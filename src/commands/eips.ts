import fsp from "node:fs/promises";
import { Command } from "commander";
import { loadCache } from "../lib/cache.js";
import { CommandError, getCommandErrorCode } from "../lib/errors.js";
import { getCacheLayout, getCacheRoot, type WritableLike } from "../lib/fetcher.js";
import { exitCodeForErrorCode, writeJsonEnvelope, writeJsonError, writePrettyError } from "../lib/output.js";
import type { EipIndexEntry, EipStatus, ForkInclusionStatus, OutputEnvelope } from "../types/index.js";

const VALID_EIP_STATUSES: Record<string, EipStatus> = {
  draft: "Draft",
  review: "Review",
  "last call": "Last Call",
  final: "Final",
  stagnant: "Stagnant",
  withdrawn: "Withdrawn",
  living: "Living",
};

const VALID_INCLUSION_STATUSES: Record<string, ForkInclusionStatus> = {
  proposed: "Proposed",
  considered: "Considered",
  scheduled: "Scheduled",
  included: "Included",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

const VALID_LAYERS: Record<string, "EL" | "CL"> = {
  el: "EL",
  cl: "CL",
};

export interface EipsCommandDependencies {
  getCacheRoot: () => string;
  loadCache: typeof loadCache;
  stderr: WritableLike;
  stdout: WritableLike;
}

interface EipsCommandOptions {
  fork?: string;
  inclusion?: string;
  layer?: string;
  limit?: string | number;
  pretty?: boolean;
  status?: string;
}

interface ParsedFilters {
  fork?: string;
  inclusion?: ForkInclusionStatus;
  layer?: "EL" | "CL";
  limit?: number;
  pretty: boolean;
  status?: EipStatus;
}

function getDefaultDependencies(): EipsCommandDependencies {
  return {
    getCacheRoot,
    loadCache,
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

function normalizeInput(value: string) {
  return value.trim().toLowerCase();
}

function normalizeStatus(value: string) {
  const normalized = VALID_EIP_STATUSES[normalizeInput(value)];
  if (!normalized) {
    throw new CommandError(`Invalid EIP status: ${value}`, "INVALID_INPUT");
  }
  return normalized;
}

function normalizeInclusion(value: string): ForkInclusionStatus {
  const normalized = VALID_INCLUSION_STATUSES[normalizeInput(value)];
  if (!normalized) {
    throw new CommandError(`Invalid fork inclusion status: ${value}`, "INVALID_INPUT");
  }
  return normalized;
}

function normalizeLayer(value: string) {
  const normalized = VALID_LAYERS[normalizeInput(value)];
  if (!normalized) {
    throw new CommandError(`Invalid layer: ${value}`, "INVALID_INPUT");
  }
  return normalized;
}

function parseLimit(value: string | number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CommandError("Invalid limit", "INVALID_INPUT");
  }
  return parsed;
}

function parseFilters(options: EipsCommandOptions): ParsedFilters {
  return {
    fork: typeof options.fork === "string" && options.fork.trim() !== "" ? options.fork.trim() : undefined,
    inclusion: typeof options.inclusion === "string" ? normalizeInclusion(options.inclusion) : undefined,
    layer: typeof options.layer === "string" ? normalizeLayer(options.layer) : undefined,
    limit: options.limit !== undefined ? parseLimit(options.limit) : undefined,
    pretty: options.pretty === true,
    status: typeof options.status === "string" ? normalizeStatus(options.status) : undefined,
  };
}

/**
 * Validate that the parsed eips-index.json has the expected shape.
 * The file is cached on disk and could be schema-skewed (e.g. an old write
 * produced an object instead of an array, or individual entries are missing
 * required fields).  Throws DATA_ERROR so the caller can treat it the same
 * way as a corrupt/missing cache.
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

/**
 * Load the cache and read + validate the EIP index, with one self-healing
 * retry.  If the cache appears to exist but is actually broken (e.g. empty
 * eips/ dir, or schema-skewed index file), we delete the cache directory and
 * let loadCache start from scratch via a fresh auto-fetch.
 */
async function loadEipsIndex(
  cacheRoot: string,
  deps: EipsCommandDependencies,
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

function matchesFork(entry: EipIndexEntry, fork?: string) {
  if (!fork) {
    return true;
  }

  const normalizedFork = normalizeInput(fork);
  return entry.forks.some((relationship) => normalizeInput(relationship.name) === normalizedFork);
}

function matchesInclusion(entry: EipIndexEntry, inclusion?: ForkInclusionStatus, fork?: string) {
  if (!inclusion) {
    return true;
  }

  const normalizedFork = fork ? normalizeInput(fork) : undefined;

  return entry.forks.some((relationship) => {
    if (relationship.inclusion !== inclusion) {
      return false;
    }

    if (!normalizedFork) {
      return true;
    }

    return normalizeInput(relationship.name) === normalizedFork;
  });
}

function getLayerWarning(allEntries: EipIndexEntry[], layer?: "EL" | "CL") {
  if (!layer) {
    return undefined;
  }

  const withLayer = allEntries.filter((entry) => entry.layer !== null).length;
  const excluded = allEntries.length - withLayer;
  const eipWord = excluded === 1 ? "EIP was" : "EIPs were";
  return `Only ${withLayer} of ${allEntries.length} EIPs have a layer field. ${excluded} ${eipWord} excluded from this filter.`;
}

function formatForks(entry: EipIndexEntry) {
  if (entry.forks.length === 0) {
    return "none";
  }

  return entry.forks.map((relationship) => `${relationship.name}: ${relationship.inclusion}`).join(", ");
}

function formatPrettyRows(entries: EipIndexEntry[]) {
  const titleWidth = Math.max("Title".length, ...entries.map((entry) => entry.title.length));
  const statusWidth = Math.max("Status".length, ...entries.map((entry) => entry.status.length));
  const idWidth = Math.max("ID".length, ...entries.map((entry) => String(entry.id).length));
  const layerWidth = "Layer".length;

  const lines = [
    [
      "ID".padEnd(idWidth),
      "Title".padEnd(titleWidth),
      "Status".padEnd(statusWidth),
      "Layer".padEnd(layerWidth),
      "Forks",
    ].join("  "),
  ];

  for (const entry of entries) {
    const layerCell = entry.layer ?? "-";
    lines.push([
      String(entry.id).padEnd(idWidth),
      entry.title.padEnd(titleWidth),
      entry.status.padEnd(statusWidth),
      layerCell.padEnd(layerWidth),
      formatForks(entry),
    ].join("  "));
  }

  return lines.join("\n");
}

function formatPrettyEips(entries: EipIndexEntry[], warning?: string) {
  const lines = [];

  if (warning) {
    lines.push(`Warning: ${warning}`, "");
  }

  lines.push(formatPrettyRows(entries));

  const resultWord = entries.length === 1 ? "result" : "results";
  lines.push("", `${entries.length} ${resultWord}`);

  return `${lines.join("\n")}\n`;
}

async function runEipsCommand(options: EipsCommandOptions, deps: EipsCommandDependencies) {
  const parsedFilters = parseFilters(options);
  const cacheRoot = deps.getCacheRoot();
  const { loaded, allEntries } = await loadEipsIndex(cacheRoot, deps);

  let results = allEntries.filter((entry) => matchesFork(entry, parsedFilters.fork));

  if (parsedFilters.status) {
    results = results.filter((entry) => entry.status === parsedFilters.status);
  }

  results = results.filter((entry) => matchesInclusion(entry, parsedFilters.inclusion, parsedFilters.fork));

  if (parsedFilters.layer) {
    results = results.filter((entry) => entry.layer === parsedFilters.layer);
  }

  if (parsedFilters.limit !== undefined) {
    results = results.slice(0, parsedFilters.limit);
  }

  const warning = getLayerWarning(allEntries, parsedFilters.layer);

  const envelope: OutputEnvelope<EipIndexEntry> = {
    query: {
      command: "eips",
      filters: {
        ...(parsedFilters.fork ? { fork: parsedFilters.fork } : {}),
        ...(parsedFilters.status ? { status: parsedFilters.status } : {}),
        ...(parsedFilters.inclusion ? { inclusion: parsedFilters.inclusion } : {}),
        ...(parsedFilters.layer ? { layer: parsedFilters.layer } : {}),
        ...(parsedFilters.limit !== undefined ? { limit: parsedFilters.limit } : {}),
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

  if (parsedFilters.pretty) {
    deps.stdout.write(formatPrettyEips(results, warning));
    return;
  }

  writeJsonEnvelope(envelope, deps.stdout);
}

async function handleEipsCommand(
  _options: EipsCommandOptions,
  command: Command,
  deps: EipsCommandDependencies,
) {
  const parsedOptions = command.optsWithGlobals<EipsCommandOptions>();

  try {
    await runEipsCommand(parsedOptions, deps);
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

export function createEipsCommand(overrides: Partial<EipsCommandDependencies> = {}) {
  const deps = {
    ...getDefaultDependencies(),
    ...overrides,
  } satisfies EipsCommandDependencies;

  return new Command("eips")
    .description("List and filter indexed EIPs")
    .option("--fork <name>", "Filter by fork name")
    .option("--status <status>", "Filter by EIP lifecycle status")
    .option("--inclusion <status>", "Filter by fork inclusion status")
    .option("--layer <layer>", "Filter by layer")
    .option("--limit <n>", "Limit the number of results")
    .option("--pretty", "Human-readable output instead of JSON")
    .action((_options, command) => handleEipsCommand(_options, command, deps));
}

export const eipsCommand = createEipsCommand();
