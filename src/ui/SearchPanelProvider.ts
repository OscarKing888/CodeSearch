import * as vscode from 'vscode';
import { performance } from 'perf_hooks';
import { getConfig } from '../config';
import { ClassHierarchyCacheManager } from '../hierarchy/ClassHierarchyCacheManager';
import { ClassHierarchyModel } from '../hierarchy/ClassHierarchyModel';
import { IndexManager } from '../index/IndexManager';
import { MultiIndexSearchService, MultiSearchResult, MultiSearchStreamBatch, getRelativePath } from '../search/MultiIndexSearchService';
import { FIRST_BATCH_SIZE, UI_POST_CHUNK_SIZE, yieldToEventLoop } from '../search/searchStreamBuffer';
import { createRegistry, highlightHitsSync } from '../utils/syntaxHighlight';
import {
  beginSearchProfile,
  runWithSearchProfile,
  SearchProfileOutcome,
  SearchProfileSession,
} from '../utils/searchProfile';
import { revealProfileLogFolder } from '../utils/searchProfileUi';
import {
  ResultsPartialAckController,
  ResultsPartialAckOutcome,
} from './resultsPartialAckController';
import { ClassHierarchyPanel } from './ClassHierarchyPanel';
import { openCodeLocation } from './openCodeLocation';

const UI_CONTEXT_LINES_KEY = 'codeSearch.ui.contextLines';
const CONTEXT_LINES_MIN = 0;
const CONTEXT_LINES_MAX = 10;
const RESULTS_PARTIAL_ACK_TIMEOUT_MS = 2000;

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
  private autocompleteSeq = 0;
  private searchSeq = 0;
  private readonly partialAckController = new ResultsPartialAckController();
  private readonly profileSessions = new Map<number, SearchProfileSession>();
  private readonly profileFinalizations = new Map<number, Promise<string | undefined>>();
  private hierarchyCache: ClassHierarchyCacheManager | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private indexManager: IndexManager,
    private searchService: MultiIndexSearchService,
    private workspaceRoots: string[],
    private readonly context: vscode.ExtensionContext
  ) {
    this.bindHierarchyCache();
    ClassHierarchyPanel.register(
      context,
      (signal, force) => this.loadClassHierarchy(signal, force),
      (location) => openCodeLocation(location, {
        preview: true,
        viewColumn: vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
      })
    );
  }

  rebind(
    indexManager: IndexManager,
    searchService: MultiIndexSearchService,
    workspaceRoots: string[]
  ): void {
    this.indexManager = indexManager;
    this.searchService = searchService;
    this.workspaceRoots = workspaceRoots;
    void this.hierarchyCache?.dispose();
    this.bindHierarchyCache();
    ClassHierarchyPanel.refresh();
    this.sendIndexStatus();
  }

  async dispose(): Promise<void> {
    await this.disposeActiveSearches();
    this.view = undefined;
    this.webviewReady = false;
    this.panelVisible = false;
    this.panelWebviewFocused = false;
    this.resolveWebviewReadyWaiters();
    this.updatePanelFocusContext();
  }

  async disposeActiveSearches(): Promise<void> {
    this.searchSeq++;
    this.partialAckController.cancelActive();
    await Promise.all([
      this.finalizeAllProfiles('disposed'),
      this.disposeHierarchyCache(),
    ]);
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

    webviewView.onDidChangeVisibility(() => {
      const visible = webviewView.visible;
      this.panelVisible = visible;
      if (!visible) {
        this.panelWebviewFocused = false;
      }
      this.updatePanelFocusContext();
    });

    webviewView.onDidDispose(() => {
      if (this.view !== webviewView) {
        return;
      }
      this.view = undefined;
      this.webviewReady = false;
      this.panelVisible = false;
      this.panelWebviewFocused = false;
      this.searchSeq++;
      this.partialAckController.cancelActive();
      this.resolveWebviewReadyWaiters();
      this.updatePanelFocusContext();
      void this.finalizeAllProfiles('disposed');
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
        case 'openClassHierarchy':
          await this.showClassHierarchy();
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('codeSearch.openSettings');
          break;
        case 'installAgentGuidance':
          await vscode.commands.executeCommand('codeSearch.installAgentSkill');
          break;
        case 'setContextLines':
          await this.setUiContextLines(Number(msg.contextLines));
          break;
        case 'copyToClipboard':
          if (typeof msg.text === 'string') {
            await vscode.env.clipboard.writeText(msg.text);
          }
          break;
        case 'profileMark':
          if (typeof msg.phase === 'string' && Number.isInteger(msg.searchId)) {
            this.profileSessions.get(msg.searchId)?.mark(msg.phase, msg.data, 'webview');
          }
          break;
        case 'resultsPartialAck':
          if (Number.isInteger(msg.searchId) && Number.isInteger(msg.chunkId)) {
            this.partialAckController.acknowledge(msg.searchId, msg.chunkId);
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
    const seq = ++this.searchSeq;
    this.partialAckController.cancelActive();
    const config = getConfig();
    const effectiveContextLines = contextLines ?? this.getUiContextLines();
    const searchOptions = {
      caseSensitive: caseSensitive ?? false,
      phraseSearch: phraseSearch ?? config.phraseSearchDefault,
      contextLines: showContext ? effectiveContextLines : 0,
      maxResults: config.maxResults,
      fuzzy: fuzzy ?? config.fuzzySearchDefault,
      loose: loose ?? false,
      looseGap: config.looseGapDefault,
    };

    const profileSession = config.profileSearch
      ? beginSearchProfile(
          {
            version: String(this.context.extension.packageJSON.version ?? '0.0.0'),
            query,
            options: searchOptions,
          },
          {
            globalStoragePath: this.context.globalStorageUri.fsPath,
            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          }
        )
      : undefined;
    if (profileSession) {
      this.profileSessions.set(seq, profileSession);
    }
    void this.finalizeSupersededProfiles(seq);
    profileSession?.mark('provider_runSearch_start');

    let finalResult: MultiSearchResult | undefined;
    try {
      this.postMessage({
        type: 'searchStarted',
        searchId: seq,
        tabId,
        query,
        profileSearch: config.profileSearch,
      });
      profileSession?.mark('provider_searchStarted_sent');
      await yieldToEventLoop();

    if (seq !== this.searchSeq) {
      await this.finalizeProfile(seq, 'cancelled');
      return undefined;
    }

    const queue: MultiSearchStreamBatch[] = [];
    let searchDone = false;
    let producerError: unknown;
    const registryPromise = createRegistry(this.extensionUri).catch(() => undefined);

    const produce = async () => {
      try {
        for await (const batch of this.searchService.searchStreaming(query, searchOptions)) {
          if (seq !== this.searchSeq) {
            return;
          }
          queue.push(batch);
        }
      } catch (error) {
        producerError = error;
      } finally {
        searchDone = true;
        profileSession?.mark('provider_search_producer_done', {
          error: producerError instanceof Error ? producerError.message : undefined,
        });
      }
    };
    void (profileSession ? runWithSearchProfile(profileSession, produce) : produce());

    const allHits: MultiSearchResult['hits'] = [];
    let uiBatchIndex = 0;
    const chunkCounter = { value: 0 };

    while (!searchDone || queue.length > 0) {
      if (seq !== this.searchSeq) {
        await this.finalizeProfile(seq, 'cancelled');
        return undefined;
      }

      const batch = queue.shift();
      if (!batch) {
        await yieldToEventLoop();
        continue;
      }

      if (uiBatchIndex === 0 && batch.hits.length > 0) {
        profileSession?.mark('provider_first_batch_dequeued', { batchHits: batch.hits.length });
      }

      const skipHighlight = uiBatchIndex === 0 && batch.hits.length > 0;
      let mappedHits: MultiSearchResult['hits'];

      const highlightStart = Date.now();
      if (skipHighlight) {
        mappedHits = batch.hits.map((h) => ({
          ...h,
          relativePath: getRelativePath(h.localPath, this.workspaceRoots),
          indexLabel: h.indexName,
        }));
      } else if (batch.hits.length === 0) {
        mappedHits = [];
      } else {
        const registry = await registryPromise;
        let highlighted;
        try {
          highlighted = highlightHitsSync(
            batch.hits.map((h) => ({
              lineText: h.lineText,
              path: h.localPath ?? h.path,
              matchStart: h.matchStart,
              matchEnd: h.matchEnd,
            })),
            registry
          );
        } catch {
          highlighted = batch.hits.map((h) => ({
            tokens: [{ text: h.lineText }],
            matchStart: h.matchStart,
            matchEnd: h.matchEnd,
          }));
        }

        mappedHits = batch.hits.map((h, i) => ({
          ...h,
          relativePath: getRelativePath(h.localPath, this.workspaceRoots),
          indexLabel: h.indexName,
          highlighted: highlighted[i],
        }));
      }
      profileSession?.mark('provider_highlight_batch', {
        skipHighlight,
        batchHits: batch.hits.length,
        ms: Date.now() - highlightStart,
      });

      if (seq !== this.searchSeq) {
        await this.finalizeProfile(seq, 'cancelled');
        return undefined;
      }

      if (batch.hits.length > 0) {
        uiBatchIndex++;
      }

      const batchStartIndex = allHits.length;
      allHits.push(...mappedHits);

      await this.postResultsPartialChunks(tabId, mappedHits, {
        done: batch.done,
        hitCount: batch.hitCount,
        fileCount: batch.fileCount,
        elapsedMs: batch.elapsedMs,
        partialIndex: batch.partialIndex,
        query: batch.query,
      }, skipHighlight, seq, chunkCounter, profileSession);

      if (skipHighlight && mappedHits.length > 0 && seq === this.searchSeq) {
        const patchStart = Date.now();
        const registry = await registryPromise;
        if (seq !== this.searchSeq) {
          await this.finalizeProfile(seq, 'cancelled');
          return undefined;
        }
        let highlighted;
        try {
          highlighted = highlightHitsSync(
            batch.hits.map((h) => ({
              lineText: h.lineText,
              path: h.localPath ?? h.path,
              matchStart: h.matchStart,
              matchEnd: h.matchEnd,
            })),
            registry
          );
        } catch {
          highlighted = batch.hits.map((h) => ({
            tokens: [{ text: h.lineText }],
            matchStart: h.matchStart,
            matchEnd: h.matchEnd,
          }));
        }
        for (let i = 0; i < mappedHits.length; i++) {
          (mappedHits[i] as MultiSearchResult['hits'][number] & { highlighted?: unknown }).highlighted = highlighted[i];
        }
        this.postMessage({
          type: 'resultsHighlightPatch',
          searchId: seq,
          tabId,
          startIndex: batchStartIndex,
          highlighted,
        });
        profileSession?.mark('provider_highlight_first_patch', {
          batchHits: mappedHits.length,
          ms: Date.now() - patchStart,
        });
        await yieldToEventLoop();
      }

      if (batch.done) {
        finalResult = {
          hits: allHits,
          hitCount: batch.hitCount,
          fileCount: batch.fileCount,
          elapsedMs: batch.elapsedMs,
          query: batch.query,
          partialIndex: batch.partialIndex,
        };
      }
    }

    if (seq !== this.searchSeq) {
      await this.finalizeProfile(seq, 'cancelled');
      return undefined;
    }

    if (producerError) {
      const message = producerError instanceof Error ? producerError.message : String(producerError);
      profileSession?.mark('provider_search_failed', { message });
      this.postMessage({ type: 'searchFailed', searchId: seq, tabId, message });
      await this.finalizeProfile(seq, 'error', producerError);
      return undefined;
    }

    if (!finalResult) {
      const error = new Error('Search stream ended without a final batch');
      profileSession?.mark('provider_search_failed', { message: error.message });
      this.postMessage({ type: 'searchFailed', searchId: seq, tabId, message: error.message });
      await this.finalizeProfile(seq, 'error', error);
      return undefined;
    }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      profileSession?.mark('provider_search_failed', { message });
      const wasCurrentSearch = seq === this.searchSeq;
      if (wasCurrentSearch) {
        this.postMessage({ type: 'searchFailed', searchId: seq, tabId, message });
        this.searchSeq++;
        this.partialAckController.cancelActive();
      }
      await this.finalizeProfile(
        seq,
        wasCurrentSearch ? 'error' : 'cancelled',
        error
      );
      return undefined;
    }

    profileSession?.mark('provider_runSearch_done', { hitCount: finalResult.hitCount });

    if (profileSession) {
      let logPath: string | undefined;
      try {
        logPath = await this.finalizeProfile(seq, 'success');
      } catch (error) {
        void vscode.window.showWarningMessage(
          `Ace Code Search: 无法保存 Profile: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        this.profileSessions.delete(seq);
      }
      if (logPath && seq === this.searchSeq) {
        const openLabel = '打开日志文件夹';
        void vscode.window
          .showInformationMessage(`Ace Code Search: Profile 已保存: ${logPath}`, openLabel)
          .then((choice) => {
            if (choice === openLabel) {
              void revealProfileLogFolder(this.context);
            }
          });
      }
    }

    if (seq !== this.searchSeq) {
      return undefined;
    }

    if (config.autoOpenSingleHit && finalResult.hitCount === 1 && finalResult.hits[0]) {
      const hit = finalResult.hits[0];
      await this.openHitAt(hit.localPath ?? hit.path, hit.line, hit.column, true);
    }

    return finalResult;
  }

  nextHit(): void {
    this.postMessage({ type: 'navigateHit', direction: 'next' });
  }

  prevHit(): void {
    this.postMessage({ type: 'navigateHit', direction: 'prev' });
  }

  async showClassHierarchy(): Promise<void> {
    ClassHierarchyPanel.show();
  }

  private bindHierarchyCache(): void {
    const workerScript = vscode.Uri.joinPath(
      this.extensionUri,
      'dist',
      'workers',
      'class-hierarchy-worker.js'
    ).fsPath;
    const cache = new ClassHierarchyCacheManager(this.indexManager, workerScript);
    cache.on('updated', () => ClassHierarchyPanel.refresh());
    cache.start();
    this.hierarchyCache = cache;
  }

  private async disposeHierarchyCache(): Promise<void> {
    const cache = this.hierarchyCache;
    if (!cache) {
      return;
    }
    this.hierarchyCache = undefined;
    await cache.dispose();
    ClassHierarchyPanel.refresh();
  }

  private loadClassHierarchy(
    signal: AbortSignal,
    force: boolean
  ): Promise<ClassHierarchyModel> {
    const cache = this.hierarchyCache;
    if (cache) {
      return cache.buildModel(signal, force);
    }
    return Promise.resolve({
      roots: [],
      nodes: [],
      classCount: 0,
      externalBaseCount: 0,
      parsedFileCount: 0,
      partialIndex: true,
    });
  }

  private async openHitAt(
    path: string,
    line: number,
    column: number,
    preview: boolean
  ): Promise<void> {
    await openCodeLocation({ path, line, column }, { preview });
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
    this.postMessage(this.buildInitMessage(clamped));
  }

  private sendInitConfig(): void {
    this.postMessage(this.buildInitMessage(this.getUiContextLines()));
  }

  private buildInitMessage(contextLines: number): {
    type: 'init';
    contextLines: number;
    version: string;
    profileSearch: boolean;
  } {
    return {
      type: 'init',
      contextLines,
      version: this.context.extension.packageJSON.version as string,
      profileSearch: getConfig().profileSearch,
    };
  }

  private async finalizeProfile(
    searchId: number,
    outcome: SearchProfileOutcome,
    error?: unknown
  ): Promise<string | undefined> {
    const existing = this.profileFinalizations.get(searchId);
    if (existing) {
      return existing;
    }
    const session = this.profileSessions.get(searchId);
    if (!session) {
      return undefined;
    }

    const finalization = (async () => {
      try {
        return await session.finalize(outcome, error);
      } catch (writeError) {
        void vscode.window.showWarningMessage(
          `Ace Code Search: unable to save search profile: ${writeError instanceof Error ? writeError.message : String(writeError)}`
        );
        return undefined;
      } finally {
        if (this.profileSessions.get(searchId) === session) {
          this.profileSessions.delete(searchId);
        }
        this.profileFinalizations.delete(searchId);
      }
    })();
    this.profileFinalizations.set(searchId, finalization);
    return finalization;
  }

  private async finalizeSupersededProfiles(currentSearchId: number): Promise<void> {
    const staleIds = [...this.profileSessions.keys()].filter(
      (searchId) => searchId < currentSearchId
    );
    await Promise.all(staleIds.map((searchId) => this.finalizeProfile(searchId, 'cancelled')));
  }

  private async finalizeAllProfiles(outcome: SearchProfileOutcome): Promise<void> {
    const searchIds = [...this.profileSessions.keys()];
    await Promise.all(searchIds.map((searchId) => this.finalizeProfile(searchId, outcome)));
  }

  private async waitForResultsPartialAck(
    searchId: number,
    chunkId: number,
    profileSession?: SearchProfileSession
  ): Promise<ResultsPartialAckOutcome> {
    if (searchId !== this.searchSeq) {
      return 'cancelled';
    }
    const waitStart = performance.now();
    const outcome = await this.partialAckController.waitFor(
      searchId,
      chunkId,
      RESULTS_PARTIAL_ACK_TIMEOUT_MS
    );
    const waitMs = Math.max(0, performance.now() - waitStart);
    profileSession?.mark('provider_resultsPartial_ack', {
      searchId,
      chunkId,
      outcome,
      waitMs,
    });
    if (outcome === 'timeout') {
      profileSession?.mark('provider_resultsPartial_ack_timeout', { searchId, chunkId, waitMs });
    }
    if (profileSession && (chunkId === 1 || outcome === 'timeout')) {
      await profileSession.checkpoint().catch(() => undefined);
    }
    return outcome;
  }

  private updatePanelFocusContext(): void {
    void vscode.commands.executeCommand(
      'setContext',
      'codeSearch.panel.focus',
      this.panelVisible && this.panelWebviewFocused
    );
  }

  private handleAutocomplete(prefix: string): void {
    const seq = ++this.autocompleteSeq;
    setImmediate(() => {
      if (seq !== this.autocompleteSeq) {
        return;
      }
      const suggestions = this.indexManager.getTokenSuggestions(prefix, 20);
      if (seq !== this.autocompleteSeq) {
        return;
      }
      this.postMessage({ type: 'autocomplete', prefix, suggestions });
    });
  }

  private async postResultsPartialChunks(
    tabId: string | undefined,
    hits: MultiSearchResult['hits'],
    meta: {
      done: boolean;
      hitCount: number;
      fileCount: number;
      elapsedMs: number;
      partialIndex: boolean;
      query: string;
    },
    plainFirstBatch: boolean,
    searchSeq: number,
    chunkCounter: { value: number },
    profileSession?: SearchProfileSession
  ): Promise<void> {
    if (hits.length === 0) {
      const chunkId = ++chunkCounter.value;
      const ackPromise = this.waitForResultsPartialAck(searchSeq, chunkId, profileSession);
      void this.postResultsPartialMessage(
        {
          type: 'resultsPartial',
          searchId: searchSeq,
          chunkId,
          tabId,
          hits: [],
          done: meta.done,
          hitCount: meta.hitCount,
          fileCount: meta.fileCount,
          elapsedMs: meta.elapsedMs,
          partialIndex: meta.partialIndex,
          query: meta.query,
        },
        searchSeq,
        chunkId
      );
      profileSession?.mark('provider_resultsPartial_sent', {
        chunkId,
        batchHits: 0,
        hitCount: meta.hitCount,
        done: meta.done,
      });
      const ackOutcome = await ackPromise;
      if (ackOutcome === 'cancelled') {
        if (searchSeq !== this.searchSeq) {
          return;
        }
        throw new Error(`Webview did not accept results chunk ${chunkId}`);
      }
      await yieldToEventLoop();
      return;
    }

    for (let offset = 0; offset < hits.length;) {
      if (searchSeq !== this.searchSeq) {
        return;
      }
      const chunkSize = plainFirstBatch && offset === 0
        ? Math.min(FIRST_BATCH_SIZE, hits.length)
        : UI_POST_CHUNK_SIZE;
      const chunk = hits.slice(offset, offset + chunkSize);
      const isLastChunk = offset + chunk.length >= hits.length;
      const chunkId = ++chunkCounter.value;
      const ackPromise = this.waitForResultsPartialAck(searchSeq, chunkId, profileSession);
      void this.postResultsPartialMessage(
        {
          type: 'resultsPartial',
          searchId: searchSeq,
          chunkId,
          tabId,
          hits: chunk,
          done: meta.done && isLastChunk,
          hitCount: meta.hitCount,
          fileCount: meta.fileCount,
          elapsedMs: meta.elapsedMs,
          partialIndex: meta.partialIndex,
          query: meta.query,
          ...(plainFirstBatch && offset === 0 ? { plainFirstBatch: true } : {}),
        },
        searchSeq,
        chunkId
      );
      profileSession?.mark('provider_resultsPartial_sent', {
        chunkId,
        batchHits: chunk.length,
        hitCount: meta.hitCount,
        done: meta.done && isLastChunk,
      });
      const ackOutcome = await ackPromise;
      if (ackOutcome === 'cancelled') {
        if (searchSeq !== this.searchSeq) {
          return;
        }
        throw new Error(`Webview did not accept results chunk ${chunkId}`);
      }
      await yieldToEventLoop();
      offset += chunk.length;
    }
  }

  private async postResultsPartialMessage(
    message: unknown,
    searchId: number,
    chunkId: number
  ): Promise<void> {
    try {
      const delivered = await this.view?.webview.postMessage(message);
      if (!delivered) {
        this.partialAckController.cancel(searchId, chunkId);
      }
    } catch {
      this.partialAckController.cancel(searchId, chunkId);
    }
  }

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'main.js')
    );
    const nonce = getNonce();
    const version = this.context.extension.packageJSON.version as string;

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
    .btn-icon {
      display: block;
      width: 16px;
      height: 16px;
      pointer-events: none;
    }
    .btn-icon path,
    .btn-icon circle {
      vector-effect: non-scaling-stroke;
    }
    .btn-with-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
    }
    .btn-count {
      min-width: 1ch;
      font-variant-numeric: tabular-nums;
      line-height: 16px;
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
      gap: 12px;
      padding: 4px 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .status-hits {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-meta {
      display: flex;
      gap: 8px;
      flex-shrink: 0;
      white-space: nowrap;
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
      <button class="btn btn-with-count" id="btnContext" title="Show context lines" aria-label="Show context lines">
        <svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
          <path opacity=".65" d="M3 3.5h10M3 12.5h10"></path>
          <path stroke-width="2" d="M2 8h12"></path>
        </svg>
        <span class="btn-count" id="contextLineCount">1</span>
      </button>
      <button class="btn btn-narrow" id="btnCtxMore" title="More context lines (0-10)">+</button>
    </span>
    <button class="btn" id="btnRefresh" title="Refresh index">⟳</button>
    <button class="btn" id="btnHierarchy" title="Show class inheritance tree" aria-label="Show class inheritance tree">
      <svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 4.5v3M4 11V8h8v3"></path>
        <circle cx="8" cy="3" r="1.5"></circle>
        <circle cx="4" cy="12.5" r="1.5"></circle>
        <circle cx="12" cy="12.5" r="1.5"></circle>
      </svg>
    </button>
    <button class="btn" id="btnManage" title="Manage indexes">⚙</button>
    <button class="btn" id="btnInstallGuidance" title="Install Agent Skill / Rule" aria-label="Install Agent Skill / Rule">
      <svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4.5 2.5h5.2L12.5 5.3V13.5H4.5z"></path>
        <path d="M9.5 2.5V5.3H12.5"></path>
        <path d="M6.2 9.2l1.3 1.3 2.3-2.6"></path>
      </svg>
    </button>
    <button class="btn" id="btnSettings" title="Open Ace Code Search settings">☰</button>
  </div>
  <div class="status-bar">
    <span id="statusHits" class="status-hits">Ready</span>
    <span class="status-meta">
      <span id="statusIndex">Index: idle</span>
      <span id="statusVersion">v${version}</span>
    </span>
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
