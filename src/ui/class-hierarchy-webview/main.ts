import {
  collapseAllSubclasses,
  expandAllSubclasses,
  prioritizeHierarchyChildren,
  prioritizeHierarchyRoot,
  revealHierarchyPath,
} from '../classHierarchyTreeState';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

interface ClassHierarchyNode {
  id: string;
  name: string;
  kind?: string;
  external?: boolean;
  path?: string;
  line?: number;
  column?: number;
  children: string[];
}

interface ClassHierarchyModel {
  roots: string[];
  nodes: ClassHierarchyNode[];
  classCount: number;
  externalBaseCount: number;
  parsedFileCount: number;
  partialIndex: boolean;
}

const vscode = acquireVsCodeApi();
const MAX_RENDERED_NODES = 5000;
const filterInput = document.getElementById('filter') as HTMLInputElement;
const summaryElement = document.getElementById('summary')!;
const noticeElement = document.getElementById('notice')!;
const stateElement = document.getElementById('state')!;
const treeElement = document.getElementById('tree')!;
const collapsed = new Set<string>();
const {
  menu: treeContextMenu,
  expandButton: expandSubclassesButton,
  collapseButton: collapseSubclassesButton,
} = createTreeContextMenu();

let model: ClassHierarchyModel | undefined;
let nodeById = new Map<string, ClassHierarchyNode>();
let renderNodeBudget = MAX_RENDERED_NODES;
let renderTruncated = false;
let displayRoots: string[] = [];
let selectedOccurrence: { id: string; path: string[] } | undefined;
let selectedRow: HTMLDivElement | undefined;
let previousFilter = '';
let revealSelectedAfterRender = false;
let contextNodeId: string | undefined;

document.getElementById('expandAll')!.addEventListener('click', () => {
  collapsed.clear();
  render();
});

document.getElementById('collapseAll')!.addEventListener('click', () => {
  if (model) {
    for (const node of model.nodes) {
      if (node.children.length > 0) {
        collapsed.add(node.id);
      }
    }
  }
  render();
});

document.getElementById('refresh')!.addEventListener('click', () => {
  hideTreeContextMenu();
  vscode.postMessage({ type: 'refresh' });
});

filterInput.addEventListener('input', () => {
  hideTreeContextMenu();
  const nextFilter = normalizedFilter();
  if (previousFilter && !nextFilter && selectedOccurrence) {
    revealHierarchyPath(collapsed, selectedOccurrence.path);
    revealSelectedAfterRender = true;
  }
  previousFilter = nextFilter;
  render();
});

expandSubclassesButton.addEventListener('click', () => {
  if (!contextNodeId) {
    return;
  }
  expandAllSubclasses(collapsed, nodeById, contextNodeId);
  hideTreeContextMenu();
  revealSelectedAfterRender = true;
  render();
});

collapseSubclassesButton.addEventListener('click', () => {
  if (!contextNodeId) {
    return;
  }
  collapseAllSubclasses(collapsed, nodeById, contextNodeId);
  hideTreeContextMenu();
  revealSelectedAfterRender = true;
  render();
});

document.addEventListener('click', (event) => {
  if (!treeContextMenu.contains(event.target as Node)) {
    hideTreeContextMenu();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hideTreeContextMenu();
  }
});
window.addEventListener('resize', hideTreeContextMenu);
window.addEventListener('scroll', hideTreeContextMenu, true);

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') {
    return;
  }

  switch (message.type) {
    case 'loading':
      hideTreeContextMenu();
      clearModelStatus();
      showState('Loading class hierarchy…');
      break;
    case 'error':
      hideTreeContextMenu();
      clearModelStatus();
      showState(typeof message.message === 'string' ? message.message : 'Unable to build the class hierarchy.', true);
      break;
    case 'model':
      setModel(message.model as ClassHierarchyModel);
      break;
  }
});

vscode.postMessage({ type: 'ready' });

function setModel(nextModel: ClassHierarchyModel): void {
  hideTreeContextMenu();
  model = nextModel;
  nodeById = new Map(nextModel.nodes.map((node) => [node.id, node]));
  displayRoots = completeRootList(nextModel.roots, nextModel.nodes);
  selectedOccurrence = undefined;
  selectedRow = undefined;
  revealSelectedAfterRender = false;
  previousFilter = normalizedFilter();
  collapsed.clear();
  for (const node of nextModel.nodes) {
    if (node.children.length > 0) {
      collapsed.add(node.id);
    }
  }
  renderSummary();
  renderNotice();
  render();
}

function renderSummary(): void {
  if (!model) {
    summaryElement.textContent = '';
    return;
  }

  const external = model.externalBaseCount > 0
    ? ` · ${formatNumber(model.externalBaseCount)} external bases`
    : '';
  summaryElement.textContent = `${formatNumber(model.classCount)} indexed classes · ${formatNumber(model.parsedFileCount)} source files${external}`;
}

function renderNotice(): void {
  if (!model) {
    noticeElement.className = 'notice';
    noticeElement.textContent = '';
    return;
  }

  const notices: string[] = [];
  if (model.partialIndex) {
    notices.push('The index or hierarchy cache is still updating, so this view may be incomplete.');
  }
  noticeElement.textContent = notices.join(' ');
  noticeElement.className = notices.length > 0 ? 'notice visible' : 'notice';
}

function render(): void {
  hideTreeContextMenu();
  treeElement.replaceChildren();
  selectedRow = undefined;
  if (!model) {
    return;
  }
  renderSummary();
  renderNodeBudget = MAX_RENDERED_NODES;
  renderTruncated = false;

  if (model.classCount === 0 || model.nodes.length === 0 || displayRoots.length === 0) {
    showState('No class declarations were found in the indexed C/C++ sources.');
    return;
  }

  const filter = normalizedFilter();
  const matchMemo = new Map<string, boolean>();
  let renderedRoots = 0;
  const roots = revealSelectedAfterRender
    ? prioritizeHierarchyRoot(displayRoots, selectedOccurrence?.path)
    : displayRoots;
  for (const rootId of roots) {
    if (renderNodeBudget <= 0) {
      renderTruncated = true;
      break;
    }
    if (filter && !branchMatches(rootId, filter, new Set<string>(), matchMemo)) {
      continue;
    }
    const item = renderNode(rootId, new Set<string>(), [], filter, matchMemo);
    if (item) {
      treeElement.appendChild(item);
      renderedRoots += 1;
    }
  }

  if (renderedRoots === 0) {
    showState(`No classes match “${filterInput.value.trim()}”.`);
    return;
  }

  stateElement.hidden = true;
  treeElement.hidden = false;
  if (renderTruncated) {
    summaryElement.textContent += ` · showing first ${formatNumber(MAX_RENDERED_NODES)} tree nodes; filter to narrow`;
  }
  if (revealSelectedAfterRender) {
    revealSelectedAfterRender = false;
    const row = selectedRow;
    if (row) {
      requestAnimationFrame(() => {
        row.scrollIntoView({ block: 'center', behavior: 'auto' });
        row.focus({ preventScroll: true });
      });
    }
  }
}

function renderNode(
  id: string,
  ancestors: Set<string>,
  ancestorPath: string[],
  filter: string,
  matchMemo: Map<string, boolean>
): HTMLLIElement | undefined {
  if (renderNodeBudget <= 0) {
    renderTruncated = true;
    return undefined;
  }
  const node = nodeById.get(id);
  if (!node) {
    return undefined;
  }
  renderNodeBudget--;

  const isCycle = ancestors.has(id);
  const item = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'node-row';
  row.tabIndex = -1;
  const occurrencePath = [...ancestorPath, id];
  if (isSelectedOccurrence(id, occurrencePath)) {
    row.classList.add('selected');
    row.setAttribute('aria-selected', 'true');
    selectedRow = row;
  }
  row.addEventListener('click', () => {
    selectOccurrence(id, occurrencePath, row);
  });
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    selectOccurrence(id, occurrencePath, row);
    showTreeContextMenu(event.clientX, event.clientY, id);
  });
  item.appendChild(row);

  const matchingChildren = isCycle
    ? []
    : node.children.filter((childId) => !filter || branchMatches(childId, filter, new Set(ancestors).add(id), matchMemo));
  const orderedChildren = revealSelectedAfterRender
    ? prioritizeHierarchyChildren(
        matchingChildren,
        occurrencePath,
        selectedOccurrence?.path
      )
    : matchingChildren;
  const expandable = orderedChildren.length > 0;
  if (expandable) {
    const twistie = document.createElement('button');
    twistie.type = 'button';
    twistie.className = 'twistie';
    twistie.textContent = collapsed.has(id) && !filter ? '▶' : '▼';
    twistie.title = collapsed.has(id) && !filter ? 'Expand' : 'Collapse';
    twistie.setAttribute('aria-label', `${twistie.title} ${node.name}`);
    twistie.addEventListener('click', (event) => {
      event.stopPropagation();
      if (collapsed.has(id)) {
        collapsed.delete(id);
      } else {
        collapsed.add(id);
      }
      render();
    });
    row.appendChild(twistie);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'twistie-spacer';
    row.appendChild(spacer);
  }

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'class-name';
  name.textContent = node.name;
  const canOpen = !node.external && Boolean(node.path);
  if (node.external) {
    name.classList.add('external');
    name.title = 'External base class (not present in the index)';
    name.disabled = true;
  } else if (!canOpen) {
    name.classList.add('unavailable');
    name.title = 'Source location unavailable';
    name.disabled = true;
  } else {
    name.title = `${node.path}:${node.line ?? 1}`;
    name.addEventListener('click', () => {
      selectOccurrence(id, occurrencePath, row);
      vscode.postMessage({
        type: 'openFile',
        path: node.path,
        line: node.line ?? 1,
        column: node.column ?? 1,
      });
    });
  }
  row.appendChild(name);

  if (node.kind) {
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = node.kind;
    row.appendChild(kind);
  }

  if (isCycle) {
    const cycle = document.createElement('span');
    cycle.className = 'cycle';
    cycle.textContent = '↻ cycle';
    row.appendChild(cycle);
    return item;
  }

  if (expandable && (!collapsed.has(id) || filter)) {
    const children = document.createElement('ul');
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(id);
    for (const childId of orderedChildren) {
      const child = renderNode(childId, nextAncestors, occurrencePath, filter, matchMemo);
      if (child) {
        children.appendChild(child);
      }
    }
    if (children.childElementCount > 0) {
      item.appendChild(children);
    }
  }

  return item;
}

function normalizedFilter(): string {
  return filterInput.value.trim().toLocaleLowerCase();
}

function isSelectedOccurrence(id: string, path: readonly string[]): boolean {
  if (!selectedOccurrence || selectedOccurrence.id !== id || selectedOccurrence.path.length !== path.length) {
    return false;
  }
  return path.every((pathId, index) => selectedOccurrence?.path[index] === pathId);
}

function selectOccurrence(id: string, path: readonly string[], row: HTMLDivElement): void {
  selectedRow?.classList.remove('selected');
  selectedRow?.removeAttribute('aria-selected');
  selectedOccurrence = { id, path: [...path] };
  selectedRow = row;
  row.classList.add('selected');
  row.setAttribute('aria-selected', 'true');
}

function createTreeContextMenu(): {
  menu: HTMLDivElement;
  expandButton: HTMLButtonElement;
  collapseButton: HTMLButtonElement;
} {
  const style = document.createElement('style');
  style.textContent = `
    .node-row.selected {
      color: var(--vscode-list-activeSelectionForeground);
      background: var(--vscode-list-activeSelectionBackground);
      outline: 1px solid var(--vscode-list-focusOutline, transparent);
      outline-offset: -1px;
    }
    .node-row.selected .class-name:not(:disabled) {
      color: var(--vscode-list-activeSelectionForeground);
    }
    .tree-context-menu {
      position: fixed;
      z-index: 1000;
      display: none;
      min-width: 190px;
      padding: 2px 0;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      background: var(--vscode-menu-background, var(--vscode-dropdown-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-dropdown-border));
      border-radius: 3px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, .3);
    }
    .tree-context-menu.visible { display: block; }
    .tree-context-menu-item {
      display: block;
      width: 100%;
      padding: 5px 12px;
      color: inherit;
      background: transparent;
      border: 0;
      font: inherit;
      text-align: left;
      white-space: nowrap;
      cursor: pointer;
    }
    .tree-context-menu-item:hover:not(:disabled) {
      color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
    }
    .tree-context-menu-item:disabled {
      color: var(--vscode-disabledForeground);
      cursor: default;
    }
  `;
  document.head.appendChild(style);

  const menu = document.createElement('div');
  menu.className = 'tree-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Class hierarchy actions');

  const expandButton = document.createElement('button');
  expandButton.type = 'button';
  expandButton.className = 'tree-context-menu-item';
  expandButton.textContent = 'Expand All Subclasses';
  expandButton.setAttribute('role', 'menuitem');

  const collapseButton = document.createElement('button');
  collapseButton.type = 'button';
  collapseButton.className = 'tree-context-menu-item';
  collapseButton.textContent = 'Collapse All Subclasses';
  collapseButton.setAttribute('role', 'menuitem');

  menu.append(expandButton, collapseButton);
  menu.addEventListener('click', (event) => event.stopPropagation());
  menu.addEventListener('contextmenu', (event) => event.preventDefault());
  document.body.appendChild(menu);
  return { menu, expandButton, collapseButton };
}

function showTreeContextMenu(clientX: number, clientY: number, nodeId: string): void {
  contextNodeId = nodeId;
  const hasSubclasses = (nodeById.get(nodeId)?.children.length ?? 0) > 0;
  expandSubclassesButton.disabled = !hasSubclasses;
  collapseSubclassesButton.disabled = !hasSubclasses;
  treeContextMenu.style.left = '0px';
  treeContextMenu.style.top = '0px';
  treeContextMenu.classList.add('visible');

  const rect = treeContextMenu.getBoundingClientRect();
  const margin = 4;
  const left = Math.max(margin, Math.min(clientX, window.innerWidth - rect.width - margin));
  const top = Math.max(margin, Math.min(clientY, window.innerHeight - rect.height - margin));
  treeContextMenu.style.left = `${left}px`;
  treeContextMenu.style.top = `${top}px`;
}

function hideTreeContextMenu(): void {
  treeContextMenu.classList.remove('visible');
  contextNodeId = undefined;
}

function branchMatches(
  id: string,
  filter: string,
  ancestors: Set<string>,
  memo: Map<string, boolean>
): boolean {
  if (ancestors.has(id)) {
    return false;
  }
  const memoized = memo.get(id);
  if (memoized !== undefined) {
    return memoized;
  }
  const node = nodeById.get(id);
  if (!node) {
    return false;
  }
  if (node.name.toLocaleLowerCase().includes(filter)) {
    memo.set(id, true);
    return true;
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(id);
  for (const childId of node.children) {
    if (branchMatches(childId, filter, nextAncestors, memo)) {
      memo.set(id, true);
      return true;
    }
  }
  memo.set(id, false);
  return false;
}

function clearModelStatus(): void {
  summaryElement.textContent = '';
  noticeElement.textContent = '';
  noticeElement.className = 'notice';
}

function showState(text: string, isError = false): void {
  stateElement.textContent = text;
  stateElement.className = isError ? 'state error' : 'state';
  stateElement.hidden = false;
  treeElement.hidden = true;
}

/** Include malformed cyclic components that cannot have a conventional root. */
function completeRootList(roots: string[], nodes: ClassHierarchyNode[]): string[] {
  const result: string[] = [];
  const reached = new Set<string>();

  const markComponent = (rootId: string): void => {
    const pending = [rootId];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (reached.has(id)) {
        continue;
      }
      const node = nodeById.get(id);
      if (!node) {
        continue;
      }
      reached.add(id);
      pending.push(...node.children);
    }
  };

  for (const rootId of roots) {
    if (!nodeById.has(rootId) || reached.has(rootId)) {
      continue;
    }
    result.push(rootId);
    markComponent(rootId);
  }
  for (const node of nodes) {
    if (!reached.has(node.id)) {
      result.push(node.id);
      markComponent(node.id);
    }
  }
  return result;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}
