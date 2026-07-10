import { IndexManager } from '../index/IndexManager';
import { isBinaryExtension } from '../index/FileScanner';
import { SearchService, getRelativePath } from './SearchService';
import {
  FIRST_BATCH_SIZE,
  STREAM_BATCH_SIZE,
  StreamYieldThrottle,
} from './searchStreamBuffer';
import { SearchHit, SearchOptions, SearchResult, SearchStreamBatch } from '../types';

export interface ExtendedSearchHit extends SearchHit {
  indexId: string;
  indexName: string;
  localPath: string;
}

export interface MultiSearchResult extends SearchResult {
  hits: ExtendedSearchHit[];
}

export interface MultiSearchStreamBatch extends SearchStreamBatch {
  hits: ExtendedSearchHit[];
}

export class MultiIndexSearchService {
  private searchers = new Map<string, SearchService>();

  constructor(private indexManager: IndexManager) {
    this.rebuildSearchers();
    indexManager.on('indexesChanged', () => this.rebuildSearchers());
  }

  rebuildSearchers(): void {
    this.searchers.clear();
    for (const service of this.indexManager.getAllServices()) {
      this.searchers.set(service.id, new SearchService(service));
    }
  }

  search(queryText: string, options: SearchOptions): MultiSearchResult {
    const start = Date.now();
    const services = this.indexManager.getAllServices();

    if (services.length === 0) {
      return {
        hits: [],
        hitCount: 0,
        fileCount: 0,
        elapsedMs: 0,
        query: queryText,
        partialIndex: true,
      };
    }

    const allHits: ExtendedSearchHit[] = [];
    const fileSet = new Set<string>();
    let partial = false;

    const perIndexLimit = Math.ceil(options.maxResults / services.length);

    for (const indexService of services) {
      const searcher = this.searchers.get(indexService.id) ?? new SearchService(indexService);
      const result = searcher.search(queryText, { ...options, maxResults: perIndexLimit });
      partial = partial || result.partialIndex;

      for (const hit of result.hits) {
        const localPath = this.indexManager.mapHitPath(indexService.id, hit.path);
        if (isBinaryExtension(localPath)) {
          continue;
        }
        const key = `${localPath}:${hit.line}:${hit.matchStart}`;
        if (fileSet.has(key)) {
          continue;
        }
        fileSet.add(key);
        allHits.push({
          ...hit,
          path: hit.path,
          localPath,
          indexId: indexService.id,
          indexName: indexService.name,
        });
      }
    }

    allHits.sort((a, b) => {
      if (a.path !== b.path) {
        return a.path.localeCompare(b.path);
      }
      return a.line - b.line;
    });

    const hits = allHits.slice(0, options.maxResults);
    const files = new Set(hits.map((h) => h.localPath));

    return {
      hits,
      hitCount: hits.length,
      fileCount: files.size,
      elapsedMs: Date.now() - start,
      query: queryText,
      partialIndex: partial || this.indexManager.isPartialIndex(),
    };
  }

  async *searchStreaming(
    queryText: string,
    options: SearchOptions
  ): AsyncGenerator<MultiSearchStreamBatch> {
    const start = Date.now();
    const services = this.indexManager.getAllServices();

    if (services.length === 0) {
      yield {
        hits: [],
        hitCount: 0,
        fileCount: 0,
        elapsedMs: 0,
        query: queryText,
        partialIndex: true,
        done: true,
      };
      return;
    }

    const perIndexLimit = Math.ceil(options.maxResults / services.length);

    if (services.length === 1) {
      const indexService = services[0];
      const searcher = this.searchers.get(indexService.id) ?? new SearchService(indexService);
      const yieldThrottle = new StreamYieldThrottle();
      const fileSet = new Set<string>();
      let hitCount = 0;

      for await (const batch of searcher.searchStreaming(queryText, {
        ...options,
        maxResults: perIndexLimit,
      })) {
        const hits: ExtendedSearchHit[] = [];
        for (const hit of batch.hits) {
          const localPath = this.indexManager.mapHitPath(indexService.id, hit.path);
          if (isBinaryExtension(localPath)) {
            continue;
          }
          hits.push({
            ...hit,
            path: hit.path,
            localPath,
            indexId: indexService.id,
            indexName: indexService.name,
          });
          fileSet.add(localPath);
          hitCount++;
        }

        yield {
          ...batch,
          hits,
          hitCount,
          fileCount: fileSet.size,
        };
        await yieldThrottle.maybeYield();
      }
      return;
    }

    const seenKeys = new Set<string>();
    const fileSet = new Set<string>();
    let pending: ExtendedSearchHit[] = [];
    let hitCount = 0;
    let partial = false;
    let firstBatchEmitted = false;
    const yieldThrottle = new StreamYieldThrottle();

    const batchThreshold = (): number =>
      firstBatchEmitted ? STREAM_BATCH_SIZE : FIRST_BATCH_SIZE;

    const emitBatch = (done: boolean): MultiSearchStreamBatch | null => {
      if (pending.length === 0 && !done) {
        return null;
      }
      const hits = pending;
      pending = [];
      if (hits.length > 0) {
        firstBatchEmitted = true;
      }
      return {
        hits,
        hitCount,
        fileCount: fileSet.size,
        elapsedMs: Date.now() - start,
        query: queryText,
        partialIndex: partial || this.indexManager.isPartialIndex(),
        done,
      };
    };

    for (const indexService of services) {
      const searcher = this.searchers.get(indexService.id) ?? new SearchService(indexService);
      for await (const batch of searcher.searchStreaming(queryText, {
        ...options,
        maxResults: perIndexLimit,
      })) {
        partial = partial || batch.partialIndex;

        for (const hit of batch.hits) {
          if (hitCount >= options.maxResults) {
            break;
          }

          const localPath = this.indexManager.mapHitPath(indexService.id, hit.path);
          if (isBinaryExtension(localPath)) {
            continue;
          }
          const key = `${localPath}:${hit.line}:${hit.matchStart}`;
          if (seenKeys.has(key)) {
            continue;
          }
          seenKeys.add(key);
          fileSet.add(localPath);
          hitCount++;

          pending.push({
            ...hit,
            path: hit.path,
            localPath,
            indexId: indexService.id,
            indexName: indexService.name,
          });

          if (pending.length >= batchThreshold()) {
            const out = emitBatch(false);
            if (out) {
              yield out;
              await yieldThrottle.maybeYield();
            }
          }
        }

        if (hitCount >= options.maxResults) {
          break;
        }
      }

      if (hitCount >= options.maxResults) {
        break;
      }
    }

    const tail = emitBatch(true);
    if (tail) {
      yield tail;
    } else {
      yield {
        hits: [],
        hitCount,
        fileCount: fileSet.size,
        elapsedMs: Date.now() - start,
        query: queryText,
        partialIndex: partial || this.indexManager.isPartialIndex(),
        done: true,
      };
    }
  }
}

export { getRelativePath };
