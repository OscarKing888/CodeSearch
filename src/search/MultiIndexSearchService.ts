import { IndexManager } from '../index/IndexManager';
import { isBinaryExtension } from '../index/FileScanner';
import { SearchService, getRelativePath } from './SearchService';
import { SearchHit, SearchOptions, SearchResult } from '../types';

export interface ExtendedSearchHit extends SearchHit {
  indexId: string;
  indexName: string;
  localPath: string;
}

export interface MultiSearchResult extends SearchResult {
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
}

export { getRelativePath };
