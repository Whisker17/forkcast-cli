import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { extract as extractTar, type ReadEntry } from "tar";
import type { CacheMeta, ErrorCode } from "../types/index.js";

const DEFAULT_COMMIT_URL = "https://api.github.com/repos/ethereum/forkcast/commits/main";
const DEFAULT_PAGES_BASE_URL = "https://ethereum.github.io/forkcast/artifacts";
const CACHE_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TLDR_FETCH_CONCURRENCY = 8;
const MAX_REDIRECTS = 5;
const STALE_DIR_MAX_AGE_MS = 60_000;
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_FILENAME = ".fetch-lock";
const ARCHIVE_REPO_NAME = "forkcast";

function getArchivePrefixes(ref: string) {
  const root = `${ARCHIVE_REPO_NAME}-${ref}/`;
  return {
    eips: `${root}src/data/eips/`,
    artifacts: `${root}public/artifacts/`,
  };
}

export interface WritableLike {
  write(chunk: string): boolean;
}

export interface MeetingManifestEntry {
  type: string;
  dirName: string;
}

export interface FetchEipDataOptions {
  archiveRef?: string;
  archiveUrl?: string;
  cacheRoot?: string;
  commitUrl?: string;
  /**
   * When provided, skip the `getForkcastCommit()` API call and use this SHA
   * directly. Saves one GitHub API request when the caller has already fetched
   * the latest commit (e.g. `forkcast update` smart-update path).
   */
  knownCommit?: string;
  pagesBaseUrl?: string;
  requestTimeoutMs?: number;
  stderr?: WritableLike;
}

export interface FetchEipDataResult {
  meta: CacheMeta;
  meetings: MeetingManifestEntry[];
}

export class FetcherError extends Error {
  code: ErrorCode;

  constructor(message: string, code: ErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "FetcherError";
    this.code = code;
  }
}

interface CachePaths {
  rootDir: string;
  cacheDir: string;
  eipsDir: string;
  metaPath: string;
  meetingsManifestPath: string;
  tldrsDir: string;
}

interface RequestResult {
  body: Buffer;
  headers: http.IncomingHttpHeaders;
  statusCode: number;
}

function getDefaultCacheRoot() {
  return process.env.FORKCAST_CACHE || path.join(os.homedir(), ".forkcast");
}

function getCachePaths(cacheRoot = getDefaultCacheRoot()): CachePaths {
  const cacheDir = path.join(cacheRoot, "cache");
  return {
    rootDir: cacheRoot,
    cacheDir,
    eipsDir: path.join(cacheDir, "eips"),
    metaPath: path.join(cacheDir, "meta.json"),
    meetingsManifestPath: path.join(cacheDir, "meetings-manifest.json"),
    tldrsDir: path.join(cacheDir, "tldrs"),
  };
}

function getHttpModule(url: URL) {
  return url.protocol === "https:" ? https : http;
}

function isRedirect(statusCode: number) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function createFetchError(message: string, cause?: unknown) {
  return new FetcherError(message, "FETCH_FAILED", cause === undefined ? undefined : { cause });
}

function createDataError(message: string, cause?: unknown) {
  return new FetcherError(message, "DATA_ERROR", cause === undefined ? undefined : { cause });
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function buildNetworkError(urlString: string, error: unknown) {
  return createFetchError(`Failed to fetch ${urlString}: ${describeError(error)}`, error);
}

function buildTimeoutError(urlString: string, timeoutMs: number) {
  return createFetchError(`Request timed out after ${timeoutMs}ms while fetching ${urlString}`);
}

async function request(
  urlString: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
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
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const settleReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const req = transport.request(
      url,
      {
        headers: {
          "user-agent": "forkcast-cli",
          ...headers,
        },
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;

        if (isRedirect(statusCode) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, url).toString();
          request(nextUrl, timeoutMs, headers, redirectCount + 1).then(
            (result) => settleResolve(result),
            (error) => settleReject(error instanceof Error ? error : buildNetworkError(nextUrl, error)),
          );
          return;
        }

        const chunks: Buffer[] = [];

        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("close", () => {
          if (!res.complete) {
            settleReject(createFetchError(`Response closed before completion while fetching ${urlString}`));
          }
        });
        res.on("error", (error) => {
          settleReject(buildNetworkError(urlString, error));
        });
        res.on("end", () => {
          settleResolve({
            body: Buffer.concat(chunks),
            headers: res.headers,
            statusCode,
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(buildTimeoutError(urlString, timeoutMs));
    });
    req.on("error", (error) => {
      settleReject(error instanceof FetcherError ? error : buildNetworkError(urlString, error));
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
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const settleReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const req = transport.request(
      url,
      {
        headers: {
          "user-agent": "forkcast-cli",
        },
      },
      async (res) => {
        const statusCode = res.statusCode ?? 0;

        if (isRedirect(statusCode) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, url).toString();
          try {
            await downloadToFile(nextUrl, destinationPath, timeoutMs, redirectCount + 1);
            settleResolve();
          } catch (error) {
            settleReject(error instanceof Error ? error : buildNetworkError(nextUrl, error));
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
            settleReject(createFetchError(`Response closed before completion while fetching ${urlString}`));
          }
        });
        res.on("error", (error) => {
          settleReject(buildNetworkError(urlString, error));
        });
        fileStream.on("error", (error) => {
          settleReject(createFetchError(`Failed to write ${destinationPath}: ${describeError(error)}`, error));
        });

        try {
          await pipeline(res, fileStream);
          settleResolve();
        } catch (error) {
          settleReject(buildNetworkError(urlString, error));
        }
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(buildTimeoutError(urlString, timeoutMs));
    });
    req.on("error", (error) => {
      settleReject(error instanceof FetcherError ? error : buildNetworkError(urlString, error));
    });
    req.end();
  });
}

async function getForkcastCommit(commitUrl: string, timeoutMs: number) {
  const response = await request(commitUrl, timeoutMs, { accept: "application/json" });

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
    throw createDataError(`Invalid JSON returned by ${commitUrl}: ${describeError(error)}`, error);
  }

  if (typeof payload.sha !== "string" || payload.sha.length === 0) {
    throw createDataError(`Forkcast commit response from ${commitUrl} did not include a commit SHA`);
  }

  return payload.sha;
}

function collectMeetingManifestEntry(
  directories: Map<string, MeetingManifestEntry>,
  entryPath: string,
  artifactsPrefix: string,
) {
  if (!entryPath.startsWith(artifactsPrefix)) {
    return;
  }

  const relativePath = entryPath.slice(artifactsPrefix.length);
  const [type, dirName] = relativePath.split("/");

  if (!type || !dirName) {
    return;
  }

  directories.set(`${type}/${dirName}`, { type, dirName });
}

async function extractArchiveData(
  archivePath: string,
  eipsDir: string,
  prefixes: { eips: string; artifacts: string },
): Promise<MeetingManifestEntry[]> {
  const directories = new Map<string, MeetingManifestEntry>();

  await extractTar({
    cwd: eipsDir,
    file: archivePath,
    filter: (entryPath: string, entry: ReadEntry | fs.Stats) => {
      collectMeetingManifestEntry(directories, entryPath, prefixes.artifacts);
      return (
        "type" in entry &&
        entry.type === "File" &&
        entryPath.startsWith(prefixes.eips) &&
        entryPath.endsWith(".json")
      );
    },
    strip: 4,
  });

  return [...directories.values()].sort((left, right) =>
    `${left.type}/${left.dirName}`.localeCompare(`${right.type}/${right.dirName}`),
  );
}

async function fetchTldrContents(
  pagesBaseUrl: string,
  meeting: MeetingManifestEntry,
  timeoutMs: number,
): Promise<string | null> {
  const tldrUrl = `${pagesBaseUrl.replace(/\/$/, "")}/${meeting.type}/${meeting.dirName}/tldr.json`;
  const response = await request(tldrUrl, timeoutMs, { accept: "application/json" });

  if (response.statusCode === 404) {
    return null;
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw createFetchError(`Failed to fetch ${tldrUrl}: HTTP ${response.statusCode}`);
  }

  try {
    return JSON.stringify(JSON.parse(response.body.toString("utf8")), null, 2);
  } catch (error) {
    throw createDataError(`Invalid JSON returned by ${tldrUrl}: ${describeError(error)}`, error);
  }
}

async function withConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
) {
  if (items.length === 0) {
    return;
  }

  let index = 0;
  let cancelled = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!cancelled && index < items.length) {
      const currentIndex = index;
      index += 1;
      try {
        await worker(items[currentIndex]!);
      } catch (error) {
        cancelled = true;
        throw error;
      }
    }
  });

  await Promise.all(workers);
}

async function populateTldrCache(
  meetings: MeetingManifestEntry[],
  tldrsDir: string,
  pagesBaseUrl: string,
  timeoutMs: number,
) {
  await withConcurrency(meetings, DEFAULT_TLDR_FETCH_CONCURRENCY, async (meeting) => {
    const contents = await fetchTldrContents(pagesBaseUrl, meeting, timeoutMs);
    if (contents === null) {
      return;
    }

    const targetDir = path.join(tldrsDir, meeting.type);
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.writeFile(path.join(targetDir, `${meeting.dirName}.json`), contents);
  });
}

async function hasExistingCache(paths: CachePaths) {
  try {
    const [metaStat, eipsStat] = await Promise.all([
      fsp.stat(paths.metaPath),
      fsp.stat(paths.eipsDir),
    ]);
    return metaStat.isFile() && eipsStat.isDirectory();
  } catch {
    return false;
  }
}

async function readMeta(metaPath: string): Promise<CacheMeta> {
  return JSON.parse(await fsp.readFile(metaPath, "utf8")) as CacheMeta;
}

async function readMeetingsManifestFallback(paths: CachePaths, stderr: WritableLike) {
  try {
    return JSON.parse(
      await fsp.readFile(paths.meetingsManifestPath, "utf8"),
    ) as MeetingManifestEntry[];
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      stderr.write("Existing forkcast cache is missing meetings-manifest.json; using an empty meeting inventory.\n");
      return [];
    }

    if (error instanceof SyntaxError) {
      stderr.write("Existing forkcast cache has an invalid meetings manifest; using an empty meeting inventory.\n");
      return [];
    }

    throw error;
  }
}

async function pathExists(targetPath: string) {
  try {
    await fsp.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireFetchLock(rootDir: string): Promise<string> {
  const lockPath = path.join(rootDir, LOCK_FILENAME);

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
            throw createFetchError("Another forkcast fetch is already in progress");
          }
        }
      } catch (readError) {
        if (readError instanceof FetcherError) {
          throw readError;
        }
        if (lockAgeMs < LOCK_STALE_MS) {
          throw createFetchError("Another forkcast fetch is already in progress", readError);
        }
      }

      await fsp.unlink(lockPath).catch(() => {});
    }
  }

  throw createFetchError("Failed to acquire fetch lock after retries");
}

async function releaseFetchLock(lockPath: string): Promise<void> {
  await fsp.unlink(lockPath).catch(() => {});
}

async function cleanupStaleGeneratedDirs(parentDir: string, prefix: string) {
  const now = Date.now();
  let entries: fs.Dirent[];

  try {
    entries = await fsp.readdir(parentDir, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      try {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) {
          return;
        }

        const targetPath = path.join(parentDir, entry.name);
        const stat = await fsp.stat(targetPath);
        if (now - stat.mtimeMs < STALE_DIR_MAX_AGE_MS) {
          return;
        }

        await fsp.rm(targetPath, { force: true, recursive: true });
      } catch {
        // Best-effort cleanup only. Stale generated directories should never block a fetch.
      }
    }),
  );
}

async function cleanupStaleCacheBackups(cacheDir: string) {
  await cleanupStaleGeneratedDirs(path.dirname(cacheDir), `${path.basename(cacheDir)}.bak-`);
}

async function cleanupStaleTempFetchRoots(rootDir: string) {
  await cleanupStaleGeneratedDirs(rootDir, ".tmp-fetch-");
}

async function swapDirectoryAtomically(sourceDir: string, targetDir: string) {
  await fsp.mkdir(path.dirname(targetDir), { recursive: true });
  const backupDir = `${targetDir}.bak-${Date.now()}-${process.pid}`;
  const targetExists = await pathExists(targetDir);

  if (!targetExists) {
    await fsp.rename(sourceDir, targetDir);
    return;
  }

  let movedAside = false;

  try {
    await fsp.rename(targetDir, backupDir);
    movedAside = true;
    await fsp.rename(sourceDir, targetDir);
  } catch (error) {
    if (movedAside) {
      try {
        await fsp.rename(backupDir, targetDir);
      } catch {
        // Best-effort rollback. Preserve the original install error for the caller.
      }
    }

    throw error;
  }

  await fsp.rm(backupDir, { force: true, recursive: true });
}

export async function fetchEipData(options: FetchEipDataOptions = {}): Promise<FetchEipDataResult> {
  const stderr = options.stderr ?? process.stderr;
  const paths = getCachePaths(options.cacheRoot);
  const commitUrl = options.commitUrl ?? DEFAULT_COMMIT_URL;
  const pagesBaseUrl = options.pagesBaseUrl ?? DEFAULT_PAGES_BASE_URL;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  await fsp.mkdir(paths.rootDir, { recursive: true });
  const lockPath = await acquireFetchLock(paths.rootDir);
  let tempRoot: string | null = null;

  try {
    await cleanupStaleCacheBackups(paths.cacheDir);
    await cleanupStaleTempFetchRoots(paths.rootDir);

    let commit: string;

    if (options.knownCommit !== undefined && options.knownCommit.length > 0) {
      commit = options.knownCommit;
    } else {
      try {
        commit = await getForkcastCommit(commitUrl, requestTimeoutMs);
      } catch (error) {
        if (
          error instanceof FetcherError &&
          error.code === "FETCH_FAILED" &&
          /rate limit/i.test(error.message) &&
          (await hasExistingCache(paths))
        ) {
          stderr.write("GitHub API rate limit reached; using existing forkcast cache.\n");
          return {
            meta: await readMeta(paths.metaPath),
            meetings: await readMeetingsManifestFallback(paths, stderr),
          };
        }
        throw error;
      }
    }

    const meta: CacheMeta = {
      forkcast_commit: commit,
      last_updated: new Date().toISOString(),
      version: CACHE_VERSION,
    };
    const archiveRef = options.archiveRef ?? (options.archiveUrl ? "main" : commit);
    const archiveUrl = options.archiveUrl
      ?? `https://github.com/ethereum/forkcast/archive/${commit}.tar.gz`;
    const prefixes = getArchivePrefixes(archiveRef);

    tempRoot = path.join(paths.rootDir, `.tmp-fetch-${Date.now()}-${process.pid}`);
    const stagingCacheDir = path.join(tempRoot, "cache");
    const stagingEipsDir = path.join(stagingCacheDir, "eips");
    const stagingTldrsDir = path.join(stagingCacheDir, "tldrs");
    const archivePath = path.join(tempRoot, "archive.tar.gz");

    await fsp.mkdir(stagingEipsDir, { recursive: true });
    await fsp.mkdir(stagingTldrsDir, { recursive: true });

    await downloadToFile(archiveUrl, archivePath, requestTimeoutMs);
    const meetings = await extractArchiveData(archivePath, stagingEipsDir, prefixes);

    const extractedEipFiles = await fsp.readdir(stagingEipsDir);
    if (extractedEipFiles.length === 0) {
      throw createDataError(
        "Archive extraction produced no EIP files; refusing to replace existing cache with empty data",
      );
    }

    await populateTldrCache(meetings, stagingTldrsDir, pagesBaseUrl, requestTimeoutMs);
    await fsp.writeFile(path.join(stagingCacheDir, "meta.json"), JSON.stringify(meta, null, 2));
    await fsp.writeFile(
      path.join(stagingCacheDir, "meetings-manifest.json"),
      JSON.stringify(meetings, null, 2),
    );
    await swapDirectoryAtomically(stagingCacheDir, paths.cacheDir);

    return { meta, meetings };
  } catch (error) {
    if (error instanceof FetcherError) {
      throw error;
    }

    throw createFetchError(`Failed to fetch data from GitHub: ${describeError(error)}`, error);
  } finally {
    if (tempRoot) {
      await fsp.rm(tempRoot, { force: true, recursive: true });
    }
    await releaseFetchLock(lockPath);
  }
}

export function getCacheRoot() {
  return getDefaultCacheRoot();
}

export function getCacheLayout(cacheRoot = getDefaultCacheRoot()) {
  return getCachePaths(cacheRoot);
}

/**
 * Fetch a single meeting TLDR from GitHub Pages on demand.
 *
 * Returns the prettified JSON string on success, `null` when the upstream
 * confirms the TLDR does not exist (HTTP 404).  Throws `FetcherError` on
 * network or data errors so callers can distinguish "no TLDR" from "fetch
 * broke".
 */
export async function fetchTldr(
  type: string,
  dirName: string,
  options: { pagesBaseUrl?: string; requestTimeoutMs?: number } = {},
): Promise<string | null> {
  const pagesBaseUrl = options.pagesBaseUrl ?? DEFAULT_PAGES_BASE_URL;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return fetchTldrContents(pagesBaseUrl, { type, dirName }, timeoutMs);
}

/**
 * Fetch a single meeting key_decisions.json artifact from GitHub Pages on demand.
 *
 * Returns the prettified JSON string on success, `null` when the upstream
 * confirms the artifact does not exist (HTTP 404).  Throws `FetcherError` on
 * network or data errors so callers can distinguish "no artifact" from "fetch
 * broke".
 */
export async function fetchKeyDecisions(
  type: string,
  dirName: string,
  options: { pagesBaseUrl?: string; requestTimeoutMs?: number } = {},
): Promise<string | null> {
  const pagesBaseUrl = options.pagesBaseUrl ?? DEFAULT_PAGES_BASE_URL;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const url = `${pagesBaseUrl.replace(/\/$/, "")}/${type}/${dirName}/key_decisions.json`;
  const response = await request(url, timeoutMs, { accept: "application/json" });

  if (response.statusCode === 404) {
    return null;
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw createFetchError(`Failed to fetch ${url}: HTTP ${response.statusCode}`);
  }

  try {
    return JSON.stringify(JSON.parse(response.body.toString("utf8")), null, 2);
  } catch (error) {
    throw createDataError(`Invalid JSON returned by ${url}: ${describeError(error)}`, error);
  }
}
