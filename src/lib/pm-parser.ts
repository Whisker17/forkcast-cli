/**
 * pm-parser.ts
 *
 * Parses individual meeting note markdown files from the ethereum/pm repository
 * into structured PmMeetingNote objects using regex-based extraction.
 *
 * Supports three formats:
 *   - AllCoreDevs-EL-Meetings/Meeting NN.md  → type "acde"
 *   - AllCoreDevs-CL-Meetings/call_NNN.md    → type "acdc"
 *   - Breakout-Room-Meetings/{topic}/Meeting NN.md → type "breakout"
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PmMeetingType = "acde" | "acdc" | "breakout";

export interface PmMeetingNote {
  source: "pm";
  type: PmMeetingType;
  /** Breakout room series name, e.g. "PeerDAS". Null for acde/acdc. */
  series: string | null;
  number: number;
  title: string;
  /** ISO date string if parseable, null otherwise. */
  date: string | null;
  /** Raw duration string, e.g. "1.5 hrs". Null if not found. */
  duration: string | null;
  moderator: string | null;
  notesTaker: string | null;
  agendaUrl: string | null;
  videoUrl: string | null;
  /** Names from the Attendance section. */
  attendees: string[];
  /** Text of each row in the Decisions Made table. */
  decisions: string[];
  /** Text of each row in the Summary table (CL format). */
  summaryItems: string[];
  /** Full markdown body for search indexing. */
  bodyText: string;
  /** EIP numbers (e.g. 7702) extracted from the body. */
  eipReferences: number[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EIP_REFERENCE_PATTERN = /EIP[- ]?(\d{3,5})/gi;

/**
 * Files that should be skipped — they are not actual meeting notes.
 */
const SKIP_FILENAMES = new Set([
  "meeting template.md",
  "perma-archive.md",
  "readme.md",
  "active-breakout-series.md",
]);

/**
 * Positive-match patterns for meeting note filenames.
 * Only files matching one of these patterns should be parsed.
 * This protects against non-meeting files (e.g. `*-pm.md`, EIPs-Wiki entries)
 * that may exist in the pm repo but aren't meeting notes.
 */
const MEETING_FILE_PATTERNS = [
  /^Meeting\s+\d+/i,    // EL & breakout: "Meeting 99.md", "Meeting 01.md"
  /^call_\d+/i,          // CL: "call_150.md"
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine if a filename should be skipped (not a meeting note).
 * Uses both a blocklist (known non-meeting files) and a positive-match
 * allowlist (only `Meeting NN.md` or `call_NNN.md` patterns pass).
 * Case-insensitive comparison.
 */
export function shouldSkipFile(filename: string): boolean {
  if (SKIP_FILENAMES.has(filename.toLowerCase())) {
    return true;
  }
  // Positive-match: file must match a known meeting filename pattern
  const basename = filename.replace(/\.md$/i, "");
  return !MEETING_FILE_PATTERNS.some((pattern) => pattern.test(basename));
}

/**
 * Parse a meeting note markdown file into a PmMeetingNote.
 *
 * @param content  - Full text of the markdown file.
 * @param type     - Meeting type (acde / acdc / breakout).
 * @param filename - Base filename (e.g. "Meeting 99.md", "call_150.md").
 * @param series   - Breakout series name, null for acde/acdc.
 * @returns Parsed PmMeetingNote.
 */
export function parsePmMeeting(
  content: string,
  type: PmMeetingType,
  filename: string,
  series: string | null,
): PmMeetingNote {
  const number = extractMeetingNumber(type, filename, series);
  const title = extractTitle(content, type, number, series);
  const date = extractDate(content);
  const duration = extractFieldValue(content, /###\s+Meeting Duration\s*:\s*(.+)/i);
  const moderator = extractFieldValue(content, /###\s+Moderator\s*:\s*(.+)/i);
  const notesTaker = extractFieldValue(content, /###\s+Notes\s*:\s*(.+)/i);
  const agendaUrl = extractMarkdownLinkUrl(content, /###\s+\[.*?[Aa]genda.*?\]\((.+?)\)/);
  const videoUrl = extractMarkdownLinkUrl(content, /###\s+\[Audio\/Video.*?\]\((.+?)\)/i)
    ?? extractMarkdownLinkUrl(content, /\*\*YouTube Video\*\*\s*:\s*(\S+)/i)
    ?? extractMarkdownLinkUrl(content, /\*\*Recording\*\*\s*:\s*(\S+)/i)
    ?? extractPlainUrl(content, /\*\*YouTube Video\*\*\s*:\s*(https?:\/\/\S+)/i)
    ?? extractPlainUrl(content, /\*\*Recording\*\*\s*:\s*(https?:\/\/\S+)/i);
  const decisions = extractTableSection(content, /^##\s+Decisions Made/im);
  const summaryItems = extractTableSection(content, /^##\s+Summary(?:\s*<!--[^>]*-->)?/im);
  const attendees = extractAttendees(content);
  const bodyText = extractBodyText(content);
  const eipReferences = extractEipReferences(bodyText);

  return {
    source: "pm",
    type,
    series,
    number,
    title,
    date,
    duration,
    moderator,
    notesTaker,
    agendaUrl,
    videoUrl,
    attendees,
    decisions,
    summaryItems,
    bodyText,
    eipReferences,
  };
}

// ---------------------------------------------------------------------------
// Meeting number extraction
// ---------------------------------------------------------------------------

function extractMeetingNumber(
  type: PmMeetingType,
  filename: string,
  series: string | null,
): number {
  // EL: "Meeting 99.md" → 99
  // Breakout: "Meeting 01.md" → 1
  if (type === "acde" || type === "breakout") {
    const match = /[Mm]eeting\s+0*(\d+)/i.exec(filename);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }

  // CL: "call_150.md" → 150
  if (type === "acdc") {
    const match = /call_0*(\d+)/i.exec(filename);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }

  // Fallback: extract any number from filename
  const anyMatch = /(\d+)/.exec(filename);
  if (anyMatch?.[1]) {
    return Number(anyMatch[1]);
  }

  // Last resort: derive from series/type/filename — won't be great but won't crash
  return 0;
}

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

function extractTitle(
  content: string,
  type: PmMeetingType,
  number: number,
  series: string | null,
): string {
  // Look for the first `# ` heading (not `## ` or `### `)
  const match = /^#\s+(.+)/m.exec(content);
  if (match?.[1]) {
    // Strip <!-- omit in toc --> comments
    return match[1].replace(/<!--[^>]*-->/g, "").trim();
  }

  // Fallback: construct a reasonable title
  if (type === "acde") {
    return `All Core Devs Meeting ${number}`;
  }

  if (type === "acdc") {
    return `Consensus Layer Call ${number}`;
  }

  return series ? `${series} Meeting ${number}` : `Breakout Meeting ${number}`;
}

// ---------------------------------------------------------------------------
// Date extraction
// ---------------------------------------------------------------------------

/**
 * Attempt to parse a meeting date from the markdown content.
 * Handles multiple date formats found in the pm repo.
 * Returns an ISO date string (YYYY-MM-DD) or null if unparseable.
 */
function extractDate(content: string): string | null {
  // Pattern 1: ### Meeting Date/Time: Friday 30 Oct 2020, 14:00 UTC
  // Pattern 2: ### Meeting Date/Time: Thursday 2025/2/6 at 14:00 UTC
  // Pattern 3: **Date**: 2024.06.11
  // Pattern 4: **Date & Time**: [Feb 13, 2024, 14:00-15:00 UTC](...)
  // Pattern 5: Date: 2024.7.24

  const patterns: RegExp[] = [
    /###\s+Meeting Date\/Time\s*:\s*(.+)/i,
    /\*\*Date\s*(?:&\s*Time)?\*\*\s*:\s*(.+)/i,
    /^Date\s*:\s*(.+)/im,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (match?.[1]) {
      const parsed = parseDate(match[1].trim());
      if (parsed) {
        return parsed;
      }
    }
  }

  return null;
}

/**
 * Try to parse a date from many possible string formats.
 * Returns YYYY-MM-DD or null.
 */
function parseDate(raw: string): string | null {
  // Numeric: 2025/2/6 or 2024.06.11 or 2024.7.24
  const numericMatch = /(\d{4})[./](\d{1,2})[./](\d{1,2})/.exec(raw);
  if (numericMatch) {
    const y = numericMatch[1];
    const m = String(numericMatch[2]).padStart(2, "0");
    const d = String(numericMatch[3]).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // Markdown link: [Feb 13, 2024, ...](...) — extract the text part first
  const linkTextMatch = /\[([^\]]+)\]/.exec(raw);
  if (linkTextMatch) {
    const parsed = parseDate(linkTextMatch[1]);
    if (parsed) {
      return parsed;
    }
  }

  // "30 Oct 2020" or "Oct 30 2020" or "October 30, 2020"
  const months: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04",
    may: "05", jun: "06", jul: "07", aug: "08",
    sep: "09", oct: "10", nov: "11", dec: "12",
    january: "01", february: "02", march: "03", april: "04",
    june: "06", july: "07", august: "08", september: "09",
    october: "10", november: "11", december: "12",
  };

  // Day Month Year: "30 Oct 2020" or "30 October 2020"
  const dmyMatch = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(raw);
  if (dmyMatch) {
    const monthKey = dmyMatch[2]!.toLowerCase().slice(0, 3);
    const m = months[monthKey];
    if (m) {
      const d = String(dmyMatch[1]).padStart(2, "0");
      return `${dmyMatch[3]}-${m}-${d}`;
    }
  }

  // Month Day Year: "Feb 13, 2024" or "February 13, 2024"
  const mdyMatch = /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(raw);
  if (mdyMatch) {
    const monthKey = mdyMatch[1]!.toLowerCase().slice(0, 3);
    const m = months[monthKey];
    if (m) {
      const d = String(mdyMatch[2]).padStart(2, "0");
      return `${mdyMatch[3]}-${m}-${d}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Field extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the value portion of a single-line field matching a pattern.
 * Strips trailing `<!-- omit in toc -->` comments.
 */
function extractFieldValue(content: string, pattern: RegExp): string | null {
  const match = pattern.exec(content);
  if (!match?.[1]) {
    return null;
  }

  const value = match[1]
    .replace(/<!--[^>]*-->/g, "")
    .trim();

  return value.length > 0 ? value : null;
}

/**
 * Extract a URL from a markdown link in a line matching the given pattern.
 * The pattern should have one capture group containing the URL.
 */
function extractMarkdownLinkUrl(content: string, pattern: RegExp): string | null {
  const match = pattern.exec(content);
  if (!match?.[1]) {
    return null;
  }
  const url = match[1].trim();
  return url.length > 0 && url.startsWith("http") ? url : null;
}

/**
 * Extract a plain URL from a line matching the given pattern.
 */
function extractPlainUrl(content: string, pattern: RegExp): string | null {
  const match = pattern.exec(content);
  if (!match?.[1]) {
    return null;
  }
  const url = match[1].trim().replace(/[),\s].*$/, "");
  return url.startsWith("http") ? url : null;
}

// ---------------------------------------------------------------------------
// Table parsing
// ---------------------------------------------------------------------------

/**
 * Find a section starting at the given heading pattern and extract text rows
 * from the first markdown table in that section.
 *
 * Table format:
 *   Header | Header
 *   -|-
 *   **99.1** | Decision text here.
 */
function extractTableSection(content: string, headingPattern: RegExp): string[] {
  const match = headingPattern.exec(content);
  if (!match) {
    return [];
  }

  const sectionStart = match.index + match[0].length;

  // Find the end of the section (next heading at same or higher level)
  const afterSection = content.slice(sectionStart);
  const nextHeadingMatch = /^#{1,3}\s+/m.exec(afterSection);
  const sectionText = nextHeadingMatch
    ? afterSection.slice(0, nextHeadingMatch.index)
    : afterSection;

  return parseMarkdownTable(sectionText);
}

/**
 * Parse rows from a markdown table, returning the non-header text rows.
 * Skips the separator row (e.g., `-|-` or `---|---`).
 */
function parseMarkdownTable(text: string): string[] {
  const rows: string[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();

    // Skip empty lines, separator rows, and the header row
    if (!trimmed || /^[\-|: ]+$/.test(trimmed)) {
      continue;
    }

    // Must look like a table row: contains at least one `|`
    if (!trimmed.includes("|")) {
      continue;
    }

    // Split on `|` and take the second column (index 1 after splitting)
    const parts = trimmed.split("|");
    if (parts.length < 2) {
      continue;
    }

    // For tables with "Key | Value" format, take the second column
    // but skip the first (which is the key/number)
    const value = parts.slice(1).join("|").trim();
    if (value.length === 0) {
      continue;
    }

    // Strip markdown bold markers (**...**) but keep the text
    const cleaned = value.replace(/\*\*/g, "").trim();
    if (cleaned.length > 0) {
      rows.push(cleaned);
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Attendance extraction
// ---------------------------------------------------------------------------

function extractAttendees(content: string): string[] {
  const match = /^##\s+Attendance/im.exec(content);
  if (!match) {
    return [];
  }

  const afterSection = content.slice(match.index + match[0].length);
  // Stop at next heading
  const nextHeadingMatch = /^#{1,3}\s+/m.exec(afterSection);
  const sectionText = nextHeadingMatch
    ? afterSection.slice(0, nextHeadingMatch.index)
    : afterSection;

  const attendees: string[] = [];
  for (const line of sectionText.split("\n")) {
    const trimmed = line.trim();
    // Attendees are listed as "- Name" or "* Name"
    const attendeeMatch = /^[-*]\s+(.+)/.exec(trimmed);
    if (attendeeMatch?.[1]) {
      attendees.push(attendeeMatch[1].trim());
    }
  }

  return attendees;
}

// ---------------------------------------------------------------------------
// Body text extraction
// ---------------------------------------------------------------------------

/**
 * Extract the "body" of the meeting note — everything after the header
 * metadata block (date, duration, moderator etc.).
 * The header is defined as the block of `### Field:` lines near the top.
 */
function extractBodyText(content: string): string {
  // Find the last `###` field in the header block (moderator, notes, etc.)
  // The header block is within the first 50 lines.
  const lines = content.split("\n");
  let lastHeaderLine = 0;

  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const line = lines[i]!.trim();
    if (
      /^###\s+Meeting Date\/Time/i.test(line)
      || /^###\s+Meeting Duration/i.test(line)
      || /^###\s+Moderator/i.test(line)
      || /^###\s+Notes/i.test(line)
      || /^###\s+\[.*[Aa]genda/i.test(line)
      || /^###\s+\[Audio\/Video/i.test(line)
    ) {
      lastHeaderLine = i;
    }
  }

  // Body starts after the last header field line
  return lines.slice(lastHeaderLine + 1).join("\n").trim();
}

// ---------------------------------------------------------------------------
// EIP reference extraction
// ---------------------------------------------------------------------------

function extractEipReferences(text: string): number[] {
  const seen = new Set<number>();
  const eipNumbers: number[] = [];

  for (const match of text.matchAll(EIP_REFERENCE_PATTERN)) {
    const num = Number(match[1]);
    if (!seen.has(num)) {
      seen.add(num);
      eipNumbers.push(num);
    }
  }

  return eipNumbers.sort((a, b) => a - b);
}
