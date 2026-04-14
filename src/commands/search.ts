import fsp from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { loadCache } from "../lib/cache.js";
import { CommandError, getCommandErrorCode } from "../lib/errors.js";
import { getCacheLayout, getCacheRoot, type WritableLike } from "../lib/fetcher.js";
import { exitCodeForErrorCode, writeJsonEnvelope, writeJsonError, writePrettyError } from "../lib/output.js";
import type {
  Eip,
  EipStatus,
  MeetingTldr,
  OutputEnvelope,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface EipSearchResult {
  source: "eip";
  eipId: number;
  title: string;
  status: EipStatus;
  matches: string[];
}

export interface MeetingSearchResult {
  source: "meeting";
  type: string;
  date: string;
  number: number;
  meeting: string;
  matches: string[];
}

export type SearchResult = EipSearchResult | MeetingSearchResult;

// ---------------------------------------------------------------------------
// Relevance tiers
// ---------------------------------------------------------------------------

const TIER_EXACT_TITLE = 0;
const TIER_TITLE_CONTAINS = 1;
const TIER_BODY = 2;

interface RankedEipHit extends EipSearchResult {
  _tier: number;
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface SearchCommandDependencies {
  getCacheRoot: () => string;
  loadCache: typeof loadCache;
  stderr: WritableLike;
  stdout: WritableLike;
}

interface SearchCommandOptions {
  type?: string;
  limit?: string | number;
  pretty?: boolean;
}

interface ParsedFilters {
  term: string;
  type?: "eips" | "meetings";
  limit?: number;
  pretty: boolean;
}

function getDefaultDependencies(): SearchCommandDependencies {
  return {
    getCacheRoot,
    loadCache,
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

// ---------------------------------------------------------------------------
// Validation / normalization
// ---------------------------------------------------------------------------

function normalizeSearchType(value: string): "eips" | "meetings" {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "eips" && normalized !== "meetings") {
    throw new CommandError(
      `Invalid type: "${value}". Must be "eips" or "meetings"`,
      "INVALID_INPUT",
    );
  }
  return normalized;
}

function parseLimit(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CommandError("Invalid limit", "INVALID_INPUT");
  }
  return parsed;
}

function parseFilters(term: string, options: SearchCommandOptions): ParsedFilters {
  const trimmedTerm = term.trim();
  if (trimmedTerm.length === 0) {
    throw new CommandError("Search term must not be empty", "INVALID_INPUT");
  }

  return {
    term: trimmedTerm,
    type: typeof options.type === "string" ? normalizeSearchType(options.type) : undefined,
    limit: options.limit !== undefined ? parseLimit(options.limit) : undefined,
    pretty: options.pretty === true,
  };
}

// ---------------------------------------------------------------------------
// EIP search helpers
// ---------------------------------------------------------------------------

function searchEip(eip: Eip, termLower: string): RankedEipHit | null {
  const matches: string[] = [];
  let tier = TIER_BODY;

  const titleLower = eip.title.toLowerCase();

  if (titleLower === termLower) {
    tier = TIER_EXACT_TITLE;
    matches.push(eip.title);
  } else if (titleLower.includes(termLower)) {
    tier = TIER_TITLE_CONTAINS;
    matches.push(eip.title);
  }

  if (eip.description.toLowerCase().includes(termLower)) {
    matches.push(truncateSnippet(eip.description));
  }

  if (eip.laymanDescription && eip.laymanDescription.toLowerCase().includes(termLower)) {
    matches.push(truncateSnippet(eip.laymanDescription));
  }

  if (matches.length === 0) {
    return null;
  }

  return {
    source: "eip" as const,
    eipId: eip.id,
    title: eip.title,
    status: eip.status,
    matches,
    // Attach tier for sorting (removed before output)
    _tier: tier,
  };
}

// ---------------------------------------------------------------------------
// Meeting search helpers
// ---------------------------------------------------------------------------

function searchMeeting(
  tldr: MeetingTldr,
  type: string,
  date: string,
  number: number,
  termLower: string,
): MeetingSearchResult | null {
  const matches: string[] = [];

  // Search highlights
  for (const items of Object.values(tldr.highlights ?? {})) {
    for (const item of items) {
      if (item.highlight.toLowerCase().includes(termLower)) {
        matches.push(truncateSnippet(item.highlight));
      }
    }
  }

  // Search decisions
  if (Array.isArray(tldr.decisions)) {
    for (const d of tldr.decisions) {
      if (d.decision.toLowerCase().includes(termLower)) {
        matches.push(truncateSnippet(d.decision));
      }
    }
  }

  // Search action items
  if (Array.isArray(tldr.action_items)) {
    for (const a of tldr.action_items) {
      if (a.action.toLowerCase().includes(termLower)) {
        matches.push(truncateSnippet(a.action));
      }
    }
  }

  // Search targets / commitments
  if (Array.isArray(tldr.targets)) {
    for (const t of tldr.targets) {
      let text: string | undefined;
      if ("target" in t && typeof t.target === "string") {
        text = t.target;
      } else if ("commitment" in t && typeof t.commitment === "string") {
        text = t.commitment;
      }
      if (typeof text === "string" && text.toLowerCase().includes(termLower)) {
        matches.push(truncateSnippet(text));
      }
    }
  }

  if (matches.length === 0) {
    return null;
  }

  return {
    source: "meeting",
    type,
    date,
    number,
    meeting: tldr.meeting,
    matches,
  };
}

// ---------------------------------------------------------------------------
// Snippet truncation
// ---------------------------------------------------------------------------

const MAX_SNIPPET_LENGTH = 200;

function truncateSnippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_SNIPPET_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SNIPPET_LENGTH - 1)}…`;
}

// ---------------------------------------------------------------------------
// EIP file scanning
// ---------------------------------------------------------------------------

async function searchEips(eipsDir: string, termLower: string): Promise<RankedEipHit[]> {
  let files: string[];
  try {
    files = await fsp.readdir(eipsDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json"));

  const results = await Promise.all(jsonFiles.map(async (file) => {
    let eip: Eip;
    try {
      eip = JSON.parse(await fsp.readFile(path.join(eipsDir, file), "utf8")) as Eip;
    } catch {
      // Skip malformed files
      return null;
    }

    return searchEip(eip, termLower);
  }));

  return results.filter((hit): hit is RankedEipHit => hit !== null);
}

// ---------------------------------------------------------------------------
// TLDR file scanning
// ---------------------------------------------------------------------------

/**
 * Parse {type}/{date}_{number}.json filename into its components.
 * Returns null if the filename doesn't match the expected pattern.
 */
function parseTldrFilename(
  type: string,
  file: string,
): { type: string; date: string; number: number } | null {
  // Expected: 2026-04-09_234.json
  const match = /^(\d{4}-\d{2}-\d{2})_(\d+)\.json$/.exec(file);
  if (!match) {
    return null;
  }
  return { type, date: match[1], number: Number(match[2]) };
}

async function searchMeetings(tldrsDir: string, termLower: string): Promise<MeetingSearchResult[]> {
  let entries;
  try {
    entries = await fsp.readdir(tldrsDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const typeDirs = entries.filter((e) => e.isDirectory());

  const perTypeResults = await Promise.all(typeDirs.map(async (typeEntry) => {
    const typePath = path.join(tldrsDir, typeEntry.name);
    let tldrFiles: string[];
    try {
      tldrFiles = await fsp.readdir(typePath);
    } catch {
      return [];
    }

    const jsonFiles = tldrFiles.filter((f) => f.endsWith(".json"));

    const results = await Promise.all(jsonFiles.map(async (file) => {
      const parsed = parseTldrFilename(typeEntry.name, file);
      if (!parsed) {
        return null;
      }

      let tldr: MeetingTldr;
      try {
        tldr = JSON.parse(await fsp.readFile(path.join(typePath, file), "utf8")) as MeetingTldr;
      } catch {
        // Skip malformed files
        return null;
      }

      return searchMeeting(tldr, parsed.type, parsed.date, parsed.number, termLower);
    }));

    return results.filter((hit): hit is MeetingSearchResult => hit !== null);
  }));

  return perTypeResults.flat();
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortEipHits(hits: RankedEipHit[]): EipSearchResult[] {
  return hits
    .slice()
    .sort((a, b) => {
      if (a._tier !== b._tier) {
        return a._tier - b._tier;
      }
      return a.eipId - b.eipId;
    })
    .map(({ _tier: _unused, ...rest }) => rest as EipSearchResult);
}

function sortMeetingHits(hits: MeetingSearchResult[]): MeetingSearchResult[] {
  return hits.slice().sort((a, b) => {
    const dateCmp = a.date.localeCompare(b.date);
    if (dateCmp !== 0) {
      return dateCmp;
    }
    return a.number - b.number;
  });
}

// ---------------------------------------------------------------------------
// Pretty formatting
// ---------------------------------------------------------------------------

function formatPrettySearch(
  term: string,
  eipHits: EipSearchResult[],
  meetingHits: MeetingSearchResult[],
  total: number,
): string {
  const lines: string[] = [];
  const resultWord = total === 1 ? "result" : "results";
  lines.push(`Search results for "${term}" (${total} ${resultWord})`);

  if (eipHits.length > 0) {
    lines.push("", "EIPs:");
    for (const hit of eipHits) {
      lines.push(`  EIP-${hit.eipId}  ${hit.title}  (${hit.status})`);
      for (const snippet of hit.matches) {
        lines.push(`    - "${snippet}"`);
      }
    }
  }

  if (meetingHits.length > 0) {
    lines.push("", "Meetings:");
    for (const hit of meetingHits) {
      const typeUpper = hit.type.toUpperCase();
      lines.push(`  ${typeUpper} #${hit.number}  ${hit.date}`);
      for (const snippet of hit.matches) {
        lines.push(`    - "${snippet}"`);
      }
    }
  }

  lines.push("", `${total} ${resultWord}`);

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main business logic
// ---------------------------------------------------------------------------

async function runSearchCommand(
  term: string,
  options: SearchCommandOptions,
  deps: SearchCommandDependencies,
) {
  const parsedFilters = parseFilters(term, options);
  const cacheRoot = deps.getCacheRoot();

  // Ensure cache exists (auto-fetch if missing)
  const loaded = await deps.loadCache({ cacheRoot, stderr: deps.stderr });

  const layout = getCacheLayout(cacheRoot);
  const termLower = parsedFilters.term.toLowerCase();

  let eipHits: EipSearchResult[] = [];
  let meetingHits: MeetingSearchResult[] = [];

  if (!parsedFilters.type || parsedFilters.type === "eips") {
    const rawEipHits = await searchEips(layout.eipsDir, termLower);
    eipHits = sortEipHits(rawEipHits);
  }

  if (!parsedFilters.type || parsedFilters.type === "meetings") {
    const rawMeetingHits = await searchMeetings(layout.tldrsDir, termLower);
    meetingHits = sortMeetingHits(rawMeetingHits);
  }

  // Combine: EIPs first, meetings second (per spec)
  let results: SearchResult[] = [...eipHits, ...meetingHits];

  if (parsedFilters.limit !== undefined) {
    results = results.slice(0, parsedFilters.limit);
  }

  const finalEipHits = results.filter((r): r is EipSearchResult => r.source === "eip");
  const finalMeetingHits = results.filter((r): r is MeetingSearchResult => r.source === "meeting");

  const envelope: OutputEnvelope<SearchResult> = {
    query: {
      command: "search",
      filters: {
        term: parsedFilters.term,
        ...(parsedFilters.type ? { type: parsedFilters.type } : {}),
        ...(parsedFilters.limit !== undefined ? { limit: parsedFilters.limit } : {}),
      },
    },
    results,
    count: results.length,
    source: {
      forkcast_commit: loaded.meta.forkcast_commit,
      last_updated: loaded.meta.last_updated,
    },
  };

  if (parsedFilters.pretty) {
    deps.stdout.write(
      formatPrettySearch(parsedFilters.term, finalEipHits, finalMeetingHits, results.length),
    );
    return;
  }

  writeJsonEnvelope(envelope, deps.stdout);
}

// ---------------------------------------------------------------------------
// Error handler wrapper
// ---------------------------------------------------------------------------

async function handleSearchCommand(
  term: string,
  _options: SearchCommandOptions,
  command: Command,
  deps: SearchCommandDependencies,
) {
  const parsedOptions = command.optsWithGlobals<SearchCommandOptions>();

  try {
    await runSearchCommand(term, parsedOptions, deps);
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

export function createSearchCommand(overrides: Partial<SearchCommandDependencies> = {}) {
  const deps = {
    ...getDefaultDependencies(),
    ...overrides,
  } satisfies SearchCommandDependencies;

  return new Command("search")
    .description("Full-text search across EIPs and meeting TLDRs")
    .argument("<term>", "Search term")
    .option("--type <type>", "Restrict search to: eips or meetings")
    .option("--limit <n>", "Limit the number of results")
    .option("--pretty", "Human-readable output instead of JSON")
    .action((term, _options, command) => handleSearchCommand(term, _options, command, deps));
}

export const searchCommand = createSearchCommand();
