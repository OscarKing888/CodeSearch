import {
  ClassHierarchy,
  ClassHierarchyNode,
} from './classHierarchy';

export type ClassHierarchyNodeLimit = number | 'all';

export interface ClassHierarchyQueryLocation {
  path: string;
  localPath: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface ClassHierarchyQueryNode {
  id: string;
  name: string;
  qualifiedName: string;
  kind?: 'class' | 'struct';
  external: boolean;
  baseIds: string[];
  derivedIds: string[];
  path?: string;
  localPath?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface ClassHierarchyQueryCandidate {
  id: string;
  name: string;
  qualifiedName: string;
  kind?: 'class' | 'struct';
  external: boolean;
  path?: string;
  localPath?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export type ClassHierarchyQueryResult =
  | {
      ok: true;
      rootId: string;
      totalNodeCount: number;
      returnedNodeCount: number;
      truncated: boolean;
      nodes: ClassHierarchyQueryNode[];
    }
  | {
      ok: false;
      error: 'not_found' | 'ambiguous_class';
      candidates: ClassHierarchyQueryCandidate[];
    };

export function queryClassHierarchy(
  hierarchy: ClassHierarchy,
  className: string,
  maxNodes: ClassHierarchyNodeLimit,
  mapPath: (indexedPath: string) => string
): ClassHierarchyQueryResult {
  const rawQuery = className.trim();
  const query = normalizeClassName(rawQuery);
  const qualifiedQuery = rawQuery.startsWith('::') || rawQuery.includes('::');
  const matches = qualifiedQuery
    ? hierarchy.nodes.filter(
        (node) => normalizeClassName(node.qualifiedName) === query
      )
    : hierarchy.nodes.filter((node) => node.name === query);

  if (matches.length === 0) {
    return { ok: false, error: 'not_found', candidates: [] };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: 'ambiguous_class',
      candidates: matches
        .map((node) => toCandidate(node, mapPath))
        .sort(compareCandidates),
    };
  }

  const root = matches[0];
  const nodesById = new Map(hierarchy.nodes.map((node) => [node.id, node]));
  const reachable: ClassHierarchyNode[] = [];
  const visited = new Set<string>();
  const pending = [root.id];
  let offset = 0;
  while (offset < pending.length) {
    const id = pending[offset++];
    if (visited.has(id)) {
      continue;
    }
    visited.add(id);
    const node = nodesById.get(id);
    if (!node) {
      continue;
    }
    reachable.push(node);
    for (const derivedId of node.derivedIds) {
      pending.push(derivedId);
    }
  }

  const returned = maxNodes === 'all'
    ? reachable
    : reachable.slice(0, maxNodes);
  const returnedIds = new Set(returned.map((node) => node.id));
  return {
    ok: true,
    rootId: root.id,
    totalNodeCount: reachable.length,
    returnedNodeCount: returned.length,
    truncated: returned.length < reachable.length,
    nodes: returned.map((node) => {
      const location = toLocation(node, mapPath);
      return {
        id: node.id,
        name: node.name,
        qualifiedName: node.qualifiedName,
        kind: node.kind,
        external: node.external,
        baseIds: node.baseIds.filter((id) => returnedIds.has(id)),
        derivedIds: node.derivedIds.filter((id) => returnedIds.has(id)),
        ...location,
      };
    }),
  };
}

function normalizeClassName(value: string): string {
  return value.trim().replace(/^::/, '').replace(/\s*::\s*/g, '::');
}

function toCandidate(
  node: ClassHierarchyNode,
  mapPath: (indexedPath: string) => string
): ClassHierarchyQueryCandidate {
  const location = toLocation(node, mapPath);
  return {
    id: node.id,
    name: node.name,
    qualifiedName: node.qualifiedName,
    kind: node.kind,
    external: node.external,
    ...location,
  };
}

function toLocation(
  node: ClassHierarchyNode,
  mapPath: (indexedPath: string) => string
): ClassHierarchyQueryLocation | undefined {
  const location = node.declaration?.location;
  if (!location) {
    return undefined;
  }
  return {
    path: location.path,
    localPath: mapPath(location.path),
    line: location.line,
    column: location.column,
    endLine: location.endLine,
    endColumn: location.endColumn,
  };
}

function compareCandidates(
  left: ClassHierarchyQueryCandidate,
  right: ClassHierarchyQueryCandidate
): number {
  return (
    left.qualifiedName.localeCompare(right.qualifiedName) ||
    (left.localPath ?? '').localeCompare(right.localPath ?? '') ||
    (left.line ?? 0) - (right.line ?? 0)
  );
}
