/**
 * Git history module for temporal queries (WHI-69).
 *
 * Manages a full clone of the ethereum/forkcast repo at
 * `{cacheRoot}/repo/forkcast/` and exposes typed wrappers around the git
 * operations needed for time-travel queries:
 *
 *  - ensureRepo()  — clone or pull the repo
 *  - getEipAtCommit() — read an EIP file at a specific commit
 *  - getEipHistory() — list commits that touched an EIP file
 *  - findCommitBefore() — find the newest commit before a given date
 *  - getStatusChanges() — extract status change events from the commit list
 */

import { execFile as execFileCb } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Eip, EipHistoryEntry, TimelineEntry } from "../types/index.js";

const execFile = promisify(execFileCb);

const FORKCAST_REPO_URL = "https://github.com/ethereum/forkcast.git";
const CLONE_TIMEOUT_MS = 120_000;  // 2 minutes for initial clone
const GIT_TIMEOUT_MS = 30_000;     // 30 s for log/show/diff

// EIP file path within the repo.
const EIP_PATH_PREFIX = "src/data/eips/";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the path to the forkcast git clone.
 * Layout: `{cacheRoot}/repo/forkcast/`
 */
export function getRepoDirPath(cacheRoot?: string): string {
  const root = cacheRoot ?? (process.env.FORKCAST_CACHE ?? path.join(os.homedir(), ".forkcast"));
  return path.join(root, "repo", "forkcast");
}

function eipFilePath(eipId: number): string {
  return `${EIP_PATH_PREFIX}${eipId}.json`;
}

/**
 * Run a git command inside the clone directory.
 * Throws a descriptive error on failure.
 */
async function runGit(
  repoDir: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string> {
  try {
    const { stdout } = await execFile("git", args, {
      cwd: repoDir,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024, // 16 MB — large for `git show` of many EIPs
    });
    return stdout;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      throw new GitHistoryError(
        "git is not installed. Temporal queries require git.",
        "GIT_NOT_FOUND",
      );
    }
    const msg = error instanceof Error ? error.message : String(error);
    throw new GitHistoryError(`git ${args[0]} failed: ${msg}`, "GIT_COMMAND_FAILED", { cause: error });
  }
}

/**
 * Check whether git is available on $PATH.
 * Returns true if `git --version` exits successfully.
 */
export async function isGitAvailable(): Promise<boolean> {
  try {
    await execFile("git", ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether the repo directory exists and contains a git repo.
 */
export async function repoExists(repoDir: string): Promise<boolean> {
  try {
    await fsp.stat(path.join(repoDir, ".git"));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type GitHistoryErrorCode =
  | "GIT_NOT_FOUND"
  | "GIT_COMMAND_FAILED"
  | "REPO_NOT_FOUND"
  | "EIP_NOT_FOUND_IN_HISTORY"
  | "INVALID_DATE";

export class GitHistoryError extends Error {
  code: GitHistoryErrorCode;

  constructor(message: string, code: GitHistoryErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHistoryError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the forkcast repo is cloned and up to date.
 *
 * - If the repo does not exist, performs a full clone.
 * - If the repo already exists, runs `git pull`.
 *
 * Progress lines are written to `stderr` if provided.
 */
export async function ensureRepo(
  repoDir: string,
  options: { stderr?: NodeJS.WritableStream | { write(s: string): boolean }; skipPull?: boolean } = {},
): Promise<void> {
  const { stderr, skipPull = false } = options;

  if (!(await isGitAvailable())) {
    throw new GitHistoryError(
      "git is not installed. Temporal queries require git.",
      "GIT_NOT_FOUND",
    );
  }

  if (!(await repoExists(repoDir))) {
    stderr?.write(`Cloning forkcast repo to ${repoDir}…\n`);
    await fsp.mkdir(path.dirname(repoDir), { recursive: true });

    // Clone into the parent directory as <name> to get the right path
    const parentDir = path.dirname(repoDir);
    const repoName = path.basename(repoDir);

    try {
      await execFile("git", [
        "clone",
        "--filter=blob:none",  // partial clone — fetch blobs on demand
        FORKCAST_REPO_URL,
        repoName,
      ], {
        cwd: parentDir,
        timeout: CLONE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
        throw new GitHistoryError(
          "git is not installed. Temporal queries require git.",
          "GIT_NOT_FOUND",
        );
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw new GitHistoryError(`Failed to clone forkcast repo: ${msg}`, "GIT_COMMAND_FAILED", { cause: error });
    }

    stderr?.write("Clone complete.\n");
    return;
  }

  if (!skipPull) {
    stderr?.write("Updating forkcast repo…\n");
    try {
      await runGit(repoDir, ["pull", "--ff-only", "--quiet"], CLONE_TIMEOUT_MS);
      stderr?.write("Repo updated.\n");
    } catch (error) {
      // Pull errors are non-fatal (offline scenarios) — warn but continue
      const msg = error instanceof Error ? error.message : String(error);
      stderr?.write(`Warning: git pull failed (will use existing clone): ${msg}\n`);
    }
  }
}

/**
 * Parse an ISO date string or partial date (e.g. "2024-01") into a full ISO
 * string suitable for `--until` / `--after` git log flags.
 *
 * Accepts: "2023-03-15", "2024-01", "2024", "2023-03-15T10:20:30Z"
 * Returns: the input string (git accepts all ISO-8601 partial dates natively).
 */
export function normalizeDate(dateStr: string): string {
  if (!/^\d{4}(-\d{2}(-\d{2}(T[\dZ:.+-]+)?)?)?$/.test(dateStr)) {
    throw new GitHistoryError(
      `Invalid date format "${dateStr}". Expected ISO date like "2023-03-15" or "2024-01".`,
      "INVALID_DATE",
    );
  }
  // Validate calendar bounds for YYYY-MM partial dates.
  if (/^\d{4}-\d{2}$/.test(dateStr)) {
    const month = Number(dateStr.slice(5, 7));
    if (month < 1 || month > 12) {
      throw new GitHistoryError(
        `Invalid month in "${dateStr}".`,
        "INVALID_DATE",
      );
    }
  }
  // Validate calendar bounds for full YYYY-MM-DD dates.
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) && isNaN(Date.parse(dateStr))) {
    throw new GitHistoryError(
      `Invalid calendar date "${dateStr}".`,
      "INVALID_DATE",
    );
  }
  return dateStr;
}

/**
 * Find the commit SHA of the most recent commit on or before `date` for the
 * given EIP file.  Returns `null` if no commit exists before that date.
 */
export async function findCommitBefore(
  repoDir: string,
  eipId: number,
  date: string,
): Promise<string | null> {
  const filePath = eipFilePath(eipId);
  const output = await runGit(repoDir, [
    "log",
    "--follow",
    `--until=${date}`,
    "-1",
    "--format=%H",
    "--",
    filePath,
  ]);
  const sha = output.trim();
  return sha.length === 40 ? sha : null;
}

/**
 * Find the commit SHA of the most recent commit on or before `date` for the
 * entire repo (not limited to a specific EIP file).
 * Returns `null` if the repo has no commits before that date.
 */
export async function findRepoCommitBefore(
  repoDir: string,
  date: string,
): Promise<string | null> {
  const output = await runGit(repoDir, [
    "log",
    `--until=${date}`,
    "-1",
    "--format=%H",
  ]);
  const sha = output.trim();
  return sha.length === 40 ? sha : null;
}

/**
 * Read the contents of an EIP JSON file at a specific commit.
 * Returns `null` when the file did not exist at that commit.
 */
export async function getEipAtCommit(
  repoDir: string,
  eipId: number,
  commit: string,
): Promise<Eip | null> {
  const filePath = eipFilePath(eipId);
  let raw: string;
  try {
    raw = await runGit(repoDir, ["show", `${commit}:${filePath}`]);
  } catch (error) {
    // git exits non-zero when the path doesn't exist at that rev
    if (error instanceof GitHistoryError && /exists on disk|does not exist|unknown revision/.test(error.message)) {
      return null;
    }
    // "fatal: Path ... does not exist in ..." — treat as not found
    if (error instanceof GitHistoryError && /Path .* does not exist/.test(error.message)) {
      return null;
    }
    throw error;
  }
  try {
    return JSON.parse(raw) as Eip;
  } catch {
    return null;
  }
}

/**
 * List all EIP JSON file paths that exist at a given commit.
 * Returns file paths relative to the repo root (e.g. "src/data/eips/7702.json").
 */
export async function listEipFilesAtCommit(
  repoDir: string,
  commit: string,
): Promise<string[]> {
  const output = await runGit(repoDir, [
    "ls-tree",
    "--name-only",
    commit,
    `${EIP_PATH_PREFIX}`,
  ]);

  return output.trim().split("\n").filter((f) => f.endsWith(".json"));
}

/**
 * Retrieve the full commit history for a specific EIP file.
 * Returns entries in reverse-chronological order (newest first).
 *
 * Each entry includes the commit SHA, ISO date, author, and commit message.
 * When `limit` is specified, only the most recent N commits are returned.
 */
export async function getEipHistory(
  repoDir: string,
  eipId: number,
  options: { limit?: number } = {},
): Promise<EipHistoryEntry[]> {
  const filePath = eipFilePath(eipId);

  const formatArgs = [
    "--format=%H%n%aI%n%an%n%s%n---FORKCAST_SEP---",
  ];

  if (options.limit !== undefined) {
    formatArgs.push(`-${options.limit}`);
  }

  let output: string;
  try {
    output = await runGit(repoDir, [
      "log",
      "--follow",
      ...formatArgs,
      "--",
      filePath,
    ]);
  } catch {
    return [];
  }

  return parseGitLogOutput(output);
}

/**
 * Parse the output of `git log --format=%H%n%aI%n%an%n%s%n---FORKCAST_SEP---`.
 */
function parseGitLogOutput(raw: string): EipHistoryEntry[] {
  const separator = "---FORKCAST_SEP---";
  const blocks = raw.split(separator).map((b) => b.trim()).filter(Boolean);

  const entries: EipHistoryEntry[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const commit = lines[0]?.trim() ?? "";
    const date = lines[1]?.trim() ?? "";
    const author = lines[2]?.trim() ?? "";
    const message = lines[3]?.trim() ?? "";

    if (commit.length !== 40) continue;

    entries.push({ commit, date, author, message });
  }

  return entries;
}

/**
 * Build a diff summary between two consecutive EIP versions.
 * Compares fork relationship statuses and the lifecycle status field.
 * Returns a short human-readable string.
 */
export function buildDiffSummary(before: Eip | null, after: Eip | null): string {
  if (!before && after) return "EIP file created";
  if (before && !after) return "EIP file deleted";
  if (!before || !after) return "Unknown change";

  const changes: string[] = [];

  // Lifecycle status
  if (before.status !== after.status) {
    changes.push(`status ${before.status} → ${after.status}`);
  }

  // Fork relationship changes
  const beforeForks = new Map(
    before.forkRelationships.map((r) => [r.forkName, r.statusHistory.at(-1)?.status]),
  );
  const afterForks = new Map(
    after.forkRelationships.map((r) => [r.forkName, r.statusHistory.at(-1)?.status]),
  );

  const allForks = new Set([...beforeForks.keys(), ...afterForks.keys()]);
  for (const fork of allForks) {
    const bStatus = beforeForks.get(fork);
    const aStatus = afterForks.get(fork);
    if (!beforeForks.has(fork)) {
      changes.push(`added to ${fork} (${aStatus})`);
    } else if (!afterForks.has(fork)) {
      changes.push(`removed from ${fork}`);
    } else if (bStatus !== aStatus) {
      changes.push(`${fork}: ${bStatus} → ${aStatus}`);
    }
  }

  if (changes.length === 0) {
    // Title or other metadata changed
    if (before.title !== after.title) {
      changes.push(`title updated`);
    } else {
      changes.push("metadata updated");
    }
  }

  return changes.join("; ");
}

/**
 * Build timeline entries from EIP git history, detecting status changes
 * between consecutive commits.
 *
 * Returns entries sorted ascending by date.
 */
export async function buildTimelineFromHistory(
  repoDir: string,
  eipId: number,
  historyEntries: EipHistoryEntry[],
): Promise<TimelineEntry[]> {
  if (historyEntries.length === 0) return [];

  // Read the EIP at each commit (in parallel, bounded)
  const commits = historyEntries.map((e) => e.commit);
  const snapshots = new Map<string, Eip | null>();

  const batchSize = 5;
  for (let i = 0; i < commits.length; i += batchSize) {
    const batch = commits.slice(i, i + batchSize);
    await Promise.all(batch.map(async (sha) => {
      snapshots.set(sha, await getEipAtCommit(repoDir, eipId, sha));
    }));
  }

  // Build timeline entries in chronological order (history is newest-first)
  const sorted = [...historyEntries].reverse();
  const timeline: TimelineEntry[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i]!;
    const current = snapshots.get(entry.commit);
    const previous = i > 0 ? snapshots.get(sorted[i - 1]!.commit) : null;

    // Always add a git_commit entry
    timeline.push({
      date: entry.date,
      type: "git_commit",
      commit: entry.commit,
      author: entry.author,
      message: entry.message,
    });

    // Detect status changes and add dedicated status_change entries
    if (previous && current) {
      if (previous.status !== current.status) {
        timeline.push({
          date: entry.date,
          type: "status_change",
          fromStatus: previous.status,
          toStatus: current.status,
        });
      }

      // Detect per-fork status changes
      const prevForks = new Map(
        previous.forkRelationships.map((r) => [r.forkName, r.statusHistory.at(-1)?.status]),
      );
      for (const rel of current.forkRelationships) {
        const latestStatus = rel.statusHistory.at(-1)?.status;
        const prevStatus = prevForks.get(rel.forkName);
        if (prevStatus !== undefined && prevStatus !== latestStatus && latestStatus) {
          timeline.push({
            date: entry.date,
            type: "status_change",
            fromStatus: prevStatus,
            toStatus: latestStatus,
            fork: rel.forkName,
          });
        }
      }
    }

  }

  return timeline;
}
