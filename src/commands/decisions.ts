import fsp from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { loadCache } from "../lib/cache.js";
import { queryDecisions, queryKeyDecisions } from "../lib/db.js";
import { CommandError, getCommandErrorCode } from "../lib/errors.js";
import { fetchKeyDecisions, fetchTldr, getCacheLayout, getCacheRoot, type WritableLike } from "../lib/fetcher.js";
import { exitCodeForErrorCode, writeJsonEnvelope, writeJsonError, writePrettyError } from "../lib/output.js";
import type { MeetingDecision, MeetingIndexEntry, MeetingTldr, OutputEnvelope } from "../types/index.js";

// ---------------------------------------------------------------------------
// Key decisions schema (from forkcast key_decisions.json artifact files)
// ---------------------------------------------------------------------------

interface RawKeyDecision {
  original_text: string;
  timestamp: string;
  type: string;
  eips: number[];
  stage_change?: { to: string };
  fork?: string;
  context?: string;
}

interface RawKeyDecisionsFile {
  meeting: string;
  key_decisions: RawKeyDecision[];
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DecisionResult {
  source: "tldr" | "key_decisions";
  meetingType: string;
  meetingDate: string;
  meetingNumber: number;
  meetingName: string;
  timestamp: string;
  decision: string;
  // key_decisions-specific fields (null when source is "tldr")
  eips: number[] | null;
  stageChange: { to: string } | null;
  fork: string | null;
  context: string | null;
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface DecisionsCommandDependencies {
  fetchTldr: typeof fetchTldr;
  fetchKeyDecisions: typeof fetchKeyDecisions;
  getCacheRoot: () => string;
  loadCache: typeof loadCache;
  stderr: WritableLike;
  stdout: WritableLike;
}

export interface FetchArtifactOptions {
  pagesBaseUrl?: string;
  requestTimeoutMs?: number;
}

interface DecisionsCommandOptions {
  fork?: string;
  after?: string;
  type?: string;
  last?: string | number;
  limit?: string | number;
  pretty?: boolean;
}

interface ParsedFilters {
  fork?: string;
  after?: string;
  type?: string;
  last?: number;
  limit?: number;
  pretty: boolean;
}

// ---------------------------------------------------------------------------
// Dependency wiring
// ---------------------------------------------------------------------------

function getDefaultDependencies(): DecisionsCommandDependencies {
  return {
    fetchTldr,
    fetchKeyDecisions,
    getCacheRoot,
    loadCache,
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

// ---------------------------------------------------------------------------
// Validation / normalization
// ---------------------------------------------------------------------------

function validateDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CommandError(
      "Invalid date format: expected YYYY-MM-DD",
      "INVALID_INPUT",
    );
  }
  return value;
}

function parsePositiveInt(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CommandError(`Invalid ${label}: must be a positive integer`, "INVALID_INPUT");
  }
  return parsed;
}

function parseFilters(options: DecisionsCommandOptions): ParsedFilters {
  return {
    fork: typeof options.fork === "string" ? options.fork.trim() : undefined,
    after: typeof options.after === "string" ? validateDate(options.after) : undefined,
    type: typeof options.type === "string" ? options.type.trim().toLowerCase() : undefined,
    last: options.last !== undefined ? parsePositiveInt(options.last, "last") : undefined,
    limit: options.limit !== undefined ? parsePositiveInt(options.limit, "limit") : undefined,
    pretty: options.pretty === true,
  };
}

// ---------------------------------------------------------------------------
// Filename parsing
// ---------------------------------------------------------------------------

/**
 * Parse "{date}_{number}" (dirName) into components.
 * Returns null for malformed filenames.
 */
function parseDirName(dirName: string): { date: string; number: number } | null {
  const match = /^(\d{4}-\d{2}-\d{2})_(\d+)$/.exec(dirName);
  if (!match) {
    return null;
  }
  return { date: match[1], number: Number(match[2]) };
}

/**
 * Build a human-readable meeting name like "ACDE #234 - April 9, 2026"
 */
function formatMeetingName(type: string, number: number, date: string): string {
  const typeUpper = type.toUpperCase();
  let dateFormatted = date;
  try {
    // Parse as UTC to avoid timezone offsets shifting the date
    const [year, month, day] = date.split("-").map(Number);
    const d = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
    dateFormatted = d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    // Fall back to raw date string
  }
  return `${typeUpper} #${number} - ${dateFormatted}`;
}

// ---------------------------------------------------------------------------
// TLDR decision extraction
// ---------------------------------------------------------------------------

function extractTldrDecisions(
  tldr: MeetingTldr,
  type: string,
  dirName: string,
): DecisionResult[] {
  if (!Array.isArray(tldr.decisions) || tldr.decisions.length === 0) {
    return [];
  }

  const parsed = parseDirName(dirName);
  if (!parsed) {
    return [];
  }

  const meetingName = formatMeetingName(type, parsed.number, parsed.date);

  return tldr.decisions.map((d: MeetingDecision): DecisionResult => ({
    source: "tldr",
    meetingType: type,
    meetingDate: parsed.date,
    meetingNumber: parsed.number,
    meetingName,
    timestamp: d.timestamp,
    decision: d.decision,
    eips: null,
    stageChange: null,
    fork: null,
    context: null,
  }));
}

// ---------------------------------------------------------------------------
// Key decisions extraction
// ---------------------------------------------------------------------------

function extractKeyDecisions(
  raw: RawKeyDecisionsFile,
  type: string,
  dirName: string,
): DecisionResult[] {
  if (!Array.isArray(raw.key_decisions) || raw.key_decisions.length === 0) {
    return [];
  }

  const parsed = parseDirName(dirName);
  if (!parsed) {
    return [];
  }

  const meetingName = formatMeetingName(type, parsed.number, parsed.date);

  return raw.key_decisions.map((kd: RawKeyDecision): DecisionResult => ({
    source: "key_decisions",
    meetingType: type,
    meetingDate: parsed.date,
    meetingNumber: parsed.number,
    meetingName,
    timestamp: kd.timestamp,
    decision: kd.original_text,
    eips: Array.isArray(kd.eips) ? kd.eips : null,
    stageChange: kd.stage_change ? { to: kd.stage_change.to } : null,
    fork: typeof kd.fork === "string" && kd.fork.length > 0 ? kd.fork : null,
    context: typeof kd.context === "string" && kd.context.length > 0 ? kd.context : null,
  }));
}

// ---------------------------------------------------------------------------
// Fork filtering
// ---------------------------------------------------------------------------

/**
 * Strip diacritics so that "Hegotá" matches "Hegota" and vice-versa.
 */
function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function matchesFork(result: DecisionResult, forkLower: string): boolean {
  const forkRegex = new RegExp(
    stripDiacritics(forkLower).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i",
  );

  if (result.source === "key_decisions" && result.fork !== null) {
    // Check the explicit fork field first (regex, accent-insensitive)
    if (forkRegex.test(stripDiacritics(result.fork))) {
      return true;
    }
  }

  // Fallback: regex match in decision text (accent-insensitive)
  return forkRegex.test(stripDiacritics(result.decision));
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Normalize decision text for deduplication.  Strips accents, punctuation, and
 * extra whitespace so that minor formatting differences between TLDR and
 * key_decisions.json don't prevent matching.
 */
function normalizeTextForDedup(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Given both TLDR and key_decisions results for the same set of meetings,
 * deduplicate by preferring key_decisions when both share the same meeting +
 * decision text.  The key_decisions version carries richer metadata.
 *
 * NOTE: TLDR and key_decisions timestamps for the same decision do NOT match
 * (e.g. ACDE #234: TLDR "00:46:31" vs key_decisions "00:42:20"), so we key on
 * normalized decision text instead.
 */
function deduplicateDecisions(all: DecisionResult[]): DecisionResult[] {
  // Build a set of (meetingType/dirName/normalizedText) keys covered by key_decisions entries.
  const kdKeys = new Set<string>();
  for (const result of all) {
    if (result.source === "key_decisions") {
      kdKeys.add(`${result.meetingType}/${result.meetingDate}_${result.meetingNumber}/${normalizeTextForDedup(result.decision)}`);
    }
  }

  // Keep all key_decisions entries; drop TLDR entries that share the same key.
  return all.filter((result) => {
    if (result.source === "tldr") {
      const key = `${result.meetingType}/${result.meetingDate}_${result.meetingNumber}/${normalizeTextForDedup(result.decision)}`;
      return !kdKeys.has(key);
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function compareTimestamp(a: string, b: string): number {
  // Timestamps are "HH:MM:SS" — lexicographic sort works correctly
  return a.localeCompare(b);
}

function sortDecisions(results: DecisionResult[]): DecisionResult[] {
  return results.slice().sort((a, b) => {
    const dateCmp = a.meetingDate.localeCompare(b.meetingDate);
    if (dateCmp !== 0) {
      return dateCmp;
    }
    const numCmp = a.meetingNumber - b.meetingNumber;
    if (numCmp !== 0) {
      return numCmp;
    }
    return compareTimestamp(a.timestamp, b.timestamp);
  });
}

// ---------------------------------------------------------------------------
// TLDR cache loading
// ---------------------------------------------------------------------------

/** Max concurrent HTTP fetches when loading decisions for many meetings. */
const FETCH_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function isEnoent(error: unknown): boolean {
  return (
    error !== null
    && typeof error === "object"
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function loadTldrForEntry(
  tldrsDir: string,
  entry: MeetingIndexEntry,
  doFetchTldr: typeof fetchTldr,
): Promise<MeetingTldr | null> {
  const tldrPath = path.join(tldrsDir, entry.type, `${entry.dirName}.json`);

  let raw: string | undefined;
  try {
    raw = await fsp.readFile(tldrPath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      throw new CommandError(
        `Failed to read TLDR cache file ${entry.type}/${entry.dirName}: ${error instanceof Error ? error.message : String(error)}`,
        "DATA_ERROR",
        { cause: error },
      );
    }
  }

  if (raw === undefined) {
    const fetched = await doFetchTldr(entry.type, entry.dirName);
    if (fetched === null) {
      return null;
    }

    const targetDir = path.join(tldrsDir, entry.type);
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.writeFile(tldrPath, fetched);
    raw = fetched;
  }

  try {
    return JSON.parse(raw) as MeetingTldr;
  } catch (error) {
    throw new CommandError(
      `TLDR ${entry.type}/${entry.dirName} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "DATA_ERROR",
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// key_decisions.json cache loading
// ---------------------------------------------------------------------------

const KEY_DECISIONS_SUFFIX = "_key_decisions.json";

async function loadKeyDecisionsForEntry(
  tldrsDir: string,
  entry: MeetingIndexEntry,
  doFetchKeyDecisions: DecisionsCommandDependencies["fetchKeyDecisions"],
): Promise<RawKeyDecisionsFile | null> {
  const cachePath = path.join(tldrsDir, entry.type, `${entry.dirName}${KEY_DECISIONS_SUFFIX}`);

  let raw: string | undefined;
  try {
    raw = await fsp.readFile(cachePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      throw new CommandError(
        `Failed to read key_decisions cache file ${entry.type}/${entry.dirName}: ${error instanceof Error ? error.message : String(error)}`,
        "DATA_ERROR",
        { cause: error },
      );
    }
  }

  // Check for negative-cache sentinel or return the already-parsed result.
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "_negative_cache" in parsed) {
        return null; // Previously confirmed 404
      }
      return parsed as RawKeyDecisionsFile;
    } catch {
      // Malformed cache file — fall through to re-fetch
      raw = undefined;
    }
  }

  if (raw === undefined) {
    const fetched = await doFetchKeyDecisions(entry.type, entry.dirName);
    if (fetched === null) {
      // Write negative cache sentinel so we don't re-fetch on next run
      const targetDir = path.join(tldrsDir, entry.type);
      await fsp.mkdir(targetDir, { recursive: true });
      await fsp.writeFile(cachePath, JSON.stringify({ _negative_cache: true }));
      return null;
    }

    const targetDir = path.join(tldrsDir, entry.type);
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.writeFile(cachePath, fetched);
    raw = fetched;
  }

  try {
    return JSON.parse(raw) as RawKeyDecisionsFile;
  } catch (error) {
    throw new CommandError(
      `key_decisions ${entry.type}/${entry.dirName} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "DATA_ERROR",
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// meetings-index validation
// ---------------------------------------------------------------------------

function validateMeetingsIndex(raw: unknown): MeetingIndexEntry[] {
  if (!Array.isArray(raw)) {
    throw new CommandError(
      "meetings-index.json has an unexpected shape (expected an array)",
      "DATA_ERROR",
    );
  }

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (
      entry === null
      || typeof entry !== "object"
      || typeof (entry as Record<string, unknown>).type !== "string"
      || typeof (entry as Record<string, unknown>).date !== "string"
      || typeof (entry as Record<string, unknown>).number !== "number"
      || typeof (entry as Record<string, unknown>).dirName !== "string"
      || typeof (entry as Record<string, unknown>).tldrAvailable !== "boolean"
    ) {
      throw new CommandError(
        `meetings-index.json entry at index ${i} is missing required fields (type, date, number, dirName, tldrAvailable)`,
        "DATA_ERROR",
      );
    }
  }

  return raw as MeetingIndexEntry[];
}

// ---------------------------------------------------------------------------
// Cache loading (with self-healing retry)
// ---------------------------------------------------------------------------

async function loadMeetingsIndex(
  cacheRoot: string,
  deps: DecisionsCommandDependencies,
): Promise<{ loaded: Awaited<ReturnType<typeof loadCache>>; allEntries: MeetingIndexEntry[] }> {
  const tryLoad = async () => {
    const loaded = await deps.loadCache({ cacheRoot, stderr: deps.stderr });
    const raw = await loaded.readMeetingsIndex();
    const allEntries = validateMeetingsIndex(raw);
    return { loaded, allEntries };
  };

  try {
    return await tryLoad();
  } catch (error) {
    const code = error instanceof CommandError
      ? error.code
      : (error && typeof error === "object" && "code" in error
        ? (error as { code: unknown }).code
        : undefined);

    if (code !== "NOT_CACHED" && code !== "DATA_ERROR") {
      throw error;
    }

    const cacheDir = getCacheLayout(cacheRoot).cacheDir;
    try {
      await fsp.rm(cacheDir, { force: true, recursive: true });
    } catch {
      // Best-effort
    }

    return await tryLoad();
  }
}

// ---------------------------------------------------------------------------
// Pretty formatting
// ---------------------------------------------------------------------------

function formatPrettyDecisions(
  results: DecisionResult[],
  filters: ParsedFilters,
): string {
  const lines: string[] = [];

  // Header
  const filterParts: string[] = [];
  if (filters.fork) {
    filterParts.push(`fork: ${filters.fork}`);
  }
  if (filters.type) {
    filterParts.push(`type: ${filters.type}`);
  }
  if (filters.after) {
    filterParts.push(`after: ${filters.after}`);
  }

  const filterStr = filterParts.length > 0 ? ` (${filterParts.join(", ")})` : "";
  const resultWord = results.length === 1 ? "decision" : "decisions";
  lines.push(`Key Decisions${filterStr} — ${results.length} ${resultWord}`);

  if (results.length === 0) {
    return `${lines.join("\n")}\n`;
  }

  // Group by meeting
  const byMeeting = new Map<string, DecisionResult[]>();
  for (const result of results) {
    const key = `${result.meetingDate}_${result.meetingNumber}_${result.meetingType}`;
    const group = byMeeting.get(key);
    if (group) {
      group.push(result);
    } else {
      byMeeting.set(key, [result]);
    }
  }

  for (const [, meetingResults] of byMeeting) {
    const first = meetingResults[0]!;
    lines.push("", `── ${first.meetingName}`);

    for (const result of meetingResults) {
      lines.push(`  [${result.timestamp}] ${result.decision}`);

      const meta: string[] = [];
      if (result.fork !== null) {
        meta.push(`fork: ${result.fork}`);
      }
      if (result.eips !== null && result.eips.length > 0) {
        meta.push(`EIPs: ${result.eips.map((e) => `EIP-${e}`).join(", ")}`);
      }
      if (result.stageChange !== null) {
        meta.push(`stage → ${result.stageChange.to}`);
      }
      if (meta.length > 0) {
        lines.push(`    (${meta.join(" | ")})`);
      }
    }
  }

  lines.push("", `${results.length} ${resultWord}`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main business logic
// ---------------------------------------------------------------------------

async function runDecisionsCommand(
  options: DecisionsCommandOptions,
  deps: DecisionsCommandDependencies,
) {
  const filters = parseFilters(options);
  const cacheRoot = deps.getCacheRoot();
  const { loaded, allEntries } = await loadMeetingsIndex(cacheRoot, deps);
  const layout = getCacheLayout(cacheRoot);

  // ---------- SQLite fast path ----------
  if (loaded.db) {
    const dbFilters = {
      type: filters.type,
      after: filters.after,
    };

    // Query TLDR decisions from DB
    const tldrRows = queryDecisions(loaded.db, dbFilters);
    const tldrDecisions: DecisionResult[] = tldrRows.map((row) => ({
      source: "tldr" as const,
      meetingType: row.meeting_type,
      meetingDate: row.meeting_date,
      meetingNumber: row.meeting_number,
      meetingName: formatMeetingName(row.meeting_type, row.meeting_number, row.meeting_date),
      timestamp: row.timestamp ?? "",
      decision: row.decision_text,
      eips: null,
      stageChange: null,
      fork: null,
      context: null,
    }));

    // Query key_decisions from DB
    const kdRows = queryKeyDecisions(loaded.db, dbFilters);
    const kdDecisions: DecisionResult[] = kdRows.map((row) => ({
      source: "key_decisions" as const,
      meetingType: row.meeting_type,
      meetingDate: row.meeting_date,
      meetingNumber: row.meeting_number,
      meetingName: formatMeetingName(row.meeting_type, row.meeting_number, row.meeting_date),
      timestamp: row.timestamp ?? "",
      decision: row.original_text,
      eips: row.eips_json ? JSON.parse(row.eips_json) as number[] : null,
      stageChange: row.stage_change_to ? { to: row.stage_change_to } : null,
      fork: row.fork,
      context: row.context,
    }));

    let allDecisions = [...tldrDecisions, ...kdDecisions];

    // Apply --last: filter to decisions from the N most recent meetings
    if (filters.last !== undefined) {
      // Collect distinct meetings, sort desc, take N
      const meetingKeys = new Set<string>();
      const meetingByKey = new Map<string, { date: string; number: number }>();
      for (const d of allDecisions) {
        const key = `${d.meetingDate}_${d.meetingNumber}_${d.meetingType}`;
        meetingKeys.add(key);
        if (!meetingByKey.has(key)) {
          meetingByKey.set(key, { date: d.meetingDate, number: d.meetingNumber });
        }
      }
      const sortedKeys = [...meetingByKey.entries()]
        .sort(([, a], [, b]) => b.date.localeCompare(a.date) || b.number - a.number)
        .slice(0, filters.last)
        .map(([k]) => k);
      const allowedKeys = new Set(sortedKeys);
      allDecisions = allDecisions.filter((d) =>
        allowedKeys.has(`${d.meetingDate}_${d.meetingNumber}_${d.meetingType}`),
      );
    }

    // Deduplicate
    let deduped = deduplicateDecisions(allDecisions);

    // Apply fork filter
    if (filters.fork) {
      const forkLower = filters.fork.toLowerCase();
      deduped = deduped.filter((r) => matchesFork(r, forkLower));
    }

    let results = sortDecisions(deduped);

    if (filters.limit !== undefined) {
      results = results.slice(0, filters.limit);
    }

    // Warning for meetings without TLDR data — filter allEntries to match
    // the same type/after/last constraints for parity with the JSON path.
    let filteredForWarning = allEntries;
    if (filters.type) {
      filteredForWarning = filteredForWarning.filter(
        (e) => e.type.toLowerCase() === filters.type,
      );
    }
    if (filters.after) {
      filteredForWarning = filteredForWarning.filter((e) => e.date >= filters.after!);
    }
    if (filters.last !== undefined) {
      filteredForWarning = filteredForWarning
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date) || b.number - a.number)
        .slice(0, filters.last);
    }
    const noDataCount = filteredForWarning.filter((e) => !e.tldrAvailable).length;
    let warning: string | undefined;
    if (noDataCount > 0) {
      warning = `${noDataCount} of ${filteredForWarning.length} selected meeting(s) have no TLDR data and may contribute fewer decisions`;
    }

    const envelope: OutputEnvelope<DecisionResult> = {
      query: {
        command: "decisions",
        filters: {
          ...(filters.fork ? { fork: filters.fork } : {}),
          ...(filters.after ? { after: filters.after } : {}),
          ...(filters.type ? { type: filters.type } : {}),
          ...(filters.last !== undefined ? { last: filters.last } : {}),
          ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
        },
      },
      results,
      count: results.length,
      source: {
        forkcast_commit: loaded.meta.forkcast_commit,
        last_updated: loaded.meta.last_updated,
      },
      ...(warning ? { warning } : {}),
    };

    if (filters.pretty) {
      deps.stdout.write(formatPrettyDecisions(results, filters));
      return;
    }

    writeJsonEnvelope(envelope, deps.stdout);
    return;
  }

  // ---------- JSON fallback path ----------
  let filteredEntries = allEntries;

  if (filters.type) {
    filteredEntries = filteredEntries.filter(
      (e) => e.type.toLowerCase() === filters.type,
    );
  }

  if (filters.after) {
    filteredEntries = filteredEntries.filter((e) => e.date >= filters.after!);
  }

  // Apply --last: take N most recent meetings (by date desc, then number desc)
  if (filters.last !== undefined) {
    filteredEntries = filteredEntries
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date) || b.number - a.number)
      .slice(0, filters.last)
      .sort((a, b) => a.date.localeCompare(b.date) || a.number - b.number);
  }

  // Track meetings without any decision data source for a potential warning.
  const noDataCount = filteredEntries.filter((e) => !e.tldrAvailable).length;

  const allDecisions: DecisionResult[] = [];

  const perEntryResults = await mapWithConcurrency(filteredEntries, FETCH_CONCURRENCY, async (entry) => {
    const results: DecisionResult[] = [];

    // Load TLDR decisions — only attempt when the index says the TLDR exists
    if (entry.tldrAvailable) {
      try {
        const tldr = await loadTldrForEntry(layout.tldrsDir, entry, deps.fetchTldr);
        if (tldr !== null) {
          results.push(...extractTldrDecisions(tldr, entry.type, entry.dirName));
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        deps.stderr.write(`Warning: failed to load TLDR for ${entry.type}/${entry.dirName}: ${msg}\n`);
      }
    }

    // Load key_decisions — attempt for all types; the 404 → negative-cache
    // path handles types that don't publish this artifact at zero ongoing cost.
    try {
      const kdFile = await loadKeyDecisionsForEntry(layout.tldrsDir, entry, deps.fetchKeyDecisions);
      if (kdFile !== null) {
        results.push(...extractKeyDecisions(kdFile, entry.type, entry.dirName));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      deps.stderr.write(`Warning: failed to load key_decisions for ${entry.type}/${entry.dirName}: ${msg}\n`);
    }

    return results;
  });

  for (const results of perEntryResults) {
    allDecisions.push(...results);
  }

  // Deduplicate (key_decisions wins over TLDR when same meeting+decision text)
  let deduped = deduplicateDecisions(allDecisions);

  // Apply fork filter
  if (filters.fork) {
    const forkLower = filters.fork.toLowerCase();
    deduped = deduped.filter((r) => matchesFork(r, forkLower));
  }

  // Sort: date asc, then timestamp asc
  let results = sortDecisions(deduped);

  // Apply --limit
  if (filters.limit !== undefined) {
    results = results.slice(0, filters.limit);
  }

  // Build warning when some selected meetings lack TLDR data
  let warning: string | undefined;
  if (noDataCount > 0) {
    const total = filteredEntries.length;
    warning = `${noDataCount} of ${total} selected meeting(s) have no TLDR data and may contribute fewer decisions`;
  }

  const envelope: OutputEnvelope<DecisionResult> = {
    query: {
      command: "decisions",
      filters: {
        ...(filters.fork ? { fork: filters.fork } : {}),
        ...(filters.after ? { after: filters.after } : {}),
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.last !== undefined ? { last: filters.last } : {}),
        ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
      },
    },
    results,
    count: results.length,
    source: {
      forkcast_commit: loaded.meta.forkcast_commit,
      last_updated: loaded.meta.last_updated,
    },
    ...(warning ? { warning } : {}),
  };

  if (filters.pretty) {
    deps.stdout.write(formatPrettyDecisions(results, filters));
    return;
  }

  writeJsonEnvelope(envelope, deps.stdout);
}

// ---------------------------------------------------------------------------
// Error handler wrapper
// ---------------------------------------------------------------------------

async function handleDecisionsCommand(
  _options: DecisionsCommandOptions,
  command: Command,
  deps: DecisionsCommandDependencies,
) {
  const parsedOptions = command.optsWithGlobals<DecisionsCommandOptions>();

  try {
    await runDecisionsCommand(parsedOptions, deps);
  } catch (error) {
    const code = getCommandErrorCode(error);
    const message = error instanceof Error ? error.message : String(error);

    if (parsedOptions.pretty === true) {
      writePrettyError(message, deps.stderr);
    } else {
      writeJsonError({ error: message, code }, deps.stdout, deps.stderr);
    }

    process.exitCode = exitCodeForErrorCode(code);
  }
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

export function createDecisionsCommand(overrides: Partial<DecisionsCommandDependencies> = {}) {
  const deps = {
    ...getDefaultDependencies(),
    ...overrides,
  } satisfies DecisionsCommandDependencies;

  return new Command("decisions")
    .description("List key decisions from meeting TLDRs and key_decisions.json artifacts")
    .option("--fork <name>", "Filter decisions mentioning this fork (case-insensitive)")
    .option("--after <date>", "Filter meetings on or after this date (YYYY-MM-DD)")
    .option("--type <type>", "Filter by meeting type (acde, acdc, etc.)")
    .option("--last <n>", "Return decisions from the N most recent meetings (after other filters)")
    .option("--limit <n>", "Limit the total number of decision results")
    .option("--pretty", "Human-readable output instead of JSON")
    .action((_options, command) => handleDecisionsCommand(_options, command, deps));
}

export const decisionsCommand = createDecisionsCommand();
