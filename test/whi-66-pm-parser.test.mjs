/**
 * WHI-66: PM parser tests
 * Validates parsing of EL, CL, and breakout room meeting notes against
 * reference files from the ethereum/pm repository.
 */

import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const referencesDir = path.resolve(rootDir, "..", "..", "..", "..", "references", "pm");

let parsePmMeeting;
let shouldSkipFile;

before(async () => {
  spawnSync("npm", ["run", "build"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  const mod = await import("../dist/lib/pm-parser.js");
  parsePmMeeting = mod.parsePmMeeting;
  shouldSkipFile = mod.shouldSkipFile;
});

// ---------------------------------------------------------------------------
// shouldSkipFile
// ---------------------------------------------------------------------------

test("shouldSkipFile returns true for README.md", () => {
  assert.strictEqual(shouldSkipFile("README.md"), true);
  assert.strictEqual(shouldSkipFile("readme.md"), true);
});

test("shouldSkipFile returns true for Meeting Template.md", () => {
  assert.strictEqual(shouldSkipFile("Meeting Template.md"), true);
  assert.strictEqual(shouldSkipFile("meeting template.md"), true);
});

test("shouldSkipFile returns false for meeting files", () => {
  assert.strictEqual(shouldSkipFile("Meeting 99.md"), false);
  assert.strictEqual(shouldSkipFile("call_150.md"), false);
  assert.strictEqual(shouldSkipFile("Meeting 01.md"), false);
});

test("shouldSkipFile returns true for non-meeting files via positive-match filter", () => {
  // Files that don't match Meeting NN.md or call_NNN.md patterns
  assert.strictEqual(shouldSkipFile("EIP-1559-pm.md"), true);
  assert.strictEqual(shouldSkipFile("Berlin-pm.md"), true);
  assert.strictEqual(shouldSkipFile("EIPs-Wiki.md"), true);
  assert.strictEqual(shouldSkipFile("random-notes.md"), true);
});

// ---------------------------------------------------------------------------
// EL meetings
// ---------------------------------------------------------------------------

test("parsePmMeeting correctly parses EL Meeting 99", () => {
  const filePath = path.join(referencesDir, "AllCoreDevs-EL-Meetings", "Meeting 99.md");
  if (!fs.existsSync(filePath)) {
    return; // Skip if references not available
  }

  const content = fs.readFileSync(filePath, "utf8");
  const note = parsePmMeeting(content, "acde", "Meeting 99.md", null);

  assert.strictEqual(note.source, "pm");
  assert.strictEqual(note.type, "acde");
  assert.strictEqual(note.series, null);
  assert.strictEqual(note.number, 99);
  assert.match(note.title, /Meeting 99/);
  assert.strictEqual(note.date, "2020-10-30");
  assert.match(note.duration ?? "", /1\.5/);
  assert.match(note.moderator ?? "", /Hudson Jameson/);
  assert.match(note.notesTaker ?? "", /Edson Ayllon/);
  assert.match(note.agendaUrl ?? "", /github\.com/);
  assert.match(note.videoUrl ?? "", /youtube/i);

  // Decisions should include the BLS/YOLOv3 decision
  assert.ok(note.decisions.length >= 1);
  assert.ok(note.decisions.some((d) => d.includes("2537")));

  // Attendance
  assert.ok(note.attendees.length >= 10);
  assert.ok(note.attendees.some((a) => a.includes("Hudson Jameson")));

  // EIP references extracted from body
  assert.ok(note.eipReferences.length >= 1);
  assert.ok(note.eipReferences.includes(2537));

  // Body text should be non-empty
  assert.ok(note.bodyText.length > 100);
});

// ---------------------------------------------------------------------------
// CL meetings
// ---------------------------------------------------------------------------

test("parsePmMeeting correctly parses CL call_150", () => {
  const filePath = path.join(referencesDir, "AllCoreDevs-CL-Meetings", "call_150.md");
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  const note = parsePmMeeting(content, "acdc", "call_150.md", null);

  assert.strictEqual(note.source, "pm");
  assert.strictEqual(note.type, "acdc");
  assert.strictEqual(note.series, null);
  assert.strictEqual(note.number, 150);
  assert.match(note.title, /150/);
  assert.strictEqual(note.date, "2025-02-06");
  assert.match(note.moderator ?? "", /Stokes/);

  // Summary items (CL format uses "Summary | Description" table)
  assert.ok(note.summaryItems.length >= 1);
  assert.ok(note.summaryItems.some((s) => s.includes("Pectra")));

  // EIP references - 7702 should appear
  assert.ok(note.eipReferences.includes(7702));

  // Agenda URL
  assert.match(note.agendaUrl ?? "", /github\.com/);
});

// ---------------------------------------------------------------------------
// Breakout rooms
// ---------------------------------------------------------------------------

test("parsePmMeeting correctly parses PeerDAS breakout Meeting 01", () => {
  const filePath = path.join(referencesDir, "Breakout-Room-Meetings", "PeerDAS", "Meeting 01.md");
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  const note = parsePmMeeting(content, "breakout", "Meeting 01.md", "PeerDAS");

  assert.strictEqual(note.source, "pm");
  assert.strictEqual(note.type, "breakout");
  assert.strictEqual(note.series, "PeerDAS");
  assert.strictEqual(note.number, 1);
  assert.strictEqual(note.date, "2024-06-11");
  assert.match(note.agendaUrl ?? "", /github\.com/);
  assert.match(note.videoUrl ?? "", /youtube/i);

  // Should have body text
  assert.ok(note.bodyText.length > 50);
});

// ---------------------------------------------------------------------------
// Date parsing edge cases
// ---------------------------------------------------------------------------

test("parsePmMeeting handles slash-separated date format (2025/2/6)", () => {
  const content = `# Test Meeting 1
### Meeting Date/Time: Thursday 2025/2/6 at 14:00 UTC
### Moderator: Alice
`;
  const note = parsePmMeeting(content, "acde", "Meeting 01.md", null);
  assert.strictEqual(note.date, "2025-02-06");
});

test("parsePmMeeting handles dot-separated date format (2024.06.11)", () => {
  const content = `# PeerDAS Breakout Room #1
## Meeting Info
**Date**: 2024.06.11
`;
  const note = parsePmMeeting(content, "breakout", "Meeting 01.md", "PeerDAS");
  assert.strictEqual(note.date, "2024-06-11");
});

test("parsePmMeeting handles 'Day Month Year' format (30 Oct 2020)", () => {
  const content = `# Meeting 99
### Meeting Date/Time: Friday 30 Oct 2020, 14:00 UTC
`;
  const note = parsePmMeeting(content, "acde", "Meeting 99.md", null);
  assert.strictEqual(note.date, "2020-10-30");
});

test("parsePmMeeting handles 'Month Day Year' format (Feb 13, 2024)", () => {
  const content = `# Breakout Meeting 1
**Date & Time**: [Feb 13, 2024, 14:00-15:00 UTC](https://example.com)
`;
  const note = parsePmMeeting(content, "breakout", "Meeting 01.md", "(e)PBS");
  assert.strictEqual(note.date, "2024-02-13");
});

test("parsePmMeeting returns null for unparseable date", () => {
  const content = `# Meeting 1
### Meeting Date/Time: Unknown Date TBD
`;
  const note = parsePmMeeting(content, "acde", "Meeting 01.md", null);
  assert.strictEqual(note.date, null);
});

// ---------------------------------------------------------------------------
// Meeting number extraction
// ---------------------------------------------------------------------------

test("parsePmMeeting extracts number from EL filename 'Meeting 99.md'", () => {
  const note = parsePmMeeting("# Meeting 99\n", "acde", "Meeting 99.md", null);
  assert.strictEqual(note.number, 99);
});

test("parsePmMeeting extracts number from CL filename 'call_150.md'", () => {
  const note = parsePmMeeting("# CL Call 150\n", "acdc", "call_150.md", null);
  assert.strictEqual(note.number, 150);
});

test("parsePmMeeting extracts number from breakout filename 'Meeting 01.md'", () => {
  const note = parsePmMeeting("# Breakout 1\n", "breakout", "Meeting 01.md", "PeerDAS");
  assert.strictEqual(note.number, 1);
});

// ---------------------------------------------------------------------------
// EIP reference extraction
// ---------------------------------------------------------------------------

test("parsePmMeeting extracts EIP references from body", () => {
  const content = `# Meeting 1
### Meeting Date/Time: 2024-01-01

Body text mentions EIP-1234 and EIP 5678.
Also EIP-1234 again (should only appear once).
`;
  const note = parsePmMeeting(content, "acde", "Meeting 01.md", null);
  assert.deepStrictEqual(note.eipReferences, [1234, 5678]);
});

test("parsePmMeeting extracts no EIP references when none present", () => {
  const content = `# Meeting 1\n### Meeting Date/Time: 2024-01-01\nNo EIP mentions here.\n`;
  const note = parsePmMeeting(content, "acde", "Meeting 01.md", null);
  assert.deepStrictEqual(note.eipReferences, []);
});
