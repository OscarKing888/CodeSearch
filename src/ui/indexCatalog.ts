import { IndexMeta } from '../index/types';
import { canonicalPathKey } from '../index/sharedIndexStorage';

/**
 * Builds the management-panel catalog with active services taking precedence.
 *
 * Another window may remove an entry from the shared per-editor registry while
 * this process still has the database open. Keeping active entries in this
 * union ensures the panel can still show and close those services. Deduplicate
 * by both registry id and physical database path so a stale/duplicate catalog
 * row cannot create a second card for an active database.
 */
export function mergeIndexCatalog(
  registryIndexes: readonly IndexMeta[],
  activeIndexes: readonly IndexMeta[]
): IndexMeta[] {
  const merged: IndexMeta[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  const append = (meta: IndexMeta): void => {
    const pathKey = canonicalPathKey(meta.dbPath);
    if (seenIds.has(meta.id) || seenPaths.has(pathKey)) {
      return;
    }
    seenIds.add(meta.id);
    seenPaths.add(pathKey);
    merged.push(meta);
  };

  for (const meta of activeIndexes) {
    append(meta);
  }
  for (const meta of registryIndexes) {
    append(meta);
  }
  return merged;
}
