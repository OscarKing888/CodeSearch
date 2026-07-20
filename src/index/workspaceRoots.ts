import * as path from 'path';
import { canonicalPathKey } from './sharedIndexStorage';

function isStrictSubpath(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  if (resolvedParent === resolvedChild) {
    return false;
  }
  const rel = path.relative(resolvedParent, resolvedChild);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Remove workspace roots that are strict parents of another root (avoids duplicate scanning). */
export function pruneNestedRoots(roots: string[]): string[] {
  const resolved = roots.map((r) => path.resolve(r));
  return resolved.filter(
    (root) => !resolved.some((other) => other !== root && isStrictSubpath(root, other))
  );
}

export function sameWorkspaceRoots(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftKeys = left.map((root) => canonicalPathKey(root)).sort();
  const rightKeys = right.map((root) => canonicalPathKey(root)).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}
