/**
 * Shared TLDR text-extraction utilities used by both cache.ts and db.ts.
 *
 * Provides a single source of truth for iterating over individual text fields
 * in a MeetingTldr.  Both the JSON context-index builder (cache.ts) and the
 * SQLite eip_mentions inserter (db.ts) MUST use `getTldrTextFields` so that
 * the per-field granularity is consistent.
 */

import type { MeetingTarget, MeetingTldr } from "../types/index.js";

/**
 * Return every individual text string from a TLDR — one per highlight, one per
 * decision, one per action-item, one per target.  The caller decides how to
 * aggregate (join for search columns, iterate for per-mention extraction).
 */
export function getTldrTextFields(tldr: MeetingTldr): string[] {
  const fields: string[] = [];

  for (const items of Object.values(tldr.highlights)) {
    for (const item of items) {
      fields.push(item.highlight);
    }
  }

  for (const decision of tldr.decisions) {
    fields.push(decision.decision);
  }

  for (const actionItem of tldr.action_items) {
    fields.push(actionItem.action);
  }

  for (const target of tldr.targets ?? []) {
    fields.push(getMeetingTargetText(target));
  }

  return fields;
}

/**
 * Extract a human-readable text string from a MeetingTarget entry.
 */
export function getMeetingTargetText(target: MeetingTarget): string {
  if ("target" in target && typeof target.target === "string") {
    return target.target;
  }

  if ("commitment" in target && typeof target.commitment === "string") {
    return target.commitment;
  }

  throw new Error("Meeting target entry is missing both target and commitment text");
}
