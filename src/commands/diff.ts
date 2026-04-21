/**
 * `forkcast diff --fork <name> --between <start> <end>` — show what changed in
 * a fork's EIP set between two points in time.
 *
 * Compares the fork's EIP set at the commits closest to `start` and `end`,
 * showing which EIPs were added, removed, or changed status.
 */

import { Command } from "commander";
import { loadCache } from "../lib/cache.js";
import {
  ensureRepo,
  findRepoCommitBefore,
  getEipAtCommit,
  isGitAvailable,
  listEipFilesAtCommit,
  normalizeDate,
  getRepoDirPath,
  GitHistoryError,
} from "../lib/git-history.js";
import { getCacheRoot, type WritableLike } from "../lib/fetcher.js";
import { CommandError, getCommandErrorCode } from "../lib/errors.js";
import { exitCodeForErrorCode, writeJsonEnvelope, writeJsonError, writePrettyError } from "../lib/output.js";
import type { EipDiffEntry, OutputEnvelope } from "../types/index.js";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DiffCommandDependencies {
  getCacheRoot: () => string;
  loadCache: typeof loadCache;
  ensureRepo: typeof ensureRepo;
  getRepoDirPath: (cacheRoot?: string) => string;
  stderr: WritableLike;
  stdout: WritableLike;
}

function getDefaultDependencies(): DiffCommandDependencies {
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
// Fork snapshot helpers
// ---------------------------------------------------------------------------

interface ForkSnapshot {
  /** Map from EIP ID → { inclusion status, EIP lifecycle status }. */
  eips: Map<number, { inclusion: string; eipStatus: string; title: string }>;
}

/**
 * Build a snapshot of all EIPs for a given fork at a given commit.
 * Uses `listEipFilesAtCommit` from git-history.ts, then reads each in parallel.
 */
async function buildForkSnapshot(
  repoDir: string,
  forkName: string,
  commit: string,
): Promise<ForkSnapshot> {
  const lowerFork = forkName.toLowerCase();

  const fileNames = await listEipFilesAtCommit(repoDir, commit);
  if (fileNames.length === 0) return { eips: new Map() };

  const snapshot: ForkSnapshot = { eips: new Map() };

  // Read EIPs in batches
  const batchSize = 20;
  for (let i = 0; i < fileNames.length; i += batchSize) {
    const batch = fileNames.slice(i, i + batchSize);
    await Promise.all(batch.map(async (filePath) => {
      const baseName = filePath.split("/").pop() ?? "";
      const eipIdStr = baseName.replace(".json", "");
      const eipId = Number(eipIdStr);
      if (!Number.isFinite(eipId)) return;

      const eip = await getEipAtCommit(repoDir, eipId, commit);
      if (!eip) return;

      const rel = eip.forkRelationships.find(
        (r) => r.forkName.toLowerCase() === lowerFork,
      );
      if (!rel) return;

      const latestStatus = rel.statusHistory.at(-1)?.status;
      if (!latestStatus) return;

      snapshot.eips.set(eipId, {
        inclusion: latestStatus,
        eipStatus: eip.status,
        title: eip.title,
      });
    }));
  }

  return snapshot;
}

/**
 * Compute the diff between two fork snapshots.
 * Returns EipDiffEntry[] for EIPs that changed between the two snapshots.
 */
function computeDiff(before: ForkSnapshot, after: ForkSnapshot): EipDiffEntry[] {
  const results: EipDiffEntry[] = [];
  const allIds = new Set([...before.eips.keys(), ...after.eips.keys()]);

  for (const eipId of allIds) {
    const bEntry = before.eips.get(eipId);
    const aEntry = after.eips.get(eipId);

    // Skip EIPs that did not change
    if (bEntry && aEntry && bEntry.inclusion === aEntry.inclusion && bEntry.eipStatus === aEntry.eipStatus) {
      continue;
    }

    const added = !bEntry && aEntry !== undefined;
    const removed = bEntry !== undefined && !aEntry;
    const title = aEntry?.title ?? bEntry?.title ?? `EIP-${eipId}`;

    results.push({
      eipId,
      title,
      inclusionBefore: bEntry?.inclusion ?? null,
      inclusionAfter: aEntry?.inclusion ?? null,
      statusBefore: bEntry?.eipStatus ?? "unknown",
      statusAfter: aEntry?.eipStatus ?? "unknown",
      added,
      removed,
    } satisfies EipDiffEntry);
  }

  results.sort((a, b) => a.eipId - b.eipId);
  return results;
}

// ---------------------------------------------------------------------------
// Pretty formatting
// ---------------------------------------------------------------------------

function formatDiffEntry(entry: EipDiffEntry): string {
  const label = entry.added ? "ADDED" : entry.removed ? "REMOVED" : "CHANGED";
  let detail = "";

  if (entry.added) {
    detail = ` (${entry.inclusionAfter ?? entry.statusAfter})`;
  } else if (entry.removed) {
    detail = ` (was ${entry.inclusionBefore ?? entry.statusBefore})`;
  } else {
    const parts: string[] = [];
    if (entry.inclusionBefore !== entry.inclusionAfter) {
      parts.push(`inclusion: ${entry.inclusionBefore} → ${entry.inclusionAfter}`);
    }
    if (entry.statusBefore !== entry.statusAfter) {
      parts.push(`status: ${entry.statusBefore} → ${entry.statusAfter}`);
    }
    if (parts.length > 0) detail = ` (${parts.join(", ")})`;
  }

  return `  [${label}] EIP-${entry.eipId}: ${entry.title}${detail}`;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function runDiffCommand(
  options: {
    fork: string;
    between: [string, string];
    pretty?: boolean;
    skipPull?: boolean;
  },
  deps: DiffCommandDependencies,
): Promise<void> {
  const cacheRoot = deps.getCacheRoot();
  const forkName = options.fork;
  const [startDateRaw, endDateRaw] = options.between;

  if (!forkName || forkName.trim().length === 0) {
    throw new CommandError("--fork is required", "INVALID_INPUT");
  }

  let startDate: string;
  let endDate: string;
  try {
    startDate = normalizeDate(startDateRaw);
    endDate = normalizeDate(endDateRaw);
  } catch (error) {
    if (error instanceof GitHistoryError) {
      throw new CommandError(error.message, "INVALID_INPUT", { cause: error });
    }
    throw error;
  }

  if (startDate > endDate) {
    throw new CommandError(
      `Start date "${startDate}" must be before end date "${endDate}"`,
      "INVALID_INPUT",
    );
  }

  // Check git availability
  if (!(await isGitAvailable())) {
    throw new CommandError(
      "git is not installed. Temporal queries require git.",
      "FETCH_FAILED",
    );
  }

  // Load cache (for meta + source info)
  const loaded = await deps.loadCache({ cacheRoot, stderr: deps.stderr });
  const { meta } = loaded;

  // Ensure repo exists
  const repoDir = deps.getRepoDirPath(cacheRoot);
  try {
    await deps.ensureRepo(repoDir, { stderr: deps.stderr, skipPull: options.skipPull });
  } catch (error) {
    if (error instanceof GitHistoryError) {
      throw new CommandError(error.message, "FETCH_FAILED", { cause: error });
    }
    throw error;
  }

  // Find commits closest to start and end dates
  const [startCommit, endCommit] = await Promise.all([
    findRepoCommitBefore(repoDir, startDate),
    findRepoCommitBefore(repoDir, endDate),
  ]);

  if (!startCommit && !endCommit) {
    throw new CommandError(
      `No commits found before "${endDate}" in the forkcast repo`,
      "DATA_ERROR",
    );
  }

  // Build fork snapshots at each commit
  if (options.pretty) {
    deps.stderr.write(`Building fork snapshot at start date (${startDate})…\n`);
  }

  const beforeSnapshot = startCommit
    ? await buildForkSnapshot(repoDir, forkName, startCommit)
    : { eips: new Map() };

  if (options.pretty) {
    deps.stderr.write(`Building fork snapshot at end date (${endDate})…\n`);
  }

  const afterSnapshot = endCommit
    ? await buildForkSnapshot(repoDir, forkName, endCommit)
    : { eips: new Map() };

  // Compute diff
  const diffEntries = computeDiff(beforeSnapshot, afterSnapshot);

  const envelope: OutputEnvelope<EipDiffEntry> = {
    query: {
      command: "diff",
      filters: {
        fork: forkName,
        startDate,
        endDate,
        startCommit: startCommit ?? null,
        endCommit: endCommit ?? null,
      },
    },
    results: diffEntries,
    count: diffEntries.length,
    source: {
      forkcast_commit: meta.forkcast_commit,
      last_updated: meta.last_updated,
    },
    ...(diffEntries.length === 0
      ? { warning: `No EIP changes found for fork "${forkName}" between ${startDate} and ${endDate}` }
      : {}),
  };

  if (options.pretty) {
    if (diffEntries.length === 0) {
      deps.stdout.write(
        `No changes found for fork "${forkName}" between ${startDate} and ${endDate}.\n`,
      );
      return;
    }

    const added = diffEntries.filter((e) => e.added);
    const removed = diffEntries.filter((e) => e.removed);
    const changed = diffEntries.filter((e) => !e.added && !e.removed);

    deps.stdout.write(
      `Fork diff: ${forkName} from ${startDate} to ${endDate}\n`
      + `Commits: ${startCommit?.slice(0, 8) ?? "(none)"} → ${endCommit?.slice(0, 8) ?? "(none)"}\n\n`,
    );

    if (added.length > 0) {
      deps.stdout.write(`Added (${added.length}):\n`);
      for (const e of added) deps.stdout.write(`${formatDiffEntry(e)}\n`);
      deps.stdout.write("\n");
    }

    if (removed.length > 0) {
      deps.stdout.write(`Removed (${removed.length}):\n`);
      for (const e of removed) deps.stdout.write(`${formatDiffEntry(e)}\n`);
      deps.stdout.write("\n");
    }

    if (changed.length > 0) {
      deps.stdout.write(`Changed (${changed.length}):\n`);
      for (const e of changed) deps.stdout.write(`${formatDiffEntry(e)}\n`);
      deps.stdout.write("\n");
    }

    deps.stdout.write(`Total: ${diffEntries.length} change(s)\n`);
    return;
  }

  writeJsonEnvelope(envelope, deps.stdout);
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleDiffCommand(
  _options: { fork?: string; between?: string[]; pretty?: boolean; skipPull?: boolean },
  command: Command,
  deps: DiffCommandDependencies,
): Promise<void> {
  const rawOptions = command.optsWithGlobals<{
    fork?: string;
    between?: string[];
    pretty?: boolean;
    skipPull?: boolean;
  }>();

  try {
    const forkName = rawOptions.fork;
    if (!forkName) {
      throw new CommandError("--fork <name> is required", "INVALID_INPUT");
    }

    const between = rawOptions.between;
    if (!between || between.length !== 2) {
      throw new CommandError("--between requires exactly two date arguments: --between <start> <end>", "INVALID_INPUT");
    }

    await runDiffCommand(
      {
        fork: forkName,
        between: between as [string, string],
        pretty: rawOptions.pretty === true,
        skipPull: rawOptions.skipPull === true,
      },
      deps,
    );
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

export function createDiffCommand(
  overrides: Partial<DiffCommandDependencies> = {},
) {
  const deps = {
    ...getDefaultDependencies(),
    ...overrides,
  } satisfies DiffCommandDependencies;

  return new Command("diff")
    .description("Show what changed in a fork's EIP set between two dates")
    .requiredOption("--fork <name>", "Fork name (e.g. glamsterdam)")
    .requiredOption("--between <date...>", "Two dates (start and end), e.g. --between 2024-01 2024-06")
    .option("--skip-pull", "Skip git pull (use existing clone)")
    .option("--pretty", "Human-readable output instead of JSON")
    .action((_options, command) => handleDiffCommand(_options, command, deps));
}

export const diffCommand = createDiffCommand();

// Re-export for testing
export { buildForkSnapshot, computeDiff };
export type { ForkSnapshot };
