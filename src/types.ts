export type IndexStatus = 'idle' | 'scanning' | 'indexing' | 'upToDate';

export interface IndexProgress {
  status: IndexStatus;
  queued: number;
  indexed: number;
  total: number;
  scanned?: number;
  message: string;
}

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  lineText: string;
  contextBefore: string[];
  contextAfter: string[];
  matchStart: number;
  matchEnd: number;
}

export interface SearchResult {
  hits: SearchHit[];
  hitCount: number;
  fileCount: number;
  elapsedMs: number;
  query: string;
  partialIndex: boolean;
}

export interface SearchStreamBatch extends SearchResult {
  hits: SearchHit[];
  done: boolean;
}

export interface QueryFilters {
  extInclude: string[];
  extExclude: string[];
  dirInclude: string[];
  dirExclude: string[];
  fileInclude: string[];
  fileExclude: string[];
  ageMinMs?: number;
  ageMaxMs?: number;
  contentInclude: string[];
  contentExclude: string[];
}

export interface ParsedQuery {
  raw: string;
  terms: string[];
  phrase: boolean;
  caseSensitive: boolean;
  filters: QueryFilters;
  filterOnly: boolean;
  loose: boolean;
  looseGap: number;
  multiWildcard: boolean;
  wildcardMaxTokens: number;
  wildcardSpanLines: boolean;
}

export interface SearchOptions {
  caseSensitive: boolean;
  phraseSearch: boolean;
  contextLines: number;
  maxResults: number;
  fuzzy: boolean;
  loose: boolean;
  looseGap: number;
}

export interface FileRecord {
  path: string;
  mtime: number;
  size: number;
  ext: string;
  dir: string;
  content: string;
}

export interface QueryHighlightSegment {
  text: string;
  kind: 'text' | 'filter-include' | 'filter-exclude' | 'term' | 'loose' | 'quoted';
}

export interface TokenSuggestion {
  token: string;
  freq: number;
}
