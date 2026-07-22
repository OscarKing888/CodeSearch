declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

interface DirectoryMapping {
  from: string;
  to: string;
}

type IndexUsage = 'primary' | 'secondary' | 'available';
type IndexStatus = 'idle' | 'scanning' | 'indexing' | 'upToDate' | 'available' | 'missing';
type DraftSection = 'rename' | 'mappings' | 'excludes';

interface IndexListItem {
  id: string;
  name: string;
  displayTitle: string;
  dbPath: string;
  rootDirs: string[];
  readOnly: boolean;
  requestedReadOnly: boolean;
  usage: IndexUsage;
  isPrimary: boolean;
  isAttached: boolean;
  exists: boolean;
  isShared: boolean;
  writerLabel?: string;
  directoryMappings: DirectoryMapping[];
  mappingsText: string;
  excludeDirsText: string;
  excludeFilesText: string;
  excludeGlobsText: string;
  statusMessage: string;
  status: IndexStatus;
  partial: boolean;
  canRefresh: boolean;
}

interface WorkspaceSummary {
  hash: string;
  roots: string[];
  sharedDbPath: string;
  autocreate: boolean;
  primary?: {
    id: string;
    dbPath: string;
    source: 'shared' | 'manual' | 'legacy' | 'autocreate';
    accessMode: 'writable' | 'readOnly';
    writerLabel?: string;
  };
}

interface IndexingRules {
  includeGlobsText: string;
  inheritedExcludeDirsText: string;
  inheritedExcludeFilesText: string;
  inheritedExcludeGlobsText: string;
  unrealCoreDirs: string[];
}

interface ProgressItem {
  id: string;
  status: IndexStatus;
  statusMessage: string;
  partial: boolean;
  readOnly: boolean;
  writerLabel?: string;
}

interface PendingMutation {
  id: string;
  section: DraftSection;
  submittedDraft: string;
  requestId: string;
}

const vscode = acquireVsCodeApi();

let workspace: WorkspaceSummary = {
  hash: '',
  roots: [],
  sharedDbPath: '',
  autocreate: false,
};
let indexingRules: IndexingRules = {
  includeGlobsText: '',
  inheritedExcludeDirsText: '',
  inheritedExcludeFilesText: '',
  inheritedExcludeGlobsText: '',
  unrealCoreDirs: [],
};
let allIndexes: IndexListItem[] = [];
let filterText = '';
let selectedInspectorId: string | undefined;
let pendingMutation: PendingMutation | undefined;
let mutationRequestSequence = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const editingRename = new Set<string>();
const dirtyRenameDrafts = new Set<string>();
const dirtyMappingsDrafts = new Set<string>();
const dirtyExclusionDrafts = new Set<string>();
const renameDrafts = new Map<string, string>();
const mappingsDrafts = new Map<string, string>();
const excludeDirsDrafts = new Map<string, string>();
const excludeFilesDrafts = new Map<string, string>();
const excludeGlobsDrafts = new Map<string, string>();

const listEl = document.getElementById('indexList')!;
const workspaceEl = document.getElementById('workspaceSummary')!;
const primaryEl = document.getElementById('primaryIndex')!;
const secondaryEl = document.getElementById('secondaryIndexes')!;
const availableEl = document.getElementById('availableIndexes')!;
const inspectorEl = document.getElementById('indexInspector')!;
const secondaryCountEl = document.getElementById('secondaryCount')!;
const availableCountEl = document.getElementById('availableCount')!;
const filterInput = document.getElementById('filterInput') as HTMLInputElement;
const toastEl = document.getElementById('toast')!;
const useSharedButton = document.getElementById('btnUseShared') as HTMLButtonElement;
const choosePrimaryButton = document.getElementById('btnChoosePrimary') as HTMLButtonElement;
const refreshAllButton = document.getElementById('btnRefreshAll') as HTMLButtonElement;
const attachButton = document.getElementById('btnAttach') as HTMLButtonElement;
const createButton = document.getElementById('btnCreate') as HTMLButtonElement;

createButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'createIndex' });
});

attachButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'browseAndAttach' });
});

refreshAllButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'refreshAll' });
});

useSharedButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'useSharedPrimary' });
});

choosePrimaryButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'selectPrimary' });
});

filterInput.addEventListener('input', () => {
  filterText = filterInput.value.trim().toLowerCase();
  render();
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'indexes') {
    const nextWorkspace = msg.workspace ?? workspace;
    if (workspace.hash && nextWorkspace.hash !== workspace.hash) {
      resetWorkspaceDraftState();
    }
    workspace = nextWorkspace;
    indexingRules = msg.indexingRules ?? indexingRules;
    allIndexes = msg.indexes ?? [];
    seedDrafts(allIndexes);
    pruneDrafts(allIndexes);
    ensureInspectorSelection();
    render();
  } else if (msg.type === 'progress') {
    applyProgress(msg.indexes ?? [], msg.primary);
  } else if (msg.type === 'toast') {
    settlePendingMutation(!!msg.isError, msg.requestId);
    showToast(msg.message, !!msg.isError);
  }
});

vscode.postMessage({ type: 'ready' });

function resetWorkspaceDraftState(): void {
  selectedInspectorId = undefined;
  pendingMutation = undefined;
  editingRename.clear();
  dirtyRenameDrafts.clear();
  dirtyMappingsDrafts.clear();
  dirtyExclusionDrafts.clear();
  renameDrafts.clear();
  mappingsDrafts.clear();
  excludeDirsDrafts.clear();
  excludeFilesDrafts.clear();
  excludeGlobsDrafts.clear();
}

function showToast(message: string, isError: boolean): void {
  if (!message) {
    return;
  }
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = `toast visible ${isError ? 'error' : 'ok'}`;
  toastEl.setAttribute('role', isError ? 'alert' : 'status');
  toastTimer = setTimeout(() => {
    toastEl.className = 'toast';
  }, 5000);
}

function dirtySet(section: DraftSection): Set<string> {
  if (section === 'rename') return dirtyRenameDrafts;
  if (section === 'mappings') return dirtyMappingsDrafts;
  return dirtyExclusionDrafts;
}

function settlePendingMutation(isError: boolean, requestId: unknown): void {
  if (!pendingMutation || requestId !== pendingMutation.requestId) {
    return;
  }
  const { id, section, submittedDraft } = pendingMutation;
  pendingMutation = undefined;
  if (!isError && currentDraftSignature(id, section) === submittedDraft) {
    dirtySet(section).delete(id);
  } else if (section === 'rename') {
    editingRename.add(id);
  }
  render();
}

function nextMutationRequestId(): string {
  mutationRequestSequence += 1;
  return `${Date.now().toString(36)}-${mutationRequestSequence.toString(36)}`;
}

function currentDraftSignature(id: string, section: DraftSection): string {
  if (section === 'rename') {
    return renameDrafts.get(id) ?? '';
  }
  if (section === 'mappings') {
    return mappingsDrafts.get(id) ?? '';
  }
  return JSON.stringify([
    excludeDirsDrafts.get(id) ?? '',
    excludeFilesDrafts.get(id) ?? '',
    excludeGlobsDrafts.get(id) ?? '',
  ]);
}

function seedDrafts(indexes: IndexListItem[]): void {
  for (const item of indexes) {
    if (!dirtyRenameDrafts.has(item.id) && !editingRename.has(item.id)) {
      renameDrafts.set(item.id, item.name);
    }
    if (!dirtyMappingsDrafts.has(item.id)) {
      mappingsDrafts.set(item.id, item.mappingsText);
    }
    if (!dirtyExclusionDrafts.has(item.id)) {
      excludeDirsDrafts.set(item.id, item.excludeDirsText);
      excludeFilesDrafts.set(item.id, item.excludeFilesText);
      excludeGlobsDrafts.set(item.id, item.excludeGlobsText);
    }
  }
}

function pruneDrafts(indexes: IndexListItem[]): void {
  const ids = new Set(indexes.map((item) => item.id));
  for (const id of Array.from(renameDrafts.keys())) {
    if (ids.has(id)) continue;
    editingRename.delete(id);
    dirtyRenameDrafts.delete(id);
    dirtyMappingsDrafts.delete(id);
    dirtyExclusionDrafts.delete(id);
    renameDrafts.delete(id);
    mappingsDrafts.delete(id);
    excludeDirsDrafts.delete(id);
    excludeFilesDrafts.delete(id);
    excludeGlobsDrafts.delete(id);
  }
}

function ensureInspectorSelection(): void {
  if (selectedInspectorId && allIndexes.some((item) => item.id === selectedInspectorId)) {
    return;
  }
  selectedInspectorId =
    allIndexes.find((item) => item.usage === 'primary')?.id ??
    allIndexes.find((item) => item.usage === 'secondary')?.id ??
    allIndexes[0]?.id;
}

function render(): void {
  renderWorkspaceSummary();
  renderIndexes();
}

function renderWorkspaceSummary(): void {
  const primary = workspace.primary;
  const sourceLabels: Record<string, string> = {
    shared: 'Cross-IDE shared',
    manual: 'Manually selected',
    legacy: 'Existing IDE index',
    autocreate: 'code-search.autocreate',
  };
  const roots = workspace.roots.length ? workspace.roots.join('; ') : 'No workspace roots';
  const access = primary
    ? primary.accessMode === 'writable'
      ? 'Writable in this IDE'
      : 'Read-only in this IDE'
    : 'No Primary selected';
  const writerHint = primary?.writerLabel
    ? `<div class="context-note">${esc(primary.writerLabel)} owns the writer lease. This IDE searches the same database read-only and will retry automatically.</div>`
    : '';
  const autocreateHint = workspace.autocreate
    ? '<div class="context-note warning">Primary selection is controlled by <code>code-search.autocreate</code>.</div>'
    : '';

  workspaceEl.innerHTML = `
    <div class="context-main">
      <div>
        <span class="eyebrow">Current workspace</span>
        <div class="context-title">${esc(roots)}</div>
      </div>
      <div class="context-badges">
        <span class="badge ${primary ? 'primary' : 'muted'}">${primary ? 'Primary active' : 'No Primary'}</span>
        ${primary ? `<span class="badge">${esc(access)}</span>` : ''}
        ${primary?.source === 'shared' ? '<span class="badge shared">Shared across IDEs</span>' : ''}
      </div>
    </div>
    <details class="context-details">
      <summary>Database paths and source</summary>
      <div class="context-grid">
        <div><span class="meta-label">Primary source</span><span>${esc(primary ? sourceLabels[primary.source] : 'Not selected')}</span></div>
        <div><span class="meta-label">Primary database</span><span class="path">${esc(primary?.dbPath ?? '—')}</span></div>
        <div><span class="meta-label">Shared database</span><span class="path">${esc(workspace.sharedDbPath || '—')}</span></div>
      </div>
    </details>
    ${writerHint}${autocreateHint}`;

  useSharedButton.hidden = workspace.autocreate || primary?.source === 'shared';
  useSharedButton.disabled = !workspace.sharedDbPath;
  useSharedButton.textContent = primary ? 'Switch to shared Primary' : 'Use shared Primary';
  choosePrimaryButton.hidden = workspace.autocreate;
  choosePrimaryButton.disabled = workspace.autocreate;
}

function matchesFilter(item: IndexListItem): boolean {
  if (!filterText) return true;
  const hay = `${item.displayTitle} ${item.name} ${item.dbPath} ${item.rootDirs.join(' ')}`.toLowerCase();
  return hay.includes(filterText);
}

function renderIndexes(): void {
  const primary = allIndexes.find((item) => item.usage === 'primary');
  const secondaries = allIndexes.filter((item) => item.usage === 'secondary');
  const available = allIndexes.filter((item) => item.usage === 'available');
  const filteredAvailable = available.filter(matchesFilter);

  primaryEl.innerHTML = primary
    ? renderPrimaryCard(primary)
    : '<div class="empty compact">No Primary index is open. Use the shared database or choose an existing index.</div>';
  secondaryEl.innerHTML = secondaries.length
    ? secondaries.map((item) => renderIndexRow(item, 'secondary')).join('')
    : '<div class="empty compact">No Secondary indexes are included.</div>';
  availableEl.innerHTML = filteredAvailable.length
    ? filteredAvailable.map((item) => renderIndexRow(item, 'available')).join('')
    : `<div class="empty compact">${filterText ? 'No matching available indexes.' : 'No other known indexes.'}</div>`;
  secondaryCountEl.textContent = String(secondaries.length);
  availableCountEl.textContent = filterText
    ? `${filteredAvailable.length}/${available.length}`
    : String(available.length);
  refreshAllButton.disabled = ![primary, ...secondaries].some((item) => item?.canRefresh);
  attachButton.disabled = !!pendingMutation;
  createButton.disabled = !!pendingMutation;
  filterInput.disabled = !!pendingMutation;

  renderInspector();

  const bindItems = new Map<string, IndexListItem>();
  for (const item of [primary, ...secondaries, ...filteredAvailable]) {
    if (item) bindItems.set(item.id, item);
  }
  const selected = allIndexes.find((item) => item.id === selectedInspectorId);
  if (selected) bindItems.set(selected.id, selected);
  bindCardEvents(Array.from(bindItems.values()));
  applyPendingUiState();
}

function applyPendingUiState(): void {
  const busy = !!pendingMutation;
  listEl.setAttribute('aria-busy', String(busy));
  const controls = listEl.querySelectorAll('button, input, textarea');
  for (const node of Array.from(controls)) {
    const control = node as HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement;
    if (busy) {
      control.disabled = true;
    }
  }
}

function renderPrimaryCard(item: IndexListItem): string {
  const selected = item.id === selectedInspectorId;
  return `
    <article class="primary-card${selected ? ' selected' : ''}" data-card-id="${esc(item.id)}" aria-label="Primary index ${esc(item.displayTitle)}">
      <div class="item-header">
        <div class="item-main">
          <div class="item-title">${esc(item.displayTitle)}</div>
          <div class="item-subtitle">${esc(item.name)}</div>
        </div>
        <div class="item-badges">${renderBadges(item, 'primary')}</div>
      </div>
      <div class="item-meta">
        ${renderStatus(item)}
        <span><span class="meta-label">Database</span><span class="path">${esc(item.dbPath)}</span></span>
      </div>
      <div class="action-row">${renderActions(item)}</div>
    </article>`;
}

function renderIndexRow(item: IndexListItem, usage: 'secondary' | 'available'): string {
  const selected = item.id === selectedInspectorId;
  const stateClass = item.exists ? '' : ' missing';
  return `
    <article class="index-row ${usage}-row${selected ? ' selected' : ''}${stateClass}" data-card-id="${esc(item.id)}" aria-label="${usage === 'secondary' ? 'Secondary' : 'Available'} index ${esc(item.displayTitle)}">
      <div class="item-main">
        <div class="item-header">
          <div class="item-title">${esc(item.displayTitle)}</div>
          <div class="item-badges">${renderBadges(item, usage)}</div>
        </div>
        <div class="item-subtitle">${esc(item.name)} · ${esc(item.dbPath)}</div>
        <div class="item-meta">${renderStatus(item)}</div>
      </div>
      <div class="action-row">${renderActions(item)}</div>
    </article>`;
}

function renderBadges(item: IndexListItem, usage: IndexUsage): string {
  const badges: string[] = [];
  if (usage === 'primary') badges.push('<span class="badge primary">Primary</span>');
  if (usage === 'secondary') badges.push('<span class="badge secondary">Secondary</span>');
  if (usage === 'available') badges.push('<span class="badge muted">Available</span>');
  if (item.isShared) badges.push('<span class="badge shared">Shared path</span>');
  badges.push(`<span class="badge access-badge" data-access-id="${esc(item.id)}">${esc(accessLabel(item))}</span>`);
  if (item.partial) {
    badges.push(`<span class="badge progress-badge" data-progress-id="${esc(item.id)}">Working</span>`);
  }
  return badges.join('');
}

function renderStatus(item: IndexListItem): string {
  return `<span class="status-line"><span class="status-dot ${statusClass(item.status)}" data-status-dot-id="${esc(item.id)}"></span><span data-status-id="${esc(item.id)}">${esc(item.statusMessage)}</span></span>`;
}

function renderActions(item: IndexListItem): string {
  const actions: string[] = [];
  if (editingRename.has(item.id)) {
    actions.push(`
      <div class="rename-row" data-id="${esc(item.id)}">
        <label class="sr-only" for="rename-${esc(item.id)}">Index name</label>
        <input id="rename-${esc(item.id)}" type="text" class="rename-input" value="${esc(renameDrafts.get(item.id) ?? item.name)}" />
        <button type="button" class="btn btn-primary rename-save" data-id="${esc(item.id)}">Save</button>
        <button type="button" class="btn rename-cancel" data-id="${esc(item.id)}">Cancel</button>
      </div>`);
  } else {
    actions.push(`<button type="button" class="btn btn-quiet rename-start" data-id="${esc(item.id)}">Rename</button>`);
  }
  actions.push(`<button type="button" class="btn settings-select" data-id="${esc(item.id)}" aria-controls="indexInspector" aria-expanded="${item.id === selectedInspectorId}" aria-pressed="${item.id === selectedInspectorId}">Settings</button>`);
  if (item.canRefresh) {
    actions.push(`<button type="button" class="btn refresh-btn" data-id="${esc(item.id)}">Refresh</button>`);
  }
  if (item.usage === 'secondary') {
    actions.push(`<button type="button" class="btn detach-btn" data-id="${esc(item.id)}">Close</button>`);
  }
  if (item.usage === 'available' && item.exists) {
    actions.unshift(`<button type="button" class="btn btn-primary attach-btn" data-id="${esc(item.id)}">Open in search</button>`);
  }
  if (item.usage === 'available') {
    actions.push(`<button type="button" class="btn btn-danger delete-btn" data-id="${esc(item.id)}" title="Permanently delete the database and its index data">Delete</button>`);
  }
  return actions.join('');
}

function renderInspector(): void {
  const item = allIndexes.find((candidate) => candidate.id === selectedInspectorId);
  if (!item) {
    inspectorEl.hidden = true;
    inspectorEl.innerHTML = '';
    return;
  }
  inspectorEl.hidden = false;
  const roots = item.rootDirs.length
    ? item.rootDirs.map((root) => `<div role="listitem">${esc(root)}</div>`).join('')
    : '<div role="listitem">No source roots are stored for this index.</div>';
  const unrealChips = indexingRules.unrealCoreDirs.length
    ? indexingRules.unrealCoreDirs.map((dir) => `<span class="chip ue">${esc(dir)}</span>`).join('')
    : '<span class="setting-help">No Unreal Engine defaults reported.</span>';
  const excludesReadOnly = item.readOnly;
  const readonlyAttr = excludesReadOnly ? ' readonly' : '';
  const excludesDirty = dirtyExclusionDrafts.has(item.id);
  const mappingsDirty = dirtyMappingsDrafts.has(item.id);
  const excludesPending = pendingMutation?.id === item.id && pendingMutation.section === 'excludes';
  const mappingsPending = pendingMutation?.id === item.id && pendingMutation.section === 'mappings';
  const excludeSaveLabel = item.usage === 'available' ? 'Save rules' : 'Save & Reindex';
  const requestedAccess = item.requestedReadOnly ? 'Read-only' : 'Automatic (keep up to date when writer)';
  const effectiveAccess = item.usage === 'available' ? 'Not open in this workspace' : accessLabel(item);
  const writerNote = accessNote(item);

  inspectorEl.innerHTML = `
    <header class="inspector-header">
      <div>
        <span class="eyebrow">Selected index settings</span>
        <h2 id="inspectorHeading">${esc(item.name)}</h2>
        <div class="inspector-title-path">${esc(item.displayTitle)}</div>
      </div>
      <div class="item-badges">${renderBadges(item, item.usage)}</div>
    </header>
    <div class="inspector-body">
      <fieldset class="settings-scope index-content">
        <legend>Index content</legend>
        <p class="setting-help">These rules are used whenever this IDE updates the index. Source roots are shown read-only; create or reopen an index to change them.</p>

        <div class="setting-block">
          <div class="setting-title">Root directories</div>
          <div class="root-list" role="list" aria-label="Root directories">${roots}</div>
        </div>

        <div class="setting-block">
          <div class="setting-title">Inherited indexing rules</div>
          <p class="setting-help">Built-in and workspace rules from this IDE are applied whenever it owns writes; they are shown read-only here.</p>
          <div class="rules-grid">
            <div>
              <span class="meta-label">Inclusion patterns</span>
              ${renderReadonlyRule(indexingRules.includeGlobsText, 'No inherited inclusion patterns')}
            </div>
            <div>
              <span class="meta-label">Unreal Engine core exclusions</span>
              <div class="ue-chips">${unrealChips}</div>
            </div>
          </div>
          <details class="inherited-details">
            <summary>View all inherited exclusion rules</summary>
            <div class="additional-grid">
              <div><span class="meta-label">Directory names</span>${renderReadonlyRule(indexingRules.inheritedExcludeDirsText, 'None')}</div>
              <div><span class="meta-label">File names</span>${renderReadonlyRule(indexingRules.inheritedExcludeFilesText, 'None')}</div>
              <div><span class="meta-label">Path globs</span>${renderReadonlyRule(indexingRules.inheritedExcludeGlobsText, 'None')}</div>
            </div>
          </details>
        </div>

        <div class="setting-block">
          <div class="setting-title-row">
            <div>
              <div class="setting-title">Additional exclusions used by this IDE</div>
              <p class="setting-help">One pattern per line. These are added to the inherited rules above.</p>
            </div>
            <span class="dirty-marker${excludesDirty ? ' visible' : ''}" data-dirty-section="excludes" data-id="${esc(item.id)}">Unsaved</span>
          </div>
          <div class="additional-grid">
            <label class="field-label">Additional directory names
              <textarea class="exclude-dirs" data-id="${esc(item.id)}"${readonlyAttr}>${esc(excludeDirsDrafts.get(item.id) ?? '')}</textarea>
            </label>
            <label class="field-label">Additional file names
              <textarea class="exclude-files" data-id="${esc(item.id)}"${readonlyAttr}>${esc(excludeFilesDrafts.get(item.id) ?? '')}</textarea>
            </label>
            <label class="field-label">Additional path globs
              <textarea class="exclude-globs" data-id="${esc(item.id)}"${readonlyAttr}>${esc(excludeGlobsDrafts.get(item.id) ?? '')}</textarea>
            </label>
          </div>
          <div class="setting-footer">
            <span class="setting-help">${excludesReadOnly ? 'Additional exclusions cannot be changed while this index is read-only.' : 'Saving updates the rules and starts a full refresh of an active index.'}</span>
            <button type="button" class="btn btn-primary excludes-save" data-id="${esc(item.id)}" data-save-section="excludes"${excludesReadOnly || !excludesDirty || excludesPending ? ' disabled' : ''}>${excludesPending ? 'Saving...' : excludeSaveLabel}</button>
          </div>
        </div>
      </fieldset>

      <fieldset class="settings-scope workspace-binding">
        <legend>This workspace</legend>
        <p class="setting-help">Mappings affect paths shown in this workspace. Access reports how this IDE opened the database.</p>
        <div class="workspace-grid">
          <div class="setting-block">
            <div class="setting-title-row">
              <div class="setting-title">Directory mapping</div>
              <span class="dirty-marker${mappingsDirty ? ' visible' : ''}" data-dirty-section="mappings" data-id="${esc(item.id)}">Unsaved</span>
            </div>
            <p class="setting-help">One mapping per line: <code>indexed path =&gt; local path</code>.</p>
            <label class="field-label">
              <span class="sr-only">Directory mappings</span>
              <textarea class="mappings" data-id="${esc(item.id)}">${esc(mappingsDrafts.get(item.id) ?? '')}</textarea>
            </label>
            <div class="setting-footer">
              <span class="setting-help">Mappings do not rebuild the database.</span>
              <button type="button" class="btn btn-primary mappings-save" data-id="${esc(item.id)}" data-save-section="mappings"${!mappingsDirty || mappingsPending ? ' disabled' : ''}>${mappingsPending ? 'Saving...' : 'Save mapping'}</button>
            </div>
          </div>
          <div class="access-panel">
            <span class="meta-label">Requested access</span>
            <div class="access-value">${esc(requestedAccess)}</div>
            <span class="meta-label">Effective access</span>
            <div class="access-value" data-access-id="${esc(item.id)}">${esc(effectiveAccess)}</div>
            <div class="access-note" data-writer-id="${esc(item.id)}">${esc(writerNote)}</div>
            <span class="meta-label">Database</span>
            <span class="path">${esc(item.dbPath)}</span>
          </div>
        </div>
      </fieldset>
    </div>`;
}

function renderReadonlyRule(text: string, emptyText: string): string {
  return `<pre class="readonly-rule" aria-readonly="true">${esc(text || emptyText)}</pre>`;
}

function bindCardEvents(items: IndexListItem[]): void {
  for (const item of items) {
    const id = item.id;
    const select = (selector: string) => listEl.querySelector(`${selector}[data-id="${cssEsc(id)}"]`);

    select('.settings-select')?.addEventListener('click', () => {
      selectedInspectorId = id;
      renderIndexes();
      inspectorEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    select('.rename-start')?.addEventListener('click', () => {
      editingRename.add(id);
      renderIndexes();
      const input = select('.rename-row')?.querySelector('.rename-input') as HTMLInputElement | null;
      input?.focus();
      input?.select();
    });
    const renameRow = select('.rename-row');
    const renameInput = renameRow?.querySelector('.rename-input') as HTMLInputElement | null;
    renameInput?.addEventListener('input', () => {
      renameDrafts.set(id, renameInput.value);
      dirtyRenameDrafts.add(id);
    });
    renameInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        (renameRow?.querySelector('.rename-save') as HTMLButtonElement | null)?.click();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        (renameRow?.querySelector('.rename-cancel') as HTMLButtonElement | null)?.click();
      }
    });
    renameRow?.querySelector('.rename-cancel')?.addEventListener('click', () => {
      editingRename.delete(id);
      dirtyRenameDrafts.delete(id);
      renameDrafts.set(id, item.name);
      renderIndexes();
    });
    renameRow?.querySelector('.rename-save')?.addEventListener('click', () => {
      const requestId = nextMutationRequestId();
      pendingMutation = {
        id,
        section: 'rename',
        submittedDraft: currentDraftSignature(id, 'rename'),
        requestId,
      };
      vscode.postMessage({ type: 'rename', id, name: renameInput?.value ?? item.name, requestId });
      editingRename.delete(id);
      renderIndexes();
    });
    select('.refresh-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'refreshIndex', id }));
    select('.attach-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'attach', id }));
    select('.detach-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'detach', id }));
    select('.delete-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'delete', id }));

    const mappings = select('.mappings') as HTMLTextAreaElement | null;
    mappings?.addEventListener('input', () => {
      mappingsDrafts.set(id, mappings.value);
      dirtyMappingsDrafts.add(id);
      updateDirtyControls(id, 'mappings');
    });
    select('.mappings-save')?.addEventListener('click', () => {
      const requestId = nextMutationRequestId();
      pendingMutation = {
        id,
        section: 'mappings',
        submittedDraft: currentDraftSignature(id, 'mappings'),
        requestId,
      };
      vscode.postMessage({ type: 'setMappings', id, text: mappings?.value ?? '', requestId });
      renderIndexes();
    });

    const dirs = select('.exclude-dirs') as HTMLTextAreaElement | null;
    const files = select('.exclude-files') as HTMLTextAreaElement | null;
    const globs = select('.exclude-globs') as HTMLTextAreaElement | null;
    const markExclusionsDirty = () => {
      if (dirs) excludeDirsDrafts.set(id, dirs.value);
      if (files) excludeFilesDrafts.set(id, files.value);
      if (globs) excludeGlobsDrafts.set(id, globs.value);
      dirtyExclusionDrafts.add(id);
      updateDirtyControls(id, 'excludes');
    };
    dirs?.addEventListener('input', markExclusionsDirty);
    files?.addEventListener('input', markExclusionsDirty);
    globs?.addEventListener('input', markExclusionsDirty);
    select('.excludes-save')?.addEventListener('click', () => {
      const requestId = nextMutationRequestId();
      pendingMutation = {
        id,
        section: 'excludes',
        submittedDraft: currentDraftSignature(id, 'excludes'),
        requestId,
      };
      vscode.postMessage({
        type: 'setExcludeRules',
        id,
        dirsText: dirs?.value ?? '',
        filesText: files?.value ?? '',
        globsText: globs?.value ?? '',
        requestId,
      });
      renderIndexes();
    });
  }
}

function updateDirtyControls(id: string, section: DraftSection): void {
  if (section === 'rename') {
    return;
  }
  const dirty = dirtySet(section).has(id);
  const pending = pendingMutation?.id === id && pendingMutation.section === section;
  const marker = listEl.querySelector(`[data-dirty-section="${section}"][data-id="${cssEsc(id)}"]`);
  marker?.classList.toggle('visible', dirty);
  const button = listEl.querySelector(`[data-save-section="${section}"][data-id="${cssEsc(id)}"]`) as HTMLButtonElement | null;
  if (button) {
    const item = allIndexes.find((candidate) => candidate.id === id);
    button.disabled = pending || !dirty || (section === 'excludes' && !!item?.readOnly);
    const excludeLabel = item?.usage === 'available' ? 'Save rules' : 'Save & Reindex';
    button.textContent = pending ? 'Saving...' : section === 'excludes' ? excludeLabel : 'Save mapping';
  }
}

function applyProgress(items: ProgressItem[], primary: WorkspaceSummary['primary']): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  let selectedAccessChanged = false;
  for (const index of allIndexes) {
    const update = byId.get(index.id);
    if (!update) continue;
    if (
      index.id === selectedInspectorId &&
      (index.readOnly !== update.readOnly || index.writerLabel !== update.writerLabel)
    ) {
      selectedAccessChanged = true;
    }
    index.status = update.status;
    index.statusMessage = update.statusMessage;
    index.partial = update.partial;
    index.readOnly = update.readOnly;
    index.writerLabel = update.writerLabel;

    for (const statusNode of Array.from(listEl.querySelectorAll(`[data-status-id="${cssEsc(index.id)}"]`))) {
      statusNode.textContent = update.statusMessage;
    }
    for (const dotNode of Array.from(listEl.querySelectorAll(`[data-status-dot-id="${cssEsc(index.id)}"]`))) {
      dotNode.className = `status-dot ${statusClass(update.status)}`;
    }
    for (const accessNode of Array.from(listEl.querySelectorAll(`[data-access-id="${cssEsc(index.id)}"]`))) {
      accessNode.textContent = index.usage === 'available' ? 'Not open in this workspace' : accessLabel(index);
    }
    for (const writerNode of Array.from(listEl.querySelectorAll(`[data-writer-id="${cssEsc(index.id)}"]`))) {
      writerNode.textContent = accessNote(index);
    }
    const progressNodes = Array.from(
      listEl.querySelectorAll(`[data-progress-id="${cssEsc(index.id)}"]`)
    );
    if (update.partial && progressNodes.length === 0) {
      const badges = listEl
        .querySelector(`[data-card-id="${cssEsc(index.id)}"]`)
        ?.querySelector('.item-badges');
      if (badges) {
        const progressNode = document.createElement('span');
        progressNode.className = 'badge progress-badge';
        progressNode.setAttribute('data-progress-id', index.id);
        progressNode.textContent = 'Working';
        badges.appendChild(progressNode);
      }
    } else if (!update.partial) {
      for (const progressNode of progressNodes) progressNode.remove();
    }
  }
  if (primary) workspace.primary = primary;
  renderWorkspaceSummary();
  if (selectedAccessChanged) {
    renderIndexes();
  }
}

function accessLabel(item: IndexListItem): string {
  if (item.usage === 'available') {
    return item.requestedReadOnly ? 'Read-only config' : 'Automatic access';
  }
  if (!item.readOnly) return 'Writable';
  if (!item.requestedReadOnly) return item.writerLabel ? `Reader · ${item.writerLabel} writes` : 'Reader · writer busy';
  return 'Read-only';
}

function accessNote(item: IndexListItem): string {
  if (item.writerLabel) {
    return `${item.writerLabel} currently owns writes. This IDE is using the shared database as a reader.`;
  }
  if (item.requestedReadOnly) {
    return 'This index was explicitly opened read-only.';
  }
  return 'Automatic mode uses a writer lease and falls back to a reader when another IDE owns it.';
}

function statusClass(status: IndexStatus): string {
  switch (status) {
    case 'idle':
    case 'scanning':
    case 'indexing':
    case 'upToDate':
    case 'available':
    case 'missing':
      return status;
  }
}

function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cssEsc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
