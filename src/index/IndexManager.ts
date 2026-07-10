import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { IndexRegistry, mapFilePath } from './IndexRegistry';
import { IndexService } from './IndexService';
import { DirectoryMapping, IndexMeta } from './types';
import { PerIndexExcludes } from './excludePatterns';
import { compareTokenSuggestions } from './tokenSuggestions';

function metaToPerIndexExcludes(meta: Pick<IndexMeta, 'excludeDirNames' | 'excludeFileNames' | 'excludeGlobs'>): PerIndexExcludes | undefined {
  if (
    !meta.excludeDirNames?.length &&
    !meta.excludeFileNames?.length &&
    !meta.excludeGlobs?.length
  ) {
    return undefined;
  }
  return {
    excludeDirNames: meta.excludeDirNames,
    excludeFileNames: meta.excludeFileNames,
    excludeGlobs: meta.excludeGlobs,
  };
}

export interface AttachedIndex {
  meta: IndexMeta;
  service: IndexService;
}

export class IndexManager extends EventEmitter {
  private registry: IndexRegistry;
  private primary: IndexService | undefined;
  private secondaries = new Map<string, AttachedIndex>();
  private workspaceHash: string;
  private globalStorage: string;

  constructor(globalStorage: string, workspaceHash: string) {
    super();
    this.globalStorage = globalStorage;
    this.workspaceHash = workspaceHash;
    this.registry = new IndexRegistry(path.join(globalStorage, 'code-search'));
  }

  async initialize(): Promise<void> {
    await this.registry.load();
  }

  getRegistry(): IndexRegistry {
    return this.registry;
  }

  getPrimary(): IndexService | undefined {
    return this.primary;
  }

  getAllServices(): IndexService[] {
    const all: IndexService[] = [];
    if (this.primary) {
      all.push(this.primary);
    }
    for (const attached of this.secondaries.values()) {
      all.push(attached.service);
    }
    return all;
  }

  getAttachedIndexes(): AttachedIndex[] {
    return Array.from(this.secondaries.values());
  }

  async createPrimary(
    dbPath: string,
    rootDirs: string[],
    name = 'Primary',
    excludeRules?: PerIndexExcludes
  ): Promise<IndexService> {
    if (this.primary) {
      this.primary.dispose();
    }

    const id = IndexRegistry.generateId();
    const meta: IndexMeta = {
      id,
      name,
      dbPath,
      rootDirs,
      readOnly: false,
      directoryMappings: [],
      excludeDirNames: excludeRules?.excludeDirNames,
      excludeFileNames: excludeRules?.excludeFileNames,
      excludeGlobs: excludeRules?.excludeGlobs,
      workspaceHashes: [this.workspaceHash],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.primary = new IndexService(dbPath, {
      id,
      name,
      readOnly: false,
      perIndexExcludes: excludeRules,
    });
    await this.primary.initialize(rootDirs);
    this.registry.upsert(meta);
    await this.registry.save();

    this.primary.on('progress', (p) => this.emit('progress', p));
    this.emit('indexesChanged');
    return this.primary;
  }

  async openPrimary(
    dbPath: string,
    rootDirs: string[],
    name = 'Primary'
  ): Promise<IndexService> {
    if (this.primary) {
      this.primary.dispose();
    }

    const normalized = path.resolve(dbPath);
    let meta =
      this.registry.getByWorkspaceHash(this.workspaceHash) ??
      this.registry.getAll().find((i) => path.resolve(i.dbPath) === normalized);

    if (!meta) {
      meta = {
        id: IndexRegistry.generateId(),
        name,
        dbPath: normalized,
        rootDirs,
        readOnly: false,
        directoryMappings: [],
        workspaceHashes: [this.workspaceHash],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    } else {
      meta.rootDirs = rootDirs;
      meta.workspaceHashes = [...new Set([...meta.workspaceHashes, this.workspaceHash])];
      meta.updatedAt = Date.now();
      if (name && meta.name === 'Primary') {
        meta.name = name;
      }
    }

    this.primary = new IndexService(meta.dbPath, {
      id: meta.id,
      name: meta.name,
      readOnly: meta.readOnly,
      perIndexExcludes: metaToPerIndexExcludes(meta),
    });
    await this.primary.initialize(rootDirs);
    this.registry.upsert(meta);
    await this.registry.save();

    this.primary.on('progress', (p) => this.emit('progress', p));
    this.emit('indexesChanged');
    return this.primary;
  }

  async attachSecondary(
    dbPath: string,
    options?: {
      name?: string;
      readOnly?: boolean;
      directoryMappings?: DirectoryMapping[];
      rootDirs?: string[];
    }
  ): Promise<IndexService> {
    const normalized = path.resolve(dbPath);
    const existing = Array.from(this.secondaries.values()).find(
      (a) => path.resolve(a.meta.dbPath) === normalized
    );
    if (existing) {
      return existing.service;
    }

    let meta = this.registry.getAll().find((i) => path.resolve(i.dbPath) === normalized);
    const readOnly = options?.readOnly ?? meta?.readOnly ?? true;

    if (!meta) {
      meta = {
        id: IndexRegistry.generateId(),
        name: options?.name ?? path.basename(path.dirname(normalized)),
        dbPath: normalized,
        rootDirs: options?.rootDirs ?? [],
        readOnly,
        directoryMappings: options?.directoryMappings ?? [],
        workspaceHashes: [this.workspaceHash],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    } else {
      meta.workspaceHashes = [...new Set([...meta.workspaceHashes, this.workspaceHash])];
      if (options?.name) {
        meta.name = options.name;
      }
      if (options?.directoryMappings) {
        meta.directoryMappings = options.directoryMappings;
      }
      meta.updatedAt = Date.now();
    }

    const service = new IndexService(normalized, {
      id: meta.id,
      name: meta.name,
      readOnly,
      perIndexExcludes: metaToPerIndexExcludes(meta),
    });
    await service.initialize(meta.rootDirs.length > 0 ? meta.rootDirs : [path.dirname(normalized)]);
    if (!readOnly) {
      await service.startIndexing();
    } else {
      await service.startIndexing(); // marks upToDate for read-only
    }

    this.secondaries.set(meta.id, { meta, service });
    this.registry.upsert(meta);
    await this.registry.save();

    service.on('progress', (p) => this.emit('progress', p));
    this.emit('indexesChanged');
    return service;
  }

  async detachSecondary(id: string): Promise<boolean> {
    const attached = this.secondaries.get(id);
    if (!attached) {
      return false;
    }
    attached.service.dispose();
    this.secondaries.delete(id);
    this.emit('indexesChanged');
    return true;
  }

  mapHitPath(indexId: string, filePath: string): string {
    if (this.primary?.id === indexId) {
      return filePath;
    }
    const attached = this.secondaries.get(indexId);
    if (!attached) {
      return filePath;
    }
    return mapFilePath(filePath, attached.meta.directoryMappings);
  }

  getIndexName(indexId: string): string {
    if (this.primary?.id === indexId) {
      return this.primary.name;
    }
    return this.secondaries.get(indexId)?.meta.name ?? indexId;
  }

  async deleteIndex(id: string, deleteFiles = false): Promise<boolean> {
    if (this.primary?.id === id) {
      return false; // cannot delete primary while active
    }

    const attached = this.secondaries.get(id);
    if (attached) {
      await this.detachSecondary(id);
    }

    const meta = this.registry.getById(id);
    const removed = this.registry.remove(id);
    if (removed) {
      await this.registry.save();
    }

    if (deleteFiles && meta) {
      try {
        await fs.promises.unlink(meta.dbPath);
        const wal = meta.dbPath + '-wal';
        const shm = meta.dbPath + '-shm';
        await fs.promises.unlink(wal).catch(() => undefined);
        await fs.promises.unlink(shm).catch(() => undefined);
      } catch {
        // ignore
      }
    }
    return removed;
  }

  async renameIndex(id: string, name: string): Promise<boolean> {
    const ok = this.registry.rename(id, name);
    if (!ok) {
      return false;
    }
    if (this.primary?.id === id) {
      this.primary.setName(name);
    }
    const attached = this.secondaries.get(id);
    if (attached) {
      attached.meta.name = name;
      attached.service.setName(name);
    }
    await this.registry.save();
    return true;
  }

  async moveIndex(id: string, newDbPath: string): Promise<boolean> {
    const meta = this.registry.getById(id);
    if (!meta) {
      return false;
    }
    await fs.promises.mkdir(path.dirname(newDbPath), { recursive: true });
    await fs.promises.copyFile(meta.dbPath, newDbPath);
    this.registry.move(id, newDbPath);
    await this.registry.save();
    return true;
  }

  async setDirectoryMappings(id: string, mappings: DirectoryMapping[]): Promise<boolean> {
    const meta = this.registry.getById(id);
    if (!meta) {
      return false;
    }
    meta.directoryMappings = mappings;
    meta.updatedAt = Date.now();
    const attached = this.secondaries.get(id);
    if (attached) {
      attached.meta.directoryMappings = mappings;
    }
    this.registry.upsert(meta);
    await this.registry.save();
    return true;
  }

  async setExcludeRules(id: string, rules: PerIndexExcludes): Promise<boolean> {
    const meta = this.registry.getById(id);
    if (!meta) {
      return false;
    }
    meta.excludeDirNames = rules.excludeDirNames?.length ? rules.excludeDirNames : undefined;
    meta.excludeFileNames = rules.excludeFileNames?.length ? rules.excludeFileNames : undefined;
    meta.excludeGlobs = rules.excludeGlobs?.length ? rules.excludeGlobs : undefined;
    meta.updatedAt = Date.now();

    const perIndex = metaToPerIndexExcludes(meta);
    if (this.primary?.id === id) {
      this.primary.setPerIndexExcludes(perIndex);
    }
    const attached = this.secondaries.get(id);
    if (attached) {
      attached.meta.excludeDirNames = meta.excludeDirNames;
      attached.meta.excludeFileNames = meta.excludeFileNames;
      attached.meta.excludeGlobs = meta.excludeGlobs;
      attached.service.setPerIndexExcludes(perIndex);
    }

    this.registry.upsert(meta);
    await this.registry.save();
    return true;
  }

  async loadWorkspaceSecondaries(secondaryIds: string[]): Promise<void> {
    for (const id of secondaryIds) {
      const meta = this.registry.getById(id);
      if (meta && !this.secondaries.has(id)) {
        await this.attachSecondary(meta.dbPath, {
          name: meta.name,
          readOnly: meta.readOnly,
          directoryMappings: meta.directoryMappings,
          rootDirs: meta.rootDirs,
        });
      }
    }
  }

  getWorkspaceSecondaryIds(): string[] {
    return Array.from(this.secondaries.keys());
  }

  isPartialIndex(): boolean {
    return this.getAllServices().some((s) => s.isPartialIndex());
  }

  getCombinedProgress(): { message: string; partial: boolean } {
    const services = this.getAllServices();
    const partial = services.some((s) => s.isPartialIndex());
    const indexing = services.filter((s) => s.getProgress().status === 'indexing');
    if (indexing.length > 0) {
      const indexed = indexing.reduce((sum, s) => sum + s.getProgress().indexed, 0);
      const total = indexing.reduce((sum, s) => sum + s.getProgress().total, 0);
      const indexSuffix = indexing.length > 1 ? ` (${indexing.length} indexes)` : '';
      return {
        message:
          total > 0
            ? `Indexing ${indexed}/${total} files${indexSuffix}...`
            : `Indexing${indexSuffix}...`,
        partial,
      };
    }
    const scanning = services.filter((s) => s.getProgress().status === 'scanning');
    if (scanning.length > 0) {
      const scanned = scanning.reduce((sum, s) => sum + (s.getProgress().scanned ?? 0), 0);
      const scanSuffix = scanning.length > 1 ? ` (${scanning.length} indexes)` : '';
      return { message: `Scanning ${scanned} files${scanSuffix}...`, partial };
    }
    const count = services.length;
    const tokenCount = services.reduce((sum, s) => sum + s.getTokenCount(), 0);
    const tokenLabel = `${tokenCount.toLocaleString('en-US')} tokens · `;
    return {
      message: count > 1 ? `${tokenLabel}Up to date (${count} indexes)` : `${tokenLabel}Up to date`,
      partial,
    };
  }

  getTokenSuggestions(prefix: string, limit = 20): Array<{ token: string; freq: number }> {
    const seen = new Map<string, number>();
    for (const service of this.getAllServices()) {
      for (const s of service.getTokenSuggestions(prefix, limit)) {
        seen.set(s.token, (seen.get(s.token) ?? 0) + s.freq);
      }
    }
    return Array.from(seen.entries())
      .map(([token, freq]) => ({ token, freq }))
      .sort(compareTokenSuggestions)
      .slice(0, limit);
  }

  async refreshAll(forceAll = false): Promise<void> {
    const tasks = this.getAllServices()
      .filter((s) => !s.isReadOnly())
      .map((s) => s.refresh(forceAll));
    await Promise.all(tasks);
  }

  dispose(): void {
    this.primary?.dispose();
    for (const attached of this.secondaries.values()) {
      attached.service.dispose();
    }
    this.secondaries.clear();
  }
}
