import fsp from "node:fs/promises";
import path from "node:path";
import {
  fetchEipData,
  getCacheLayout,
  getCacheRoot,
  type FetchEipDataOptions,
  type FetchEipDataResult,
  type WritableLike,
} from "./fetcher.js";
import {
  getPmCachePaths,
  readPmMeta,
} from "./pm-fetcher.js";
import { isNodeError, listJsonFiles, walkJsonFiles } from "./fs-utils.js";
import { getTldrTextFields, getMeetingTargetText } from "./tldr-utils.js";
import {
  parsePmMeeting,
  shouldSkipFile,
  type PmMeetingNote,
  type PmMeetingType,
} from "./pm-parser.js";
import {
  buildSqliteDb,
  dbIsValid,
  openDb,
  type Db,
} from "./db.js";
import type {
  CacheMeta,
  ContextEntry,
  Eip,
  EipIndexEntry,
  ErrorCode,
  MeetingIndexEntry,
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
  pmNoteCount: number;
}

export interface LoadCacheOptions extends FetchEipDataOptions {
  fetcher?: (options: FetchEipDataOptions) => Promise<FetchEipDataResult>;
  stderr?: WritableLike;
}

export interface LoadedCache {
  meta: CacheMeta;
  /** Open SQLite DB, or null when the DB is not available (first-fetch or legacy cache). */
  db: Db | null;
  readContextIndex(): Promise<Record<string, ContextEntry[]>>;
  readEipsIndex(): Promise<EipIndexEntry[]>;
  readMeetingsIndex(): Promise<MeetingIndexEntry[]>;
  readPmNote(type: string, dirName: string): Promise<PmMeetingNote | null>;
}

// Re-export Db type so callers can reference it without importing db.ts directly.
export type { Db };

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
  // Filter out _key_decisions.json files — they are not TLDRs and would fail
  // parseMeetingRef() because their dirName includes the "_key_decisions" suffix.
  const tldrPaths = filePaths.filter((p) => !p.endsWith("_key_decisions.json"));
  return Promise.all(tldrPaths.map(async (filePath) => {
    const dirName = path.basename(filePath, ".json");
    const type = path.basename(path.dirname(filePath));
    return {
      ref: parseMeetingRef(type, dirName),
      tldr: await readJsonFile<MeetingTldr>(filePath, `TLDR ${type}/${dirName}.json`),
    };
  }));
}

// getTldrTextFields and getMeetingTargetText are imported from tldr-utils.ts
// Re-export for consumers that already import from cache.ts
export { getTldrTextFields, getMeetingTargetText } from "./tldr-utils.js";

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
  pmNotes: PmMeetingNote[],
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

  // Build forkcast entries (from manifest + cached TLDRs)
  const forkcastEntries: MeetingIndexEntry[] = [...meetings.values()]
    .sort(compareMeetingEntries)
    .map((ref) => ({
      type: ref.type,
      date: ref.date,
      number: ref.number,
      dirName: ref.dirName,
      tldrAvailable: cachedTldrRefs.has(`${ref.type}/${ref.dirName}`),
      source: "forkcast" as const,
    }));

  // Build a lookup by type+date to allow augmenting forkcast entries with pm data
  const forkcastByTypeAndDate = new Map<string, MeetingIndexEntry>();
  for (const entry of forkcastEntries) {
    forkcastByTypeAndDate.set(`${entry.type}/${entry.date}`, entry);
  }

  // Add pm meetings as independent entries, or augment forkcast entries when
  // the same type+date already exists
  const pmEntries: MeetingIndexEntry[] = [];
  for (const note of pmNotes) {
    if (!note.date) {
      continue;
    }

    const matchKey = `${note.type}/${note.date}`;
    const existingForkcast = forkcastByTypeAndDate.get(matchKey);
    if (existingForkcast) {
      // Augment the existing forkcast entry — don't add a duplicate
      existingForkcast.pmNoteAvailable = true;
      continue;
    }

    // No matching forkcast entry — add as independent pm-sourced entry
    pmEntries.push({
      type: note.type,
      date: note.date,
      number: note.number,
      dirName: `pm-${note.date}_${note.number}`,
      tldrAvailable: false,
      pmNoteAvailable: true,
      source: "pm",
    });
  }

  return [...forkcastEntries, ...pmEntries].sort(compareMeetingEntries);
}

async function writeJsonFileAtomic(filePath: string, value: unknown) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(tmpPath, JSON.stringify(value, null, 2));
  await fsp.rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// pm note helpers
// ---------------------------------------------------------------------------

/**
 * Walk the pm cache directory tree and parse all meeting note markdown files.
 * Skips non-meeting files (README.md, templates, etc.).
 *
 * Returns an empty array if the pm directory does not exist (pm data not fetched yet).
 */
async function loadPmNotes(
  cacheRoot: string | undefined,
  stderr: WritableLike,
): Promise<PmMeetingNote[]> {
  const pmPaths = getPmCachePaths(cacheRoot);
  const pmDir = pmPaths.pmDir;

  const exists = await pathExists(pmDir);
  if (!exists) {
    return [];
  }

  const notes: PmMeetingNote[] = [];

  // Read EL meetings
  await loadPmNotesFromDir(
    pmPaths.elDir,
    "acde",
    null,
    notes,
    stderr,
  );

  // Read CL meetings
  await loadPmNotesFromDir(
    pmPaths.clDir,
    "acdc",
    null,
    notes,
    stderr,
  );

  // Read breakout rooms — one subdirectory per series
  let seriesDirs: string[];
  try {
    const entries = await fsp.readdir(pmPaths.breakoutDir, { withFileTypes: true });
    seriesDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    seriesDirs = [];
  }

  for (const series of seriesDirs) {
    await loadPmNotesFromDir(
      path.join(pmPaths.breakoutDir, series),
      "breakout",
      series,
      notes,
      stderr,
    );
  }

  return notes;
}

async function loadPmNotesFromDir(
  dir: string,
  type: PmMeetingType,
  series: string | null,
  notes: PmMeetingNote[],
  stderr: WritableLike,
): Promise<void> {
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return;
  }

  const mdFiles = files.filter((f) => f.endsWith(".md") && !shouldSkipFile(f));

  for (const filename of mdFiles) {
    const filePath = path.join(dir, filename);
    try {
      const content = await fsp.readFile(filePath, "utf8");
      const note = parsePmMeeting(content, type, filename, series);
      notes.push(note);
    } catch (error) {
      // Skip unparseable files but warn
      const msg = error instanceof Error ? error.message : String(error);
      stderr.write(`Warning: failed to parse pm note ${filePath}: ${msg}\n`);
    }
  }
}

/**
 * Add pm note EIP references to the context index.
 * Pm notes use the same context entry format as TLDRs.
 */
function addPmNotesToContextIndex(
  contextIndex: Record<string, ContextEntry[]>,
  pmNotes: PmMeetingNote[],
): void {
  for (const note of pmNotes) {
    if (note.eipReferences.length === 0) {
      continue;
    }

    // Build a meeting display name for the context entry
    const meetingName = note.title;
    const date = note.date ?? "0000-00-00";

    const baseEntry = {
      meeting: meetingName,
      type: note.type,
      date,
      number: note.number,
    };

    for (const eipId of note.eipReferences) {
      const eipKey = String(eipId);

      if (!contextIndex[eipKey]) {
        contextIndex[eipKey] = [];
      }

      // Check if this meeting is already represented
      const alreadyExists = contextIndex[eipKey].some(
        (e) => e.type === note.type && e.number === note.number && e.date === date,
      );

      if (!alreadyExists) {
        const entries = contextIndex[eipKey];

        // Build a snippet that actually mentions this EIP
        const eipPattern = new RegExp(`EIP[- ]?${eipId}[^\\n]{0,150}`, "i");
        const eipMatch = eipPattern.exec(note.bodyText);
        const mention = eipMatch
          ? eipMatch[0].trim()
          : `Referenced in ${meetingName}`;

        // Add pm meeting context entry
        const pmEntry: ContextEntry = {
          ...baseEntry,
          mentions: [mention],
        };

        entries.push(pmEntry);
      } else {
        // Append mention to existing entry
        const existing = contextIndex[eipKey].find(
          (e) => e.type === note.type && e.number === note.number && e.date === date,
        );
        if (existing) {
          const eipPattern = new RegExp(`EIP[- ]?${eipId}[^\\n]{0,150}`, "i");
          const eipMatch = eipPattern.exec(note.bodyText);
          if (eipMatch) {
            const snippet = eipMatch[0].trim();
            if (!existing.mentions.includes(snippet)) {
              existing.mentions.push(snippet);
            }
          }
        }
      }
    }
  }

  // Re-sort each EIP's entries by date
  for (const entries of Object.values(contextIndex)) {
    entries.sort(compareMeetingEntries);
  }
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

async function indexesNeedRebuild(paths: CachePaths, pmDir: string) {
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

  // Detect stale meetings-index format: if entries lack the `source` field
  // introduced with pm-note support, force a rebuild so all entries get tagged.
  try {
    const raw = await fsp.readFile(paths.meetingsIndexPath, "utf8");
    const entries = JSON.parse(raw) as MeetingIndexEntry[];
    if (entries.length > 0 && entries[0]!.source === undefined) {
      return true;
    }
  } catch {
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

  if ((await getFileMtime(paths.meetingsManifestPath)) > meetingsIndexMtime) {
    return true;
  }

  // Also rebuild if pm notes are newer than the current indexes
  const newestPmMtime = await getNewestMtime(pmDir);
  if (newestPmMtime > contextIndexMtime || newestPmMtime > meetingsIndexMtime) {
    return true;
  }

  return false;
}

export function warnIfStale(meta: CacheMeta, stderr: WritableLike) {
  const ageMs = Date.now() - Date.parse(meta.last_updated);
  if (!Number.isFinite(ageMs) || ageMs <= CACHE_STALE_MS) {
    return;
  }

  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  stderr.write(`Cache is ${ageDays} days old. Consider refreshing the cache.\n`);
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
  const stderr: WritableLike = process.stderr;

  const [meta, eipsIndex, manifestRefs, cachedTldrs, pmNotes] = await Promise.all([
    readMeta(paths),
    buildEipsIndex(paths),
    readMeetingManifest(paths),
    loadCachedTldrs(paths),
    loadPmNotes(options.cacheRoot, stderr),
  ]);
  const contextIndex = buildContextIndex(cachedTldrs);

  // Augment context index with pm note references
  if (pmNotes.length > 0) {
    addPmNotesToContextIndex(contextIndex, pmNotes);
  }

  const meetingsIndex = buildMeetingsIndex(manifestRefs, cachedTldrs, pmNotes);

  await Promise.all([
    writeJsonFileAtomic(paths.eipsIndexPath, eipsIndex),
    writeJsonFileAtomic(paths.contextIndexPath, contextIndex),
    writeJsonFileAtomic(paths.meetingsIndexPath, meetingsIndex),
  ]);

  // Build SQLite database after JSON indexes are written.
  // Errors here are non-fatal: JSON indexes remain the fallback.
  try {
    await buildSqliteDb(options.cacheRoot ?? getCacheRoot());
  } catch (err) {
    // Log but don't fail — commands fall back to JSON indexes.
    process.stderr.write(
      `Warning: SQLite DB build failed (JSON indexes will be used instead): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  return {
    meta,
    eipCount: eipsIndex.length,
    contextKeyCount: Object.keys(contextIndex).length,
    meetingCount: meetingsIndex.length,
    pmNoteCount: pmNotes.length,
  };
}

export async function loadCache(options: LoadCacheOptions = {}): Promise<LoadedCache> {
  const { fetcher = fetchEipData, stderr = process.stderr, ...fetchOptions } = options;
  const paths = buildPaths(options.cacheRoot);
  const pmPaths = getPmCachePaths(options.cacheRoot);
  let meta: CacheMeta | undefined;

  if (!(await rawCacheExists(paths))) {
    const fetchResult = await fetcher({ ...fetchOptions, stderr });
    await ensureFetchResultMetadata(paths, fetchResult);
    meta = (await buildCache({ cacheRoot: options.cacheRoot })).meta;
  } else if (await indexesNeedRebuild(paths, pmPaths.pmDir)) {
    meta = (await buildCache({ cacheRoot: options.cacheRoot })).meta;
  }

  meta ??= await readMeta(paths);
  warnIfStale(meta, stderr);

  // Open SQLite DB if it is valid; otherwise fall back to JSON indexes.
  const cacheRoot = options.cacheRoot ?? getCacheRoot();
  let db: Db | null = null;
  if (await dbIsValid(cacheRoot)) {
    try {
      db = openDb(cacheRoot, { readonly: true });
      // Ensure the DB file descriptor is released when the process exits.
      const dbRef = db;
      process.on("exit", () => { try { dbRef.close(); } catch { /* ignore */ } });
    } catch {
      db = null;
    }
  }

  return {
    meta,
    db,
    readContextIndex: createLazyReader(paths.contextIndexPath, "context-index.json"),
    readEipsIndex: createLazyReader(paths.eipsIndexPath, "eips-index.json"),
    readMeetingsIndex: createLazyReader(paths.meetingsIndexPath, "meetings-index.json"),
    readPmNote: createPmNoteReader(pmPaths.pmDir, options.cacheRoot, stderr),
  };
}

/**
 * Create a function that reads a pm meeting note on demand.
 *
 * On first call, all pm notes are loaded upfront and indexed in memory by both
 * forkcast-style dirName (`{type}/{date}_{number}`) and pm-style dirName
 * (`{type}/pm-{date}_{number}`). Subsequent lookups are O(1).
 *
 * Returns null if the pm cache does not exist or the note is not found.
 */
function createPmNoteReader(
  _pmDir: string,
  cacheRoot: string | undefined,
  stderr: WritableLike,
) {
  // Lazy-loaded index: built on first call
  let indexPromise: Promise<Map<string, PmMeetingNote>> | undefined;

  async function buildIndex(): Promise<Map<string, PmMeetingNote>> {
    const notes = await loadPmNotes(cacheRoot, stderr);
    const index = new Map<string, PmMeetingNote>();
    for (const note of notes) {
      if (note.date) {
        // Index by forkcast-style dirName: {type}/{date}_{number}
        const forkcastKey = `${note.type}/${note.date}_${note.number}`;
        // Index by pm-style dirName: {type}/pm-{date}_{number}
        const pmKey = `${note.type}/pm-${note.date}_${note.number}`;
        index.set(forkcastKey, note);
        index.set(pmKey, note);
      }
    }
    return index;
  }

  return async (type: string, dirName: string): Promise<PmMeetingNote | null> => {
    indexPromise ??= buildIndex();
    const index = await indexPromise;
    return index.get(`${type}/${dirName}`) ?? null;
  };
}
