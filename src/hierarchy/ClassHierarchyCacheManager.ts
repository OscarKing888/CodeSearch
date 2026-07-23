import * as path from 'path';
import { EventEmitter } from 'events';
import { IndexManager } from '../index/IndexManager';
import { IndexService } from '../index/IndexService';
import { ClassHierarchyModel } from './ClassHierarchyModel';
import {
  ClassDeclaration,
  buildClassHierarchy,
} from './classHierarchy';
import {
  ClassHierarchyCacheStore,
  ParsedClassHierarchyFile,
} from './classHierarchyCacheStore';
import {
  ClassHierarchySourceParser,
  throwIfAborted,
  yieldToEventLoop,
} from './ClassHierarchySourceParser';

const CACHE_PAGE_SIZE = 16;
const CACHE_APPLY_BATCH_SIZE = 16;
const BACKGROUND_DELAY_MS = 1500;

interface ReadonlyFallback {
  declarations: ClassDeclaration[];
  parsedFileCount: number;
  complete: boolean;
}

interface ServiceDeclarations {
  declarations: ClassDeclaration[];
  parsedFileCount: number;
  partial: boolean;
}

/**
 * Coordinates the disposable inheritance cache without adding parser work to
 * the normal index/search path. Workers only parse text; SQLite stays on the
 * extension thread and receives bounded bulk applies after an idle scan completes.
 */
export class ClassHierarchyCacheManager extends EventEmitter {
  private readonly stores = new WeakMap<IndexService, ClassHierarchyCacheStore>();
  private readonly readonlyFallbacks = new Map<string, ReadonlyFallback>();
  private readonly sourceParser: ClassHierarchySourceParser;
  private syncPromise: Promise<boolean> | undefined;
  private backgroundTimer: ReturnType<typeof setTimeout> | undefined;
  private cachedModel: ClassHierarchyModel | undefined;
  private disposed = false;
  private modelGeneration = 0;
  private modelDirty = false;

  private readonly onProgress = () => {
    this.invalidateModel(true);
    this.scheduleBackgroundSync();
  };

  private readonly onIndexesChanged = () => {
    this.readonlyFallbacks.clear();
    this.invalidateModel(false);
    this.emit('updated');
    this.scheduleBackgroundSync(250);
  };

  constructor(
    private readonly indexManager: IndexManager,
    workerScript: string
  ) {
    super();
    this.sourceParser = new ClassHierarchySourceParser({
      workerScript,
      workerBatchSize: 8,
      warn: (message, error) => this.warn(message, error),
    });
  }

  start(): void {
    if (this.disposed) {
      return;
    }
    this.indexManager.on('progress', this.onProgress);
    this.indexManager.on('indexesChanged', this.onIndexesChanged);
    this.scheduleBackgroundSync();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.indexManager.off('progress', this.onProgress);
    this.indexManager.off('indexesChanged', this.onIndexesChanged);
    if (this.backgroundTimer) {
      clearTimeout(this.backgroundTimer);
      this.backgroundTimer = undefined;
    }
    await this.sourceParser.dispose();
    try {
      await this.syncPromise;
    } catch {
      // Terminating the worker pool is expected to cancel an in-flight sync.
    }
    this.removeAllListeners();
  }

  async buildModel(signal?: AbortSignal, force = false): Promise<ClassHierarchyModel> {
    throwIfAborted(signal);
    if (force) {
      this.readonlyFallbacks.clear();
      this.invalidateModel(false);
    }
    if (this.cachedModel) {
      return this.cachedModel;
    }
    await this.synchronizeWritableCaches();
    throwIfAborted(signal);

    if (this.cachedModel) {
      return this.cachedModel;
    }

    const generation = this.modelGeneration;
    const combined: ClassDeclaration[] = [];
    let parsedFileCount = 0;
    let partial = this.indexManager.isPartialIndex();

    for (const service of this.indexManager.getAllServices()) {
      throwIfAborted(signal);
      const result = await this.readServiceDeclarations(service, signal);
      for (const declaration of result.declarations) {
        combined.push(declaration);
      }
      parsedFileCount += result.parsedFileCount;
      partial ||= result.partial;
      await yieldToEventLoop();
    }

    throwIfAborted(signal);
    const declarations = mapAndDeduplicateDeclarations(this.indexManager, combined);
    const hierarchy = buildClassHierarchy(declarations);
    const nodes = hierarchy.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      kind: node.kind,
      external: node.external || undefined,
      path: node.path,
      line: node.line,
      column: node.column,
      children: [...node.derivedIds],
    }));
    const model: ClassHierarchyModel = {
      roots: [...hierarchy.roots],
      nodes,
      classCount: nodes.filter((node) => !node.external).length,
      externalBaseCount: nodes.filter((node) => node.external).length,
      parsedFileCount,
      partialIndex: partial,
    };
    if (generation === this.modelGeneration) {
      this.cachedModel = model;
    } else {
      model.partialIndex = true;
      this.scheduleBackgroundSync(250);
    }
    return model;
  }

  private scheduleBackgroundSync(delay = BACKGROUND_DELAY_MS): void {
    if (this.disposed || this.backgroundTimer) {
      return;
    }
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = undefined;
      void this.synchronizeWritableCaches()
        .catch((error) => this.warn('background cache update failed', error));
    }, delay);
  }

  private async synchronizeWritableCaches(): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = this.runWritableSync();
    try {
      const changed = await this.syncPromise;
      const safeToNotify = this.indexManager.getAllServices().every(
        (service) => service.isReadOnly() || service.isBackgroundWorkAllowed()
      );
      const notify = safeToNotify && (changed || this.modelDirty);
      if (notify) {
        this.modelDirty = false;
      }
      if (notify && !this.disposed) {
        this.invalidateModel(false);
        this.emit('updated');
      }
      return changed;
    } finally {
      this.syncPromise = undefined;
    }
  }

  private async runWritableSync(): Promise<boolean> {
    let changed = false;
    let retryNeeded = false;
    for (const service of this.indexManager.getAllServices()) {
      if (this.disposed || service.isReadOnly()) {
        continue;
      }
      if (!service.isBackgroundWorkAllowed()) {
        retryNeeded = true;
        continue;
      }

      const store = this.getStore(service, true);
      if (!store) {
        continue;
      }
      const parsedFiles: ParsedClassHierarchyFile[] = [];
      let afterFileId = 0;
      let scanComplete = true;

      while (!this.disposed) {
        if (!service.isBackgroundWorkAllowed()) {
          retryNeeded = true;
          scanComplete = false;
          break;
        }
        const page = store.readPendingSourcePage({
          afterFileId,
          limit: CACHE_PAGE_SIZE,
        });
        if (page.sources.length > 0) {
          const parsed = await this.sourceParser.parsePage(page.sources);
          for (const file of parsed.files) {
            parsedFiles.push(file);
          }
          if (parsed.failedFileCount > 0) {
            retryNeeded = true;
          }
        }
        afterFileId = page.nextAfterFileId;
        if (page.done) {
          break;
        }
        await yieldToEventLoop();
      }

      if (!scanComplete || parsedFiles.length === 0 || this.disposed) {
        continue;
      }
      for (let offset = 0; offset < parsedFiles.length; offset += CACHE_APPLY_BATCH_SIZE) {
        if (!service.isBackgroundWorkAllowed() || !service.getDatabase()) {
          retryNeeded = true;
          break;
        }
        const applied = store.applyParsedFiles(
          parsedFiles.slice(offset, offset + CACHE_APPLY_BATCH_SIZE)
        );
        changed ||= applied.appliedFileIds.length > 0;
        if (applied.skippedFileIds.length > 0) {
          retryNeeded = true;
        }
        await yieldToEventLoop();
      }
    }

    if (retryNeeded && !this.disposed) {
      this.scheduleBackgroundSync();
    }
    return changed;
  }

  private async readServiceDeclarations(
    service: IndexService,
    signal?: AbortSignal
  ): Promise<ServiceDeclarations> {
    const store = this.getStore(service, service.isBackgroundWorkAllowed());
    if (!store) {
      return { declarations: [], parsedFileCount: 0, partial: true };
    }

    const capabilities = store.getCapabilities();
    const cached = capabilities.available ? store.readCachedDeclarations() : [];
    const cachedFileCount = capabilities.available ? store.countCachedFiles() : 0;
    const pending = store.listPendingFiles({ limit: 1 }).files.length > 0;

    if (!service.isReadOnly()) {
      return {
        declarations: tagDeclarations(service.id, cached),
        parsedFileCount: cachedFileCount,
        partial: pending || !capabilities.available,
      };
    }

    let fallback = this.readonlyFallbacks.get(service.id);
    if (!fallback && (pending || !capabilities.available)) {
      fallback = await this.parseReadonlyFallback(store, signal);
      this.readonlyFallbacks.set(service.id, fallback);
    }
    const declarations = cached.slice();
    if (fallback) {
      for (const declaration of fallback.declarations) {
        declarations.push(declaration);
      }
    }
    return {
      declarations: tagDeclarations(service.id, declarations),
      parsedFileCount: cachedFileCount + (fallback?.parsedFileCount ?? 0),
      partial: fallback ? !fallback.complete : pending || !capabilities.available,
    };
  }

  private async parseReadonlyFallback(
    store: ClassHierarchyCacheStore,
    signal?: AbortSignal
  ): Promise<ReadonlyFallback> {
    const declarations: ClassDeclaration[] = [];
    let parsedFileCount = 0;
    let complete = true;
    let afterFileId = 0;

    while (!this.disposed) {
      throwIfAborted(signal);
      const page = store.readPendingSourcePage({
        afterFileId,
        limit: CACHE_PAGE_SIZE,
      });
      const parsed = await this.sourceParser.parsePage(page.sources, signal);
      for (const file of parsed.files) {
        for (const declaration of file.declarations) {
          declarations.push(declaration);
        }
      }
      parsedFileCount += parsed.files.length;
      complete &&= parsed.failedFileCount === 0;
      afterFileId = page.nextAfterFileId;
      if (page.done) {
        break;
      }
      await yieldToEventLoop();
    }
    return { declarations, parsedFileCount, complete: complete && !this.disposed };
  }

  private getStore(
    service: IndexService,
    allowWritableInitialization: boolean
  ): ClassHierarchyCacheStore | undefined {
    const existing = this.stores.get(service);
    if (existing) {
      if (service.isReadOnly() || !allowWritableInitialization ||
          existing.getCapabilities().writable) {
        return existing;
      }
    }
    const db = service.getDatabase();
    if (!db) {
      return undefined;
    }
    const store = new ClassHierarchyCacheStore(db, {
      readOnly: service.isReadOnly() || !allowWritableInitialization,
    });
    store.initialize();
    this.stores.set(service, store);
    return store;
  }

  private warn(message: string, error: unknown): void {
    if (this.disposed) {
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[Ace Code Search] ${message}: ${detail}`);
  }

  private invalidateModel(dirty: boolean): void {
    this.modelGeneration++;
    this.cachedModel = undefined;
    this.modelDirty ||= dirty;
  }
}

function tagDeclarations(
  indexId: string,
  declarations: readonly ClassDeclaration[]
): ClassDeclaration[] {
  return declarations.map((declaration) => ({
    ...declaration,
    id: `${indexId}:${declaration.id}`,
    location: {
      ...declaration.location,
      metadata: { indexId },
    },
  }));
}

function mapAndDeduplicateDeclarations(
  indexManager: IndexManager,
  declarations: readonly ClassDeclaration[]
): ClassDeclaration[] {
  const unique = new Map<string, ClassDeclaration>();
  for (const declaration of declarations) {
    const metadata = declaration.location.metadata as { indexId?: unknown } | undefined;
    const indexId = typeof metadata?.indexId === 'string' ? metadata.indexId : '';
    const mappedPath = indexId
      ? indexManager.mapHitPath(indexId, declaration.location.path)
      : declaration.location.path;
    const comparablePath = process.platform === 'win32'
      ? path.normalize(mappedPath).toLocaleLowerCase()
      : path.normalize(mappedPath);
    const key = [
      comparablePath,
      declaration.location.line,
      declaration.location.column,
      declaration.qualifiedName,
    ].join('\0');
    if (unique.has(key)) {
      continue;
    }
    unique.set(key, {
      ...declaration,
      location: {
        ...declaration.location,
        path: mappedPath,
      },
    });
  }
  return [...unique.values()];
}
