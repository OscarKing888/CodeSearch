import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig, workspaceHash } from './config';
import { IndexManager } from './index/IndexManager';
import {
  applyAutocreateToConfig,
  findAutocreateConfig,
  getEffectiveRoots,
  resolveIndexDbPath,
} from './index/Autocreate';
import { MultiIndexSearchService } from './search/MultiIndexSearchService';
import { SearchPanelProvider } from './ui/SearchPanelProvider';
import { createStandaloneIndex, manageIndexes, openSecondaryIndex } from './ui/IndexManagement';
import { IndexManagePanel } from './ui/IndexManagePanel';

let indexManager: IndexManager | undefined;
let searchService: MultiIndexSearchService | undefined;
let panelProvider: SearchPanelProvider | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let initPromise: Promise<void> | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  registerCommands(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void initializeWorkspace(context);
    })
  );

  await initializeWorkspace(context);
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
      if (!(await ensureWorkspaceReady())) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Code Search: Refreshing indexes...' },
        () => indexManager!.refreshAll(true)
      );
      vscode.window.showInformationMessage('Code Search: Indexes refreshed.');
    }),
    vscode.commands.registerCommand('codeSearch.manageIndexes', async () => {
      if (!(await ensureWorkspaceReady())) {
        return;
      }
      manageIndexes();
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
    })
  );
}

async function initializeWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = doInitializeWorkspace(context, folders);
  try {
    await initPromise;
  } catch (err) {
    initPromise = undefined;
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Code Search: Failed to initialize — ${message}`);
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
    : path.join(globalStorage, 'source-search', hash, 'index.db');

  const indexName = autocreate?.config.name ?? 'Primary';
  await indexManager.createPrimary(dbPath, roots, indexName);

  const secondaryIds = context.workspaceState.get<string[]>('secondaryIndexIds', []);
  await indexManager.loadWorkspaceSecondaries(secondaryIds);

  IndexManagePanel.register(context, indexManager);

  searchService = new MultiIndexSearchService(indexManager);
  const workspaceRoots = folders.map((f) => f.uri.fsPath);

  panelProvider = new SearchPanelProvider(
    context.extensionUri,
    indexManager,
    searchService,
    workspaceRoots,
    context
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SearchPanelProvider.viewType, panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'codeSearch.focusSearch';
  statusBarItem.tooltip = 'Code Search — click to focus';
  context.subscriptions.push(statusBarItem);

  indexManager.on('progress', () => {
    const combined = indexManager!.getCombinedProgress();
    if (statusBarItem) {
      statusBarItem.text = `$(search) ${combined.message}`;
      statusBarItem.show();
    }
    panelProvider?.sendIndexStatus();
  });

  context.subscriptions.push({
    dispose: () => {
      void saveSecondaryIds(context);
      indexManager?.dispose();
    },
  });

  const config = getConfig();
  if (config.indexOnStartup) {
    void indexManager.getPrimary()?.startIndexing();
  }
}

async function ensureWorkspaceReady(): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'Code Search: Open a workspace folder to enable indexing.',
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
        await panelProvider?.setQuery(query, 'search', false);
      } else {
        await panelProvider?.focus();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Code Search: ${message}`);
    }
  })();
}

export function deactivate(): void {
  indexManager?.dispose();
  statusBarItem?.dispose();
}

async function fsMkdir(dir: string): Promise<void> {
  const fs = await import('fs');
  await fs.promises.mkdir(dir, { recursive: true });
}
