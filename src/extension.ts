import * as vscode from 'vscode';
import * as path from 'path';
import { configureBetterSqlite3 } from './native/betterSqlite3';
import { getConfig, workspaceHash } from './config';
import { IndexManager } from './index/IndexManager';
import {
  applyAutocreateToConfig,
  extractPerIndexExcludesFromAutocreate,
  findAutocreateConfig,
  getEffectiveRoots,
  resolveIndexDbPath,
} from './index/Autocreate';
import { hasWorkspaceIndex } from './index/indexPresence';
import { MultiIndexSearchService } from './search/MultiIndexSearchService';
import { SearchPanelProvider } from './ui/SearchPanelProvider';
import { createStandaloneIndex, manageIndexes, openSecondaryIndex } from './ui/IndexManagement';
import { IndexManagePanel } from './ui/IndexManagePanel';
import { getLogicalCpuCount } from './index/threadCount';
import { switchHeaderSource as runSwitchHeaderSource } from './pairing/switchHeaderSource';
import { migrateUserHeaderSourceKeybindings } from './pairing/migrateHeaderSourceKeybindings';
import { revealProfileLogFolder } from './utils/searchProfileUi';

const CREATE_INDEX_LABEL = 'Create Index';
const SKIP_INDEX_LABEL = 'Not Now';

const INDEXING_CONFIG_KEYS = [
  'codeSearch.excludeGlobs',
  'codeSearch.excludeDirNames',
  'codeSearch.excludeFileNames',
  'codeSearch.includeGlobs',
  'codeSearch.maxFileSizeKB',
] as const;

const INDEXING_SETTINGS_REFRESH_DEBOUNCE_MS = 500;

let indexManager: IndexManager | undefined;
let searchService: MultiIndexSearchService | undefined;
let panelProvider: SearchPanelProvider | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let initPromise: Promise<void> | undefined;
let initializedWorkspaceHash: string | undefined;
let webviewRegistered = false;
let progressListener: (() => void) | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let indexingSettingsRefreshTimer: ReturnType<typeof setTimeout> | undefined;

function resolveEditorProduct(): 'Cursor' | 'Code' {
  const appName = vscode.env.appName.toLowerCase();
  if (appName.includes('cursor') || vscode.env.uriScheme === 'cursor') {
    return 'Cursor';
  }
  return 'Code';
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  configureBetterSqlite3(context.extensionPath);
  extensionContext = context;
  logCpuInfo(context);
  registerCommands(context);
  void migrateUserHeaderSourceKeybindings(resolveEditorProduct(), (message) =>
    outputChannel?.appendLine(message)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void initializeWorkspace(context);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!INDEXING_CONFIG_KEYS.some((key) => e.affectsConfiguration(key))) {
        return;
      }
      scheduleIndexingSettingsRefresh();
    })
  );

  await initializeWorkspace(context);
}

function logCpuInfo(context: vscode.ExtensionContext): void {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Ace Code Search');
    context.subscriptions.push(outputChannel);
  }
  const cpuCount = getLogicalCpuCount();
  outputChannel.appendLine(
    `本机逻辑处理器: ${cpuCount}。codeSearch.indexThreads=0（自动）将使用 ${cpuCount} 路并发索引。`
  );
}

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeSearch.searchSelection', () => searchSelection()),
    vscode.commands.registerCommand('sourceSearch.searchSelection', () => searchSelection()),
    vscode.commands.registerCommand('codeSearch.focusSearch', () => {
      void focusSearch();
    }),
    vscode.commands.registerCommand('sourceSearch.focusSearch', () => {
      void focusSearch();
    }),
    vscode.commands.registerCommand('codeSearch.quickOpenFile', () => {
      void panelProvider?.setQuery('file:', 'search').then(() => focusSearch());
    }),
    vscode.commands.registerCommand('codeSearch.nextHit', () => panelProvider?.nextHit()),
    vscode.commands.registerCommand('codeSearch.prevHit', () => panelProvider?.prevHit()),
    vscode.commands.registerCommand('codeSearch.refreshIndex', async () => {
      if (!(await ensureWorkspaceReady()) || !indexManager) {
        return;
      }
      if (!indexManager.getPrimary()) {
        const created = await promptAndCreatePrimary(indexManager);
        if (!created) {
          return;
        }
        rebuildSearchBindings();
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Ace Code Search: Refreshing indexes...' },
        () => indexManager!.refreshAll(true)
      );
      vscode.window.showInformationMessage('Ace Code Search: Indexes refreshed.');
    }),
    vscode.commands.registerCommand('codeSearch.manageIndexes', async () => {
      if (!(await ensureWorkspaceReady())) {
        return;
      }
      manageIndexes();
    }),
    vscode.commands.registerCommand('codeSearch.openClassHierarchy', async () => {
      if (!(await ensureWorkspaceReady())) {
        return;
      }
      await panelProvider?.showClassHierarchy();
    }),
    vscode.commands.registerCommand('codeSearch.openSettings', () => {
      void vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `@ext:${context.extension.id}`
      );
    }),
    vscode.commands.registerCommand('codeSearch.openProfileLogFolder', () => {
      void revealProfileLogFolder(context);
    }),
    vscode.commands.registerCommand('codeSearch.openSecondaryIndex', async () => {
      if (!(await ensureWorkspaceReady()) || !indexManager) {
        return;
      }
      const err = await openSecondaryIndex(indexManager);
      if (!err) {
        await saveSecondaryIds(context);
      }
    }),
    vscode.commands.registerCommand('codeSearch.createIndex', async () => {
      if (!(await ensureWorkspaceReady()) || !indexManager) {
        return;
      }
      const err = await createStandaloneIndex(indexManager);
      if (!err) {
        await saveSecondaryIds(context);
      }
    }),
    vscode.commands.registerCommand('codeSearch.searchInNewTab', () => {
      panelProvider?.searchInNewTab();
    }),
    vscode.commands.registerCommand('codeSearch.switchHeaderSource', () => {
      void switchHeaderSource();
    })
  );
}

async function initializeWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    await panelProvider?.disposeActiveSearches();
    disposeWorkspaceResources();
    initializedWorkspaceHash = undefined;
    initPromise = undefined;
    return;
  }

  const hash = workspaceHash(folders);
  if (initializedWorkspaceHash && initializedWorkspaceHash !== hash) {
    await saveSecondaryIds(context);
    await panelProvider?.disposeActiveSearches();
    disposeWorkspaceResources();
    initPromise = undefined;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = doInitializeWorkspace(context, folders);
  try {
    await initPromise;
    initializedWorkspaceHash = hash;
  } catch (err) {
    initPromise = undefined;
    initializedWorkspaceHash = undefined;
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Ace Code Search: Failed to initialize — ${message}`);
    throw err;
  }
}

async function doInitializeWorkspace(
  context: vscode.ExtensionContext,
  folders: readonly vscode.WorkspaceFolder[]
): Promise<void> {
  const hash = workspaceHash(folders);
  const globalStorage = context.globalStorageUri.fsPath;
  await fsMkdir(globalStorage);

  indexManager = new IndexManager(globalStorage, hash);
  await indexManager.initialize();

  const autocreate = await findAutocreateConfig(folders);
  if (autocreate) {
    applyAutocreateToConfig(autocreate.config);
  }

  const roots = getEffectiveRoots(folders, autocreate?.rootDir);
  const dbPath = autocreate
    ? resolveIndexDbPath(autocreate.config, autocreate.rootDir, globalStorage, hash)
    : path.join(globalStorage, 'code-search', hash, 'index.db');

  const indexName = autocreate?.config.name ?? 'Primary';
  let shouldStartIndexing = false;

  if (autocreate) {
    const excludeRules = extractPerIndexExcludesFromAutocreate(autocreate.config);
    await indexManager.createPrimary(dbPath, roots, indexName, excludeRules);
    shouldStartIndexing = true;
  } else {
    const presence = await hasWorkspaceIndex(hash, dbPath, indexManager.getRegistry());
    if (presence.exists) {
      await indexManager.openPrimary(presence.dbPath, roots, indexName);
      shouldStartIndexing = getConfig().indexOnStartup;
    } else {
      const choice = await vscode.window.showInformationMessage(
        'Ace Code Search: No index found for this workspace. Create one now?',
        CREATE_INDEX_LABEL,
        SKIP_INDEX_LABEL
      );
      if (choice === CREATE_INDEX_LABEL) {
        await indexManager.createPrimary(dbPath, roots, indexName);
        shouldStartIndexing = true;
      }
    }
  }

  const secondaryIds = context.workspaceState.get<string[]>('secondaryIndexIds', []);
  await indexManager.loadWorkspaceSecondaries(secondaryIds);

  IndexManagePanel.register(context, indexManager);

  searchService = new MultiIndexSearchService(indexManager);
  const workspaceRoots = folders.map((f) => f.uri.fsPath);

  if (panelProvider) {
    panelProvider.rebind(indexManager, searchService, workspaceRoots);
  } else {
    panelProvider = new SearchPanelProvider(
      context.extensionUri,
      indexManager,
      searchService,
      workspaceRoots,
      context
    );
  }

  if (!webviewRegistered) {
    webviewRegistered = true;
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(SearchPanelProvider.viewType, panelProvider, {
        webviewOptions: { retainContextWhenHidden: true },
      })
    );
  }

  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'codeSearch.focusSearch';
    statusBarItem.tooltip = 'Ace Code Search — click to focus';
    context.subscriptions.push(statusBarItem);
  }

  attachProgressListener();

  if (shouldStartIndexing) {
    void indexManager.getPrimary()?.startIndexing();
  } else if (!indexManager.getPrimary()) {
    updateStatusBar('No index');
  } else {
    updateStatusBar(indexManager.getCombinedProgress().message);
  }
}

async function promptAndCreatePrimary(manager: IndexManager): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    'Ace Code Search: No index found for this workspace. Create one now?',
    CREATE_INDEX_LABEL,
    SKIP_INDEX_LABEL
  );
  if (choice !== CREATE_INDEX_LABEL) {
    return false;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0 || !extensionContext) {
    return false;
  }

  const hash = workspaceHash(folders);
  const globalStorage = extensionContext.globalStorageUri.fsPath;
  const autocreate = await findAutocreateConfig(folders);
  const roots = getEffectiveRoots(folders, autocreate?.rootDir);
  const dbPath = autocreate
    ? resolveIndexDbPath(autocreate.config, autocreate.rootDir, globalStorage, hash)
    : path.join(globalStorage, 'code-search', hash, 'index.db');
  const indexName = autocreate?.config.name ?? 'Primary';
  const excludeRules = autocreate ? extractPerIndexExcludesFromAutocreate(autocreate.config) : undefined;

  await manager.createPrimary(dbPath, roots, indexName, excludeRules);
  void manager.getPrimary()?.startIndexing();
  return true;
}

function rebuildSearchBindings(): void {
  if (!indexManager) {
    return;
  }
  searchService = new MultiIndexSearchService(indexManager);
  const folders = vscode.workspace.workspaceFolders;
  const workspaceRoots = folders?.map((f) => f.uri.fsPath) ?? [];
  panelProvider?.rebind(indexManager, searchService, workspaceRoots);
  attachProgressListener();
}

function attachProgressListener(): void {
  if (!indexManager) {
    return;
  }
  if (progressListener) {
    indexManager.off('progress', progressListener);
  }
  progressListener = () => {
    const combined = indexManager!.getCombinedProgress();
    updateStatusBar(combined.message);
    panelProvider?.sendIndexStatus();
  };
  indexManager.on('progress', progressListener);
}

function updateStatusBar(message: string): void {
  if (statusBarItem) {
    statusBarItem.text = `$(search) ${message}`;
    statusBarItem.show();
  }
}

function disposeWorkspaceResources(): void {
  if (progressListener && indexManager) {
    indexManager.off('progress', progressListener);
  }
  progressListener = undefined;
  indexManager?.dispose();
  indexManager = undefined;
  searchService = undefined;
}

async function ensureWorkspaceReady(): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'Ace Code Search: Open a workspace folder to enable indexing.',
      'Open Folder'
    );
    if (choice === 'Open Folder') {
      await vscode.commands.executeCommand('vscode.openFolder');
    }
    return false;
  }

  if (!panelProvider && extensionContext) {
    if (initPromise) {
      try {
        await initPromise;
      } catch {
        return false;
      }
    } else {
      await initializeWorkspace(extensionContext);
    }
  }

  return !!panelProvider;
}

async function focusSearch(): Promise<void> {
  if (!panelProvider) {
    if (!(await ensureWorkspaceReady())) {
      return;
    }
  }
  await panelProvider?.focus();
}

async function saveSecondaryIds(context: vscode.ExtensionContext): Promise<void> {
  if (!indexManager) {
    return;
  }
  await context.workspaceState.update('secondaryIndexIds', indexManager.getWorkspaceSecondaryIds());
}

async function switchHeaderSource(): Promise<void> {
  try {
    if (!(await ensureWorkspaceReady())) {
      return;
    }
    await runSwitchHeaderSource(indexManager);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Ace Code Search: ${message}`);
  }
}

function searchSelection(): void {
  void (async () => {
    try {
      if (!(await ensureWorkspaceReady())) {
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        await panelProvider?.focus();
        return;
      }

      const selection = editor.document.getText(editor.selection);
      let query = selection.trim();

      if (!query) {
        const position = editor.selection.active;
        const range = editor.document.getWordRangeAtPosition(position);
        if (range) {
          query = editor.document.getText(range);
        }
      }

      if (query) {
        await panelProvider?.setQuery(query, 'search', true);
      } else {
        await panelProvider?.focus();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Ace Code Search: ${message}`);
    }
  })();
}

function scheduleIndexingSettingsRefresh(): void {
  if (indexingSettingsRefreshTimer) {
    clearTimeout(indexingSettingsRefreshTimer);
  }
  indexingSettingsRefreshTimer = setTimeout(() => {
    indexingSettingsRefreshTimer = undefined;
    void runIndexingSettingsRefresh();
  }, INDEXING_SETTINGS_REFRESH_DEBOUNCE_MS);
}

async function runIndexingSettingsRefresh(): Promise<void> {
  if (!indexManager) {
    return;
  }
  const writable = indexManager.getAllServices().filter((s) => !s.isReadOnly());
  if (writable.length === 0) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Ace Code Search: Refreshing indexes after settings change...',
    },
    () => indexManager!.refreshAll(true)
  );
  panelProvider?.sendIndexStatus();
}

export async function deactivate(): Promise<void> {
  if (indexingSettingsRefreshTimer) {
    clearTimeout(indexingSettingsRefreshTimer);
    indexingSettingsRefreshTimer = undefined;
  }
  if (extensionContext) {
    void saveSecondaryIds(extensionContext);
  }
  await panelProvider?.dispose();
  panelProvider = undefined;
  disposeWorkspaceResources();
  statusBarItem?.dispose();
  statusBarItem = undefined;
}

async function fsMkdir(dir: string): Promise<void> {
  const fs = await import('fs');
  await fs.promises.mkdir(dir, { recursive: true });
}
