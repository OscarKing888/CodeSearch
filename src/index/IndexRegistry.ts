import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import { IndexMeta, IndexRegistryData } from './types';
import { canonicalPathKey } from './sharedIndexStorage';
import { acquireIndexWriterLease, IndexWriterLease } from './IndexWriterLease';

const REGISTRY_VERSION = 1;
const REGISTRY_LOCK_RETRY_DELAY_MS = 25;
const REGISTRY_LOCK_MAX_ATTEMPTS = 400;
const REGISTRY_LOCK_STALE_TIMEOUT_MS = 5_000;

export class IndexRegistry {
  private registryPath: string;
  private data: IndexRegistryData = { indexes: [] };
  private persistedIndexes: IndexMeta[] = [];
  private saveTail: Promise<void> = Promise.resolve();

  constructor(storageRoot: string) {
    this.registryPath = path.join(storageRoot, 'registry.json');
  }

  async load(): Promise<void> {
    const loaded = await this.readFromDisk();
    this.data = { indexes: loaded.indexes.map(cloneIndexMeta) };
    this.persistedIndexes = loaded.indexes.map(cloneIndexMeta);
  }

  save(): Promise<void> {
    const task = this.saveTail.then(() => this.saveOnce());
    this.saveTail = task.catch(() => undefined);
    return task;
  }

  /**
   * Runs draft validation/mutation and a post-commit side effect while still
   * holding the cross-process registry writer lease. This is reserved for
   * destructive operations whose filesystem action must not race a peer
   * adding a catalog reference after an ordinary save returns.
   */
  saveWithExclusiveHooks<T>(
    prepare: (mergedDraft: IndexMeta[]) => T | Promise<T>,
    afterWrite?: (prepared: T, persisted: readonly IndexMeta[]) => void | Promise<void>
  ): Promise<T> {
    const task = this.saveTail.then(() => this.saveOnce(prepare, afterWrite));
    this.saveTail = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private async saveOnce<T = void>(
    prepare?: (mergedDraft: IndexMeta[]) => T | Promise<T>,
    afterWrite?: (prepared: T, persisted: readonly IndexMeta[]) => void | Promise<void>
  ): Promise<T> {
    const localBase = this.persistedIndexes.map(cloneIndexMeta);
    const localCurrent = this.data.indexes.map(cloneIndexMeta);
    await fs.promises.mkdir(path.dirname(this.registryPath), { recursive: true });
    const lease = await this.acquireWriteLease();
    try {
      const latest = await this.readFromDisk();
      const merged = mergeIndexChanges(localBase, localCurrent, latest.indexes);
      const prepared = prepare
        ? await prepare(merged)
        : (undefined as T);
      await this.writeToDisk({ indexes: merged });

      // Synchronous registry mutations may happen while the filesystem write
      // is pending. Overlay those late changes onto the merged view and leave
      // them dirty for the next queued save instead of discarding them.
      const liveCurrent = this.data.indexes.map(cloneIndexMeta);
      this.data = {
        indexes: mergeIndexChanges(localCurrent, liveCurrent, merged),
      };
      this.persistedIndexes = merged.map(cloneIndexMeta);
      if (afterWrite) {
        await afterWrite(prepared, merged);
      }
      return prepared;
    } finally {
      await lease.release().catch(() => undefined);
    }
  }

  private async readFromDisk(): Promise<IndexRegistryData> {
    try {
      const raw = await fs.promises.readFile(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw) as IndexRegistryData;
      if (!Array.isArray(parsed.indexes)) {
        throw new Error(`Invalid Ace Code Search registry: ${this.registryPath}`);
      }
      return { indexes: parsed.indexes.map(cloneIndexMeta) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { indexes: [] };
      }
      throw error;
    }
  }

  private async writeToDisk(data: IndexRegistryData): Promise<void> {
    const tempPath = `${this.registryPath}.${process.pid}.${Date.now()}.tmp`;
    const serialized = JSON.stringify(data, null, 2);
    await fs.promises.writeFile(tempPath, serialized, 'utf8');
    try {
      await fs.promises.rename(tempPath, this.registryPath);
    } catch {
      // Some Windows filesystems do not replace an existing destination via
      // rename. Keep compatibility while still ensuring readers never observe
      // our temporary file as the registry.
      await fs.promises.writeFile(this.registryPath, serialized, 'utf8');
      await fs.promises.unlink(tempPath).catch(() => undefined);
    }
  }

  private async acquireWriteLease(): Promise<IndexWriterLease> {
    let ownerLabel: string | undefined;
    for (let attempt = 0; attempt < REGISTRY_LOCK_MAX_ATTEMPTS; attempt++) {
      const result = await acquireIndexWriterLease(this.registryPath, {
        label: `Ace Code Search registry (${process.pid})`,
        staleTimeoutMs: REGISTRY_LOCK_STALE_TIMEOUT_MS,
      });
      if (result.acquired) {
        return result.lease;
      }
      ownerLabel = result.owner?.label;
      await new Promise((resolve) => setTimeout(resolve, REGISTRY_LOCK_RETRY_DELAY_MS));
    }
    throw new Error(
      `Timed out waiting to update the Ace Code Search registry` +
        (ownerLabel ? ` (owned by ${ownerLabel})` : '')
    );
  }

  getPath(): string {
    return this.registryPath;
  }

  getAll(): IndexMeta[] {
    return [...this.data.indexes];
  }

  snapshot(): IndexMeta[] {
    return this.data.indexes.map(cloneIndexMeta);
  }

  restore(snapshot: readonly IndexMeta[]): void {
    this.data = { indexes: snapshot.map(cloneIndexMeta) };
  }

  getById(id: string): IndexMeta | undefined {
    return this.data.indexes.find((i) => i.id === id);
  }

  getByDbPath(dbPath: string): IndexMeta | undefined {
    const key = canonicalPathKey(dbPath);
    return this.data.indexes.find((item) => canonicalPathKey(item.dbPath) === key);
  }

  getAllByWorkspaceHash(hash: string): IndexMeta[] {
    return this.data.indexes.filter((item) => item.workspaceHashes.includes(hash));
  }

  getByWorkspaceHash(hash: string): IndexMeta | undefined {
    return this.getAllByWorkspaceHash(hash).sort((a, b) => {
      const aPrimary = a.name.toLowerCase() === 'primary' ? 1 : 0;
      const bPrimary = b.name.toLowerCase() === 'primary' ? 1 : 0;
      if (aPrimary !== bPrimary) {
        return bPrimary - aPrimary;
      }
      if (a.readOnly !== b.readOnly) {
        return a.readOnly ? 1 : -1;
      }
      return b.updatedAt - a.updatedAt;
    })[0];
  }

  upsert(meta: IndexMeta): void {
    const idx = this.data.indexes.findIndex((i) => i.id === meta.id);
    if (idx >= 0) {
      this.data.indexes[idx] = meta;
    } else {
      this.data.indexes.push(meta);
    }
  }

  /**
   * Updates one physical index without reviving a runtime ID that lost a
   * concurrent first-open registry race. Existing legacy duplicates remain
   * untouched: path coalescing is only safe when the catalog has one match.
   */
  upsertByDbPath(meta: IndexMeta): IndexMeta {
    if (this.getById(meta.id)) {
      this.upsert(meta);
      return meta;
    }

    const pathKey = canonicalPathKey(meta.dbPath);
    const pathMatches = this.data.indexes.filter(
      (candidate) => canonicalPathKey(candidate.dbPath) === pathKey
    );
    if (pathMatches.length !== 1) {
      this.upsert(meta);
      return meta;
    }

    const existing = pathMatches[0];
    const coalesced: IndexMeta = {
      ...cloneIndexMeta(meta),
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Math.max(existing.updatedAt, meta.updatedAt),
      workspaceHashes: [...existing.workspaceHashes],
    };
    this.upsert(coalesced);
    return coalesced;
  }

  remove(id: string): boolean {
    const before = this.data.indexes.length;
    this.data.indexes = this.data.indexes.filter((i) => i.id !== id);
    return this.data.indexes.length < before;
  }

  rename(id: string, name: string): boolean {
    const meta = this.getById(id);
    if (!meta) {
      return false;
    }
    meta.name = name;
    meta.updatedAt = Date.now();
    return true;
  }

  move(id: string, newDbPath: string): boolean {
    const meta = this.getById(id);
    if (!meta) {
      return false;
    }
    meta.dbPath = newDbPath;
    meta.updatedAt = Date.now();
    return true;
  }

  attachWorkspace(id: string, workspaceHash: string): void {
    const meta = this.getById(id);
    if (!meta) {
      return;
    }
    if (!meta.workspaceHashes.includes(workspaceHash)) {
      meta.workspaceHashes.push(workspaceHash);
      meta.updatedAt = Date.now();
    }
  }

  /**
   * Legacy registries stored workspace membership directly on IndexMeta and
   * did not distinguish primary from secondary. Keep the format compatible,
   * but make the selected primary the only entry carrying this workspace hash.
   */
  setWorkspacePrimary(id: string, workspaceHash: string): void {
    const now = Date.now();
    for (const meta of this.data.indexes) {
      const hadWorkspace = meta.workspaceHashes.includes(workspaceHash);
      if (meta.id === id) {
        if (!hadWorkspace) {
          meta.workspaceHashes.push(workspaceHash);
          meta.updatedAt = now;
        }
      } else if (hadWorkspace) {
        meta.workspaceHashes = meta.workspaceHashes.filter((hash) => hash !== workspaceHash);
        meta.updatedAt = now;
      }
    }
  }

  static generateId(): string {
    return `idx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function cloneIndexMeta(meta: IndexMeta): IndexMeta {
  return {
    ...meta,
    rootDirs: [...meta.rootDirs],
    directoryMappings: meta.directoryMappings.map((mapping) => ({ ...mapping })),
    excludeDirNames: meta.excludeDirNames ? [...meta.excludeDirNames] : undefined,
    excludeFileNames: meta.excludeFileNames ? [...meta.excludeFileNames] : undefined,
    excludeGlobs: meta.excludeGlobs ? [...meta.excludeGlobs] : undefined,
    workspaceHashes: [...meta.workspaceHashes],
  };
}

/**
 * Applies this registry instance's changes to the latest on-disk snapshot.
 * Unchanged entries are deliberately omitted from the patch so that a stale
 * manager cannot recreate an entry deleted by another IDE window.
 */
function mergeIndexChanges(
  base: readonly IndexMeta[],
  current: readonly IndexMeta[],
  latest: readonly IndexMeta[]
): IndexMeta[] {
  const workspacePrimaryIntents = collectWorkspacePrimaryIntents(base, current);
  const replacementIds = new Map<string, string>();
  const baseById = new Map(base.map((meta) => [meta.id, meta]));
  const currentById = new Map(current.map((meta) => [meta.id, meta]));
  const mergedById = new Map(
    latest.map((meta) => [meta.id, cloneIndexMeta(meta)])
  );

  for (const baseline of base) {
    if (!currentById.has(baseline.id)) {
      mergedById.delete(baseline.id);
    }
  }

  for (const meta of current) {
    const baseline = baseById.get(meta.id);
    if (!baseline) {
      mergedById.set(meta.id, cloneIndexMeta(meta));
      continue;
    }
    if (isDeepStrictEqual(meta, baseline)) {
      continue;
    }

    const latestMeta = mergedById.get(meta.id);
    if (latestMeta) {
      mergedById.set(
        meta.id,
        mergeIndexMetaChanges(baseline, meta, latestMeta)
      );
      continue;
    }

    // A concurrent first-open can replace this manager's generated ID with a
    // different ID for the same physical database. Carry an active loser's
    // later metadata delta onto that one new replacement instead of silently
    // dropping it or resurrecting the losing ID. A pre-existing same-path row
    // is deliberately ineligible so legacy duplicates keep their identities.
    if (
      canonicalPathKey(meta.dbPath) === canonicalPathKey(baseline.dbPath)
    ) {
      const baselinePathKey = canonicalPathKey(baseline.dbPath);
      const replacements = latest.filter((candidate) => {
        if (canonicalPathKey(candidate.dbPath) !== baselinePathKey) {
          return false;
        }
        const candidateBaseline = baseById.get(candidate.id);
        return (
          !candidateBaseline ||
          canonicalPathKey(candidateBaseline.dbPath) !== baselinePathKey
        );
      });
      if (replacements.length === 1) {
        const replacement = mergedById.get(replacements[0].id);
        if (replacement) {
          mergedById.set(
            replacement.id,
            mergeIndexMetaChanges(baseline, meta, replacement)
          );
          replacementIds.set(meta.id, replacement.id);
        }
      }
    }
  }

  const merged = Array.from(mergedById.values());
  collapseConcurrentPathAdds(base, current, latest, merged);
  applyWorkspacePrimaryIntents(merged, workspacePrimaryIntents, replacementIds);
  return merged;
}

/**
 * Two stale managers can both discover an unregistered physical DB and create
 * different random IDs for it, or concurrently move/add records onto one path.
 * Preserve entries that already occupied the path in this caller's baseline,
 * but collapse new path entrants so the last registry lease holder wins.
 */
function collapseConcurrentPathAdds(
  base: readonly IndexMeta[],
  current: readonly IndexMeta[],
  latest: readonly IndexMeta[],
  merged: IndexMeta[]
): void {
  const baseById = new Map(base.map((meta) => [meta.id, meta]));
  const latestConcurrentAddsByPath = new Map<string, Set<string>>();
  for (const meta of latest) {
    const key = canonicalPathKey(meta.dbPath);
    const baseline = baseById.get(meta.id);
    if (baseline && canonicalPathKey(baseline.dbPath) === key) {
      continue;
    }
    const ids = latestConcurrentAddsByPath.get(key) ?? new Set<string>();
    ids.add(meta.id);
    latestConcurrentAddsByPath.set(key, ids);
  }

  const localWinnerByPath = new Map<string, string>();
  for (const meta of current) {
    const key = canonicalPathKey(meta.dbPath);
    const baseline = baseById.get(meta.id);
    if (!baseline || canonicalPathKey(baseline.dbPath) !== key) {
      localWinnerByPath.set(key, meta.id);
    }
  }

  for (const [pathKey, winnerId] of localWinnerByPath) {
    const remoteIds = latestConcurrentAddsByPath.get(pathKey);
    if (!remoteIds || (remoteIds.size === 1 && remoteIds.has(winnerId))) {
      continue;
    }
    for (let index = merged.length - 1; index >= 0; index--) {
      const candidate = merged[index];
      if (
        candidate.id !== winnerId &&
        (!baseById.has(candidate.id) ||
          canonicalPathKey(baseById.get(candidate.id)!.dbPath) !== pathKey) &&
        canonicalPathKey(candidate.dbPath) === pathKey
      ) {
        merged.splice(index, 1);
      }
    }
  }
}

/**
 * Detects an intentional local Primary selection from the caller's own
 * baseline/current delta. Applying this after the per-entry three-way merge
 * makes concurrent selections deterministic: the last registry lease holder
 * removes the workspace hash from the earlier winner instead of preserving
 * both additions as unrelated set changes.
 */
function collectWorkspacePrimaryIntents(
  base: readonly IndexMeta[],
  current: readonly IndexMeta[]
): Map<string, string> {
  const hashes = new Set<string>();
  for (const meta of base) {
    for (const hash of meta.workspaceHashes) {
      hashes.add(hash);
    }
  }
  for (const meta of current) {
    for (const hash of meta.workspaceHashes) {
      hashes.add(hash);
    }
  }

  const intents = new Map<string, string>();
  for (const hash of hashes) {
    const baseIds = new Set(
      base.filter((meta) => meta.workspaceHashes.includes(hash)).map((meta) => meta.id)
    );
    const currentIds = new Set(
      current.filter((meta) => meta.workspaceHashes.includes(hash)).map((meta) => meta.id)
    );
    if (currentIds.size !== 1 || setsEqual(baseIds, currentIds)) {
      continue;
    }
    intents.set(hash, currentIds.values().next().value as string);
  }
  return intents;
}

function applyWorkspacePrimaryIntents(
  merged: IndexMeta[],
  intents: ReadonlyMap<string, string>,
  replacementIds: ReadonlyMap<string, string>
): void {
  for (const [hash, primaryId] of intents) {
    const resolvedPrimaryId = replacementIds.get(primaryId) ?? primaryId;
    const primary = merged.find((meta) => meta.id === resolvedPrimaryId);
    if (!primary) {
      // A concurrent deletion wins over a stale selection and must not be
      // resurrected merely to satisfy the legacy workspace association.
      continue;
    }
    for (const meta of merged) {
      if (meta.id === resolvedPrimaryId) {
        if (!meta.workspaceHashes.includes(hash)) {
          meta.workspaceHashes.push(hash);
        }
      } else if (meta.workspaceHashes.includes(hash)) {
        meta.workspaceHashes = meta.workspaceHashes.filter((value) => value !== hash);
      }
    }
  }
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function mergeIndexMetaChanges(
  base: IndexMeta,
  current: IndexMeta,
  latest: IndexMeta
): IndexMeta {
  const merged = cloneIndexMeta(latest);
  if (!isDeepStrictEqual(current.name, base.name)) {
    merged.name = current.name;
  }
  if (!isDeepStrictEqual(current.dbPath, base.dbPath)) {
    merged.dbPath = current.dbPath;
  }
  if (!isDeepStrictEqual(current.rootDirs, base.rootDirs)) {
    merged.rootDirs = [...current.rootDirs];
  }
  if (!isDeepStrictEqual(current.readOnly, base.readOnly)) {
    merged.readOnly = current.readOnly;
  }
  if (!isDeepStrictEqual(current.directoryMappings, base.directoryMappings)) {
    merged.directoryMappings = current.directoryMappings.map((mapping) => ({ ...mapping }));
  }
  if (!isDeepStrictEqual(current.excludeDirNames, base.excludeDirNames)) {
    merged.excludeDirNames = current.excludeDirNames
      ? [...current.excludeDirNames]
      : undefined;
  }
  if (!isDeepStrictEqual(current.excludeFileNames, base.excludeFileNames)) {
    merged.excludeFileNames = current.excludeFileNames
      ? [...current.excludeFileNames]
      : undefined;
  }
  if (!isDeepStrictEqual(current.excludeGlobs, base.excludeGlobs)) {
    merged.excludeGlobs = current.excludeGlobs ? [...current.excludeGlobs] : undefined;
  }
  if (!isDeepStrictEqual(current.workspaceHashes, base.workspaceHashes)) {
    merged.workspaceHashes = mergeStringSetDelta(
      base.workspaceHashes,
      current.workspaceHashes,
      latest.workspaceHashes
    );
  }
  if (!isDeepStrictEqual(current.createdAt, base.createdAt)) {
    merged.createdAt = current.createdAt;
  }
  if (!isDeepStrictEqual(current.updatedAt, base.updatedAt)) {
    merged.updatedAt = Math.max(current.updatedAt, latest.updatedAt);
  }
  return merged;
}

function mergeStringSetDelta(
  base: readonly string[],
  current: readonly string[],
  latest: readonly string[]
): string[] {
  const baseSet = new Set(base);
  const currentSet = new Set(current);
  const merged = latest.filter((value) => !baseSet.has(value) || currentSet.has(value));
  const mergedSet = new Set(merged);
  for (const value of current) {
    if (!baseSet.has(value) && !mergedSet.has(value)) {
      merged.push(value);
      mergedSet.add(value);
    }
  }
  return merged;
}

export function mapFilePath(filePath: string, mappings: Array<{ from: string; to: string }>): string {
  const normalized = filePath.replace(/\\/g, '/');
  for (const { from, to } of mappings) {
    const rawPrefix = from.replace(/\\/g, '/');
    const fromNorm =
      rawPrefix.length > 1 &&
      rawPrefix.endsWith('/') &&
      !/^[A-Za-z]:\/$/.test(rawPrefix)
        ? rawPrefix.slice(0, -1)
        : rawPrefix;
    if (!fromNorm) {
      continue;
    }
    const normalizedLower = normalized.toLowerCase();
    const prefixLower = fromNorm.toLowerCase();
    if (
      normalizedLower !== prefixLower &&
      !normalizedLower.startsWith(`${prefixLower}/`)
    ) {
      continue;
    }
    const suffix = normalized.slice(fromNorm.length);
    return path.join(
      to.replace(/\\/g, path.sep),
      suffix.replace(/^\//, '').replace(/\//g, path.sep)
    );
  }
  return filePath;
}
