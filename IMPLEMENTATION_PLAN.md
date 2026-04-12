# Forkcast CLI — Implementation Plan

> This plan is designed for Codex to execute. Each phase has clear inputs, outputs,
> and verification criteria. Reference data files are in `./references/forkcast/` and
> `./references/pm/` for schema validation during development.

## Project Overview

A CLI tool that fetches Ethereum governance data from the forkcast repo
(github.com/ethereum/forkcast) and exposes it as agent-consumable structured JSON.
No git dependency. Auto-fetches data on first query. Zero-setup install.

**Linear Project:** Forkcast CLI (WHI)
**Design Doc:** `~/.gstack/projects/forkcast-cli/whisker-no-branch-design-20260412-160545.md`

---

## Phase 0: Project Setup

### WHI-56: Initialize TypeScript project

**What:** Bootstrap the Node.js project with TypeScript and Commander.js.

**Steps:**
1. Run `npm init` in project root. Package name: `forkcast-cli`, bin: `forkcast`
2. Install dev dependencies: `typescript`, `@types/node`
3. Install runtime dependency: `commander`
4. Create `tsconfig.json`:
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "Node16",
       "moduleResolution": "Node16",
       "outDir": "dist",
       "rootDir": "src",
       "strict": true,
       "esModuleInterop": true,
       "declaration": true
     },
     "include": ["src"]
   }
   ```
5. Create directory structure:
   ```
   src/
     index.ts          # CLI entry point (Commander.js program definition)
     commands/          # One file per command
     lib/               # Shared logic (fetcher, cache, output)
     types/             # TypeScript interfaces
   bin/
     forkcast           # #!/usr/bin/env node shim → dist/index.js
   ```
6. Add `package.json` scripts: `build`, `dev` (tsc --watch), `start`
7. Add `.gitignore`: node_modules, dist, .forkcast
8. Run `git init` and make initial commit

**Verify:** `npm run build` succeeds. `./bin/forkcast --help` shows Commander.js help output.

---

### WHI-57: Define TypeScript interfaces

**What:** Create type definitions matching the actual forkcast data schemas.

**File:** `src/types/index.ts`

**Critical: use the actual data files for reference, NOT made-up schemas.**
- EIP schema: examine `./references/forkcast/src/data/eips/7702.json`
- TLDR schema: examine `./references/forkcast/public/artifacts/acde/2026-04-09_234/tldr.json`

**Interfaces to define:**

```typescript
// EIP lifecycle status (top-level "status" field)
type EipStatus = "Draft" | "Review" | "Last Call" | "Final" | "Stagnant" | "Withdrawn" | "Living";

// Fork inclusion status (inside forkRelationships.statusHistory)
type ForkInclusionStatus = "Proposed" | "Considered" | "Scheduled" | "Included" | "Declined" | "Withdrawn";

interface ForkRelationship {
  forkName: string;
  statusHistory: { status: ForkInclusionStatus; call: string | null; date: string | null }[];
  champions?: { name: string; discord?: string; email?: string; telegram?: string }[];
  isHeadliner?: boolean;
  wasHeadlinerCandidate?: boolean;
  presentationHistory?: unknown[];
}

interface Eip {
  id: number;
  title: string;
  status: EipStatus;
  description: string;
  author: string;
  type: string;
  category: string | null;       // 490/544 have this
  createdDate: string;
  discussionLink?: string;
  reviewer?: string;
  forkRelationships: ForkRelationship[];
  layer?: "EL" | "CL";           // only 69/544 (13%)
  laymanDescription?: string;     // 117/544 (22%)
  northStarAlignment?: Record<string, { description: string }>;
  stakeholderImpacts?: Record<string, { description: string }>;
  benefits?: string[];
  tradeoffs?: string[];
}

// TLDR highlights are grouped by topic category
interface MeetingTldr {
  meeting: string;                // e.g. "ACDE #234 - April 9, 2026"
  highlights: Record<string, { timestamp: string; highlight: string }[]>;
  action_items: { timestamp: string; action: string; owner: string }[];
  decisions: { timestamp: string; decision: string }[];
  targets?: { timestamp: string; target: string }[];
}

// Index entry for fast filtering (precomputed)
interface EipIndexEntry {
  id: number;
  title: string;
  status: EipStatus;
  category: string | null;
  layer: "EL" | "CL" | null;
  createdDate: string;
  forks: { name: string; inclusion: ForkInclusionStatus }[];
  hasLaymanDescription: boolean;
  hasStakeholderImpacts: boolean;
}

// Meeting index entry
interface MeetingIndexEntry {
  type: string;                   // acde, acdc, acdt, bal, epbs, etc.
  date: string;                   // ISO date
  number: number;
  dirName: string;                // e.g. "2026-04-09_234"
  tldrAvailable: boolean;
}

// Context index: EIP → meeting mentions
interface ContextEntry {
  meeting: string;
  type: string;
  date: string;
  number: number;
  mentions: string[];             // highlight/decision text that mentions this EIP
}

// Output envelope wrapping every command response
interface OutputEnvelope<T> {
  query: { command: string; filters?: Record<string, unknown> };
  results: T[];
  count: number;
  source: {
    forkcast_commit: string;
    last_updated: string;
  };
  warning?: string;
  context?: ContextEntry[];       // only for --context flag
}

// Error output
interface ErrorOutput {
  error: string;
  code: "NOT_CACHED" | "EIP_NOT_FOUND" | "FETCH_FAILED" | "DATA_ERROR" | "INVALID_INPUT";
}

// Cache metadata
interface CacheMeta {
  forkcast_commit: string;
  last_updated: string;           // ISO timestamp
  version: number;                // schema version, start at 1
}
```

**IMPORTANT — Two status taxonomies:**
1. `EipStatus`: the EIP's own lifecycle (Draft → Final). Stored at top-level `status` field.
2. `ForkInclusionStatus`: whether an EIP is included in a fork. Stored inside `forkRelationships[].statusHistory[].status`.
These are DIFFERENT. The CLI exposes them as `--status` and `--inclusion` flags respectively.

**Verify:** Types compile. Manually parse `7702.json` and `tldr.json` against the interfaces.

---

## Phase 1: Core MVP

### WHI-58: Data fetcher

**What:** Download EIP data from GitHub without git. Auto-fetch on first query.

**File:** `src/lib/fetcher.ts`

**Implementation:**

```
fetchEipData():
  1. GET https://api.github.com/repos/ethereum/forkcast/commits/main
     → extract commit SHA (response.sha)
  2. Download https://github.com/ethereum/forkcast/archive/main.tar.gz
     → stream through node:zlib (gunzip) → tar extraction
     → extract ONLY files matching: forkcast-main/src/data/eips/*.json
     → write to ~/.forkcast/cache/eips/
  3. Also extract: forkcast-main/public/artifacts/
     → list directories to build meeting inventory
     → for each dir with tldr.json: fetch from GitHub Pages instead (faster, cached by CDN)
  4. Write meta.json: { forkcast_commit: SHA, last_updated: NOW, version: 1 }
```

**TLDR fetching strategy:**
- TLDRs are served at `https://ethereum.github.io/forkcast/artifacts/{type}/{date}_{number}/tldr.json`
- After tarball extraction, scan the `public/artifacts/` directory listing from the tarball
- For each meeting dir: try fetching tldr.json from GitHub Pages
- Cache successful fetches to `~/.forkcast/cache/tldrs/{type}/{date}_{number}.json`
- This is the most reliable source (GitHub Pages CDN, no rate limits)

**Cache dir:** `process.env.FORKCAST_CACHE || path.join(os.homedir(), '.forkcast')`

**Error handling:**
- Network failure: throw with code `FETCH_FAILED`
- Tarball extraction error: clean up partial cache dir, throw
- GitHub API rate limit (HTTP 403): warn, use existing cache if available

**tar extraction:** Use the `tar` npm package (`tar.x({ filter, cwd, strip })`) or implement minimal tar parsing with `node:zlib` + streaming. The `tar` package is recommended for reliability.

**Verify:** Run fetcher. `~/.forkcast/cache/eips/` contains 544 JSON files. `meta.json` has commit SHA.

---

### WHI-59: Cache system (indexes)

**What:** Build precomputed indexes from raw EIP and TLDR data for fast querying.

**File:** `src/lib/cache.ts`

**Implementation:**

```
buildCache():
  1. Read all 544 files from cache/eips/
  2. Build eips-index.json:
     For each EIP file:
       - Extract: id, title, status, category, layer (or null), createdDate
       - Extract fork relationships: for each forkRelationship, take forkName and
         the LATEST entry in statusHistory as the current inclusion status
       - Track sparse field presence: hasLaymanDescription, hasStakeholderImpacts
     Write array of EipIndexEntry to cache/eips-index.json

  3. Build context-index.json:
     For each TLDR file in cache/tldrs/:
       - Extract meeting metadata from filename (type, date, number)
       - Scan ALL text fields for EIP references:
         regex: /EIP[- ]?(\d{3,5})/gi
         Search in: highlights (all categories), decisions, action_items, targets
       - For each matched EIP number, record: { meeting, type, date, number, mentions[] }
     Write Record<string, ContextEntry[]> to cache/context-index.json
     Key = EIP number as string, value = array of meetings that mention it

  4. Build meetings-index.json:
     For each meeting directory found during fetch:
       - Parse dir name: "{date}_{number}" → extract date and number
       - Check if TLDR exists in cache
       - Record: { type, date, number, dirName, tldrAvailable }
     Write array of MeetingIndexEntry to cache/meetings-index.json

loadCache():
  1. Check if cache/meta.json exists
     - If not: run fetchEipData() + buildCache() (auto-fetch)
  2. Read meta.json
  3. Check staleness: if last_updated > 7 days ago, print warning to stderr
  4. Return loaded indexes (lazy-load: only read index files when needed)
```

**Cache validation:**
- Store `forkcast_commit` in meta.json
- `forkcast update` compares this against latest commit from GitHub API

**Verify:** After build, `eips-index.json` has 544 entries. `context-index.json` has EIP number keys. `meetings-index.json` lists all meeting dirs with `tldrAvailable` booleans.

---

### WHI-60: Command `forkcast eip <number>`

**File:** `src/commands/eip.ts`

**Implementation:**
```
1. Parse argument: eip number (validate: positive integer)
2. Load cache (auto-fetch if missing)
3. Read cache/eips/{number}.json
   - If not found: error output { code: "EIP_NOT_FOUND" }, exit 1
4. If --context flag:
   - Read context-index.json
   - Look up eip number → get array of ContextEntry
   - Attach as "context" field in output
5. Wrap in OutputEnvelope
6. If --pretty: format as human-readable text
   - Title, status, description
   - Fork relationships table
   - If --context: list related meetings with dates and highlights
7. Print JSON to stdout (or pretty text)
```

**Flags:** `--context`, `--pretty`

**Verify:** `forkcast eip 7702` returns valid JSON envelope. `forkcast eip 7702 --context` includes meeting mentions. `forkcast eip 99999` returns EIP_NOT_FOUND error.

---

### WHI-61: Command `forkcast eips`

**File:** `src/commands/eips.ts`

**Implementation:**
```
1. Load cache (auto-fetch if missing)
2. Read eips-index.json
3. Apply filters in order:
   a. --fork: case-insensitive match on forks[].name
   b. --status: exact match on status field (EIP lifecycle)
   c. --inclusion: match on forks[].inclusion (fork inclusion status)
      Note: when --fork and --inclusion both specified, match the SAME forkRelationship entry
   d. --layer: match on layer field
      WARN: if layer filter used, add warning about 87% exclusion
4. Apply --limit if specified
5. Wrap in OutputEnvelope
6. If --pretty: format as table (id | title | status | forks)
7. Print
```

**Sparse data warning logic:**
```typescript
if (filters.layer) {
  const total = allEips.length;
  const withLayer = allEips.filter(e => e.layer !== null).length;
  const excluded = total - withLayer;
  envelope.warning = `Only ${withLayer} of ${total} EIPs have a layer field. ${excluded} EIPs were excluded from this filter.`;
}
```

**Flags:** `--fork <name>`, `--status <status>`, `--inclusion <status>`, `--layer <layer>`, `--limit <n>`, `--pretty`

**Verify:** `forkcast eips --fork glamsterdam` returns EIPs related to Glamsterdam. `forkcast eips --layer EL` returns ~69 results with a warning. `forkcast eips --fork glamsterdam --inclusion considered` returns the intersection.

---

### WHI-62: Command `forkcast meetings`

**File:** `src/commands/meetings.ts`

**Implementation:**
```
1. Load cache (auto-fetch if missing)
2. Read meetings-index.json
3. Apply filters:
   a. --type: exact match on type field
   b. --after: filter meetings with date >= value
   c. --last: sort by date descending, take first N
4. For each meeting in results:
   - If tldrAvailable and TLDR cached: include summary counts (highlights, decisions, action_items)
   - If tldrAvailable but not cached: fetch from GitHub Pages, cache, then include
   - If not tldrAvailable: include basic info only, mark tldr_available: false
5. Wrap in OutputEnvelope
6. If --pretty: format as table with date, type, number, key highlights
```

**Meeting types (all 18):**
acdc, acde, acdt, awd, bal, epbs, etm, fcr, focil, pqi, pqts, price, rpc, tli, zkevm, one-off-1954, one-off-1971, one-off-1985

**Flags:** `--type <type>`, `--after <date>`, `--last <n>`, `--pretty`

**Verify:** `forkcast meetings --type acde --last 3` returns 3 most recent ACDE meetings with TLDR summaries. Meetings without TLDRs show `tldr_available: false`.

---

### WHI-63: Command `forkcast forks`

**File:** `src/commands/forks.ts`

**Implementation:**
```
1. Load cache (auto-fetch if missing)
2. Read eips-index.json
3. Hardcoded fork definitions:
   - Pectra: status "Live", activated May 2025
   - Fusaka: status "Upcoming"
   - Glamsterdam: status "Planning"
   - Hegota: status "Research"
4. For each fork, count EIPs from eips-index:
   - Count by inclusion status (Proposed, Considered, Scheduled, Included, Declined)
5. Wrap in OutputEnvelope
6. If --pretty: format as table
```

**Source of truth for fork definitions:** `./references/forkcast/src/data/upgrades.ts`
This is a TypeScript module (cannot be JSON.parse'd). For Phase 1, hardcode the values.
Read the file to extract: name, status, activationDate, description.

**Flags:** `--pretty`

**Verify:** `forkcast forks` returns 4+ forks with correct EIP counts per inclusion status.

---

### WHI-64: Command `forkcast update`

**File:** `src/commands/update.ts`

**Implementation:**
```
1. Read meta.json (if exists)
2. GET https://api.github.com/repos/ethereum/forkcast/commits/main
   - If 403 (rate limited): warn "GitHub API rate limited. Try again later.", exit 0
   - If network error: warn and exit
3. Compare response SHA with meta.json.forkcast_commit
   - If same: "Already up to date (commit {sha}, last updated {time ago})"
   - If different or --force: run fetchEipData() + buildCache()
4. Report result in OutputEnvelope
```

**Flags:** `--force`

**Verify:** `forkcast update` checks and reports. `forkcast update --force` always refetches.

---

### Output formatting (shared)

**File:** `src/lib/output.ts`

Two output modes, controlled by `--pretty` flag (registered as global option in Commander.js):

1. **JSON mode (default):** `JSON.stringify(envelope, null, 2)` to stdout
2. **Pretty mode:** Human-readable tables and formatted text to stdout

Error output always goes to stderr. JSON error envelopes go to stdout for agent consumption.

Exit codes: 0 = success, 1 = user error, 2 = data error.

---

### CLI entry point

**File:** `src/index.ts`

```typescript
import { Command } from 'commander';

const program = new Command();

program
  .name('forkcast')
  .description('Ethereum governance data CLI for AI agents')
  .version('0.1.0');

program.option('--pretty', 'Human-readable output instead of JSON');

// Register subcommands
program.addCommand(eipCommand);
program.addCommand(eipsCommand);
program.addCommand(meetingsCommand);
program.addCommand(forksCommand);
program.addCommand(updateCommand);

program.parse();
```

---

## Phase 2: Cross-Source Enhancement (future, not for initial implementation)

### WHI-65: `forkcast search <term>`
- Full-text search across EIP descriptions + TLDR text
- Simple substring/regex match on cached data
- Results grouped by source type (eips, meetings)

### WHI-66: pm repo meeting notes
- Add tarball fetch for ethereum/pm repo
- Parse markdown meeting notes: extract headers, attendees, agenda
- Integrate into meetings-index and context-index

### WHI-67: `forkcast decisions`
- Filter TLDR decisions[] by fork name (regex match in decision text)
- Also incorporate `key_decisions.json` files from forkcast artifacts

---

## Phase 3: Temporal Queries + SQLite (future)

### WHI-68: SQLite storage
- Replace JSON file reads with better-sqlite3
- Schema: eips, fork_relationships, meetings, eip_mentions, decisions
- FTS5 virtual table for full-text search

### WHI-69: Temporal queries
- Requires switching from tarball to full git clone
- `git log --follow` for EIP file change history
- `forkcast eip 4844 --as-of 2023-03-15`: checkout historical version
- `forkcast timeline 7702`: structured chronology from git + meetings

---

## Dependency Graph

```
WHI-56 (project init)
  └── WHI-57 (type definitions)
        └── WHI-58 (data fetcher)
              └── WHI-59 (cache system)
                    ├── WHI-60 (forkcast eip)
                    ├── WHI-61 (forkcast eips)
                    ├── WHI-62 (forkcast meetings)
                    ├── WHI-63 (forkcast forks)
                    └── WHI-64 (forkcast update)

Phase 2 (all depend on Phase 1 completion):
  WHI-65 (search), WHI-66 (pm notes), WHI-67 (decisions)

Phase 3 (depends on Phase 2):
  WHI-68 (SQLite) → WHI-69 (temporal)
```

## Implementation Order (recommended for Codex)

Execute in this sequence. Each step produces a testable artifact.

1. **WHI-56** → project compiles, `forkcast --help` works
2. **WHI-57** → types defined, compile check
3. **WHI-58** → `forkcast update --force` fetches data to cache
4. **WHI-59** → cache indexes built, verifiable by reading JSON files
5. **WHI-60** → `forkcast eip 7702` returns real data
6. **WHI-61** → `forkcast eips --fork glamsterdam` returns filtered list
7. **WHI-62** → `forkcast meetings --type acde --last 3` returns TLDRs
8. **WHI-63** → `forkcast forks` returns fork summary
9. **WHI-64** → `forkcast update` checks for new data (refine after other commands work)

## Verification Checklist

After Phase 1 is complete, these commands should all produce valid JSON:

```bash
forkcast eip 7702                              # single EIP
forkcast eip 7702 --context                    # EIP + meeting mentions
forkcast eip 7702 --pretty                     # human-readable
forkcast eips --fork glamsterdam               # all Glamsterdam EIPs
forkcast eips --fork glamsterdam --inclusion considered  # filtered by inclusion
forkcast eips --status Final                   # all Final EIPs
forkcast eips --layer EL                       # EL EIPs (with warning)
forkcast meetings --type acde --last 5         # last 5 ACDE meetings
forkcast meetings --after 2026-01-01           # meetings since Jan 2026
forkcast forks                                 # all forks with EIP counts
forkcast forks --pretty                        # human-readable fork table
forkcast update                                # check for updates
forkcast update --force                        # force refetch
```

Each command should:
- Return valid JSON with the OutputEnvelope structure
- Include `source.forkcast_commit` and `source.last_updated`
- Auto-fetch data on first run if cache is empty
- Exit 0 on success, 1 on user error, 2 on data error
