import { Command } from "commander";
import { loadCache } from "../lib/cache.js";
import { countEipsByFork } from "../lib/db.js";
import { getCommandErrorCode } from "../lib/errors.js";
import { loadEipsIndex } from "../lib/eips-index-loader.js";
import { getCacheRoot, type WritableLike } from "../lib/fetcher.js";
import { exitCodeForErrorCode, writeJsonEnvelope, writeJsonError, writePrettyError } from "../lib/output.js";
import type { EipIndexEntry, ForkInclusionStatus, OutputEnvelope } from "../types/index.js";

// ---------------------------------------------------------------------------
// Fork definitions (hardcoded from references/forkcast/src/data/upgrades.ts)
// ---------------------------------------------------------------------------

type ForkStatus = "Live" | "Upcoming" | "Planning" | "Research";

interface ForkDefinition {
  name: string;
  status: ForkStatus;
  activationDate: string | null;
  description: string;
}

const FORK_DEFINITIONS: ForkDefinition[] = [
  {
    name: "Pectra",
    status: "Live",
    activationDate: "May 7, 2025",
    description: "Account abstraction, validator upgrades, and 2x blob throughput",
  },
  {
    name: "Fusaka",
    status: "Live",
    activationDate: "Dec 3, 2025",
    description: "PeerDAS, gas limit increase, introduce BPOs",
  },
  {
    name: "Glamsterdam",
    status: "Upcoming",
    activationDate: "2026",
    description: "Block-level Access Lists and ePBS",
  },
  {
    name: "Hegota",
    status: "Planning",
    activationDate: "TBD",
    description: "Headliner selection concluded: FOCIL SFI'd, Frame Tx CFI'd",
  },
];

// All valid inclusion statuses — kept in a consistent order for predictable output.
const ALL_INCLUSION_STATUSES: ForkInclusionStatus[] = [
  "Proposed",
  "Considered",
  "Scheduled",
  "Included",
  "Declined",
  "Withdrawn",
];

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

type EipsByInclusion = Record<ForkInclusionStatus, number>;

export interface ForkResult {
  name: string;
  status: ForkStatus;
  activationDate: string | null;
  description: string;
  eipCount: number;
  eipsByInclusion: EipsByInclusion;
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface ForksCommandDependencies {
  getCacheRoot: () => string;
  loadCache: typeof loadCache;
  stderr: WritableLike;
  stdout: WritableLike;
}

interface ForksCommandOptions {
  pretty?: boolean;
}

function getDefaultDependencies(): ForksCommandDependencies {
  return {
    getCacheRoot,
    loadCache,
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

// ---------------------------------------------------------------------------
// EIP counting logic
// ---------------------------------------------------------------------------

/**
 * Count EIPs per inclusion status for a given fork by scanning all index
 * entries.  Fork name matching is case-insensitive.
 */
function countEipsForFork(allEntries: EipIndexEntry[], forkName: string): EipsByInclusion {
  const normalizedForkName = forkName.toLowerCase();
  const counts: EipsByInclusion = {
    Proposed: 0,
    Considered: 0,
    Scheduled: 0,
    Included: 0,
    Declined: 0,
    Withdrawn: 0,
  };

  for (const entry of allEntries) {
    for (const forkEntry of entry.forks) {
      if (forkEntry.name.toLowerCase() === normalizedForkName) {
        counts[forkEntry.inclusion] = (counts[forkEntry.inclusion] ?? 0) + 1;
      }
    }
  }

  return counts;
}

function sumCounts(counts: EipsByInclusion): number {
  let total = 0;
  for (const status of ALL_INCLUSION_STATUSES) {
    total += counts[status];
  }
  return total;
}

// ---------------------------------------------------------------------------
// Pretty formatting
// ---------------------------------------------------------------------------

function formatPrettyForks(results: ForkResult[]): string {
  const nameWidth = Math.max("Name".length, ...results.map((r) => r.name.length));
  const statusWidth = Math.max("Status".length, ...results.map((r) => r.status.length));
  const activationWidth = Math.max(
    "Activation".length,
    ...results.map((r) => (r.activationDate ?? "-").length),
  );
  const eipWidth = Math.max("EIPs".length, ...results.map((r) => String(r.eipCount).length));
  const proposedWidth = Math.max(
    "Proposed".length,
    ...results.map((r) => String(r.eipsByInclusion.Proposed).length),
  );
  const consideredWidth = Math.max(
    "Considered".length,
    ...results.map((r) => String(r.eipsByInclusion.Considered).length),
  );
  const scheduledWidth = Math.max(
    "Scheduled".length,
    ...results.map((r) => String(r.eipsByInclusion.Scheduled).length),
  );
  const includedWidth = Math.max(
    "Included".length,
    ...results.map((r) => String(r.eipsByInclusion.Included).length),
  );
  const declinedWidth = Math.max(
    "Declined".length,
    ...results.map((r) => String(r.eipsByInclusion.Declined).length),
  );
  const withdrawnWidth = Math.max(
    "Withdrawn".length,
    ...results.map((r) => String(r.eipsByInclusion.Withdrawn).length),
  );

  const lines: string[] = [
    [
      "Name".padEnd(nameWidth),
      "Status".padEnd(statusWidth),
      "Activation".padEnd(activationWidth),
      "EIPs".padStart(eipWidth),
      "Proposed".padStart(proposedWidth),
      "Considered".padStart(consideredWidth),
      "Scheduled".padStart(scheduledWidth),
      "Included".padStart(includedWidth),
      "Declined".padStart(declinedWidth),
      "Withdrawn".padStart(withdrawnWidth),
    ].join("  "),
  ];

  for (const result of results) {
    const activation = result.activationDate ?? "-";
    lines.push([
      result.name.padEnd(nameWidth),
      result.status.padEnd(statusWidth),
      activation.padEnd(activationWidth),
      String(result.eipCount).padStart(eipWidth),
      String(result.eipsByInclusion.Proposed).padStart(proposedWidth),
      String(result.eipsByInclusion.Considered).padStart(consideredWidth),
      String(result.eipsByInclusion.Scheduled).padStart(scheduledWidth),
      String(result.eipsByInclusion.Included).padStart(includedWidth),
      String(result.eipsByInclusion.Declined).padStart(declinedWidth),
      String(result.eipsByInclusion.Withdrawn).padStart(withdrawnWidth),
    ].join("  "));
  }

  const forkWord = results.length === 1 ? "fork" : "forks";
  lines.push("", `${results.length} ${forkWord}`);

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main business logic
// ---------------------------------------------------------------------------

async function runForksCommand(
  options: ForksCommandOptions,
  deps: ForksCommandDependencies,
) {
  const pretty = options.pretty === true;
  const cacheRoot = deps.getCacheRoot();

  // Load cache first — if DB is available we skip the JSON index entirely.
  const loaded = await deps.loadCache({ cacheRoot, stderr: deps.stderr });

  // Only load the full JSON index when the DB is unavailable.
  let allEntries: EipIndexEntry[] | undefined;
  if (!loaded.db) {
    const idx = await loadEipsIndex(cacheRoot, deps);
    allEntries = idx.allEntries;
  }

  const results: ForkResult[] = FORK_DEFINITIONS.map((fork) => {
    let eipsByInclusion: EipsByInclusion;

    if (loaded.db) {
      // Single GROUP BY query per fork — no JSON.parse, no N+1.
      const dbCounts = countEipsByFork(loaded.db, fork.name);
      eipsByInclusion = {
        Proposed: 0,
        Considered: 0,
        Scheduled: 0,
        Included: 0,
        Declined: 0,
        Withdrawn: 0,
      };
      for (const status of ALL_INCLUSION_STATUSES) {
        eipsByInclusion[status] = dbCounts[status] ?? 0;
      }
    } else {
      eipsByInclusion = countEipsForFork(allEntries!, fork.name);
    }

    return {
      name: fork.name,
      status: fork.status,
      activationDate: fork.activationDate,
      description: fork.description,
      eipCount: sumCounts(eipsByInclusion),
      eipsByInclusion,
    };
  });

  const envelope: OutputEnvelope<ForkResult> = {
    query: {
      command: "forks",
    },
    results,
    count: results.length,
    source: {
      forkcast_commit: loaded.meta.forkcast_commit,
      last_updated: loaded.meta.last_updated,
    },
  };

  if (pretty) {
    deps.stdout.write(formatPrettyForks(results));
    return;
  }

  writeJsonEnvelope(envelope, deps.stdout);
}

// ---------------------------------------------------------------------------
// Error handler wrapper
// ---------------------------------------------------------------------------

async function handleForksCommand(
  _options: ForksCommandOptions,
  command: Command,
  deps: ForksCommandDependencies,
) {
  const parsedOptions = command.optsWithGlobals<ForksCommandOptions>();

  try {
    await runForksCommand(parsedOptions, deps);
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

export function createForksCommand(overrides: Partial<ForksCommandDependencies> = {}) {
  const deps = {
    ...getDefaultDependencies(),
    ...overrides,
  } satisfies ForksCommandDependencies;

  return new Command("forks")
    .description("List all tracked Ethereum network upgrades with EIP counts")
    .option("--pretty", "Human-readable output instead of JSON")
    .action((_options, command) => handleForksCommand(_options, command, deps));
}

export const forksCommand = createForksCommand();
