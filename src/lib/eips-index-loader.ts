import fsp from "node:fs/promises";
import { loadCache } from "./cache.js";
import { CommandError } from "./errors.js";
import { getCacheLayout, type WritableLike } from "./fetcher.js";
import type { EipIndexEntry } from "../types/index.js";

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface EipsIndexLoaderDependencies {
  loadCache: typeof loadCache;
  stderr: WritableLike;
}

// ---------------------------------------------------------------------------
// Index validation
// ---------------------------------------------------------------------------

/**
 * Validate that the parsed eips-index.json has the expected shape.
 * The file is cached on disk and could be schema-skewed (e.g. an old write
 * produced an object instead of an array, or individual entries are missing
 * required fields).  Throws DATA_ERROR so the caller can treat it the same
 * way as a corrupt/missing cache.
 */
export function validateEipsIndex(raw: unknown): EipIndexEntry[] {
  if (!Array.isArray(raw)) {
    throw new CommandError(
      "eips-index.json has an unexpected shape (expected an array)",
      "DATA_ERROR",
    );
  }

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (
      entry === null
      || typeof entry !== "object"
      || typeof (entry as Record<string, unknown>).id !== "number"
      || typeof (entry as Record<string, unknown>).status !== "string"
      || !Array.isArray((entry as Record<string, unknown>).forks)
    ) {
      throw new CommandError(
        `eips-index.json entry at index ${i} is missing required fields (id, status, forks)`,
        "DATA_ERROR",
      );
    }
  }

  return raw as EipIndexEntry[];
}

// ---------------------------------------------------------------------------
// Cache loading (with self-healing retry)
// ---------------------------------------------------------------------------

/**
 * Load the cache and read + validate the EIP index, with one self-healing
 * retry.  If the cache appears to exist but is actually broken (e.g. empty
 * eips/ dir, or schema-skewed index file), we delete the cache directory and
 * let loadCache start from scratch via a fresh auto-fetch.
 */
export async function loadEipsIndex(
  cacheRoot: string,
  deps: EipsIndexLoaderDependencies,
): Promise<{ loaded: Awaited<ReturnType<typeof loadCache>>; allEntries: EipIndexEntry[] }> {
  const tryLoad = async () => {
    const loaded = await deps.loadCache({ cacheRoot, stderr: deps.stderr });
    const raw = await loaded.readEipsIndex();
    const allEntries = validateEipsIndex(raw);
    return { loaded, allEntries };
  };

  try {
    return await tryLoad();
  } catch (error) {
    // Only self-heal on cache/data errors — not on user input errors or
    // unrelated failures.
    const code = error instanceof CommandError
      ? error.code
      : (error && typeof error === "object" && "code" in error
        ? (error as { code: unknown }).code
        : undefined);

    if (code !== "NOT_CACHED" && code !== "DATA_ERROR") {
      throw error;
    }

    // The raw cache appears to exist but is corrupt or incomplete.  Delete the
    // cache directory so the next loadCache call sees an empty state and
    // triggers a fresh auto-fetch.
    const cacheDir = getCacheLayout(cacheRoot).cacheDir;
    try {
      await fsp.rm(cacheDir, { force: true, recursive: true });
    } catch {
      // Deletion is best-effort.  If it fails, tryLoad will re-throw the
      // original error on the next attempt, giving the user an actionable
      // message rather than a silent hang.
    }

    return await tryLoad();
  }
}
