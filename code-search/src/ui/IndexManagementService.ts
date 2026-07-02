import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IndexManager } from '../index/IndexManager';
import { IndexService } from '../index/IndexService';
import { DirectoryMapping } from '../index/types';

export interface IndexListItem {
  id: string;
  name: string;
  dbPath: string;
  rootDirs: string[];
  readOnly: boolean;
  isPrimary: boolean;
  isAttached: boolean;
  directoryMappings: DirectoryMapping[];
  mappingsText: string;
  statusMessage: string;
  partial: boolean;
}

export interface IndexListPayload {
  indexes: IndexListItem[];
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

export function getIndexListPayload(manager: IndexManager): IndexListPayload {
  const primary = manager.getPrimary();
  const primaryId = primary?.id;
  const attachedIds = new Set(manager.getWorkspaceSecondaryIds());
  const registryIndexes = manager.getRegistry().getAll();
  const items: IndexListItem[] = [];

  for (const meta of registryIndexes) {
    const service = findServiceById(manager, meta.id);
    const progress = service?.getProgress();
    items.push({
      id: meta.id,
      name: meta.name,
      dbPath: meta.dbPath,
      rootDirs: meta.rootDirs,
      readOnly: meta.readOnly,
      isPrimary: meta.id === primaryId,
      isAttached: meta.id === primaryId || attachedIds.has(meta.id),
      directoryMappings: meta.directoryMappings,
      mappingsText: formatMappings(meta.directoryMappings),
      statusMessage: progress?.message ?? '—',
      partial: progress ? progress.status !== 'upToDate' : false,
    });
  }

  items.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) {
      return a.isPrimary ? -1 : 1;
    }
    if (a.isAttached !== b.isAttached) {
      return a.isAttached ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return { indexes: items };
}

function findServiceById(manager: IndexManager, id: string): IndexService | undefined {
  const primary = manager.getPrimary();
  if (primary?.id === id) {
    return primary;
  }
  return manager.getAttachedIndexes().find((a) => a.meta.id === id)?.service;
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

export async function attachIndex(manager: IndexManager, id: string): Promise<string | null> {
  const meta = manager.getRegistry().getById(id);
  if (!meta) {
    return 'Index not found';
  }
  if (manager.getPrimary()?.id === id) {
    return 'Primary index is always attached';
  }
  try {
    await manager.attachSecondary(meta.dbPath, {
      name: meta.name,
      readOnly: meta.readOnly,
      directoryMappings: meta.directoryMappings,
      rootDirs: meta.rootDirs,
    });
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
  const ok = await manager.deleteIndex(id, deleteFiles);
  return ok ? null : 'Delete failed';
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

export async function createStandaloneIndex(manager: IndexManager): Promise<string | null> {
  const rootUri = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Select root directory to index',
  });
  if (!rootUri?.[0]) {
    return null;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Index name',
    value: path.basename(rootUri[0].fsPath),
  });
  if (!name) {
    return null;
  }

  const saveUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(rootUri[0].fsPath, `${name}.db`)),
    filters: { Database: ['db'] },
  });
  if (!saveUri) {
    return null;
  }

  try {
    await fs.promises.mkdir(path.dirname(saveUri.fsPath), { recursive: true });
    const service = await manager.attachSecondary(saveUri.fsPath, {
      name,
      readOnly: false,
      rootDirs: [rootUri[0].fsPath],
    });

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Indexing ${name}...` },
      () => service.refresh(true)
    );
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function browseAndAttachIndex(manager: IndexManager): Promise<string | null> {
  const indexes = manager.getRegistry().getAll();
  const attached = new Set(manager.getWorkspaceSecondaryIds());
  const primaryId = manager.getPrimary()?.id;

  const items = [
    ...indexes
      .filter((i) => i.id !== primaryId)
      .map((idx) => ({
        label: idx.name,
        description: attached.has(idx.id) ? 'Attached' : idx.readOnly ? 'Read-only' : 'Writable',
        detail: idx.dbPath,
        id: idx.id,
        dbPath: idx.dbPath,
        meta: idx,
      })),
    {
      label: 'Browse for index database...',
      id: '__browse__',
      dbPath: '',
      meta: undefined as never,
      description: '',
      detail: '',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Open a secondary index',
  });
  if (!picked) {
    return null;
  }

  let dbPath = picked.dbPath;
  if (picked.id === '__browse__') {
    const uri = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { Database: ['db'] },
    });
    if (!uri?.[0]) {
      return null;
    }
    dbPath = uri[0].fsPath;
  }

  const readOnly = await vscode.window.showQuickPick(
    [
      { label: 'Read-only (recommended for libraries)', value: true },
      { label: 'Writable', value: false },
    ],
    { placeHolder: 'Open mode' }
  );
  if (!readOnly) {
    return null;
  }

  try {
    await manager.attachSecondary(dbPath, {
      name: picked.meta?.name,
      readOnly: readOnly.value,
      directoryMappings: picked.meta?.directoryMappings,
      rootDirs: picked.meta?.rootDirs,
    });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
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
  const confirm = await vscode.window.showWarningMessage(
    `Delete index "${name}"?`,
    { modal: true },
    'Delete',
    'Delete files'
  );
  if (confirm === 'Delete') {
    return deleteIndex(manager, id, false);
  }
  if (confirm === 'Delete files') {
    return deleteIndex(manager, id, true);
  }
  return null;
}

export async function saveSecondaryIds(
  manager: IndexManager,
  context: vscode.ExtensionContext
): Promise<void> {
  await context.workspaceState.update('secondaryIndexIds', manager.getWorkspaceSecondaryIds());
}
