# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Forkcast CLI — a TypeScript command-line tool that fetches Ethereum governance data (EIPs, meeting TLDRs, hardfork tracking) from the ethereum/forkcast GitHub repo and exposes it as structured JSON for AI agent consumption. No git dependency at runtime. Data is fetched via GitHub tarball + GitHub Pages and cached locally.

## Git Workflow

- **`main`** — release/deploy only, not for daily development
- **`dev`** — primary development branch, all feature work branches from here
- Every development task MUST use a git worktree branched from `dev`
- Branch naming: `<type>/WHI-<N>-<short-desc>` where type is `feat`, `fix`, or `chore` (e.g., `feat/WHI-58-data-fetcher`, `fix/WHI-60-eip-lookup`)
- Development happens in the feature worktree first, then the user performs peer review
- Do NOT merge a phase back to `dev` until the user explicitly says the review is finished and there are no remaining issues
- When task is complete and review is approved, commit the feature branch, then merge back to `dev` using **merge commit** (no squash, no rebase)
- After merge, clean up the worktree and its branch

### Worktree Lifecycle

```
1. git worktree add .worktrees/<name> -b <type>/WHI-<N>-<name> dev
2. Work in .worktrees/<name>/
3. Implement and verify in the feature worktree
4. Wait for user peer review and address review feedback there
5. After user approval, commit with message: "feat(WHI-<N>): description"
6. Verify build passes: npm run build
7. git checkout dev && git merge --no-ff <type>/WHI-<N>-<name>
8. git worktree remove .worktrees/<name>
9. git branch -d <type>/WHI-<N>-<name>
```

### Task Transition

When the user says "继续下一个任务" or similar, follow this sequence before starting the next task:

1. Ensure the current task has passed peer review and the user has explicitly approved merge/cleanup
2. Ensure all changes are committed on the current feature branch
3. Switch to `dev`: `cd <project-root> && git checkout dev`
4. Merge the feature branch: `git merge --no-ff <current-branch>`
5. Remove the worktree: `git worktree remove .worktrees/<name>`
6. Delete the feature branch: `git branch -d <type>/WHI-<N>-<name>`
7. **Update Linear**: move the completed issue to `Done` state (see Linear Workflow below)
8. Create a new worktree for the next task (per Worktree Lifecycle above)
9. **Update Linear**: move the next issue to `In Progress` state

## Linear Workflow

Project: "Forkcast CLI" (ID: `82b016da-30e7-49ec-ad71-1895bd4a366c`)
Team: Whisker-Personal (ID: `37abcce9-0070-470b-a57b-d8213047c418`)

### Issue State Transitions

```
Backlog ──► Todo ──► In Progress ──► In Review ──► Done
```

- **Starting a task**: move issue + its sub-issues to `In Progress`
- **Submitting for review**: move issue to `In Review`
- **Review approved + merged**: move issue to `Done`
- **Review has feedback**: keep in `In Review`, address feedback, re-submit

### State IDs (for API calls)

```
Backlog:     c273e428-65d4-41a3-9b8c-479a65b79a46
Todo:        aea138f7-93e2-4d7a-a6eb-c80b20d831ad
In Progress: b65f8992-0241-4dd0-b08f-24cd19a51750
In Review:   d103adf2-dbe4-4875-9873-e8a44a288c15
Done:        f92b8ffe-b750-4d4f-9d5b-4883a158d5af
```

### Mandatory Linear Updates

1. **Before starting implementation**: move the parent issue and all its sub-issues to `In Progress`
2. **As each sub-issue is completed**: move that sub-issue to `Done`
3. **When implementation is done, before requesting review**: move the parent issue to `In Review`
4. **After review is approved and code is merged to dev**: move the parent issue to `Done`
5. **If blocked**: add a comment on the Linear issue explaining what's blocking

### Issue Dependencies

Issues have `blocks` relations set in Linear. Respect the dependency order:

```
WHI-56 (project init) ──► WHI-57 (type definitions)
WHI-57 ──► WHI-58 (data fetcher)
WHI-58 ──► WHI-59 (cache system)
WHI-59 ──► WHI-60 (forkcast eip)
WHI-59 ──► WHI-61 (forkcast eips)
WHI-59 ──► WHI-62 (forkcast meetings)
WHI-59 ──► WHI-63 (forkcast forks)
WHI-58 + WHI-59 ──► WHI-64 (forkcast update)
```

Do NOT start a blocked issue until its blocker is `Done`.

## Build & Development Commands

All commands run from a worktree root:

```bash
npm run build          # TypeScript compile to dist/
npm run dev            # tsc --watch
./bin/forkcast --help  # run locally after build
npm link               # install globally for development
```

## Architecture

ESM project (`"type": "module"`). Node.js >= 20. TypeScript strict mode.

```
src/
  index.ts          # CLI entry point, Commander.js program definition
  commands/         # One file per subcommand (eip.ts, eips.ts, meetings.ts, forks.ts, update.ts)
  lib/
    fetcher.ts      # Downloads EIP data from GitHub tarball, TLDRs from GitHub Pages
    cache.ts        # Builds and reads precomputed indexes (eips-index, context-index, meetings-index)
    output.ts       # Output envelope wrapper, --pretty formatting, error formatting
  types/
    index.ts        # All TypeScript interfaces (Eip, MeetingTldr, OutputEnvelope, etc.)
```

**Data flow:** User runs command → cache.ts checks for local data → if missing, fetcher.ts auto-fetches → command reads from cache indexes → output.ts wraps in envelope → stdout.

**Cache structure at `~/.forkcast/cache/`:**
- `eips/` — 544 individual EIP JSON files (from GitHub tarball extraction)
- `tldrs/` — meeting TLDR JSONs (fetched from GitHub Pages on demand)
- `eips-index.json` — precomputed metadata for fast `forkcast eips` filtering
- `context-index.json` — precomputed EIP-to-meeting cross-references (built at cache time via regex scan)
- `meetings-index.json` — all meeting dirs with dates, types, tldr availability
- `meta.json` — commit SHA, last_updated timestamp, schema version

## Key Technical Details

- **Node.js version:** >= 20
- **Module system:** ESM (`"type": "module"`, tsconfig target `ES2022`, module `Node16`)
- **Runtime dependencies:** `commander`, `tar`. Everything else uses Node built-ins (`node:fs`, `node:path`, `node:https`, `node:zlib`)
- **Cache directory:** `FORKCAST_CACHE` env var or `~/.forkcast/`
- **Commit messages:** reference Linear issues: `feat(WHI-58): implement data fetcher`

## Critical Domain Knowledge

**Two status taxonomies (do NOT conflate):**
1. `--status`: EIP lifecycle status (top-level `status` field): Draft, Review, Last Call, Final, Stagnant, Withdrawn, Living
2. `--inclusion`: Fork inclusion status (inside `forkRelationships[].statusHistory[].status`): Proposed, Considered, Scheduled, Included, Declined

**EIP schema sparsity:** Only 13% of EIPs have `layer` field, 22% have `laymanDescription`, 18% have `stakeholderImpacts`. Missing fields should be `null` in output. When filtering on sparse fields, include a `warning` in the output envelope.

**Meeting TLDR structure:** Highlights are grouped by topic category (a `Record<string, array>`), NOT a flat array. The field is `highlight` not `summary`. Action items have `action`/`owner` (no `deadline`). Only ~112 of ~156 meetings have TLDRs.

**18 meeting artifact types:** acdc, acde, acdt, awd, bal, epbs, etm, fcr, focil, pqi, pqts, price, rpc, tli, zkevm, one-off-1954, one-off-1971, one-off-1985

## Data Sources

- **EIP JSONs:** Downloaded via GitHub tarball from `github.com/ethereum/forkcast/archive/main.tar.gz`, extracting only `src/data/eips/`
- **Meeting TLDRs:** Fetched directly from GitHub Pages at `ethereum.github.io/forkcast/artifacts/{type}/{date}_{number}/tldr.json` (no rate limits, no auth)
- **Commit SHA:** `api.github.com/repos/ethereum/forkcast/commits/main` (1 request, no auth)

## Output Contract

Every command wraps results in `OutputEnvelope`:
```json
{
  "query": { "command": "eips", "filters": { "fork": "glamsterdam" } },
  "results": [...],
  "count": 42,
  "source": { "forkcast_commit": "abc1234", "last_updated": "2026-04-12T15:30:00Z" },
  "warning": "optional sparse data warning"
}
```
Errors: `{ "error": "message", "code": "ERROR_CODE" }`. Exit codes: 0=success, 1=user error, 2=data error.

## Reference Data

`./references/forkcast/` and `./references/pm/` contain synced copies of the upstream repos for schema validation during development. Use these to verify type definitions match real data:
- `references/forkcast/src/data/eips/7702.json` — representative EIP
- `references/forkcast/public/artifacts/acde/2026-04-09_234/tldr.json` — representative TLDR
- `references/forkcast/src/data/upgrades.ts` — fork definitions (TypeScript, cannot JSON.parse)

## Implementation Plan

See `IMPLEMENTATION_PLAN.md` for the full phased plan with Linear issue references (WHI-56 through WHI-69).

### Phases

- **Phase 0**: Project setup (WHI-56, WHI-57)
- **Phase 1**: Core MVP — data fetcher, cache, 4 commands + update (WHI-58 ~ WHI-64)
- **Phase 2**: Cross-source enhancement — search, pm notes, decisions (WHI-65 ~ WHI-67)
- **Phase 3**: Temporal queries + SQLite (WHI-68, WHI-69)
