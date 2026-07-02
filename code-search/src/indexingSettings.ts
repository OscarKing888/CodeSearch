export interface IndexingSettings {
  excludeGlobs: string[];
  includeGlobs: string[];
  maxFileSizeKB: number;
}

export const DEFAULT_INDEXING_SETTINGS: IndexingSettings = {
  excludeGlobs: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/bin/**',
    '**/obj/**',
    '**/.vs/**',
    '**/out/**',
  ],
  includeGlobs: ['**/*'],
  maxFileSizeKB: 2048,
};

export function getIndexingSettings(): IndexingSettings {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require('vscode') as typeof import('vscode');
    if (vscode?.workspace) {
      const cfg = vscode.workspace.getConfiguration('codeSearch');
      return {
        excludeGlobs: cfg.get<string[]>('excludeGlobs', DEFAULT_INDEXING_SETTINGS.excludeGlobs),
        includeGlobs: cfg.get<string[]>('includeGlobs', DEFAULT_INDEXING_SETTINGS.includeGlobs),
        maxFileSizeKB: cfg.get<number>('maxFileSizeKB', DEFAULT_INDEXING_SETTINGS.maxFileSizeKB),
      };
    }
  } catch {
    // CLI or non-VS Code environment
  }
  return DEFAULT_INDEXING_SETTINGS;
}
