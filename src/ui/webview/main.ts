declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

interface HighlightToken {
  text: string;
  color?: string;
}

interface HitPayload {
  path: string;
  localPath?: string;
  relativePath: string;
  indexLabel?: string;
  line: number;
  column: number;
  lineText: string;
  contextBefore: string[];
  contextAfter: string[];
  matchStart: number;
  matchEnd: number;
  highlighted?: { tokens: HighlightToken[]; matchStart: number; matchEnd: number };
}

interface SearchResultPayload {
  hits: HitPayload[];
  hitCount: number;
  fileCount: number;
  elapsedMs: number;
  query: string;
  partialIndex: boolean;
}

interface Suggestion {
  token: string;
  freq: number;
}

type SortColumn = 'path' | 'line' | 'code';
type SortDirection = 'asc' | 'desc';

interface ColumnWidths {
  path: number;
  line: number;
}

interface PersistedWebviewState {
  columnLayoutVersion?: number;
  columnWidths?: ColumnWidths;
}

const COLUMN_LAYOUT_VERSION = 2;
const DEFAULT_COLUMN_WIDTHS: ColumnWidths = { path: 100, line: 44 };
const MIN_COLUMN_WIDTHS: ColumnWidths = { path: 64, line: 36 };
const MAX_COLUMN_WIDTHS: ColumnWidths = { path: 480, line: 120 };

interface Tab {
  id: string;
  label: string;
  query: string;
  locked: boolean;
  results?: SearchResultPayload;
  selectedIndex: number;
  sortColumn: SortColumn;
  sortDirection: SortDirection;
  showContext: boolean;
}

const searchInput = document.getElementById('searchInput') as HTMLInputElement;
const searchHighlight = document.getElementById('searchHighlight') as HTMLDivElement;
const autocompleteEl = document.getElementById('autocomplete') as HTMLDivElement;
const tabBar = document.getElementById('tabBar') as HTMLDivElement;
const btnNewTab = document.getElementById('btnNewTab') as HTMLDivElement;
const btnCase = document.getElementById('btnCase') as HTMLButtonElement;
const btnPhrase = document.getElementById('btnPhrase') as HTMLButtonElement;
const btnFuzzy = document.getElementById('btnFuzzy') as HTMLButtonElement;
const btnLoose = document.getElementById('btnLoose') as HTMLButtonElement;
const btnContext = document.getElementById('btnContext') as HTMLButtonElement;
const btnCtxLess = document.getElementById('btnCtxLess') as HTMLButtonElement;
const btnCtxMore = document.getElementById('btnCtxMore') as HTMLButtonElement;
const btnRefresh = document.getElementById('btnRefresh') as HTMLButtonElement;
const btnManage = document.getElementById('btnManage') as HTMLButtonElement;
const btnSettings = document.getElementById('btnSettings') as HTMLButtonElement;
const statusHits = document.getElementById('statusHits') as HTMLSpanElement;
const statusIndex = document.getElementById('statusIndex') as HTMLSpanElement;
const resultsEl = document.getElementById('results') as HTMLDivElement;
const resultContextMenu = document.getElementById('resultContextMenu') as HTMLDivElement;

let contextMenuHitIndex = -1;

let caseSensitive = false;
let phraseSearch = true;
let fuzzy = false;
let loose = false;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let acTimer: ReturnType<typeof setTimeout> | undefined;
let suggestions: Suggestion[] = [];
let acActiveIndex = -1;
let configContextLines = 1;

let tabs: Tab[] = [];
let activeTabId = '';
let tabCounter = 0;

function loadColumnWidths(): ColumnWidths {
  const state = vscode.getState() as PersistedWebviewState | null;
  if (state?.columnLayoutVersion !== COLUMN_LAYOUT_VERSION) {
    return { ...DEFAULT_COLUMN_WIDTHS };
  }
  return {
    path: clampColumnWidth('path', state?.columnWidths?.path ?? DEFAULT_COLUMN_WIDTHS.path),
    line: clampColumnWidth('line', state?.columnWidths?.line ?? DEFAULT_COLUMN_WIDTHS.line),
  };
}

function clampColumnWidth(key: keyof ColumnWidths, value: number): number {
  return Math.max(MIN_COLUMN_WIDTHS[key], Math.min(MAX_COLUMN_WIDTHS[key], value));
}

let columnWidths = loadColumnWidths();

function saveColumnWidths(): void {
  const prev = (vscode.getState() as PersistedWebviewState | null) ?? {};
  vscode.setState({
    ...prev,
    columnLayoutVersion: COLUMN_LAYOUT_VERSION,
    columnWidths,
  });
}

function applyTableColumnWidths(table: HTMLTableElement): void {
  table.style.setProperty('--cs-col-path', `${columnWidths.path}px`);
  table.style.setProperty('--cs-col-line', `${columnWidths.line}px`);
}

function attachColumnResizer(
  th: HTMLTableCellElement,
  table: HTMLTableElement,
  columnKey: keyof ColumnWidths
): void {
  const resizer = document.createElement('div');
  resizer.className = 'col-resizer';
  resizer.title = 'Drag to resize · double-click to reset';
  th.appendChild(resizer);

  const cssVar = columnKey === 'path' ? '--cs-col-path' : '--cs-col-line';

  const applyWidth = (width: number) => {
    columnWidths = { ...columnWidths, [columnKey]: width };
    table.style.setProperty(cssVar, `${width}px`);
  };

  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    resizer.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = columnWidths[columnKey];

    const onMove = (ev: PointerEvent) => {
      const next = clampColumnWidth(columnKey, startWidth + (ev.clientX - startX));
      applyWidth(next);
    };
    const onEnd = (ev: PointerEvent) => {
      if (resizer.hasPointerCapture(ev.pointerId)) {
        resizer.releasePointerCapture(ev.pointerId);
      }
      resizer.removeEventListener('pointermove', onMove);
      resizer.removeEventListener('pointerup', onEnd);
      resizer.removeEventListener('pointercancel', onEnd);
      document.body.classList.remove('col-resizing');
      saveColumnWidths();
    };
    document.body.classList.add('col-resizing');
    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onEnd);
    resizer.addEventListener('pointercancel', onEnd);
  });

  resizer.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    columnWidths = { ...DEFAULT_COLUMN_WIDTHS };
    applyTableColumnWidths(table);
    saveColumnWidths();
  });
}

function createTab(query = '', label?: string): Tab {
  tabCounter++;
  const tab: Tab = {
    id: `tab_${tabCounter}`,
    label: label ?? `Search ${tabCounter}`,
    query,
    locked: false,
    selectedIndex: -1,
    sortColumn: 'path',
    sortDirection: 'asc',
    showContext: false,
  };
  tabs.push(tab);
  return tab;
}

function getActiveTab(): Tab | undefined {
  return tabs.find((t) => t.id === activeTabId);
}

function ensureDefaultTab(): Tab {
  if (tabs.length === 0) {
    const tab = createTab();
    activeTabId = tab.id;
  }
  return getActiveTab()!;
}

function renderTabs(): void {
  tabBar.querySelectorAll('.tab').forEach((el) => el.remove());

  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '') + (tab.locked ? ' locked' : '');
    el.title = tab.query;

    el.addEventListener('click', () => {
      switchTab(tab.id);
    });

    const labelEl = document.createElement('span');
    labelEl.className = 'tab-label';
    labelEl.textContent = tab.label;

    const lockBtn = document.createElement('span');
    lockBtn.className = 'tab-lock';
    lockBtn.textContent = tab.locked ? '🔒' : '🔓';
    lockBtn.title = tab.locked ? 'Unlock tab' : 'Lock tab';
    lockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      tab.locked = !tab.locked;
      renderTabs();
    });

    const closeBtn = document.createElement('span');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });

    el.appendChild(labelEl);
    el.appendChild(lockBtn);
    if (tabs.length > 1 && !tab.locked) {
      el.appendChild(closeBtn);
    }
    tabBar.insertBefore(el, btnNewTab);
  }
}

function syncContextButton(): void {
  const tab = getActiveTab();
  const show = tab?.showContext ?? false;
  btnContext.classList.toggle('active', show);
  btnContext.textContent = `Ctx${configContextLines > 0 ? `·${configContextLines}` : ''}`;
  btnContext.title = show
    ? `Hide context lines (${configContextLines} per side)`
    : `Show context lines (${configContextLines} per side)`;
  btnCtxLess.disabled = configContextLines <= 0;
  btnCtxMore.disabled = configContextLines >= 10;
}

function changeContextLines(next: number): void {
  const clamped = Math.max(0, Math.min(10, next));
  if (clamped === configContextLines) {
    return;
  }
  configContextLines = clamped;
  syncContextButton();
  vscode.postMessage({ type: 'setContextLines', contextLines: clamped });

  const tab = getActiveTab();
  if (!tab) {
    return;
  }
  const needsRescan = tab.showContext && tab.query.trim().length > 0;
  if (needsRescan) {
    doSearch(false);
  } else if (tab.results) {
    renderResults(tab.results, tab.selectedIndex);
  }
}

function switchTab(id: string): void {
  const prev = getActiveTab();
  if (prev) {
    prev.query = searchInput.value;
  }
  activeTabId = id;
  const tab = getActiveTab();
  if (tab) {
    searchInput.value = tab.query;
    updateQueryHighlight();
    syncContextButton();
    if (tab.results) {
      renderResults(tab.results, tab.selectedIndex);
    } else {
      resultsEl.innerHTML = tab.query ? '' : '<div class="empty">Enter a search query</div>';
      statusHits.textContent = 'Ready';
    }
  }
  renderTabs();
}

function closeTab(id: string): void {
  if (tabs.length <= 1) {
    return;
  }
  const idx = tabs.findIndex((t) => t.id === id);
  tabs = tabs.filter((t) => t.id !== id);
  if (activeTabId === id) {
    activeTabId = tabs[Math.max(0, idx - 1)].id;
    switchTab(activeTabId);
  } else {
    renderTabs();
  }
}

function newTab(query = ''): Tab {
  hideResultContextMenu();
  const tab = createTab(query);
  activeTabId = tab.id;
  searchInput.value = query;
  updateQueryHighlight();
  resultsEl.innerHTML = '<div class="empty">Enter a search query</div>';
  statusHits.textContent = 'Ready';
  renderTabs();
  return tab;
}

function findTargetTab(forNewTab: boolean): Tab {
  if (forNewTab) {
    return newTab(searchInput.value);
  }
  const active = ensureDefaultTab();
  if (active.locked) {
    const unlocked = tabs.find((t) => !t.locked);
    if (unlocked) {
      activeTabId = unlocked.id;
      return unlocked;
    }
    return newTab(searchInput.value);
  }
  return active;
}

btnNewTab.addEventListener('click', () => {
  newTab('');
  searchInput.focus();
});

searchInput.addEventListener('input', () => {
  const tab = getActiveTab();
  if (tab && !tab.locked) {
    tab.query = searchInput.value;
    tab.label = searchInput.value.slice(0, 20) || tab.label;
    renderTabs();
  }
  updateQueryHighlight();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => doSearch(false), 250);
  requestAutocomplete();
});

searchInput.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    doSearch(true);
    return;
  }

  if (autocompleteEl.classList.contains('visible') && suggestions.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acActiveIndex = Math.min(acActiveIndex + 1, suggestions.length - 1);
      renderAutocomplete();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      acActiveIndex = Math.max(acActiveIndex - 1, 0);
      renderAutocomplete();
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && acActiveIndex >= 0)) {
      e.preventDefault();
      applySuggestion(suggestions[acActiveIndex]);
      return;
    }
    if (e.key === 'Escape') {
      hideAutocomplete();
      return;
    }
  }

  if (e.key === 'Enter') {
    clearTimeout(debounceTimer);
    doSearch(false);
  }
});

searchInput.addEventListener('blur', () => {
  setTimeout(() => hideAutocomplete(), 150);
});

btnCase.addEventListener('click', () => {
  caseSensitive = !caseSensitive;
  btnCase.classList.toggle('active', caseSensitive);
  doSearch(false);
});

btnPhrase.addEventListener('click', () => {
  phraseSearch = !phraseSearch;
  btnPhrase.classList.toggle('active', phraseSearch);
  doSearch(false);
});

btnFuzzy.addEventListener('click', () => {
  fuzzy = !fuzzy;
  btnFuzzy.classList.toggle('active', fuzzy);
  doSearch(false);
});

btnLoose.addEventListener('click', () => {
  loose = !loose;
  btnLoose.classList.toggle('active', loose);
  doSearch(false);
});

btnContext.addEventListener('click', () => {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }
  tab.showContext = !tab.showContext;
  syncContextButton();
  const needsRescan =
    tab.showContext &&
    tab.results?.hits.some(
      (h) => h.contextBefore.length > 0 || h.contextAfter.length > 0
    ) === false &&
    configContextLines > 0;
  if (needsRescan && tab.query.trim()) {
    doSearch(false);
  } else if (tab.results) {
    renderResults(tab.results, tab.selectedIndex);
  }
});

btnCtxLess.addEventListener('click', () => changeContextLines(configContextLines - 1));
btnCtxMore.addEventListener('click', () => changeContextLines(configContextLines + 1));

btnRefresh.addEventListener('click', () => vscode.postMessage({ type: 'refreshIndex' }));
btnManage.addEventListener('click', () => vscode.postMessage({ type: 'manageIndexes' }));
btnSettings.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

function doSearch(forceNewTab: boolean): void {
  const tab = findTargetTab(forceNewTab);
  if (tab.locked && !forceNewTab) {
    return;
  }

  const query = searchInput.value.trim();
  tab.query = query;
  tab.label = query.slice(0, 24) || tab.label;
  renderTabs();

  if (!query) {
    resultsEl.innerHTML = '<div class="empty">Enter a search query</div>';
    statusHits.textContent = 'Ready';
    return;
  }

  vscode.postMessage({
    type: 'search',
    query,
    caseSensitive,
    phraseSearch,
    fuzzy,
    loose,
    showContext: tab.showContext,
    contextLines: configContextLines,
    tabId: tab.id,
    newTab: forceNewTab,
  });
}

function requestAutocomplete(): void {
  const value = searchInput.value;
  const wordMatch = value.match(/[a-zA-Z_][a-zA-Z0-9_]*$/);
  const prefix = wordMatch?.[0] ?? '';
  if (prefix.length < 2) {
    hideAutocomplete();
    return;
  }
  clearTimeout(acTimer);
  acTimer = setTimeout(() => vscode.postMessage({ type: 'autocomplete', prefix }), 150);
}

function renderAutocomplete(): void {
  autocompleteEl.innerHTML = '';
  if (suggestions.length === 0) {
    hideAutocomplete();
    return;
  }
  autocompleteEl.classList.add('visible');
  suggestions.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item' + (i === acActiveIndex ? ' active' : '');
    item.innerHTML = `<span>${escapeHtml(s.token)}</span><span class="autocomplete-freq">${s.freq}</span>`;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applySuggestion(s);
    });
    autocompleteEl.appendChild(item);
  });
}

function applySuggestion(s: Suggestion): void {
  const value = searchInput.value;
  const wordMatch = value.match(/[a-zA-Z_][a-zA-Z0-9_]*$/);
  if (wordMatch) {
    searchInput.value = value.slice(0, wordMatch.index) + s.token;
  } else {
    searchInput.value = value + s.token;
  }
  hideAutocomplete();
  updateQueryHighlight();
  doSearch(false);
  searchInput.focus();
}

function hideAutocomplete(): void {
  autocompleteEl.classList.remove('visible');
  autocompleteEl.innerHTML = '';
  acActiveIndex = -1;
  suggestions = [];
}

function updateQueryHighlight(): void {
  searchHighlight.innerHTML = highlightQueryHtml(searchInput.value);
}

function highlightQueryHtml(raw: string): string {
  if (!raw) {
    return '';
  }
  const regex =
    /loose\d*:|(-?)(ext|dir|file|age):(\S+)|\+(?:"([^"]+)"|(\S+))|-(?:"([^"]+)"|(\S+))|"(?:[^"\\]|\\.)*"|[^\s]+/gi;
  let html = '';
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    if (match.index > lastEnd) {
      html += escapeHtml(raw.slice(lastEnd, match.index));
    }
    const full = match[0];
    let cls = 'term';
    if (/^loose\d*:$/i.test(full)) {
      cls = 'loose';
    } else if (match[2]) {
      cls = match[1] === '-' ? 'filter-exclude' : 'filter-include';
    } else if (full.startsWith('+')) {
      cls = 'filter-include';
    } else if (full.startsWith('-') && !match[2]) {
      cls = 'filter-exclude';
    } else if (full.startsWith('"')) {
      cls = 'quoted';
    }
    html += `<span class="${cls}">${escapeHtml(full)}</span>`;
    lastEnd = match.index + full.length;
  }
  if (lastEnd < raw.length) {
    html += escapeHtml(raw.slice(lastEnd));
  }
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function openHitFile(hit: HitPayload, preview: boolean): void {
  vscode.postMessage({
    type: 'openFile',
    path: hit.localPath ?? hit.path,
    line: hit.line,
    column: hit.column,
    preview,
  });
}

function formatHitLine(hit: HitPayload): string {
  const fullPath = hit.localPath ?? hit.path;
  return `${fullPath}:${hit.line}\t${hit.lineText}`;
}

function copyTextToClipboard(text: string): void {
  vscode.postMessage({ type: 'copyToClipboard', text });
}

function hideResultContextMenu(): void {
  resultContextMenu.classList.remove('visible');
  contextMenuHitIndex = -1;
}

function showResultContextMenu(x: number, y: number, hitIndex: number): void {
  contextMenuHitIndex = hitIndex;
  resultContextMenu.style.left = `${x}px`;
  resultContextMenu.style.top = `${y}px`;
  resultContextMenu.classList.add('visible');
}

function copyAllHits(): void {
  const tab = getActiveTab();
  if (!tab?.results?.hits.length) {
    return;
  }
  const sorted = getSortedIndices(tab.results.hits, tab.sortColumn, tab.sortDirection);
  const text = sorted.map((i) => formatHitLine(tab.results!.hits[i])).join('\n');
  copyTextToClipboard(text);
}

function getFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

function getSortedIndices(
  hits: HitPayload[],
  column: SortColumn,
  direction: SortDirection
): number[] {
  const indices = hits.map((_, i) => i);
  indices.sort((a, b) => {
    const ha = hits[a];
    const hb = hits[b];
    let cmp = 0;
    switch (column) {
      case 'path':
        cmp = ha.relativePath.localeCompare(hb.relativePath);
        break;
      case 'line':
        cmp = ha.line - hb.line;
        if (cmp === 0) {
          cmp = ha.relativePath.localeCompare(hb.relativePath);
        }
        break;
      case 'code':
        cmp = ha.lineText.localeCompare(hb.lineText);
        if (cmp === 0) {
          cmp = ha.relativePath.localeCompare(hb.relativePath) || ha.line - hb.line;
        }
        break;
    }
    return direction === 'asc' ? cmp : -cmp;
  });
  return indices;
}

function navigateHit(direction: 'next' | 'prev'): void {
  const tab = getActiveTab();
  const hits = tab?.results?.hits;
  if (!tab || !hits?.length) {
    return;
  }
  const sortedIndices = getSortedIndices(hits, tab.sortColumn, tab.sortDirection);
  const len = sortedIndices.length;
  let displayIdx = sortedIndices.indexOf(tab.selectedIndex);
  if (displayIdx < 0) {
    displayIdx = direction === 'next' ? -1 : 0;
  }
  if (direction === 'next') {
    displayIdx = displayIdx < 0 ? 0 : (displayIdx + 1) % len;
  } else {
    displayIdx = displayIdx <= 0 ? len - 1 : displayIdx - 1;
  }
  tab.selectedIndex = sortedIndices[displayIdx];
  renderResults(tab.results!, tab.selectedIndex);
  openHitFile(hits[tab.selectedIndex], true);
}

function sortIndicator(column: SortColumn, activeColumn: SortColumn, direction: SortDirection): string {
  if (column !== activeColumn) {
    return '';
  }
  return direction === 'asc' ? ' ▲' : ' ▼';
}

function selectHit(originalIndex: number): void {
  const tab = getActiveTab();
  if (tab) {
    tab.selectedIndex = originalIndex;
  }
  document.querySelectorAll('.hit-row').forEach((el) => {
    const idx = Number((el as HTMLElement).dataset.hitIndex);
    el.classList.toggle('selected', idx === originalIndex);
  });
  document.querySelectorAll('.hit-context-row').forEach((el) => {
    const idx = Number((el as HTMLElement).dataset.hitIndex);
    el.classList.toggle('selected', idx === originalIndex);
  });
}

function renderResults(result: SearchResultPayload, selectedIndex = -1): void {
  const partial = result.partialIndex ? ' (partial index)' : '';
  statusHits.textContent = `${result.hitCount.toLocaleString()} hits in ${result.fileCount} files · ${(result.elapsedMs / 1000).toFixed(2)}s${partial}`;

  if (result.hits.length === 0) {
    resultsEl.innerHTML = '<div class="empty">No results found</div>';
    return;
  }

  const tab = getActiveTab();
  const sortColumn = tab?.sortColumn ?? 'path';
  const sortDirection = tab?.sortDirection ?? 'asc';
  const showContext = tab?.showContext ?? false;
  const sortedIndices = getSortedIndices(result.hits, sortColumn, sortDirection);

  const table = document.createElement('table');
  table.className = 'results-table';

  const colgroup = document.createElement('colgroup');
  const colPath = document.createElement('col');
  colPath.className = 'col-path';
  const colLine = document.createElement('col');
  colLine.className = 'col-line';
  const colCode = document.createElement('col');
  colCode.className = 'col-code';
  colgroup.append(colPath, colLine, colCode);
  table.appendChild(colgroup);
  applyTableColumnWidths(table);

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const columns: Array<{
    key: SortColumn;
    label: string;
    className: string;
    resizable?: keyof ColumnWidths;
  }> = [
    { key: 'path', label: 'File', className: 'col-path', resizable: 'path' },
    { key: 'line', label: 'Line', className: 'col-line', resizable: 'line' },
    { key: 'code', label: 'Code', className: 'col-code' },
  ];
  for (const col of columns) {
    const th = document.createElement('th');
    th.className = col.className;
    const label = document.createElement('span');
    label.className = 'col-header-label';
    label.textContent = col.label + sortIndicator(col.key, sortColumn, sortDirection);
    th.appendChild(label);
    if (col.resizable) {
      attachColumnResizer(th, table, col.resizable);
    }
    th.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('col-resizer')) {
        return;
      }
      const activeTab = getActiveTab();
      if (!activeTab?.results) {
        return;
      }
      if (activeTab.sortColumn === col.key) {
        activeTab.sortDirection = activeTab.sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        activeTab.sortColumn = col.key;
        activeTab.sortDirection = 'asc';
      }
      renderResults(activeTab.results, activeTab.selectedIndex);
    });
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const originalIndex of sortedIndices) {
    const hit = result.hits[originalIndex];
    const isSelected = originalIndex === selectedIndex;
    const badge = hit.indexLabel ? ` [${hit.indexLabel}]` : '';

    const addContextRow = (text: string) => {
      const tr = document.createElement('tr');
      tr.className = 'hit-context-row' + (isSelected ? ' selected' : '');
      tr.dataset.hitIndex = String(originalIndex);
      const emptyPath = document.createElement('td');
      emptyPath.className = 'col-path';
      const emptyLine = document.createElement('td');
      emptyLine.className = 'col-line';
      const codeTd = document.createElement('td');
      codeTd.className = 'col-code';
      codeTd.textContent = text;
      tr.appendChild(emptyPath);
      tr.appendChild(emptyLine);
      tr.appendChild(codeTd);
      tr.addEventListener('click', () => {
        selectHit(originalIndex);
        openHitFile(hit, true);
      });
      tbody.appendChild(tr);
    };

    if (showContext) {
      for (const ctx of hit.contextBefore) {
        addContextRow(ctx);
      }
    }

    const tr = document.createElement('tr');
    tr.className = 'hit-row' + (isSelected ? ' selected' : '');
    tr.dataset.hitIndex = String(originalIndex);

    const pathTd = document.createElement('td');
    pathTd.className = 'col-path';
    const fullPath = hit.relativePath + badge;
    pathTd.textContent = getFileName(hit.relativePath) + badge;
    pathTd.title = fullPath;

    const lineTd = document.createElement('td');
    lineTd.className = 'col-line';
    lineTd.textContent = String(hit.line);

    const codeTd = document.createElement('td');
    codeTd.className = 'col-code hit-line';
    renderHighlightedLine(codeTd, hit);

    tr.appendChild(pathTd);
    tr.appendChild(lineTd);
    tr.appendChild(codeTd);

    tr.addEventListener('click', () => {
      selectHit(originalIndex);
      openHitFile(hit, true);
    });

    tbody.appendChild(tr);

    if (showContext) {
      for (const ctx of hit.contextAfter) {
        addContextRow(ctx);
      }
    }
  }
  table.appendChild(tbody);

  resultsEl.innerHTML = '';
  resultsEl.appendChild(table);
}

function renderHighlightedLine(container: HTMLElement, hit: HitPayload): void {
  const hl = hit.highlighted;
  if (!hl || !hl.tokens.length) {
    if (hit.matchStart < hit.matchEnd) {
      wrapMatch(container, hit.lineText, hit.matchStart, hit.matchEnd);
    } else {
      container.textContent = hit.lineText;
    }
    return;
  }
  let offset = 0;
  for (const token of hl.tokens) {
    const tokenStart = offset;
    const tokenEnd = offset + token.text.length;
    if (hit.matchStart < hit.matchEnd && tokenEnd > hit.matchStart && tokenStart < hit.matchEnd) {
      const ms = Math.max(0, hit.matchStart - tokenStart);
      const me = Math.min(token.text.length, hit.matchEnd - tokenStart);
      if (ms > 0) {
        const before = document.createElement('span');
        before.textContent = token.text.slice(0, ms);
        if (token.color) {
          before.style.color = token.color;
        }
        container.appendChild(before);
      }
      const matchSpan = document.createElement('span');
      matchSpan.className = 'match-highlight';
      matchSpan.textContent = token.text.slice(ms, me);
      if (token.color) {
        matchSpan.style.color = token.color;
      }
      container.appendChild(matchSpan);
      if (me < token.text.length) {
        const after = document.createElement('span');
        after.textContent = token.text.slice(me);
        if (token.color) {
          after.style.color = token.color;
        }
        container.appendChild(after);
      }
    } else {
      const span = document.createElement('span');
      span.textContent = token.text;
      if (token.color) {
        span.style.color = token.color;
      }
      container.appendChild(span);
    }
    offset = tokenEnd;
  }
}

function wrapMatch(container: HTMLElement, text: string, start: number, end: number): void {
  if (start > 0) {
    container.appendChild(document.createTextNode(text.slice(0, start)));
  }
  const match = document.createElement('span');
  match.className = 'match-highlight';
  match.textContent = text.slice(start, end);
  container.appendChild(match);
  if (end < text.length) {
    container.appendChild(document.createTextNode(text.slice(end)));
  }
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      configContextLines = msg.contextLines ?? 1;
      syncContextButton();
      break;
    case 'results': {
      const tab = tabs.find((t) => t.id === msg.tabId) ?? getActiveTab();
      if (tab) {
        tab.results = msg.result;
        tab.selectedIndex = -1;
        if (tab.id === activeTabId) {
          renderResults(msg.result);
        }
      }
      break;
    }
    case 'indexStatus': {
      let text = `Index: ${msg.progress.message}`;
      if (msg.secondaryIndexes?.length) {
        text += ` +${msg.secondaryIndexes.length} secondary`;
      }
      statusIndex.textContent = text;
      break;
    }
    case 'autocomplete':
      suggestions = msg.suggestions ?? [];
      acActiveIndex = suggestions.length > 0 ? 0 : -1;
      renderAutocomplete();
      break;
    case 'focus':
      searchInput.focus();
      searchInput.select();
      postPanelFocus(true);
      break;
    case 'newTab':
      newTab('');
      break;
    case 'setQuery':
      searchInput.value = msg.query;
      updateQueryHighlight();
      doSearch(false);
      break;
    case 'navigateHit':
      navigateHit(msg.direction === 'prev' ? 'prev' : 'next');
      break;
  }
});

searchInput.style.background = 'transparent';
searchHighlight.style.background = 'var(--vscode-input-background)';

function postPanelFocus(focused: boolean): void {
  vscode.postMessage({ type: 'panelFocus', focused });
}

window.addEventListener('focus', () => postPanelFocus(true));
window.addEventListener('blur', () => postPanelFocus(false));
document.addEventListener('pointerdown', () => postPanelFocus(true));

resultsEl.addEventListener('contextmenu', (e) => {
  const row = (e.target as HTMLElement).closest('.hit-row');
  if (!row) {
    return;
  }
  const tab = getActiveTab();
  if (!tab?.results?.hits.length) {
    return;
  }
  e.preventDefault();
  const hitIndex = Number((row as HTMLElement).dataset.hitIndex);
  if (Number.isNaN(hitIndex)) {
    return;
  }
  showResultContextMenu(e.clientX, e.clientY, hitIndex);
});

resultContextMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const item = (e.target as HTMLElement).closest('[data-action]');
  if (!item) {
    return;
  }
  const action = item.getAttribute('data-action');
  const tab = getActiveTab();
  if (action === 'copy' && tab?.results && contextMenuHitIndex >= 0) {
    const hit = tab.results.hits[contextMenuHitIndex];
    if (hit) {
      copyTextToClipboard(formatHitLine(hit));
    }
  } else if (action === 'copyAll') {
    copyAllHits();
  }
  hideResultContextMenu();
});

document.addEventListener('click', () => hideResultContextMenu());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideResultContextMenu();
  }
});
resultsEl.addEventListener('scroll', () => hideResultContextMenu(), true);

ensureDefaultTab();
renderTabs();
syncContextButton();
vscode.postMessage({ type: 'ready' });