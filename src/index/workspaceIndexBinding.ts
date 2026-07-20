import { DirectoryMapping, IndexMeta } from './types';
import { canonicalPathKey } from './sharedIndexStorage';

export const WORKSPACE_INDEX_BINDING_KEY = 'workspaceIndexBindingV2';
export const WORKSPACE_INDEX_BINDING_VERSION = 2 as const;
export const LEGACY_SECONDARY_IDS_MIGRATION_MARKER_KEY =
  'workspaceIndexBindingV2.legacySecondaryIdsMigrated';

export type IndexAccessMode = 'auto' | 'readOnly';
export type PrimaryIndexSource = 'shared' | 'manual' | 'legacy' | 'autocreate';

export interface WorkspacePrimaryBinding {
  dbPath: string;
  accessMode: IndexAccessMode;
  source: PrimaryIndexSource;
  name?: string;
  rootDirs?: string[];
  directoryMappings?: DirectoryMapping[];
}

export interface WorkspaceSecondaryBinding {
  dbPath: string;
  accessMode: IndexAccessMode;
  name?: string;
  rootDirs?: string[];
  directoryMappings?: DirectoryMapping[];
}

export interface WorkspaceIndexBindingV2 {
  version: typeof WORKSPACE_INDEX_BINDING_VERSION;
  primary?: WorkspacePrimaryBinding;
  secondaries: WorkspaceSecondaryBinding[];
}

export type WorkspaceSecondaryRestoreSource = 'keyedBinding' | 'legacyIds' | 'none';

/**
 * Keeps temporarily unavailable keyed Secondary paths across routine saves.
 * Live attachments win so recovered indexes refresh their metadata. A path is
 * removed only when the caller identifies an explicit Close/Forget action.
 */
export function mergeWorkspaceSecondaryBindings(
  attached: readonly WorkspaceSecondaryBinding[],
  previous: readonly WorkspaceSecondaryBinding[],
  removedDbPaths: readonly string[] = []
): WorkspaceSecondaryBinding[] {
  const removed = new Set(removedDbPaths.map((dbPath) => canonicalPathKey(dbPath)));
  const seen = new Set<string>();
  const merged: WorkspaceSecondaryBinding[] = [];

  for (const secondary of attached) {
    const key = canonicalPathKey(secondary.dbPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(secondary);
  }
  for (const secondary of previous) {
    const key = canonicalPathKey(secondary.dbPath);
    if (removed.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(secondary);
  }
  return merged;
}

export function getWorkspaceIndexBindingKey(workspaceHash: string): string {
  return `${WORKSPACE_INDEX_BINDING_KEY}.${workspaceHash}`;
}

/**
 * Legacy secondary IDs are scoped only to VS Code's workspaceState, not to a
 * workspace-root hash. Consume them once when upgrading, otherwise changing a
 * multi-root workspace from roots A to B can copy A's secondaries into B.
 */
export function getWorkspaceSecondaryRestoreSource(
  storedBindingRaw: unknown,
  legacyMigrationCompleted: boolean
): WorkspaceSecondaryRestoreSource {
  if (storedBindingRaw !== undefined) {
    return 'keyedBinding';
  }
  return legacyMigrationCompleted ? 'none' : 'legacyIds';
}

export function normalizeWorkspaceIndexBinding(value: unknown): WorkspaceIndexBindingV2 {
  const record = asRecord(value);
  const primary = normalizePrimary(record?.primary);
  const secondaries: WorkspaceSecondaryBinding[] = [];
  const seen = new Set<string>();
  if (primary) {
    seen.add(canonicalPathKey(primary.dbPath));
  }

  const rawSecondaries = Array.isArray(record?.secondaries) ? record.secondaries : [];
  for (const raw of rawSecondaries) {
    const secondary = normalizeSecondary(raw);
    if (!secondary) {
      continue;
    }
    const key = canonicalPathKey(secondary.dbPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    secondaries.push(secondary);
  }

  return {
    version: WORKSPACE_INDEX_BINDING_VERSION,
    primary,
    secondaries,
  };
}

export function migrateLegacyWorkspaceBinding(
  primary: IndexMeta | undefined,
  secondaries: readonly IndexMeta[]
): WorkspaceIndexBindingV2 {
  return normalizeWorkspaceIndexBinding({
    version: WORKSPACE_INDEX_BINDING_VERSION,
    primary: primary
      ? {
          dbPath: primary.dbPath,
          accessMode: primary.readOnly ? 'readOnly' : 'auto',
          source: 'legacy',
          name: primary.name,
          rootDirs: primary.rootDirs,
          directoryMappings: primary.directoryMappings,
        }
      : undefined,
    secondaries: secondaries.map((meta) => ({
      dbPath: meta.dbPath,
      accessMode: meta.readOnly ? 'readOnly' : 'auto',
      name: meta.name,
      rootDirs: meta.rootDirs,
      directoryMappings: meta.directoryMappings,
    })),
  });
}

function normalizePrimary(value: unknown): WorkspacePrimaryBinding | undefined {
  const record = asRecord(value);
  const dbPath = nonEmptyString(record?.dbPath);
  if (!dbPath) {
    return undefined;
  }
  const source = normalizeSource(record?.source);
  return {
    dbPath,
    accessMode: normalizeAccessMode(record?.accessMode),
    source,
    name: optionalString(record?.name),
    rootDirs: normalizeStringArray(record?.rootDirs),
    directoryMappings: normalizeMappings(record?.directoryMappings),
  };
}

function normalizeSecondary(value: unknown): WorkspaceSecondaryBinding | undefined {
  const record = asRecord(value);
  const dbPath = nonEmptyString(record?.dbPath);
  if (!dbPath) {
    return undefined;
  }
  return {
    dbPath,
    accessMode: normalizeAccessMode(record?.accessMode),
    name: optionalString(record?.name),
    rootDirs: normalizeStringArray(record?.rootDirs),
    directoryMappings: normalizeMappings(record?.directoryMappings),
  };
}

function normalizeAccessMode(value: unknown): IndexAccessMode {
  return value === 'readOnly' ? 'readOnly' : 'auto';
}

function normalizeSource(value: unknown): PrimaryIndexSource {
  switch (value) {
    case 'shared':
    case 'manual':
    case 'legacy':
    case 'autocreate':
      return value;
    default:
      return 'legacy';
  }
}

function normalizeMappings(value: unknown): DirectoryMapping[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const mappings: DirectoryMapping[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const from = nonEmptyString(record?.from);
    const to = nonEmptyString(record?.to);
    if (from && to) {
      mappings.push({ from, to });
    }
  }
  return mappings.length > 0 ? mappings : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value
    .map(nonEmptyString)
    .filter((item): item is string => item !== undefined);
  return strings.length > 0 ? [...new Set(strings)] : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
