import * as path from 'path';

export const HEADER_EXTS = ['h', 'hpp', 'hxx'] as const;
export const SOURCE_EXTS = ['c', 'cpp', 'cc', 'cxx'] as const;

export interface FileCandidate {
  path: string;
  ext: string;
  dir: string;
}

export function normalizePathSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

export function stemFromPath(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function extFromPath(filePath: string): string {
  return path.extname(filePath).replace(/^\./, '').toLowerCase();
}

export function isHeaderExt(ext: string): boolean {
  return (HEADER_EXTS as readonly string[]).includes(ext);
}

export function isSourceExt(ext: string): boolean {
  return (SOURCE_EXTS as readonly string[]).includes(ext);
}

export function isHeaderSourceFile(filePath: string): boolean {
  const ext = extFromPath(filePath);
  return isHeaderExt(ext) || isSourceExt(ext);
}

export function counterpartExts(ext: string): readonly string[] {
  if (isHeaderExt(ext)) {
    return SOURCE_EXTS;
  }
  if (isSourceExt(ext)) {
    return HEADER_EXTS;
  }
  return [];
}

export function alternatePublicPrivateDirs(dir: string): string[] {
  const normalized = normalizePathSlash(dir);
  const alts: string[] = [];
  if (/\/Public(\/|$)/.test(normalized)) {
    alts.push(normalized.replace(/\/Public(\/|$)/, '/Private$1'));
  }
  if (/\/Private(\/|$)/.test(normalized)) {
    alts.push(normalized.replace(/\/Private(\/|$)/, '/Public$1'));
  }
  return alts.filter((d) => d !== normalized);
}

export interface CandidateScore {
  tier: number;
  extRank: number;
  dirDistance: number;
}

function extPriority(currentExt: string, counterpartExt: string): number {
  if (isSourceExt(currentExt)) {
    const order = ['h', 'hpp', 'hxx'];
    const idx = order.indexOf(counterpartExt);
    return idx === -1 ? 999 : idx;
  }
  const order = ['cpp', 'cc', 'cxx', 'c'];
  const idx = order.indexOf(counterpartExt);
  return idx === -1 ? 999 : idx;
}

function dirPathDistance(a: string, b: string): number {
  const aParts = normalizePathSlash(a).split('/');
  const bParts = normalizePathSlash(b).split('/');
  let common = 0;
  while (common < aParts.length && common < bParts.length && aParts[common] === bParts[common]) {
    common++;
  }
  return aParts.length - common + (bParts.length - common);
}

export function scoreCandidate(
  currentDir: string,
  currentExt: string,
  candidate: FileCandidate
): CandidateScore {
  const normalizedCurrentDir = normalizePathSlash(currentDir);
  const normalizedCandidateDir = normalizePathSlash(candidate.dir);

  let tier: number;
  if (normalizedCandidateDir === normalizedCurrentDir) {
    tier = 0;
  } else if (alternatePublicPrivateDirs(normalizedCurrentDir).includes(normalizedCandidateDir)) {
    tier = 1;
  } else {
    tier = 2;
  }

  return {
    tier,
    extRank: extPriority(currentExt, candidate.ext),
    dirDistance: tier === 2 ? dirPathDistance(normalizedCurrentDir, normalizedCandidateDir) : 0,
  };
}

export function toFileCandidate(filePath: string): FileCandidate {
  return {
    path: filePath,
    ext: extFromPath(filePath),
    dir: normalizePathSlash(path.dirname(filePath)),
  };
}

export function rankCounterparts(currentPath: string, candidates: FileCandidate[]): string[] {
  const currentDir = normalizePathSlash(path.dirname(currentPath));
  const currentExt = extFromPath(currentPath);
  const currentStem = stemFromPath(currentPath);

  const scored = candidates
    .filter((c) => stemFromPath(c.path) === currentStem && c.path !== currentPath)
    .map((c) => ({
      path: c.path,
      ...scoreCandidate(currentDir, currentExt, c),
    }));

  scored.sort((a, b) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    if (a.extRank !== b.extRank) {
      return a.extRank - b.extRank;
    }
    return a.dirDistance - b.dirDistance;
  });

  return scored.map((s) => s.path);
}

export function topTiedCounterparts(currentPath: string, rankedPaths: string[]): string[] {
  if (rankedPaths.length <= 1) {
    return rankedPaths;
  }

  const currentDir = normalizePathSlash(path.dirname(currentPath));
  const currentExt = extFromPath(currentPath);
  const first = scoreCandidate(currentDir, currentExt, toFileCandidate(rankedPaths[0]));
  const tied = [rankedPaths[0]];

  for (let i = 1; i < rankedPaths.length; i++) {
    const score = scoreCandidate(currentDir, currentExt, toFileCandidate(rankedPaths[i]));
    if (
      score.tier === first.tier &&
      score.extRank === first.extRank &&
      score.dirDistance === first.dirDistance
    ) {
      tied.push(rankedPaths[i]);
    } else {
      break;
    }
  }

  return tied;
}
