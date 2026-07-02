export interface IndexingSettings {
  excludeGlobs: string[];
  excludeDirNames: string[];
  excludeFileNames: string[];
  includeGlobs: string[];
  maxFileSizeKB: number;
}

export const DEFAULT_EXCLUDE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/bin/**',
  '**/obj/**',
  '**/.vs/**',
  '**/out/**',
  '**/.vscode/**',
  '**/.cursor/**',
  '**/Intermediate/**',
  '**/Saved/**',
  '**/Binaries/**',
  '**/DerivedDataCache/**',
];

export const DEFAULT_EXCLUDE_DIR_NAMES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'bin',
  'obj',
  'out',
  '.vs',
  '.vscode',
  '.cursor',
  '.idea',
  'Intermediate',
  'Saved',
  'Binaries',
  'DerivedDataCache',
  'DerivedData',
];

export const DEFAULT_EXCLUDE_FILE_NAMES = [
  '*.pdb',
  '*.obj',
  '*.o',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.cache',
  '*.min.js',
];

export const DEFAULT_INDEXING_SETTINGS: IndexingSettings = {
  excludeGlobs: DEFAULT_EXCLUDE_GLOBS,
  excludeDirNames: DEFAULT_EXCLUDE_DIR_NAMES,
  excludeFileNames: DEFAULT_EXCLUDE_FILE_NAMES,
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
        excludeDirNames: cfg.get<string[]>('excludeDirNames', DEFAULT_INDEXING_SETTINGS.excludeDirNames),
        excludeFileNames: cfg.get<string[]>('excludeFileNames', DEFAULT_INDEXING_SETTINGS.excludeFileNames),
        includeGlobs: cfg.get<string[]>('includeGlobs', DEFAULT_INDEXING_SETTINGS.includeGlobs),
        maxFileSizeKB: cfg.get<number>('maxFileSizeKB', DEFAULT_INDEXING_SETTINGS.maxFileSizeKB),
      };
    }
  } catch {
    // CLI or non-VS Code environment
  }
  return DEFAULT_INDEXING_SETTINGS;
}
