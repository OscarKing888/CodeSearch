import * as fs from 'fs';
import * as path from 'path';
import { IndexService } from '../index/IndexService';
import { DirectoryMapping, IndexMeta } from '../index/types';
import { configureBetterSqlite3 } from '../native/betterSqlite3';
import { resolveExtensionRoot } from '../native/extensionRoot';
import { SearchService } from '../search/SearchService';
import { SearchOptions } from '../types';
import {
  discoverIndexMetas,
  McpCliOptions,
  pathComparisonKey,
} from './discover';

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

function applyDirectoryMapping(
  filePath: string,
  mappings: readonly DirectoryMapping[],
  reverse: boolean
): string {
  const normalized = filePath.replace(/\\/g, '/');
  for (const mapping of mappings) {
    const sourceValue = reverse ? mapping.to : mapping.from;
    const targetValue = reverse ? mapping.from : mapping.to;
    let source = sourceValue.replace(/\\/g, '/');
    if (source.length > 1 && source.endsWith('/') && !/^[A-Za-z]:\/$/.test(source)) {
      source = source.slice(0, -1);
    }
    if (!source) {
      continue;
    }
    const pathKey = pathComparisonKey(normalized);
    const sourceKey = pathComparisonKey(source);
    const sourcePrefix = sourceKey.endsWith('/') ? sourceKey : `${sourceKey}/`;
    if (pathKey !== sourceKey && !pathKey.startsWith(sourcePrefix)) {
      continue;
    }
    const suffix = normalized.slice(source.length).replace(/^\//, '');
    const localTarget = targetValue.replace(/\\|\//g, path.sep);
    return suffix
      ? path.join(localTarget, suffix.replace(/\//g, path.sep))
      : path.normalize(localTarget);
  }
  return filePath;
}

export class McpIndexSession {
  private indexes = new Map<string, OpenedIndex>();
  private byDbPath = new Map<string, OpenedIndex>();
  private warnings: string[] = [];
  private workspaceRoots: string[] = [];

  private constructor(private options: McpCliOptions) {}

  static async create(options: McpCliOptions): Promise<McpIndexSession> {
    // Always pin nativeBinding for MCP: VSIX omits node_modules/better-sqlite3/build,
    // so we load from native-node/<platform-arch-abi>/ (system Node ABI).
    const extensionRoot = options.extensionRoot ?? resolveExtensionRoot(__dirname);
    configureBetterSqlite3(extensionRoot);

    const session = new McpIndexSession({ ...options });
    await session.reload();
    return session;
  }

  private async reload(): Promise<void> {
    const discovery = await discoverIndexMetas(this.options);
    const strict = Boolean(this.options.db || this.options.registry);
    const nextIndexes = new Map<string, OpenedIndex>();
    const nextByDbPath = new Map<string, OpenedIndex>();
    const warnings = [...discovery.warnings];

    try {
      for (const meta of discovery.metas) {
        try {
          const dbKey = pathComparisonKey(path.resolve(meta.dbPath));
          if (nextByDbPath.has(dbKey)) {
            continue;
          }
          if (nextIndexes.has(meta.id)) {
            throw new Error(`Duplicate index id "${meta.id}" in the selected workspace scope`);
          }
          const opened = await this.openMeta(meta);
          nextIndexes.set(opened.meta.id, opened);
          nextByDbPath.set(dbKey, opened);
        } catch (error) {
          if (strict) {
            throw error;
          }
          warnings.push(
            `Skipped unavailable index "${meta.name || meta.id}": ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    } catch (error) {
      for (const opened of nextIndexes.values()) {
        opened.service.dispose();
      }
      throw error;
    }

    for (const opened of this.indexes.values()) {
      opened.service.dispose();
    }
    this.indexes = nextIndexes;
    this.byDbPath = nextByDbPath;
    this.warnings = Array.from(new Set(warnings));
    this.workspaceRoots = discovery.workspaceRoots;
  }

  private async openMeta(meta: IndexMeta): Promise<OpenedIndex> {
    const dbPath = path.resolve(meta.dbPath);
    await fs.promises.access(dbPath, fs.constants.R_OK);

    const service = new IndexService(dbPath, {
      id: meta.id,
      name: meta.name,
      readOnly: true,
    });
    try {
      const roots = meta.rootDirs.length > 0 ? meta.rootDirs : [path.dirname(dbPath)];
      await service.initialize(roots);
      await service.startIndexing(false);
      return {
        meta: { ...meta, dbPath, readOnly: true },
        service,
        searcher: new SearchService(service),
      };
    } catch (error) {
      service.dispose();
      throw error;
    }
  }

  async setWorkspaceRoots(workspaceRoots: string[]): Promise<void> {
    if (this.options.db || this.options.allIndexes || workspaceRoots.length === 0) {
      return;
    }
    const nextRoots = workspaceRoots.map((root) => path.resolve(root));
    const currentKeys = this.workspaceRoots.map((root) => pathComparisonKey(root)).sort();
    const nextKeys = nextRoots.map((root) => pathComparisonKey(root)).sort();
    if (
      currentKeys.length === nextKeys.length &&
      currentKeys.every((key, index) => key === nextKeys[index])
    ) {
      return;
    }
    this.options = { ...this.options, workspaceRoots: nextRoots };
    try {
      await this.reload();
    } catch (error) {
      // Never retain indexes from the fallback cwd after a client supplied a
      // different authoritative root set.
      this.dispose();
      this.workspaceRoots = nextRoots;
      throw error;
    }
  }

  recordWarning(message: string): void {
    if (!this.warnings.includes(message)) {
      this.warnings.push(message);
    }
  }

  listWarnings(): string[] {
    return [...this.warnings];
  }

  getWorkspaceRoots(): string[] {
    return [...this.workspaceRoots];
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
    buildState: string;
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
        buildState: service.getIndexBuildState(),
        progressMessage: progress.message,
      };
    });
  }

  resolveIndexes(indexId?: string): OpenedIndex[] {
    if (!indexId) {
      if (this.indexes.size === 0) {
        throw new Error('No usable index is available. Call list_indexes and inspect its warnings.');
      }
      if (this.indexes.size > 1) {
        throw new Error(
          `Multiple indexes are available. Choose one with indexId: ${Array.from(
            this.indexes.keys()
          ).join(', ')}`
        );
      }
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
        `Unknown index "${indexId}". Available: ${
          Array.from(this.indexes.keys()).join(', ') || 'none'
        }`
      );
    }
    return [opened];
  }

  mapPath(opened: OpenedIndex, filePath: string): string {
    return applyDirectoryMapping(filePath, opened.meta.directoryMappings ?? [], false);
  }

  unmapPath(opened: OpenedIndex, filePath: string): string {
    return applyDirectoryMapping(filePath, opened.meta.directoryMappings ?? [], true);
  }

  dispose(): void {
    for (const opened of this.indexes.values()) {
      opened.service.dispose();
    }
    this.indexes.clear();
    this.byDbPath.clear();
  }
}
