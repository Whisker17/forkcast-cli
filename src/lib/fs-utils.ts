/**
 * Shared filesystem utilities used by both cache.ts and db.ts.
 */

import fsp from "node:fs/promises";
import path from "node:path";

export function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}

export async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir);
    return entries.filter((e) => e.endsWith(".json")).sort();
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      return [];
    }
    throw error;
  }
}

export async function walkJsonFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      return [];
    }
    throw error;
  }

  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walkJsonFiles(entryPath);
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      return [entryPath];
    }
    return [];
  }));

  return files.flat().sort();
}
