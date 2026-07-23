import {
  ClassDeclaration,
  extractClassDeclarations,
} from './classHierarchy';
import {
  ClassHierarchySourceSnapshot,
  ParsedClassHierarchyFile,
} from './classHierarchyCacheStore';
import {
  ClassHierarchyWorkerPool,
  shouldFallbackFromClassHierarchyWorker,
} from './ClassHierarchyWorkerPool';

export interface ClassHierarchyParsePageResult {
  files: ParsedClassHierarchyFile[];
  failedFileCount: number;
}

export interface ClassHierarchySourceParserOptions {
  workerScript?: string;
  useWorkers?: boolean;
  workerBatchSize?: number;
  warn?: (message: string, error: unknown) => void;
}

/**
 * CPU-only class declaration parser shared by the editor cache coordinator and
 * read-only MCP snapshots. SQLite handles stay with the caller.
 */
export class ClassHierarchySourceParser {
  private readonly workerPool: ClassHierarchyWorkerPool | undefined;
  private useWorkers: boolean;

  constructor(private readonly options: ClassHierarchySourceParserOptions = {}) {
    this.useWorkers = options.useWorkers !== false;
    this.workerPool = this.useWorkers
      ? new ClassHierarchyWorkerPool({
          workerScript: options.workerScript,
          batchSize: options.workerBatchSize ?? 8,
        })
      : undefined;
  }

  async dispose(): Promise<void> {
    await this.workerPool?.terminate();
  }

  async parsePage(
    sources: readonly ClassHierarchySourceSnapshot[],
    signal?: AbortSignal
  ): Promise<ClassHierarchyParsePageResult> {
    if (sources.length === 0) {
      return { files: [], failedFileCount: 0 };
    }

    if (this.useWorkers && this.workerPool) {
      try {
        const results = await this.workerPool.parseFiles(
          sources.map((source) => ({
            path: source.path,
            mtime: source.mtime,
            size: source.size,
            content: source.content,
          })),
          signal
        );
        const files: ParsedClassHierarchyFile[] = [];
        let failedFileCount = 0;
        results.forEach((result, index) => {
          const source = sources[index];
          if (
            !source ||
            !result.ok ||
            result.path !== source.path ||
            result.mtime !== source.mtime ||
            result.size !== source.size
          ) {
            failedFileCount++;
            return;
          }
          files.push(toParsedFile(source, result.declarations));
        });
        return { files, failedFileCount };
      } catch (error) {
        if (!shouldFallbackFromClassHierarchyWorker(error)) {
          throw error;
        }
        this.useWorkers = false;
        this.options.warn?.(
          'class parser worker unavailable; using the event-loop fallback',
          error
        );
      }
    }

    const files: ParsedClassHierarchyFile[] = [];
    let failedFileCount = 0;
    for (const source of sources) {
      throwIfAborted(signal);
      try {
        files.push(
          toParsedFile(
            source,
            extractClassDeclarations(source.content, source.path)
          )
        );
      } catch {
        failedFileCount++;
      }
    }
    await yieldToEventLoop();
    return { files, failedFileCount };
  }
}

function toParsedFile(
  source: ClassHierarchySourceSnapshot,
  declarations: readonly ClassDeclaration[]
): ParsedClassHierarchyFile {
  return {
    fileId: source.fileId,
    path: source.path,
    mtime: source.mtime,
    size: source.size,
    fingerprint: source.fingerprint,
    declarations,
  };
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Class hierarchy build cancelled');
  }
}
