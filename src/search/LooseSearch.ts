import { fuzzyMatch } from './FuzzyMatch';

export interface TokenPosition {
  token: string;
  line: number;
  column: number;
  tokenIndex: number;
  lineText: string;
  charStart: number;
  charEnd: number;
}

export function tokenizeContent(content: string): TokenPosition[] {
  const tokens: TokenPosition[] = [];
  const lines = content.split(/\r?\n/);
  let tokenIndex = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const regex = /[a-zA-Z_][a-zA-Z0-9_]*/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      tokens.push({
        token: match[0],
        line: lineIdx + 1,
        column: match.index + 1,
        tokenIndex: tokenIndex++,
        lineText: line,
        charStart: match.index,
        charEnd: match.index + match[0].length,
      });
    }
  }
  return tokens;
}

export interface LooseHit {
  line: number;
  column: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

/**
 * Find loose phrase matches: all terms within maxGap tokens, any order.
 */
export function findLooseHits(
  content: string,
  terms: string[],
  maxGap: number,
  caseSensitive: boolean,
  fuzzy: boolean
): LooseHit[] {
  if (terms.length === 0) {
    return [];
  }

  const tokens = tokenizeContent(content);
  if (tokens.length === 0) {
    return [];
  }

  const termMatches: TokenPosition[][] = terms.map((term) =>
    tokens.filter((t) => matchesTerm(t.token, term, caseSensitive, fuzzy))
  );

  if (termMatches.some((m) => m.length === 0)) {
    return [];
  }

  const hits: LooseHit[] = [];
  const seen = new Set<string>();

  if (terms.length === 1) {
    for (const pos of termMatches[0]) {
      const key = `${pos.line}:${pos.charStart}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({
          line: pos.line,
          column: pos.column,
          lineText: pos.lineText,
          matchStart: pos.charStart,
          matchEnd: pos.charEnd,
        });
      }
    }
    return hits;
  }

  // Try each token position as anchor for first matched term
  for (const anchor of termMatches[0]) {
    const matched = matchLooseGroup(termMatches, anchor.tokenIndex, maxGap);
    if (matched) {
      const first = matched[0];
      const key = `${first.line}:${first.charStart}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({
          line: first.line,
          column: first.column,
          lineText: first.lineText,
          matchStart: first.charStart,
          matchEnd: first.charEnd,
        });
      }
    }
  }

  return hits;
}

function matchesTerm(
  token: string,
  term: string,
  caseSensitive: boolean,
  fuzzy: boolean
): boolean {
  const a = caseSensitive ? token : token.toLowerCase();
  const b = caseSensitive ? term : term.toLowerCase();
  if (a === b) {
    return true;
  }
  if (term.includes('*')) {
    const regex = new RegExp(
      '^' + term.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      caseSensitive ? '' : 'i'
    );
    return regex.test(token);
  }
  if (fuzzy) {
    return fuzzyMatch(term, token, caseSensitive);
  }
  return false;
}

function matchLooseGroup(
  termMatches: TokenPosition[][],
  anchorIndex: number,
  maxGap: number
): TokenPosition[] | null {
  const used = new Set<number>();
  const result: TokenPosition[] = [];

  for (let ti = 0; ti < termMatches.length; ti++) {
    const candidates = termMatches[ti];
    let best: TokenPosition | null = null;
    let bestDist = Infinity;

    for (const pos of candidates) {
      if (used.has(pos.tokenIndex)) {
        continue;
      }
      const dist = Math.abs(pos.tokenIndex - anchorIndex);
      if (dist <= maxGap && dist < bestDist) {
        bestDist = dist;
        best = pos;
      }
    }

    if (!best) {
      return null;
    }
    used.add(best.tokenIndex);
    result.push(best);
  }

  // Verify all matched tokens are within maxGap of each other
  const indices = result.map((r) => r.tokenIndex);
  const min = Math.min(...indices);
  const max = Math.max(...indices);
  if (max - min > maxGap) {
    return null;
  }

  return result;
}
