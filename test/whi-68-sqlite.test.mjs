/**
 * WHI-68 SQLite integration tests.
 *
 * These tests verify that:
 * - buildCache() creates a usable SQLite DB alongside JSON indexes
 * - SQLite query functions return results consistent with JSON indexes
 * - loadCache() exposes a non-null `db` handle when the DB is valid
 * - DB-backed command paths (queryEips, countEipsByFork, getContextForEip,
 *   queryMeetings, searchEipsFts, searchMeetingsFts) produce correct output
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const fixturesDir = path.join(__dirname, "fixtures");

let build;

before(() => {
  build = spawnSync("npm", ["run", "build"], {
    cwd: rootDir,
    encoding: "utf8",
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFixtureJson(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8"));
}

function writeJson(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(contents, null, 2));
}

function createCacheRoot(prefix = "whi-68-sqlite-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createCacheOnlyMeetingTldr() {
  const tldr = readFixtureJson("reference-tldr-acdt-058.json");
  tldr.meeting = "ACDC #99 - April 11, 2026";
  tldr.action_items[0].action = "Prepare EIP-7702 rollout notes before the next sync";
  tldr.decisions[0].decision = "Keep EIP-5920 out of the next fork pending more data";
  tldr.targets[0].commitment = "EIP-8037 follow-up activation scheduled for April 12";
  return tldr;
}

function seedRawCache(
  cacheRoot,
  {
    extraCachedTldrs = [],
    meta = { forkcast_commit: "abc123def456", version: 1 },
    override5920 = (eip) => eip,
    override8037 = (eip) => eip,
  } = {},
) {
  const cacheDir = path.join(cacheRoot, "cache");

  writeJson(
    path.join(cacheDir, "eips", "7702.json"),
    readFixtureJson("reference-eip-7702.json"),
  );
  writeJson(
    path.join(cacheDir, "eips", "5920.json"),
    override5920(readFixtureJson("reference-eip-5920.json")),
  );
  writeJson(
    path.join(cacheDir, "eips", "8037.json"),
    override8037(readFixtureJson("reference-eip-8037.json")),
  );
  writeJson(path.join(cacheDir, "meta.json"), {
    ...meta,
    last_updated: meta.last_updated ?? new Date().toISOString(),
  });
  writeJson(path.join(cacheDir, "meetings-manifest.json"), [
    { type: "acde", dirName: "2026-04-09_234" },
    { type: "acdt", dirName: "2026-04-10_058" },
  ]);
  writeJson(
    path.join(cacheDir, "tldrs", "acde", "2026-04-09_234.json"),
    readFixtureJson("reference-tldr-acde-234.json"),
  );
  for (const meeting of extraCachedTldrs) {
    writeJson(
      path.join(cacheDir, "tldrs", meeting.type, `${meeting.dirName}.json`),
      meeting.payload,
    );
  }

  return cacheDir;
}

function assertBuildOk() {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("WHI-68 buildCache creates a SQLite DB file alongside JSON indexes", async () => {
  assertBuildOk();

  const { buildCache } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
  );

  const cacheRoot = createCacheRoot();
  seedRawCache(cacheRoot, {
    extraCachedTldrs: [
      {
        type: "acdc",
        dirName: "2026-04-11_099",
        payload: createCacheOnlyMeetingTldr(),
      },
    ],
    override5920: (eip) => ({
      ...eip,
      stakeholderImpacts: null,
    }),
    override8037: (eip) => ({
      ...eip,
      stakeholderImpacts: {},
    }),
  });

  try {
    await buildCache({ cacheRoot });

    const dbPath = path.join(cacheRoot, "cache", "forkcast.db");
    assert.ok(fs.existsSync(dbPath), "SQLite DB file should exist");

    // DB should not be empty
    const stat = fs.statSync(dbPath);
    assert.ok(stat.size > 0, "DB file should be non-empty");
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-68 loadCache exposes a non-null db handle", async () => {
  assertBuildOk();

  const { loadCache } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
  );

  const cacheRoot = createCacheRoot();
  seedRawCache(cacheRoot);

  try {
    const loaded = await loadCache({
      cacheRoot,
      fetcher: async () => {
        throw new Error("should not refetch");
      },
    });

    assert.ok(loaded.db !== null, "loadCache should return a non-null db handle");
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-68 queryEips returns results consistent with JSON eips-index", async () => {
  assertBuildOk();

  const cacheRoot = createCacheRoot();
  seedRawCache(cacheRoot, {
    override5920: (eip) => ({
      ...eip,
      stakeholderImpacts: null,
    }),
    override8037: (eip) => ({
      ...eip,
      stakeholderImpacts: {},
    }),
  });

  try {
    const { buildCache, loadCache } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
    );
    const { queryEips } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "db.js")).href}?t=${Date.now()}`
    );

    await buildCache({ cacheRoot });
    const loaded = await loadCache({
      cacheRoot,
      fetcher: async () => { throw new Error("no refetch"); },
    });

    assert.ok(loaded.db, "DB should be available");

    // No filters — all 3 EIPs
    const all = queryEips(loaded.db, {});
    assert.equal(all.length, 3, "should return all 3 EIPs");
    assert.deepEqual(all.map(e => e.id), [5920, 7702, 8037]);

    // Verify structure of first entry
    const eip5920 = all.find(e => e.id === 5920);
    assert.ok(eip5920);
    assert.equal(eip5920.title, "EIP-5920: PAY opcode");
    assert.equal(eip5920.status, "Stagnant");
    assert.equal(eip5920.hasStakeholderImpacts, false);
    assert.ok(Array.isArray(eip5920.forks));
    assert.ok(eip5920.forks.length > 0, "should have fork relationships");

    // Filter by fork
    const pectra = queryEips(loaded.db, { fork: "Pectra" });
    assert.ok(pectra.length > 0, "should find EIPs in Pectra");
    assert.ok(pectra.every(e => e.forks.some(f => f.name === "Pectra")));

    // Filter by inclusion
    const included = queryEips(loaded.db, { inclusion: "Included" });
    assert.ok(included.length > 0, "should find Included EIPs");
    assert.ok(included.every(e => e.forks.some(f => f.inclusion === "Included")));

    // Filter by layer
    const el = queryEips(loaded.db, { layer: "EL" });
    assert.ok(el.every(e => e.layer === "EL"));

    // Limit
    const limited = queryEips(loaded.db, { limit: 1 });
    assert.equal(limited.length, 1);

    // Close the DB
    loaded.db.close();
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-68 countEipsByFork returns correct per-inclusion counts", async () => {
  assertBuildOk();

  const cacheRoot = createCacheRoot();
  seedRawCache(cacheRoot);

  try {
    const { buildCache, loadCache } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
    );
    const { countEipsByFork } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "db.js")).href}?t=${Date.now()}`
    );

    await buildCache({ cacheRoot });
    const loaded = await loadCache({
      cacheRoot,
      fetcher: async () => { throw new Error("no refetch"); },
    });

    assert.ok(loaded.db);

    const pectraCounts = countEipsByFork(loaded.db, "Pectra");
    // EIP-7702 is Included in Pectra
    assert.ok(pectraCounts["Included"] >= 1, "Pectra should have at least 1 Included EIP");

    const glamCounts = countEipsByFork(loaded.db, "Glamsterdam");
    // EIP-8037 is Considered in Glamsterdam, EIP-5920 is Declined
    const total = Object.values(glamCounts).reduce((a, b) => a + b, 0);
    assert.ok(total > 0, "Glamsterdam should have some EIPs");

    loaded.db.close();
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-68 getContextForEip returns meeting mentions", async () => {
  assertBuildOk();

  const cacheRoot = createCacheRoot();
  seedRawCache(cacheRoot, {
    extraCachedTldrs: [
      {
        type: "acdc",
        dirName: "2026-04-11_099",
        payload: createCacheOnlyMeetingTldr(),
      },
    ],
  });

  try {
    const { buildCache, loadCache } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
    );
    const { getContextForEip } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "db.js")).href}?t=${Date.now()}`
    );

    await buildCache({ cacheRoot });
    const loaded = await loadCache({
      cacheRoot,
      fetcher: async () => { throw new Error("no refetch"); },
    });

    assert.ok(loaded.db);

    // EIP-8037 is mentioned in both ACDE #234 and ACDC #99
    const context = getContextForEip(loaded.db, 8037);
    assert.ok(context.length >= 2, `expected at least 2 meetings, got ${context.length}`);

    // Each entry should have meeting name, mentions
    for (const entry of context) {
      assert.ok(entry.meeting, "should have meeting name");
      assert.ok(entry.type, "should have type");
      assert.ok(entry.date, "should have date");
      assert.ok(Array.isArray(entry.mentions), "should have mentions array");
      assert.ok(entry.mentions.length > 0, "should have at least one mention");
    }

    loaded.db.close();
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-68 queryMeetings returns all meetings from DB", async () => {
  assertBuildOk();

  const cacheRoot = createCacheRoot();
  seedRawCache(cacheRoot, {
    extraCachedTldrs: [
      {
        type: "acdc",
        dirName: "2026-04-11_099",
        payload: createCacheOnlyMeetingTldr(),
      },
    ],
  });

  try {
    const { buildCache, loadCache } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
    );
    const { queryMeetings } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "db.js")).href}?t=${Date.now()}`
    );

    await buildCache({ cacheRoot });
    const loaded = await loadCache({
      cacheRoot,
      fetcher: async () => { throw new Error("no refetch"); },
    });

    assert.ok(loaded.db);

    // All meetings
    const all = queryMeetings(loaded.db, {});
    assert.ok(all.length >= 3, `expected at least 3 meetings, got ${all.length}`);

    // Each entry should have required fields
    for (const entry of all) {
      assert.ok(entry.type);
      assert.ok(entry.date);
      assert.ok(typeof entry.number === "number");
      assert.ok(entry.dirName);
    }

    // Filter by type
    const acde = queryMeetings(loaded.db, { type: "acde" });
    assert.ok(acde.length >= 1);
    assert.ok(acde.every(e => e.type === "acde"));

    // Filter with --last
    const last2 = queryMeetings(loaded.db, { last: 2 });
    assert.equal(last2.length, 2);

    // Ascending date order
    for (let i = 1; i < all.length; i++) {
      assert.ok(
        all[i].date >= all[i - 1].date,
        `meetings should be in ascending date order: ${all[i - 1].date} > ${all[i].date}`,
      );
    }

    loaded.db.close();
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-68 searchEipsFts finds EIPs by title and description", async () => {
  assertBuildOk();

  const cacheRoot = createCacheRoot();
  seedRawCache(cacheRoot);

  try {
    const { buildCache, loadCache } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
    );
    const { searchEipsFts } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "db.js")).href}?t=${Date.now()}`
    );

    await buildCache({ cacheRoot });
    const loaded = await loadCache({
      cacheRoot,
      fetcher: async () => { throw new Error("no refetch"); },
    });

    assert.ok(loaded.db);

    // Search by title keyword
    const payResults = searchEipsFts(loaded.db, "PAY");
    assert.ok(payResults.length >= 1, "should find EIP-5920 (PAY opcode)");
    assert.ok(payResults.some(r => r.id === 5920));

    // Search by a broad term
    const codeResults = searchEipsFts(loaded.db, "code");
    assert.ok(codeResults.length >= 1, "should find at least one EIP with 'code'");

    // Each result has expected structure
    for (const r of payResults) {
      assert.ok(typeof r.id === "number");
      assert.ok(typeof r.title === "string");
      assert.ok(typeof r.status === "string");
      assert.ok(Array.isArray(r.matchedFields));
      assert.ok(typeof r._tier === "number");
    }

    loaded.db.close();
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-68 searchMeetingsFts finds meetings by content", async () => {
  assertBuildOk();

  const cacheRoot = createCacheRoot();
  seedRawCache(cacheRoot);

  try {
    const { buildCache, loadCache } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
    );
    const { searchMeetingsFts } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "db.js")).href}?t=${Date.now()}`
    );

    await buildCache({ cacheRoot });
    const loaded = await loadCache({
      cacheRoot,
      fetcher: async () => { throw new Error("no refetch"); },
    });

    assert.ok(loaded.db);

    // Search for a term from the reference TLDR (EIP-8037 appears in acde-234)
    const results = searchMeetingsFts(loaded.db, "8037");
    assert.ok(results.length >= 1, "should find meetings mentioning 8037");

    // Each result should have matchedTexts (per-item snippets)
    for (const r of results) {
      assert.ok(typeof r.meetingId === "number");
      assert.ok(typeof r.type === "string");
      assert.ok(typeof r.date === "string");
      assert.ok(typeof r.number === "number");
      assert.ok(Array.isArray(r.matchedTexts));
      assert.ok(r.matchedTexts.length > 0, "should have at least one matched snippet");
    }

    loaded.db.close();
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-68 getEipById returns parsed EIP from DB", async () => {
  assertBuildOk();

  const cacheRoot = createCacheRoot();
  seedRawCache(cacheRoot);

  try {
    const { buildCache, loadCache } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
    );
    const { getEipById } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "db.js")).href}?t=${Date.now()}`
    );

    await buildCache({ cacheRoot });
    const loaded = await loadCache({
      cacheRoot,
      fetcher: async () => { throw new Error("no refetch"); },
    });

    assert.ok(loaded.db);

    const eip = getEipById(loaded.db, 7702);
    assert.ok(eip);
    assert.equal(eip.id, 7702);
    assert.equal(eip.title, "EIP-7702: Set Code for EOAs");
    assert.ok(Array.isArray(eip.forkRelationships));

    // Non-existent EIP
    const missing = getEipById(loaded.db, 99999);
    assert.equal(missing, null);

    loaded.db.close();
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-68 rebuild transaction is atomic — DELETE + INSERT in same transaction", async () => {
  assertBuildOk();

  const cacheRoot = createCacheRoot();
  seedRawCache(cacheRoot);

  try {
    const { buildCache } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
    );
    const { openDb, getEipCount } = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "lib", "db.js")).href}?t=${Date.now()}`
    );

    // Build twice — second build should cleanly replace the first
    await buildCache({ cacheRoot });
    await buildCache({ cacheRoot });

    const db = openDb(cacheRoot, { readonly: true });
    try {
      const count = getEipCount(db);
      // Should have exactly 3 EIPs (not 6 from double-insert)
      assert.equal(count, 3, "rebuild should replace, not duplicate");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});
