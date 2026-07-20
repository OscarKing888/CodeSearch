import * as fs from 'fs';
import { IndexRegistry } from './IndexRegistry';
import { canonicalPathKey } from './sharedIndexStorage';
import { IndexMeta } from './types';

export interface WorkspaceIndexPresence {
  exists: boolean;
  dbPath: string;
  meta?: IndexMeta;
}

export async function findExistingWorkspaceIndexes(
  workspaceHash: string,
  expectedDbPath: string,
  registry: IndexRegistry,
  fallbackDbPaths: readonly string[] = []
): Promise<WorkspaceIndexPresence[]> {
  const registryMeta = registry.getByWorkspaceHash(workspaceHash);
  const candidates = registryMeta
    ? [registryMeta.dbPath, ...fallbackDbPaths, expectedDbPath]
    : [...fallbackDbPaths, expectedDbPath];
  const seen = new Set<string>();
  const existing: WorkspaceIndexPresence[] = [];

  for (const dbPath of candidates) {
    const key = canonicalPathKey(dbPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    try {
      await fs.promises.access(dbPath, fs.constants.R_OK);
      existing.push({
        exists: true,
        dbPath,
        meta: registry.getByDbPath(dbPath),
      });
    } catch {
      // A stale legacy registry entry must not hide the deterministic shared
      // database created by another IDE.
    }
  }

  return existing;
}

export async function hasWorkspaceIndex(
  workspaceHash: string,
  expectedDbPath: string,
  registry: IndexRegistry
): Promise<WorkspaceIndexPresence> {
  const existing = await findExistingWorkspaceIndexes(
    workspaceHash,
    expectedDbPath,
    registry
  );
  return existing[0] ?? { exists: false, dbPath: expectedDbPath };
}
