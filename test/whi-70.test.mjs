import test, { before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

let build;

before(() => {
  build = spawnSync("npm", ["run", "build"], { cwd: rootDir, encoding: "utf8" });
});

function assertBuildOk() {
  assert.equal(build.status, 0, "build failed: " + build.stdout + build.stderr);
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FIXTURE_EIPS = [
  { id: 8141, title: "Frame Transaction", prefix: "EIP", status: "Draft", description: "desc", lastStageChange: "2026-03-26", lastStageChangeFork: "Hegota", currentStage: "Considered", url: "/eips/8141" },
  { id: 7807, title: "SSZ execution blocks", prefix: "EIP", status: "Draft", description: "desc", lastStageChange: "2026-03-12", lastStageChangeFork: "Hegota", currentStage: "Declined", url: "/eips/7807" },
  { id: 7805, title: "FOCIL", prefix: "EIP", status: "Draft", description: "desc", lastStageChange: "2026-02-19", lastStageChangeFork: "Hegota", currentStage: "Scheduled", url: "/eips/7805" },
  { id: 5920, title: "PAY opcode", prefix: "EIP", status: "Stagnant", description: "desc", lastStageChange: "2025-06-15", lastStageChangeFork: "Fusaka", currentStage: "Declined", url: "/eips/5920" },
];

function makeApiResponse(eips = FIXTURE_EIPS) {
  return { generatedAt: "2026-04-14T12:00:00.000Z", eips };
}

function makeWritable() {
  let buf = "";
  return { write(chunk) { buf += chunk; return true; }, get value() { return buf; } };
}

async function runChanges(since, { pretty = false, eips = FIXTURE_EIPS, throwFetch = null } = {}) {
  const { createChangesCommand } = await import(
    pathToFileURL(path.join(rootDir, "dist", "commands", "changes.js")).href + "?t=" + Date.now()
  );
  const stdout = makeWritable();
  const stderr = makeWritable();
  const fetchStageChanges = throwFetch
    ? async () => { throw throwFetch; }
    : async () => makeApiResponse(eips);
  const cmd = createChangesCommand({ fetchStageChanges, stdout, stderr });
  const argv = ["node", "changes", "--since", since];
  if (pretty) argv.push("--pretty");
  await cmd.parseAsync(argv);
  return { stdout: stdout.value, stderr: stderr.value };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("WHI-70 changes command is registered in the CLI binary", () => {
  assertBuildOk();
  const help = spawnSync("./bin/forkcast", ["--help"], { cwd: rootDir, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /changes/);
});

test("WHI-70 changes --help describes --since and --pretty", () => {
  assertBuildOk();
  const help = spawnSync("./bin/forkcast", ["changes", "--help"], { cwd: rootDir, encoding: "utf8" });
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /--since/);
  assert.match(help.stdout, /--pretty/);
});

test("WHI-70 filters by lastStageChange >= since date", async () => {
  assertBuildOk();
  const { stdout } = await runChanges("2026-03-01");
  const output = JSON.parse(stdout);
  assert.equal(output.query.command, "changes");
  assert.equal(output.query.filters.sinceDate, "2026-03-01");
  assert.equal(output.count, 2);
  // 8141 (2026-03-26) and 7807 (2026-03-12) are >= 2026-03-01
  assert.deepEqual(output.results.map((r) => r.id), [8141, 7807]);
});

test("WHI-70 results are sorted newest-first then ascending EIP id", async () => {
  assertBuildOk();
  const { stdout } = await runChanges("2026-01-01");
  const output = JSON.parse(stdout);
  assert.deepEqual(output.results.map((r) => r.id), [8141, 7807, 7805]);
  for (let i = 1; i < output.results.length; i++) {
    assert.ok(output.results[i].lastStageChange <= output.results[i - 1].lastStageChange, "must be newest-first");
  }
});

test("WHI-70 sort tie-breaking: same date orders by ascending EIP id", async () => {
  assertBuildOk();
  const tiedEips = [
    { id: 9999, title: "AAA", prefix: "EIP", status: "Draft", description: "desc", lastStageChange: "2026-03-26", lastStageChangeFork: "Hegota", currentStage: "Considered", url: "/eips/9999" },
    { id: 1111, title: "BBB", prefix: "EIP", status: "Draft", description: "desc", lastStageChange: "2026-03-26", lastStageChangeFork: "Hegota", currentStage: "Considered", url: "/eips/1111" },
    { id: 5555, title: "CCC", prefix: "EIP", status: "Draft", description: "desc", lastStageChange: "2026-03-20", lastStageChangeFork: "Hegota", currentStage: "Scheduled", url: "/eips/5555" },
  ];
  const { stdout } = await runChanges("2026-03-01", { eips: tiedEips });
  const output = JSON.parse(stdout);
  // Same date (2026-03-26): 1111 before 9999 (ascending id); then 5555 (earlier date)
  assert.deepEqual(output.results.map((r) => r.id), [1111, 9999, 5555]);
});

test("WHI-70 source.forkcast_commit is live and last_updated matches generatedAt", async () => {
  assertBuildOk();
  const { stdout } = await runChanges("2026-01-01");
  const output = JSON.parse(stdout);
  assert.equal(output.source.forkcast_commit, "live");
  assert.equal(output.source.last_updated, "2026-04-14T12:00:00.000Z");
});

test("WHI-70 returns empty results with warning when nothing matches", async () => {
  assertBuildOk();
  const { stdout } = await runChanges("2030-01-01");
  const output = JSON.parse(stdout);
  assert.equal(output.count, 0);
  assert.deepEqual(output.results, []);
  assert.ok(typeof output.warning === "string" && output.warning.length > 0);
  assert.match(output.warning, /No EIP stage changes found/);
});

test("WHI-70 accepts ISO timestamp with time component", async () => {
  assertBuildOk();
  const { stdout } = await runChanges("2026-03-26T00:00:00Z");
  const output = JSON.parse(stdout);
  assert.equal(output.query.filters.sinceDate, "2026-03-26");
  assert.ok(output.results.some((r) => r.id === 8141));
});

test("WHI-70 INVALID_INPUT for unparseable --since value", async () => {
  assertBuildOk();
  const exitCodeBefore = process.exitCode;
  try {
    const { stdout } = await runChanges("not-a-date");
    const output = JSON.parse(stdout);
    assert.equal(output.code, "INVALID_INPUT");
    assert.ok(typeof output.error === "string" && output.error.length > 0);
  } finally {
    process.exitCode = exitCodeBefore;
  }
});

test("WHI-70 FETCH_FAILED when fetchStageChanges throws", async () => {
  assertBuildOk();
  const exitCodeBefore = process.exitCode;
  try {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "FETCH_FAILED" });
    const { stdout } = await runChanges("2026-01-01", { throwFetch: err });
    const output = JSON.parse(stdout);
    assert.equal(output.code, "FETCH_FAILED");
  } finally {
    process.exitCode = exitCodeBefore;
  }
});

test("WHI-70 DATA_ERROR when API response has no eips array", async () => {
  assertBuildOk();
  const exitCodeBefore = process.exitCode;
  try {
    const { stdout } = await runChanges("2026-01-01", { eips: null });
    const output = JSON.parse(stdout);
    assert.equal(output.code, "DATA_ERROR");
  } finally {
    process.exitCode = exitCodeBefore;
  }
});

test("WHI-70 --pretty renders table with header and rows", async () => {
  assertBuildOk();
  const { stdout } = await runChanges("2026-03-01", { pretty: true });
  assert.match(stdout, /ID\s+Stage\s+Fork\s+Changed\s+Title/);
  assert.match(stdout, /8141/);
  assert.match(stdout, /Frame Transaction/);
  assert.match(stdout, /2 results since 2026-03-01/);
});

test("WHI-70 --pretty empty results prints helpful message", async () => {
  assertBuildOk();
  const { stdout } = await runChanges("2030-01-01", { pretty: true });
  assert.match(stdout, /No stage changes found since 2030-01-01/);
});

test("WHI-70 --pretty error goes to stderr, not stdout", async () => {
  assertBuildOk();
  const exitCodeBefore = process.exitCode;
  try {
    const err = new Error("network down");
    const { stdout, stderr } = await runChanges("2026-01-01", { pretty: true, throwFetch: err });
    assert.equal(stdout, "");
    assert.match(stderr, /network down/);
  } finally {
    process.exitCode = exitCodeBefore;
  }
});

test("WHI-70 envelope satisfies OutputEnvelope contract", async () => {
  assertBuildOk();
  const { stdout } = await runChanges("2026-01-01");
  const output = JSON.parse(stdout);
  assert.ok("query" in output && typeof output.query.command === "string");
  assert.ok(Array.isArray(output.results));
  assert.ok(typeof output.count === "number");
  assert.equal(output.count, output.results.length);
  assert.ok("source" in output);
});

test("WHI-70 each result has required StageChange fields", async () => {
  assertBuildOk();
  const { stdout } = await runChanges("2026-01-01");
  const output = JSON.parse(stdout);
  for (const r of output.results) {
    assert.ok(typeof r.id === "number");
    assert.ok(typeof r.title === "string");
    assert.ok(typeof r.prefix === "string");
    assert.ok(typeof r.status === "string");
    assert.ok(typeof r.description === "string");
    assert.ok(typeof r.lastStageChange === "string");
    assert.ok(typeof r.lastStageChangeFork === "string");
    assert.ok(typeof r.currentStage === "string");
    assert.ok(typeof r.url === "string");
  }
});
