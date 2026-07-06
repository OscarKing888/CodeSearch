import * as vscode from 'vscode';

export interface SourceSearchConfig {
  excludeGlobs: string[];
  includeGlobs: string[];
  contextLines: number;
  phraseSearchDefault: boolean;
  autoOpenSingleHit: boolean;
  maxResults: number;
  indexOnStartup: boolean;
  maxFileSizeKB: number;
  fuzzySearchDefault: boolean;
  looseGapDefault: number;
}

export function getConfig(): SourceSearchConfig {
  const cfg = vscode.workspace.getConfiguration('codeSearch');
  return {
    excludeGlobs: cfg.get<string[]>('excludeGlobs', []),
    includeGlobs: cfg.get<string[]>('includeGlobs', ['**/*']),
    contextLines: cfg.get<number>('contextLines', 1),
    phraseSearchDefault: cfg.get<boolean>('phraseSearchDefault', true),
    autoOpenSingleHit: cfg.get<boolean>('autoOpenSingleHit', false),
    maxResults: cfg.get<number>('maxResults', 10000),
    indexOnStartup: cfg.get<boolean>('indexOnStartup', true),
    maxFileSizeKB: cfg.get<number>('maxFileSizeKB', 2048),
    fuzzySearchDefault: cfg.get<boolean>('fuzzySearchDefault', false),
    looseGapDefault: cfg.get<number>('looseGapDefault', 10),
  };
}

export function workspaceHash(workspaceFolders: readonly vscode.WorkspaceFolder[]): string {
  const key = workspaceFolders.map((f) => f.uri.fsPath).sort().join('|');
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16);
}
