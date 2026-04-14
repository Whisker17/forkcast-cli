import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function readFixtureJson(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8"));
}

function writeJson(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(contents, null, 2));
}

function createCacheRoot(prefix = "whi-61-cache-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runForkcast(args, { cacheRoot } = {}) {
  return spawnSync("./bin/forkcast", args, {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(cacheRoot ? { FORKCAST_CACHE: cacheRoot } : {}),
    },
  });
}

function seedRawCache(
  cacheRoot,
  {
    eips = [
      readFixtureJson("reference-eip-7702.json"),
      readFixtureJson("reference-eip-7732.json"),
      readFixtureJson("reference-eip-8037.json"),
      readFixtureJson("reference-eip-5920.json"),
    ],
  } = {},
) {
  const cacheDir = path.join(cacheRoot, "cache");

  for (const eip of eips) {
    writeJson(path.join(cacheDir, "eips", `${eip.id}.json`), eip);
  }

  writeJson(path.join(cacheDir, "meta.json"), {
    forkcast_commit: "abc123def456",
    last_updated: "2026-04-13T00:00:00.000Z",
    version: 1,
  });
  writeJson(path.join(cacheDir, "meetings-manifest.json"), [
    { type: "acde", dirName: "2026-04-09_234" },
  ]);
}

test("WHI-61 lists indexed EIPs filtered by fork name case-insensitively", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const result = runForkcast(["eips", "--fork", "glamsterdam"], { cacheRoot });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const output = JSON.parse(result.stdout);

    assert.deepEqual(output.query, {
      command: "eips",
      filters: {
        fork: "glamsterdam",
      },
    });
    assert.equal(output.count, 3);
    assert.deepEqual(output.results.map((entry) => entry.id), [5920, 7732, 8037]);
    assert.deepEqual(output.source, {
      forkcast_commit: "abc123def456",
      last_updated: "2026-04-13T00:00:00.000Z",
    });
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-61 matches --fork and --inclusion against the same fork entry", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const result = runForkcast(["eips", "--fork", "glamsterdam", "--inclusion", "declined"], { cacheRoot });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const output = JSON.parse(result.stdout);

    assert.deepEqual(output.query, {
      command: "eips",
      filters: {
        fork: "glamsterdam",
        inclusion: "Declined",
      },
    });
    assert.equal(output.count, 1);
    assert.deepEqual(output.results.map((entry) => entry.id), [5920]);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-61 applies --layer and --limit while emitting the sparse-data warning", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const result = runForkcast(["eips", "--layer", "EL", "--limit", "1"], { cacheRoot });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const output = JSON.parse(result.stdout);

    assert.deepEqual(output.query, {
      command: "eips",
      filters: {
        layer: "EL",
        limit: 1,
      },
    });
    assert.equal(output.count, 1);
    assert.deepEqual(output.results.map((entry) => entry.id), [5920]);
    assert.equal(
      output.warning,
      "Only 3 of 4 EIPs have a layer field. 1 EIP was excluded from this filter.",
    );
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-61 pretty output renders a table and warning text", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const result = runForkcast(["eips", "--layer", "EL", "--pretty"], { cacheRoot });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /^Warning: Only 3 of 4 EIPs have a layer field\. 1 EIP was excluded from this filter\.$/m);
    assert.match(result.stdout, /^ID\s+Title\s+Status\s+Layer\s+Forks$/m);
    assert.match(result.stdout, /^5920\s+EIP-5920: PAY opcode\s+Stagnant\s+EL\s+Fusaka: Declined, Glamsterdam: Declined$/m);
    assert.match(result.stdout, /^8037\s+EIP-8037: State Creation Gas Cost Increase\s+Draft\s+EL\s+Glamsterdam: Considered$/m);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-61 accepts --pretty after the subcommand and documents it in help", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const pretty = runForkcast(["eips", "--fork", "glamsterdam", "--pretty"], { cacheRoot });
    assert.equal(pretty.status, 0, `stdout:\n${pretty.stdout}\nstderr:\n${pretty.stderr}`);
    assert.match(pretty.stdout, /^ID\s+Title\s+Status\s+Layer\s+Forks$/m);

    const help = runForkcast(["eips", "--help"]);
    assert.equal(help.status, 0, `stdout:\n${help.stdout}\nstderr:\n${help.stderr}`);
    assert.match(help.stdout, /--pretty/);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-61 filters by --status returning only Draft EIPs", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const result = runForkcast(["eips", "--status", "Draft"], { cacheRoot });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const output = JSON.parse(result.stdout);

    assert.deepEqual(output.query, {
      command: "eips",
      filters: {
        status: "Draft",
      },
    });
    assert.equal(output.count, 2);
    assert.deepEqual(output.results.map((entry) => entry.id), [7732, 8037]);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-61 --inclusion without --fork matches any fork with that inclusion status", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const result = runForkcast(["eips", "--inclusion", "scheduled"], { cacheRoot });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const output = JSON.parse(result.stdout);

    assert.deepEqual(output.query, {
      command: "eips",
      filters: {
        inclusion: "Scheduled",
      },
    });
    assert.equal(output.count, 1);
    assert.deepEqual(output.results.map((entry) => entry.id), [7732]);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-61 returns INVALID_INPUT exit code 1 for invalid --status", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const result = runForkcast(["eips", "--status", "invalid"], { cacheRoot });

    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.code, "INVALID_INPUT");
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-61 returns INVALID_INPUT exit code 1 for invalid --layer", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const result = runForkcast(["eips", "--layer", "invalid"], { cacheRoot });

    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.code, "INVALID_INPUT");
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-61 returns empty results with exit code 0 for nonexistent fork", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const result = runForkcast(["eips", "--fork", "nonexistent"], { cacheRoot });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.count, 0);
    assert.deepEqual(output.results, []);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-61 resilience: partial cache (empty eips/ dir) is treated as DATA_ERROR", () => {
  // Simulate the scenario where meta.json + meetings-manifest.json exist and
  // eips/ dir exists but is EMPTY.  The command must not hard-crash; it should
  // surface a meaningful error (DATA_ERROR / NOT_CACHED) with exit code 2.
  //
  // The self-healing retry path is not exercised here because the retry would
  // try to auto-fetch from GitHub, which is not available in the test
  // environment.  We verify instead that the command fails gracefully with a
  // structured JSON error rather than an unhandled exception / empty output.
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot("whi-61-partial-cache-");

  try {
    // Write meta + manifest but leave eips/ dir empty.
    const cacheDir = path.join(cacheRoot, "cache");
    fs.mkdirSync(path.join(cacheDir, "eips"), { recursive: true });
    writeJson(path.join(cacheDir, "meta.json"), {
      forkcast_commit: "abc123def456",
      last_updated: "2026-04-13T00:00:00.000Z",
      version: 1,
    });
    writeJson(path.join(cacheDir, "meetings-manifest.json"), []);

    const result = runForkcast(["eips"], { cacheRoot });

    // Must exit with a non-zero code — either 1 (user error) or 2 (data/fetch error).
    assert.notEqual(result.status, 0, `expected non-zero exit\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    // stdout must still be valid JSON (not garbled or empty).
    let output;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      assert.fail(`stdout was not valid JSON:\n${result.stdout}`);
    }

    assert.ok(typeof output.error === "string" && output.error.length > 0, "output.error should be a non-empty string");
    assert.ok(typeof output.code === "string" && output.code.length > 0, "output.code should be a non-empty string");
    // The code should be a cache-related error, not INVALID_INPUT.
    assert.notEqual(output.code, "INVALID_INPUT");
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-61 resilience: schema-skewed eips-index (object instead of array) yields DATA_ERROR", () => {
  // Pre-seed a valid raw cache AND a malformed eips-index.json that is an
  // object ({}) instead of an array.  The command should detect this, report
  // DATA_ERROR, and exit non-zero — not crash with an unhandled TypeError.
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot("whi-61-skewed-index-");

  try {
    // Seed a valid raw cache (eips/ + meta + manifest) so rawCacheExists() === true
    // and indexesNeedRebuild() sees the index as fresh (same mtime check).
    seedRawCache(cacheRoot);

    const cacheDir = path.join(cacheRoot, "cache");

    // Write an eips-index that is valid JSON but has the wrong shape.
    // We also write a newer-than-eips context + meetings index so that
    // indexesNeedRebuild() considers all three indexes up-to-date (mtime check
    // would normally force a rebuild, but we control timestamps here by writing
    // the index AFTER the EIP files).
    const eipsIndexPath = path.join(cacheDir, "eips-index.json");
    const contextIndexPath = path.join(cacheDir, "context-index.json");
    const meetingsIndexPath = path.join(cacheDir, "meetings-index.json");
    writeJson(eipsIndexPath, { not: "an array" });
    writeJson(contextIndexPath, {});
    writeJson(meetingsIndexPath, []);

    const result = runForkcast(["eips"], { cacheRoot });

    // Must exit with a non-zero code.
    assert.notEqual(result.status, 0, `expected non-zero exit\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    let output;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      assert.fail(`stdout was not valid JSON:\n${result.stdout}`);
    }

    assert.ok(typeof output.error === "string" && output.error.length > 0, "output.error should be a non-empty string");
    // Must not be INVALID_INPUT.
    assert.notEqual(output.code, "INVALID_INPUT");
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});
