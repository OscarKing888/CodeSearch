import { ParsedQuery, QueryFilters, QueryHighlightSegment } from '../types';
import { hasMultiTokenWildcard } from './WildcardMatcher';

const PATH_FILTER_PATTERN = /(-?)(ext|dir|file|age):(\S+)/g;
const CONTENT_FILTER_PATTERN = /([+-])(?:"(?:[^"\\]|\\.)*"|[^\s]+)/g;
const HIGHLIGHT_REGEX =
  /loose\d*:|(-?)(ext|dir|file|age):(\S+)|\+(?:"(?:[^"\\]|\\.)*"|[^\s]+)|-(?:"(?:[^"\\]|\\.)*"|[^\s]+)|"(?:[^"\\]|\\.)*"|[^\s]+/gi;

export function unescapeQueryString(s: string): string {
  let result = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === '\\' || next === '"') {
        result += next;
        i += 2;
        continue;
      }
    }
    result += s[i];
    i++;
  }
  return result;
}

function parseLeadingQuotedString(s: string): { value: string; rest: string } | null {
  if (!s.startsWith('"')) {
    return null;
  }

  let i = 1;
  let inner = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      inner += ch + s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') {
      return { value: inner, rest: s.slice(i + 1) };
    }
    inner += ch;
    i++;
  }

  return null;
}

function parseContentFilterValue(token: string): string | undefined {
  if (token.startsWith('"')) {
    const parsed = parseLeadingQuotedString(token);
    return parsed ? unescapeQueryString(parsed.value) : undefined;
  }
  return unescapeQueryString(token);
}

function applyContentFilters(remaining: string, filters: QueryFilters): string {
  return remaining.replace(CONTENT_FILTER_PATTERN, (full, sign: string) => {
    const token = full.slice(1);
    const value = parseContentFilterValue(token);
    if (value === undefined) {
      return full;
    }
    if (sign === '+') {
      filters.contentInclude.push(value);
    } else if (!/^(ext|dir|file|age):/.test(value)) {
      filters.contentExclude.push(value);
    }
    return ' ';
  });
}

export function parseAgeValue(value: string): number | undefined {
  const match = value.match(/^(\d+)d(?:(\d+)h)?$|^(\d+)h$|^(\d+)m$/);
  if (!match) {
    const simple = value.match(/^(\d+)([mhd])$/);
    if (!simple) {
      return undefined;
    }
    const n = parseInt(simple[1], 10);
    switch (simple[2]) {
      case 'm': return n * 60 * 1000;
      case 'h': return n * 60 * 60 * 1000;
      case 'd': return n * 24 * 60 * 60 * 1000;
    }
    return undefined;
  }

  if (match[1] !== undefined) {
    const days = parseInt(match[1], 10);
    const hours = match[2] ? parseInt(match[2], 10) : 0;
    return (days * 24 + hours) * 60 * 60 * 1000;
  }
  if (match[3] !== undefined) {
    return parseInt(match[3], 10) * 60 * 60 * 1000;
  }
  if (match[4] !== undefined) {
    return parseInt(match[4], 10) * 60 * 1000;
  }
  return undefined;
}

function globToLike(pattern: string): string {
  return pattern
    .replace(/\\/g, '/')
    .replace(/\./g, '\\.')
    .replace(/\*/g, '%')
    .replace(/\?/g, '_');
}

function emptyFilters(): QueryFilters {
  return {
    extInclude: [],
    extExclude: [],
    dirInclude: [],
    dirExclude: [],
    fileInclude: [],
    fileExclude: [],
    contentInclude: [],
    contentExclude: [],
  };
}

export function parseQuery(raw: string, defaultPhrase: boolean, defaultLooseGap = 10): ParsedQuery {
  const filters = emptyFilters();
  let remaining = raw.trim();
  const filterMatches: string[] = [];

  let loose = false;
  let looseGap = defaultLooseGap;
  const loosePrefix = remaining.match(/^loose(\d+)?:\s*/i);
  if (loosePrefix) {
    loose = true;
    if (loosePrefix[1]) {
      looseGap = parseInt(loosePrefix[1], 10);
    }
    remaining = remaining.slice(loosePrefix[0].length).trim();
  }

  remaining = remaining.replace(PATH_FILTER_PATTERN, (full, negate, type, value) => {
    filterMatches.push(full);
    const isExclude = negate === '-';
    const unquoted = value.replace(/^["']|["']$/g, '');

    switch (type) {
      case 'ext': {
        const ext = unquoted.replace(/^\*\.?/, '').replace(/^\./, '');
        if (isExclude) {
          filters.extExclude.push(ext);
        } else {
          filters.extInclude.push(ext);
        }
        break;
      }
      case 'dir': {
        const dir = unquoted.replace(/\\/g, '/');
        if (isExclude) {
          filters.dirExclude.push(dir);
        } else {
          filters.dirInclude.push(dir);
        }
        break;
      }
      case 'file': {
        if (isExclude) {
          filters.fileExclude.push(unquoted);
        } else {
          filters.fileInclude.push(unquoted);
        }
        break;
      }
      case 'age': {
        const ms = parseAgeValue(unquoted);
        if (ms !== undefined) {
          if (isExclude) {
            filters.ageMinMs = ms;
          } else {
            filters.ageMaxMs = ms;
          }
        }
        break;
      }
    }
    return ' ';
  });

  remaining = applyContentFilters(remaining, filters);

  remaining = remaining.trim();

  let phrase = defaultPhrase;
  let terms: string[] = [];
  let multiWildcard = false;
  let wildcardMaxTokens = Infinity;
  let wildcardSpanLines = false;

  if (!remaining) {
    return {
      raw,
      terms: [],
      phrase: false,
      caseSensitive: false,
      filters,
      filterOnly: filterMatches.length > 0 || filters.contentInclude.length > 0 || filters.contentExclude.length > 0,
      loose,
      looseGap,
      multiWildcard,
      wildcardMaxTokens,
      wildcardSpanLines,
    };
  }

  const quoted = parseLeadingQuotedString(remaining);
  if (quoted) {
    const inner = unescapeQueryString(quoted.value);
    terms = [inner];
    phrase = true;
    if (hasMultiTokenWildcard(inner) || /\s\*(?::\d+)?\s/.test(inner)) {
      multiWildcard = true;
      const gapMatch = inner.match(/\*:(\d+)/);
      if (gapMatch) {
        wildcardMaxTokens = parseInt(gapMatch[1], 10);
        wildcardSpanLines = true;
      }
    }
    remaining = quoted.rest.trim();
  } else if (phrase && remaining.includes(' ')) {
    const inner = unescapeQueryString(remaining);
    terms = [inner];
    if (hasMultiTokenWildcard(inner)) {
      multiWildcard = true;
    }
  } else {
    terms = remaining.split(/\s+/).filter(Boolean).map(unescapeQueryString);
    if (terms.length > 1) {
      phrase = defaultPhrase;
      if (phrase) {
        terms = [unescapeQueryString(remaining)];
      }
    }
    if (terms.length === 1 && terms[0].includes('*')) {
      multiWildcard = /\s\*(?::\d+)?\s/.test(terms[0]);
    }
  }

  return {
    raw,
    terms,
    phrase,
    caseSensitive: false,
    filters,
    filterOnly: terms.length === 0 && (filterMatches.length > 0 || filters.contentInclude.length > 0 || filters.contentExclude.length > 0),
    loose,
    looseGap,
    multiWildcard,
    wildcardMaxTokens,
    wildcardSpanLines,
  };
}

export function termToFtsQuery(term: string, phrase: boolean): string {
  if (!term) {
    return '';
  }

  const escaped = term.replace(/"/g, '""');

  if (phrase && !term.includes('*')) {
    return `"${escaped}"`;
  }

  if (term.includes('*')) {
    const parts = term.split('*').map((p) => p.replace(/"/g, '""'));
    if (parts.length === 2 && parts[0] && !parts[1]) {
      return `${parts[0]}*`;
    }
    if (parts.length === 2 && !parts[0] && parts[1]) {
      return `*${parts[1]}`;
    }
    if (parts.length === 2 && parts[0] && parts[1]) {
      return `${parts[0]}*${parts[1]}`;
    }
    return parts.filter(Boolean).map((p) => `${p}*`).join(' ');
  }

  return escaped;
}

export function buildFtsMatch(terms: string[], phrase: boolean, useOr = false): string {
  if (terms.length === 0) {
    return '';
  }
  if (phrase && terms.length === 1 && !terms[0].includes('*')) {
    return termToFtsQuery(terms[0], true);
  }
  const parts = terms.map((t) => termToFtsQuery(t, false));
  return useOr ? parts.join(' OR ') : parts.join(' ');
}

export function pathMatchesFilter(
  filePath: string,
  ext: string,
  dir: string,
  filters: QueryFilters
): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const basename = normalizedPath.split('/').pop() ?? '';

  for (const e of filters.extExclude) {
    if (ext.toLowerCase() === e.toLowerCase()) {
      return false;
    }
  }
  for (const d of filters.dirExclude) {
    const norm = d.replace(/\\/g, '/');
    if (normalizedPath.includes(norm)) {
      return false;
    }
  }
  for (const f of filters.fileExclude) {
    const pattern = globToLike(f);
    if (matchLike(basename, pattern) || matchLike(normalizedPath, pattern)) {
      return false;
    }
  }

  if (filters.extInclude.length > 0) {
    if (!filters.extInclude.some((e) => ext.toLowerCase() === e.toLowerCase())) {
      return false;
    }
  }
  if (filters.dirInclude.length > 0) {
    if (!filters.dirInclude.some((d) => normalizedPath.includes(d.replace(/\\/g, '/')))) {
      return false;
    }
  }
  if (filters.fileInclude.length > 0) {
    if (!filters.fileInclude.some((f) => matchLike(basename, globToLike(f)) || matchLike(normalizedPath, globToLike(f)))) {
      return false;
    }
  }

  return true;
}

export function contentMatchesFilter(content: string, filters: QueryFilters, caseSensitive: boolean): boolean {
  const haystack = caseSensitive ? content : content.toLowerCase();

  for (const phrase of filters.contentInclude) {
    const needle = caseSensitive ? phrase : phrase.toLowerCase();
    if (!haystack.includes(needle)) {
      return false;
    }
  }

  for (const phrase of filters.contentExclude) {
    const needle = caseSensitive ? phrase : phrase.toLowerCase();
    if (haystack.includes(needle)) {
      return false;
    }
  }

  return true;
}

function matchLike(value: string, pattern: string): boolean {
  const regex = new RegExp('^' + pattern.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
  return regex.test(value);
}

export function highlightQuery(raw: string): QueryHighlightSegment[] {
  const segments: QueryHighlightSegment[] = [];
  if (!raw) {
    return segments;
  }

  const regex = HIGHLIGHT_REGEX;

  let lastEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(raw)) !== null) {
    if (match.index > lastEnd) {
      segments.push({ text: raw.slice(lastEnd, match.index), kind: 'text' });
    }

    const full = match[0];
    if (/^loose\d*:$/i.test(full)) {
      segments.push({ text: full, kind: 'loose' });
    } else if (match[2]) {
      segments.push({
        text: full,
        kind: match[1] === '-' ? 'filter-exclude' : 'filter-include',
      });
    } else if (match[0].startsWith('+')) {
      segments.push({ text: full, kind: 'filter-include' });
    } else if (match[0].startsWith('-') && !match[2]) {
      segments.push({ text: full, kind: 'filter-exclude' });
    } else if (match[0].startsWith('"')) {
      segments.push({ text: full, kind: 'quoted' });
    } else {
      segments.push({ text: full, kind: 'term' });
    }

    lastEnd = match.index + full.length;
  }

  if (lastEnd < raw.length) {
    segments.push({ text: raw.slice(lastEnd), kind: 'text' });
  }

  return segments;
}

export { globToLike };
