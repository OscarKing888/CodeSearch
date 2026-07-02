export interface WildcardHit {
  line: number;
  column: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

interface WildcardPart {
  text: string;
  isWildcard: boolean;
  maxTokens: number;
  spanLines: boolean;
}

/**
 * Parse patterns like: this * that  |  this *:100 that
 */
export function parseWildcardPattern(pattern: string): WildcardPart[] {
  const parts: WildcardPart[] = [];
  const regex = /(\*:?\d*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(pattern)) !== null) {
    if (match.index > lastIndex) {
      const text = pattern.slice(lastIndex, match.index);
      if (text) {
        parts.push({ text, isWildcard: false, maxTokens: 0, spanLines: false });
      }
    }

    const wc = match[1];
    if (wc === '*') {
      parts.push({ text: '', isWildcard: true, maxTokens: Infinity, spanLines: false });
    } else {
      const num = parseInt(wc.slice(2), 10);
      parts.push({
        text: '',
        isWildcard: true,
        maxTokens: isNaN(num) ? Infinity : num,
        spanLines: true,
      });
    }
    lastIndex = match.index + wc.length;
  }

  if (lastIndex < pattern.length) {
    parts.push({ text: pattern.slice(lastIndex), isWildcard: false, maxTokens: 0, spanLines: false });
  }

  return parts;
}

export function hasMultiTokenWildcard(pattern: string): boolean {
  return /\s\*(?::\d+)?\s/.test(pattern);
}

export function findWildcardHits(
  content: string,
  pattern: string,
  caseSensitive: boolean
): WildcardHit[] {
  const parts = parseWildcardPattern(pattern);
  if (parts.length === 0) {
    return [];
  }

  const flags = caseSensitive ? 'g' : 'gi';
  const hits: WildcardHit[] = [];
  const lines = content.split(/\r?\n/);

  const spanLines = parts.some((p) => p.isWildcard && p.spanLines);

  if (!spanLines) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = matchLineWildcard(line, parts, flags);
      if (match) {
        hits.push({
          line: i + 1,
          column: match.start + 1,
          lineText: line,
          matchStart: match.start,
          matchEnd: match.end,
        });
      }
    }
    return hits;
  }

  // Multi-line wildcard
  const fullText = content;
  const multilineHits = matchMultilineWildcard(fullText, lines, parts, flags);
  return multilineHits;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchLineWildcard(
  line: string,
  parts: WildcardPart[],
  flags: string
): { start: number; end: number } | null {
  let regexStr = '';
  for (const part of parts) {
    if (part.isWildcard) {
      if (part.maxTokens === Infinity) {
        regexStr += '.*?';
      } else {
        regexStr += `(?:\\S+\\s+){0,${part.maxTokens}}\\S*`;
      }
    } else {
      regexStr += escapeRegex(part.text);
    }
  }

  const regex = new RegExp(regexStr, flags);
  const match = regex.exec(line);
  if (!match) {
    return null;
  }
  return { start: match.index, end: match.index + match[0].length };
}

function matchMultilineWildcard(
  fullText: string,
  lines: string[],
  parts: WildcardPart[],
  flags: string
): WildcardHit[] {
  let regexStr = '';
  for (const part of parts) {
    if (part.isWildcard) {
      if (part.maxTokens === Infinity) {
        regexStr += '[\\s\\S]*?';
      } else {
        regexStr += `(?:\\S+\\s+){0,${part.maxTokens}}[\\s\\S]*?`;
      }
    } else {
      regexStr += escapeRegex(part.text);
    }
  }

  const regex = new RegExp(regexStr, flags);
  const hits: WildcardHit[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(fullText)) !== null) {
    const startOffset = match.index;
    const { line, column, lineText, charStart, charEnd } = offsetToLine(lines, startOffset, match[0].length);
    hits.push({ line, column, lineText, matchStart: charStart, matchEnd: charEnd });
    if (match[0].length === 0) {
      regex.lastIndex++;
    }
  }
  return hits;
}

function offsetToLine(
  lines: string[],
  offset: number,
  length: number
): { line: number; column: number; lineText: string; charStart: number; charEnd: number } {
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length + 1;
    if (pos + lines[i].length >= offset || (i === lines.length - 1)) {
      const charStart = Math.max(0, offset - pos);
      return {
        line: i + 1,
        column: charStart + 1,
        lineText: lines[i],
        charStart,
        charEnd: Math.min(lines[i].length, charStart + length),
      };
    }
    pos += lineLen;
  }
  return { line: 1, column: 1, lineText: lines[0] ?? '', charStart: 0, charEnd: 0 };
}
