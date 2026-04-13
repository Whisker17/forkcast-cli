import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const fixturesDir = path.join(__dirname, "fixtures");

test("WHI-57 exports interfaces that satisfy the forkcast data contracts", () => {
  const typecheck = spawnSync("npm", ["run", "test:types"], {
    cwd: rootDir,
    encoding: "utf8",
  });

  assert.equal(
    typecheck.status,
    0,
    `expected interface contract to compile\nstdout:\n${typecheck.stdout}\nstderr:\n${typecheck.stderr}`,
  );
});

// ---------------------------------------------------------------------------
// Allowed values for union types (must stay in sync with src/types/index.ts)
// ---------------------------------------------------------------------------

const EIP_STATUSES = new Set([
  "Draft", "Review", "Last Call", "Final", "Stagnant", "Withdrawn", "Living",
]);

const EIP_TYPES = new Set(["Standards Track", "Meta", "Informational"]);

const FORK_INCLUSION_STATUSES = new Set([
  "Proposed", "Considered", "Scheduled", "Included", "Declined", "Withdrawn",
]);

const LAYERS = new Set(["EL", "CL"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJSON(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8"));
}

function assertString(value, label) {
  assert.equal(typeof value, "string", `${label} should be a string`);
}

function assertOptionalString(value, label) {
  if (value !== undefined && value !== null) {
    assertString(value, label);
  }
}

function assertMemberOf(value, set, label) {
  assert.ok(set.has(value), `${label}: "${value}" is not in ${JSON.stringify([...set])}`);
}

function assertPresentationHistoryEntry(entry, label) {
  assertString(entry.type, `${label}.type`);
  assertString(entry.date, `${label}.date`);

  const hasLink = "link" in entry;
  const hasCall = "call" in entry;

  assert.ok(
    (hasLink && !hasCall) || (!hasLink && hasCall),
    `${label} must have exactly one of link or call`,
  );

  if (hasLink) {
    assertString(entry.link, `${label}.link`);
  } else {
    assertString(entry.call, `${label}.call`);
  }
}

function assertMeetingTargetEntry(entry, label) {
  assertString(entry.timestamp, `${label}.timestamp`);

  const hasTarget = "target" in entry;
  const hasCommitment = "commitment" in entry;

  assert.ok(
    (hasTarget && !hasCommitment) || (!hasTarget && hasCommitment),
    `${label} must have exactly one of target or commitment`,
  );

  if (hasTarget) {
    assertString(entry.target, `${label}.target`);
  } else {
    assertString(entry.commitment, `${label}.commitment`);
  }
}

// ---------------------------------------------------------------------------
// Reference EIP validation
// ---------------------------------------------------------------------------

test("reference EIP 7702 conforms to the Eip type contract", () => {
  const eip = readJSON("reference-eip-7702.json");

  // Required fields — must always be present
  assert.equal(typeof eip.id, "number", "id must be a number");
  assertString(eip.title, "title");
  assertMemberOf(eip.status, EIP_STATUSES, "status");
  assertString(eip.description, "description");
  assertString(eip.author, "author");
  assertMemberOf(eip.type, EIP_TYPES, "type");
  assertString(eip.createdDate, "createdDate");
  assert.ok(Array.isArray(eip.forkRelationships), "forkRelationships must be an array");

  // tradeoffs — required, always present (null or string[])
  assert.ok(
    eip.tradeoffs === null || Array.isArray(eip.tradeoffs),
    "tradeoffs must be null or string[]",
  );

  // Optional typed fields
  assertOptionalString(eip.category, "category");
  assertOptionalString(eip.discussionLink, "discussionLink");
  assertOptionalString(eip.reviewer, "reviewer");
  assertOptionalString(eip.laymanDescription, "laymanDescription");

  if (eip.layer !== undefined) {
    assertMemberOf(eip.layer, LAYERS, "layer");
  }

  if (eip.benefits !== undefined) {
    assert.ok(Array.isArray(eip.benefits), "benefits must be an array");
    for (const b of eip.benefits) assertString(b, "benefits[]");
  }

  if (eip.northStars !== undefined) {
    assert.ok(Array.isArray(eip.northStars), "northStars must be an array");
    for (const s of eip.northStars) assertString(s, "northStars[]");
  }

  if (eip.northStarAlignment !== undefined) {
    for (const [key, entry] of Object.entries(eip.northStarAlignment)) {
      assertString(entry.description, `northStarAlignment.${key}.description`);
    }
  }

  if (eip.stakeholderImpacts !== undefined) {
    for (const [key, entry] of Object.entries(eip.stakeholderImpacts)) {
      assertString(entry.description, `stakeholderImpacts.${key}.description`);
    }
  }

  // Validate forkRelationships sub-structure
  for (const fr of eip.forkRelationships) {
    assertString(fr.forkName, "forkRelationships[].forkName");
    assert.ok(Array.isArray(fr.statusHistory), "statusHistory must be an array");

    for (const sh of fr.statusHistory) {
      assertMemberOf(sh.status, FORK_INCLUSION_STATUSES, "statusHistory[].status");
      assert.ok(
        sh.call === null || typeof sh.call === "string",
        "statusHistory[].call must be string | null",
      );
      assert.ok(
        sh.date === null || typeof sh.date === "string",
        "statusHistory[].date must be string | null",
      );
      if (sh.timestamp !== undefined) {
        assert.equal(typeof sh.timestamp, "number", "statusHistory[].timestamp must be a number");
      }
    }

    if (fr.champions !== undefined) {
      for (const c of fr.champions) {
        assertString(c.name, "champions[].name");
        assertOptionalString(c.discord, "champions[].discord");
        assertOptionalString(c.email, "champions[].email");
        assertOptionalString(c.telegram, "champions[].telegram");
      }
    }

    if (fr.presentationHistory !== undefined) {
      for (const [index, ph] of fr.presentationHistory.entries()) {
        assertPresentationHistoryEntry(ph, `presentationHistory[${index}]`);
      }
    }
  }
});

test("reference EIP 5920 covers the legacy northStars payload shape", () => {
  const eip = readJSON("reference-eip-5920.json");

  assert.ok(Array.isArray(eip.northStars), "northStars must be an array");
  assert.ok(eip.northStars.length > 0, "northStars fixture must exercise the legacy field");

  for (const [index, value] of eip.northStars.entries()) {
    assertString(value, `northStars[${index}]`);
  }
});

test("reference EIP 7732 covers actual presentationHistory payloads", () => {
  const eip = readJSON("reference-eip-7732.json");
  const entries = eip.forkRelationships.flatMap((relationship, relationshipIndex) =>
    (relationship.presentationHistory ?? []).map((entry, entryIndex) => ({
      entry,
      label: `forkRelationships[${relationshipIndex}].presentationHistory[${entryIndex}]`,
    })),
  );

  assert.ok(entries.length > 0, "fixture must contain presentationHistory entries");

  for (const { entry, label } of entries) {
    assertPresentationHistoryEntry(entry, label);
  }
});

test("reference EIP 8037 covers actual numeric statusHistory timestamps", () => {
  const eip = readJSON("reference-eip-8037.json");
  const timestampedEntries = eip.forkRelationships.flatMap((relationship, relationshipIndex) =>
    relationship.statusHistory
      .filter((entry) => entry.timestamp !== undefined)
      .map((entry, entryIndex) => ({
        entry,
        label: `forkRelationships[${relationshipIndex}].statusHistory[${entryIndex}]`,
      })),
  );

  assert.ok(timestampedEntries.length > 0, "fixture must contain statusHistory timestamps");

  for (const { entry, label } of timestampedEntries) {
    assert.equal(typeof entry.timestamp, "number", `${label}.timestamp must be a number`);
  }
});

// ---------------------------------------------------------------------------
// Reference TLDR validation
// ---------------------------------------------------------------------------

test("reference TLDR ACDE #234 conforms to the MeetingTldr type contract", () => {
  const tldr = readJSON("reference-tldr-acde-234.json");

  // Required top-level fields
  assertString(tldr.meeting, "meeting");
  assert.equal(typeof tldr.highlights, "object", "highlights must be an object");
  assert.ok(!Array.isArray(tldr.highlights), "highlights must be Record<string, array>, not array");
  assert.ok(Array.isArray(tldr.action_items), "action_items must be an array");
  assert.ok(Array.isArray(tldr.decisions), "decisions must be an array");

  // targets — required, always present (may be empty array)
  assert.ok(Array.isArray(tldr.targets), "targets must be an array");

  // Validate highlights structure
  for (const [category, entries] of Object.entries(tldr.highlights)) {
    assert.ok(Array.isArray(entries), `highlights.${category} must be an array`);
    for (const entry of entries) {
      assertString(entry.timestamp, `highlights.${category}[].timestamp`);
      assertString(entry.highlight, `highlights.${category}[].highlight`);
    }
  }

  // Validate action_items structure
  for (const item of tldr.action_items) {
    assertString(item.timestamp, "action_items[].timestamp");
    assertString(item.action, "action_items[].action");
    assertString(item.owner, "action_items[].owner");
    assert.equal(item.deadline, undefined, "action_items[] must not have a deadline field");
  }

  // Validate decisions structure
  for (const d of tldr.decisions) {
    assertString(d.timestamp, "decisions[].timestamp");
    assertString(d.decision, "decisions[].decision");
  }

  // Validate targets structure
  for (const [index, target] of tldr.targets.entries()) {
    assertMeetingTargetEntry(target, `targets[${index}]`);
  }
});

test("reference TLDR ACDT #58 covers actual commitment targets", () => {
  const tldr = readJSON("reference-tldr-acdt-058.json");
  const commitmentTargets = tldr.targets.filter((entry) => "commitment" in entry);

  assert.ok(commitmentTargets.length > 0, "fixture must contain commitment targets");

  for (const [index, target] of commitmentTargets.entries()) {
    assertMeetingTargetEntry(target, `commitmentTargets[${index}]`);
  }
});
