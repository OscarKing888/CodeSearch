import { IndexService } from '../index/IndexService';
import {
  ClassDeclaration,
  ClassHierarchy,
  buildClassHierarchy,
} from './classHierarchy';
import { ClassHierarchyCacheStore } from './classHierarchyCacheStore';
import {
  ClassHierarchySourceParser,
  throwIfAborted,
  yieldToEventLoop,
} from './ClassHierarchySourceParser';

const READ_PAGE_SIZE = 16;

export interface ReadonlyClassHierarchySnapshot {
  hierarchy: ClassHierarchy;
  parsedFileCount: number;
  fallbackParsedFileCount: number;
  partialIndex: boolean;
}

export interface ReadonlyClassHierarchyLoaderOptions {
  workerScript?: string;
  useWorkers?: boolean;
  warn?: (message: string, error: unknown) => void;
}

/**
 * Builds one hierarchy from an already-open index without writing cache rows.
 * Current cache rows are reused and only missing/stale source snapshots are
 * parsed in memory.
 */
export class ReadonlyClassHierarchyLoader {
  private readonly parser: ClassHierarchySourceParser;

  constructor(options: ReadonlyClassHierarchyLoaderOptions = {}) {
    this.parser = new ClassHierarchySourceParser({
      workerScript: options.workerScript,
      useWorkers: options.useWorkers,
      workerBatchSize: 8,
      warn: options.warn,
    });
  }

  async dispose(): Promise<void> {
    await this.parser.dispose();
  }

  async build(
    service: IndexService,
    indexId: string,
    signal?: AbortSignal
  ): Promise<ReadonlyClassHierarchySnapshot> {
    throwIfAborted(signal);
    const db = service.getDatabase();
    if (!db) {
      throw new Error(`Index database is unavailable: ${indexId}`);
    }

    // Always inspect as read-only, even if a caller accidentally supplies a
    // writable service. MCP must never create or update hierarchy cache tables.
    const store = new ClassHierarchyCacheStore(db, { readOnly: true });
    const capabilities = store.initialize();
    const declarations: ClassDeclaration[] = capabilities.available
      ? store.readCachedDeclarations()
      : [];
    const cachedFileCount = capabilities.available ? store.countCachedFiles() : 0;

    let afterFileId = 0;
    let fallbackParsedFileCount = 0;
    let complete = true;
    while (true) {
      throwIfAborted(signal);
      const page = store.readPendingSourcePage({
        afterFileId,
        limit: READ_PAGE_SIZE,
      });
      const parsed = await this.parser.parsePage(page.sources, signal);
      complete &&=
        parsed.failedFileCount === 0 &&
        page.sources.length === page.files.length;
      for (const file of parsed.files) {
        fallbackParsedFileCount++;
        for (const declaration of file.declarations) {
          declarations.push(declaration);
        }
      }
      afterFileId = page.nextAfterFileId;
      if (page.done) {
        break;
      }
      await yieldToEventLoop();
    }

    const tagged = tagDeclarations(indexId, declarations);
    return {
      hierarchy: buildClassHierarchy(tagged),
      parsedFileCount: cachedFileCount + fallbackParsedFileCount,
      fallbackParsedFileCount,
      partialIndex: service.isPartialIndex() || !complete,
    };
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
