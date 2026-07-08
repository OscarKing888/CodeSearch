import * as vscode from 'vscode';
import { getConfig } from '../config';
import { isBinaryExtension } from '../index/FileScanner';
import { IndexManager } from '../index/IndexManager';
import { MultiIndexSearchService, MultiSearchResult, getRelativePath } from '../search/MultiIndexSearchService';
import { createRegistry, highlightHits } from '../utils/syntaxHighlight';

const UI_CONTEXT_LINES_KEY = 'codeSearch.ui.contextLines';
const CONTEXT_LINES_MIN = 0;
const CONTEXT_LINES_MAX = 10;

export class SearchPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codeSearch.panel';

  private view: vscode.WebviewView | undefined;
  private pendingQuery: string | undefined;
  private pendingMode: 'search' | 'file' | undefined;
  private pendingNewTab = false;
  private pendingFocus = false;
  private webviewReady = false;
  private webviewReadyWaiters: Array<() => void> = [];
  private panelVisible = false;
  private panelWebviewFocused = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private indexManager: IndexManager,
    private searchService: MultiIndexSearchService,
    private workspaceRoots: string[],
    private readonly context: vscode.ExtensionContext
  ) {}

  rebind(
    indexManager: IndexManager,
    searchService: MultiIndexSearchService,
    workspaceRoots: string[]
  ): void {
    this.indexManager = indexManager;
    this.searchService = searchService;
    this.workspaceRoots = workspaceRoots;
    this.sendIndexStatus();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.onDidChangeVisibility((visible) => {
      this.panelVisible = visible;
      if (!visible) {
        this.panelWebviewFocused = false;
      }
      this.updatePanelFocusContext();
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'panelFocus':
          this.panelWebviewFocused = Boolean(msg.focused);
          this.updatePanelFocusContext();
          break;
        case 'ready':
          this.webviewReady = true;
          this.resolveWebviewReadyWaiters();
          this.sendIndexStatus();
          this.sendInitConfig();
          this.flushPendingUi();
          break;
        case 'search':
          await this.runSearch(
            msg.query,
            msg.caseSensitive,
            msg.phraseSearch,
            msg.fuzzy,
            msg.loose,
            msg.tabId,
            msg.newTab,
            msg.showContext,
            msg.contextLines
          );
          break;
        case 'saveSecondaries':
          await this.context.workspaceState.update(
            'secondaryIndexIds',
            this.indexManager.getWorkspaceSecondaryIds()
          );
          break;
        case 'autocomplete':
          this.handleAutocomplete(msg.prefix ?? '');
          break;
        case 'openFile':
          if (msg.path) {
            await this.openHitAt(msg.path, msg.line ?? 1, msg.column ?? 1, msg.preview ?? true);
          }
          break;
        case 'refreshIndex':
          await vscode.commands.executeCommand('codeSearch.refreshIndex');
          break;
        case 'manageIndexes':
          await vscode.commands.executeCommand('codeSearch.manageIndexes');
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('codeSearch.openSettings');
          break;
        case 'setContextLines':
          await this.setUiContextLines(Number(msg.contextLines));
          break;
        case 'copyToClipboard':
          if (typeof msg.text === 'string') {
            await vscode.env.clipboard.writeText(msg.text);
          }
          break;
      }
    });

    this.indexManager.on('progress', () => this.sendIndexStatus());
    this.indexManager.on('indexesChanged', () => this.sendIndexStatus());
  }

  searchInNewTab(): void {
    this.postMessage({ type: 'newTab' });
    void this.focus();
  }

  private resolveWebviewReadyWaiters(): void {
    const waiters = this.webviewReadyWaiters;
    this.webviewReadyWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private waitForWebviewReady(timeoutMs = 8000): Promise<boolean> {
    if (this.webviewReady && this.view?.webview) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.webviewReadyWaiters.push(() => {
        clearTimeout(timer);
        resolve(this.webviewReady && !!this.view?.webview);
      });
    });
  }

  private async ensureWebviewReady(): Promise<boolean> {
    await this.revealPanel();
    if (!this.view) {
      await vscode.commands.executeCommand(`${SearchPanelProvider.viewType}.focus`);
    }
    return this.waitForWebviewReady();
  }

  private flushPendingUi(): void {
    if (this.pendingNewTab) {
      this.postMessage({ type: 'newTab' });
      this.pendingNewTab = false;
    }
    if (this.pendingQuery !== undefined) {
      const q = this.pendingQuery;
      const mode = this.pendingMode ?? 'search';
      this.pendingQuery = undefined;
      this.pendingMode = undefined;
      if (mode === 'file') {
        void this.runSearch(`file:${q}`);
      } else {
        void this.runSearch(q);
      }
      this.postMessage({ type: 'setQuery', query: mode === 'file' ? `file:${q}` : q });
    }
    if (this.pendingFocus) {
      this.pendingFocus = false;
      this.view?.show?.(false);
      this.postMessage({ type: 'focus' });
    }
  }

  private async focusSearchInput(): Promise<void> {
    const ready = await this.ensureWebviewReady();
    if (!ready) {
      this.pendingFocus = true;
      return;
    }
    this.view?.show?.(false);
    this.postMessage({ type: 'focus' });
  }

  private async revealPanel(): Promise<void> {
    if (this.view) {
      this.view.show(true);
      return;
    }

    try {
      await vscode.commands.executeCommand(`${SearchPanelProvider.viewType}.focus`, {
        preserveFocus: true,
      });
    } catch {
      try {
        await vscode.commands.executeCommand('workbench.view.extension.codeSearch');
      } catch {
        // Some hosts (e.g. Cursor) may not expose all workbench panel commands.
      }
    }
  }

  async focus(): Promise<void> {
    await this.focusSearchInput();
  }

  async setQuery(query: string, mode: 'search' | 'file' = 'search', newTab = false): Promise<void> {
    if (this.webviewReady && this.view?.webview) {
      if (newTab) {
        this.postMessage({ type: 'newTab' });
      }
      if (mode === 'file') {
        void this.runSearch(`file:${query}`);
      } else {
        void this.runSearch(query);
      }
      this.postMessage({ type: 'setQuery', query: mode === 'file' ? `file:${query}` : query });
      await this.focusSearchInput();
      return;
    }

    this.pendingQuery = query;
    this.pendingMode = mode;
    this.pendingNewTab = newTab;
    this.pendingFocus = true;
    await this.ensureWebviewReady();
  }

  async runSearch(
    query: string,
    caseSensitive?: boolean,
    phraseSearch?: boolean,
    fuzzy?: boolean,
    loose?: boolean,
    tabId?: string,
    _newTab?: boolean,
    showContext?: boolean,
    contextLines?: number
  ): Promise<MultiSearchResult | undefined> {
    const config = getConfig();
    const effectiveContextLines = contextLines ?? this.getUiContextLines();
    const result = this.searchService.search(query, {
      caseSensitive: caseSensitive ?? false,
      phraseSearch: phraseSearch ?? config.phraseSearchDefault,
      contextLines: showContext ? effectiveContextLines : 0,
      maxResults: config.maxResults,
      fuzzy: fuzzy ?? config.fuzzySearchDefault,
      loose: loose ?? false,
      looseGap: config.looseGapDefault,
    });

    let highlighted;
    try {
      const reg = await createRegistry(this.extensionUri);
      highlighted = await highlightHits(
        result.hits.map((h) => ({
          lineText: h.lineText,
          path: h.localPath ?? h.path,
          matchStart: h.matchStart,
          matchEnd: h.matchEnd,
        })),
        reg
      );
    } catch {
      highlighted = result.hits.map((h) => ({
        tokens: [{ text: h.lineText }],
        matchStart: h.matchStart,
        matchEnd: h.matchEnd,
      }));
    }

    const payload = {
      type: 'results' as const,
      tabId,
      result: {
        ...result,
        hits: result.hits.map((h, i) => ({
          ...h,
          relativePath: getRelativePath(h.localPath, this.workspaceRoots),
          indexLabel: h.indexName,
          highlighted: highlighted[i],
        })),
      },
    };

    this.postMessage(payload);

    if (config.autoOpenSingleHit && result.hitCount === 1 && result.hits[0]) {
      const hit = result.hits[0];
      await this.openHitAt(hit.localPath ?? hit.path, hit.line, hit.column, true);
    }

    return result;
  }

  nextHit(): void {
    this.postMessage({ type: 'navigateHit', direction: 'next' });
  }

  prevHit(): void {
    this.postMessage({ type: 'navigateHit', direction: 'prev' });
  }

  private async openHitAt(
    path: string,
    line: number,
    column: number,
    preview: boolean
  ): Promise<void> {
    if (isBinaryExtension(path)) {
      void vscode.window.showWarningMessage(`Ace Code Search: 无法打开二进制文件 ${path}`);
      return;
    }
    const uri = vscode.Uri.file(path);
    const doc = await vscode.workspace.openTextDocument(uri);
    const options: vscode.TextDocumentShowOptions = {
      selection: new vscode.Range(line - 1, column - 1, line - 1, column - 1),
      viewColumn: vscode.ViewColumn.Active,
      preview,
    };
    await vscode.window.showTextDocument(doc, options);
  }

  sendIndexStatus(): void {
    const combined = this.indexManager.getCombinedProgress();
    const attached = this.indexManager.getAttachedIndexes().map((a) => a.meta.name);
    this.postMessage({
      type: 'indexStatus',
      progress: { message: combined.message, partial: combined.partial },
      secondaryIndexes: attached,
    });
  }

  private getUiContextLines(): number {
    const stored = this.context.globalState.get<number>(UI_CONTEXT_LINES_KEY);
    if (stored !== undefined) {
      return Math.max(CONTEXT_LINES_MIN, Math.min(CONTEXT_LINES_MAX, stored));
    }
    return getConfig().contextLines;
  }

  private async setUiContextLines(lines: number): Promise<void> {
    const clamped = Math.max(CONTEXT_LINES_MIN, Math.min(CONTEXT_LINES_MAX, lines));
    await this.context.globalState.update(UI_CONTEXT_LINES_KEY, clamped);
    this.postMessage({ type: 'init', contextLines: clamped });
  }

  private sendInitConfig(): void {
    this.postMessage({ type: 'init', contextLines: this.getUiContextLines() });
  }

  private updatePanelFocusContext(): void {
    void vscode.commands.executeCommand(
      'setContext',
      'codeSearch.panel.focus',
      this.panelVisible && this.panelWebviewFocused
    );
  }

  private handleAutocomplete(prefix: string): void {
    const suggestions = this.indexManager.getTokenSuggestions(prefix, 20);
    this.postMessage({ type: 'autocomplete', prefix, suggestions });
  }

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'main.js')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ace Code Search</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .search-wrap {
      flex: 1;
      position: relative;
      min-width: 0;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
    }
    .search-wrap:focus-within {
      border-color: var(--vscode-focusBorder);
    }
    .search-highlight {
      position: absolute;
      inset: 0;
      padding: 4px 8px;
      pointer-events: none;
      white-space: pre;
      overflow: hidden;
      font-family: inherit;
      font-size: inherit;
      color: transparent;
    }
    .search-highlight .filter-include { color: #4ec9b0; -webkit-text-fill-color: #4ec9b0; }
    .search-highlight .filter-exclude { color: #f44747; -webkit-text-fill-color: #f44747; }
    .search-highlight .loose { color: #c586c0; -webkit-text-fill-color: #c586c0; }
    .search-highlight .quoted { color: #ce9178; -webkit-text-fill-color: #ce9178; }
    .search-highlight .term { color: var(--vscode-input-foreground); -webkit-text-fill-color: var(--vscode-input-foreground); }
    .search-input {
      width: 100%;
      padding: 4px 8px;
      background: transparent;
      color: var(--vscode-input-foreground);
      border: none;
      border-radius: 2px;
      font-family: inherit;
      font-size: inherit;
      outline: none;
      position: relative;
      z-index: 1;
    }
    .autocomplete {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      z-index: 10;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      max-height: 200px;
      overflow-y: auto;
      display: none;
    }
    .autocomplete.visible { display: block; }
    .autocomplete-item {
      padding: 4px 8px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      justify-content: space-between;
    }
    .autocomplete-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .autocomplete-item.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .autocomplete-freq {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }
    .btn {
      padding: 4px 8px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: 12px;
      min-width: 28px;
    }
    .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .btn:disabled:hover { background: var(--vscode-button-secondaryBackground); }
    .btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .ctx-lines-wrap {
      display: flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }
    .btn-narrow {
      min-width: 22px;
      padding: 4px 4px;
    }
    .status-bar {
      display: flex;
      justify-content: space-between;
      padding: 4px 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .results {
      flex: 1;
      overflow-y: auto;
      padding: 0;
    }
    .results-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      --cs-col-path: 100px;
      --cs-col-line: 44px;
    }
    .results-table col.col-path {
      width: var(--cs-col-path);
    }
    .results-table col.col-line {
      width: var(--cs-col-line);
    }
    .results-table th {
      position: relative;
      padding: 4px 8px;
      text-align: left;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      overflow: visible;
    }
    .results-table th.col-line {
      text-align: right;
    }
    .col-header-label {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      padding-right: 6px;
    }
    .col-resizer {
      position: absolute;
      top: 0;
      right: -3px;
      width: 8px;
      height: 100%;
      cursor: col-resize;
      z-index: 3;
      touch-action: none;
    }
    .col-resizer:hover,
    body.col-resizing .col-resizer {
      background: var(--vscode-focusBorder);
    }
    body.col-resizing {
      cursor: col-resize;
      user-select: none;
    }
    .results-table thead {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--vscode-editor-background);
    }
    .results-table th:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-list-hoverBackground);
    }
    .results-table td {
      padding: 2px 8px;
      vertical-align: top;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .col-path {
      font-size: 11px;
      color: var(--vscode-textLink-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .col-line {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .results-table td.col-line {
      text-align: right;
    }
    .col-code {
      width: auto;
    }
    .hit-row {
      cursor: pointer;
    }
    .hit-row:hover,
    .hit-context-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .hit-row.selected,
    .hit-context-row.selected {
      background: var(--vscode-list-activeSelectionBackground);
    }
    .hit-line {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      white-space: pre;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .hit-context-row td.col-code {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
      white-space: pre;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .match-highlight {
      background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
      border-bottom: 1px solid var(--vscode-editor-findMatchBorder, #ea5c00);
    }
    .empty {
      padding: 16px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .filter-ext { color: #4ec9b0; }
    .filter-dir { color: #4ec9b0; }
    .filter-file { color: #4ec9b0; }
    .filter-exclude { color: #f44747; }
    .tab-bar {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 2px 6px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      overflow-x: auto;
    }
    .tab {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
      border-radius: 3px;
      white-space: nowrap;
      max-width: 140px;
      overflow: hidden;
    }
    .tab-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tab:hover { background: var(--vscode-list-hoverBackground); }
    .tab.active { background: var(--vscode-list-activeSelectionBackground); }
    .tab-close, .tab-lock, .tab-new {
      flex-shrink: 0;
      padding: 2px 6px;
      font-size: 11px;
      cursor: pointer;
      opacity: 0.7;
    }
    .tab-close:hover, .tab-lock:hover, .tab-new:hover { opacity: 1; }
    .index-badge {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-left: 4px;
    }
    .result-context-menu {
      position: fixed;
      z-index: 100;
      display: none;
      min-width: 120px;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      border-radius: 3px;
      padding: 2px 0;
    }
    .result-context-menu.visible {
      display: block;
    }
    .result-context-menu-item {
      display: block;
      width: 100%;
      padding: 4px 12px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      font-family: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
    }
    .result-context-menu-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
  </style>
</head>
<body>
  <div class="tab-bar" id="tabBar">
    <div class="tab-new" id="btnNewTab" title="New tab">+</div>
  </div>
  <div class="toolbar">
    <div class="search-wrap">
      <div class="search-highlight" id="searchHighlight"></div>
      <input type="text" class="search-input" id="searchInput" placeholder="Search... loose:&quot;A B&quot; ext:ts +"only this"" spellcheck="false" autocomplete="off" />
      <div class="autocomplete" id="autocomplete"></div>
    </div>
    <button class="btn" id="btnCase" title="Case sensitive">Aa</button>
    <button class="btn active" id="btnPhrase" title="Phrase search">""</button>
    <button class="btn" id="btnFuzzy" title="Fuzzy search">Fz</button>
    <button class="btn" id="btnLoose" title="Loose phrase search">~</button>
    <span class="ctx-lines-wrap">
      <button class="btn btn-narrow" id="btnCtxLess" title="Fewer context lines (0-10)">−</button>
      <button class="btn" id="btnContext" title="Show context lines">Ctx</button>
      <button class="btn btn-narrow" id="btnCtxMore" title="More context lines (0-10)">+</button>
    </span>
    <button class="btn" id="btnRefresh" title="Refresh index">⟳</button>
    <button class="btn" id="btnManage" title="Manage indexes">⚙</button>
    <button class="btn" id="btnSettings" title="Open Ace Code Search settings">Set</button>
  </div>
  <div class="status-bar">
    <span id="statusHits">Ready</span>
    <span id="statusIndex">Index: idle</span>
  </div>
  <div class="results" id="results"></div>
  <div class="result-context-menu" id="resultContextMenu">
    <button type="button" class="result-context-menu-item" data-action="copy">Copy</button>
    <button type="button" class="result-context-menu-item" data-action="copyAll">Copy All</button>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
