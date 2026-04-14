import fsp from "node:fs/promises";
import https from "node:https";
import { Command } from "commander";
import { buildCache } from "../lib/cache.js";
import { fetchEipData, getCacheLayout, getCacheRoot, type WritableLike } from "../lib/fetcher.js";
import { CommandError, getCommandErrorCode } from "../lib/errors.js";
import { exitCodeForErrorCode, writeJsonEnvelope, writeJsonError, writePrettyError } from "../lib/output.js";
import type { CacheMeta, OutputEnvelope } from "../types/index.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface UpdateResultUpToDate {
  status: "up_to_date";
  commit: string;
  last_updated: string;
}

export interface UpdateResultUpdated {
  status: "updated";
  old_commit: string | null;
  new_commit: string;
  eips_count: number;
  meetings_count: number;
}

export type UpdateResult = UpdateResultUpToDate | UpdateResultUpdated;

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface UpdateCommandDependencies {
  buildCache: typeof buildCache;
  fetchEipData: typeof fetchEipData;
  getCacheRoot: () => string;
  getLatestCommit: (timeoutMs?: number) => Promise<string | null>;
  readMeta: (metaPath: string) => Promise<CacheMeta | null>;
  stderr: WritableLike;
  stdout: WritableLike;
}

const GITHUB_COMMIT_URL = "https://api.github.com/repos/ethereum/forkcast/commits/main";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fetch the latest commit SHA from the GitHub API.
 * Returns `null` when the API rate-limits us (HTTP 403).
 * Throws `CommandError` on network/data errors.
 */
async function fetchLatestCommit(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const url = new URL(GITHUB_COMMIT_URL);

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
              `GitHub API returned HTTP ${statusCode} while fetching latest commit`,
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
              `Network error while fetching latest commit: ${error.message}`,
              "FETCH_FAILED",
              { cause: error },
            ),
          );
        });

        res.on("close", () => {
          if (!res.complete) {
            settleReject(
              new CommandError(
                "Response closed before completion while fetching latest commit",
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
                `Invalid JSON returned by GitHub API: ${error instanceof Error ? error.message : String(error)}`,
                "DATA_ERROR",
                { cause: error },
              ),
            );
            return;
          }

          if (typeof payload.sha !== "string" || payload.sha.length === 0) {
            settleReject(
              new CommandError(
                "GitHub API response did not include a commit SHA",
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
          `Request timed out after ${timeoutMs}ms while fetching latest commit`,
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
          `Network error while fetching latest commit: ${error.message}`,
          "FETCH_FAILED",
          { cause: error },
        ),
      );
    });

    req.end();
  });
}

async function readMetaFile(metaPath: string): Promise<CacheMeta | null> {
  try {
    return JSON.parse(await fsp.readFile(metaPath, "utf8")) as CacheMeta;
  } catch {
    return null;
  }
}

function getDefaultDependencies(): UpdateCommandDependencies {
  return {
    buildCache,
    fetchEipData,
    getCacheRoot,
    getLatestCommit: fetchLatestCommit,
    readMeta: readMetaFile,
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function runUpdateCommand(
  options: { force?: boolean; pretty?: boolean },
  deps: UpdateCommandDependencies,
) {
  const cacheRoot = deps.getCacheRoot();
  const layout = getCacheLayout(cacheRoot);

  // Read existing meta (if any).
  const existingMeta = await deps.readMeta(layout.metaPath);

  if (options.force) {
    // Force path: fetch and rebuild regardless of current commit.
    if (options.pretty) {
      deps.stderr.write("Forcing full cache refresh…\n");
    }

    const fetchResult = await deps.fetchEipData({ cacheRoot, stderr: deps.stderr });
    const buildResult = await deps.buildCache({ cacheRoot });

    const old_commit = existingMeta?.forkcast_commit ?? null;
    const new_commit = fetchResult.meta.forkcast_commit;

    // If the force-fetched commit matches the existing one (e.g. GitHub API was
    // rate-limited inside fetchEipData and the existing cache was returned),
    // report up_to_date instead of "updated" to avoid misleading output.
    if (old_commit !== null && old_commit === new_commit) {
      const result: UpdateResultUpToDate = {
        status: "up_to_date",
        commit: new_commit,
        last_updated: fetchResult.meta.last_updated,
      };

      const envelope: OutputEnvelope<UpdateResultUpToDate> = {
        query: { command: "update", filters: { force: true } },
        results: [result],
        count: 1,
        source: {
          forkcast_commit: new_commit,
          last_updated: fetchResult.meta.last_updated,
        },
        warning: "Force-fetch returned existing cache (possible rate limit); no new data available.",
      };

      if (options.pretty) {
        deps.stdout.write(
          `Already up to date (force). Commit: ${result.commit}\nLast updated: ${result.last_updated}\n`,
        );
        return;
      }

      writeJsonEnvelope(envelope, deps.stdout);
      return;
    }

    const result: UpdateResultUpdated = {
      status: "updated",
      old_commit,
      new_commit,
      eips_count: buildResult.eipCount,
      meetings_count: buildResult.meetingCount,
    };

    const envelope: OutputEnvelope<UpdateResultUpdated> = {
      query: { command: "update", filters: { force: true } },
      results: [result],
      count: 1,
      source: {
        forkcast_commit: fetchResult.meta.forkcast_commit,
        last_updated: fetchResult.meta.last_updated,
      },
    };

    if (options.pretty) {
      deps.stdout.write(
        `Updated: ${result.old_commit ?? "(none)"} → ${result.new_commit}\n`
        + `EIPs: ${result.eips_count}, meetings: ${result.meetings_count}\n`,
      );
      return;
    }

    writeJsonEnvelope(envelope, deps.stdout);
    return;
  }

  // Smart update path: check the latest commit first.
  const latestCommit = await deps.getLatestCommit();

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
          ? { forkcast_commit: existingMeta.forkcast_commit, last_updated: existingMeta.last_updated }
          : { forkcast_commit: "unknown", last_updated: "unknown" },
        warning: "GitHub API rate limited. Try again later.",
      };
      writeJsonEnvelope(envelope, deps.stdout);
    }
    return;
  }

  if (existingMeta && existingMeta.forkcast_commit === latestCommit) {
    // Already up to date.
    const result: UpdateResultUpToDate = {
      status: "up_to_date",
      commit: existingMeta.forkcast_commit,
      last_updated: existingMeta.last_updated,
    };

    const envelope: OutputEnvelope<UpdateResultUpToDate> = {
      query: { command: "update", filters: { force: false } },
      results: [result],
      count: 1,
      source: {
        forkcast_commit: existingMeta.forkcast_commit,
        last_updated: existingMeta.last_updated,
      },
    };

    if (options.pretty) {
      deps.stdout.write(
        `Already up to date. Commit: ${result.commit}\nLast updated: ${result.last_updated}\n`,
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
    old_commit: existingMeta?.forkcast_commit ?? null,
    new_commit: fetchResult.meta.forkcast_commit,
    eips_count: buildResult.eipCount,
    meetings_count: buildResult.meetingCount,
  };

  const envelope: OutputEnvelope<UpdateResultUpdated> = {
    query: { command: "update", filters: { force: false } },
    results: [result],
    count: 1,
    source: {
      forkcast_commit: fetchResult.meta.forkcast_commit,
      last_updated: fetchResult.meta.last_updated,
    },
  };

  if (options.pretty) {
    deps.stdout.write(
      `Updated: ${result.old_commit ?? "(none)"} → ${result.new_commit}\n`
      + `EIPs: ${result.eips_count}, meetings: ${result.meetings_count}\n`,
    );
    return;
  }

  writeJsonEnvelope(envelope, deps.stdout);
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleUpdateCommand(
  _options: { force?: boolean; pretty?: boolean },
  command: Command,
  deps: UpdateCommandDependencies,
) {
  const parsedOptions = command.optsWithGlobals<{ force?: boolean; pretty?: boolean }>();

  try {
    await runUpdateCommand(
      {
        force: parsedOptions.force === true,
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
    .option("--pretty", "Human-readable output instead of JSON")
    .action((_options, command) => handleUpdateCommand(_options, command, deps));
}

export const updateCommand = createUpdateCommand();
