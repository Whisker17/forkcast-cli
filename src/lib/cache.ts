import fsp from "node:fs/promises";
import path from "node:path";
import {
  fetchEipData,
  getCacheLayout,
  type FetchEipDataOptions,
  type FetchEipDataResult,
  type WritableLike,
} from "./fetcher.js";
import type {
  CacheMeta,
  ContextEntry,
  Eip,
  EipIndexEntry,
  ErrorCode,
  MeetingIndexEntry,
  MeetingTarget,
  MeetingTldr,
} from "../types/index.js";

const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const EIP_REFERENCE_PATTERN = /EIP[- ]?(\d{3,5})/gi;

export interface BuildCacheOptions {
  cacheRoot?: string;
}

export interface BuildCacheResult {
  meta: CacheMeta;
  eipCount: number;
  contextKeyCount: number;
  meetingCount: number;
}

export interface LoadCacheOptions extends FetchEipDataOptions {
  fetcher?: (options: FetchEipDataOptions) => Promise<FetchEipDataResult>;
  stderr?: WritableLike;
}

export interface LoadedCache {
  meta: CacheMeta;
  readContextIndex(): Promise<Record<string, ContextEntry[]>>;
  readEipsIndex(): Promise<EipIndexEntry[]>;
  readMeetingsIndex(): Promise<MeetingIndexEntry[]>;
}

export class CacheError extends Error {
  code: ErrorCode;

  constructor(message: string, code: ErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "CacheError";
    this.code = code;
  }
}

interface CachePaths {
  cacheDir: string;
  contextIndexPath: string;
  eipsDir: string;
  eipsIndexPath: string;
  meetingsIndexPath: string;
  meetingsManifestPath: string;
  metaPath: string;
  tldrsDir: string;
}

interface MeetingRef {
  date: string;
  dirName: string;
  number: number;
  type: string;
}

interface CachedTldrEntry {
  ref: MeetingRef;
  tldr: MeetingTldr;
}

interface MeetingManifestEntry {
  dirName: string;
  type: string;
}

function buildPaths(cacheRoot?: string): CachePaths {
  const layout = getCacheLayout(cacheRoot);
  return {
    cacheDir: layout.cacheDir,
    contextIndexPath: path.join(layout.cacheDir, "context-index.json"),
    eipsDir: layout.eipsDir,
    eipsIndexPath: path.join(layout.cacheDir, "eips-index.json"),
    meetingsIndexPath: path.join(layout.cacheDir, "meetings-index.json"),
    meetingsManifestPath: layout.meetingsManifestPath,
    metaPath: layout.metaPath,
    tldrsDir: layout.tldrsDir,
  };
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}

async function readJsonFile<T>(filePath: string, label: string): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      throw new CacheError(`${label} is missing from the forkcast cache`, "NOT_CACHED", { cause: error });
    }

    if (error instanceof SyntaxError) {
      throw new CacheError(`${label} contains invalid JSON: ${describeError(error)}`, "DATA_ERROR", { cause: error });
    }

    throw new CacheError(`Failed to read ${label}: ${describeError(error)}`, "DATA_ERROR", { cause: error });
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

async function ensureFetchResultMetadata(
  paths: CachePaths,
  fetchResult: FetchEipDataResult,
) {
  await fsp.mkdir(paths.cacheDir, { recursive: true });

  if (!(await pathExists(paths.metaPath))) {
    await writeJsonFileAtomic(paths.metaPath, fetchResult.meta);
  }

  if (!(await pathExists(paths.meetingsManifestPath))) {
    const meetingsManifest: MeetingManifestEntry[] = fetchResult.meetings.map((meeting) => ({
      dirName: meeting.dirName,
      type: meeting.type,
    }));
    await writeJsonFileAtomic(paths.meetingsManifestPath, meetingsManifest);
  }
}

async function listJsonFiles(targetDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(targetDir);
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      return [];
    }
    throw error;
  }

  return entries.filter((entry) => entry.endsWith(".json")).sort();
}

async function walkJsonFiles(targetDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(targetDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      return [];
    }
    throw error;
  }

  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      return walkJsonFiles(entryPath);
    }

    if (entry.isFile() && entry.name.endsWith(".json")) {
      return [entryPath];
    }

    return [];
  }));

  return files.flat().sort();
}

function parseMeetingRef(type: string, dirName: string): MeetingRef {
  const match = /^(?<date>\d{4}-\d{2}-\d{2})_(?<number>\d+)$/.exec(dirName);
  if (!match?.groups) {
    throw new CacheError(
      `Meeting directory "${type}/${dirName}" does not match the expected {date}_{number} pattern`,
      "DATA_ERROR",
    );
  }

  return {
    date: match.groups.date,
    dirName,
    number: Number(match.groups.number),
    type,
  };
}

function compareMeetingEntries(
  left: Pick<MeetingRef, "date" | "number" | "type">,
  right: Pick<MeetingRef, "date" | "number" | "type">,
) {
  return left.date.localeCompare(right.date)
    || left.type.localeCompare(right.type)
    || left.number - right.number;
}

function getLatestForkInclusionStatus(eip: Eip) {
  return eip.forkRelationships.map((relationship) => {
    const latestStatus = relationship.statusHistory.at(-1);
    if (!latestStatus) {
      throw new CacheError(
        `EIP-${eip.id} fork relationship "${relationship.forkName}" is missing status history`,
        "DATA_ERROR",
      );
    }

    return {
      name: relationship.forkName,
      inclusion: latestStatus.status,
    };
  });
}

async function readMeta(paths: CachePaths) {
  return readJsonFile<CacheMeta>(paths.metaPath, "meta.json");
}

async function readMeetingManifest(paths: CachePaths): Promise<MeetingRef[]> {
  const manifest = await readJsonFile<{ dirName: string; type: string }[]>(
    paths.meetingsManifestPath,
    "meetings-manifest.json",
  );

  return manifest.map((entry) => parseMeetingRef(entry.type, entry.dirName));
}

async function loadCachedTldrs(paths: CachePaths): Promise<CachedTldrEntry[]> {
  const filePaths = await walkJsonFiles(paths.tldrsDir);
  return Promise.all(filePaths.map(async (filePath) => {
    const dirName = path.basename(filePath, ".json");
    const type = path.basename(path.dirname(filePath));
    return {
      ref: parseMeetingRef(type, dirName),
      tldr: await readJsonFile<MeetingTldr>(filePath, `TLDR ${type}/${dirName}.json`),
    };
  }));
}

function getTldrTextFields(tldr: MeetingTldr): string[] {
  const fields: string[] = [];

  for (const items of Object.values(tldr.highlights)) {
    for (const item of items) {
      fields.push(item.highlight);
    }
  }

  for (const decision of tldr.decisions) {
    fields.push(decision.decision);
  }

  for (const actionItem of tldr.action_items) {
    fields.push(actionItem.action);
  }

  for (const target of tldr.targets ?? []) {
    fields.push(getMeetingTargetText(target));
  }

  return fields;
}

function getMeetingTargetText(target: MeetingTarget) {
  if ("target" in target && typeof target.target === "string") {
    return target.target;
  }

  if ("commitment" in target && typeof target.commitment === "string") {
    return target.commitment;
  }

  throw new CacheError("Meeting target entry is missing both target and commitment text", "DATA_ERROR");
}

function hasNonEmptyRecord(value: Record<string, unknown> | null | undefined) {
  return value != null && Object.keys(value).length > 0;
}

async function buildEipsIndex(paths: CachePaths): Promise<EipIndexEntry[]> {
  const fileNames = await listJsonFiles(paths.eipsDir);
  if (fileNames.length === 0) {
    throw new CacheError("The forkcast cache does not contain any EIP JSON files", "NOT_CACHED");
  }

  const eips = await Promise.all(fileNames.map(async (fileName) => {
    const eip = await readJsonFile<Eip>(path.join(paths.eipsDir, fileName), `EIP file ${fileName}`);
    return {
      id: eip.id,
      title: eip.title,
      status: eip.status,
      category: eip.category ?? null,
      layer: eip.layer ?? null,
      createdDate: eip.createdDate,
      forks: getLatestForkInclusionStatus(eip),
      hasLaymanDescription: typeof eip.laymanDescription === "string" && eip.laymanDescription.length > 0,
      hasStakeholderImpacts: hasNonEmptyRecord(eip.stakeholderImpacts),
    } satisfies EipIndexEntry;
  }));

  eips.sort((left, right) => left.id - right.id);
  return eips;
}

function buildContextIndex(cachedTldrs: CachedTldrEntry[]): Record<string, ContextEntry[]> {
  const byEip = new Map<string, Map<string, { ref: ContextEntry; mentions: Set<string> }>>();

  for (const { ref, tldr } of cachedTldrs) {
    const meetingRef: ContextEntry = {
      meeting: tldr.meeting,
      type: ref.type,
      date: ref.date,
      number: ref.number,
      mentions: [],
    };
    const meetingKey = `${ref.type}/${ref.dirName}`;

    for (const text of getTldrTextFields(tldr)) {
      const seenInText = new Set<string>();
      for (const match of text.matchAll(EIP_REFERENCE_PATTERN)) {
        const eipId = match[1];
        if (!eipId || seenInText.has(eipId)) {
          continue;
        }
        seenInText.add(eipId);

        let meetingMap = byEip.get(eipId);
        if (!meetingMap) {
          meetingMap = new Map();
          byEip.set(eipId, meetingMap);
        }

        const existing = meetingMap.get(meetingKey);
        if (existing) {
          existing.mentions.add(text);
        } else {
          meetingMap.set(meetingKey, {
            ref: meetingRef,
            mentions: new Set([text]),
          });
        }
      }
    }
  }

  const contextIndex = Object.fromEntries(
    [...byEip.entries()]
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([eipId, entries]) => [
        eipId,
        [...entries.values()]
          .map(({ ref, mentions }) => ({
            ...ref,
            mentions: [...mentions],
          }))
          .sort(compareMeetingEntries),
      ]),
  );

  return contextIndex;
}

function buildMeetingsIndex(
  manifestRefs: MeetingRef[],
  cachedTldrs: CachedTldrEntry[],
): MeetingIndexEntry[] {
  const cachedTldrRefs = new Map(
    cachedTldrs.map(({ ref }) => [`${ref.type}/${ref.dirName}`, ref] as const),
  );
  const meetings = new Map<string, MeetingRef>();

  for (const ref of manifestRefs) {
    meetings.set(`${ref.type}/${ref.dirName}`, ref);
  }

  for (const [key, ref] of cachedTldrRefs.entries()) {
    if (!meetings.has(key)) {
      meetings.set(key, ref);
    }
  }

  return [...meetings.values()]
    .sort(compareMeetingEntries)
    .map((ref) => ({
      type: ref.type,
      date: ref.date,
      number: ref.number,
      dirName: ref.dirName,
      tldrAvailable: cachedTldrRefs.has(`${ref.type}/${ref.dirName}`),
    }));
}

async function writeJsonFileAtomic(filePath: string, value: unknown) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(tmpPath, JSON.stringify(value, null, 2));
  await fsp.rename(tmpPath, filePath);
}

async function getNewestMtime(targetPath: string): Promise<number> {
  let stat;
  try {
    stat = await fsp.stat(targetPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      return 0;
    }
    throw error;
  }

  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let entries;
  try {
    entries = await fsp.readdir(targetPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      return 0;
    }
    throw error;
  }

  let newestMtime = stat.mtimeMs;
  for (const entry of entries) {
    newestMtime = Math.max(newestMtime, await getNewestMtime(path.join(targetPath, entry.name)));
  }

  return newestMtime;
}

async function getFileMtime(targetPath: string): Promise<number> {
  try {
    return (await fsp.stat(targetPath)).mtimeMs;
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      return 0;
    }
    throw error;
  }
}

async function rawCacheExists(paths: CachePaths) {
  return await pathExists(paths.metaPath)
    && await pathExists(paths.eipsDir)
    && await pathExists(paths.meetingsManifestPath);
}

async function indexJsonIsValid(filePath: string): Promise<boolean> {
  try {
    JSON.parse(await fsp.readFile(filePath, "utf8"));
    return true;
  } catch {
    return false;
  }
}

async function indexesNeedRebuild(paths: CachePaths) {
  const eipsIndexMtime = await getFileMtime(paths.eipsIndexPath);
  const contextIndexMtime = await getFileMtime(paths.contextIndexPath);
  const meetingsIndexMtime = await getFileMtime(paths.meetingsIndexPath);

  if (eipsIndexMtime === 0 || contextIndexMtime === 0 || meetingsIndexMtime === 0) {
    return true;
  }

  const [eipsValid, contextValid, meetingsValid] = await Promise.all([
    indexJsonIsValid(paths.eipsIndexPath),
    indexJsonIsValid(paths.contextIndexPath),
    indexJsonIsValid(paths.meetingsIndexPath),
  ]);
  if (!eipsValid || !contextValid || !meetingsValid) {
    return true;
  }

  const newestEipMtime = await getNewestMtime(paths.eipsDir);
  if (newestEipMtime > eipsIndexMtime) {
    return true;
  }

  const newestTldrMtime = await getNewestMtime(paths.tldrsDir);
  if (newestTldrMtime > contextIndexMtime || newestTldrMtime > meetingsIndexMtime) {
    return true;
  }

  return (await getFileMtime(paths.meetingsManifestPath)) > meetingsIndexMtime;
}

function warnIfStale(meta: CacheMeta, stderr: WritableLike) {
  const ageMs = Date.now() - Date.parse(meta.last_updated);
  if (!Number.isFinite(ageMs) || ageMs <= CACHE_STALE_MS) {
    return;
  }

  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  stderr.write(`Cache is ${ageDays} days old. Run \`forkcast update\` to refresh.\n`);
}

function createLazyReader<T>(filePath: string, label: string) {
  let promise: Promise<T> | undefined;
  return async () => {
    promise ??= readJsonFile<T>(filePath, label);
    return promise;
  };
}

export async function buildCache(options: BuildCacheOptions = {}): Promise<BuildCacheResult> {
  const paths = buildPaths(options.cacheRoot);
  const [meta, eipsIndex, manifestRefs, cachedTldrs] = await Promise.all([
    readMeta(paths),
    buildEipsIndex(paths),
    readMeetingManifest(paths),
    loadCachedTldrs(paths),
  ]);
  const contextIndex = buildContextIndex(cachedTldrs);
  const meetingsIndex = buildMeetingsIndex(manifestRefs, cachedTldrs);

  await Promise.all([
    writeJsonFileAtomic(paths.eipsIndexPath, eipsIndex),
    writeJsonFileAtomic(paths.contextIndexPath, contextIndex),
    writeJsonFileAtomic(paths.meetingsIndexPath, meetingsIndex),
  ]);

  return {
    meta,
    eipCount: eipsIndex.length,
    contextKeyCount: Object.keys(contextIndex).length,
    meetingCount: meetingsIndex.length,
  };
}

export async function loadCache(options: LoadCacheOptions = {}): Promise<LoadedCache> {
  const { fetcher = fetchEipData, stderr = process.stderr, ...fetchOptions } = options;
  const paths = buildPaths(options.cacheRoot);
  let meta: CacheMeta | undefined;

  if (!(await rawCacheExists(paths))) {
    const fetchResult = await fetcher({ ...fetchOptions, stderr });
    await ensureFetchResultMetadata(paths, fetchResult);
    meta = (await buildCache({ cacheRoot: options.cacheRoot })).meta;
  } else if (await indexesNeedRebuild(paths)) {
    meta = (await buildCache({ cacheRoot: options.cacheRoot })).meta;
  }

  meta ??= await readMeta(paths);
  warnIfStale(meta, stderr);

  return {
    meta,
    readContextIndex: createLazyReader(paths.contextIndexPath, "context-index.json"),
    readEipsIndex: createLazyReader(paths.eipsIndexPath, "eips-index.json"),
    readMeetingsIndex: createLazyReader(paths.meetingsIndexPath, "meetings-index.json"),
  };
}
