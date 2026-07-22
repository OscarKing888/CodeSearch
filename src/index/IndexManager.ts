import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { IndexRegistry, mapFilePath } from './IndexRegistry';
import { IndexService } from './IndexService';
import { DirectoryMapping, IndexMeta } from './types';
import { PerIndexExcludes } from './excludePatterns';
import { compareTokenSuggestions } from './tokenSuggestions';
import { canonicalPathKey } from './sharedIndexStorage';
import {
  acquireIndexWriterLease,
  IndexWriterLease,
  IndexWriterLeaseOwner,
} from './IndexWriterLease';

const READER_READY_RETRY_COUNT = 30;
const READER_READY_RETRY_DELAY_MS = 100;
const WRITER_RETRY_INTERVAL_MS = 5_000;

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

export interface IndexRuntimeAccess {
  requestedReadOnly: boolean;
  effectiveReadOnly: boolean;
  writerOwner?: IndexWriterLeaseOwner | null;
}

export interface IndexManagerOptions {
  writerLabel?: string;
  sharedDbPath?: string;
  workspaceRoots?: string[];
  writerRetryIntervalMs?: number;
}

export interface OpenPrimaryOptions {
  readOnly?: boolean;
  excludeRules?: PerIndexExcludes;
  directoryMappings?: DirectoryMapping[];
}

interface OpenedService {
  service: IndexService;
  access: IndexRuntimeAccess;
  lease?: IndexWriterLease;
}

export class IndexManager extends EventEmitter {
  private registry: IndexRegistry;
  private primary: IndexService | undefined;
  private primaryMeta: IndexMeta | undefined;
  private secondaries = new Map<string, AttachedIndex>();
  private accessById = new Map<string, IndexRuntimeAccess>();
  private writerLeases = new Map<IndexService, IndexWriterLease>();
  private pendingServices = new Set<IndexService>();
  private pendingLeases = new Set<IndexWriterLease>();
  private workspaceHash: string;
  private readonly writerLabel: string;
  private readonly sharedDbPath?: string;
  private readonly writerRetryIntervalMs: number;
  private workspaceRoots: string[];
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private writerRetryTimer: NodeJS.Timeout | undefined;
  private retryingWriters = false;
  private writerRetryTask: Promise<void> | undefined;
  private topologyMutationTail: Promise<void> = Promise.resolve();

  constructor(globalStorage: string, workspaceHash: string, options: IndexManagerOptions = {}) {
    super();
    this.workspaceHash = workspaceHash;
    this.writerLabel = options.writerLabel ?? 'Ace Code Search';
    this.sharedDbPath = options.sharedDbPath;
    const retryInterval = options.writerRetryIntervalMs ?? WRITER_RETRY_INTERVAL_MS;
    this.writerRetryIntervalMs =
      Number.isFinite(retryInterval) && retryInterval > 0
        ? retryInterval
        : WRITER_RETRY_INTERVAL_MS;
    this.workspaceRoots = [...(options.workspaceRoots ?? [])];
    this.registry = new IndexRegistry(path.join(globalStorage, 'code-search'));
  }

  async initialize(): Promise<void> {
    this.assertActive();
    await this.registry.load();
  }

  getRegistry(): IndexRegistry {
    return this.registry;
  }

  getWorkspaceHash(): string {
    return this.workspaceHash;
  }

  getWorkspaceRoots(): string[] {
    return [...this.workspaceRoots];
  }

  getSharedDbPath(): string | undefined {
    return this.sharedDbPath;
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

  getAttachedIndex(id: string): AttachedIndex | undefined {
    return this.secondaries.get(id);
  }

  /** Active runtime metadata remains authoritative if a peer window removes
   * the shared registry row while this manager still has the service open. */
  getIndexMeta(id: string): IndexMeta | undefined {
    if (this.primary?.id === id && this.primaryMeta?.id === id) {
      return this.primaryMeta;
    }
    return this.secondaries.get(id)?.meta ?? this.registry.getById(id);
  }

  private getActiveIndexMetaByDbPath(dbPath: string): IndexMeta | undefined {
    const key = canonicalPathKey(dbPath);
    if (
      this.primary &&
      this.primaryMeta &&
      canonicalPathKey(this.primary.getDbPath()) === key
    ) {
      return this.primaryMeta;
    }
    return Array.from(this.secondaries.values()).find(
      ({ service }) => canonicalPathKey(service.getDbPath()) === key
    )?.meta;
  }

  getRuntimeAccess(id: string): IndexRuntimeAccess | undefined {
    const access = this.accessById.get(id);
    return access ? { ...access } : undefined;
  }

  /**
   * Serializes service-topology mutations. UI-level operation guards cannot
   * cover command-palette invocations or the automatic writer retry timer, so
   * the manager must prevent two operations from replacing the same map slot
   * and orphaning an open service/lease.
   */
  private runTopologyMutation<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.topologyMutationTail.then(operation);
    this.topologyMutationTail = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private async openService(
    meta: IndexMeta,
    rootDirs: string[],
    requestedReadOnly: boolean
  ): Promise<OpenedService> {
    this.assertActive();
    let lease: IndexWriterLease | undefined;
    let writerOwner: IndexWriterLeaseOwner | null | undefined;
    let effectiveReadOnly = requestedReadOnly;

    if (!requestedReadOnly) {
      await fs.promises.mkdir(path.dirname(meta.dbPath), { recursive: true });
      let leaseResult: Awaited<ReturnType<typeof acquireIndexWriterLease>> | undefined;
      try {
        leaseResult = await acquireIndexWriterLease(meta.dbPath, {
          label: this.writerLabel,
        });
      } catch (error) {
        try {
          await fs.promises.access(meta.dbPath, fs.constants.R_OK);
          effectiveReadOnly = true;
          writerOwner = null;
        } catch {
          throw error;
        }
      }
      if (leaseResult) {
        if (this.disposed) {
          if (leaseResult.acquired) {
            await leaseResult.lease.release().catch(() => undefined);
          }
          this.assertActive();
        }
        if (leaseResult.acquired) {
          lease = leaseResult.lease;
          this.pendingLeases.add(lease);
          writerOwner = leaseResult.owner;
        } else {
          effectiveReadOnly = true;
          writerOwner = leaseResult.owner;
        }
      }
    }

    if (lease) {
      try {
        const stat = await fs.promises.stat(meta.dbPath).catch(() => undefined);
        this.assertActive();
        if (stat && stat.size > 0) {
          const validator = new IndexService(meta.dbPath, {
            id: `${meta.id}:validator`,
            name: meta.name,
            readOnly: true,
          });
          try {
            await validator.initialize(rootDirs);
          } finally {
            validator.dispose();
          }
          this.assertActive();
        }
      } catch (error) {
        this.pendingLeases.delete(lease);
        await lease.release().catch(() => undefined);
        throw error;
      }
    }

    const service = new IndexService(meta.dbPath, {
      id: meta.id,
      name: meta.name,
      readOnly: effectiveReadOnly,
      perIndexExcludes: metaToPerIndexExcludes(meta),
    });
    this.pendingServices.add(service);
    try {
      if (effectiveReadOnly && !requestedReadOnly) {
        await this.initializeReaderAfterWriter(service, rootDirs);
      } else {
        await service.initialize(rootDirs);
      }
      this.assertActive();
    } catch (error) {
      this.pendingServices.delete(service);
      try {
        service.dispose();
      } catch {
        // Preserve the initialization/cancellation error.
      }
      if (lease) {
        this.pendingLeases.delete(lease);
        await lease.release().catch(() => undefined);
      }
      throw error;
    }

    return {
      service,
      lease,
      access: {
        requestedReadOnly,
        effectiveReadOnly,
        writerOwner,
      },
    };
  }

  private rememberOpenedService(opened: OpenedService): void {
    this.pendingServices.delete(opened.service);
    if (opened.lease) {
      this.pendingLeases.delete(opened.lease);
    }
    this.accessById.set(opened.service.id, opened.access);
    if (opened.lease) {
      this.writerLeases.set(opened.service, opened.lease);
    }
    opened.service.on('progress', (progress) => this.emit('progress', progress));
    if (!opened.access.requestedReadOnly && opened.access.effectiveReadOnly) {
      this.ensureWriterRetryTimer();
    }
  }

  private async closeService(service: IndexService): Promise<void> {
    try {
      service.dispose();
    } catch {
      // Releasing the writer lease is more important than surfacing a close
      // error from a connection that is already being discarded.
    }
    this.accessById.delete(service.id);
    const lease = this.writerLeases.get(service);
    if (lease) {
      this.writerLeases.delete(service);
      await lease.release().catch(() => undefined);
    }
  }

  private async initializeReaderAfterWriter(
    service: IndexService,
    rootDirs: string[]
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < READER_READY_RETRY_COUNT; attempt++) {
      this.assertActive();
      try {
        await service.initialize(rootDirs);
        return;
      } catch (error) {
        lastError = error;
        try {
          service.dispose();
        } catch {
          // Retry with a fresh read-only connection.
        }
        if (attempt + 1 < READER_READY_RETRY_COUNT) {
          await new Promise((resolve) => setTimeout(resolve, READER_READY_RETRY_DELAY_MS));
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('The index writer did not finish creating a readable database');
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('Index manager has been disposed');
    }
  }

  private ensureWriterRetryTimer(): void {
    if (this.disposed || this.writerRetryTimer) {
      return;
    }
    this.writerRetryTimer = setInterval(() => {
      this.startWriterRetry();
    }, this.writerRetryIntervalMs);
    this.writerRetryTimer.unref();
  }

  private startWriterRetry(): void {
    if (this.writerRetryTask) {
      return;
    }
    const task = this.retryAutomaticWriters();
    this.writerRetryTask = task;
    void task
      .finally(() => {
        if (this.writerRetryTask === task) {
          this.writerRetryTask = undefined;
        }
      })
      .catch(() => undefined);
  }

  private hasPendingAutomaticReader(): boolean {
    return this.getAllServices().some((service) => {
      const access = this.accessById.get(service.id);
      return access && !access.requestedReadOnly && access.effectiveReadOnly;
    });
  }

  private async retryAutomaticWriters(): Promise<void> {
    if (this.disposed || this.retryingWriters) {
      return;
    }
    this.retryingWriters = true;
    try {
      const readers = this.getAllServices().filter((service) => {
        const access = this.accessById.get(service.id);
        return (
          access &&
          !access.requestedReadOnly &&
          access.effectiveReadOnly &&
          service.isBackgroundWorkAllowed()
        );
      });
      for (const service of readers) {
        if (this.disposed) {
          break;
        }
        await this.tryPromoteAutomaticReader(service);
      }
    } finally {
      this.retryingWriters = false;
      if (!this.hasPendingAutomaticReader() && this.writerRetryTimer) {
        clearInterval(this.writerRetryTimer);
        this.writerRetryTimer = undefined;
      }
    }
  }

  private async tryPromoteAutomaticReader(current: IndexService): Promise<void> {
    return this.runTopologyMutation(() => this.tryPromoteAutomaticReaderUnlocked(current));
  }

  private async tryPromoteAutomaticReaderUnlocked(current: IndexService): Promise<void> {
    if (!this.isCurrentService(current) || !current.isBackgroundWorkAllowed()) {
      return;
    }
    const access = this.accessById.get(current.id);
    if (!access || access.requestedReadOnly || !access.effectiveReadOnly) {
      return;
    }

    const leaseResult = await acquireIndexWriterLease(current.getDbPath(), {
      label: this.writerLabel,
    });
    if (this.disposed || !this.isCurrentService(current)) {
      if (leaseResult.acquired) {
        await leaseResult.lease.release().catch(() => undefined);
      }
      return;
    }
    if (!leaseResult.acquired) {
      const ownerChanged = access.writerOwner?.token !== leaseResult.owner?.token;
      access.writerOwner = leaseResult.owner;
      if (ownerChanged) {
        this.emit('indexesChanged');
      }
      return;
    }

    if (this.disposed || !this.isCurrentService(current) || !current.isBackgroundWorkAllowed()) {
      await leaseResult.lease.release().catch(() => undefined);
      return;
    }

    const meta = this.getIndexMeta(current.id);
    if (!meta) {
      await leaseResult.lease.release().catch(() => undefined);
      return;
    }
    const replacement = new IndexService(current.getDbPath(), {
      id: current.id,
      name: current.name,
      readOnly: false,
      perIndexExcludes: metaToPerIndexExcludes(meta),
    });
    try {
      await replacement.initialize(current.getRootDirs());
    } catch {
      replacement.dispose();
      await leaseResult.lease.release().catch(() => undefined);
      return;
    }

    const currentAccess = this.accessById.get(current.id);
    if (
      this.disposed ||
      !this.isCurrentService(current) ||
      !current.isBackgroundWorkAllowed() ||
      currentAccess !== access ||
      currentAccess.requestedReadOnly ||
      !currentAccess.effectiveReadOnly
    ) {
      replacement.dispose();
      await leaseResult.lease.release().catch(() => undefined);
      return;
    }

    const attached = this.secondaries.get(current.id);
    if (this.primary === current) {
      this.primary = replacement;
      this.primaryMeta = cloneIndexMeta(meta);
    } else if (attached?.service === current) {
      attached.service = replacement;
    } else {
      replacement.dispose();
      await leaseResult.lease.release().catch(() => undefined);
      return;
    }

    try {
      current.dispose();
    } catch {
      // The replacement is already open and owns the lease.
    }
    this.accessById.delete(current.id);
    this.rememberOpenedService({
      service: replacement,
      lease: leaseResult.lease,
      access: {
        requestedReadOnly: false,
        effectiveReadOnly: false,
        writerOwner: leaseResult.owner,
      },
    });
    this.emit('indexesChanged');
    void replacement.startIndexing().catch(() => undefined);
  }

  private isCurrentService(service: IndexService): boolean {
    return (
      this.primary === service ||
      this.secondaries.get(service.id)?.service === service
    );
  }

  async createPrimary(
    dbPath: string,
    rootDirs: string[],
    name = 'Primary',
    excludeRules?: PerIndexExcludes
  ): Promise<IndexService> {
    // Reuse metadata for an existing physical database. Autocreate invokes
    // this path on every activation, so generating a fresh id would otherwise
    // accumulate duplicate registry cards for the same DB.
    return this.openPrimary(dbPath, rootDirs, name, {
      readOnly: false,
      excludeRules,
    });
  }

  async openPrimary(
    dbPath: string,
    rootDirs: string[],
    name = 'Primary',
    options: OpenPrimaryOptions = {}
  ): Promise<IndexService> {
    return this.runTopologyMutation(() =>
      this.openPrimaryUnlocked(dbPath, rootDirs, name, options)
    );
  }

  private async openPrimaryUnlocked(
    dbPath: string,
    rootDirs: string[],
    name = 'Primary',
    options: OpenPrimaryOptions = {}
  ): Promise<IndexService> {
    this.assertActive();
    const normalized = path.resolve(dbPath);
    const requestedReadOnly = options.readOnly ?? false;
    const existingMeta =
      this.getActiveIndexMetaByDbPath(normalized) ??
      this.registry.getByDbPath(normalized);
    let meta = existingMeta ? cloneIndexMeta(existingMeta) : undefined;
    const now = Date.now();

    if (!meta) {
      meta = {
        id: IndexRegistry.generateId(),
        name,
        dbPath: normalized,
        rootDirs,
        readOnly: requestedReadOnly,
        directoryMappings: options.directoryMappings ?? [],
        excludeDirNames: options.excludeRules?.excludeDirNames,
        excludeFileNames: options.excludeRules?.excludeFileNames,
        excludeGlobs: options.excludeRules?.excludeGlobs,
        workspaceHashes: [],
        createdAt: now,
        updatedAt: now,
      };
    } else {
      meta.dbPath = normalized;
      if (rootDirs.length > 0) {
        meta.rootDirs = [...rootDirs];
      }
      meta.readOnly = requestedReadOnly;
      meta.updatedAt = now;
      if (name && meta.name === 'Primary') {
        meta.name = name;
      }
      if (options.excludeRules) {
        meta.excludeDirNames = options.excludeRules.excludeDirNames;
        meta.excludeFileNames = options.excludeRules.excludeFileNames;
        meta.excludeGlobs = options.excludeRules.excludeGlobs;
      }
      if (options.directoryMappings) {
        meta.directoryMappings = [...options.directoryMappings];
      }
    }

    const currentIsSamePath =
      this.primary &&
      canonicalPathKey(this.primary.getDbPath()) === canonicalPathKey(normalized);
    const currentAccess = this.primary ? this.accessById.get(this.primary.id) : undefined;
    const shouldRetryAutomaticWriter =
      !requestedReadOnly && currentAccess?.effectiveReadOnly === true;
    if (
      currentIsSamePath &&
      currentAccess?.requestedReadOnly === requestedReadOnly &&
      !shouldRetryAutomaticWriter
    ) {
      const registrySnapshot = this.registry.snapshot();
      const persistedMeta = this.registry.upsertByDbPath(meta);
      this.registry.setWorkspacePrimary(persistedMeta.id, this.workspaceHash);
      try {
        await this.registry.save();
        this.assertActive();
      } catch (error) {
        this.registry.restore(registrySnapshot);
        this.syncAttachedMetadataFromRegistry();
        throw error;
      }
      if (this.workspaceRoots.length === 0) {
        this.workspaceRoots = [...rootDirs];
      }
      this.primary!.setName(meta.name);
      this.primary!.setPerIndexExcludes(metaToPerIndexExcludes(meta));
      this.primaryMeta = cloneIndexMeta(meta);
      return this.primary!;
    }

    const attachedTarget = Array.from(this.secondaries.values()).find(
      (item) => canonicalPathKey(item.meta.dbPath) === canonicalPathKey(normalized)
    );
    const attachedSnapshot = attachedTarget
      ? {
          meta: cloneIndexMeta(attachedTarget.meta),
          requestedReadOnly:
            this.accessById.get(attachedTarget.service.id)?.requestedReadOnly ??
            attachedTarget.service.isReadOnly(),
        }
      : undefined;
    if (attachedTarget) {
      await this.closeService(attachedTarget.service);
      this.secondaries.delete(attachedTarget.meta.id);
    }

    // Initialize the replacement before closing the current primary. A bad
    // manual selection therefore leaves the working search index intact.
    let opened: OpenedService;
    try {
      opened = await this.openService(meta, rootDirs, requestedReadOnly);
      this.assertActive();
    } catch (error) {
      if (attachedTarget) {
        try {
          await this.attachSecondaryUnlocked(attachedTarget.meta.dbPath, {
            name: attachedSnapshot!.meta.name,
            readOnly: attachedSnapshot!.requestedReadOnly,
            directoryMappings: attachedSnapshot!.meta.directoryMappings,
            rootDirs: attachedSnapshot!.meta.rootDirs,
          });
        } catch {
          // Preserve the original selection error; the panel can reopen the
          // secondary explicitly if restoration also failed.
        }
      }
      throw error;
    }

    const previous = this.primary;
    const registrySnapshot = this.registry.snapshot();
    const persistedMeta = this.registry.upsertByDbPath(meta);
    this.registry.setWorkspacePrimary(persistedMeta.id, this.workspaceHash);
    try {
      await this.registry.save();
      this.assertActive();
    } catch (error) {
      this.registry.restore(registrySnapshot);
      this.syncAttachedMetadataFromRegistry();
      await this.closeOpenedService(opened);
      if (attachedSnapshot) {
        await this.restoreSecondaryUnlocked(attachedSnapshot).catch(() => undefined);
      }
      throw error;
    }

    this.primary = opened.service;
    this.primaryMeta = cloneIndexMeta(meta);
    if (this.workspaceRoots.length === 0) {
      this.workspaceRoots = [...rootDirs];
    }
    if (previous) {
      await this.closeService(previous);
    }
    this.assertActive();
    this.rememberOpenedService(opened);
    this.emit('indexesChanged');
    return this.primary;
  }

  private async closeOpenedService(opened: OpenedService): Promise<void> {
    this.pendingServices.delete(opened.service);
    if (opened.lease) {
      this.pendingLeases.delete(opened.lease);
    }
    try {
      opened.service.dispose();
    } catch {
      // Continue with lease release even if SQLite close reports an error.
    }
    await opened.lease?.release().catch(() => undefined);
  }

  private async restoreSecondaryUnlocked(snapshot: {
    meta: IndexMeta;
    requestedReadOnly: boolean;
  }): Promise<void> {
    await this.attachSecondaryUnlocked(snapshot.meta.dbPath, {
      name: snapshot.meta.name,
      readOnly: snapshot.requestedReadOnly,
      directoryMappings: snapshot.meta.directoryMappings,
      rootDirs: snapshot.meta.rootDirs,
    });
  }

  private syncAttachedMetadataFromRegistry(): void {
    if (this.primary) {
      const restoredPrimary = this.registry.getById(this.primary.id);
      if (restoredPrimary) {
        this.primaryMeta = cloneIndexMeta(restoredPrimary);
      }
    }
    for (const [id, attached] of this.secondaries) {
      const restored = this.registry.getById(id);
      if (restored) {
        attached.meta = restored;
      }
    }
  }

  async attachSecondary(
    dbPath: string,
    options?: {
      name?: string;
      readOnly?: boolean;
      directoryMappings?: DirectoryMapping[];
      rootDirs?: string[];
      waitForInitialIndex?: boolean;
    }
  ): Promise<IndexService> {
    return this.runTopologyMutation(() => this.attachSecondaryUnlocked(dbPath, options));
  }

  private async attachSecondaryUnlocked(
    dbPath: string,
    options?: {
      name?: string;
      readOnly?: boolean;
      directoryMappings?: DirectoryMapping[];
      rootDirs?: string[];
      waitForInitialIndex?: boolean;
    }
  ): Promise<IndexService> {
    this.assertActive();
    const normalized = path.resolve(dbPath);
    if (
      this.primary &&
      canonicalPathKey(this.primary.getDbPath()) === canonicalPathKey(normalized)
    ) {
      throw new Error('The active primary index cannot also be opened as a secondary index');
    }
    const existing = Array.from(this.secondaries.values()).find(
      (item) => canonicalPathKey(item.meta.dbPath) === canonicalPathKey(normalized)
    );
    if (existing) {
      return existing.service;
    }

    const existingMeta = this.registry.getByDbPath(normalized);
    let meta = existingMeta ? cloneIndexMeta(existingMeta) : undefined;
    const readOnly = options?.readOnly ?? meta?.readOnly ?? true;
    const roots = options?.rootDirs ?? meta?.rootDirs ?? [];
    if (!readOnly && roots.length === 0) {
      throw new Error('A writable secondary index requires an explicit source root');
    }

    if (!meta) {
      meta = {
        id: IndexRegistry.generateId(),
        name: options?.name ?? path.basename(path.dirname(normalized)),
        dbPath: normalized,
        rootDirs: roots,
        readOnly,
        directoryMappings: options?.directoryMappings ?? [],
        workspaceHashes: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    } else {
      meta.dbPath = normalized;
      if (options?.name) {
        meta.name = options.name;
      }
      if (options?.directoryMappings) {
        meta.directoryMappings = options.directoryMappings;
      }
      if (options?.rootDirs?.length) {
        meta.rootDirs = [...options.rootDirs];
      }
      meta.readOnly = readOnly;
      meta.updatedAt = Date.now();
    }

    const opened = await this.openService(meta, meta.rootDirs, readOnly);
    const service = opened.service;
    if (options?.waitForInitialIndex !== false) {
      try {
        await service.startIndexing();
        this.assertActive();
      } catch (error) {
        await this.closeOpenedService(opened);
        throw error;
      }
    }

    const registrySnapshot = this.registry.snapshot();
    this.registry.upsertByDbPath(meta);
    try {
      await this.registry.save();
      this.assertActive();
    } catch (error) {
      this.registry.restore(registrySnapshot);
      this.syncAttachedMetadataFromRegistry();
      await this.closeOpenedService(opened);
      throw error;
    }

    this.secondaries.set(meta.id, { meta, service });
    this.rememberOpenedService(opened);
    this.emit('indexesChanged');
    return service;
  }

  async detachSecondary(id: string): Promise<boolean> {
    return this.runTopologyMutation(() => this.detachSecondaryUnlocked(id));
  }

  private async detachSecondaryUnlocked(id: string): Promise<boolean> {
    const attached = this.secondaries.get(id);
    if (!attached) {
      return false;
    }
    await this.closeService(attached.service);
    this.secondaries.delete(id);
    this.emit('indexesChanged');
    return true;
  }

  mapHitPath(indexId: string, filePath: string): string {
    if (this.primary?.id === indexId) {
      return mapFilePath(filePath, this.primaryMeta?.directoryMappings ?? []);
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
    return this.runTopologyMutation(() => this.deleteIndexUnlocked(id, deleteFiles));
  }

  private async deleteIndexUnlocked(id: string, deleteFiles = false): Promise<boolean> {
    this.assertActive();
    if (this.primary?.id === id) {
      return false; // cannot delete primary while active
    }

    const meta = this.registry.getById(id);
    if (
      deleteFiles &&
      meta &&
      (this.registry.getAll().some(
        (item) =>
          item.id !== id &&
          canonicalPathKey(item.dbPath) === canonicalPathKey(meta.dbPath)
      ) ||
        this.getAllServices().some(
          (service) =>
            service.id !== id &&
            canonicalPathKey(service.getDbPath()) === canonicalPathKey(meta.dbPath)
        ))
    ) {
      return false;
    }

    const attached = this.secondaries.get(id);
    if (attached) {
      await this.detachSecondaryUnlocked(id);
    }

    let administrativeLease: IndexWriterLease | undefined;
    if (deleteFiles && meta) {
      if (fs.existsSync(`${meta.dbPath}.writer.lock.reclaim`)) {
        return false;
      }
      try {
        const leaseResult = await acquireIndexWriterLease(meta.dbPath, {
          label: `${this.writerLabel} (delete index)`,
        });
        if (!leaseResult.acquired) {
          return false;
        }
        administrativeLease = leaseResult.lease;
      } catch (error) {
        const noIndexArtifacts = [
          meta.dbPath,
          `${meta.dbPath}-wal`,
          `${meta.dbPath}-shm`,
          `${meta.dbPath}.writer.lock`,
          `${meta.dbPath}.writer.lock.reclaim`,
        ].every((dataPath) => !fs.existsSync(dataPath));
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !noIndexArtifacts) {
          throw error;
        }
      }
      if (administrativeLease && this.disposed) {
        await administrativeLease.release().catch(() => undefined);
        this.assertActive();
      }
    }

    try {
      let physicalDeleteSucceeded = !deleteFiles;
      const registrySnapshot = this.registry.snapshot();
      const removed = this.registry.remove(id);
      if (removed) {
        try {
          if (deleteFiles && meta) {
            const deletePhysicalFile = await this.registry.saveWithExclusiveHooks(
              (merged) =>
                !merged.some(
                  (item) =>
                    canonicalPathKey(item.dbPath) === canonicalPathKey(meta.dbPath)
                ),
              async (deletePhysicalFile) => {
                if (!deletePhysicalFile) {
                  return;
                }
                physicalDeleteSucceeded = true;
                for (const dataPath of [
                  meta.dbPath,
                  `${meta.dbPath}-wal`,
                  `${meta.dbPath}-shm`,
                ]) {
                  try {
                    await fs.promises.unlink(dataPath);
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                      physicalDeleteSucceeded = false;
                    }
                  }
                }
              }
            );
            if (!deletePhysicalFile) {
              physicalDeleteSucceeded = false;
            }
          } else {
            await this.registry.save();
          }
        } catch (error) {
          this.registry.restore(registrySnapshot);
          throw error;
        }
        this.assertActive();
      }
      return removed && physicalDeleteSucceeded;
    } finally {
      await administrativeLease?.release().catch(() => undefined);
    }
  }

  async renameIndex(id: string, name: string): Promise<boolean> {
    const meta = this.getIndexMeta(id);
    if (!meta) {
      return false;
    }
    meta.name = name;
    meta.updatedAt = Date.now();
    this.registry.upsertByDbPath(meta);
    if (this.primary?.id === id) {
      this.primary.setName(name);
      this.primaryMeta = meta;
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
    return this.runTopologyMutation(() => this.moveIndexUnlocked(id, newDbPath));
  }

  private async moveIndexUnlocked(id: string, newDbPath: string): Promise<boolean> {
    this.assertActive();
    const meta = this.registry.getById(id);
    if (!meta) {
      return false;
    }
    const sourcePath = path.resolve(meta.dbPath);
    const destinationPath = path.resolve(newDbPath);
    if (canonicalPathKey(sourcePath) === canonicalPathKey(destinationPath)) {
      return true;
    }
    const activeSamePath = meta
      ? this.getAllServices().some(
          (service) =>
            canonicalPathKey(service.getDbPath()) === canonicalPathKey(sourcePath)
        )
      : false;
    const destinationCatalogConflict = this.registry.getAll().some(
      (item) =>
        item.id !== id &&
        canonicalPathKey(item.dbPath) === canonicalPathKey(destinationPath)
    );
    const destinationActive = this.getAllServices().some(
      (service) =>
        canonicalPathKey(service.getDbPath()) === canonicalPathKey(destinationPath)
    );
    if (
      activeSamePath ||
      destinationCatalogConflict ||
      destinationActive ||
      fs.existsSync(destinationPath) ||
      fs.existsSync(`${destinationPath}.writer.lock`) ||
      fs.existsSync(`${destinationPath}.writer.lock.reclaim`) ||
      fs.existsSync(`${destinationPath}-wal`) ||
      fs.existsSync(`${destinationPath}-shm`)
    ) {
      return false;
    }

    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    const sourceLeaseResult = await acquireIndexWriterLease(sourcePath, {
      label: `${this.writerLabel} (move index source)`,
    });
    if (!sourceLeaseResult.acquired) {
      return false;
    }

    let destinationLease: IndexWriterLease | undefined;
    try {
      const destinationLeaseResult = await acquireIndexWriterLease(destinationPath, {
        label: `${this.writerLabel} (move index destination)`,
      });
      if (!destinationLeaseResult.acquired) {
        return false;
      }
      destinationLease = destinationLeaseResult.lease;
      this.assertActive();

      // Recheck after both atomic leases: another process may have changed the
      // filesystem between the optimistic UI checks and lease acquisition.
      if (
        fs.existsSync(`${sourcePath}-wal`) ||
        fs.existsSync(destinationPath) ||
        fs.existsSync(`${destinationPath}-wal`) ||
        fs.existsSync(`${destinationPath}-shm`)
      ) {
        return false;
      }

      try {
        await fs.promises.copyFile(
          sourcePath,
          destinationPath,
          fs.constants.COPYFILE_EXCL
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return false;
        }
        throw error;
      }

      const registrySnapshot = this.registry.snapshot();
      this.registry.move(id, destinationPath);
      let committed: boolean;
      try {
        committed = await this.registry.saveWithExclusiveHooks((merged) => {
          const destinationConflict = merged.some(
            (item) =>
              item.id !== id &&
              canonicalPathKey(item.dbPath) === canonicalPathKey(destinationPath)
          );
          if (!destinationConflict) {
            return true;
          }

          // A peer claimed the destination while this operation waited for
          // the registry lease. Roll this record back in the draft so no
          // transient duplicate-path commit is visible to another process.
          const moved = merged.find((item) => item.id === id);
          if (moved) {
            moved.dbPath = sourcePath;
            moved.updatedAt = Date.now();
          }
          return false;
        });
      } catch (error) {
        this.registry.restore(registrySnapshot);
        // Do not unlink after a successful exclusive copy. A peer may have
        // claimed this path in the catalog while the save was pending; an
        // unreferenced copy is recoverable, deleting a peer's DB is not.
        throw error;
      }
      this.assertActive();
      return committed;
    } finally {
      await destinationLease?.release().catch(() => undefined);
      await sourceLeaseResult.lease.release().catch(() => undefined);
    }
  }

  async setDirectoryMappings(id: string, mappings: DirectoryMapping[]): Promise<boolean> {
    const meta = this.getIndexMeta(id);
    if (!meta) {
      return false;
    }
    meta.directoryMappings = mappings;
    meta.updatedAt = Date.now();
    const attached = this.secondaries.get(id);
    if (attached) {
      attached.meta.directoryMappings = mappings;
    }
    if (this.primary?.id === id) {
      this.primaryMeta = meta;
    }
    this.registry.upsertByDbPath(meta);
    await this.registry.save();
    this.emit('indexesChanged');
    return true;
  }

  async setExcludeRules(id: string, rules: PerIndexExcludes): Promise<boolean> {
    const meta = this.getIndexMeta(id);
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
      this.primaryMeta = meta;
    }
    const attached = this.secondaries.get(id);
    if (attached) {
      attached.meta.excludeDirNames = meta.excludeDirNames;
      attached.meta.excludeFileNames = meta.excludeFileNames;
      attached.meta.excludeGlobs = meta.excludeGlobs;
      attached.service.setPerIndexExcludes(perIndex);
    }

    this.registry.upsertByDbPath(meta);
    await this.registry.save();
    return true;
  }

  async loadWorkspaceSecondaries(
    secondaryIds: string[],
    options: { waitForInitialIndex?: boolean } = {}
  ): Promise<IndexService[]> {
    const restored: IndexService[] = [];
    for (const id of secondaryIds) {
      const meta = this.registry.getById(id);
      if (meta && !this.secondaries.has(id)) {
        try {
          const service = await this.attachSecondary(meta.dbPath, {
            name: meta.name,
            readOnly: meta.readOnly,
            directoryMappings: meta.directoryMappings,
            rootDirs: meta.rootDirs,
            waitForInitialIndex: options.waitForInitialIndex,
          });
          restored.push(service);
        } catch {
          // Older releases allowed writable secondary metadata with no source
          // roots. Preserve activation by reopening those databases as readers;
          // the management UI can later collect roots before enabling writes.
          if (!meta.readOnly && meta.rootDirs.length === 0) {
            const service = await this.attachSecondary(meta.dbPath, {
              name: meta.name,
              readOnly: true,
              directoryMappings: meta.directoryMappings,
              rootDirs: [],
              waitForInitialIndex: options.waitForInitialIndex,
            }).catch(() => undefined);
            if (service) {
              restored.push(service);
            }
          }
        }
      }
    }
    return restored;
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

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    if (this.writerRetryTimer) {
      clearInterval(this.writerRetryTimer);
      this.writerRetryTimer = undefined;
    }

    const services = [...this.getAllServices(), ...this.pendingServices];
    const leases = [...this.writerLeases.values(), ...this.pendingLeases];
    const pendingTopology = this.topologyMutationTail;
    this.primary = undefined;
    this.primaryMeta = undefined;
    this.secondaries.clear();
    this.writerLeases.clear();
    this.pendingServices.clear();
    this.pendingLeases.clear();
    this.accessById.clear();
    for (const service of services) {
      try {
        service.dispose();
      } catch {
        // Continue releasing every writer lease during shutdown.
      }
    }

    const pendingRetry = this.writerRetryTask;
    this.disposePromise = Promise.allSettled([
      ...leases.map((lease) => lease.release()),
      ...(pendingRetry ? [pendingRetry] : []),
      pendingTopology,
    ]).then(() => undefined);
    return this.disposePromise;
  }
}
