import * as path from 'path';
import { SearchOptions } from '../types';
import { pathComparisonKey } from './discover';
import { DEFAULT_MCP_SEARCH_OPTIONS, McpIndexSession, OpenedIndex } from './session';

export type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function toolError(message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function toolJson(data: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

export function mergeSearchOptions(partial?: Partial<SearchOptions>): SearchOptions {
  const defined = Object.fromEntries(
    Object.entries(partial ?? {}).filter(([, value]) => value !== undefined)
  ) as Partial<SearchOptions>;
  return {
    ...DEFAULT_MCP_SEARCH_OPTIONS,
    ...defined,
    maxResults: Math.min(
      Math.max(defined.maxResults ?? DEFAULT_MCP_SEARCH_OPTIONS.maxResults, 1),
      10000
    ),
    contextLines: Math.min(
      Math.max(defined.contextLines ?? DEFAULT_MCP_SEARCH_OPTIONS.contextLines, 0),
      10
    ),
    looseGap: Math.min(
      Math.max(defined.looseGap ?? DEFAULT_MCP_SEARCH_OPTIONS.looseGap, 1),
      500
    ),
  };
}

function resolveFileInIndex(
  opened: OpenedIndex,
  filePath: string,
  session: McpIndexSession
): { indexedPath: string; mappedPath: string } | undefined {
  const db = opened.service.getDatabase();
  if (!db) {
    return undefined;
  }

  // localPath is the normal value returned to agents. Reverse directory
  // mappings first, then query indexed paths directly; never scan every row.
  const reversed = session.unmapPath(opened, filePath);
  const rawCandidates = [reversed, path.resolve(reversed), filePath, path.resolve(filePath)];
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const candidate of rawCandidates) {
    for (const variant of [candidate, candidate.replace(/\\/g, '/')]) {
      // Keep separator variants for the exact SQLite lookup. pathComparisonKey
      // intentionally treats them as equivalent, while the BINARY path index does not.
      const key = process.platform === 'win32' ? variant.toLowerCase() : variant;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(variant);
      }
    }
  }

  // The exact lookup uses the UNIQUE BINARY path index. This is the common
  // path for localPath values returned by search_code.
  const stmt = db.prepare('SELECT path FROM files WHERE path = ?');
  for (const candidate of candidates) {
    const row = stmt.get(candidate) as { path: string } | undefined;
    if (row) {
      return {
        indexedPath: row.path,
        mappedPath: session.mapPath(opened, row.path),
      };
    }
  }

  // Windows paths are case-insensitive. Keep this compatibility fallback last
  // because COLLATE NOCASE may not use an older database's BINARY path index.
  if (process.platform === 'win32') {
    const insensitive = db.prepare('SELECT path FROM files WHERE path = ? COLLATE NOCASE');
    for (const candidate of candidates) {
      const row = insensitive.get(candidate) as { path: string } | undefined;
      if (row) {
        return {
          indexedPath: row.path,
          mappedPath: session.mapPath(opened, row.path),
        };
      }
    }
  }

  return undefined;
}

export interface SearchCodeArgs {
  query: string;
  indexId?: string;
  caseSensitive?: boolean;
  phraseSearch?: boolean;
  contextLines?: number;
  maxResults?: number;
  fuzzy?: boolean;
  loose?: boolean;
  looseGap?: number;
}

export interface ReadIndexedFileArgs {
  path: string;
  indexId?: string;
  startLine?: number;
  endLine?: number;
  maxChars?: number;
}

export interface FindHeaderSourceArgs {
  path: string;
  indexId?: string;
}

export class McpToolHandlers {
  constructor(private session: McpIndexSession) {}

  listIndexes(): McpToolResult {
    return toolJson({
      indexes: this.session.listIndexes(),
      workspaceRoots: this.session.getWorkspaceRoots(),
      warnings: this.session.listWarnings(),
      note: 'Results come from Ace Code Search SQLite index snapshots, not a live filesystem walk.',
    });
  }

  searchCode(args: SearchCodeArgs): McpToolResult {
    if (!args.query || !args.query.trim()) {
      return toolError('query is required');
    }

    try {
      const targets = this.session.resolveIndexes(args.indexId);
      const options = mergeSearchOptions({
        caseSensitive: args.caseSensitive,
        phraseSearch: args.phraseSearch,
        contextLines: args.contextLines,
        maxResults: args.maxResults,
        fuzzy: args.fuzzy,
        loose: args.loose,
        looseGap: args.looseGap,
      });

      const hits: Array<{
        path: string;
        localPath: string;
        indexId: string;
        indexName: string;
        line: number;
        column: number;
        lineText: string;
        contextBefore: string[];
        contextAfter: string[];
        matchStart: number;
        matchEnd: number;
      }> = [];
      const seen = new Set<string>();
      let partialIndex = false;
      const start = Date.now();

      for (const opened of targets) {
        const result = opened.searcher.search(args.query, {
          ...options,
          // A sparse first index must not consume an averaged quota and cause
          // the combined result to under-fill maxResults.
          maxResults: options.maxResults,
        });
        partialIndex = partialIndex || result.partialIndex;
        for (const hit of result.hits) {
          const localPath = this.session.mapPath(opened, hit.path);
          const key = `${pathComparisonKey(localPath)}:${hit.line}:${hit.matchStart}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          hits.push({
            path: hit.path,
            localPath,
            indexId: opened.meta.id,
            indexName: opened.meta.name,
            line: hit.line,
            column: hit.column,
            lineText: hit.lineText,
            contextBefore: hit.contextBefore,
            contextAfter: hit.contextAfter,
            matchStart: hit.matchStart,
            matchEnd: hit.matchEnd,
          });
          if (hits.length >= options.maxResults) {
            break;
          }
        }
        if (hits.length >= options.maxResults) {
          break;
        }
      }

      hits.sort((a, b) => {
        if (a.localPath !== b.localPath) {
          return a.localPath.localeCompare(b.localPath);
        }
        return a.line - b.line;
      });

      const limited = hits.slice(0, options.maxResults);
      return toolJson({
        query: args.query,
        hitCount: limited.length,
        fileCount: new Set(limited.map((h) => h.localPath)).size,
        elapsedMs: Date.now() - start,
        partialIndex,
        hits: limited,
        note: 'Paths and content are from the indexed snapshot; localPath applies directory mappings when present.',
      });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }

  readIndexedFile(args: ReadIndexedFileArgs): McpToolResult {
    if (!args.path) {
      return toolError('path is required');
    }

    try {
      const targets = this.session.resolveIndexes(args.indexId);
      const startLine = Math.max(args.startLine ?? 1, 1);
      const endLine = Math.max(args.endLine ?? startLine + 199, startLine);
      const maxChars = Math.min(Math.max(args.maxChars ?? 100_000, 1), 500_000);

      for (const opened of targets) {
        const resolved = resolveFileInIndex(opened, args.path, this.session);
        if (!resolved) {
          continue;
        }

        const db = opened.service.getDatabase();
        if (!db) {
          continue;
        }
        const row = db
          .prepare('SELECT path, content, mtime, size FROM files WHERE path = ?')
          .get(resolved.indexedPath) as
          | { path: string; content: string; mtime: number; size: number }
          | undefined;
        if (!row) {
          continue;
        }

        const lines = row.content.split(/\r?\n/);
        const slice = lines.slice(startLine - 1, endLine);
        let text = slice.join('\n');
        let truncated = false;
        if (text.length > maxChars) {
          text = text.slice(0, maxChars);
          truncated = true;
        }

        return toolJson({
          indexId: opened.meta.id,
          indexName: opened.meta.name,
          path: row.path,
          localPath: resolved.mappedPath,
          startLine,
          endLine: Math.min(endLine, lines.length),
          totalLines: lines.length,
          mtime: row.mtime,
          size: row.size,
          truncated,
          content: text,
          note: 'Content is from the index snapshot, which may lag the current file on disk.',
        });
      }

      return toolError(
        `File not found in index: ${args.path}` +
          (args.indexId ? ` (index ${args.indexId})` : '')
      );
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }

  findHeaderSource(args: FindHeaderSourceArgs): McpToolResult {
    if (!args.path) {
      return toolError('path is required');
    }

    try {
      const targets = this.session.resolveIndexes(args.indexId);
      const results: Array<{
        indexId: string;
        indexName: string;
        inputPath: string;
        indexedPath: string;
        counterparts: Array<{ path: string; localPath: string }>;
      }> = [];

      for (const opened of targets) {
        const mapPath = (p: string) => this.session.mapPath(opened, p);
        const resolved = resolveFileInIndex(opened, args.path, this.session);
        const lookupPath = resolved?.indexedPath ?? args.path;
        const counterparts = opened.service
          .findHeaderSourceCounterparts(lookupPath)
          .map((counterpart) => ({
            path: counterpart,
            localPath: mapPath(counterpart),
          }));

        if (counterparts.length > 0 || resolved) {
          results.push({
            indexId: opened.meta.id,
            indexName: opened.meta.name,
            inputPath: args.path,
            indexedPath: lookupPath,
            counterparts,
          });
        }
      }

      if (results.length === 0) {
        return toolError(`No header/source counterparts found for: ${args.path}`);
      }

      return toolJson({
        results,
        note: 'Counterparts must exist in the index; there is no filesystem fallback.',
      });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }
}
