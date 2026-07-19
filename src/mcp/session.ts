import * as fs from 'fs';
import * as path from 'path';
import { IndexService } from '../index/IndexService';
import { mapFilePath } from '../index/IndexRegistry';
import { IndexMeta } from '../index/types';
import { configureBetterSqlite3 } from '../native/betterSqlite3';
import { SearchService } from '../search/SearchService';
import { SearchOptions } from '../types';
import { McpCliOptions, resolveIndexMetas } from './discover';

export const DEFAULT_MCP_SEARCH_OPTIONS: SearchOptions = {
  caseSensitive: false,
  phraseSearch: true,
  contextLines: 1,
  maxResults: 50,
  fuzzy: false,
  loose: false,
  looseGap: 10,
};

export interface OpenedIndex {
  meta: IndexMeta;
  service: IndexService;
  searcher: SearchService;
}

export class McpIndexSession {
  private indexes = new Map<string, OpenedIndex>();
  private byDbPath = new Map<string, OpenedIndex>();

  static async create(options: McpCliOptions): Promise<McpIndexSession> {
    // Only pin a nativeBinding when the caller provides an extension root.
    // Otherwise let better-sqlite3 load the system Node build from node_modules
    // (required for CLI/MCP after Electron rebuilds overwrite that binary).
    if (options.extensionRoot) {
      configureBetterSqlite3(options.extensionRoot);
    }

    const session = new McpIndexSession();
    const metas = await resolveIndexMetas(options);
    if (metas.length === 0) {
      throw new Error('Registry contains no indexes.');
    }

    for (const meta of metas) {
      await session.openMeta(meta);
    }

    return session;
  }

  private async openMeta(meta: IndexMeta): Promise<OpenedIndex> {
    const dbPath = path.resolve(meta.dbPath);
    const existing = this.byDbPath.get(dbPath.toLowerCase());
    if (existing) {
      return existing;
    }

    await fs.promises.access(dbPath, fs.constants.R_OK);

    const service = new IndexService(dbPath, {
      id: meta.id,
      name: meta.name,
      readOnly: true,
    });
    const roots =
      meta.rootDirs.length > 0 ? meta.rootDirs : [path.dirname(dbPath)];
    await service.initialize(roots);
    await service.startIndexing(false);

    const opened: OpenedIndex = {
      meta: { ...meta, dbPath, readOnly: true },
      service,
      searcher: new SearchService(service),
    };
    this.indexes.set(meta.id, opened);
    this.byDbPath.set(dbPath.toLowerCase(), opened);
    return opened;
  }

  listIndexes(): Array<{
    id: string;
    name: string;
    dbPath: string;
    rootDirs: string[];
    readOnly: boolean;
    directoryMappings: IndexMeta['directoryMappings'];
    tokenCount: number;
    partialIndex: boolean;
    progressMessage: string;
  }> {
    return Array.from(this.indexes.values()).map(({ meta, service }) => {
      const progress = service.getProgress();
      return {
        id: meta.id,
        name: meta.name,
        dbPath: meta.dbPath,
        rootDirs: meta.rootDirs,
        readOnly: true,
        directoryMappings: meta.directoryMappings,
        tokenCount: service.getTokenCount(),
        partialIndex: service.isPartialIndex(),
        progressMessage: progress.message,
      };
    });
  }

  resolveIndexes(indexId?: string): OpenedIndex[] {
    if (!indexId) {
      return Array.from(this.indexes.values());
    }
    const opened = this.indexes.get(indexId);
    if (!opened) {
      const byName = Array.from(this.indexes.values()).filter(
        (item) => item.meta.name.toLowerCase() === indexId.toLowerCase()
      );
      if (byName.length === 1) {
        return byName;
      }
      if (byName.length > 1) {
        throw new Error(
          `Ambiguous index name "${indexId}". Use index id instead: ${byName
            .map((i) => i.meta.id)
            .join(', ')}`
        );
      }
      throw new Error(
        `Unknown index "${indexId}". Available: ${Array.from(this.indexes.keys()).join(', ') || 'none'}`
      );
    }
    return [opened];
  }

  mapPath(opened: OpenedIndex, filePath: string): string {
    return mapFilePath(filePath, opened.meta.directoryMappings ?? []);
  }

  dispose(): void {
    for (const opened of this.indexes.values()) {
      opened.service.dispose();
    }
    this.indexes.clear();
    this.byDbPath.clear();
  }
}
