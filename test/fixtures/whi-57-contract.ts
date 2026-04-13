import type {
  CacheMeta,
  ContextEntry,
  Eip,
  EipIndexEntry,
  EipStatus,
  ErrorOutput,
  ForkInclusionStatus,
  PresentationHistoryEntry,
  ForkRelationship,
  ForkStatusHistoryEntry,
  MeetingIndexEntry,
  MeetingTarget,
  MeetingTldr,
  OutputEnvelope,
} from "../../src/types/index.js";

const lifecycleStatus: EipStatus = "Final";
const inclusionStatus: ForkInclusionStatus = "Included";

// @ts-expect-error Fork inclusion statuses are distinct from EIP lifecycle statuses.
const invalidLifecycleStatus: EipStatus = "Included";
// @ts-expect-error EIP lifecycle statuses are distinct from fork inclusion statuses.
const invalidInclusionStatus: ForkInclusionStatus = "Final";
const validEipType: Eip["type"] = "Informational";
// @ts-expect-error The audited EIP taxonomy excludes arbitrary type strings.
const invalidEipType: Eip["type"] = "Protocol";

const timedStatusHistoryEntry = {
  status: "Considered",
  call: "acdt/66",
  date: "2026-01-19",
  timestamp: 3188,
} satisfies ForkStatusHistoryEntry;

const representativeEip = {
  id: 7702,
  title: "EIP-7702: Set Code for EOAs",
  status: lifecycleStatus,
  description: "Add a new tx type that permanently sets the code for an EOA",
  author:
    "Vitalik Buterin (@vbuterin), Sam Wilson (@SamWilsn), Ansgar Dietrichs (@adietrichs), lightclient (@lightclient)",
  type: "Standards Track",
  category: "Core",
  createdDate: "2024-05-07",
  discussionLink:
    "https://ethereum-magicians.org/t/eip-set-eoa-account-code-for-one-transaction/19923",
  reviewer: "bot",
  forkRelationships: [
    {
      forkName: "Pectra",
      statusHistory: [
        {
          status: inclusionStatus,
          call: null,
          date: null,
        },
      ],
    },
  ],
  laymanDescription:
    "Enables an address to delegate its control to an existing smart contract.",
  northStarAlignment: {
    improveUX: {
      description: "Brings account abstraction benefits to EOAs.",
    },
  },
  stakeholderImpacts: {
    endUsers: {
      description: "Better wallet UX with new features without migrating to a new address.",
    },
    elClients: {
      description: "Support new transaction type and code authorization for EOAs.",
    },
  },
  benefits: [
    "Brings account abstraction features to EOAs",
    "Provides alternative recovery options for wallets",
  ],
  tradeoffs: null,
} satisfies Eip;

const eipWithLegacyNorthStars = {
  id: 5920,
  title: "EIP-5920: PAY opcode",
  status: "Draft",
  description: "Add a new PAY opcode for ETH transfers.",
  author:
    "Gavin John (@Pandapip1), Zainan Victor Zhou (@xinbenlv), Sam Wilson (@SamWilsn), Jochem Brouwer (@jochem-brouwer), Charles Cooper (@charles-cooper)",
  type: "Standards Track",
  category: "Core",
  createdDate: "2022-12-13",
  forkRelationships: [],
  northStars: ["Improve UX", "Scale L1"],
  northStarAlignment: {
    scaleL1: {
      description:
        "Minor gas efficiency improvements for ETH transfers by having a dedicated function.",
    },
    improveUX: {
      description: "Improving fees and security for users.",
    },
  },
  tradeoffs: null,
} satisfies Eip;

const eipWithoutCategory = {
  id: 1,
  title: "EIP-1: EIP Purpose and Guidelines",
  status: "Living",
  description: "",
  author: "Martin Becze <mb@ethereum.org>, Hudson Jameson <hudson@ethereum.org>, et al.",
  type: "Meta",
  createdDate: "2015-10-27",
  forkRelationships: [],
  tradeoffs: null,
} satisfies Eip;

const eipWithChampionsAndPresentationHistory = {
  id: 7692,
  title: "EIP-7692: EVM Object Format (EOFv1) Meta",
  status: "Stagnant",
  description: "List of EIPs belonging to the EOFv1 proposal",
  author:
    "Alex Beregszaszi (@axic), Paweł Bylica (@chfast), Andrei Maiboroda (@gumb0), Piotr Dobaczewski (@pdobacz), Danno Ferrin (@shemnon)",
  type: "Meta",
  category: "Core",
  createdDate: "2024-04-17",
  discussionLink: "https://ethereum-magicians.org/t/eip-7692-evm-object-format-eof-meta/19686",
  reviewer: "bot",
  layer: "EL",
  forkRelationships: [
    {
      forkName: "Fusaka",
      statusHistory: [
        {
          status: "Declined",
          call: null,
          date: null,
        },
      ],
    },
    {
      forkName: "Glamsterdam",
      statusHistory: [],
      isHeadliner: false,
      wasHeadlinerCandidate: true,
      presentationHistory: [
        {
          type: "headliner_proposal",
          link: "https://ethereum-magicians.org/t/glamsterdam-headliner-proposal-eof/24464",
          date: "2025-06-05",
        },
        {
          type: "headliner_presentation",
          call: "acdc/158",
          date: "2025-05-29",
        },
      ],
      champions: [
        {
          name: "Ben Adams",
          discord: "ben_a_adams",
          email: "ben@example.org",
          telegram: "@benaadams",
        },
      ],
    },
  ],
  laymanDescription:
    "This introduces a new container format for EVM bytecode that enables code versioning.",
  northStarAlignment: {
    scaleL1: {
      description: "Enables more efficient execution environments like RISC-V and EVM64.",
    },
    improveUX: {
      description: "Provides better developer tools through improved code analysis.",
    },
  },
  stakeholderImpacts: {
    endUsers: {
      description: "Indirect benefits from improved contract performance and reduced gas costs.",
    },
    appDevs: {
      description: "Can use multiple execution environments within the same contract.",
    },
  },
  benefits: [
    "Enables incremental adoption of RISC-V and EVM64 within existing contracts",
  ],
  tradeoffs: null,
} satisfies Eip;

// @ts-expect-error EIPs always include tradeoffs, even when the value is null.
const eipWithoutTradeoffs: Eip = {
  id: 2,
  title: "EIP-2: Homestead Hard-fork Changes",
  status: "Final",
  description: "Homestead consensus changes.",
  author: "Vitalik Buterin <vitalik.buterin@ethereum.org>",
  type: "Standards Track",
  category: "Core",
  createdDate: "2015-11-15",
  forkRelationships: [],
};

// @ts-expect-error Presentation history entries must provide either a link or a call reference.
const invalidPresentationHistoryEntry: PresentationHistoryEntry = {
  type: "headliner_proposal",
  date: "2025-06-05",
};

// @ts-expect-error Presentation history entries cannot provide both a link and a call reference.
const dualPresentationHistoryEntry: PresentationHistoryEntry = {
  type: "headliner_proposal",
  link: "https://example.com",
  call: "acdc/158",
  date: "2025-06-05",
};

const forkRelationshipWithEmptyHistory = {
  forkName: "Glamsterdam",
  statusHistory: [],
  presentationHistory: [],
} satisfies ForkRelationship;

const meetingTldr = {
  meeting: "ACDE #234 - April 9, 2026",
  highlights: {
    testing_progress: [
      {
        timestamp: "00:08:37",
        highlight: "EIP-8037 clarifications needed for spillover gas and state refunds",
      },
    ],
    history_pruning: [
      {
        timestamp: "01:10:31",
        highlight: "EIP-4444: one year; weak subjectivity: 18 days; blob expiry: 18 days",
      },
    ],
  },
  action_items: [
    {
      timestamp: "01:00:31",
      action: "Schedule AA breakout to align on proposal path forward",
      owner: "Pedro (Protocol Support to coordinate)",
    },
  ],
  decisions: [
    {
      timestamp: "00:46:31",
      decision: "Frame transactions CFI'd as non-headliner; AA proposals now open for Hegota",
    },
  ],
  targets: [
    {
      timestamp: "00:29:02",
      target: "Monday - Decision point for ePBS DevNet stability",
    },
  ],
} satisfies MeetingTldr;

const meetingCommitmentTarget = {
  timestamp: "00:11:29",
  commitment: "First BPO activation scheduled for October 21st (10 target/15 max blobs)",
} satisfies MeetingTarget;

// @ts-expect-error Meeting targets cannot provide both a target and a commitment.
const dualMeetingTarget: MeetingTarget = {
  timestamp: "00:29:02",
  target: "Monday - Decision point",
  commitment: "First BPO activation scheduled",
};

// @ts-expect-error TLDR payloads always include a targets array, even when it is empty.
const meetingTldrWithoutTargets: MeetingTldr = {
  meeting: "ACDE #000 - Placeholder",
  highlights: {},
  action_items: [],
  decisions: [],
};

const eipIndexEntry = {
  id: representativeEip.id,
  title: representativeEip.title,
  status: representativeEip.status,
  category: representativeEip.category,
  layer: null,
  createdDate: representativeEip.createdDate,
  forks: [
    {
      name: "Pectra",
      inclusion: "Included",
    },
  ],
  hasLaymanDescription: true,
  hasStakeholderImpacts: true,
} satisfies EipIndexEntry;

const meetingIndexEntry = {
  type: "acde",
  date: "2026-04-09",
  number: 234,
  dirName: "2026-04-09_234",
  tldrAvailable: true,
} satisfies MeetingIndexEntry;

const contextEntry = {
  meeting: meetingTldr.meeting,
  type: meetingIndexEntry.type,
  date: meetingIndexEntry.date,
  number: meetingIndexEntry.number,
  mentions: [
    meetingTldr.highlights.history_pruning[0].highlight,
    meetingTldr.decisions[0].decision,
  ],
} satisfies ContextEntry;

const outputEnvelope = {
  query: {
    command: "eip",
    filters: {
      id: 7702,
      context: true,
      type: validEipType,
    },
  },
  results: [
    representativeEip,
    eipWithLegacyNorthStars,
    eipWithoutCategory,
    eipWithChampionsAndPresentationHistory,
  ],
  count: 4,
  source: {
    forkcast_commit: "abc1234",
    last_updated: "2026-04-13T00:00:00.000Z",
  },
  warning: "Sparse field filters may exclude EIPs without optional data.",
  context: [contextEntry],
} satisfies OutputEnvelope<Eip>;

const errorOutput = {
  error: "Cache is empty",
  code: "NOT_CACHED",
} satisfies ErrorOutput;

const cacheMeta = {
  forkcast_commit: "abc1234",
  last_updated: "2026-04-13T00:00:00.000Z",
  version: 1,
} satisfies CacheMeta;

void [
  invalidLifecycleStatus,
  invalidInclusionStatus,
  invalidEipType,
  timedStatusHistoryEntry,
  representativeEip,
  eipWithLegacyNorthStars,
  eipWithoutCategory,
  eipWithChampionsAndPresentationHistory,
  eipWithoutTradeoffs,
  invalidPresentationHistoryEntry,
  dualPresentationHistoryEntry,
  forkRelationshipWithEmptyHistory,
  meetingTldr,
  meetingCommitmentTarget,
  dualMeetingTarget,
  meetingTldrWithoutTargets,
  eipIndexEntry,
  meetingIndexEntry,
  contextEntry,
  outputEnvelope,
  errorOutput,
  cacheMeta,
];
