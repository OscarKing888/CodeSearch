import * as path from 'path';

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
