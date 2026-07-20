import * as fs from 'fs';
import { IndexMeta } from './types';
import { canonicalPathKey } from './sharedIndexStorage';
import { sameWorkspaceRoots } from './workspaceRoots';
import {
  findExistingRegistries,
  loadRegistryIndexes,
} from '../mcp/discover';

export interface IndexRegistrySnapshot {
  source: string;
  path: string;
  indexes: IndexMeta[];
}

export interface WorkspaceIndexCandidate {
  key: string;
  meta: IndexMeta;
  sources: string[];
  exactRoots: boolean;
  legacyHashMatch: boolean;
  exists: boolean;
}

export function collectWorkspaceIndexCandidates(
  snapshots: readonly IndexRegistrySnapshot[],
  workspaceRoots: readonly string[],
  workspaceHash: string
): WorkspaceIndexCandidate[] {
  const byPath = new Map<string, WorkspaceIndexCandidate>();

  for (const snapshot of snapshots) {
    for (const meta of snapshot.indexes) {
      if (!meta || typeof meta.dbPath !== 'string' || !meta.dbPath.trim()) {
        continue;
      }
      const exactRoots = sameWorkspaceRoots(meta.rootDirs ?? [], workspaceRoots);
      const legacyHashMatch = (meta.workspaceHashes ?? []).includes(workspaceHash);
      if (!exactRoots && !legacyHashMatch) {
        continue;
      }

      const key = canonicalPathKey(meta.dbPath);
      const existing = byPath.get(key);
      if (existing) {
        if (!existing.sources.includes(snapshot.source)) {
          existing.sources.push(snapshot.source);
        }
        existing.exactRoots = existing.exactRoots || exactRoots;
        existing.legacyHashMatch = existing.legacyHashMatch || legacyHashMatch;
        if (meta.updatedAt > existing.meta.updatedAt) {
          existing.meta = meta;
        }
        continue;
      }

      byPath.set(key, {
        key,
        meta,
        sources: [snapshot.source],
        exactRoots,
        legacyHashMatch,
        exists: fs.existsSync(meta.dbPath),
      });
    }
  }

  return Array.from(byPath.values()).sort((left, right) => {
    if (left.exists !== right.exists) {
      return left.exists ? -1 : 1;
    }
    if (left.exactRoots !== right.exactRoots) {
      return left.exactRoots ? -1 : 1;
    }
    return right.meta.updatedAt - left.meta.updatedAt;
  });
}

export async function discoverWorkspaceIndexCandidates(
  workspaceRoots: readonly string[],
  workspaceHash: string,
  localRegistry?: IndexRegistrySnapshot
): Promise<WorkspaceIndexCandidate[]> {
  const snapshots: IndexRegistrySnapshot[] = localRegistry ? [localRegistry] : [];
  const found = await findExistingRegistries();
  for (const registry of found) {
    if (localRegistry && canonicalPathKey(registry.path) === canonicalPathKey(localRegistry.path)) {
      continue;
    }
    try {
      snapshots.push({
        source: registry.source,
        path: registry.path,
        indexes: await loadRegistryIndexes(registry.path),
      });
    } catch {
      // A peer IDE may be replacing its registry while discovery runs. Keep
      // the healthy candidates and let a later refresh retry this source.
    }
  }
  return collectWorkspaceIndexCandidates(snapshots, workspaceRoots, workspaceHash);
}
