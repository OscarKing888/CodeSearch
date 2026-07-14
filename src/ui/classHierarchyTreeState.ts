export interface ClassHierarchyTreeNode {
  id: string;
  children: readonly string[];
}

export interface NamedClassHierarchyTreeNode extends ClassHierarchyTreeNode {
  name: string;
}

/**
 * Return direct name matches and every node that can reach one through child edges.
 * Reverse edges keep the traversal iterative and naturally deduplicate DAGs/cycles.
 */
export function collectHierarchyFilterMatches(
  nodeById: ReadonlyMap<string, NamedClassHierarchyTreeNode>,
  filter: string
): Set<string> {
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const parentsByChild = new Map<string, string[]>();
  const visible = new Set<string>();
  const pending: string[] = [];

  for (const [id, node] of nodeById) {
    if (node.name.toLocaleLowerCase().includes(normalizedFilter)) {
      visible.add(id);
      pending.push(id);
    }
    for (const childId of node.children) {
      const parents = parentsByChild.get(childId);
      if (parents) {
        parents.push(id);
      } else {
        parentsByChild.set(childId, [id]);
      }
    }
  }

  while (pending.length > 0) {
    const id = pending.pop()!;
    for (const parentId of parentsByChild.get(id) ?? []) {
      if (visible.has(parentId)) {
        continue;
      }
      visible.add(parentId);
      pending.push(parentId);
    }
  }

  return visible;
}

/** Return every reachable child once, even when the hierarchy is a DAG or malformed cycle. */
export function collectHierarchyDescendants(
  nodeById: ReadonlyMap<string, ClassHierarchyTreeNode>,
  startId: string
): Set<string> {
  const descendants = new Set<string>();
  const visited = new Set<string>([startId]);
  const pending = [...(nodeById.get(startId)?.children ?? [])];

  while (pending.length > 0) {
    const id = pending.pop()!;
    if (visited.has(id)) {
      continue;
    }
    visited.add(id);
    descendants.add(id);
    for (const childId of nodeById.get(id)?.children ?? []) {
      pending.push(childId);
    }
  }

  return descendants;
}

/** Expand the selected node and every subclass below it. */
export function expandAllSubclasses(
  collapsed: Set<string>,
  nodeById: ReadonlyMap<string, ClassHierarchyTreeNode>,
  startId: string
): void {
  collapsed.delete(startId);
  for (const id of collectHierarchyDescendants(nodeById, startId)) {
    collapsed.delete(id);
  }
}

/** Keep the selected node open while collapsing each expandable subclass below it. */
export function collapseAllSubclasses(
  collapsed: Set<string>,
  nodeById: ReadonlyMap<string, ClassHierarchyTreeNode>,
  startId: string
): void {
  collapsed.delete(startId);
  for (const id of collectHierarchyDescendants(nodeById, startId)) {
    const node = nodeById.get(id);
    if (node?.children.length) {
      collapsed.add(id);
    } else {
      collapsed.delete(id);
    }
  }
}

/** Expand only the ancestors needed to make a selected occurrence visible. */
export function revealHierarchyPath(collapsed: Set<string>, path: readonly string[]): void {
  for (let index = 0; index < path.length - 1; index++) {
    collapsed.delete(path[index]);
  }
}

/** Clear the selected occurrence's ancestor path and open the selected class itself. */
export function revealHierarchySubclasses(collapsed: Set<string>, path: readonly string[]): void {
  revealHierarchyPath(collapsed, path);
  const selectedId = path[path.length - 1];
  if (selectedId) {
    collapsed.delete(selectedId);
  }
}

/** Keep expansion choices for stable nodes while collapsing newly introduced branches. */
export function retainCollapsedHierarchyNodes(
  previousCollapsed: ReadonlySet<string>,
  previousNodes: ReadonlyMap<string, ClassHierarchyTreeNode>,
  nextNodes: ReadonlyMap<string, ClassHierarchyTreeNode>
): Set<string> {
  const retained = new Set<string>();
  for (const [id, node] of nextNodes) {
    if (node.children.length === 0) {
      continue;
    }
    if (!previousNodes.has(id) || previousCollapsed.has(id)) {
      retained.add(id);
    }
  }
  return retained;
}

/** A selected occurrence is reusable only when its complete parent-child path remains valid. */
export function isHierarchyOccurrencePathValid(
  nodeById: ReadonlyMap<string, ClassHierarchyTreeNode>,
  path: readonly string[]
): boolean {
  if (path.length === 0) {
    return false;
  }
  for (let index = 0; index < path.length; index++) {
    const node = nodeById.get(path[index]);
    if (!node) {
      return false;
    }
    if (index > 0 && !nodeById.get(path[index - 1])?.children.includes(path[index])) {
      return false;
    }
  }
  return true;
}

/** Put the selected occurrence's root first so it survives the webview render budget. */
export function prioritizeHierarchyRoot(
  roots: readonly string[],
  selectedPath: readonly string[] | undefined
): string[] {
  const selectedRoot = selectedPath?.[0];
  if (!selectedRoot) {
    return [...roots];
  }
  const index = roots.indexOf(selectedRoot);
  if (index <= 0) {
    return [...roots];
  }
  return [selectedRoot, ...roots.slice(0, index), ...roots.slice(index + 1)];
}

/** Put the next selected-path child first without copying the whole ancestor path. */
export function prioritizeHierarchyChild(
  children: readonly string[],
  selectedChild: string | undefined
): string[] {
  if (!selectedChild) {
    return [...children];
  }
  const index = children.indexOf(selectedChild);
  if (index <= 0) {
    return [...children];
  }
  return [selectedChild, ...children.slice(0, index), ...children.slice(index + 1)];
}
