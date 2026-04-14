import fsp from "node:fs/promises";
import { Command } from "commander";
import { loadCache } from "../lib/cache.js";
import { CommandError, getCommandErrorCode } from "../lib/errors.js";
import { getCacheLayout, getCacheRoot, type WritableLike } from "../lib/fetcher.js";
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
    name: "Hegotá",
    status: "Planning",
    activationDate: null,
    description: "FOCIL SFI'd, Frame Tx CFI'd",
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
// Index validation
// ---------------------------------------------------------------------------

/**
 * Validate that the parsed eips-index.json has the expected shape.
 * Throws DATA_ERROR so the caller can treat it the same way as a corrupt or
 * missing cache (triggering a self-healing retry).
 */
function validateEipsIndex(raw: unknown): EipIndexEntry[] {
  if (!Array.isArray(raw)) {
    throw new CommandError(
      "eips-index.json has an unexpected shape (expected an array)",
      "DATA_ERROR",
    );
  }

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (
      entry === null
      || typeof entry !== "object"
      || typeof (entry as Record<string, unknown>).id !== "number"
      || typeof (entry as Record<string, unknown>).status !== "string"
      || !Array.isArray((entry as Record<string, unknown>).forks)
    ) {
      throw new CommandError(
        `eips-index.json entry at index ${i} is missing required fields (id, status, forks)`,
        "DATA_ERROR",
      );
    }
  }

  return raw as EipIndexEntry[];
}

// ---------------------------------------------------------------------------
// Cache loading (with self-healing retry)
// ---------------------------------------------------------------------------

async function loadEipsIndex(
  cacheRoot: string,
  deps: ForksCommandDependencies,
): Promise<{ loaded: Awaited<ReturnType<typeof loadCache>>; allEntries: EipIndexEntry[] }> {
  const tryLoad = async () => {
    const loaded = await deps.loadCache({ cacheRoot, stderr: deps.stderr });
    const raw = await loaded.readEipsIndex();
    const allEntries = validateEipsIndex(raw);
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
  const { loaded, allEntries } = await loadEipsIndex(cacheRoot, deps);

  const results: ForkResult[] = FORK_DEFINITIONS.map((fork) => {
    const eipsByInclusion = countEipsForFork(allEntries, fork.name);
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
