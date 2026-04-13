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

function readFixtureJson(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8"));
}

function writeJson(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(contents, null, 2));
}

function createCacheRoot(prefix = "whi-60-cache-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function assertNoUndefinedDeep(value, seen = new Set()) {
  if (value === null || typeof value !== "object") {
    assert.notEqual(value, undefined);
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoUndefinedDeep(item, seen);
    }
    return;
  }

  for (const entry of Object.values(value)) {
    assert.notEqual(entry, undefined);
    assertNoUndefinedDeep(entry, seen);
  }
}

async function importEipModule() {
  return import(`${pathToFileURL(path.join(rootDir, "dist", "commands", "eip.js")).href}?t=${Date.now()}`);
}

function runForkcast(args, { cacheRoot, env } = {}) {
  return spawnSync("./bin/forkcast", args, {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(cacheRoot ? { FORKCAST_CACHE: cacheRoot } : {}),
      ...env,
    },
  });
}

function seedRawCache(
  cacheRoot,
  {
    includeContext = false,
    eips = [readFixtureJson("reference-eip-7702.json")],
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

  if (includeContext) {
    const tldr = readFixtureJson("reference-tldr-acde-234.json");
    tldr.action_items = [
      {
        timestamp: "01:23:45",
        action: "Prepare follow-up notes for EIP-7702 before the next call",
        owner: "Protocol R&D",
      },
    ];
    writeJson(
      path.join(cacheDir, "tldrs", "acde", "2026-04-09_234.json"),
      tldr,
    );
  }
}

test("WHI-60 returns a single EIP in the output envelope", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const result = runForkcast(["eip", "7702"], { cacheRoot });

    assert.equal(
      result.status,
      0,
      `expected command to succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);

    assert.deepEqual(output.query, {
      command: "eip",
      filters: {
        id: 7702,
      },
    });
    assert.equal(output.count, 1);
    assert.equal(output.results[0].id, 7702);
    assert.equal(output.results[0].title, "EIP-7702: Set Code for EOAs");
    assert.deepEqual(output.source, {
      forkcast_commit: "abc123def456",
      last_updated: "2026-04-13T00:00:00.000Z",
    });
    assert.equal("context" in output, false);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-60 attaches related meeting context when --context is set", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot, { includeContext: true });

    const result = runForkcast(["eip", "7702", "--context"], { cacheRoot });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const output = JSON.parse(result.stdout);

    assert.deepEqual(output.query, {
      command: "eip",
      filters: {
        id: 7702,
        context: true,
      },
    });
    assert.deepEqual(output.context, [
      {
        meeting: "ACDE #234 - April 9, 2026",
        type: "acde",
        date: "2026-04-09",
        number: 234,
        mentions: ["Prepare follow-up notes for EIP-7702 before the next call"],
      },
    ]);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-60 pretty output renders the EIP summary and fork relationships", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const result = runForkcast(["--pretty", "eip", "7702"], { cacheRoot });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /^EIP-7702: Set Code for EOAs/m);
    assert.match(result.stdout, /^Status: Final$/m);
    assert.match(result.stdout, /^Type: Standards Track$/m);
    assert.match(result.stdout, /^Category: Core$/m);
    assert.match(result.stdout, /^Source: abc123def456$/m);
    assert.match(result.stdout, /^Updated: 2026-04-13T00:00:00\.000Z$/m);
    assert.match(result.stdout, /^Fork relationships:$/m);
    assert.match(result.stdout, /Pectra: Included/);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-60 pretty output includes meeting context when requested", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot, { includeContext: true });

    const result = runForkcast(["--pretty", "eip", "7702", "--context"], { cacheRoot });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /^Related meetings:$/m);
    assert.match(result.stdout, /ACDE #234 - April 9, 2026 \(2026-04-09\)/);
    assert.match(result.stdout, /^  - Prepare follow-up notes for EIP-7702 before the next call$/m);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-60 accepts --pretty after the subcommand and documents it in help", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const pretty = runForkcast(["eip", "7702", "--pretty"], { cacheRoot });
    assert.equal(pretty.status, 0, `stdout:\n${pretty.stdout}\nstderr:\n${pretty.stderr}`);
    assert.match(pretty.stdout, /^EIP-7702: Set Code for EOAs/m);

    const help = runForkcast(["eip", "--help"]);
    assert.equal(help.status, 0, `stdout:\n${help.stdout}\nstderr:\n${help.stderr}`);
    assert.match(help.stdout, /--pretty/);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-60 pretty output includes latest fork call and date details", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot, {
      eips: [readFixtureJson("reference-eip-8037.json")],
      includeContext: true,
    });

    const result = runForkcast(["eip", "8037", "--pretty", "--context"], { cacheRoot });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Glamsterdam: Considered \(2026-01-19, acdt\/66\)/);
    assert.match(result.stdout, /^  - EIP-8037 clarifications needed for spillover gas and state refunds$/m);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-60 pretty output keeps lay summary before the fork relationships section", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot, {
      eips: [readFixtureJson("reference-eip-8037.json")],
    });

    const result = runForkcast(["eip", "8037", "--pretty"], { cacheRoot });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const descriptionIndex = result.stdout.indexOf("Description:");
    const laySummaryIndex = result.stdout.indexOf("Lay Summary:");
    const forkRelationshipsIndex = result.stdout.indexOf("Fork relationships:");

    assert.notEqual(descriptionIndex, -1);
    assert.notEqual(laySummaryIndex, -1);
    assert.notEqual(forkRelationshipsIndex, -1);
    assert.ok(descriptionIndex < laySummaryIndex, result.stdout);
    assert.ok(laySummaryIndex < forkRelationshipsIndex, result.stdout);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-60 returns EIP_NOT_FOUND when the requested EIP is missing", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const result = runForkcast(["eip", "99999"], { cacheRoot });

    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      error: "EIP 99999 not found",
      code: "EIP_NOT_FOUND",
    });
    assert.match(result.stderr, /EIP 99999 not found/);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-60 pretty mode writes human-readable errors", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const result = runForkcast(["eip", "99999", "--pretty"], { cacheRoot });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /EIP 99999 not found/);
    assert.doesNotMatch(result.stderr, /"code"/);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-60 rejects invalid EIP identifiers", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    const result = runForkcast(["eip", "abc"], { cacheRoot });

    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      error: "Invalid EIP number",
      code: "INVALID_INPUT",
    });
    assert.match(result.stderr, /Invalid EIP number/);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-60 returns an empty context array when no meeting mentions are found", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();

  try {
    seedRawCache(cacheRoot);

    const result = runForkcast(["eip", "7702", "--context"], { cacheRoot });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout).context, []);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-60 normalizes missing optional EIP fields to null in JSON output", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();
  const sparseEip = readFixtureJson("reference-eip-7702.json");

  delete sparseEip.category;
  delete sparseEip.discussionLink;
  delete sparseEip.reviewer;
  delete sparseEip.layer;
  delete sparseEip.laymanDescription;
  delete sparseEip.northStars;
  delete sparseEip.northStarAlignment;
  delete sparseEip.stakeholderImpacts;
  delete sparseEip.benefits;
  delete sparseEip.tradeoffs;

  try {
    seedRawCache(cacheRoot, { eips: [sparseEip] });

    const result = runForkcast(["eip", "7702"], { cacheRoot });
    const outputEip = JSON.parse(result.stdout).results[0];

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(outputEip.category, null);
    assert.equal(outputEip.discussionLink, null);
    assert.equal(outputEip.reviewer, null);
    assert.equal(outputEip.layer, null);
    assert.equal(outputEip.laymanDescription, null);
    assert.equal(outputEip.northStars, null);
    assert.equal(outputEip.northStarAlignment, null);
    assert.equal(outputEip.stakeholderImpacts, null);
    assert.equal(outputEip.benefits, null);
    assert.equal(outputEip.tradeoffs, null);
    assert.ok("category" in outputEip);
    assert.ok("discussionLink" in outputEip);
    assert.ok("reviewer" in outputEip);
    assert.ok("layer" in outputEip);
    assert.ok("laymanDescription" in outputEip);
    assert.ok("northStars" in outputEip);
    assert.ok("northStarAlignment" in outputEip);
    assert.ok("stakeholderImpacts" in outputEip);
    assert.ok("benefits" in outputEip);
    assert.ok("tradeoffs" in outputEip);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-60 normalizes nested fork relationship sparse fields to null", () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const cacheRoot = createCacheRoot();
  const sparseEip = readFixtureJson("reference-eip-8037.json");

  delete sparseEip.forkRelationships[0].champions;
  delete sparseEip.forkRelationships[0].statusHistory[1].timestamp;

  try {
    seedRawCache(cacheRoot, {
      eips: [sparseEip],
    });

    const result = runForkcast(["eip", "8037"], { cacheRoot });
    const outputEip = JSON.parse(result.stdout).results[0];

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.deepEqual(outputEip.forkRelationships[0], {
      forkName: "Glamsterdam",
      statusHistory: [
        {
          status: "Proposed",
          call: null,
          date: null,
          timestamp: null,
        },
        {
          status: "Considered",
          call: "acdt/66",
          date: "2026-01-19",
          timestamp: null,
        },
      ],
      champions: null,
      isHeadliner: null,
      wasHeadlinerCandidate: null,
      presentationHistory: null,
    });
    assert.ok("champions" in outputEip.forkRelationships[0]);
    assert.ok("isHeadliner" in outputEip.forkRelationships[0]);
    assert.ok("wasHeadlinerCandidate" in outputEip.forkRelationships[0]);
    assert.ok("presentationHistory" in outputEip.forkRelationships[0]);
  } finally {
    fs.rmSync(cacheRoot, { force: true, recursive: true });
  }
});

test("WHI-60 normalizeEipForOutput strips unknown fields and preserves populated values", async () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const { normalizeEipForOutput } = await importEipModule();
  const populatedEip = readFixtureJson("reference-eip-8037.json");

  populatedEip.securityConsiderations = "Synthetic field to catch spread leakage";
  populatedEip.forkRelationships[0].isHeadliner = true;
  populatedEip.forkRelationships[0].wasHeadlinerCandidate = false;
  populatedEip.forkRelationships[0].presentationHistory = [
    {
      type: "call",
      call: "acdt/66",
      date: "2026-01-19",
    },
  ];

  const normalized = normalizeEipForOutput(populatedEip);

  assertNoUndefinedDeep(normalized);
  assert.equal("securityConsiderations" in normalized, false);
  assert.deepEqual(normalized, {
    id: 8037,
    title: "EIP-8037: State Creation Gas Cost Increase",
    status: "Draft",
    description: "Harmonization, increase and separate metering of state creation gas costs to mitigate state growth and unblock scaling",
    author: "Maria Silva (@misilva73), Carlos Perez (@CPerezz), Jochem Brouwer (@jochem-brouwer), Ansgar Dietrichs (@adietrichs), Łukasz Rozmej (@LukaszRozmej), Anders Elowsson (@anderselowsson), Francesco D'Amato (@fradamt)",
    type: "Standards Track",
    category: "Core",
    createdDate: "2025-10-01",
    discussionLink: "https://ethereum-magicians.org/t/eip-8037-state-creation-gas-cost-increase/25694",
    reviewer: "expert",
    layer: "EL",
    forkRelationships: [
      {
        forkName: "Glamsterdam",
        statusHistory: [
          {
            status: "Proposed",
            call: null,
            date: null,
            timestamp: null,
          },
          {
            status: "Considered",
            call: "acdt/66",
            date: "2026-01-19",
            timestamp: 3188,
          },
        ],
        champions: [
          {
            name: "Maria Silva",
            discord: "misilva73",
            email: null,
            telegram: null,
          },
        ],
        isHeadliner: true,
        wasHeadlinerCandidate: false,
        presentationHistory: [
          {
            type: "call",
            call: "acdt/66",
            date: "2026-01-19",
            link: null,
          },
        ],
      },
    ],
    laymanDescription: "Proposes to increase gas costs for state creation to mitigate state growth under higher throughput regimes.",
    northStars: null,
    northStarAlignment: {
      scaleL1: {
        description: "By making state creation more expensive, this EIP helps control state growth, which is crucial for scaling Ethereum.",
      },
    },
    stakeholderImpacts: {
      endUsers: {
        description: "Users may experience higher transaction fees for creating new accounts and contracts, but improved scalability benefits all.",
      },
      appDevs: {
        description: "Developers should anticipate increased deployment costs, necessitating adjustments to gas estimation tools and budget projections.",
      },
      walletDevs: {
        description: "Wallet developers need to update gas estimations to reflect new costs; otherwise, minimal code changes are needed.",
      },
      toolingInfra: {
        description: "Tooling and infrastructure must accommodate new pricing models for transaction estimates, with only minor changes to existing tools.",
      },
      layer2s: {
        description: "L2s adopting this EIP will align with mainnet behaviors, requiring thorough testing and client updates for accurate operations.",
      },
      stakersNodes: {
        description: "Node operators will need to update their clients for new gas parameters; otherwise, operations and validation remain unchanged.",
      },
      clClients: {
        description: "Minimal changes expected for CL clients; primarily involves standard fork coordination with minimal complexity.",
      },
      elClients: {
        description: "Must integrate new gas costs into transaction handling, requiring updates to gas accounting and ensuring compatibility with existing EIP standards.",
      },
    },
    benefits: [
      "Standardizes costs across all state creation operations.",
      "Mitigates excessive state growth, enhancing Ethereum's overall scalability.",
      "Encourages developers to optimize contract designs due to increased costs.",
    ],
    tradeoffs: null,
  });
});

test("WHI-60 normalizeEipForOutput materializes nulls before JSON serialization", async () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const { normalizeEipForOutput } = await importEipModule();
  const sparseEip = readFixtureJson("reference-eip-7702.json");

  delete sparseEip.category;
  delete sparseEip.discussionLink;
  delete sparseEip.reviewer;
  delete sparseEip.layer;
  delete sparseEip.laymanDescription;
  delete sparseEip.northStars;
  delete sparseEip.northStarAlignment;
  delete sparseEip.stakeholderImpacts;
  delete sparseEip.benefits;
  delete sparseEip.tradeoffs;
  delete sparseEip.forkRelationships[0].champions;
  delete sparseEip.forkRelationships[0].isHeadliner;
  delete sparseEip.forkRelationships[0].wasHeadlinerCandidate;
  delete sparseEip.forkRelationships[0].presentationHistory;

  const normalized = normalizeEipForOutput(sparseEip);

  assertNoUndefinedDeep(normalized);
  assert.equal(normalized.category, null);
  assert.equal(normalized.forkRelationships[0].champions, null);
  assert.equal(normalized.forkRelationships[0].isHeadliner, null);
  assert.equal(normalized.forkRelationships[0].wasHeadlinerCandidate, null);
  assert.equal(normalized.forkRelationships[0].presentationHistory, null);
});

test("WHI-60 preserves FETCH_FAILED when cache bootstrap fails", async () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const [{ createEipCommand }, { FetcherError }] = await Promise.all([
    import(`${pathToFileURL(path.join(rootDir, "dist", "commands", "eip.js")).href}?t=${Date.now()}`),
    import(`${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}`),
  ]);

  const stdout = [];
  const stderr = [];
  const previousExitCode = process.exitCode;

  try {
    const command = createEipCommand({
      getCacheRoot: () => "/tmp/whi-60-fetch-failed",
      loadCache: async () => {
        throw new FetcherError("Unable to reach forkcast upstream", "FETCH_FAILED");
      },
      stdout: {
        write(chunk) {
          stdout.push(String(chunk));
          return true;
        },
      },
      stderr: {
        write(chunk) {
          stderr.push(String(chunk));
          return true;
        },
      },
    });

    await command.parseAsync(["node", "eip", "7702"], { from: "node" });

    assert.deepEqual(JSON.parse(stdout.join("")), {
      error: "Unable to reach forkcast upstream",
      code: "FETCH_FAILED",
    });
    assert.match(stderr.join(""), /Unable to reach forkcast upstream/);
    assert.equal(process.exitCode, 2);
  } finally {
    process.exitCode = previousExitCode;
  }
});
