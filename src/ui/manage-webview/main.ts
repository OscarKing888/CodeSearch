declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

interface DirectoryMapping {
  from: string;
  to: string;
}

interface IndexListItem {
  id: string;
  name: string;
  displayTitle: string;
  dbPath: string;
  rootDirs: string[];
  readOnly: boolean;
  isPrimary: boolean;
  isAttached: boolean;
  directoryMappings: DirectoryMapping[];
  mappingsText: string;
  excludeDirsText: string;
  excludeFilesText: string;
  excludeGlobsText: string;
  statusMessage: string;
  partial: boolean;
}

const vscode = acquireVsCodeApi();

let allIndexes: IndexListItem[] = [];
let filterText = '';
const expandedMappings = new Set<string>();
const expandedExcludes = new Set<string>();
const editingRename = new Set<string>();

const listEl = document.getElementById('indexList')!;
const filterInput = document.getElementById('filterInput') as HTMLInputElement;
const toastEl = document.getElementById('toast')!;

document.getElementById('btnCreate')!.addEventListener('click', () => {
  vscode.postMessage({ type: 'createIndex' });
});

document.getElementById('btnAttach')!.addEventListener('click', () => {
  vscode.postMessage({ type: 'browseAndAttach' });
});

document.getElementById('btnRefreshAll')!.addEventListener('click', () => {
  vscode.postMessage({ type: 'refreshAll' });
});

filterInput.addEventListener('input', () => {
  filterText = filterInput.value.trim().toLowerCase();
  render();
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'indexes') {
    allIndexes = msg.indexes ?? [];
    render();
  } else if (msg.type === 'toast') {
    showToast(msg.message, msg.isError);
  }
});

vscode.postMessage({ type: 'ready' });

function showToast(message: string, isError: boolean): void {
  if (!message) {
    return;
  }
  toastEl.textContent = message;
  toastEl.className = `toast visible ${isError ? 'error' : 'ok'}`;
  setTimeout(() => {
    toastEl.className = 'toast';
  }, 4000);
}

function matchesFilter(item: IndexListItem): boolean {
  if (!filterText) {
    return true;
  }
  const hay = `${item.displayTitle} ${item.name} ${item.dbPath} ${item.rootDirs.join(' ')}`.toLowerCase();
  return hay.includes(filterText);
}

function render(): void {
  const filtered = allIndexes.filter(matchesFilter);
  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="empty">No indexes found</div>';
    return;
  }

  listEl.innerHTML = filtered.map((item) => renderCard(item)).join('');
  bindCardEvents(filtered);
}

function renderCard(item: IndexListItem): string {
  const badges: string[] = [];
  if (item.isPrimary) {
    badges.push('<span class="badge primary">Primary</span>');
  } else {
    badges.push('<span class="badge secondary">Secondary</span>');
  }
  badges.push(`<span class="badge">${item.readOnly ? 'Read-only' : 'Writable'}</span>`);
  if (item.isAttached && !item.isPrimary) {
    badges.push('<span class="badge">Attached</span>');
  }
  if (item.partial) {
    badges.push('<span class="badge">Indexing</span>');
  }

  const mappingsExpanded = expandedMappings.has(item.id);
  const excludesExpanded = expandedExcludes.has(item.id);
  const renameEditing = editingRename.has(item.id);

  let actions = '';
  if (renameEditing) {
    actions += `
      <div class="rename-row" data-id="${esc(item.id)}">
        <input type="text" class="rename-input" value="${esc(item.name)}" />
        <button class="btn btn-primary rename-save">Save</button>
        <button class="btn rename-cancel">Cancel</button>
      </div>`;
  } else {
    actions += `<button class="btn rename-start" data-id="${esc(item.id)}">Rename</button>`;
  }

  if (!item.readOnly) {
    actions += `<button class="btn move-btn" data-id="${esc(item.id)}">Move DB</button>`;
    actions += `<button class="btn refresh-btn" data-id="${esc(item.id)}">Refresh</button>`;
  }

  actions += `<button class="btn mappings-toggle" data-id="${esc(item.id)}">Directory Mappings</button>`;
  actions += `<button class="btn excludes-toggle" data-id="${esc(item.id)}">Exclude Rules</button>`;

  if (!item.isPrimary) {
    if (item.isAttached) {
      actions += `<button class="btn detach-btn" data-id="${esc(item.id)}">Detach</button>`;
    } else {
      actions += `<button class="btn attach-btn" data-id="${esc(item.id)}">Attach</button>`;
    }
    actions += `<button class="btn btn-danger delete-btn" data-id="${esc(item.id)}">Delete</button>`;
  }

  let mappingsBlock = '';
  if (mappingsExpanded) {
    mappingsBlock = `
      <div class="mappings-label">One mapping per line: from => to</div>
      <textarea class="mappings" data-id="${esc(item.id)}">${esc(item.mappingsText)}</textarea>
      <button class="btn btn-primary mappings-save" data-id="${esc(item.id)}">Save Mappings</button>`;
  }

  let excludesBlock = '';
  if (excludesExpanded) {
    const readonlyAttr = item.readOnly ? 'readonly' : '';
    const saveBtn = item.readOnly
      ? ''
      : `<button class="btn btn-primary excludes-save" data-id="${esc(item.id)}">Save Exclude Rules</button>`;
    excludesBlock = `
      <div class="mappings-label">Per-index exclude rules (appended to global settings). One pattern per line; # for comments. Supports wildcards (*).</div>
      <div class="exclude-block">
        <div class="mappings-label">Directory names (any depth)</div>
        <div class="exclude-hint">e.g. Intermediate, .vscode, Derived*</div>
        <textarea class="exclude-dirs" data-id="${esc(item.id)}" ${readonlyAttr}>${esc(item.excludeDirsText)}</textarea>
      </div>
      <div class="exclude-block">
        <div class="mappings-label">File names</div>
        <div class="exclude-hint">e.g. *.pdb, package-lock.json</div>
        <textarea class="exclude-files" data-id="${esc(item.id)}" ${readonlyAttr}>${esc(item.excludeFilesText)}</textarea>
      </div>
      <div class="exclude-block">
        <div class="mappings-label">Path globs</div>
        <div class="exclude-hint">e.g. **/custom-build/**</div>
        <textarea class="exclude-globs" data-id="${esc(item.id)}" ${readonlyAttr}>${esc(item.excludeGlobsText)}</textarea>
      </div>
      ${saveBtn}`;
  }

  return `
    <div class="card" data-id="${esc(item.id)}">
      <div class="card-header">
        <span class="card-title">${esc(item.displayTitle)}</span>
        ${badges.join('')}
      </div>
      <div class="meta">DB: ${esc(item.dbPath)}</div>
      <div class="meta">Name: ${esc(item.name)}</div>
      <div class="meta">Status: ${esc(item.statusMessage)}</div>
      <div class="actions">${actions}</div>
      ${mappingsBlock}
      ${excludesBlock}
    </div>`;
}

function bindCardEvents(items: IndexListItem[]): void {
  for (const item of items) {
    const id = item.id;

    listEl.querySelector(`.rename-start[data-id="${cssEsc(id)}"]`)?.addEventListener('click', () => {
      editingRename.add(id);
      render();
    });

    const renameRow = listEl.querySelector(`.rename-row[data-id="${cssEsc(id)}"]`);
    renameRow?.querySelector('.rename-cancel')?.addEventListener('click', () => {
      editingRename.delete(id);
      render();
    });
    renameRow?.querySelector('.rename-save')?.addEventListener('click', () => {
      const input = renameRow.querySelector('.rename-input') as HTMLInputElement;
      vscode.postMessage({ type: 'rename', id, name: input.value });
      editingRename.delete(id);
    });

    listEl.querySelector(`.move-btn[data-id="${cssEsc(id)}"]`)?.addEventListener('click', () => {
      vscode.postMessage({ type: 'moveIndex', id });
    });

    listEl.querySelector(`.refresh-btn[data-id="${cssEsc(id)}"]`)?.addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshIndex', id });
    });

    listEl.querySelector(`.mappings-toggle[data-id="${cssEsc(id)}"]`)?.addEventListener('click', () => {
      if (expandedMappings.has(id)) {
        expandedMappings.delete(id);
      } else {
        expandedMappings.add(id);
      }
      render();
    });

    listEl.querySelector(`.mappings-save[data-id="${cssEsc(id)}"]`)?.addEventListener('click', () => {
      const ta = listEl.querySelector(`textarea.mappings[data-id="${cssEsc(id)}"]`) as HTMLTextAreaElement;
      vscode.postMessage({ type: 'setMappings', id, text: ta.value });
    });

    listEl.querySelector(`.excludes-toggle[data-id="${cssEsc(id)}"]`)?.addEventListener('click', () => {
      if (expandedExcludes.has(id)) {
        expandedExcludes.delete(id);
      } else {
        expandedExcludes.add(id);
      }
      render();
    });

    listEl.querySelector(`.excludes-save[data-id="${cssEsc(id)}"]`)?.addEventListener('click', () => {
      const dirsTa = listEl.querySelector(`textarea.exclude-dirs[data-id="${cssEsc(id)}"]`) as HTMLTextAreaElement;
      const filesTa = listEl.querySelector(`textarea.exclude-files[data-id="${cssEsc(id)}"]`) as HTMLTextAreaElement;
      const globsTa = listEl.querySelector(`textarea.exclude-globs[data-id="${cssEsc(id)}"]`) as HTMLTextAreaElement;
      vscode.postMessage({
        type: 'setExcludeRules',
        id,
        dirsText: dirsTa.value,
        filesText: filesTa.value,
        globsText: globsTa.value,
      });
    });

    listEl.querySelector(`.attach-btn[data-id="${cssEsc(id)}"]`)?.addEventListener('click', () => {
      vscode.postMessage({ type: 'attach', id });
    });

    listEl.querySelector(`.detach-btn[data-id="${cssEsc(id)}"]`)?.addEventListener('click', () => {
      vscode.postMessage({ type: 'detach', id });
    });

    listEl.querySelector(`.delete-btn[data-id="${cssEsc(id)}"]`)?.addEventListener('click', () => {
      vscode.postMessage({ type: 'delete', id });
    });
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cssEsc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
