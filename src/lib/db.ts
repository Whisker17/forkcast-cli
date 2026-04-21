/**
 * SQLite database layer for forkcast-cli.
 *
 * Provides indexed storage for fast queries, LIKE-based full-text search, and
 * efficient joins.  The DB is built from raw JSON files during buildCache()
 * and used as the primary query layer when available.  JSON indexes kept as
 * fallback.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { isNodeError, listJsonFiles, walkJsonFiles } from "./fs-utils.js";
import { getTldrTextFields } from "./tldr-utils.js";
import type {
  ContextEntry,
  Eip,
  EipIndexEntry,
  ForkInclusionStatus,
  MeetingIndexEntry,
  MeetingTldr,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Db = Database.Database;

export interface DbEipFilters {
  fork?: string;
  inclusion?: ForkInclusionStatus;
  layer?: "EL" | "CL";
  status?: string;
  limit?: number;
}

export interface DbMeetingFilters {
  type?: string;
  after?: string;
  last?: number;
}

export interface DbDecisionFilters {
  fork?: string;
  after?: string;
  type?: string;
  last?: number;
  limit?: number;
}

export interface DbSearchResult {
  source: "eip" | "meeting";
  eipId?: number;
  title?: string;
  status?: string;
  meetingType?: string;
  meetingDate?: string;
  meetingNumber?: number;
  meetingName?: string;
  snippet: string;
}

// ---------------------------------------------------------------------------
// DB path
// ---------------------------------------------------------------------------

export function getDbPath(cacheRoot: string): string {
  return path.join(cacheRoot, "cache", "forkcast.db");
}

// ---------------------------------------------------------------------------
// Open / create DB
// ---------------------------------------------------------------------------

export function openDb(cacheRoot: string, options?: { readonly?: boolean }): Db {
  const dbPath = getDbPath(cacheRoot);
  const db = new Database(dbPath, options?.readonly ? { readonly: true } : undefined);
  // WAL mode improves concurrent read performance — only set on writable connections.
  if (!options?.readonly) {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");
  return db;
}

// ---------------------------------------------------------------------------
// Schema creation
// ---------------------------------------------------------------------------

function createSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS eips (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT,
      author TEXT,
      type TEXT,
      category TEXT,
      layer TEXT,
      created_date TEXT,
      discussion_link TEXT,
      reviewer TEXT,
      layman_description TEXT,
      has_stakeholder_impacts INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fork_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eip_id INTEGER NOT NULL REFERENCES eips(id),
      fork_name TEXT NOT NULL,
      current_inclusion_status TEXT NOT NULL,
      is_headliner INTEGER DEFAULT 0,
      raw_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fork_rel_eip ON fork_relationships(eip_id);
    CREATE INDEX IF NOT EXISTS idx_fork_rel_fork ON fork_relationships(fork_name);
    CREATE INDEX IF NOT EXISTS idx_fork_rel_status ON fork_relationships(current_inclusion_status);

    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      number INTEGER NOT NULL,
      dir_name TEXT NOT NULL,
      meeting_name TEXT,
      tldr_available INTEGER NOT NULL DEFAULT 0,
      pm_note_available INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      raw_tldr_json TEXT,
      highlights_text TEXT,
      decisions_text TEXT,
      action_items_text TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_type ON meetings(type);
    CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);

    CREATE TABLE IF NOT EXISTS eip_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eip_id INTEGER NOT NULL,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id),
      mention_text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eip_mentions_eip ON eip_mentions(eip_id);

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id),
      decision_text TEXT NOT NULL,
      timestamp TEXT
    );

    CREATE TABLE IF NOT EXISTS key_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id),
      original_text TEXT NOT NULL,
      timestamp TEXT,
      type TEXT,
      eips_json TEXT,
      stage_change_to TEXT,
      fork TEXT,
      context TEXT
    );

  `);
}

// ---------------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------------

interface RawKeyDecisionsFile {
  meeting: string;
  key_decisions: Array<{
    original_text: string;
    timestamp: string;
    type: string;
    eips: number[];
    stage_change?: { to: string };
    fork?: string;
    context?: string;
  }>;
}

function getLatestForkStatus(eip: Eip): Array<{ name: string; inclusion: ForkInclusionStatus; isHeadliner: boolean }> {
  const results: Array<{ name: string; inclusion: ForkInclusionStatus; isHeadliner: boolean }> = [];
  for (const rel of eip.forkRelationships) {
    const latest = rel.statusHistory.at(-1);
    if (!latest) continue; // Skip malformed relationships (matches cache.ts strictness)
    results.push({
      name: rel.forkName,
      inclusion: latest.status,
      isHeadliner: rel.isHeadliner === true,
    });
  }
  return results;
}

function getTldrSearchText(tldr: MeetingTldr): {
  highlights: string;
  decisions: string;
  actionItems: string;
} {
  const highlights: string[] = [];
  for (const items of Object.values(tldr.highlights ?? {})) {
    for (const item of items) {
      highlights.push(item.highlight);
    }
  }

  const decisions: string[] = [];
  for (const d of tldr.decisions ?? []) {
    decisions.push(d.decision);
  }

  const actionItems: string[] = [];
  for (const a of tldr.action_items ?? []) {
    actionItems.push(a.action);
  }

  for (const t of tldr.targets ?? []) {
    if ("target" in t && typeof t.target === "string") {
      actionItems.push(t.target);
    } else if ("commitment" in t && typeof t.commitment === "string") {
      actionItems.push(t.commitment);
    }
  }

  return {
    highlights: highlights.join(" "),
    decisions: decisions.join(" "),
    actionItems: actionItems.join(" "),
  };
}

const EIP_REFERENCE_PATTERN = /EIP[- ]?(\d{3,5})/gi;

// ---------------------------------------------------------------------------
// Build SQLite DB from raw JSON files
// ---------------------------------------------------------------------------

export async function buildSqliteDb(cacheRoot: string): Promise<void> {
  const cacheDir = path.join(cacheRoot, "cache");
  const eipsDir = path.join(cacheDir, "eips");
  const tldrsDir = path.join(cacheDir, "tldrs");

  const db = openDb(cacheRoot);

  try {
    createSchema(db);

    // Load EIPs
    const eipFiles = await listJsonFiles(eipsDir);
    const eips: Eip[] = await Promise.all(
      eipFiles.map(async (file) => {
        const raw = await fsp.readFile(path.join(eipsDir, file), "utf8");
        return JSON.parse(raw) as Eip;
      }),
    );

    // Load TLDRs — only tldr.json files (not _key_decisions.json)
    const allTldrsPaths = await walkJsonFiles(tldrsDir);
    const tldrFilePaths = allTldrsPaths.filter((p) => !p.endsWith("_key_decisions.json"));
    const keyDecisionFilePaths = allTldrsPaths.filter((p) => p.endsWith("_key_decisions.json"));

    interface TldrEntry {
      type: string;
      dirName: string;
      tldr: MeetingTldr;
      raw: string;
    }
    const tldrEntries: TldrEntry[] = (await Promise.all(
      tldrFilePaths.map(async (filePath) => {
        const raw = await fsp.readFile(filePath, "utf8");
        // Determine type and dirName from path
        const fileName = path.basename(filePath, ".json");
        const type = path.basename(path.dirname(filePath));
        // Skip negative-cache sentinels for tldr files
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && "_negative_cache" in parsed) {
            return null;
          }
          return {
            type,
            dirName: fileName,
            tldr: parsed as MeetingTldr,
            raw,
          };
        } catch {
          return null;
        }
      }),
    )).filter((e): e is TldrEntry => e !== null);

    // Load key_decisions files
    interface KeyDecisionEntry {
      type: string;
      dirName: string; // e.g. "2026-04-09_234" (without _key_decisions suffix)
      raw: RawKeyDecisionsFile;
    }
    const keyDecisionEntries: KeyDecisionEntry[] = (await Promise.all(
      keyDecisionFilePaths.map(async (filePath) => {
        const fileName = path.basename(filePath, ".json"); // e.g. "2026-04-09_234_key_decisions"
        const type = path.basename(path.dirname(filePath));
        // Strip the _key_decisions suffix to get dirName
        const dirName = fileName.replace(/_key_decisions$/, "");
        try {
          const raw = await fsp.readFile(filePath, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          // Skip negative-cache sentinels
          if (parsed && typeof parsed === "object" && "_negative_cache" in parsed) {
            return null;
          }
          return {
            type,
            dirName,
            raw: parsed as RawKeyDecisionsFile,
          };
        } catch {
          return null;
        }
      }),
    )).filter((e): e is KeyDecisionEntry => e !== null);

    // Load meetings index for the full meeting list (including meetings without TLDRs)
    const meetingsIndexPath = path.join(cacheDir, "meetings-index.json");
    let meetingsIndex: MeetingIndexEntry[] = [];
    try {
      const raw = await fsp.readFile(meetingsIndexPath, "utf8");
      meetingsIndex = JSON.parse(raw) as MeetingIndexEntry[];
    } catch {
      // No meetings index yet — will be built from TLDRs only
    }

    // Insert all data in a single transaction (including cleanup of old rows)
    const insert = db.transaction(() => {
      // Drop and recreate content in tables rather than trying to diff.
      // Merged into the insert transaction for atomicity — either a full
      // rebuild completes or the old data remains untouched.
      db.exec(`
        DELETE FROM eip_mentions;
        DELETE FROM key_decisions;
        DELETE FROM decisions;
        DELETE FROM fork_relationships;
        DELETE FROM meetings;
        DELETE FROM eips;
      `);

      // Prepare statements
      const insertEip = db.prepare(`
        INSERT OR REPLACE INTO eips
          (id, title, status, description, author, type, category, layer,
           created_date, discussion_link, reviewer, layman_description,
           has_stakeholder_impacts, raw_json)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertForkRel = db.prepare(`
        INSERT INTO fork_relationships
          (eip_id, fork_name, current_inclusion_status, is_headliner, raw_json)
        VALUES (?, ?, ?, ?, ?)
      `);

      const insertMeeting = db.prepare(`
        INSERT INTO meetings
          (type, date, number, dir_name, meeting_name, tldr_available, pm_note_available, source,
           raw_tldr_json, highlights_text, decisions_text, action_items_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertEipMention = db.prepare(`
        INSERT INTO eip_mentions (eip_id, meeting_id, mention_text)
        VALUES (?, ?, ?)
      `);

      const insertDecision = db.prepare(`
        INSERT INTO decisions (meeting_id, decision_text, timestamp)
        VALUES (?, ?, ?)
      `);

      const insertKeyDecision = db.prepare(`
        INSERT INTO key_decisions
          (meeting_id, original_text, timestamp, type, eips_json, stage_change_to, fork, context)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Insert EIPs
      for (const eip of eips) {
        insertEip.run(
          eip.id,
          eip.title,
          eip.status,
          eip.description ?? null,
          eip.author ?? null,
          eip.type ?? null,
          eip.category ?? null,
          eip.layer ?? null,
          eip.createdDate ?? null,
          eip.discussionLink ?? null,
          eip.reviewer ?? null,
          eip.laymanDescription ?? null,
          eip.stakeholderImpacts != null && Object.keys(eip.stakeholderImpacts).length > 0 ? 1 : 0,
          JSON.stringify(eip),
        );

        for (const rel of eip.forkRelationships) {
          const latest = rel.statusHistory.at(-1);
          if (!latest) continue;
          insertForkRel.run(
            eip.id,
            rel.forkName,
            latest.status,
            rel.isHeadliner ? 1 : 0,
            JSON.stringify(rel),
          );
        }
      }

      // Build a map from dirName key to TLDR entry for fast lookup
      const tldrMap = new Map<string, TldrEntry>(
        tldrEntries.map((e) => [`${e.type}/${e.dirName}`, e]),
      );

      // Build a map from dirName key to key_decisions entries for fast lookup
      const keyDecisionMap = new Map<string, KeyDecisionEntry>(
        keyDecisionEntries.map((e) => [`${e.type}/${e.dirName}`, e]),
      );

      // Track which dir_names we've inserted meetings for
      const insertedMeetings = new Map<string, number>(); // key -> row id

      /**
       * Helper: insert TLDR content and EIP mentions for a given meeting row.
       * Aligns with cache.ts buildContextIndex(): stores ALL mention texts
       * (one row per text field that references the EIP), not just the first.
       */
      function insertTldrContent(meetingId: number, tldrEntry: TldrEntry): void {
        // Insert decisions
        for (const d of tldrEntry.tldr.decisions ?? []) {
          insertDecision.run(meetingId, d.decision, d.timestamp ?? null);
        }

        // Extract EIP mentions using the same per-field iteration as
        // cache.ts buildContextIndex() — each individual text field
        // (highlight, decision, action-item, target) is stored as its own
        // mention_text, NOT a joined blob.
        const eipMentionMap = new Map<number, Set<string>>();

        for (const text of getTldrTextFields(tldrEntry.tldr)) {
          if (!text) continue;
          const seenInText = new Set<string>();
          for (const match of text.matchAll(EIP_REFERENCE_PATTERN)) {
            const eipIdStr = match[1];
            if (!eipIdStr || seenInText.has(eipIdStr)) continue;
            seenInText.add(eipIdStr);

            const eipId = Number(eipIdStr);
            let mentionSet = eipMentionMap.get(eipId);
            if (!mentionSet) {
              mentionSet = new Set();
              eipMentionMap.set(eipId, mentionSet);
            }
            mentionSet.add(text);
          }
        }

        for (const [eipId, mentionTexts] of eipMentionMap) {
          for (const mentionText of mentionTexts) {
            insertEipMention.run(eipId, meetingId, mentionText);
          }
        }
      }

      /**
       * Helper: insert key_decisions rows for a given meeting.
       */
      function insertKeyDecisionContent(meetingId: number, kdEntry: KeyDecisionEntry): void {
        if (!Array.isArray(kdEntry.raw.key_decisions)) return;
        for (const kd of kdEntry.raw.key_decisions) {
          insertKeyDecision.run(
            meetingId,
            kd.original_text,
            kd.timestamp ?? null,
            kd.type ?? null,
            Array.isArray(kd.eips) ? JSON.stringify(kd.eips) : null,
            kd.stage_change?.to ?? null,
            typeof kd.fork === "string" && kd.fork.length > 0 ? kd.fork : null,
            typeof kd.context === "string" && kd.context.length > 0 ? kd.context : null,
          );
        }
      }

      // Insert all meetings from the index
      for (const entry of meetingsIndex) {
        const key = `${entry.type}/${entry.dirName}`;
        const tldrEntry = tldrMap.get(key);
        const kdEntry = keyDecisionMap.get(key);

        let highlightsText: string | null = null;
        let decisionsText: string | null = null;
        let actionItemsText: string | null = null;

        if (tldrEntry) {
          const textFields = getTldrSearchText(tldrEntry.tldr);
          highlightsText = textFields.highlights || null;
          decisionsText = textFields.decisions || null;
          actionItemsText = textFields.actionItems || null;
        }

        const result = insertMeeting.run(
          entry.type,
          entry.date,
          entry.number,
          entry.dirName,
          tldrEntry?.tldr.meeting ?? null,
          entry.tldrAvailable ? 1 : 0,
          entry.pmNoteAvailable ? 1 : 0,
          entry.source ?? "forkcast",
          tldrEntry ? tldrEntry.raw : null,
          highlightsText,
          decisionsText,
          actionItemsText,
        );
        const meetingId = result.lastInsertRowid as number;
        insertedMeetings.set(key, meetingId);

        // Insert FTS content, decisions, and EIP mentions if TLDR is available
        if (tldrEntry) {
          insertTldrContent(meetingId, tldrEntry);
        }

        // Insert key_decisions if available
        if (kdEntry) {
          insertKeyDecisionContent(meetingId, kdEntry);
        }
      }

      // Insert any TLDR-only meetings that weren't in the index
      for (const [key, tldrEntry] of tldrMap) {
        if (insertedMeetings.has(key)) continue;

        // Parse dirName for date and number
        const dirMatch = /^(\d{4}-\d{2}-\d{2})_(\d+)$/.exec(tldrEntry.dirName);
        if (!dirMatch) continue;

        const date = dirMatch[1]!;
        const number = Number(dirMatch[2]);

        const textFields = getTldrSearchText(tldrEntry.tldr);
        const highlightsText = textFields.highlights || null;
        const decisionsText = textFields.decisions || null;
        const actionItemsText = textFields.actionItems || null;

        const result = insertMeeting.run(
          tldrEntry.type,
          date,
          number,
          tldrEntry.dirName,
          tldrEntry.tldr.meeting ?? null,
          1, // tldr_available
          0, // pm_note_available
          "forkcast",
          tldrEntry.raw,
          highlightsText,
          decisionsText,
          actionItemsText,
        );
        const meetingId = result.lastInsertRowid as number;
        insertedMeetings.set(key, meetingId);

        insertTldrContent(meetingId, tldrEntry);

        // Insert key_decisions if available
        const kdEntry = keyDecisionMap.get(key);
        if (kdEntry) {
          insertKeyDecisionContent(meetingId, kdEntry);
        }
      }

      // Insert key_decisions for any meetings not yet represented
      for (const [key, kdEntry] of keyDecisionMap) {
        if (insertedMeetings.has(key)) continue;

        const dirMatch = /^(\d{4}-\d{2}-\d{2})_(\d+)$/.exec(kdEntry.dirName);
        if (!dirMatch) continue;

        const date = dirMatch[1]!;
        const number = Number(dirMatch[2]);

        const result = insertMeeting.run(
          kdEntry.type,
          date,
          number,
          kdEntry.dirName,
          kdEntry.raw.meeting ?? null,
          0, // tldr_available
          0, // pm_note_available
          "forkcast",
          null,
          null,
          null,
          null,
        );
        const meetingId = result.lastInsertRowid as number;
        insertedMeetings.set(key, meetingId);

        insertKeyDecisionContent(meetingId, kdEntry);
      }
    });

    insert();
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Get a single EIP by ID.  Returns the parsed Eip from raw_json, or null.
 */
export function getEipById(db: Db, id: number): Eip | null {
  const row = db.prepare("SELECT raw_json FROM eips WHERE id = ?").get(id) as
    | { raw_json: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.raw_json) as Eip;
}

/**
 * Query EIPs with optional filters.  Returns EipIndexEntry[] compatible with
 * existing command code.
 *
 * Fork data is retrieved via a follow-up query on fork_relationships — no
 * JSON.parse of raw_json per row.
 */
export function queryEips(db: Db, filters: DbEipFilters): EipIndexEntry[] {
  // Start with base query joining fork_relationships for filtering
  let sql = `
    SELECT DISTINCT e.id, e.title, e.status, e.category, e.layer,
                    e.created_date, e.layman_description,
                    e.has_stakeholder_impacts
    FROM eips e
  `;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // Filter by fork name (join fork_relationships)
  if (filters.fork || filters.inclusion) {
    sql += " INNER JOIN fork_relationships fr ON e.id = fr.eip_id";

    if (filters.fork) {
      conditions.push("LOWER(fr.fork_name) = LOWER(?)");
      params.push(filters.fork);
    }

    if (filters.inclusion) {
      conditions.push("fr.current_inclusion_status = ?");
      params.push(filters.inclusion);
    }
  }

  if (filters.status) {
    conditions.push("e.status = ?");
    params.push(filters.status);
  }

  if (filters.layer) {
    conditions.push("e.layer = ?");
    params.push(filters.layer);
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  sql += " ORDER BY e.id ASC";

  if (filters.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(filters.limit);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    title: string;
    status: string;
    category: string | null;
    layer: string | null;
    created_date: string;
    layman_description: string | null;
    has_stakeholder_impacts: number;
  }>;

  if (rows.length === 0) return [];

  // Fetch fork relationships for all returned EIP IDs in a single query
  // instead of parsing raw_json per row.
  const eipIds = rows.map((r) => r.id);
  const forkRows = db.prepare(
    `SELECT eip_id, fork_name, current_inclusion_status
     FROM fork_relationships
     WHERE eip_id IN (${eipIds.map(() => "?").join(",")})`,
  ).all(...eipIds) as Array<{
    eip_id: number;
    fork_name: string;
    current_inclusion_status: string;
  }>;

  // Group fork data by eip_id
  const forksByEip = new Map<number, Array<{ name: string; inclusion: ForkInclusionStatus }>>();
  for (const fr of forkRows) {
    let arr = forksByEip.get(fr.eip_id);
    if (!arr) {
      arr = [];
      forksByEip.set(fr.eip_id, arr);
    }
    arr.push({ name: fr.fork_name, inclusion: fr.current_inclusion_status as ForkInclusionStatus });
  }

  // Build EipIndexEntry — no raw_json parsing needed.
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status as EipIndexEntry["status"],
    category: row.category,
    layer: row.layer as "EL" | "CL" | null,
    createdDate: row.created_date,
    forks: forksByEip.get(row.id) ?? [],
    hasLaymanDescription: typeof row.layman_description === "string" && row.layman_description.length > 0,
    hasStakeholderImpacts: row.has_stakeholder_impacts === 1,
  } satisfies EipIndexEntry));
}

/**
 * Count EIPs per inclusion status for a given fork — single query, no JSON.parse.
 * Returns a map of inclusion_status -> count.
 */
export function countEipsByFork(db: Db, forkName: string): Record<string, number> {
  const rows = db.prepare(`
    SELECT current_inclusion_status, COUNT(*) AS cnt
    FROM fork_relationships
    WHERE LOWER(fork_name) = LOWER(?)
    GROUP BY current_inclusion_status
  `).all(forkName) as Array<{ current_inclusion_status: string; cnt: number }>;

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.current_inclusion_status] = row.cnt;
  }
  return result;
}

/**
 * Get total count of EIPs in the DB.
 */
export function getEipCount(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM eips").get() as { cnt: number };
  return row.cnt;
}

/**
 * Query meetings with optional filters.  Returns MeetingIndexEntry[].
 */
export function queryMeetings(db: Db, filters: DbMeetingFilters): MeetingIndexEntry[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.type) {
    conditions.push("LOWER(type) = LOWER(?)");
    params.push(filters.type);
  }

  if (filters.after) {
    conditions.push("date >= ?");
    params.push(filters.after);
  }

  const whereClause = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";

  if (filters.last !== undefined) {
    // Get the N most recent rows DESC, then re-sort ASC in JS
    const sql = `
      SELECT type, date, number, dir_name, tldr_available, pm_note_available, source
      FROM meetings${whereClause}
      ORDER BY date DESC, type DESC, number DESC LIMIT ?
    `;
    params.push(filters.last);

    const rows = db.prepare(sql).all(...params) as Array<{
      type: string;
      date: string;
      number: number;
      dir_name: string;
      tldr_available: number;
      pm_note_available: number;
      source: string | null;
    }>;

    // Re-sort ascending for output (matching compareMeetingEntries: date → type → number)
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || a.number - b.number);

    return rows.map((row) => ({
      type: row.type,
      date: row.date,
      number: row.number,
      dirName: row.dir_name,
      tldrAvailable: row.tldr_available === 1,
      pmNoteAvailable: row.pm_note_available === 1 ? true : undefined,
      source: (row.source ?? "forkcast") as "forkcast" | "pm",
    }));
  }

  const sql = `
    SELECT type, date, number, dir_name, tldr_available, pm_note_available, source
    FROM meetings${whereClause}
    ORDER BY date ASC, type ASC, number ASC
  `;

  const rows = db.prepare(sql).all(...params) as Array<{
    type: string;
    date: string;
    number: number;
    dir_name: string;
    tldr_available: number;
    pm_note_available: number;
    source: string | null;
  }>;

  return rows.map((row) => ({
    type: row.type,
    date: row.date,
    number: row.number,
    dirName: row.dir_name,
    tldrAvailable: row.tldr_available === 1,
    pmNoteAvailable: row.pm_note_available === 1 ? true : undefined,
    source: (row.source ?? "forkcast") as "forkcast" | "pm",
  }));
}

/**
 * Get context (EIP mentions in meetings) for a given EIP ID.
 */
export function getContextForEip(db: Db, eipId: number): ContextEntry[] {
  const rows = db.prepare(`
    SELECT m.type, m.date, m.number, m.meeting_name,
           em.mention_text
    FROM eip_mentions em
    INNER JOIN meetings m ON em.meeting_id = m.id
    WHERE em.eip_id = ?
    ORDER BY m.date ASC, m.type ASC, m.number ASC
  `).all(eipId) as Array<{
    type: string;
    date: string;
    number: number;
    meeting_name: string | null;
    mention_text: string;
  }>;

  // Group by meeting
  const meetingMap = new Map<string, ContextEntry>();
  for (const row of rows) {
    const key = `${row.type}/${row.date}_${row.number}`;
    const existing = meetingMap.get(key);

    const meetingName = row.meeting_name ?? `${row.type.toUpperCase()} #${row.number}`;

    if (existing) {
      if (!existing.mentions.includes(row.mention_text)) {
        existing.mentions.push(row.mention_text);
      }
    } else {
      meetingMap.set(key, {
        meeting: meetingName,
        type: row.type,
        date: row.date,
        number: row.number,
        mentions: [row.mention_text],
      });
    }
  }

  return [...meetingMap.values()];
}

/**
 * Get the raw TLDR JSON for a meeting.
 */
export function getTldr(db: Db, type: string, dirName: string): MeetingTldr | null {
  const row = db.prepare(`
    SELECT raw_tldr_json
    FROM meetings
    WHERE type = ? AND dir_name = ?
  `).get(type, dirName) as { raw_tldr_json: string | null } | undefined;

  if (!row?.raw_tldr_json) return null;
  return JSON.parse(row.raw_tldr_json) as MeetingTldr;
}

// ---------------------------------------------------------------------------
// LIKE-based search (preserves substring semantics matching JSON path)
// ---------------------------------------------------------------------------

const MAX_SNIPPET_LENGTH = 200;

function truncateSnippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_SNIPPET_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SNIPPET_LENGTH - 1)}…`;
}

export interface EipFtsResult {
  id: number;
  title: string;
  status: string;
  matchedFields: string[];
  /** Internal tier for sorting: 0=exact title, 1=title contains, 2=body */
  _tier: number;
}

export interface MeetingFtsResult {
  meetingId: number;
  type: string;
  date: string;
  number: number;
  dirName: string;
  meetingName: string | null;
  /** Individual per-item matching snippets (parity with JSON searchMeeting path). */
  matchedTexts: string[];
}

/**
 * Search EIPs using LIKE-based substring matching on the main eips table.
 * Preserves the same substring semantics as the JSON path (case-insensitive).
 * Results are sorted by relevance tier: exact title > title-contains > body match.
 */
export function searchEipsFts(db: Db, term: string): EipFtsResult[] {
  const pattern = `%${term.toLowerCase()}%`;

  const rows = db.prepare(`
    SELECT id, title, status, description, layman_description
    FROM eips
    WHERE LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(layman_description) LIKE ?
    ORDER BY id ASC
  `).all(pattern, pattern, pattern) as Array<{
    id: number;
    title: string;
    status: string;
    description: string | null;
    layman_description: string | null;
  }>;

  const termLower = term.toLowerCase();

  return rows.map((row) => {
    const matchedFields: string[] = [];
    let tier = 2; // body

    const titleLower = row.title.toLowerCase();
    if (titleLower === termLower) {
      tier = 0; // exact title match
      matchedFields.push(row.title);
    } else if (titleLower.includes(termLower)) {
      tier = 1; // title contains
      matchedFields.push(row.title);
    }

    if (row.description && row.description.toLowerCase().includes(termLower)) {
      matchedFields.push(truncateSnippet(row.description));
    }

    if (row.layman_description && row.layman_description.toLowerCase().includes(termLower)) {
      matchedFields.push(truncateSnippet(row.layman_description));
    }

    return {
      id: row.id,
      title: row.title,
      status: row.status,
      matchedFields,
      _tier: tier,
    };
  });
}

/**
 * Search meetings using LIKE-based substring matching on the meetings table.
 * After identifying hits, re-parses the TLDR to extract per-item matching
 * snippets — matching the JSON path's per-highlight/decision/action output.
 */
export function searchMeetingsFts(db: Db, term: string): MeetingFtsResult[] {
  const pattern = `%${term.toLowerCase()}%`;

  const rows = db.prepare(`
    SELECT id, type, date, number, dir_name, meeting_name, raw_tldr_json
    FROM meetings
    WHERE
      LOWER(highlights_text) LIKE ?
      OR LOWER(decisions_text) LIKE ?
      OR LOWER(action_items_text) LIKE ?
    ORDER BY date ASC, number ASC
  `).all(pattern, pattern, pattern) as Array<{
    id: number;
    type: string;
    date: string;
    number: number;
    dir_name: string;
    meeting_name: string | null;
    raw_tldr_json: string | null;
  }>;

  const termLower = term.toLowerCase();

  return rows.map((row) => {
    // Re-parse the TLDR to get per-item matches (parity with JSON searchMeeting)
    const matchedTexts: string[] = [];

    if (row.raw_tldr_json) {
      try {
        const tldr = JSON.parse(row.raw_tldr_json) as MeetingTldr;
        for (const text of getTldrTextFields(tldr)) {
          if (text && text.toLowerCase().includes(termLower)) {
            matchedTexts.push(truncateSnippet(text));
          }
        }
      } catch {
        // Fallback: no individual matches available
      }
    }

    return {
      meetingId: row.id,
      type: row.type,
      date: row.date,
      number: row.number,
      dirName: row.dir_name,
      meetingName: row.meeting_name,
      matchedTexts,
    };
  });
}

// ---------------------------------------------------------------------------
// Decision queries
// ---------------------------------------------------------------------------

export interface DbDecisionRow {
  meeting_type: string;
  meeting_date: string;
  meeting_number: number;
  meeting_dir_name: string;
  decision_text: string;
  timestamp: string | null;
  source: "tldr" | "key_decisions";
}

export interface DbKeyDecisionRow {
  meeting_type: string;
  meeting_date: string;
  meeting_number: number;
  meeting_dir_name: string;
  original_text: string;
  timestamp: string | null;
  type: string | null;
  eips_json: string | null;
  stage_change_to: string | null;
  fork: string | null;
  context: string | null;
}

/**
 * Query TLDR decisions from the DB.
 */
export function queryDecisions(db: Db, filters: DbDecisionFilters): DbDecisionRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.type) {
    conditions.push("LOWER(m.type) = LOWER(?)");
    params.push(filters.type);
  }

  if (filters.after) {
    conditions.push("m.date >= ?");
    params.push(filters.after);
  }

  const whereClause = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";

  const sql = `
    SELECT m.type AS meeting_type, m.date AS meeting_date, m.number AS meeting_number,
           m.dir_name AS meeting_dir_name, d.decision_text, d.timestamp, 'tldr' AS source
    FROM decisions d
    INNER JOIN meetings m ON d.meeting_id = m.id${whereClause}
    ORDER BY m.date ASC, m.number ASC, d.timestamp ASC
  `;

  return db.prepare(sql).all(...params) as DbDecisionRow[];
}

/**
 * Query key_decisions rows from the DB.
 */
export function queryKeyDecisions(db: Db, filters: DbDecisionFilters): DbKeyDecisionRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.type) {
    conditions.push("LOWER(m.type) = LOWER(?)");
    params.push(filters.type);
  }

  if (filters.after) {
    conditions.push("m.date >= ?");
    params.push(filters.after);
  }

  const whereClause = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";

  const sql = `
    SELECT m.type AS meeting_type, m.date AS meeting_date, m.number AS meeting_number,
           m.dir_name AS meeting_dir_name,
           kd.original_text, kd.timestamp, kd.type, kd.eips_json,
           kd.stage_change_to, kd.fork, kd.context
    FROM key_decisions kd
    INNER JOIN meetings m ON kd.meeting_id = m.id${whereClause}
    ORDER BY m.date ASC, m.number ASC, kd.timestamp ASC
  `;

  return db.prepare(sql).all(...params) as DbKeyDecisionRow[];
}

// ---------------------------------------------------------------------------
// DB validity check
// ---------------------------------------------------------------------------

/**
 * Returns true if the SQLite DB exists and has data in the eips table.
 */
export async function dbIsValid(cacheRoot: string): Promise<boolean> {
  const dbPath = getDbPath(cacheRoot);
  try {
    await fsp.stat(dbPath);
  } catch {
    return false;
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) as cnt FROM eips").get() as { cnt: number };
      return row.cnt > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}
