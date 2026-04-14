import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
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

function readFixture(name) {
  return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

function readFixtureJson(name) {
  return JSON.parse(readFixture(name));
}

function writeJson(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(contents, null, 2));
}

function createCacheRoot(prefix = "whi-59-cache-") {
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

test("WHI-59 builds EIP, context, and meeting indexes from the raw cache", async () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

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

    const cacheDir = path.join(cacheRoot, "cache");
    const eipsIndex = JSON.parse(fs.readFileSync(path.join(cacheDir, "eips-index.json"), "utf8"));
    const contextIndex = JSON.parse(fs.readFileSync(path.join(cacheDir, "context-index.json"), "utf8"));
    const meetingsIndex = JSON.parse(fs.readFileSync(path.join(cacheDir, "meetings-index.json"), "utf8"));

    assert.deepEqual(eipsIndex, [
      {
        id: 5920,
        title: "EIP-5920: PAY opcode",
        status: "Stagnant",
        category: "Core",
        layer: "EL",
        createdDate: "2022-03-14",
        forks: [
          { name: "Fusaka", inclusion: "Declined" },
          { name: "Glamsterdam", inclusion: "Declined" },
        ],
        hasLaymanDescription: true,
        hasStakeholderImpacts: false,
      },
      {
        id: 7702,
        title: "EIP-7702: Set Code for EOAs",
        status: "Final",
        category: "Core",
        layer: null,
        createdDate: "2024-05-07",
        forks: [{ name: "Pectra", inclusion: "Included" }],
        hasLaymanDescription: true,
        hasStakeholderImpacts: true,
      },
      {
        id: 8037,
        title: "EIP-8037: State Creation Gas Cost Increase",
        status: "Draft",
        category: "Core",
        layer: "EL",
        createdDate: "2025-10-01",
        forks: [{ name: "Glamsterdam", inclusion: "Considered" }],
        hasLaymanDescription: true,
        hasStakeholderImpacts: false,
      },
    ]);

    assert.deepEqual(contextIndex, {
      "4444": [
        {
          meeting: "ACDE #234 - April 9, 2026",
          type: "acde",
          date: "2026-04-09",
          number: 234,
          mentions: ["EIP-4444: one year; weak subjectivity: 18 days; blob expiry: 18 days"],
        },
      ],
      "5920": [
        {
          meeting: "ACDC #99 - April 11, 2026",
          type: "acdc",
          date: "2026-04-11",
          number: 99,
          mentions: ["Keep EIP-5920 out of the next fork pending more data"],
        },
      ],
      "7702": [
        {
          meeting: "ACDC #99 - April 11, 2026",
          type: "acdc",
          date: "2026-04-11",
          number: 99,
          mentions: ["Prepare EIP-7702 rollout notes before the next sync"],
        },
      ],
      "8037": [
        {
          meeting: "ACDE #234 - April 9, 2026",
          type: "acde",
          date: "2026-04-09",
          number: 234,
          mentions: ["EIP-8037 clarifications needed for spillover gas and state refunds"],
        },
        {
          meeting: "ACDC #99 - April 11, 2026",
          type: "acdc",
          date: "2026-04-11",
          number: 99,
          mentions: ["EIP-8037 follow-up activation scheduled for April 12"],
        },
      ],
    });

    assert.deepEqual(meetingsIndex, [
      {
        type: "acde",
        date: "2026-04-09",
        number: 234,
        dirName: "2026-04-09_234",
        tldrAvailable: true,
        source: "forkcast",
      },
      {
        type: "acdt",
        date: "2026-04-10",
        number: 58,
        dirName: "2026-04-10_058",
        tldrAvailable: false,
        source: "forkcast",
      },
      {
        type: "acdc",
        date: "2026-04-11",
        number: 99,
        dirName: "2026-04-11_099",
        tldrAvailable: true,
        source: "forkcast",
      },
    ]);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-59 loadCache auto-fetches missing data and warns when the cache is stale", async () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const { loadCache } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
  );

  const cacheRoot = createCacheRoot();
  const stderr = [];
  const fetchCalls = [];
  const stderrSink = {
    write(chunk) {
      stderr.push(String(chunk));
      return true;
    },
  };

  try {
    const loaded = await loadCache({
      cacheRoot,
      fetcher: async (options) => {
        fetchCalls.push(options);
        seedRawCache(cacheRoot, {
          meta: {
            forkcast_commit: "fetched789",
            version: 1,
            last_updated: new Date(Date.now() - (9 * 24 * 60 * 60 * 1000)).toISOString(),
          },
        });

        return {
          meta: JSON.parse(
            fs.readFileSync(path.join(cacheRoot, "cache", "meta.json"), "utf8"),
          ),
          meetings: JSON.parse(
            fs.readFileSync(path.join(cacheRoot, "cache", "meetings-manifest.json"), "utf8"),
          ),
        };
      },
      stderr: stderrSink,
    });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].cacheRoot, cacheRoot);
    assert.equal(fetchCalls[0].stderr, stderrSink);
    assert.equal(loaded.meta.forkcast_commit, "fetched789");
    assert.match(stderr.join(""), /Cache is \d+ days old\. Consider refreshing the cache\./);
    assert.equal((await loaded.readEipsIndex()).length, 3);
    assert.equal((await loaded.readMeetingsIndex())[0].dirName, "2026-04-09_234");
    assert.ok(fs.existsSync(path.join(cacheRoot, "cache", "context-index.json")));
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-59 loadCache rebuilds missing indexes from the existing raw cache without refetching", async () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const { loadCache } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
  );

  const cacheRoot = createCacheRoot();
  let fetchCalls = 0;

  try {
    seedRawCache(cacheRoot);

    const loaded = await loadCache({
      cacheRoot,
      fetcher: async () => {
        fetchCalls += 1;
        throw new Error("loadCache should not refetch when raw cache exists");
      },
    });

    assert.equal(fetchCalls, 0);
    assert.equal(loaded.meta.forkcast_commit, "abc123def456");
    assert.ok(fs.existsSync(path.join(cacheRoot, "cache", "eips-index.json")));
    assert.ok(fs.existsSync(path.join(cacheRoot, "cache", "context-index.json")));
    assert.ok(fs.existsSync(path.join(cacheRoot, "cache", "meetings-index.json")));
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-59 loadCache rebuilds when index files contain truncated JSON", async () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const { loadCache } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const cacheDir = path.join(cacheRoot, "cache");
    fs.writeFileSync(path.join(cacheDir, "eips-index.json"), '{"truncated');
    fs.writeFileSync(path.join(cacheDir, "context-index.json"), "{}");
    fs.writeFileSync(path.join(cacheDir, "meetings-index.json"), "[]");

    const loaded = await loadCache({
      cacheRoot,
      fetcher: async () => {
        throw new Error("should not refetch when raw cache exists");
      },
    });

    const eipsIndex = await loaded.readEipsIndex();
    assert.ok(eipsIndex.length > 0, "eips index should be rebuilt with valid data");
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-59 loadCache refetches when meetings-manifest.json is missing", async () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const { loadCache } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
  );

  const cacheRoot = createCacheRoot();
  let fetchCalled = false;

  try {
    seedRawCache(cacheRoot);

    fs.unlinkSync(path.join(cacheRoot, "cache", "meetings-manifest.json"));

    const loaded = await loadCache({
      cacheRoot,
      fetcher: async () => {
        fetchCalled = true;
        seedRawCache(cacheRoot);
        const cacheDir = path.join(cacheRoot, "cache");
        return {
          meta: JSON.parse(fs.readFileSync(path.join(cacheDir, "meta.json"), "utf8")),
          meetings: JSON.parse(fs.readFileSync(path.join(cacheDir, "meetings-manifest.json"), "utf8")),
        };
      },
    });

    assert.ok(fetchCalled, "fetcher should be called when meetings-manifest.json is missing");
    assert.ok(
      (await loaded.readMeetingsIndex()).length > 0,
      "meetings index should be populated after refetch",
    );
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-59 loadCache accepts fetcher fallback results even when the manifest is still missing on disk", async () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const { loadCache } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
  );

  const cacheRoot = createCacheRoot();
  let fetchCalled = false;

  try {
    seedRawCache(cacheRoot);
    fs.unlinkSync(path.join(cacheRoot, "cache", "meetings-manifest.json"));

    const loaded = await loadCache({
      cacheRoot,
      fetcher: async () => {
        fetchCalled = true;
        const cacheDir = path.join(cacheRoot, "cache");
        return {
          meta: JSON.parse(fs.readFileSync(path.join(cacheDir, "meta.json"), "utf8")),
          meetings: [],
        };
      },
    });

    assert.ok(fetchCalled, "fetcher should be called when meetings-manifest.json is missing");
    assert.equal(loaded.meta.forkcast_commit, "abc123def456");
    assert.deepEqual(await loaded.readMeetingsIndex(), [
      {
        type: "acde",
        date: "2026-04-09",
        number: 234,
        dirName: "2026-04-09_234",
        tldrAvailable: true,
        source: "forkcast",
      },
    ]);
    assert.equal((await loaded.readEipsIndex()).length, 3);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-59 buildCache fails when meetings-manifest.json is missing from raw cache", async () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const { buildCache, CacheError } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    fs.unlinkSync(path.join(cacheRoot, "cache", "meetings-manifest.json"));

    await assert.rejects(
      () => buildCache({ cacheRoot }),
      (error) => {
        assert.ok(error instanceof CacheError, `expected CacheError, got ${error.constructor.name}`);
        assert.equal(error.code, "NOT_CACHED");
        return true;
      },
    );
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-59 loadCache reuses build metadata instead of reading meta.json twice", async () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const { loadCache } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "cache.js")).href}?t=${Date.now()}`
  );

  const cacheRoot = createCacheRoot();
  const originalReadFile = fsp.readFile;
  let metaReads = 0;

  try {
    seedRawCache(cacheRoot);

    fsp.readFile = async function patchedReadFile(targetPath, ...args) {
      if (String(targetPath).endsWith(path.join("cache", "meta.json"))) {
        metaReads += 1;
      }
      return originalReadFile.call(this, targetPath, ...args);
    };

    await loadCache({
      cacheRoot,
      fetcher: async () => {
        throw new Error("loadCache should not refetch when raw cache exists");
      },
    });

    assert.equal(metaReads, 1);
  } finally {
    fsp.readFile = originalReadFile;
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});
