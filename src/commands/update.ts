import fsp from "node:fs/promises";
import https from "node:https";
import { Command } from "commander";
import { buildCache } from "../lib/cache.js";
import { fetchEipData, getCacheLayout, getCacheRoot, type WritableLike } from "../lib/fetcher.js";
import { fetchPmData, readPmMeta, type PmFetchOptions } from "../lib/pm-fetcher.js";
import {
  ensureRepo,
  getRepoDirPath,
  repoExists,
  GitHistoryError,
} from "../lib/git-history.js";
import { CommandError, getCommandErrorCode } from "../lib/errors.js";
import { exitCodeForErrorCode, writeJsonEnvelope, writeJsonError, writePrettyError } from "../lib/output.js";
import type { CacheMeta, OutputEnvelope } from "../types/index.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface UpdateResultUpToDate {
  status: "up_to_date";
  commit: string;
  lastUpdated: string;
  pmCommit?: string;
  /** True when the forkcast git repo was cloned/updated for temporal queries. */
  repoCloned?: boolean;
}

export interface UpdateResultUpdated {
  status: "updated";
  oldCommit: string | null;
  newCommit: string;
  eipsCount: number;
  meetingsCount: number;
  pmCommit?: string;
  pmNoteCount?: number;
  /** True when the forkcast git repo was cloned/updated for temporal queries. */
  repoCloned?: boolean;
}

export type UpdateResult = UpdateResultUpToDate | UpdateResultUpdated;

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface UpdateCommandDependencies {
  buildCache: typeof buildCache;
  fetchEipData: typeof fetchEipData;
  fetchPmData: typeof fetchPmData;
  getCacheRoot: () => string;
  getLatestCommit: (timeoutMs?: number) => Promise<string | null>;
  getLatestPmCommit: (timeoutMs?: number) => Promise<string | null>;
  readMeta: (metaPath: string) => Promise<CacheMeta | null>;
  ensureRepo: typeof ensureRepo;
  getRepoDirPath: (cacheRoot?: string) => string;
  stderr: WritableLike;
  stdout: WritableLike;
}

const GITHUB_COMMIT_URL = "https://api.github.com/repos/ethereum/forkcast/commits/main";
const GITHUB_PM_COMMIT_URL = "https://api.github.com/repos/ethereum/pm/commits/main";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fetch the latest commit SHA from the given GitHub API URL.
 * Returns `null` when the API rate-limits us (HTTP 403).
 * Throws `CommandError` on network/data errors.
 */
async function fetchLatestCommitFromUrl(
  commitUrl: string,
  label: string,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const url = new URL(commitUrl);

    let settled = false;

    const settleResolve = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const req = https.request(
      url,
      {
        headers: {
          "accept": "application/json",
          "user-agent": "forkcast-cli",
        },
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;

        if (statusCode === 403) {
          res.resume();
          settleResolve(null);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          settleReject(
            new CommandError(
              `GitHub API returned HTTP ${statusCode} while fetching ${label} latest commit`,
              "FETCH_FAILED",
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];

        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        res.on("error", (error) => {
          settleReject(
            new CommandError(
              `Network error while fetching ${label} latest commit: ${error.message}`,
              "FETCH_FAILED",
              { cause: error },
            ),
          );
        });

        res.on("close", () => {
          if (!res.complete) {
            settleReject(
              new CommandError(
                `Response closed before completion while fetching ${label} latest commit`,
                "FETCH_FAILED",
              ),
            );
          }
        });

        res.on("end", () => {
          let payload: { sha?: unknown };
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { sha?: unknown };
          } catch (error) {
            settleReject(
              new CommandError(
                `Invalid JSON returned by GitHub API (${label}): ${error instanceof Error ? error.message : String(error)}`,
                "DATA_ERROR",
                { cause: error },
              ),
            );
            return;
          }

          if (typeof payload.sha !== "string" || payload.sha.length === 0) {
            settleReject(
              new CommandError(
                `GitHub API response (${label}) did not include a commit SHA`,
                "DATA_ERROR",
              ),
            );
            return;
          }

          settleResolve(payload.sha);
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new CommandError(
          `Request timed out after ${timeoutMs}ms while fetching ${label} latest commit`,
          "FETCH_FAILED",
        ),
      );
    });

    req.on("error", (error) => {
      if (error instanceof CommandError) {
        settleReject(error);
        return;
      }
      settleReject(
        new CommandError(
          `Network error while fetching ${label} latest commit: ${error.message}`,
          "FETCH_FAILED",
          { cause: error },
        ),
      );
    });

    req.end();
  });
}

/**
 * Fetch the latest commit SHA from the ethereum/forkcast GitHub API.
 * Returns `null` when the API rate-limits us (HTTP 403).
 * Throws `CommandError` on network/data errors.
 */
async function fetchLatestCommit(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<string | null> {
  return fetchLatestCommitFromUrl(GITHUB_COMMIT_URL, "forkcast", timeoutMs);
}

/**
 * Fetch the latest commit SHA from the ethereum/pm GitHub API.
 * Returns `null` when the API rate-limits us (HTTP 403).
 * Throws `CommandError` on network/data errors.
 */
async function fetchLatestPmCommit(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<string | null> {
  return fetchLatestCommitFromUrl(GITHUB_PM_COMMIT_URL, "pm", timeoutMs);
}

async function readMetaFile(metaPath: string, stderr?: WritableLike): Promise<CacheMeta | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(metaPath, "utf8");
  } catch (error) {
    // File doesn't exist — normal for first-time usage.
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    // Unexpected I/O error — treat as missing but warn.
    stderr?.write(`Warning: failed to read ${metaPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }

  try {
    return JSON.parse(raw) as CacheMeta;
  } catch {
    // File exists but contains invalid JSON — warn so the user knows the cache is damaged.
    stderr?.write(`Warning: ${metaPath} contains invalid JSON; treating cache as empty.\n`);
    return null;
  }
}

function getDefaultDependencies(): UpdateCommandDependencies {
  return {
    buildCache,
    fetchEipData,
    fetchPmData,
    getCacheRoot,
    getLatestCommit: fetchLatestCommit,
    getLatestPmCommit: fetchLatestPmCommit,
    readMeta: (metaPath) => readMetaFile(metaPath, process.stderr),
    ensureRepo,
    getRepoDirPath,
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Try to update pm data if the latest commit is different from what's cached.
 * Returns the pm commit that ended up in cache (may be the same as before if rate-limited).
 * Never throws — gracefully handles rate-limits and network errors by logging to stderr.
 */
async function tryUpdatePm(
  cacheRoot: string,
  deps: UpdateCommandDependencies,
): Promise<{ pmCommit: string | null; pmNoteCount: number }> {
  const pmMeta = await readPmMeta(cacheRoot);

  let latestPmCommit: string | null;
  try {
    latestPmCommit = await deps.getLatestPmCommit();
  } catch (error) {
    deps.stderr.write(
      `Warning: could not check pm repo commit: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { pmCommit: pmMeta?.pm_commit ?? null, pmNoteCount: 0 };
  }

  if (latestPmCommit === null) {
    // Rate-limited — skip pm update
    deps.stderr.write("GitHub API rate limited for pm repo; skipping pm update.\n");
    return { pmCommit: pmMeta?.pm_commit ?? null, pmNoteCount: 0 };
  }

  if (pmMeta && pmMeta.pm_commit === latestPmCommit) {
    // Already up to date
    return { pmCommit: pmMeta.pm_commit, pmNoteCount: 0 };
  }

  // Fetch pm data
  try {
    const pmFetchResult = await deps.fetchPmData({ cacheRoot, stderr: deps.stderr });
    return {
      pmCommit: pmFetchResult.commit,
      pmNoteCount: pmFetchResult.elMeetings + pmFetchResult.clMeetings + pmFetchResult.breakoutMeetings,
    };
  } catch (error) {
    deps.stderr.write(
      `Warning: failed to fetch pm data: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { pmCommit: pmMeta?.pm_commit ?? null, pmNoteCount: 0 };
  }
}

async function runUpdateCommand(
  options: { force?: boolean; clone?: boolean; pretty?: boolean },
  deps: UpdateCommandDependencies,
) {
  const cacheRoot = deps.getCacheRoot();
  const layout = getCacheLayout(cacheRoot);

  // Read existing meta (if any).
  const existingMeta = await deps.readMeta(layout.metaPath);

  // --clone: clone or update the forkcast git repo for temporal queries
  let repoCloned = false;
  if (options.clone) {
    const repoDir = deps.getRepoDirPath(cacheRoot);
    const alreadyExists = await repoExists(repoDir);
    if (options.pretty) {
      deps.stderr.write(alreadyExists ? "Updating forkcast git repo…\n" : "Cloning forkcast git repo…\n");
    }
    try {
      await deps.ensureRepo(repoDir, { stderr: deps.stderr });
      repoCloned = true;
      if (options.pretty) {
        deps.stderr.write("Forkcast git repo ready.\n");
      }
    } catch (error) {
      if (error instanceof GitHistoryError) {
        deps.stderr.write(`Warning: failed to clone/update git repo: ${error.message}\n`);
      } else {
        deps.stderr.write(`Warning: failed to clone/update git repo: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  if (options.force) {
    // Force path: fetch and rebuild regardless of current commit.
    if (options.pretty) {
      deps.stderr.write("Forcing full cache refresh…\n");
    }

    const [fetchResult, pmUpdate] = await Promise.all([
      deps.fetchEipData({ cacheRoot, stderr: deps.stderr }),
      tryUpdatePm(cacheRoot, deps),
    ]);
    const buildResult = await deps.buildCache({ cacheRoot });

    const oldCommit = existingMeta?.forkcast_commit ?? null;
    const newCommit = fetchResult.meta.forkcast_commit;

    // If the force-fetched commit matches the existing one (e.g. GitHub API was
    // rate-limited inside fetchEipData and the existing cache was returned),
    // report up_to_date instead of "updated" to avoid misleading output.
    if (oldCommit !== null && oldCommit === newCommit) {
      const result: UpdateResultUpToDate = {
        status: "up_to_date",
        commit: newCommit,
        lastUpdated: fetchResult.meta.last_updated,
        ...(pmUpdate.pmCommit ? { pmCommit: pmUpdate.pmCommit } : {}),
        ...(repoCloned ? { repoCloned: true } : {}),
      };

      const envelope: OutputEnvelope<UpdateResultUpToDate> = {
        query: { command: "update", filters: { force: true } },
        results: [result],
        count: 1,
        source: {
          forkcast_commit: newCommit,
          last_updated: fetchResult.meta.last_updated,
          ...(pmUpdate.pmCommit ? { pm_commit: pmUpdate.pmCommit } : {}),
        },
        warning: "Force-fetch returned existing cache (possible rate limit); no new data available.",
      };

      if (options.pretty) {
        deps.stdout.write(
          `Already up to date (force). Commit: ${result.commit}\nLast updated: ${result.lastUpdated}\n`,
        );
        return;
      }

      writeJsonEnvelope(envelope, deps.stdout);
      return;
    }

    const result: UpdateResultUpdated = {
      status: "updated",
      oldCommit,
      newCommit,
      eipsCount: buildResult.eipCount,
      meetingsCount: buildResult.meetingCount,
      ...(pmUpdate.pmCommit ? { pmCommit: pmUpdate.pmCommit } : {}),
      ...(pmUpdate.pmNoteCount > 0 ? { pmNoteCount: pmUpdate.pmNoteCount } : {}),
      ...(repoCloned ? { repoCloned: true } : {}),
    };

    const envelope: OutputEnvelope<UpdateResultUpdated> = {
      query: { command: "update", filters: { force: true } },
      results: [result],
      count: 1,
      source: {
        forkcast_commit: fetchResult.meta.forkcast_commit,
        last_updated: fetchResult.meta.last_updated,
        ...(pmUpdate.pmCommit ? { pm_commit: pmUpdate.pmCommit } : {}),
      },
    };

    if (options.pretty) {
      deps.stdout.write(
        `Updated: ${result.oldCommit ?? "(none)"} → ${result.newCommit}\n`
        + `EIPs: ${result.eipsCount}, meetings: ${result.meetingsCount}`
        + (result.pmNoteCount !== undefined ? `, pm notes: ${result.pmNoteCount}` : "")
        + "\n",
      );
      return;
    }

    writeJsonEnvelope(envelope, deps.stdout);
    return;
  }

  // Smart update path: check the latest commits first (forkcast + pm).
  const [latestCommit, pmUpdate] = await Promise.all([
    deps.getLatestCommit(),
    tryUpdatePm(cacheRoot, deps),
  ]);

  if (latestCommit === null) {
    // Rate-limited — warn and exit cleanly.
    if (options.pretty) {
      deps.stderr.write("GitHub API rate limited. Try again later.\n");
    } else {
      const envelope: OutputEnvelope<UpdateResultUpToDate> = {
        query: { command: "update", filters: { force: false } },
        results: [],
        count: 0,
        source: existingMeta
          ? {
            forkcast_commit: existingMeta.forkcast_commit,
            last_updated: existingMeta.last_updated,
            ...(pmUpdate.pmCommit ? { pm_commit: pmUpdate.pmCommit } : {}),
          }
          : { forkcast_commit: "unknown", last_updated: "unknown" },
        warning: "GitHub API rate limited. Try again later.",
      };
      writeJsonEnvelope(envelope, deps.stdout);
    }
    return;
  }

  if (existingMeta && existingMeta.forkcast_commit === latestCommit) {
    // Forkcast is already up to date; pm may have been updated above
    const needsBuildForPm = pmUpdate.pmNoteCount > 0;
    if (needsBuildForPm) {
      await deps.buildCache({ cacheRoot });
    }

    const result: UpdateResultUpToDate = {
      status: "up_to_date",
      commit: existingMeta.forkcast_commit,
      lastUpdated: existingMeta.last_updated,
      ...(pmUpdate.pmCommit ? { pmCommit: pmUpdate.pmCommit } : {}),
      ...(repoCloned ? { repoCloned: true } : {}),
    };

    const envelope: OutputEnvelope<UpdateResultUpToDate> = {
      query: { command: "update", filters: { force: false } },
      results: [result],
      count: 1,
      source: {
        forkcast_commit: existingMeta.forkcast_commit,
        last_updated: existingMeta.last_updated,
        ...(pmUpdate.pmCommit ? { pm_commit: pmUpdate.pmCommit } : {}),
      },
    };

    if (options.pretty) {
      deps.stdout.write(
        `Already up to date. Commit: ${result.commit}\nLast updated: ${result.lastUpdated}\n`,
      );
      return;
    }

    writeJsonEnvelope(envelope, deps.stdout);
    return;
  }

  // New commit available (or no local cache yet) — fetch and rebuild.
  if (options.pretty) {
    if (existingMeta) {
      deps.stderr.write(
        `New commit detected: ${existingMeta.forkcast_commit} → ${latestCommit}\nFetching updates…\n`,
      );
    } else {
      deps.stderr.write(`Fetching initial cache (commit: ${latestCommit})…\n`);
    }
  }

  const fetchResult = await deps.fetchEipData({ cacheRoot, knownCommit: latestCommit, stderr: deps.stderr });
  const buildResult = await deps.buildCache({ cacheRoot });

  const result: UpdateResultUpdated = {
    status: "updated",
    oldCommit: existingMeta?.forkcast_commit ?? null,
    newCommit: fetchResult.meta.forkcast_commit,
    eipsCount: buildResult.eipCount,
    meetingsCount: buildResult.meetingCount,
    ...(pmUpdate.pmCommit ? { pmCommit: pmUpdate.pmCommit } : {}),
    ...(pmUpdate.pmNoteCount > 0 ? { pmNoteCount: pmUpdate.pmNoteCount } : {}),
    ...(repoCloned ? { repoCloned: true } : {}),
  };

  const envelope: OutputEnvelope<UpdateResultUpdated> = {
    query: { command: "update", filters: { force: false } },
    results: [result],
    count: 1,
    source: {
      forkcast_commit: fetchResult.meta.forkcast_commit,
      last_updated: fetchResult.meta.last_updated,
      ...(pmUpdate.pmCommit ? { pm_commit: pmUpdate.pmCommit } : {}),
    },
  };

  if (options.pretty) {
    deps.stdout.write(
      `Updated: ${result.oldCommit ?? "(none)"} → ${result.newCommit}\n`
      + `EIPs: ${result.eipsCount}, meetings: ${result.meetingsCount}`
      + (result.pmNoteCount !== undefined ? `, pm notes: ${result.pmNoteCount}` : "")
      + "\n",
    );
    return;
  }

  writeJsonEnvelope(envelope, deps.stdout);
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleUpdateCommand(
  _options: { force?: boolean; clone?: boolean; pretty?: boolean },
  command: Command,
  deps: UpdateCommandDependencies,
) {
  const parsedOptions = command.optsWithGlobals<{ force?: boolean; clone?: boolean; pretty?: boolean }>();

  try {
    await runUpdateCommand(
      {
        force: parsedOptions.force === true,
        clone: parsedOptions.clone === true,
        pretty: parsedOptions.pretty === true,
      },
      deps,
    );
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

export function createUpdateCommand(
  overrides: Partial<UpdateCommandDependencies> = {},
) {
  const deps = {
    ...getDefaultDependencies(),
    ...overrides,
  } satisfies UpdateCommandDependencies;

  return new Command("update")
    .description("Check for new forkcast data and refresh the local cache if updates are available")
    .option("--force", "Force a full cache refresh regardless of current commit")
    .option("--clone", "Clone or update the forkcast git repo (required for --as-of, timeline, diff commands)")
    .option("--pretty", "Human-readable output instead of JSON")
    .action((_options, command) => handleUpdateCommand(_options, command, deps));
}

export const updateCommand = createUpdateCommand();
