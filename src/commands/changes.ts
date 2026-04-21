/**
 * forkcast changes --since <ISO-timestamp>
 *
 * Fetches https://ethereum.github.io/forkcast/api/eip-stage-changes.json,
 * filters entries whose lastStageChange date is >= the since argument, and
 * returns the results wrapped in an OutputEnvelope<StageChange>.
 *
 * Stateless: performs a live fetch every time; does not use the local cache.
 */

import https from "node:https";
import http from "node:http";
import { Command } from "commander";
import { CommandError, getCommandErrorCode } from "../lib/errors.js";
import { exitCodeForErrorCode, writeJsonEnvelope, writeJsonError, writePrettyError } from "../lib/output.js";
import type { OutputEnvelope, StageChange, StageChangesApiResponse } from "../types/index.js";
import type { WritableLike } from "../lib/fetcher.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STAGE_CHANGES_URL = "https://ethereum.github.io/forkcast/api/eip-stage-changes.json";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// Networking helpers
// ---------------------------------------------------------------------------

function getHttpModule(url: URL): typeof https | typeof http {
  return url.protocol === "https:" ? https : http;
}

function isRedirect(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

async function fetchJson<T>(
  urlString: string,
  timeoutMs: number,
  redirectCount = 0,
): Promise<T> {
  if (redirectCount > MAX_REDIRECTS) {
    throw new CommandError(
      `Too many redirects while fetching ${urlString}`,
      "FETCH_FAILED",
    );
  }
  const url = new URL(urlString);
  const transport = getHttpModule(url);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settleResolve = (value: T) => { if (settled) return; settled = true; resolve(value); };
    const settleReject = (error: Error) => { if (settled) return; settled = true; reject(error); };
    const req = transport.request(
      url,
      { headers: { "accept": "application/json", "user-agent": "forkcast-cli" } },
      async (res) => {
        const statusCode = res.statusCode ?? 0;
        if (isRedirect(statusCode) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, url).toString();
          try {
            settleResolve(await fetchJson<T>(nextUrl, timeoutMs, redirectCount + 1));
          } catch (err) {
            settleReject(err instanceof Error ? err : new CommandError(String(err), "FETCH_FAILED"));
          }
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          settleReject(new CommandError(`Failed to fetch ${urlString}: HTTP ${statusCode}`, "FETCH_FAILED"));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
        res.on("close", () => {
          if (!res.complete) {
            settleReject(new CommandError(`Response closed before completion while fetching ${urlString}`, "FETCH_FAILED"));
          }
        });
        res.on("error", (err) => {
          settleReject(new CommandError(`Network error while fetching ${urlString}: ${err.message}`, "FETCH_FAILED", { cause: err }));
        });
        res.on("end", () => {
          try {
            settleResolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch (err) {
            settleReject(new CommandError(
              `Invalid JSON returned by ${urlString}: ${err instanceof Error ? err.message : String(err)}`,
              "DATA_ERROR",
              { cause: err },
            ));
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new CommandError(`Request timed out after ${timeoutMs}ms while fetching ${urlString}`, "FETCH_FAILED"));
    });
    req.on("error", (err) => {
      settleReject(
        err instanceof CommandError
          ? err
          : new CommandError(`Network error while fetching ${urlString}: ${err.message}`, "FETCH_FAILED", { cause: err }),
      );
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

/** Fetches the stage-changes API and returns the parsed payload. */
export type FetchStageChanges = (
  options: { url?: string; timeoutMs?: number },
) => Promise<StageChangesApiResponse>;

export interface ChangesCommandDependencies {
  fetchStageChanges: FetchStageChanges;
  stderr: WritableLike;
  stdout: WritableLike;
}

function defaultFetchStageChanges(
  options: { url?: string; timeoutMs?: number } = {},
): Promise<StageChangesApiResponse> {
  return fetchJson<StageChangesApiResponse>(
    options.url ?? STAGE_CHANGES_URL,
    options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
}

function getDefaultDependencies(): ChangesCommandDependencies {
  return {
    fetchStageChanges: defaultFetchStageChanges,
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Parse and validate the --since argument.
 * Accepts any string parseable by Date.parse; returns the YYYY-MM-DD portion
 * in UTC for lexicographic comparison against lastStageChange date strings.
 */
function parseSinceOption(raw: string): { isoDate: string; original: string } {
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) {
    throw new CommandError(
      `Invalid --since value: "${raw}". Expected an ISO 8601 date or timestamp (e.g. 2025-01-01 or 2025-01-01T00:00:00Z).`,
      "INVALID_INPUT",
    );
  }
  const isoDate = new Date(ts).toISOString().slice(0, 10);
  return { isoDate, original: raw };
}

// ---------------------------------------------------------------------------
// Pretty formatting
// ---------------------------------------------------------------------------

function formatPrettyChanges(results: StageChange[], sinceDate: string): string {
  if (results.length === 0) {
    return "No stage changes found since " + sinceDate + ".\n";
  }
  const lines: string[] = [];
  const idWidth = Math.max("ID".length, ...results.map((r) => String(r.id).length));
  const stageWidth = Math.max("Stage".length, ...results.map((r) => (r.currentStage ?? "").length));
  const forkWidth = Math.max("Fork".length, ...results.map((r) => (r.lastStageChangeFork ?? "").length));
  const dateWidth = Math.max("Changed".length, ...results.map((r) => (r.lastStageChange ?? "").length));
  lines.push(
    [
      "ID".padEnd(idWidth),
      "Stage".padEnd(stageWidth),
      "Fork".padEnd(forkWidth),
      "Changed".padEnd(dateWidth),
      "Title",
    ].join("  "),
  );
  for (const r of results) {
    lines.push(
      [
        String(r.id).padEnd(idWidth),
        (r.currentStage ?? "").padEnd(stageWidth),
        (r.lastStageChangeFork ?? "").padEnd(forkWidth),
        (r.lastStageChange ?? "").padEnd(dateWidth),
        r.title ?? "",
      ].join("  "),
    );
  }
  const resultWord = results.length === 1 ? "result" : "results";
  lines.push("", `${results.length} ${resultWord} since ${sinceDate}`);
  return lines.join("\n") + "\n";
}
// ---------------------------------------------------------------------------

interface ChangesCommandOptions {
  since: string;
  pretty?: boolean;
}

async function runChangesCommand(
  options: ChangesCommandOptions,
  deps: ChangesCommandDependencies,
): Promise<void> {
  const { isoDate, original } = parseSinceOption(options.since);
  const pretty = options.pretty === true;

  let apiResponse: StageChangesApiResponse;
  try {
    apiResponse = await deps.fetchStageChanges({});
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(
      `Failed to fetch stage changes: ${error instanceof Error ? error.message : String(error)}`,
      "FETCH_FAILED",
      { cause: error },
    );
  }

  if (!Array.isArray(apiResponse.eips)) {
    throw new CommandError(
      "Unexpected response from stage-changes API: eips is not an array",
      "DATA_ERROR",
    );
  }

  // Filter: lastStageChange >= since (YYYY-MM-DD lexicographic comparison is correct)
  const results: StageChange[] = apiResponse.eips.filter(
    (entry) => typeof entry.lastStageChange === "string" && entry.lastStageChange >= isoDate,
  );

  // Sort newest-first; break ties by ascending EIP id
  results.sort((a, b) =>
    (a.lastStageChange < b.lastStageChange ? 1 : a.lastStageChange > b.lastStageChange ? -1 : 0) ||
    a.id - b.id,
  );

  const generatedAt = typeof apiResponse.generatedAt === "string"
    ? apiResponse.generatedAt
    : new Date().toISOString();

  const envelope: OutputEnvelope<StageChange> = {
    query: {
      command: "changes",
      filters: { since: original, sinceDate: isoDate },
    },
    results,
    count: results.length,
    source: {
      // The stage-changes endpoint is not commit-versioned; "live" signals that
      // data was fetched on demand rather than from a pinned cache commit.
      forkcast_commit: "live",
      last_updated: generatedAt,
    },
    ...(results.length === 0
      ? { warning: `No EIP stage changes found since ${isoDate}` }
      : {}),
  };

  if (pretty) {
    deps.stdout.write(formatPrettyChanges(results, isoDate));
    return;
  }

  writeJsonEnvelope(envelope, deps.stdout);
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleChangesCommand(
  _options: { since?: string; pretty?: boolean },
  command: Command,
  deps: ChangesCommandDependencies,
): Promise<void> {
  const rawOptions = { ...command.optsWithGlobals<{ since?: string; pretty?: boolean }>(), ..._options };
  try {
    const since = rawOptions.since;
    if (!since || since.trim().length === 0) {
      throw new CommandError("--since <timestamp> is required", "INVALID_INPUT");
    }
    await runChangesCommand(
      { since: since.trim(), pretty: rawOptions.pretty === true },
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

export function createChangesCommand(
  overrides: Partial<ChangesCommandDependencies> = {},
) {
  const deps = {
    ...getDefaultDependencies(),
    ...overrides,
  } satisfies ChangesCommandDependencies;

  return new Command("changes")
    .description(
      "List EIP stage changes since a given date (fetches live from the forkcast API)",
    )
    .requiredOption(
      "--since <timestamp>",
      "Only return changes on or after this ISO 8601 date or timestamp (e.g. 2025-01-01)",
    )
    .option("--pretty", "Human-readable output instead of JSON")
    .action((_options, command) => handleChangesCommand(_options, command, deps));
}

export const changesCommand = createChangesCommand();
