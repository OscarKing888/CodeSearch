import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IndexManager } from '../index/IndexManager';
import { IndexService } from '../index/IndexService';
import { DirectoryMapping, IndexMeta } from '../index/types';
import { formatPatternLines, parsePatternLines, PerIndexExcludes } from '../index/excludePatterns';
import {
  DEFAULT_UNREAL_CORE_EXCLUDE_DIR_NAMES,
  getIndexingSettings,
} from '../indexingSettings';
import {
  discoverWorkspaceIndexCandidates,
  WorkspaceIndexCandidate,
} from '../index/indexDiscovery';
import { canonicalPathKey, samePath } from '../index/sharedIndexStorage';
import {
  getWorkspaceIndexBindingKey,
  IndexAccessMode,
  mergeWorkspaceSecondaryBindings,
  normalizeWorkspaceIndexBinding,
  PrimaryIndexSource,
  WorkspaceIndexBindingV2,
} from '../index/workspaceIndexBinding';

import { formatIndexDisplayTitle } from './indexDisplayTitle';
import { mergeIndexCatalog } from './indexCatalog';

export { formatIndexDisplayTitle } from './indexDisplayTitle';

export interface IndexListItem {
  id: string;
  name: string;
  displayTitle: string;
  dbPath: string;
  rootDirs: string[];
  readOnly: boolean;
  requestedReadOnly: boolean;
  usage: 'primary' | 'secondary' | 'available';
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
  status: 'idle' | 'scanning' | 'indexing' | 'upToDate' | 'available' | 'missing';
  partial: boolean;
  canRefresh: boolean;
}

export interface IndexManagementWorkspaceContext {
  hash: string;
  roots: string[];
  sharedDbPath: string;
  primarySource?: PrimaryIndexSource;
  autocreate?: boolean;
}

export interface IndexWorkspaceSummary {
  hash: string;
  roots: string[];
  sharedDbPath: string;
  autocreate: boolean;
  primary?: {
    id: string;
    dbPath: string;
    source: PrimaryIndexSource;
    accessMode: 'writable' | 'readOnly';
    writerLabel?: string;
  };
}

export interface IndexListPayload {
  workspace: IndexWorkspaceSummary;
  indexingRules: {
    includeGlobsText: string;
    inheritedExcludeDirsText: string;
    inheritedExcludeFilesText: string;
    inheritedExcludeGlobsText: string;
    unrealCoreDirs: string[];
  };
  indexes: IndexListItem[];
}

export type IndexOperationResult =
  | { status: 'ok'; message?: string; source?: PrimaryIndexSource }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

interface IndexPickerItem extends vscode.QuickPickItem {
  pickerType: 'candidate' | 'browse';
  candidate?: WorkspaceIndexCandidate;
}

export function parseMappings(input: string): DirectoryMapping[] {
  const mappings: DirectoryMapping[] = [];
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split('=>').map((s) => s.trim());
    if (parts.length === 2 && parts[0] && parts[1]) {
      mappings.push({ from: parts[0], to: parts[1] });
    }
  }
  return mappings;
}

export function formatMappings(mappings: DirectoryMapping[]): string {
  return mappings.map((m) => `${m.from} => ${m.to}`).join('\n');
}

export function formatExcludeRules(meta: Pick<IndexMeta, 'excludeDirNames' | 'excludeFileNames' | 'excludeGlobs'>): {
  excludeDirsText: string;
  excludeFilesText: string;
  excludeGlobsText: string;
} {
  return {
    excludeDirsText: formatPatternLines(meta.excludeDirNames),
    excludeFilesText: formatPatternLines(meta.excludeFileNames),
    excludeGlobsText: formatPatternLines(meta.excludeGlobs),
  };
}

export function parseExcludeRulesInput(
  dirsText: string,
  filesText: string,
  globsText: string
): PerIndexExcludes {
  return {
    excludeDirNames: parsePatternLines(dirsText),
    excludeFileNames: parsePatternLines(filesText),
    excludeGlobs: parsePatternLines(globsText),
  };
}

export function getIndexListPayload(
  manager: IndexManager,
  workspaceContext?: IndexManagementWorkspaceContext
): IndexListPayload {
  const indexingSettings = getIndexingSettings();
  const primary = manager.getPrimary();
  const primaryId = primary?.id;
  const attachedIds = new Set(manager.getWorkspaceSecondaryIds());
  const registryIndexes = manager.getRegistry().getAll();
  const activeIndexes: IndexMeta[] = [];
  if (primary) {
    const registered = manager.getIndexMeta(primary.id);
    const runtime = manager.getRuntimeAccess(primary.id);
    activeIndexes.push({
      ...(registered ?? {
        directoryMappings: [],
        workspaceHashes: [manager.getWorkspaceHash()],
        createdAt: 0,
        updatedAt: 0,
      }),
      id: primary.id,
      name: primary.name,
      dbPath: primary.getDbPath(),
      rootDirs: primary.getRootDirs(),
      readOnly: runtime?.requestedReadOnly ?? primary.isReadOnly(),
    });
  }
  for (const { meta, service } of manager.getAttachedIndexes()) {
    const runtime = manager.getRuntimeAccess(service.id);
    activeIndexes.push({
      ...meta,
      id: service.id,
      name: service.name,
      dbPath: service.getDbPath(),
      rootDirs: service.getRootDirs(),
      readOnly: runtime?.requestedReadOnly ?? service.isReadOnly(),
    });
  }
  const catalogIndexes = mergeIndexCatalog(registryIndexes, activeIndexes);
  const items: IndexListItem[] = [];

  for (const meta of catalogIndexes) {
    const service = findServiceById(manager, meta.id);
    const progress = service?.getProgress();
    const runtimeAccess = manager.getRuntimeAccess(meta.id);
    const excludeText = formatExcludeRules(meta);
    const isPrimary = meta.id === primaryId;
    const isAttachedSecondary = attachedIds.has(meta.id);
    const exists = fs.existsSync(meta.dbPath);
    const status = progress?.status ?? (exists ? 'available' : 'missing');
    const readOnly = service?.isReadOnly() ?? meta.readOnly;
    items.push({
      id: meta.id,
      name: meta.name,
      displayTitle: formatIndexDisplayTitle(meta.rootDirs, meta.name),
      dbPath: meta.dbPath,
      rootDirs: meta.rootDirs,
      readOnly,
      requestedReadOnly: runtimeAccess?.requestedReadOnly ?? meta.readOnly,
      usage: isPrimary ? 'primary' : isAttachedSecondary ? 'secondary' : 'available',
      isPrimary,
      isAttached: isPrimary || isAttachedSecondary,
      exists,
      isShared: workspaceContext ? samePath(meta.dbPath, workspaceContext.sharedDbPath) : false,
      writerLabel:
        runtimeAccess && runtimeAccess.effectiveReadOnly && !runtimeAccess.requestedReadOnly
          ? runtimeAccess.writerOwner?.label
          : undefined,
      directoryMappings: meta.directoryMappings,
      mappingsText: formatMappings(meta.directoryMappings),
      excludeDirsText: excludeText.excludeDirsText,
      excludeFilesText: excludeText.excludeFilesText,
      excludeGlobsText: excludeText.excludeGlobsText,
      statusMessage: progress?.message ?? (exists ? 'Available' : 'Database missing'),
      status,
      partial: progress ? progress.status === 'scanning' || progress.status === 'indexing' : false,
      canRefresh: !!service && !service.isReadOnly(),
    });
  }

  items.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) {
      return a.isPrimary ? -1 : 1;
    }
    if (a.isAttached !== b.isAttached) {
      return a.isAttached ? -1 : 1;
    }
    return a.displayTitle.localeCompare(b.displayTitle);
  });

  const primaryRuntime = primary ? manager.getRuntimeAccess(primary.id) : undefined;
  const source: PrimaryIndexSource = workspaceContext?.autocreate
    ? 'autocreate'
    : workspaceContext?.primarySource ??
      (primary && workspaceContext && samePath(primary.getDbPath(), workspaceContext.sharedDbPath)
        ? 'shared'
        : 'legacy');

  return {
    workspace: {
      hash: workspaceContext?.hash ?? manager.getWorkspaceHash(),
      roots: workspaceContext?.roots ?? manager.getWorkspaceRoots(),
      sharedDbPath: workspaceContext?.sharedDbPath ?? manager.getSharedDbPath() ?? '',
      autocreate: workspaceContext?.autocreate ?? false,
      primary: primary
        ? {
            id: primary.id,
            dbPath: primary.getDbPath(),
            source,
            accessMode: primary.isReadOnly() ? 'readOnly' : 'writable',
            writerLabel:
              primaryRuntime?.effectiveReadOnly && !primaryRuntime.requestedReadOnly
                ? primaryRuntime.writerOwner?.label
                : undefined,
          }
        : undefined,
    },
    indexingRules: {
      includeGlobsText: formatPatternLines(indexingSettings.includeGlobs),
      inheritedExcludeDirsText: formatPatternLines(indexingSettings.excludeDirNames),
      inheritedExcludeFilesText: formatPatternLines(indexingSettings.excludeFileNames),
      inheritedExcludeGlobsText: formatPatternLines(indexingSettings.excludeGlobs),
      unrealCoreDirs: [...DEFAULT_UNREAL_CORE_EXCLUDE_DIR_NAMES],
    },
    indexes: items,
  };
}

function findServiceById(manager: IndexManager, id: string): IndexService | undefined {
  const primary = manager.getPrimary();
  if (primary?.id === id) {
    return primary;
  }
  return manager.getAttachedIndexes().find((a) => a.meta.id === id)?.service;
}

async function discoverCandidates(
  manager: IndexManager,
  workspaceContext?: IndexManagementWorkspaceContext
): Promise<WorkspaceIndexCandidate[]> {
  const roots = workspaceContext?.roots ?? manager.getWorkspaceRoots();
  const hash = workspaceContext?.hash ?? manager.getWorkspaceHash();
  return discoverWorkspaceIndexCandidates(roots, hash, {
    source: 'current-ide',
    path: manager.getRegistry().getPath(),
    indexes: manager.getRegistry().getAll(),
  });
}

function candidateKey(dbPath: string): string {
  return canonicalPathKey(dbPath);
}

function formatCandidateSource(source: string): string {
  if (source === 'current-ide') return 'This IDE';
  if (source.startsWith('vscode:')) return 'VS Code';
  if (source.startsWith('cursor:')) return 'Cursor';
  if (source === 'shared') return 'Shared path';
  return source;
}

export async function useSharedPrimaryIndex(
  manager: IndexManager,
  workspaceContext: IndexManagementWorkspaceContext
): Promise<IndexOperationResult> {
  if (workspaceContext.autocreate) {
    return {
      status: 'error',
      message: 'This workspace primary is controlled by code-search.autocreate',
    };
  }
  try {
    const service = await manager.openPrimary(
      workspaceContext.sharedDbPath,
      workspaceContext.roots,
      'Shared workspace index',
      { readOnly: false }
    );
    void service.startIndexing().catch((error) => {
      void vscode.window.showErrorMessage(`Ace Code Search: ${errorMessage(error)}`);
    });
    const access = manager.getRuntimeAccess(service.id);
    return {
      status: 'ok',
      source: 'shared',
      message:
        access?.effectiveReadOnly && !access.requestedReadOnly
          ? `Using the shared index read-only while ${access.writerOwner?.label ?? 'another IDE'} owns writes`
          : 'Using the shared cross-IDE workspace index',
    };
  } catch (error) {
    return { status: 'error', message: errorMessage(error) };
  }
}

export async function selectPrimaryIndex(
  manager: IndexManager,
  workspaceContext: IndexManagementWorkspaceContext
): Promise<IndexOperationResult> {
  if (workspaceContext.autocreate) {
    return {
      status: 'error',
      message: 'Edit code-search.autocreate to change this workspace primary index',
    };
  }

  const currentPath = manager.getPrimary()?.getDbPath();
  const discovered = await discoverCandidates(manager, workspaceContext);
  const discoveredShared = discovered.find((candidate) =>
    samePath(candidate.meta.dbPath, workspaceContext.sharedDbPath)
  );
  const candidates = discovered.filter(
    (candidate) =>
      candidate.exists &&
      !samePath(candidate.meta.dbPath, workspaceContext.sharedDbPath) &&
      (!currentPath || !samePath(candidate.meta.dbPath, currentPath))
  );
  const items: IndexPickerItem[] = candidates.map((candidate) => ({
    label: candidate.meta.name,
    description: candidate.sources.map(formatCandidateSource).join(', '),
    detail: candidate.meta.dbPath,
    pickerType: 'candidate',
    candidate,
  }));
  const registeredShared = manager
    .getRegistry()
    .getByDbPath(workspaceContext.sharedDbPath);
  items.unshift({
    label: 'Use shared workspace index',
    description: 'Same deterministic database path in VS Code and Cursor',
    detail: workspaceContext.sharedDbPath,
    pickerType: 'candidate',
    candidate: {
      key: candidateKey(workspaceContext.sharedDbPath),
      meta: registeredShared ?? discoveredShared?.meta ?? {
        id: '__shared__',
        name: 'Shared workspace index',
        dbPath: workspaceContext.sharedDbPath,
        rootDirs: workspaceContext.roots,
        readOnly: false,
        directoryMappings: [],
        workspaceHashes: [workspaceContext.hash],
        createdAt: 0,
        updatedAt: 0,
      },
      sources: ['shared'],
      exactRoots: true,
      legacyHashMatch: true,
      exists: fs.existsSync(workspaceContext.sharedDbPath),
    },
  });
  items.push({
    label: 'Browse for index database...',
    description: 'Manually choose an existing index.db file',
    pickerType: 'browse',
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose the primary index for this workspace',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return { status: 'cancelled' };
  }

  let dbPath = picked.candidate?.meta.dbPath;
  let name = picked.candidate?.meta.name ?? 'Primary';
  let rootDirs = picked.candidate?.meta.rootDirs ?? workspaceContext.roots;
  if (picked.pickerType === 'browse') {
    const uri = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { Database: ['db'] },
      openLabel: 'Use as workspace primary',
    });
    if (!uri?.[0]) {
      return { status: 'cancelled' };
    }
    dbPath = uri[0].fsPath;
    name = path.basename(path.dirname(dbPath)) || 'Primary';
    rootDirs = workspaceContext.roots;
  }
  if (!dbPath) {
    return { status: 'error', message: 'No primary index database was selected' };
  }

  const isShared = samePath(dbPath, workspaceContext.sharedDbPath);
  const access = isShared && !fs.existsSync(dbPath)
    ? { value: false }
    : await vscode.window.showQuickPick(
        [
          {
            label: 'Read-only (Recommended for an existing index)',
            description: 'Never scans or writes from this IDE',
            value: true,
          },
          {
            label: 'Automatic single-writer',
            description: 'Writable only when no other IDE owns the writer lease',
            value: false,
          },
        ],
        { placeHolder: 'Primary index access mode' }
      );
  if (!access) {
    return { status: 'cancelled' };
  }

  try {
    const service = await manager.openPrimary(dbPath, rootDirs, name, {
      readOnly: access.value,
      excludeRules: picked.candidate
        ? {
            excludeDirNames: picked.candidate.meta.excludeDirNames,
            excludeFileNames: picked.candidate.meta.excludeFileNames,
            excludeGlobs: picked.candidate.meta.excludeGlobs,
          }
        : undefined,
      directoryMappings: picked.candidate?.meta.directoryMappings,
    });
    void service.startIndexing().catch((error) => {
      void vscode.window.showErrorMessage(`Ace Code Search: ${errorMessage(error)}`);
    });
    const source: PrimaryIndexSource = isShared ? 'shared' : 'manual';
    const runtime = manager.getRuntimeAccess(service.id);
    return {
      status: 'ok',
      source,
      message:
        runtime?.effectiveReadOnly && !runtime.requestedReadOnly
          ? `Primary opened read-only while ${runtime.writerOwner?.label ?? 'another IDE'} owns writes`
          : 'Workspace primary index changed',
    };
  } catch (error) {
    return { status: 'error', message: errorMessage(error) };
  }
}

export async function renameIndex(manager: IndexManager, id: string, name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Name cannot be empty';
  }
  const ok = await manager.renameIndex(id, trimmed);
  return ok ? null : 'Rename failed';
}

export async function setMappings(
  manager: IndexManager,
  id: string,
  text: string
): Promise<string | null> {
  const mappings = parseMappings(text);
  const ok = await manager.setDirectoryMappings(id, mappings);
  return ok ? null : 'Failed to save mappings';
}

export async function setExcludeRules(
  manager: IndexManager,
  id: string,
  dirsText: string,
  filesText: string,
  globsText: string
): Promise<string | null> {
  const rules = parseExcludeRulesInput(dirsText, filesText, globsText);
  const ok = await manager.setExcludeRules(id, rules);
  if (!ok) {
    return 'Failed to save exclude rules';
  }

  const service = findServiceById(manager, id);
  if (service && !service.isReadOnly()) {
    try {
      await service.refresh(true);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  return null;
}

export async function attachIndex(manager: IndexManager, id: string): Promise<string | null> {
  const meta = manager.getRegistry().getById(id);
  if (!meta) {
    return 'Index not found';
  }
  if (manager.getPrimary()?.id === id) {
    return 'Primary index is always attached';
  }
  try {
    const service = await manager.attachSecondary(meta.dbPath, {
      name: meta.name,
      readOnly: meta.readOnly || meta.rootDirs.length === 0,
      directoryMappings: meta.directoryMappings,
      rootDirs: meta.rootDirs,
      waitForInitialIndex: false,
    });
    startSecondaryIndexingInBackground(service, meta.dbPath);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function detachIndex(manager: IndexManager, id: string): Promise<string | null> {
  if (manager.getPrimary()?.id === id) {
    return 'Cannot detach primary index';
  }
  const ok = await manager.detachSecondary(id);
  return ok ? null : 'Index is not attached';
}

export async function deleteIndex(
  manager: IndexManager,
  id: string,
  deleteFiles: boolean
): Promise<string | null> {
  if (manager.getPrimary()?.id === id) {
    return 'Cannot delete the active primary index';
  }
  if (deleteFiles && manager.getAttachedIndex(id)) {
    return 'Close the Secondary index before deleting its data';
  }
  const ok = await manager.deleteIndex(id, deleteFiles);
  if (ok) {
    return null;
  }
  return deleteFiles
    ? 'Index data could not be deleted because the database is active, referenced elsewhere, or locked by another IDE'
    : 'Delete failed';
}

export async function refreshIndexById(manager: IndexManager, id: string): Promise<string | null> {
  const service = findServiceById(manager, id);
  if (!service) {
    return 'Index is not loaded';
  }
  if (service.isReadOnly()) {
    return 'Read-only index cannot be refreshed';
  }
  try {
    await service.refresh(true);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function refreshAllIndexes(manager: IndexManager): Promise<string | null> {
  try {
    await manager.refreshAll(true);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function moveIndexDb(
  manager: IndexManager,
  id: string,
  newDbPath: string
): Promise<string | null> {
  const ok = await manager.moveIndex(id, newDbPath);
  return ok ? null : 'Move failed';
}

export async function createStandaloneIndex(manager: IndexManager): Promise<IndexOperationResult> {
  const rootUri = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Select root directory to index',
  });
  if (!rootUri?.[0]) {
    return { status: 'cancelled' };
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Index name',
    value: path.basename(rootUri[0].fsPath),
  });
  if (!name) {
    return { status: 'cancelled' };
  }

  const saveUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(rootUri[0].fsPath, `${name}.db`)),
    filters: { Database: ['db'] },
  });
  if (!saveUri) {
    return { status: 'cancelled' };
  }

  try {
    await fs.promises.mkdir(path.dirname(saveUri.fsPath), { recursive: true });
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Indexing ${name}...` },
      () =>
        manager.attachSecondary(saveUri.fsPath, {
          name,
          readOnly: false,
          rootDirs: [rootUri[0].fsPath],
        })
    );
    return { status: 'ok', message: 'Secondary index created' };
  } catch (e) {
    return { status: 'error', message: errorMessage(e) };
  }
}

export async function browseAndAttachIndex(
  manager: IndexManager,
  workspaceContext?: IndexManagementWorkspaceContext
): Promise<IndexOperationResult> {
  const indexes = manager.getRegistry().getAll();
  const primaryPath = manager.getPrimary()?.getDbPath();
  const attachedPaths = new Set(
    manager.getAttachedIndexes().map((item) => canonicalPathKey(item.meta.dbPath))
  );
  const candidates = await discoverCandidates(manager, workspaceContext);
  const byPath = new Map<string, WorkspaceIndexCandidate>();
  for (const candidate of candidates) {
    byPath.set(candidate.key, candidate);
  }
  for (const meta of indexes) {
    const key = candidateKey(meta.dbPath);
    if (!byPath.has(key)) {
      byPath.set(key, {
        key,
        meta,
        sources: ['current-ide'],
        exactRoots: false,
        legacyHashMatch: false,
        exists: fs.existsSync(meta.dbPath),
      });
    }
  }

  const items: IndexPickerItem[] = Array.from(byPath.values())
    .filter(
      (candidate) =>
        candidate.exists &&
        (!primaryPath || !samePath(candidate.meta.dbPath, primaryPath)) &&
        !attachedPaths.has(candidate.key)
    )
    .map((candidate) => ({
      label: candidate.meta.name,
      description: candidate.sources.map(formatCandidateSource).join(', '),
      detail: candidate.meta.dbPath,
      pickerType: 'candidate',
      candidate,
    }));
  items.push({
    label: 'Browse for index database...',
    description: 'Choose an index.db file',
    pickerType: 'browse',
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Open a secondary index',
  });
  if (!picked) {
    return { status: 'cancelled' };
  }

  let dbPath = picked.candidate?.meta.dbPath;
  if (picked.pickerType === 'browse') {
    const uri = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { Database: ['db'] },
    });
    if (!uri?.[0]) {
      return { status: 'cancelled' };
    }
    dbPath = uri[0].fsPath;
  }
  if (!dbPath) {
    return { status: 'error', message: 'No index database was selected' };
  }

  const access = await vscode.window.showQuickPick(
    [
      {
        label: 'Read-only (Recommended)',
        description: 'Safe when another IDE owns or updates this index',
        value: true,
      },
      {
        label: 'Automatic single-writer',
        description: 'Writable here only when no other IDE holds the writer lease',
        value: false,
      },
    ],
    { placeHolder: 'Open mode' }
  );
  if (!access) {
    return { status: 'cancelled' };
  }

  try {
    let rootDirs = picked.candidate?.meta.rootDirs ?? [];
    if (!access.value && rootDirs.length === 0) {
      const roots = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectMany: true,
        openLabel: 'Select source root(s) for this writable index',
      });
      if (!roots?.length) {
        return { status: 'cancelled' };
      }
      rootDirs = roots.map((uri) => uri.fsPath);
    }
    const service = await manager.attachSecondary(dbPath, {
      name: picked.candidate?.meta.name,
      readOnly: access.value,
      directoryMappings: picked.candidate?.meta.directoryMappings,
      rootDirs,
      waitForInitialIndex: false,
    });
    startSecondaryIndexingInBackground(service, dbPath);
    return { status: 'ok', message: 'Secondary index opened' };
  } catch (e) {
    return { status: 'error', message: errorMessage(e) };
  }
}

export async function pickMoveDestination(manager: IndexManager, id: string): Promise<string | null> {
  const meta = manager.getRegistry().getById(id);
  if (!meta) {
    return 'Index not found';
  }
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(meta.dbPath),
    filters: { Database: ['db'] },
  });
  if (!dest) {
    return null;
  }
  return moveIndexDb(manager, id, dest.fsPath);
}

export async function confirmAndDelete(
  manager: IndexManager,
  id: string,
  name: string
): Promise<string | null> {
  const dbPath = manager.getRegistry().getById(id)?.dbPath;
  const confirm = await vscode.window.showWarningMessage(
    `Permanently delete index "${name}"?`,
    {
      modal: true,
      detail: dbPath
        ? `Database: ${dbPath}\n\nThe database and its SQLite index data will be deleted. This cannot be undone.`
        : 'The database and its SQLite index data will be deleted. This cannot be undone.',
    },
    'Delete'
  );
  if (confirm === 'Delete') {
    return deleteIndex(manager, id, true);
  }
  return null;
}

export async function saveWorkspaceIndexBinding(
  manager: IndexManager,
  context: vscode.ExtensionContext,
  primarySource?: PrimaryIndexSource,
  options: {
    removedSecondaryDbPaths?: readonly string[];
  } = {}
): Promise<WorkspaceIndexBindingV2> {
  const previous = normalizeWorkspaceIndexBinding(
    context.workspaceState.get<unknown>(
      getWorkspaceIndexBindingKey(manager.getWorkspaceHash())
    )
  );
  const primary = manager.getPrimary();
  const primaryMeta = primary ? manager.getIndexMeta(primary.id) : undefined;
  const primaryAccess = primary ? manager.getRuntimeAccess(primary.id) : undefined;
  const previousSource =
    primary && previous.primary && samePath(previous.primary.dbPath, primary.getDbPath())
      ? previous.primary.source
      : undefined;
  const inferredSource: PrimaryIndexSource =
    primary && manager.getSharedDbPath() && samePath(primary.getDbPath(), manager.getSharedDbPath()!)
      ? 'shared'
      : 'manual';

  const attachedSecondaries = manager.getAttachedIndexes().map(({ meta, service }) => {
    const runtime = manager.getRuntimeAccess(service.id);
    return {
      dbPath: meta.dbPath,
      accessMode: accessModeFromRequested(runtime?.requestedReadOnly ?? service.isReadOnly()),
      name: meta.name,
      rootDirs: meta.rootDirs,
      directoryMappings: meta.directoryMappings,
    };
  });
  const binding = normalizeWorkspaceIndexBinding({
    version: 2,
    primary: primary
      ? {
          dbPath: primary.getDbPath(),
          accessMode: accessModeFromRequested(primaryAccess?.requestedReadOnly ?? primary.isReadOnly()),
          source: primarySource ?? previousSource ?? inferredSource,
          name: primary.name,
          rootDirs: primaryMeta?.rootDirs ?? primary.getRootDirs(),
          directoryMappings: primaryMeta?.directoryMappings,
        }
      : previous.primary,
    secondaries: mergeWorkspaceSecondaryBindings(
      attachedSecondaries,
      previous.secondaries,
      options.removedSecondaryDbPaths
    ),
  });

  await context.workspaceState.update(
    getWorkspaceIndexBindingKey(manager.getWorkspaceHash()),
    binding
  );
  // Keep the v1 IDs for downgrade compatibility. V2 paths remain authoritative
  // because IDs are local to each editor's registry.
  await context.workspaceState.update('secondaryIndexIds', manager.getWorkspaceSecondaryIds());
  return binding;
}

function accessModeFromRequested(readOnly: boolean): IndexAccessMode {
  return readOnly ? 'readOnly' : 'auto';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startSecondaryIndexingInBackground(service: IndexService, dbPath: string): void {
  void service.startIndexing().catch((error) => {
    void vscode.window.showErrorMessage(
      `Ace Code Search: Secondary indexing failed for ${dbPath} - ${errorMessage(error)}`
    );
  });
}

export async function saveSecondaryIds(
  manager: IndexManager,
  context: vscode.ExtensionContext
): Promise<void> {
  await saveWorkspaceIndexBinding(manager, context);
}
