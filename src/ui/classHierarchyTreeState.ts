export interface ClassHierarchyTreeNode {
  id: string;
  children: readonly string[];
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
    pending.push(...(nodeById.get(id)?.children ?? []));
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

/** Prioritize the next selected-path child so a render budget cannot hide it. */
export function prioritizeHierarchyChildren(
  children: readonly string[],
  currentPath: readonly string[],
  selectedPath: readonly string[] | undefined
): string[] {
  if (!selectedPath || currentPath.length >= selectedPath.length) {
    return [...children];
  }
  for (let index = 0; index < currentPath.length; index++) {
    if (currentPath[index] !== selectedPath[index]) {
      return [...children];
    }
  }
  const selectedChild = selectedPath[currentPath.length];
  const childIndex = children.indexOf(selectedChild);
  if (childIndex <= 0) {
    return [...children];
  }
  return [
    selectedChild,
    ...children.slice(0, childIndex),
    ...children.slice(childIndex + 1),
  ];
}
