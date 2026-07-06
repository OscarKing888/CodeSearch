export interface IndexingSettings {
  excludeGlobs: string[];
  excludeDirNames: string[];
  excludeFileNames: string[];
  includeGlobs: string[];
  maxFileSizeKB: number;
  indexThreads: number;
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
  '**/DerivedData/**',
  '**/Build/**',
  '**/Staging/**',
  '**/ShaderCache/**',
  '**/ShaderDebugInfo/**',
  '**/AutomationReports/**',
  '**/Packaging/**',
  '**/enc_temp_folder/**',
  '**/WebCache/**',
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
  'Build',
  'Staging',
  'ShaderCache',
  'ShaderDebugInfo',
  'AutomationReports',
  'Packaging',
  'enc_temp_folder',
  'WebCache',
  'Content',
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
  '*.uasset',
  '*.umap',
  '*.ubulk',
  '*.uexp',
  '*.ucas',
  '*.utoc',
  '*.uptodate',
];

export const DEFAULT_INDEXING_SETTINGS: IndexingSettings = {
  excludeGlobs: DEFAULT_EXCLUDE_GLOBS,
  excludeDirNames: DEFAULT_EXCLUDE_DIR_NAMES,
  excludeFileNames: DEFAULT_EXCLUDE_FILE_NAMES,
  includeGlobs: ['**/*'],
  maxFileSizeKB: 2048,
  indexThreads: 0,
};

function mergeDefaultPatterns(configured: string[] | undefined, defaults: string[]): string[] {
  const base = configured && configured.length > 0 ? [...configured] : [...defaults];
  const seen = new Set(base);
  for (const item of defaults) {
    if (!seen.has(item)) {
      seen.add(item);
      base.push(item);
    }
  }
  return base;
}

export function getIndexingSettings(): IndexingSettings {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require('vscode') as typeof import('vscode');
    if (vscode?.workspace) {
      const cfg = vscode.workspace.getConfiguration('codeSearch');
      const configuredGlobs = cfg.get<string[]>('excludeGlobs');
      const configuredDirNames = cfg.get<string[]>('excludeDirNames');
      const configuredFileNames = cfg.get<string[]>('excludeFileNames');
      return {
        excludeGlobs: mergeDefaultPatterns(configuredGlobs, DEFAULT_EXCLUDE_GLOBS),
        excludeDirNames: mergeDefaultPatterns(configuredDirNames, DEFAULT_EXCLUDE_DIR_NAMES),
        excludeFileNames: mergeDefaultPatterns(configuredFileNames, DEFAULT_EXCLUDE_FILE_NAMES),
        includeGlobs: cfg.get<string[]>('includeGlobs', DEFAULT_INDEXING_SETTINGS.includeGlobs),
        maxFileSizeKB: cfg.get<number>('maxFileSizeKB', DEFAULT_INDEXING_SETTINGS.maxFileSizeKB),
        indexThreads: cfg.get<number>('indexThreads', DEFAULT_INDEXING_SETTINGS.indexThreads),
      };
    }
  } catch {
    // CLI or non-VS Code environment
  }
  return DEFAULT_INDEXING_SETTINGS;
}
