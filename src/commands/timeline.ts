/**
 * `forkcast timeline <number>` — structured chronology of an EIP.
 *
 * Merges git commit history (from the forkcast repo clone) with meeting
 * mention data (from the SQLite DB / context index) into a single
 * chronological timeline, sorted ascending by date.
 */

import { Command } from "commander";
import { loadCache } from "../lib/cache.js";
import { getContextForEip } from "../lib/db.js";
import {
  ensureRepo,
  getEipHistory,
  getRepoDirPath,
  buildTimelineFromHistory,
  isGitAvailable,
  GitHistoryError,
} from "../lib/git-history.js";
import { getCacheRoot, type WritableLike } from "../lib/fetcher.js";
import { CommandError, getCommandErrorCode } from "../lib/errors.js";
import { exitCodeForErrorCode, writeJsonEnvelope, writeJsonError, writePrettyError } from "../lib/output.js";
import type {
  ContextEntry,
  EipTimeline,
  OutputEnvelope,
  TimelineEntry,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface TimelineCommandDependencies {
  getCacheRoot: () => string;
  loadCache: typeof loadCache;
  ensureRepo: typeof ensureRepo;
  getRepoDirPath: (cacheRoot?: string) => string;
  stderr: WritableLike;
  stdout: WritableLike;
}

function getDefaultDependencies(): TimelineCommandDependencies {
  return {
    getCacheRoot,
    loadCache,
    ensureRepo,
    getRepoDirPath,
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseEipNumber(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CommandError("Invalid EIP number", "INVALID_INPUT");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CommandError("Invalid EIP number", "INVALID_INPUT");
  }
  return parsed;
}

/** Convert a ContextEntry (meeting mention) to a TimelineEntry. */
function contextEntryToTimelineEntry(ctx: ContextEntry): TimelineEntry {
  return {
    date: ctx.date,
    type: "meeting_mention",
    meeting: ctx.meeting,
    meetingType: ctx.type,
  };
}

/** Merge git timeline entries with meeting mention entries, sorted by date. */
function mergeAndSortTimeline(
  gitEntries: TimelineEntry[],
  meetingEntries: TimelineEntry[],
  limit?: number,
): TimelineEntry[] {
  const all = [...gitEntries, ...meetingEntries];
  // Compare only the date portion (first 10 chars) so that git dates
  // ("2023-03-15T10:20:30+00:00") and meeting dates ("2023-03-15") can
  // tie-break on entry type.
  const typeOrder: Record<TimelineEntry["type"], number> = {
    git_commit: 0,
    status_change: 1,
    meeting_mention: 2,
  };
  all.sort((a, b) => {
    const diff = a.date.slice(0, 10).localeCompare(b.date.slice(0, 10));
    if (diff !== 0) return diff;
    return typeOrder[a.type] - typeOrder[b.type];
  });

  if (limit !== undefined && limit > 0) {
    // Return the most recent N entries (array is ascending by date).
    return all.slice(-limit);
  }
  return all;
}

/** Format a timeline entry for --pretty output. */
function formatTimelineEntry(entry: TimelineEntry, index: number): string {
  const prefix = `${index + 1}. [${entry.date.slice(0, 10)}]`;
  switch (entry.type) {
    case "git_commit":
      return `${prefix} (commit) ${entry.message ?? ""} — by ${entry.author ?? "unknown"} (${(entry.commit ?? "").slice(0, 8)})`;
    case "status_change":
      if (entry.fork) {
        return `${prefix} (fork status) ${entry.fork}: ${entry.fromStatus} → ${entry.toStatus}`;
      }
      return `${prefix} (status) ${entry.fromStatus} → ${entry.toStatus}`;
    case "meeting_mention":
      return `${prefix} (meeting) ${entry.meeting ?? entry.meetingType ?? "meeting"}`;
    default:
      return `${prefix} (${entry.type})`;
  }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function runTimelineCommand(
  eipNumberArg: string,
  options: { pretty?: boolean; limit?: number; skipPull?: boolean },
  deps: TimelineCommandDependencies,
): Promise<void> {
  const cacheRoot = deps.getCacheRoot();
  const eipId = parseEipNumber(eipNumberArg);
  const limit = options.limit !== undefined ? Number(options.limit) : undefined;

  if (limit !== undefined && (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0)) {
    throw new CommandError("--limit must be a positive integer", "INVALID_INPUT");
  }

  // Check git availability upfront for a clear error message
  if (!(await isGitAvailable())) {
    throw new CommandError(
      "git is not installed. Temporal queries require git.",
      "FETCH_FAILED",
    );
  }

  // Load cache (for context entries and meta)
  const loaded = await deps.loadCache({ cacheRoot, stderr: deps.stderr });
  const { meta } = loaded;

  // Get meeting mention entries
  let meetingEntries: TimelineEntry[] = [];
  if (loaded.db) {
    const ctxEntries = getContextForEip(loaded.db, eipId);
    meetingEntries = ctxEntries.map(contextEntryToTimelineEntry);
  } else {
    const contextIndex = await loaded.readContextIndex();
    const ctxEntries = contextIndex[String(eipId)] ?? [];
    meetingEntries = ctxEntries.map(contextEntryToTimelineEntry);
  }

  // Ensure git repo is available
  const repoDir = deps.getRepoDirPath(cacheRoot);
  try {
    await deps.ensureRepo(repoDir, { stderr: deps.stderr, skipPull: options.skipPull });
  } catch (error) {
    if (error instanceof GitHistoryError) {
      throw new CommandError(error.message, "FETCH_FAILED", { cause: error });
    }
    throw error;
  }

  // Get git history for the EIP
  let historyEntries;
  try {
    historyEntries = await getEipHistory(repoDir, eipId, {
      limit: limit !== undefined ? limit * 3 : undefined, // over-fetch to allow merging
    });
  } catch (error) {
    if (error instanceof GitHistoryError) {
      throw new CommandError(error.message, "DATA_ERROR", { cause: error });
    }
    throw error;
  }

  // Get EIP title from the most recent snapshot (or from cache)
  let eipTitle = `EIP-${eipId}`;
  if (loaded.db) {
    // Quick lookup from DB
    const row = (loaded.db.prepare("SELECT title FROM eips WHERE id = ?").get(eipId) as { title?: string } | undefined);
    if (row?.title) eipTitle = row.title;
  }

  // Build git timeline with status change detection
  let gitEntries: TimelineEntry[] = [];
  try {
    gitEntries = await buildTimelineFromHistory(repoDir, eipId, historyEntries);
  } catch (error) {
    if (error instanceof GitHistoryError) {
      throw new CommandError(error.message, "DATA_ERROR", { cause: error });
    }
    throw error;
  }

  // Merge and sort
  const entries = mergeAndSortTimeline(gitEntries, meetingEntries, limit);

  // Build output
  const timeline: EipTimeline = {
    eipId,
    title: eipTitle,
    entries,
  };

  const envelope: OutputEnvelope<EipTimeline> = {
    query: {
      command: "timeline",
      filters: {
        eipId,
        ...(limit !== undefined ? { limit } : {}),
      },
    },
    results: [timeline],
    count: entries.length,
    source: {
      forkcast_commit: meta.forkcast_commit,
      last_updated: meta.last_updated,
    },
    ...(entries.length === 0 ? { warning: `No timeline data found for EIP-${eipId}` } : {}),
  };

  if (options.pretty) {
    if (entries.length === 0) {
      deps.stdout.write(`No timeline data found for EIP-${eipId}.\n`);
      return;
    }
    deps.stdout.write(`Timeline for ${eipTitle} (EIP-${eipId}):\n\n`);
    for (let i = 0; i < entries.length; i++) {
      deps.stdout.write(`${formatTimelineEntry(entries[i]!, i)}\n`);
    }
    deps.stdout.write(`\n${entries.length} event(s) total\n`);
    return;
  }

  writeJsonEnvelope(envelope, deps.stdout);
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleTimelineCommand(
  eipNumberArg: string,
  _options: { pretty?: boolean; limit?: string; skipPull?: boolean },
  command: Command,
  deps: TimelineCommandDependencies,
): Promise<void> {
  const rawOptions = command.optsWithGlobals<{
    pretty?: boolean;
    limit?: string;
    skipPull?: boolean;
  }>();

  const limit = rawOptions.limit !== undefined ? Number(rawOptions.limit) : undefined;

  try {
    await runTimelineCommand(eipNumberArg, {
      pretty: rawOptions.pretty === true,
      limit,
      skipPull: rawOptions.skipPull === true,
    }, deps);
  } catch (error) {
    const code = getCommandErrorCode(error);
    const message = error instanceof Error ? error.message : String(error);

    if (rawOptions.pretty === true) {
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

export function createTimelineCommand(
  overrides: Partial<TimelineCommandDependencies> = {},
) {
  const deps = {
    ...getDefaultDependencies(),
    ...overrides,
  } satisfies TimelineCommandDependencies;

  return new Command("timeline")
    .description("Show chronological timeline of an EIP (git history + meeting mentions)")
    .argument("<number>", "EIP number")
    .option("--limit <n>", "Limit output to N most recent events")
    .option("--skip-pull", "Skip git pull (use existing clone)")
    .option("--pretty", "Human-readable output instead of JSON")
    .action((eipNumberArg, _options, command) =>
      handleTimelineCommand(eipNumberArg, _options, command, deps));
}

export const timelineCommand = createTimelineCommand();
