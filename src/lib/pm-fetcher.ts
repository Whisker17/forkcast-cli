/**
 * pm-fetcher.ts
 *
 * Downloads the ethereum/pm repository tarball and extracts meeting note
 * markdown files into the local cache directory.
 *
 * Cache layout after fetch:
 *   ~/.forkcast/pm/el/*.md              — EL meeting notes
 *   ~/.forkcast/pm/cl/*.md              — CL meeting notes
 *   ~/.forkcast/pm/breakout/{topic}/*.md — Breakout room notes
 *   ~/.forkcast/pm-meta.json            — { pm_commit, last_updated, version }
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { extract as extractTar, type ReadEntry } from "tar";
import type { ErrorCode, PmMeta } from "../types/index.js";
import type { WritableLike } from "./fetcher.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ARCHIVE_URL = "https://github.com/ethereum/pm/archive/main.tar.gz";
const DEFAULT_COMMIT_URL = "https://api.github.com/repos/ethereum/pm/commits/main";
const PM_CACHE_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const ARCHIVE_PREFIX = "pm-main/";
const PM_LOCK_FILENAME = ".pm-fetch-lock";
const LOCK_STALE_MS = 10 * 60_000;

/**
 * Directories inside the tarball that contain meeting notes.
 */
const SOURCE_DIRS = {
  el: `${ARCHIVE_PREFIX}AllCoreDevs-EL-Meetings/`,
  cl: `${ARCHIVE_PREFIX}AllCoreDevs-CL-Meetings/`,
  breakout: `${ARCHIVE_PREFIX}Breakout-Room-Meetings/`,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PmFetchOptions {
  cacheRoot?: string;
  stderr?: WritableLike;
  requestTimeoutMs?: number;
  /** Override archive URL (useful for testing). */
  archiveUrl?: string;
  /** Override commit API URL (useful for testing). */
  commitUrl?: string;
}

export interface PmFetchResult {
  commit: string;
  elMeetings: number;
  clMeetings: number;
  breakoutMeetings: number;
}

export type { PmMeta } from "../types/index.js";

export class PmFetcherError extends Error {
  code: ErrorCode;

  constructor(message: string, code: ErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "PmFetcherError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getDefaultCacheRoot() {
  return process.env.FORKCAST_CACHE || path.join(os.homedir(), ".forkcast");
}

interface PmPaths {
  cacheRoot: string;
  cacheDir: string;
  pmDir: string;
  elDir: string;
  clDir: string;
  breakoutDir: string;
  pmMetaPath: string;
}

function getPmPaths(cacheRoot = getDefaultCacheRoot()): PmPaths {
  const cacheDir = path.join(cacheRoot, "cache");
  // pm data lives OUTSIDE cache/ so it survives forkcast's atomic cache/ swap.
  const pmDir = path.join(cacheRoot, "pm");
  return {
    cacheRoot,
    cacheDir,
    pmDir,
    elDir: path.join(pmDir, "el"),
    clDir: path.join(pmDir, "cl"),
    breakoutDir: path.join(pmDir, "breakout"),
    pmMetaPath: path.join(cacheRoot, "pm-meta.json"),
  };
}

export function getPmCachePaths(cacheRoot?: string) {
  return getPmPaths(cacheRoot);
}

// ---------------------------------------------------------------------------
// HTTP utilities
// ---------------------------------------------------------------------------

function getHttpModule(url: URL) {
  return url.protocol === "https:" ? https : http;
}

function isRedirect(statusCode: number) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createFetchError(message: string, cause?: unknown): PmFetcherError {
  return new PmFetcherError(
    message,
    "FETCH_FAILED",
    cause === undefined ? undefined : { cause },
  );
}

function createDataError(message: string, cause?: unknown): PmFetcherError {
  return new PmFetcherError(
    message,
    "DATA_ERROR",
    cause === undefined ? undefined : { cause },
  );
}

interface RequestResult {
  body: Buffer;
  statusCode: number;
}

async function request(
  urlString: string,
  timeoutMs: number,
  redirectCount = 0,
): Promise<RequestResult> {
  if (redirectCount > MAX_REDIRECTS) {
    throw createFetchError(`Too many redirects while fetching ${urlString}`);
  }

  const url = new URL(urlString);
  const transport = getHttpModule(url);

  return new Promise((resolve, reject) => {
    let settled = false;

    const settleResolve = (value: RequestResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const req = transport.request(
      url,
      {
        headers: {
          "user-agent": "forkcast-cli",
          "accept": "application/json",
        },
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;

        if (isRedirect(statusCode) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, url).toString();
          request(nextUrl, timeoutMs, redirectCount + 1).then(
            (result) => settleResolve(result),
            (error) => settleReject(error instanceof Error ? error : createFetchError(describeError(error))),
          );
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("close", () => {
          if (!res.complete) {
            settleReject(createFetchError(`Response closed before completion fetching ${urlString}`));
          }
        });
        res.on("error", (error) => {
          settleReject(createFetchError(`Network error fetching ${urlString}: ${describeError(error)}`, error));
        });
        res.on("end", () => {
          settleResolve({ body: Buffer.concat(chunks), statusCode });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(createFetchError(`Request timed out after ${timeoutMs}ms fetching ${urlString}`));
    });
    req.on("error", (error) => {
      settleReject(error instanceof PmFetcherError ? error : createFetchError(describeError(error), error));
    });
    req.end();
  });
}

async function downloadToFile(
  urlString: string,
  destinationPath: string,
  timeoutMs: number,
  redirectCount = 0,
): Promise<void> {
  if (redirectCount > MAX_REDIRECTS) {
    throw createFetchError(`Too many redirects while fetching ${urlString}`);
  }

  const url = new URL(urlString);
  const transport = getHttpModule(url);

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const req = transport.request(
      url,
      { headers: { "user-agent": "forkcast-cli" } },
      async (res) => {
        const statusCode = res.statusCode ?? 0;

        if (isRedirect(statusCode) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, url).toString();
          try {
            await downloadToFile(nextUrl, destinationPath, timeoutMs, redirectCount + 1);
            settleResolve();
          } catch (error) {
            settleReject(error instanceof Error ? error : createFetchError(describeError(error)));
          }
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          settleReject(createFetchError(`Failed to fetch ${urlString}: HTTP ${statusCode}`));
          return;
        }

        const fileStream = fs.createWriteStream(destinationPath);
        res.on("close", () => {
          if (!res.complete) {
            settleReject(createFetchError(`Response closed before completion fetching ${urlString}`));
          }
        });
        res.on("error", (error) => {
          settleReject(createFetchError(`Network error: ${describeError(error)}`, error));
        });
        fileStream.on("error", (error) => {
          settleReject(createFetchError(`Failed to write ${destinationPath}: ${describeError(error)}`, error));
        });

        try {
          await pipeline(res, fileStream);
          settleResolve();
        } catch (error) {
          settleReject(createFetchError(`Pipeline error: ${describeError(error)}`, error));
        }
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(createFetchError(`Request timed out after ${timeoutMs}ms fetching ${urlString}`));
    });
    req.on("error", (error) => {
      settleReject(error instanceof PmFetcherError ? error : createFetchError(describeError(error), error));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Commit fetch
// ---------------------------------------------------------------------------

async function getPmCommit(commitUrl: string, timeoutMs: number): Promise<string> {
  const response = await request(commitUrl, timeoutMs);

  if (response.statusCode === 403) {
    throw createFetchError(`GitHub API rate limit reached while fetching ${commitUrl}`);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw createFetchError(`Failed to fetch ${commitUrl}: HTTP ${response.statusCode}`);
  }

  let payload: { sha?: unknown };
  try {
    payload = JSON.parse(response.body.toString("utf8")) as { sha?: unknown };
  } catch (error) {
    throw createDataError(`Invalid JSON from ${commitUrl}: ${describeError(error)}`, error);
  }

  if (typeof payload.sha !== "string" || payload.sha.length === 0) {
    throw createDataError(`pm commit response from ${commitUrl} did not include a commit SHA`);
  }

  return payload.sha;
}

// ---------------------------------------------------------------------------
// Archive extraction
// ---------------------------------------------------------------------------

/**
 * Tracks how many files were extracted per category.
 */
interface ExtractStats {
  elMeetings: number;
  clMeetings: number;
  breakoutMeetings: number;
}

/**
 * Determine the target path for a given tarball entry path.
 * Returns null if the entry should be skipped.
 *
 * @param entryPath - Path of the entry within the tarball.
 * @param stagingPmDir - Staging directory for pm files.
 */
function resolveEntryTarget(
  entryPath: string,
  stagingPmDir: string,
): string | null {
  // EL meetings: pm-main/AllCoreDevs-EL-Meetings/Meeting NN.md
  if (entryPath.startsWith(SOURCE_DIRS.el)) {
    const filename = entryPath.slice(SOURCE_DIRS.el.length);
    if (!filename || filename.includes("/") || !filename.endsWith(".md")) {
      return null;
    }
    return path.join(stagingPmDir, "el", filename);
  }

  // CL meetings: pm-main/AllCoreDevs-CL-Meetings/call_NNN.md
  if (entryPath.startsWith(SOURCE_DIRS.cl)) {
    const filename = entryPath.slice(SOURCE_DIRS.cl.length);
    if (!filename || filename.includes("/") || !filename.endsWith(".md")) {
      return null;
    }
    return path.join(stagingPmDir, "cl", filename);
  }

  // Breakout rooms: pm-main/Breakout-Room-Meetings/{topic}/Meeting NN.md
  if (entryPath.startsWith(SOURCE_DIRS.breakout)) {
    const relative = entryPath.slice(SOURCE_DIRS.breakout.length);
    const parts = relative.split("/");
    // Must be: {topic}/{filename}.md (exactly 2 parts)
    if (parts.length !== 2 || !parts[0] || !parts[1] || !parts[1].endsWith(".md")) {
      return null;
    }
    return path.join(stagingPmDir, "breakout", parts[0], parts[1]);
  }

  return null;
}

async function extractPmArchive(
  archivePath: string,
  stagingPmDir: string,
  stderr: WritableLike,
): Promise<ExtractStats> {
  const stats: ExtractStats = {
    elMeetings: 0,
    clMeetings: 0,
    breakoutMeetings: 0,
  };

  // Ensure all required target directories exist before extraction
  await fsp.mkdir(path.join(stagingPmDir, "el"), { recursive: true });
  await fsp.mkdir(path.join(stagingPmDir, "cl"), { recursive: true });

  // We'll create breakout series dirs on demand via a set tracking which we've made
  const createdDirs = new Set<string>();

  const writePromises: Promise<void>[] = [];

  await extractTar({
    file: archivePath,
    filter: (entryPath: string, entry: ReadEntry | fs.Stats) => {
      // Only extract File entries with .md extension
      if (!("type" in entry) || (entry as ReadEntry).type !== "File") {
        return false;
      }
      if (!entryPath.endsWith(".md")) {
        return false;
      }
      return resolveEntryTarget(entryPath, stagingPmDir) !== null;
    },
    onentry: (entry: ReadEntry) => {
      const target = resolveEntryTarget(entry.path, stagingPmDir);
      if (!target) {
        entry.resume();
        return;
      }

      // Create breakout series directory if needed (synchronously using mkdirSync since we're in callback)
      const targetDir = path.dirname(target);
      if (!createdDirs.has(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
        createdDirs.add(targetDir);
      }

      // Pipe entry to its target file and track the promise
      const writePromise = new Promise<void>((resolve, reject) => {
        const fileStream = fs.createWriteStream(target);
        fileStream.on("error", reject);
        fileStream.on("close", resolve);
        entry.pipe(fileStream);
        entry.on("error", reject);
      });

      writePromises.push(writePromise);

      // Count by category
      if (entry.path.startsWith(SOURCE_DIRS.el)) {
        stats.elMeetings++;
      } else if (entry.path.startsWith(SOURCE_DIRS.cl)) {
        stats.clMeetings++;
      } else if (entry.path.startsWith(SOURCE_DIRS.breakout)) {
        stats.breakoutMeetings++;
      }
    },
  });

  // Wait for all file writes to complete
  await Promise.all(writePromises);

  const totalFiles = stats.elMeetings + stats.clMeetings + stats.breakoutMeetings;
  if (totalFiles === 0) {
    stderr.write("Warning: pm archive extraction produced no meeting note files.\n");
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the existing pm-meta.json, returning null if it doesn't exist or
 * contains invalid JSON.
 */
export async function readPmMeta(cacheRoot?: string): Promise<PmMeta | null> {
  const paths = getPmPaths(cacheRoot);
  try {
    const raw = await fsp.readFile(paths.pmMetaPath, "utf8");
    return JSON.parse(raw) as PmMeta;
  } catch {
    return null;
  }
}

/**
 * Download the ethereum/pm repository tarball and extract meeting notes into
 * the local cache directory.
 *
 * Creates:
 *   ~/.forkcast/pm/el/*.md
 *   ~/.forkcast/pm/cl/*.md
 *   ~/.forkcast/pm/breakout/{topic}/*.md
 *   ~/.forkcast/pm-meta.json
 */
export async function fetchPmData(options: PmFetchOptions = {}): Promise<PmFetchResult> {
  const stderr = options.stderr ?? process.stderr;
  const paths = getPmPaths(options.cacheRoot);
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const archiveUrl = options.archiveUrl ?? DEFAULT_ARCHIVE_URL;
  const commitUrl = options.commitUrl ?? DEFAULT_COMMIT_URL;

  // Ensure the root directory exists (temp dir + pm dir live here, not inside cache/)
  await fsp.mkdir(paths.cacheRoot, { recursive: true });

  let commit: string;
  try {
    commit = await getPmCommit(commitUrl, timeoutMs);
  } catch (error) {
    if (
      error instanceof PmFetcherError
      && error.code === "FETCH_FAILED"
      && /rate limit/i.test(error.message)
    ) {
      // Graceful degradation: return whatever we have
      stderr.write("GitHub API rate limit reached for pm repo; skipping pm update.\n");
      const existing = await readPmMeta(options.cacheRoot);
      if (existing) {
        return {
          commit: existing.pm_commit,
          elMeetings: 0,
          clMeetings: 0,
          breakoutMeetings: 0,
        };
      }
      throw error;
    }
    throw error;
  }

  // Acquire process lock to prevent concurrent pm fetches
  const lockPath = await acquirePmFetchLock(paths.cacheRoot);

  // Use a temp directory under cacheRoot (NOT inside cache/) for atomic replacement
  const tempDir = path.join(paths.cacheRoot, `.tmp-pm-fetch-${Date.now()}-${process.pid}`);
  const stagingPmDir = path.join(tempDir, "pm");
  const archivePath = path.join(tempDir, "pm-archive.tar.gz");

  try {
    await fsp.mkdir(tempDir, { recursive: true });
    await fsp.mkdir(stagingPmDir, { recursive: true });

    stderr.write(`Fetching pm repo (commit: ${commit.slice(0, 12)})…\n`);
    await downloadToFile(archiveUrl, archivePath, timeoutMs);

    const extractStats = await extractPmArchive(archivePath, stagingPmDir, stderr);

    const totalFiles = extractStats.elMeetings + extractStats.clMeetings + extractStats.breakoutMeetings;
    if (totalFiles === 0) {
      throw createDataError(
        "pm archive extraction produced no meeting note files; refusing to update cache",
      );
    }

    // Atomically replace the pm directory
    const backupDir = `${paths.pmDir}.bak-${Date.now()}-${process.pid}`;
    const pmDirExists = await pathExists(paths.pmDir);

    if (pmDirExists) {
      await fsp.rename(paths.pmDir, backupDir);
    }

    try {
      await fsp.rename(stagingPmDir, paths.pmDir);
    } catch (error) {
      // Rollback
      if (pmDirExists) {
        await fsp.rename(backupDir, paths.pmDir).catch(() => {});
      }
      throw error;
    }

    if (pmDirExists) {
      await fsp.rm(backupDir, { force: true, recursive: true }).catch(() => {});
    }

    // Write pm-meta.json
    const meta: PmMeta = {
      pm_commit: commit,
      last_updated: new Date().toISOString(),
      version: PM_CACHE_VERSION,
    };
    await writeJsonAtomic(paths.pmMetaPath, meta);

    return {
      commit,
      elMeetings: extractStats.elMeetings,
      clMeetings: extractStats.clMeetings,
      breakoutMeetings: extractStats.breakoutMeetings,
    };
  } catch (error) {
    if (error instanceof PmFetcherError) {
      throw error;
    }
    throw createFetchError(`Failed to fetch pm data: ${describeError(error)}`, error);
  } finally {
    await releasePmFetchLock(lockPath);
    await fsp.rm(tempDir, { force: true, recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Process lock
// ---------------------------------------------------------------------------

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquirePmFetchLock(rootDir: string): Promise<string> {
  const lockPath = path.join(rootDir, PM_LOCK_FILENAME);

  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
    try {
      handle = await fsp.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
      await handle.close();
      handle = undefined;
      return lockPath;
    } catch (error: unknown) {
      if (handle) {
        await handle.close().catch(() => {});
      }

      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      ) {
        throw error;
      }

      let lockStat: fs.Stats;
      try {
        lockStat = await fsp.stat(lockPath);
      } catch (statError) {
        if (statError instanceof Error && "code" in statError && statError.code === "ENOENT") {
          continue;
        }
        throw statError;
      }

      const lockAgeMs = Date.now() - lockStat.mtimeMs;
      try {
        if (lockAgeMs < LOCK_STALE_MS) {
          const raw = await fsp.readFile(lockPath, "utf8");
          const info = JSON.parse(raw) as { pid: number; ts: number };
          if (isProcessAlive(info.pid) && Date.now() - info.ts < LOCK_STALE_MS) {
            throw createFetchError("Another pm fetch is already in progress");
          }
        }
      } catch (readError) {
        if (readError instanceof PmFetcherError) {
          throw readError;
        }
        if (lockAgeMs < LOCK_STALE_MS) {
          throw createFetchError("Another pm fetch is already in progress", readError);
        }
      }

      await fsp.unlink(lockPath).catch(() => {});
    }
  }

  throw createFetchError("Failed to acquire pm fetch lock after retries");
}

async function releasePmFetchLock(lockPath: string): Promise<void> {
  await fsp.unlink(lockPath).catch(() => {});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(tmpPath, JSON.stringify(value, null, 2));
  await fsp.rename(tmpPath, filePath);
}
