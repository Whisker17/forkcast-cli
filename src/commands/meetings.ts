import fsp from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { loadCache } from "../lib/cache.js";
import { queryMeetings, getTldr as getDbTldr } from "../lib/db.js";
import { CommandError, getCommandErrorCode } from "../lib/errors.js";
import { fetchTldr, getCacheLayout, getCacheRoot, type WritableLike } from "../lib/fetcher.js";
import { exitCodeForErrorCode, writeJsonEnvelope, writeJsonError, writePrettyError } from "../lib/output.js";
import type { MeetingIndexEntry, MeetingTldr, OutputEnvelope } from "../types/index.js";
import type { PmMeetingNote } from "../lib/pm-parser.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface TldrSummary {
  highlightCategories: number;
  highlightCount: number;
  decisionCount: number;
  actionItemCount: number;
  targetCount: number;
}

interface PmNoteSummary {
  title: string;
  date: string | null;
  moderator: string | null;
  attendeeCount: number;
  decisionCount: number;
  summaryItemCount: number;
  eipReferenceCount: number;
}

interface MeetingResult extends MeetingIndexEntry {
  tldrSummary: TldrSummary | null;
  pmNoteSummary: PmNoteSummary | null;
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface MeetingsCommandDependencies {
  fetchTldr: typeof fetchTldr;
  getCacheRoot: () => string;
  loadCache: typeof loadCache;
  stderr: WritableLike;
  stdout: WritableLike;
}

interface MeetingsCommandOptions {
  type?: string;
  after?: string;
  last?: string | number;
  pretty?: boolean;
}

interface ParsedFilters {
  type?: string;
  after?: string;
  last?: number;
  pretty: boolean;
}

function getDefaultDependencies(): MeetingsCommandDependencies {
  return {
    fetchTldr,
    getCacheRoot,
    loadCache,
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

// ---------------------------------------------------------------------------
// Validation / normalization
// ---------------------------------------------------------------------------

function normalizeType(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Validate that the string is a YYYY-MM-DD date.  We deliberately do not
 * parse it as a Date object to avoid timezone confusion — string comparison
 * is sufficient for ≥ filtering on ISO dates.
 */
function validateDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CommandError(
      "Invalid date format: expected YYYY-MM-DD",
      "INVALID_INPUT",
    );
  }
  return value;
}

function parseLimit(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CommandError("Invalid limit", "INVALID_INPUT");
  }
  return parsed;
}

function parseFilters(options: MeetingsCommandOptions): ParsedFilters {
  return {
    type: typeof options.type === "string" ? normalizeType(options.type) : undefined,
    after: typeof options.after === "string" ? validateDate(options.after) : undefined,
    last: options.last !== undefined ? parseLimit(options.last) : undefined,
    pretty: options.pretty === true,
  };
}

// ---------------------------------------------------------------------------
// Index validation
// ---------------------------------------------------------------------------

/**
 * Validate that the parsed meetings-index.json has the expected shape.
 * Throws DATA_ERROR so the caller can treat it the same way as a corrupt or
 * missing cache (triggering a self-healing retry).
 */
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
  deps: MeetingsCommandDependencies,
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
    // Only self-heal on cache/data errors — not on user input errors or
    // unrelated failures.
    const code = error instanceof CommandError
      ? error.code
      : (error && typeof error === "object" && "code" in error
        ? (error as { code: unknown }).code
        : undefined);

    if (code !== "NOT_CACHED" && code !== "DATA_ERROR") {
      throw error;
    }

    // The raw cache appears to exist but is corrupt or incomplete.  Delete the
    // cache directory so the next loadCache call sees an empty state and
    // triggers a fresh auto-fetch.
    const cacheDir = getCacheLayout(cacheRoot).cacheDir;
    try {
      await fsp.rm(cacheDir, { force: true, recursive: true });
    } catch {
      // Deletion is best-effort.  If it fails, tryLoad will re-throw the
      // original error on the next attempt, giving the user an actionable
      // message rather than a silent hang.
    }

    return await tryLoad();
  }
}

// ---------------------------------------------------------------------------
// Filtering helpers
// ---------------------------------------------------------------------------

function matchesType(entry: MeetingIndexEntry, type?: string): boolean {
  if (!type) {
    return true;
  }
  return entry.type.toLowerCase() === type;
}

function matchesAfter(entry: MeetingIndexEntry, after?: string): boolean {
  if (!after) {
    return true;
  }
  return entry.date >= after;
}

// ---------------------------------------------------------------------------
// TLDR summary loading
// ---------------------------------------------------------------------------

function isEnoent(error: unknown): boolean {
  return (
    error !== null
    && typeof error === "object"
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function parseTldrSummary(tldr: MeetingTldr): TldrSummary {
  const highlightCategories = Object.keys(tldr.highlights ?? {}).length;
  const highlightCount = Object.values(tldr.highlights ?? {}).reduce(
    (sum, items) => sum + (Array.isArray(items) ? items.length : 0),
    0,
  );

  return {
    highlightCategories,
    highlightCount,
    decisionCount: Array.isArray(tldr.decisions) ? tldr.decisions.length : 0,
    actionItemCount: Array.isArray(tldr.action_items) ? tldr.action_items.length : 0,
    targetCount: Array.isArray(tldr.targets) ? tldr.targets.length : 0,
  };
}

/**
 * Load a TLDR summary for a single meeting.
 *
 * 1. Try reading the cached file from disk.
 * 2. On ENOENT, fetch on demand from GitHub Pages, write to cache, and parse.
 * 3. Return `null` only when the upstream confirms no TLDR exists (HTTP 404).
 * 4. Throw on parse errors or unexpected I/O failures so the caller can
 *    surface them rather than silently returning incomplete data.
 */
async function loadTldrSummary(
  tldrsDir: string,
  entry: MeetingIndexEntry,
  doFetchTldr: typeof fetchTldr,
): Promise<TldrSummary | null> {
  const tldrPath = path.join(
    tldrsDir,
    entry.type,
    `${entry.dirName}.json`,
  );

  // --- Try the local cache first -------------------------------------------
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
    // File doesn't exist — fall through to fetch-on-miss.
  }

  // --- Fetch on miss -------------------------------------------------------
  if (raw === undefined) {
    const fetched = await doFetchTldr(entry.type, entry.dirName);
    if (fetched === null) {
      // Upstream confirms no TLDR (404).
      return null;
    }

    // Write to cache for next time.
    const targetDir = path.join(tldrsDir, entry.type);
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.writeFile(tldrPath, fetched);
    raw = fetched;
  }

  // --- Parse ---------------------------------------------------------------
  let tldr: MeetingTldr;
  try {
    tldr = JSON.parse(raw) as MeetingTldr;
  } catch (error) {
    throw new CommandError(
      `TLDR ${entry.type}/${entry.dirName} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "DATA_ERROR",
      { cause: error },
    );
  }

  return parseTldrSummary(tldr);
}

// ---------------------------------------------------------------------------
// PM note summary loading
// ---------------------------------------------------------------------------

function parsePmNoteSummary(note: PmMeetingNote): PmNoteSummary {
  return {
    title: note.title,
    date: note.date,
    moderator: note.moderator,
    attendeeCount: note.attendees.length,
    decisionCount: note.decisions.length,
    summaryItemCount: note.summaryItems.length,
    eipReferenceCount: note.eipReferences.length,
  };
}

async function loadPmNoteSummary(
  entry: MeetingIndexEntry,
  loaded: Awaited<ReturnType<typeof loadCache>>,
): Promise<PmNoteSummary | null> {
  try {
    const note = await loaded.readPmNote(entry.type, entry.dirName);
    return note ? parsePmNoteSummary(note) : null;
  } catch {
    return null;
  }
}

function formatPrettyMeetings(entries: MeetingResult[]): string {
  const typeWidth = Math.max("Type".length, ...entries.map((e) => e.type.length));
  const dateWidth = Math.max("Date".length, ...entries.map((e) => e.date.length));
  const numWidth = Math.max("#".length, ...entries.map((e) => String(e.number).length));
  const hlWidth = Math.max("Highlights".length, ...entries.map((e) =>
    e.tldrSummary ? String(e.tldrSummary.highlightCount).length : 1,
  ));
  const decWidth = Math.max("Decisions".length, ...entries.map((e) =>
    e.tldrSummary ? String(e.tldrSummary.decisionCount).length : 1,
  ));
  const actWidth = Math.max("Actions".length, ...entries.map((e) =>
    e.tldrSummary ? String(e.tldrSummary.actionItemCount).length : 1,
  ));

  const lines: string[] = [
    [
      "Type".padEnd(typeWidth),
      "Date".padEnd(dateWidth),
      "#".padEnd(numWidth),
      "Highlights".padEnd(hlWidth),
      "Decisions".padEnd(decWidth),
      "Actions".padEnd(actWidth),
    ].join("  "),
  ];

  for (const entry of entries) {
    const hl = entry.tldrSummary ? String(entry.tldrSummary.highlightCount) : "-";
    const dec = entry.tldrSummary ? String(entry.tldrSummary.decisionCount) : "-";
    const act = entry.tldrSummary ? String(entry.tldrSummary.actionItemCount) : "-";
    lines.push([
      entry.type.padEnd(typeWidth),
      entry.date.padEnd(dateWidth),
      String(entry.number).padEnd(numWidth),
      hl.padEnd(hlWidth),
      dec.padEnd(decWidth),
      act.padEnd(actWidth),
    ].join("  "));
  }

  const resultWord = entries.length === 1 ? "result" : "results";
  lines.push("", `${entries.length} ${resultWord}`);

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main business logic
// ---------------------------------------------------------------------------

async function runMeetingsCommand(
  options: MeetingsCommandOptions,
  deps: MeetingsCommandDependencies,
) {
  const parsedFilters = parseFilters(options);
  const cacheRoot = deps.getCacheRoot();
  const { loaded, allEntries } = await loadMeetingsIndex(cacheRoot, deps);

  let results: MeetingIndexEntry[];

  // Use SQLite query when the DB is available.
  if (loaded.db) {
    results = queryMeetings(loaded.db, {
      type: parsedFilters.type,
      after: parsedFilters.after,
      last: parsedFilters.last,
    });
  } else {
    // Apply filters
    results = allEntries.filter((entry) => matchesType(entry, parsedFilters.type));
    results = results.filter((entry) => matchesAfter(entry, parsedFilters.after));

    // When --last is used: sort descending, slice, then re-sort ascending for
    // consistent output.  Without --last, default sort is ascending (the natural
    // order from the index).
    if (parsedFilters.last !== undefined) {
      results = results
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date) || b.number - a.number)
        .slice(0, parsedFilters.last)
        .sort((a, b) => a.date.localeCompare(b.date) || a.number - b.number);
    }
  }

  // Load TLDR summaries for entries where tldrAvailable is true.
  const tldrsDir = getCacheLayout(cacheRoot).tldrsDir;
  const meetingResults: MeetingResult[] = await Promise.all(
    results.map(async (entry) => {
      let tldrSummary: TldrSummary | null = null;

      if (entry.tldrAvailable) {
        // Try SQLite first; fall back to file system.
        if (loaded.db) {
          const tldr = getDbTldr(loaded.db, entry.type, entry.dirName);
          tldrSummary = tldr ? parseTldrSummary(tldr) : null;

          // If not in DB (e.g. fetched on-demand after DB was built), fall through to file.
          if (tldrSummary === null) {
            tldrSummary = await loadTldrSummary(tldrsDir, entry, deps.fetchTldr);
          }
        } else {
          tldrSummary = await loadTldrSummary(tldrsDir, entry, deps.fetchTldr);
        }
      }

      const pmNoteSummary = entry.pmNoteAvailable
        ? await loadPmNoteSummary(entry, loaded)
        : null;

      return { ...entry, tldrSummary, pmNoteSummary };
    }),
  );

  const envelope: OutputEnvelope<MeetingResult> = {
    query: {
      command: "meetings",
      filters: {
        ...(parsedFilters.type ? { type: parsedFilters.type } : {}),
        ...(parsedFilters.after ? { after: parsedFilters.after } : {}),
        ...(parsedFilters.last !== undefined ? { last: parsedFilters.last } : {}),
      },
    },
    results: meetingResults,
    count: meetingResults.length,
    source: {
      forkcast_commit: loaded.meta.forkcast_commit,
      last_updated: loaded.meta.last_updated,
    },
  };

  if (parsedFilters.pretty) {
    deps.stdout.write(formatPrettyMeetings(meetingResults));
    return;
  }

  writeJsonEnvelope(envelope, deps.stdout);
}

// ---------------------------------------------------------------------------
// Error handler wrapper
// ---------------------------------------------------------------------------

async function handleMeetingsCommand(
  _options: MeetingsCommandOptions,
  command: Command,
  deps: MeetingsCommandDependencies,
) {
  const parsedOptions = command.optsWithGlobals<MeetingsCommandOptions>();

  try {
    await runMeetingsCommand(parsedOptions, deps);
  } catch (error) {
    const code = getCommandErrorCode(error);
    const message = error instanceof Error ? error.message : String(error);

    if (parsedOptions.pretty === true) {
      writePrettyError(message, deps.stderr);
    } else {
      writeJsonError({
        error: message,
        code,
      }, deps.stdout, deps.stderr);
    }

    process.exitCode = exitCodeForErrorCode(code);
  }
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

export function createMeetingsCommand(overrides: Partial<MeetingsCommandDependencies> = {}) {
  const deps = {
    ...getDefaultDependencies(),
    ...overrides,
  } satisfies MeetingsCommandDependencies;

  return new Command("meetings")
    .description("List and filter indexed meetings")
    .option("--type <type>", "Filter by meeting type (case-insensitive)")
    .option("--after <date>", "Filter meetings on or after this date (YYYY-MM-DD)")
    .option("--last <n>", "Return the N most recent meetings")
    .option("--pretty", "Human-readable output instead of JSON")
    .action((_options, command) => handleMeetingsCommand(_options, command, deps));
}

export const meetingsCommand = createMeetingsCommand();
