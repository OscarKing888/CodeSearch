import * as path from 'path';
import { minimatch } from 'minimatch';
import { IndexingSettings } from '../indexingSettings';

export interface PerIndexExcludes {
  excludeDirNames?: string[];
  excludeFileNames?: string[];
  excludeGlobs?: string[];
}

const MINIMATCH_OPTS = { dot: true, nocase: process.platform === 'win32' };

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function matchesName(name: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }
  return patterns.some((pattern) => minimatch(name, pattern, MINIMATCH_OPTS));
}

export function matchesPathGlobs(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }
  const normalized = normalizePath(filePath);
  return patterns.some((pattern) => minimatch(normalized, pattern, MINIMATCH_OPTS));
}

export function isExcludedDir(dirName: string, settings: Pick<IndexingSettings, 'excludeDirNames'>): boolean {
  return matchesName(dirName, settings.excludeDirNames);
}

export function isExcludedFile(
  filePath: string,
  settings: Pick<IndexingSettings, 'excludeFileNames' | 'excludeGlobs'>
): boolean {
  const basename = path.basename(filePath);
  if (matchesName(basename, settings.excludeFileNames)) {
    return true;
  }
  return matchesPathGlobs(filePath, settings.excludeGlobs);
}

export function isPathIgnored(filePath: string, settings: IndexingSettings): boolean {
  const normalized = normalizePath(filePath);
  if (matchesPathGlobs(normalized, settings.excludeGlobs)) {
    return true;
  }

  const segments = normalized.split('/').filter(Boolean);
  for (const segment of segments) {
    if (matchesName(segment, settings.excludeDirNames)) {
      return true;
    }
  }

  const basename = path.basename(filePath);
  return matchesName(basename, settings.excludeFileNames);
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
