export interface DirectoryMapping {
  from: string;
  to: string;
}

export interface IndexMeta {
  id: string;
  name: string;
  dbPath: string;
  rootDirs: string[];
  readOnly: boolean;
  directoryMappings: DirectoryMapping[];
  workspaceHashes: string[];
  createdAt: number;
  updatedAt: number;
}

export interface IndexRegistryData {
  indexes: IndexMeta[];
}

export interface AutocreateConfig {
  indexLocation?: string;
  excludeList?: string[];
  includeList?: string[];
  ignoreGlobalExclusions?: boolean;
  ignoreGlobalInclusions?: boolean;
  readOnly?: boolean;
  name?: string;
}

export interface SearchTabState {
  id: string;
  label: string;
  query: string;
  locked: boolean;
}

export interface MappedSearchHit {
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
}
