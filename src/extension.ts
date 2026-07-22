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
import { findExistingWorkspaceIndexes } from './index/indexPresence';
import {
  selectFirstUsableStartupPrimary,
  StartupPrimaryCandidate,
} from './index/startupPrimarySelection';
import {
  captureWorkspaceOperation,
  isWorkspaceOperationCurrent,
  WorkspaceOperationToken,
} from './index/workspaceOperationGuard';
import { MultiIndexSearchService } from './search/MultiIndexSearchService';
import { SearchPanelProvider } from './ui/SearchPanelProvider';
import {
  createStandaloneIndex,
  manageIndexes,
  openSecondaryIndex,
  saveWorkspaceIndexBinding,
  selectPrimaryIndex,
} from './ui/IndexManagement';
import { IndexManagePanel } from './ui/IndexManagePanel';
import {
  IndexManagementWorkspaceContext,
  IndexOperationResult,
} from './ui/IndexManagementService';
import {
  getSharedWorkspaceDbPath,
  getSharedWorkspaceKey,
  samePath as samePhysicalIndex,
} from './index/sharedIndexStorage';
import {
  getWorkspaceIndexBindingKey,
  getWorkspaceSecondaryRestoreSource,
  LEGACY_SECONDARY_IDS_MIGRATION_MARKER_KEY,
  migrateLegacyWorkspaceBinding,
  normalizeWorkspaceIndexBinding,
} from './index/workspaceIndexBinding';
import { getLogicalCpuCount } from './index/threadCount';
import { switchHeaderSource as runSwitchHeaderSource } from './pairing/switchHeaderSource';
import { migrateUserHeaderSourceKeybindings } from './pairing/migrateHeaderSourceKeybindings';
import { revealProfileLogFolder } from './utils/searchProfileUi';
import { installProjectAgentSkill } from './agentSkillInstaller';
import {
  cleanupLegacyProjectAgentRules,
  readCursorUserRule,
} from './agentRuleInstaller';
import { installMcpClientConfig } from './mcpConfigInstaller';
import { McpStatusMonitor } from './mcpStatus';
import {
  buildVscodeMcpLaunchSpec,
  VSCODE_MCP_SERVER_DEFINITION_PROVIDER_ID,
} from './vscodeMcpProvider';

const CREATE_INDEX_LABEL = 'Create Shared Index';
const CHOOSE_INDEX_LABEL = 'Choose Existing...';
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
let mcpStatusMonitor: McpStatusMonitor | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let initPromise: Promise<void> | undefined;
let initializationTail: Promise<void> = Promise.resolve();
let initializationGeneration = 0;
let initializedWorkspaceHash: string | undefined;
let webviewRegistered = false;
let progressListener: (() => void) | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let indexingSettingsRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let indexManagementWorkspace: IndexManagementWorkspaceContext | undefined;

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
  mcpStatusMonitor = new McpStatusMonitor({
    workspaceRoots: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
  });
  mcpStatusMonitor.start();
  registerCommands(context);
  registerVscodeMcpProvider(context);
  // Project Skill/Rule install is explicit (toolbar / command) so we do not
  // silently dirty workspace git status on every activation.
  void migrateUserHeaderSourceKeybindings(resolveEditorProduct(), (message) =>
    outputChannel?.appendLine(message)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      mcpStatusMonitor?.setWorkspaceRoots(
        vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []
      );
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
    vscode.commands.registerCommand('codeSearch.installAgentSkill', () => {
      void installAgentSkill(context, true);
    }),
    vscode.commands.registerCommand('codeSearch.installVscodeCopilotInstruction', () => {
      // Deprecated compatibility alias. Project guidance now has one canonical
      // location under .agents and never writes .github/instructions.
      void installAgentSkill(context, true);
    }),
    vscode.commands.registerCommand('codeSearch.copyCursorUserRule', () => {
      void copyCursorUserRule(context);
    }),
    vscode.commands.registerCommand('codeSearch.openSecondaryIndex', async () => {
      if (!(await ensureWorkspaceReady()) || !indexManager || !indexManagementWorkspace) {
        return;
      }
      const operation = captureWorkspaceOperation(indexManager, indexManagementWorkspace);
      await handleCommandOperation(
        await openSecondaryIndex(operation.manager, operation.workspace),
        context,
        operation
      );
    }),
    vscode.commands.registerCommand('codeSearch.selectPrimaryIndex', async () => {
      if (!(await ensureWorkspaceReady()) || !indexManager || !indexManagementWorkspace) {
        return;
      }
      const operation = captureWorkspaceOperation(indexManager, indexManagementWorkspace);
      await handleCommandOperation(
        await selectPrimaryIndex(operation.manager, operation.workspace),
        context,
        operation
      );
    }),
    vscode.commands.registerCommand('codeSearch.createIndex', async () => {
      if (!(await ensureWorkspaceReady()) || !indexManager || !indexManagementWorkspace) {
        return;
      }
      const operation = captureWorkspaceOperation(indexManager, indexManagementWorkspace);
      await handleCommandOperation(
        await createStandaloneIndex(operation.manager),
        context,
        operation
      );
    }),
    vscode.commands.registerCommand('codeSearch.searchInNewTab', () => {
      panelProvider?.searchInNewTab();
    }),
    vscode.commands.registerCommand('codeSearch.switchHeaderSource', () => {
      void switchHeaderSource();
    })
  );
}

async function installAgentSkill(
  context: vscode.ExtensionContext,
  notify: boolean
): Promise<void> {
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      if (notify) {
        void vscode.window.showWarningMessage(
          'Ace Code Search: Open a folder or workspace before installing the project Agent Skill.'
        );
      }
      return;
    }

    const version = String(context.extension.packageJSON.version ?? '0.0.0');
    const installedRoots: string[] = [];
    const warnings: string[] = [];

    // Codex/Cursor need an MCP server entry before Skill tools exist.
    // User-level Codex config applies to the VS Code Codex extension.
    const mcp = await installMcpClientConfig({
      extensionRoot: context.extensionPath,
      workspaceRoots: folders.map((folder) => folder.uri.fsPath),
    });
    for (const item of mcp.paths) {
      outputChannel?.appendLine(
        `MCP config ${item.client}: ${item.path}` +
          (item.changed ? ' (updated)' : '')
      );
    }
    warnings.push(...mcp.warnings);

    for (const folder of folders) {
      const workspaceRoot = folder.uri.fsPath;
      const skill = await installProjectAgentSkill({
        extensionRoot: context.extensionPath,
        version,
        workspaceRoot,
      });
      const canonical = skill.paths.find((item) => item.client === 'agents');
      const rules =
        canonical?.mode === 'canonical' && !canonical.warning
          ? await cleanupLegacyProjectAgentRules({ workspaceRoot })
          : { changed: false, paths: [], warnings: [] };

      for (const item of skill.paths) {
        outputChannel?.appendLine(
          `Project Agent Skill [${folder.name}] ${item.client}: ${item.mode} ${item.path}` +
            (item.changed ? ' (updated)' : '')
        );
      }
      for (const item of rules.paths) {
        outputChannel?.appendLine(
          `Legacy Agent guidance [${folder.name}]: ${item.mode} ${item.path}` +
            (item.changed ? ' (updated)' : '')
        );
      }
      warnings.push(...skill.warnings, ...rules.warnings);
      if (skill.changed || rules.changed || mcp.changed) {
        installedRoots.push(workspaceRoot);
      } else if (skill.warnings.length === 0 && rules.warnings.length === 0) {
        installedRoots.push(workspaceRoot);
      }
    }

    for (const warning of warnings) {
      outputChannel?.appendLine(`Agent guidance warning: ${warning}`);
    }

    if (!notify) {
      return;
    }

    if (warnings.length > 0) {
      void vscode.window.showWarningMessage(
        `Ace Code Search: Project Agent guidance installed with warnings — ${warnings.join(' ')}`
      );
      return;
    }

    const rootLabel =
      installedRoots.length === 1
        ? installedRoots[0]
        : `${installedRoots.length} workspace folders`;
    void vscode.window.showInformationMessage(
      `Ace Code Search: Canonical .agents Skill and user MCP config installed for ${rootLabel}. ` +
        'Restart Codex (or run /mcp) so list_indexes / search_code appear. ' +
        'Codex/Cursor require Node.js 20, 22, or 24 on PATH; VS Code uses its editor runtime.'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel?.appendLine(`Agent Skill install failed: ${message}`);
    if (notify) {
      void vscode.window.showErrorMessage(
        `Ace Code Search: Failed to install project Agent guidance — ${message}`
      );
    }
  }
}

function registerVscodeMcpProvider(context: vscode.ExtensionContext): void {
  if (resolveEditorProduct() !== 'Code') {
    return;
  }
  const runtime = vscode as typeof vscode & {
    McpStdioServerDefinition?: typeof vscode.McpStdioServerDefinition;
    lm?: typeof vscode.lm;
  };
  const register = runtime.lm?.registerMcpServerDefinitionProvider;
  const StdioDefinition = runtime.McpStdioServerDefinition;
  if (typeof register !== 'function' || typeof StdioDefinition !== 'function') {
    outputChannel?.appendLine(
      'VS Code MCP provider API is unavailable in this editor version; Codex/Cursor user config remains available.'
    );
    return;
  }

  const changed = new vscode.EventEmitter<void>();
  const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const launch = buildVscodeMcpLaunchSpec({
        extensionRoot: context.extensionPath,
        executablePath: process.execPath,
        version: String(context.extension.packageJSON.version ?? '0.0.0'),
        workspaceRoots: folders.map((folder) => folder.uri.fsPath),
      });
      if (!launch) {
        return [];
      }
      const definition = new StdioDefinition(
        launch.label,
        launch.command,
        launch.args,
        launch.env,
        launch.version
      );
      definition.cwd =
        folders.find((folder) => folder.uri.fsPath === launch.cwd)?.uri ??
        vscode.Uri.file(launch.cwd);
      return [definition];
    },
  };

  context.subscriptions.push(
    changed,
    runtime.lm!.registerMcpServerDefinitionProvider(
      VSCODE_MCP_SERVER_DEFINITION_PROVIDER_ID,
      provider
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire())
  );
}

async function copyCursorUserRule(
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    const rule = (await readCursorUserRule(context.extensionPath)).trim();
    await vscode.env.clipboard.writeText(rule);
    void vscode.window.showInformationMessage(
      'Ace Code Search: Cursor User Rule copied. Paste it into Cursor Settings → Rules → User Rules.'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel?.appendLine(`Copy Cursor User Rule failed: ${message}`);
    void vscode.window.showErrorMessage(
      `Ace Code Search: Failed to copy Cursor User Rule — ${message}`
    );
  }
}

function initializeWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const generation = ++initializationGeneration;
  const task = initializationTail
    .catch(() => undefined)
    .then(() => initializeWorkspaceNow(context, generation));
  initializationTail = task;
  initPromise = task;
  void task
    .finally(() => {
      if (initPromise === task) {
        initPromise = undefined;
      }
    })
    .catch(() => undefined);
  return task;
}

async function initializeWorkspaceNow(
  context: vscode.ExtensionContext,
  generation: number
): Promise<void> {
  if (generation !== initializationGeneration) {
    return;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    await saveSecondaryIds(context);
    await panelProvider?.disposeActiveSearches();
    await disposeWorkspaceResources();
    initializedWorkspaceHash = undefined;
    return;
  }

  const hash = workspaceHash(folders);
  if (initializedWorkspaceHash === hash && indexManager) {
    return;
  }
  if (indexManager) {
    await saveSecondaryIds(context);
    await panelProvider?.disposeActiveSearches();
    await disposeWorkspaceResources();
  }

  if (generation !== initializationGeneration) {
    return;
  }

  try {
    await doInitializeWorkspace(context, folders);
    const currentFolders = vscode.workspace.workspaceFolders;
    const currentHash = currentFolders?.length ? workspaceHash(currentFolders) : undefined;
    if (generation !== initializationGeneration || currentHash !== hash) {
      await saveSecondaryIds(context);
      await panelProvider?.disposeActiveSearches();
      await disposeWorkspaceResources();
      initializedWorkspaceHash = undefined;
      return;
    }
    initializedWorkspaceHash = hash;
  } catch (err) {
    initializedWorkspaceHash = undefined;
    await disposeWorkspaceResources();
    if (generation !== initializationGeneration) {
      return;
    }
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

  const autocreate = await findAutocreateConfig(folders);
  if (autocreate) {
    applyAutocreateToConfig(autocreate.config);
  }

  const roots = getEffectiveRoots(folders, autocreate?.rootDir);
  const sharedDbPath = getSharedWorkspaceDbPath(getSharedWorkspaceKey(roots));
  const legacyDefaultDbPath = path.join(
    globalStorage,
    'code-search',
    hash,
    'index.db'
  );
  const legacyOrAutocreateDbPath = autocreate
    ? resolveIndexDbPath(autocreate.config, autocreate.rootDir, globalStorage, hash)
    : legacyDefaultDbPath;

  indexManager = new IndexManager(globalStorage, hash, {
    writerLabel: resolveEditorProduct(),
    sharedDbPath,
    workspaceRoots: roots,
  });
  await indexManager.initialize();

  const indexName = autocreate?.config.name ?? 'Primary';
  let shouldStartIndexing = false;
  let primarySource: IndexManagementWorkspaceContext['primarySource'];
  const bindingKey = getWorkspaceIndexBindingKey(hash);
  const storedBindingRaw = context.workspaceState.get<unknown>(bindingKey);
  const storedBinding = normalizeWorkspaceIndexBinding(storedBindingRaw);
  const secondaryRestoreSource = getWorkspaceSecondaryRestoreSource(
    storedBindingRaw,
    context.workspaceState.get<boolean>(LEGACY_SECONDARY_IDS_MIGRATION_MARKER_KEY, false)
  );
  indexManagementWorkspace = {
    hash,
    roots,
    sharedDbPath,
    autocreate: !!autocreate,
  };

  if (autocreate) {
    const excludeRules = extractPerIndexExcludesFromAutocreate(autocreate.config);
    if (autocreate.config.readOnly) {
      if (!(await fileExists(legacyOrAutocreateDbPath))) {
        throw new Error(
          `Autocreate read-only index does not exist: ${legacyOrAutocreateDbPath}`
        );
      }
      await indexManager.openPrimary(legacyOrAutocreateDbPath, roots, indexName, {
        readOnly: true,
        excludeRules,
      });
    } else {
      await indexManager.createPrimary(
        legacyOrAutocreateDbPath,
        roots,
        indexName,
        excludeRules
      );
    }
    primarySource = 'autocreate';
    shouldStartIndexing = true;
  } else {
    type StartupDetails = {
      source: NonNullable<IndexManagementWorkspaceContext['primarySource']>;
    };
    const startupCandidates: Array<
      StartupPrimaryCandidate<Awaited<ReturnType<IndexManager['openPrimary']>>, StartupDetails>
    > = [];

    if (storedBinding.primary && (await fileExists(storedBinding.primary.dbPath))) {
      const savedPrimary = storedBinding.primary;
      const primaryRoots = savedPrimary.rootDirs?.length
        ? savedPrimary.rootDirs
        : roots;
      startupCandidates.push({
        dbPath: savedPrimary.dbPath,
        details: { source: savedPrimary.source },
        open: () =>
          indexManager!.openPrimary(
            savedPrimary.dbPath,
            primaryRoots,
            savedPrimary.name ?? indexName,
            {
              readOnly: savedPrimary.accessMode === 'readOnly',
              directoryMappings: savedPrimary.directoryMappings,
            }
          ),
      });
    } else if (storedBinding.primary) {
      outputChannel?.appendLine(
        `Saved primary index is missing; falling back to discovery: ${storedBinding.primary.dbPath}`
      );
    }

    const existingIndexes = await findExistingWorkspaceIndexes(
      hash,
      sharedDbPath,
      indexManager.getRegistry(),
      [legacyDefaultDbPath]
    );
    for (const existing of existingIndexes) {
      const source = samePhysicalIndex(existing.dbPath, sharedDbPath) ? 'shared' : 'legacy';
      startupCandidates.push({
        dbPath: existing.dbPath,
        details: { source },
        open: () =>
          indexManager!.openPrimary(existing.dbPath, roots, indexName, {
            readOnly: false,
          }),
      });
    }

    const selection = await selectFirstUsableStartupPrimary(
      startupCandidates,
      (failure) => {
        const message = failure.error instanceof Error
          ? failure.error.message
          : String(failure.error);
        outputChannel?.appendLine(
          `Unable to restore ${failure.details.source} primary ${failure.dbPath}; ` +
            `continuing startup fallback: ${message}`
        );
      }
    );
    if (selection.selected) {
      const service = selection.selected.value;
      primarySource = selection.selected.candidate.details.source;
      shouldStartIndexing = getConfig().indexOnStartup || service.isReadOnly();
    } else {
      const choice = await vscode.window.showInformationMessage(
        'Ace Code Search: No index is selected for this workspace.',
        CREATE_INDEX_LABEL,
        CHOOSE_INDEX_LABEL,
        SKIP_INDEX_LABEL
      );
      if (choice === CREATE_INDEX_LABEL) {
        try {
          await indexManager.createPrimary(sharedDbPath, roots, 'Shared workspace index');
          primarySource = 'shared';
          shouldStartIndexing = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          outputChannel?.appendLine(`Unable to create shared primary ${sharedDbPath}: ${message}`);
          void vscode.window.showErrorMessage(`Ace Code Search: ${message}`);
        }
      } else if (choice === CHOOSE_INDEX_LABEL) {
        const result = await selectPrimaryIndex(indexManager, indexManagementWorkspace);
        if (result.status === 'error') {
          void vscode.window.showErrorMessage(`Ace Code Search: ${result.message}`);
        } else if (result.status === 'ok') {
          primarySource = result.source;
        }
      }
    }
  }

  indexManagementWorkspace.primarySource = primarySource;

  if (secondaryRestoreSource === 'keyedBinding') {
    for (const secondary of storedBinding.secondaries) {
      try {
        const service = await indexManager.attachSecondary(secondary.dbPath, {
          name: secondary.name,
          readOnly: secondary.accessMode === 'readOnly',
          directoryMappings: secondary.directoryMappings,
          rootDirs: secondary.rootDirs,
          waitForInitialIndex: false,
        });
        startSecondaryIndexing(service, secondary.dbPath);
      } catch (error) {
        if (secondary.accessMode === 'auto' && !secondary.rootDirs?.length) {
          try {
            const service = await indexManager.attachSecondary(secondary.dbPath, {
              name: secondary.name,
              readOnly: true,
              directoryMappings: secondary.directoryMappings,
              rootDirs: [],
              waitForInitialIndex: false,
            });
            startSecondaryIndexing(service, secondary.dbPath);
            continue;
          } catch {
            // Log the original restore failure below.
          }
        }
        outputChannel?.appendLine(
          `Unable to restore secondary ${secondary.dbPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } else if (secondaryRestoreSource === 'legacyIds') {
    const secondaryIds = context.workspaceState.get<string[]>('secondaryIndexIds', []);
    const restored = await indexManager.loadWorkspaceSecondaries(secondaryIds, {
      waitForInitialIndex: false,
    });
    for (const service of restored) {
      startSecondaryIndexing(service, service.getDbPath());
    }
  }

  if (storedBindingRaw === undefined) {
    const legacyPrimary = indexManager.getPrimary()
      ? indexManager.getRegistry().getById(indexManager.getPrimary()!.id)
      : undefined;
    const migrated = migrateLegacyWorkspaceBinding(
      legacyPrimary,
      indexManager.getAttachedIndexes().map((item) => item.meta)
    );
    await context.workspaceState.update(bindingKey, migrated);
  }
  await context.workspaceState.update(LEGACY_SECONDARY_IDS_MIGRATION_MARKER_KEY, true);
  const preserveUnresolvedStoredPrimary =
    !!storedBinding.primary && !indexManager.getPrimary();
  if (preserveUnresolvedStoredPrimary) {
    outputChannel?.appendLine(
      `Keeping unresolved saved primary binding for a later retry: ${storedBinding.primary!.dbPath}`
    );
  } else {
    await saveWorkspaceIndexBinding(indexManager, context, primarySource);
  }

  IndexManagePanel.register(context, indexManager, indexManagementWorkspace);

  searchService ??= new MultiIndexSearchService(indexManager);
  const workspaceRoots = folders.map((f) => f.uri.fsPath);
  mcpStatusMonitor?.setWorkspaceRoots(workspaceRoots);

  if (panelProvider) {
    panelProvider.rebind(indexManager, searchService, workspaceRoots);
  } else {
    panelProvider = new SearchPanelProvider(
      context.extensionUri,
      indexManager,
      searchService,
      workspaceRoots,
      context,
      mcpStatusMonitor!
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
    startPrimaryIndexing(indexManager.getPrimary());
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
    : manager.getSharedDbPath() ?? getSharedWorkspaceDbPath(getSharedWorkspaceKey(roots));
  const indexName = autocreate?.config.name ?? 'Primary';
  const excludeRules = autocreate ? extractPerIndexExcludesFromAutocreate(autocreate.config) : undefined;

  await manager.createPrimary(dbPath, roots, indexName, excludeRules);
  if (indexManagementWorkspace) {
    indexManagementWorkspace.primarySource = autocreate ? 'autocreate' : 'shared';
    await saveWorkspaceIndexBinding(
      manager,
      extensionContext,
      indexManagementWorkspace.primarySource
    );
  }
  startPrimaryIndexing(manager.getPrimary());
  return true;
}

function startPrimaryIndexing(service: ReturnType<IndexManager['getPrimary']>): void {
  if (!service) {
    return;
  }
  void service.startIndexing().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel?.appendLine(`Primary indexing failed: ${message}`);
    void vscode.window.showErrorMessage(`Ace Code Search: ${message}`);
  });
}

function startSecondaryIndexing(
  service: Awaited<ReturnType<IndexManager['attachSecondary']>>,
  dbPath: string
): void {
  void service.startIndexing().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel?.appendLine(`Secondary indexing failed for ${dbPath}: ${message}`);
  });
}

function rebuildSearchBindings(): void {
  if (!indexManager) {
    return;
  }
  searchService ??= new MultiIndexSearchService(indexManager);
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
  };
  indexManager.on('progress', progressListener);
}

function updateStatusBar(message: string): void {
  if (statusBarItem) {
    statusBarItem.text = `$(search) ${message}`;
    statusBarItem.show();
  }
}

async function disposeWorkspaceResources(): Promise<void> {
  if (progressListener && indexManager) {
    indexManager.off('progress', progressListener);
  }
  progressListener = undefined;
  await indexManager?.dispose();
  indexManager = undefined;
  searchService = undefined;
  indexManagementWorkspace = undefined;
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
  await saveWorkspaceIndexBinding(
    indexManager,
    context,
    indexManagementWorkspace?.primarySource
  );
}

async function handleCommandOperation(
  result: IndexOperationResult,
  context: vscode.ExtensionContext,
  operation: WorkspaceOperationToken<IndexManager, IndexManagementWorkspaceContext>
): Promise<void> {
  if (result.status === 'cancelled') {
    return;
  }
  if (result.status === 'error') {
    void vscode.window.showErrorMessage(`Ace Code Search: ${result.message}`);
    return;
  }
  if (isWorkspaceOperationCurrent(operation, indexManager, indexManagementWorkspace)) {
    if (result.source) {
      operation.workspace.primarySource = result.source;
    }
    await saveWorkspaceIndexBinding(
      operation.manager,
      context,
      operation.workspace.primarySource
    );
    if (isWorkspaceOperationCurrent(operation, indexManager, indexManagementWorkspace)) {
      rebuildSearchBindings();
    }
  }
  if (result.message) {
    void vscode.window.showInformationMessage(`Ace Code Search: ${result.message}`);
  }
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
  initializationGeneration++;
  await initializationTail.catch(() => undefined);
  if (indexingSettingsRefreshTimer) {
    clearTimeout(indexingSettingsRefreshTimer);
    indexingSettingsRefreshTimer = undefined;
  }
  if (extensionContext) {
    await saveSecondaryIds(extensionContext);
  }
  await panelProvider?.dispose();
  panelProvider = undefined;
  await mcpStatusMonitor?.dispose();
  mcpStatusMonitor = undefined;
  await disposeWorkspaceResources();
  statusBarItem?.dispose();
  statusBarItem = undefined;
}

async function fileExists(filePath: string): Promise<boolean> {
  const fs = await import('fs');
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function fsMkdir(dir: string): Promise<void> {
  const fs = await import('fs');
  await fs.promises.mkdir(dir, { recursive: true });
}
