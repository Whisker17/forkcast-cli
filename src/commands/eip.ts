import fsp from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { loadCache, warnIfStale } from "../lib/cache.js";
import { getEipById, getContextForEip } from "../lib/db.js";
import { getCacheLayout, getCacheRoot, type WritableLike } from "../lib/fetcher.js";
import { CommandError, getCommandErrorCode } from "../lib/errors.js";
import { exitCodeForErrorCode, writeJsonEnvelope, writeJsonError, writePrettyError } from "../lib/output.js";
import type {
  CacheMeta,
  ContextEntry,
  Eip,
  OutputEip,
  OutputEnvelope,
  OutputForkChampion,
  OutputForkRelationship,
  OutputForkStatusHistoryEntry,
  OutputPresentationHistoryEntry,
  OutputSource,
  PresentationHistoryEntry,
} from "../types/index.js";

export interface EipCommandDependencies {
  getCacheRoot: () => string;
  loadCache: typeof loadCache;
  readFile: typeof fsp.readFile;
  stderr: WritableLike;
  stdout: WritableLike;
}

function getDefaultDependencies(): EipCommandDependencies {
  return {
    getCacheRoot,
    loadCache,
    readFile: fsp.readFile.bind(fsp),
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

function parseEipNumber(value: string) {
  if (!/^\d+$/.test(value)) {
    throw new CommandError("Invalid EIP number", "INVALID_INPUT");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CommandError("Invalid EIP number", "INVALID_INPUT");
  }

  return parsed;
}

function normalizeForkChampion(champion: NonNullable<Eip["forkRelationships"][number]["champions"]>[number]): OutputForkChampion {
  return {
    name: champion.name,
    discord: champion.discord ?? null,
    email: champion.email ?? null,
    telegram: champion.telegram ?? null,
  };
}

function normalizeForkStatusHistoryEntry(
  entry: Eip["forkRelationships"][number]["statusHistory"][number],
): OutputForkStatusHistoryEntry {
  return {
    status: entry.status,
    // Upstream JSON is not schema-validated at runtime, so keep these defensive.
    call: entry.call ?? null,
    date: entry.date ?? null,
    timestamp: entry.timestamp ?? null,
  };
}

function normalizePresentationHistoryEntry(entry: PresentationHistoryEntry): OutputPresentationHistoryEntry {
  return {
    type: entry.type,
    call: typeof entry.call === "string" ? entry.call : null,
    date: entry.date,
    link: typeof entry.link === "string" ? entry.link : null,
  };
}

function normalizeForkRelationship(relationship: Eip["forkRelationships"][number]): OutputForkRelationship {
  return {
    forkName: relationship.forkName,
    statusHistory: relationship.statusHistory.map(normalizeForkStatusHistoryEntry),
    champions: relationship.champions?.map(normalizeForkChampion) ?? null,
    isHeadliner: relationship.isHeadliner ?? null,
    wasHeadlinerCandidate: relationship.wasHeadlinerCandidate ?? null,
    presentationHistory: relationship.presentationHistory?.map(normalizePresentationHistoryEntry) ?? null,
  };
}

export function normalizeEipForOutput(eip: Eip): OutputEip {
  return {
    id: eip.id,
    title: eip.title,
    status: eip.status,
    description: eip.description,
    author: eip.author,
    type: eip.type,
    benefits: eip.benefits ?? null,
    category: eip.category ?? null,
    createdDate: eip.createdDate,
    discussionLink: eip.discussionLink ?? null,
    forkRelationships: eip.forkRelationships.map(normalizeForkRelationship),
    layer: eip.layer ?? null,
    laymanDescription: eip.laymanDescription ?? null,
    northStarAlignment: eip.northStarAlignment ?? null,
    northStars: eip.northStars ?? null,
    reviewer: eip.reviewer ?? null,
    stakeholderImpacts: eip.stakeholderImpacts ?? null,
    tradeoffs: eip.tradeoffs ?? null,
  };
}

async function readCachedEip(
  cacheRoot: string,
  eipId: number,
  deps: Pick<EipCommandDependencies, "readFile">,
): Promise<OutputEip> {
  const eipPath = path.join(getCacheLayout(cacheRoot).eipsDir, `${eipId}.json`);

  try {
    return normalizeEipForOutput(JSON.parse(await deps.readFile(eipPath, "utf8")) as Eip);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new CommandError(`EIP ${eipId} not found`, "EIP_NOT_FOUND", { cause: error });
    }

    if (error instanceof SyntaxError) {
      throw new CommandError(`EIP ${eipId} contains invalid JSON`, "DATA_ERROR", { cause: error });
    }

    throw new CommandError(
      `Failed to read cached EIP ${eipId}: ${error instanceof Error ? error.message : String(error)}`,
      "DATA_ERROR",
      { cause: error },
    );
  }
}

function getLatestForkStatusDetails(eip: OutputEip["forkRelationships"][number]) {
  const latestStatus = eip.statusHistory.at(-1);
  if (!latestStatus) {
    return "Unknown";
  }

  const details = [latestStatus.date, latestStatus.call].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  return details.length > 0
    ? `${latestStatus.status} (${details.join(", ")})`
    : latestStatus.status;
}

function formatContextSection(context: ContextEntry[]) {
  if (context.length === 0) {
    return "Related meetings: none";
  }

  const lines = ["Related meetings:"];
  for (const entry of context) {
    lines.push(`- ${entry.meeting} (${entry.date})`);
    for (const mention of entry.mentions) {
      lines.push(`  - ${mention}`);
    }
  }

  return lines.join("\n");
}

function formatPrettyEip(
  eip: OutputEip,
  source: OutputSource,
  context?: ContextEntry[],
) {
  const lines = [
    `${eip.title}`,
    `Status: ${eip.status}`,
    `Type: ${eip.type}`,
    `Category: ${eip.category ?? "n/a"}`,
    `Layer: ${eip.layer ?? "n/a"}`,
    `Created: ${eip.createdDate}`,
    `Author: ${eip.author}`,
    `Source: ${source.forkcast_commit}`,
    `Updated: ${source.last_updated}`,
    "",
    "Description:",
    eip.description,
  ];

  if (eip.laymanDescription) {
    lines.push("", "Lay Summary:", eip.laymanDescription);
  }

  lines.push("", "Fork relationships:");

  if (eip.forkRelationships.length === 0) {
    lines.push("- none");
  } else {
    for (const relationship of eip.forkRelationships) {
      lines.push(`- ${relationship.forkName}: ${getLatestForkStatusDetails(relationship)}`);
    }
  }

  if (context) {
    lines.push("", formatContextSection(context));
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Light path: read meta.json directly without triggering a full index rebuild.
 * Verifies the eips directory also exists — if the cache is only partially
 * populated (e.g. meta.json present but eips/ missing), falls back to
 * loadCache which auto-fetches + rebuilds.
 */
async function loadMetaOrFetch(
  cacheRoot: string,
  deps: EipCommandDependencies,
): Promise<CacheMeta> {
  const layout = getCacheLayout(cacheRoot);
  try {
    const [metaContent] = await Promise.all([
      deps.readFile(layout.metaPath, "utf8"),
      // Verify the eips directory exists.  Without this check, a partial cache
      // (meta.json present, eips/ missing) would fall through to readCachedEip
      // which would misreport the missing file as EIP_NOT_FOUND.
      fsp.stat(layout.eipsDir),
    ]);
    return JSON.parse(metaContent) as CacheMeta;
  } catch {
    // Cache doesn't exist or is incomplete — fall back to full loadCache to
    // trigger auto-fetch.
    const loaded = await deps.loadCache({ cacheRoot, stderr: deps.stderr });
    return loaded.meta;
  }
}

async function runEipCommand(
  eipNumberArg: string,
  options: { context?: boolean; pretty?: boolean },
  deps: EipCommandDependencies,
) {
  const cacheRoot = deps.getCacheRoot();
  const eipId = parseEipNumber(eipNumberArg);

  let meta: CacheMeta;
  let context: ContextEntry[] | undefined;
  let usedLightPath = false;
  let loaded: Awaited<ReturnType<typeof loadCache>> | undefined;

  if (options.context) {
    // Full path: needs the context index, which requires loadCache + potential
    // index rebuild.  This is expected — building the context index requires
    // parsing all TLDRs.
    loaded = await deps.loadCache({ cacheRoot, stderr: deps.stderr });
    meta = loaded.meta;

    // Use SQLite context query when available; fall back to JSON index.
    if (loaded.db) {
      context = getContextForEip(loaded.db, eipId);
    } else {
      const contextIndex = await loaded.readContextIndex();
      context = contextIndex[String(eipId)] ?? [];
    }
  } else {
    // Light path: only needs meta.json + the single EIP file.  Skips the full
    // index rebuild, so a malformed *sibling* EIP cannot break this lookup.
    meta = await loadMetaOrFetch(cacheRoot, deps);
    warnIfStale(meta, deps.stderr);
    usedLightPath = true;
  }

  let eip: OutputEip;
  try {
    // When we already have a loaded cache with SQLite, use the DB for the EIP read.
    // On the light path we skip loadCache, so fall back to file read directly.
    if (loaded?.db) {
      const rawEip = getEipById(loaded.db, eipId);
      if (!rawEip) {
        throw new CommandError(`EIP ${eipId} not found`, "EIP_NOT_FOUND");
      }
      eip = normalizeEipForOutput(rawEip);
    } else {
      eip = await readCachedEip(cacheRoot, eipId, deps);
    }
  } catch (error) {
    // On the light path, a missing EIP file could mean the cache is incomplete
    // (e.g. empty eips/ dir, interrupted fetch) rather than the EIP genuinely
    // not existing.  Fall back to loadCache (which auto-fetches if needed) and
    // retry once.  If the file is still missing after a full load, it's a real
    // EIP_NOT_FOUND.
    if (
      usedLightPath
      && error instanceof CommandError
      && error.code === "EIP_NOT_FOUND"
    ) {
      loaded = await deps.loadCache({ cacheRoot, stderr: deps.stderr });
      meta = loaded.meta;

      // Try SQLite first in the retry path.
      if (loaded.db) {
        const rawEip = getEipById(loaded.db, eipId);
        if (!rawEip) {
          throw new CommandError(`EIP ${eipId} not found`, "EIP_NOT_FOUND");
        }
        eip = normalizeEipForOutput(rawEip);
      } else {
        eip = await readCachedEip(cacheRoot, eipId, deps);
      }
    } else {
      throw error;
    }
  }

  const envelope: OutputEnvelope<OutputEip> = {
    query: {
      command: "eip",
      filters: {
        id: eipId,
        ...(options.context ? { context: true } : {}),
      },
    },
    results: [eip],
    count: 1,
    source: {
      forkcast_commit: meta.forkcast_commit,
      last_updated: meta.last_updated,
    },
    ...(context ? { context } : {}),
  };

  if (options.pretty) {
    deps.stdout.write(formatPrettyEip(eip, envelope.source, context));
    return;
  }

  writeJsonEnvelope(envelope, deps.stdout);
}

async function handleEipCommand(
  eipNumberArg: string,
  _options: { context?: boolean; pretty?: boolean },
  command: Command,
  deps: EipCommandDependencies,
) {
  const parsedOptions = command.optsWithGlobals<{ context?: boolean; pretty?: boolean }>();

  try {
    await runEipCommand(eipNumberArg, {
      context: parsedOptions.context === true,
      pretty: parsedOptions.pretty === true,
    }, deps);
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

export function createEipCommand(
  overrides: Partial<EipCommandDependencies> = {},
) {
  const deps = {
    ...getDefaultDependencies(),
    ...overrides,
  } satisfies EipCommandDependencies;

  return new Command("eip")
    .description("Look up a single EIP by number")
    .argument("<number>", "EIP number")
    .option("--context", "Include related meeting mentions")
    .option("--pretty", "Human-readable output instead of JSON")
    .action((eipNumberArg, _options, command) => handleEipCommand(eipNumberArg, _options, command, deps));
}

export const eipCommand = createEipCommand();
