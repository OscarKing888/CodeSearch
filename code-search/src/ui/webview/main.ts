declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
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

interface Tab {
  id: string;
  label: string;
  query: string;
  locked: boolean;
  results?: SearchResultPayload;
  selectedIndex: number;
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
const btnRefresh = document.getElementById('btnRefresh') as HTMLButtonElement;
const btnManage = document.getElementById('btnManage') as HTMLButtonElement;
const statusHits = document.getElementById('statusHits') as HTMLSpanElement;
const statusIndex = document.getElementById('statusIndex') as HTMLSpanElement;
const resultsEl = document.getElementById('results') as HTMLDivElement;

let caseSensitive = false;
let phraseSearch = true;
let fuzzy = false;
let loose = false;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let acTimer: ReturnType<typeof setTimeout> | undefined;
let suggestions: Suggestion[] = [];
let acActiveIndex = -1;

let tabs: Tab[] = [];
let activeTabId = '';
let tabCounter = 0;

function createTab(query = '', label?: string): Tab {
  tabCounter++;
  const tab: Tab = {
    id: `tab_${tabCounter}`,
    label: label ?? `Search ${tabCounter}`,
    query,
    locked: false,
    selectedIndex: -1,
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
  tabBar.classList.toggle('visible', tabs.length > 1);

  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '') + (tab.locked ? ' locked' : '');
    el.title = tab.query;
    el.textContent = tab.label;

    el.addEventListener('click', () => {
      switchTab(tab.id);
    });

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

    if (tabs.length > 1) {
      el.appendChild(lockBtn);
      if (!tab.locked) {
        el.appendChild(closeBtn);
      }
    }
    tabBar.insertBefore(el, btnNewTab);
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

btnRefresh.addEventListener('click', () => vscode.postMessage({ type: 'refreshIndex' }));
btnManage.addEventListener('click', () => vscode.postMessage({ type: 'manageIndexes' }));

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

function renderResults(result: SearchResultPayload, selectedIndex = -1): void {
  const partial = result.partialIndex ? ' (partial index)' : '';
  statusHits.textContent = `${result.hitCount.toLocaleString()} hits in ${result.fileCount} files · ${(result.elapsedMs / 1000).toFixed(2)}s${partial}`;

  if (result.hits.length === 0) {
    resultsEl.innerHTML = '<div class="empty">No results found</div>';
    return;
  }

  resultsEl.innerHTML = '';
  result.hits.forEach((hit, index) => {
    const div = document.createElement('div');
    div.className = 'hit' + (index === selectedIndex ? ' selected' : '');

    const header = document.createElement('div');
    header.className = 'hit-header';
    const badge = hit.indexLabel ? ` [${hit.indexLabel}]` : '';
    header.textContent = `${hit.relativePath}:${hit.line}${badge}`;
    div.appendChild(header);

    for (const ctx of hit.contextBefore) {
      const ctxEl = document.createElement('div');
      ctxEl.className = 'hit-context';
      ctxEl.textContent = ctx;
      div.appendChild(ctxEl);
    }

    const lineEl = document.createElement('div');
    lineEl.className = 'hit-line';
    renderHighlightedLine(lineEl, hit);
    div.appendChild(lineEl);

    for (const ctx of hit.contextAfter) {
      const ctxEl = document.createElement('div');
      ctxEl.className = 'hit-context';
      ctxEl.textContent = ctx;
      div.appendChild(ctxEl);
    }

    div.addEventListener('click', () => {
      const tab = getActiveTab();
      if (tab) {
        tab.selectedIndex = index;
      }
      vscode.postMessage({ type: 'openFile', index, preview: true });
      document.querySelectorAll('.hit').forEach((el, i) => {
        el.classList.toggle('selected', i === index);
      });
    });

    resultsEl.appendChild(div);
  });
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
      break;
    case 'newTab':
      newTab('');
      break;
    case 'setQuery':
      searchInput.value = msg.query;
      updateQueryHighlight();
      doSearch(false);
      break;
    case 'selectHit':
      renderResults(getActiveTab()?.results ?? { hits: [], hitCount: 0, fileCount: 0, elapsedMs: 0, query: '', partialIndex: false }, msg.index);
      break;
  }
});

searchInput.style.background = 'transparent';
searchHighlight.style.background = 'var(--vscode-input-background)';

ensureDefaultTab();
renderTabs();
vscode.postMessage({ type: 'ready' });
