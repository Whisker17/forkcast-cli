export type EipStatus =
  | "Draft"
  | "Review"
  | "Last Call"
  | "Final"
  | "Stagnant"
  | "Withdrawn"
  | "Living";

export type EipType = "Standards Track" | "Meta" | "Informational";

export type ForkInclusionStatus =
  | "Proposed"
  | "Considered"
  | "Scheduled"
  | "Included"
  | "Declined"
  | "Withdrawn";

export interface ForkStatusHistoryEntry {
  status: ForkInclusionStatus;
  call: string | null;
  date: string | null;
  timestamp?: number;
}

export interface ForkChampion {
  name: string;
  discord?: string;
  email?: string;
  telegram?: string;
}

export interface PresentationHistoryLinkEntry {
  type: string;
  link: string;
  date: string;
  call?: never;
}

export interface PresentationHistoryCallEntry {
  type: string;
  call: string;
  date: string;
  link?: never;
}

export type PresentationHistoryEntry =
  | PresentationHistoryLinkEntry
  | PresentationHistoryCallEntry;

export interface ForkRelationship {
  forkName: string;
  statusHistory: ForkStatusHistoryEntry[];
  champions?: ForkChampion[];
  isHeadliner?: boolean;
  wasHeadlinerCandidate?: boolean;
  presentationHistory?: PresentationHistoryEntry[];
}

export interface DescriptionEntry {
  description: string;
}

export interface Eip {
  id: number;
  title: string;
  status: EipStatus;
  description: string;
  author: string;
  type: EipType;
  // Raw forkcast data omits category on some legacy EIPs.
  category?: string | null;
  createdDate: string;
  discussionLink?: string;
  // Observed values are bot, expert, and staff, but keep this open for upstream additions.
  reviewer?: string;
  forkRelationships: ForkRelationship[];
  layer?: "EL" | "CL";
  laymanDescription?: string;
  northStars?: string[];
  northStarAlignment?: Record<string, DescriptionEntry>;
  stakeholderImpacts?: Record<string, DescriptionEntry>;
  benefits?: string[];
  // Raw forkcast data sometimes stores tradeoffs as null.
  tradeoffs: string[] | null;
}

export interface OutputForkStatusHistoryEntry extends Omit<ForkStatusHistoryEntry, "timestamp"> {
  timestamp: number | null;
}

export interface OutputForkChampion extends Omit<ForkChampion, "discord" | "email" | "telegram"> {
  discord: string | null;
  email: string | null;
  telegram: string | null;
}

export interface OutputPresentationHistoryEntry {
  type: string;
  // Exactly one of call/link is non-null in normalized output.
  call: string | null;
  date: string;
  link: string | null;
}

export interface OutputForkRelationship extends Omit<
  ForkRelationship,
  "champions" | "isHeadliner" | "presentationHistory" | "statusHistory" | "wasHeadlinerCandidate"
> {
  champions: OutputForkChampion[] | null;
  isHeadliner: boolean | null;
  presentationHistory: OutputPresentationHistoryEntry[] | null;
  statusHistory: OutputForkStatusHistoryEntry[];
  wasHeadlinerCandidate: boolean | null;
}

export interface OutputEip extends Omit<
  Eip,
  | "benefits"
  | "category"
  | "discussionLink"
  | "forkRelationships"
  | "layer"
  | "laymanDescription"
  | "northStarAlignment"
  | "northStars"
  | "reviewer"
  | "stakeholderImpacts"
  | "tradeoffs"
> {
  benefits: string[] | null;
  category: string | null;
  discussionLink: string | null;
  forkRelationships: OutputForkRelationship[];
  layer: "EL" | "CL" | null;
  laymanDescription: string | null;
  northStarAlignment: Record<string, DescriptionEntry> | null;
  northStars: string[] | null;
  reviewer: string | null;
  stakeholderImpacts: Record<string, DescriptionEntry> | null;
  tradeoffs: string[] | null;
}

export interface MeetingHighlight {
  timestamp: string;
  highlight: string;
}

export interface MeetingActionItem {
  timestamp: string;
  action: string;
  owner: string;
}

export interface MeetingDecision {
  timestamp: string;
  decision: string;
}

export interface MeetingTargetEntry {
  timestamp: string;
  target: string;
  commitment?: never;
}

export interface MeetingCommitmentEntry {
  timestamp: string;
  commitment: string;
  target?: never;
}

export type MeetingTarget = MeetingTargetEntry | MeetingCommitmentEntry;

export interface MeetingTldr {
  meeting: string;
  highlights: Record<string, MeetingHighlight[]>;
  action_items: MeetingActionItem[];
  decisions: MeetingDecision[];
  targets: MeetingTarget[];
}

export interface EipIndexForkEntry {
  name: string;
  inclusion: ForkInclusionStatus;
}

export interface EipIndexEntry {
  id: number;
  title: string;
  status: EipStatus;
  category: string | null;
  layer: "EL" | "CL" | null;
  createdDate: string;
  forks: EipIndexForkEntry[];
  hasLaymanDescription: boolean;
  hasStakeholderImpacts: boolean;
}

export interface MeetingIndexEntry {
  type: string;
  date: string;
  number: number;
  dirName: string;
  tldrAvailable: boolean;
  /** True when a parsed pm meeting note is available for this entry. */
  pmNoteAvailable?: boolean;
  /** "forkcast" for TLDR-based meetings, "pm" for pm-repo-only meetings */
  source?: "forkcast" | "pm";
}

export interface ContextEntry {
  meeting: string;
  type: string;
  date: string;
  number: number;
  mentions: string[];
}

export interface OutputQuery {
  command: string;
  filters?: Record<string, unknown>;
}

export interface OutputSource {
  forkcast_commit: string;
  last_updated: string;
  /** Present when pm repo data has been fetched. */
  pm_commit?: string;
}

export interface OutputEnvelope<T> {
  query: OutputQuery;
  results: T[];
  count: number;
  source: OutputSource;
  warning?: string;
  context?: ContextEntry[];
}

export type ErrorCode =
  | "NOT_CACHED"
  | "EIP_NOT_FOUND"
  | "FETCH_FAILED"
  | "DATA_ERROR"
  | "INVALID_INPUT";

export interface ErrorOutput {
  error: string;
  code: ErrorCode;
}

export interface CacheMeta {
  forkcast_commit: string;
  last_updated: string;
  version: number;
}

export interface PmMeta {
  pm_commit: string;
  last_updated: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Temporal query types (WHI-69)
// ---------------------------------------------------------------------------

export interface EipHistoryEntry {
  /** Full commit SHA. */
  commit: string;
  /** ISO date string from git log (e.g. "2023-03-15T10:20:30Z"). */
  date: string;
  author: string;
  message: string;
  /** Human-readable summary of what changed (computed from diff). */
  summary?: string;
}

export type TimelineEntryType = "git_commit" | "meeting_mention" | "status_change";

export interface TimelineEntry {
  date: string;
  type: TimelineEntryType;
  /** Present for git_commit entries. */
  commit?: string;
  author?: string;
  message?: string;
  /** Present for meeting_mention entries. */
  meeting?: string;
  meetingType?: string;
  /** Present for status_change entries. */
  fromStatus?: string;
  toStatus?: string;
  fork?: string;
}

export interface EipTimeline {
  eipId: number;
  title: string;
  entries: TimelineEntry[];
}

export interface EipDiffEntry {
  eipId: number;
  title: string;
  /** Inclusion status in the fork before the start date (null if not in fork). */
  inclusionBefore: string | null;
  /** Inclusion status in the fork after the end date (null if not in fork). */
  inclusionAfter: string | null;
  /** EIP lifecycle status before the start date. */
  statusBefore: string;
  /** EIP lifecycle status after the end date. */
  statusAfter: string;
  /** True if the EIP was added to the fork between the two dates. */
  added: boolean;
  /** True if the EIP was removed from the fork between the two dates. */
  removed: boolean;
}
