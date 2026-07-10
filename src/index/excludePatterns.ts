import * as path from 'path';
import { Minimatch } from 'minimatch';
import { IndexingSettings } from '../indexingSettings';

export interface PerIndexExcludes {
  excludeDirNames?: string[];
  excludeFileNames?: string[];
  excludeGlobs?: string[];
}

const MINIMATCH_OPTS = {
  dot: true,
  nocase: process.platform === 'win32',
  magicalBraces: true,
} as const;

const matcherCache = new WeakMap<object, IndexingMatcher>();
const nameMatcherCache = new WeakMap<string[], CompiledNameMatcher>();
const globMatcherCache = new WeakMap<string[], Minimatch[]>();

export function normalizeMatchPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function normalizeName(name: string): string {
  return MINIMATCH_OPTS.nocase ? name.toLowerCase() : name;
}

class CompiledNameMatcher {
  private readonly exactNames = new Set<string>();
  private readonly patterns: Minimatch[] = [];

  constructor(patterns: readonly string[]) {
    for (const pattern of patterns) {
      const compiled = new Minimatch(pattern, MINIMATCH_OPTS);
      if (compiled.hasMagic()) {
        this.patterns.push(compiled);
      } else {
        this.exactNames.add(normalizeName(pattern));
      }
    }
  }

  matches(name: string): boolean {
    if (this.exactNames.has(normalizeName(name))) {
      return true;
    }
    return this.patterns.some((pattern) => pattern.match(name));
  }
}

function compileGlobs(patterns: readonly string[]): Minimatch[] {
  return patterns.map((pattern) => new Minimatch(pattern, MINIMATCH_OPTS));
}

function matchesCompiledPath(filePath: string, patterns: readonly Minimatch[]): boolean {
  const normalized = normalizeMatchPath(filePath);
  return patterns.some((pattern) => pattern.match(normalized));
}

/**
 * Precompiled include/exclude rules shared by scanning and file watching.
 * Keep one instance for a settings object so multi-million-file scans do not
 * recreate minimatch state for every directory entry.
 */
export class IndexingMatcher {
  private readonly excludedDirs: CompiledNameMatcher;
  private readonly excludedFiles: CompiledNameMatcher;
  private readonly excludedGlobs: Minimatch[];
  private readonly includedGlobs: Minimatch[];

  constructor(settings: IndexingSettings) {
    this.excludedDirs = new CompiledNameMatcher(settings.excludeDirNames);
    this.excludedFiles = new CompiledNameMatcher(settings.excludeFileNames);
    this.excludedGlobs = compileGlobs(settings.excludeGlobs);
    this.includedGlobs = compileGlobs(settings.includeGlobs);
  }

  isExcludedDir(dirName: string): boolean {
    return this.excludedDirs.matches(dirName);
  }

  isExcludedFile(filePath: string): boolean {
    return (
      this.excludedFiles.matches(path.basename(filePath)) ||
      this.matchesExcludeGlob(filePath)
    );
  }

  matchesExcludeGlob(filePath: string): boolean {
    return matchesCompiledPath(filePath, this.excludedGlobs);
  }

  matchesIncludeGlob(filePath: string): boolean {
    return matchesCompiledPath(filePath, this.includedGlobs);
  }

  isPathIgnored(filePath: string, isDirectory = false): boolean {
    const normalized = normalizeMatchPath(filePath);
    if (
      this.matchesExcludeGlob(normalized) ||
      (isDirectory && this.matchesExcludeGlob(`${normalized}/`))
    ) {
      return true;
    }

    const segments = normalized.split('/').filter(Boolean);
    if (segments.some((segment) => this.excludedDirs.matches(segment))) {
      return true;
    }

    return this.excludedFiles.matches(path.basename(filePath));
  }
}

export function getIndexingMatcher(settings: IndexingSettings): IndexingMatcher {
  const key = settings as object;
  let matcher = matcherCache.get(key);
  if (!matcher) {
    matcher = new IndexingMatcher(settings);
    matcherCache.set(key, matcher);
  }
  return matcher;
}

export function matchesName(name: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }
  let matcher = nameMatcherCache.get(patterns);
  if (!matcher) {
    matcher = new CompiledNameMatcher(patterns);
    nameMatcherCache.set(patterns, matcher);
  }
  return matcher.matches(name);
}

export function matchesPathGlobs(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }
  let compiled = globMatcherCache.get(patterns);
  if (!compiled) {
    compiled = compileGlobs(patterns);
    globMatcherCache.set(patterns, compiled);
  }
  return matchesCompiledPath(filePath, compiled);
}

export function isExcludedDir(dirName: string, settings: Pick<IndexingSettings, 'excludeDirNames'>): boolean {
  return matchesName(dirName, settings.excludeDirNames);
}

export function isExcludedFile(
  filePath: string,
  settings: Pick<IndexingSettings, 'excludeFileNames' | 'excludeGlobs'>
): boolean {
  if (isFullIndexingSettings(settings)) {
    return getIndexingMatcher(settings).isExcludedFile(filePath);
  }
  const basename = path.basename(filePath);
  return (
    matchesName(basename, settings.excludeFileNames) ||
    matchesPathGlobs(filePath, settings.excludeGlobs)
  );
}

export function isPathIgnored(filePath: string, settings: IndexingSettings): boolean {
  return getIndexingMatcher(settings).isPathIgnored(filePath);
}

function isFullIndexingSettings(settings: object): settings is IndexingSettings {
  return (
    'includeGlobs' in settings &&
    'maxFileSizeKB' in settings &&
    'indexThreads' in settings
  );
}

export function mergeIndexingSettings(
  global: IndexingSettings,
  perIndex?: PerIndexExcludes
): IndexingSettings {
  if (!perIndex) {
    return global;
  }
  return {
    ...global,
    excludeDirNames: [...global.excludeDirNames, ...(perIndex.excludeDirNames ?? [])],
    excludeFileNames: [...global.excludeFileNames, ...(perIndex.excludeFileNames ?? [])],
    excludeGlobs: [...global.excludeGlobs, ...(perIndex.excludeGlobs ?? [])],
  };
}

export function parsePatternLines(text: string): string[] {
  const patterns: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    patterns.push(trimmed);
  }
  return patterns;
}

export function formatPatternLines(patterns: string[] | undefined): string {
  return (patterns ?? []).join('\n');
}
