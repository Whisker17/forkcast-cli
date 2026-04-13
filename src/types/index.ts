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

export interface OutputEip extends Omit<
  Eip,
  | "benefits"
  | "category"
  | "discussionLink"
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
