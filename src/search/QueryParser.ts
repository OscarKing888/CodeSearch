import { ParsedQuery, QueryFilters, QueryHighlightSegment } from '../types';
import { hasMultiTokenWildcard } from './WildcardMatcher';

type PathFilterType = 'ext' | 'dir' | 'file' | 'age';

interface PathFilterToken {
  start: number;
  end: number;
  text: string;
  type: PathFilterType;
  exclude: boolean;
  value: string;
  extensions?: string[];
  ageMs?: number;
}

interface ContentFilterToken {
  start: number;
  end: number;
  text: string;
  include: boolean;
  value: string;
}

interface Span {
  start: number;
  end: number;
}

const PATH_FILTER_PREFIX = /^(-?)(ext|dir|file|age):/i;
const FILTER_LIKE_VALUE = /^(ext|dir|file|age):/i;
const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|]/g;
const globRegexCache = new Map<string, RegExp>();

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
  const quoted = readQuotedString(s, 0);
  if (!quoted) {
    return null;
  }
  return {
    value: quoted.value,
    rest: s.slice(quoted.end),
  };
}

function readQuotedString(
  input: string,
  start: number
): { value: string; end: number } | undefined {
  if (input[start] !== '"') {
    return undefined;
  }

  let i = start + 1;
  let inner = '';
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length) {
      inner += ch + input[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') {
      return { value: inner, end: i + 1 };
    }
    inner += ch;
    i++;
  }
  return undefined;
}

function isTokenBoundary(input: string, index: number): boolean {
  return index === 0 || /\s/.test(input[index - 1]);
}

function isEscaped(input: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && input[i] === '\\'; i--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function normalizeExtension(value: string): string {
  return value.trim().replace(/^\*\./, '').replace(/^\./, '').toLowerCase();
}

function readPathFilterAt(input: string, start: number): PathFilterToken | undefined {
  if (!isTokenBoundary(input, start)) {
    return undefined;
  }

  const prefix = input.slice(start).match(PATH_FILTER_PREFIX);
  if (!prefix) {
    return undefined;
  }

  const exclude = prefix[1] === '-';
  const type = prefix[2].toLowerCase() as PathFilterType;
  const valueStart = start + prefix[0].length;
  if (valueStart >= input.length) {
    return undefined;
  }

  let value: string;
  let end: number;
  if (input[valueStart] === '"') {
    const quoted = readQuotedString(input, valueStart);
    if (!quoted || (quoted.end < input.length && !/\s/.test(input[quoted.end]))) {
      return undefined;
    }
    value = unescapeQueryString(quoted.value);
    end = quoted.end;
  } else {
    end = valueStart;
    while (end < input.length && !/\s/.test(input[end])) {
      end++;
    }
    value = input.slice(valueStart, end);
  }

  if (!value.trim()) {
    return undefined;
  }

  const token: PathFilterToken = {
    start,
    end,
    text: input.slice(start, end),
    type,
    exclude,
    value,
  };

  if (type === 'ext') {
    const extensions = value
      .split(',')
      .map(normalizeExtension)
      .filter(Boolean);
    if (extensions.length === 0) {
      return undefined;
    }
    token.extensions = extensions;
  } else if (type === 'age') {
    const ageMs = parseAgeValue(value.toLowerCase());
    if (ageMs === undefined) {
      return undefined;
    }
    token.ageMs = ageMs;
  }

  return token;
}

function scanPathFilterTokens(input: string): PathFilterToken[] {
  const tokens: PathFilterToken[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === '"' && !isEscaped(input, i)) {
      const quoted = readQuotedString(input, i);
      if (!quoted) {
        break;
      }
      i = quoted.end;
      continue;
    }

    const token = readPathFilterAt(input, i);
    if (token) {
      tokens.push(token);
      i = token.end;
      continue;
    }
    i++;
  }
  return tokens;
}

function scanRegexSuffixFilters(input: string): PathFilterToken[] {
  const selected: PathFilterToken[] = [];
  let end = input.length;
  while (end > 0 && /\s/.test(input[end - 1])) {
    end--;
  }

  while (end > 0) {
    let token: PathFilterToken | undefined;
    for (let start = 0; start < end; start++) {
      if (!isTokenBoundary(input, start)) {
        continue;
      }
      const candidate = readPathFilterAt(input, start);
      if (
        candidate?.end === end &&
        (!token || candidate.start < token.start)
      ) {
        token = candidate;
      }
    }
    if (!token) {
      break;
    }
    selected.unshift(token);
    end = token.start;
    while (end > 0 && /\s/.test(input[end - 1])) {
      end--;
    }
  }
  return selected;
}

function removeSpans(input: string, spans: readonly Span[]): string {
  if (spans.length === 0) {
    return input;
  }
  const chars = input.split('');
  for (const span of spans) {
    for (let i = span.start; i < span.end; i++) {
      chars[i] = ' ';
    }
  }
  return chars.join('');
}

function removeTokenSpans(input: string, spans: readonly Span[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let result = '';
  let cursor = 0;

  const append = (piece: string): void => {
    if (/\s$/.test(result) && /^\s/.test(piece)) {
      result += piece.replace(/^\s+/, '');
    } else {
      result += piece;
    }
  };

  for (const span of sorted) {
    append(input.slice(cursor, span.start));
    cursor = Math.max(cursor, span.end);
  }
  append(input.slice(cursor));
  return result;
}

function scanContentFilterTokens(input: string): ContentFilterToken[] {
  const tokens: ContentFilterToken[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === '"' && !isEscaped(input, i)) {
      const quoted = readQuotedString(input, i);
      if (!quoted) {
        break;
      }
      i = quoted.end;
      continue;
    }
    if (!isTokenBoundary(input, i) || (input[i] !== '+' && input[i] !== '-')) {
      i++;
      continue;
    }

    const include = input[i] === '+';
    const valueStart = i + 1;
    if (valueStart >= input.length) {
      i++;
      continue;
    }

    let value: string;
    let end: number;
    let quotedValue = false;
    if (input[valueStart] === '"') {
      const quoted = readQuotedString(input, valueStart);
      if (!quoted || (quoted.end < input.length && !/\s/.test(input[quoted.end]))) {
        i++;
        continue;
      }
      value = unescapeQueryString(quoted.value);
      end = quoted.end;
      quotedValue = true;
    } else {
      end = valueStart;
      while (end < input.length && !/\s/.test(input[end])) {
        end++;
      }
      value = unescapeQueryString(input.slice(valueStart, end));
    }

    if (!value || (!include && !quotedValue && FILTER_LIKE_VALUE.test(value))) {
      i++;
      continue;
    }
    tokens.push({
      start: i,
      end,
      text: input.slice(i, end),
      include,
      value,
    });
    i = end;
  }
  return tokens;
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

function applyPathFilter(token: PathFilterToken, filters: QueryFilters): void {
  switch (token.type) {
    case 'ext': {
      const target = token.exclude ? filters.extExclude : filters.extInclude;
      target.push(...(token.extensions ?? []));
      break;
    }
    case 'dir':
      (token.exclude ? filters.dirExclude : filters.dirInclude).push(token.value);
      break;
    case 'file':
      (token.exclude ? filters.fileExclude : filters.fileInclude).push(token.value);
      break;
    case 'age':
      if (token.exclude) {
        filters.ageMinMs = Math.max(filters.ageMinMs ?? 0, token.ageMs ?? 0);
      } else {
        filters.ageMaxMs = Math.max(filters.ageMaxMs ?? 0, token.ageMs ?? 0);
      }
      break;
  }
}

export function parseAgeValue(value: string): number | undefined {
  const match = value.match(/^(\d+)d(?:(\d+)h)?$|^(\d+)h$|^(\d+)m$/);
  if (!match) {
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

export function parseQuery(
  raw: string,
  defaultPhrase: boolean,
  defaultLooseGap = 10,
  regexMode = false
): ParsedQuery {
  const filters = emptyFilters();
  let remaining = regexMode ? raw : raw.trim();
  let loose = false;
  let looseGap = defaultLooseGap;

  if (!regexMode) {
    const loosePrefix = remaining.match(/^loose(\d+)?:\s*/i);
    if (loosePrefix) {
      loose = true;
      if (loosePrefix[1]) {
        looseGap = parseInt(loosePrefix[1], 10);
      }
      remaining = remaining.slice(loosePrefix[0].length).trim();
    }
  }

  const pathTokens = regexMode
    ? scanRegexSuffixFilters(remaining)
    : scanPathFilterTokens(remaining);
  for (const token of pathTokens) {
    applyPathFilter(token, filters);
  }

  if (regexMode) {
    let patternEnd = remaining.length;
    if (pathTokens.length > 0) {
      patternEnd = pathTokens[0].start;
    }
    const pattern =
      pathTokens.length > 0
        ? remaining.slice(0, patternEnd).trimEnd()
        : remaining;
    const filterOnly = pattern.length === 0 && pathTokens.length > 0;
    return {
      raw,
      terms: pattern ? [pattern] : [],
      phrase: false,
      caseSensitive: false,
      filters,
      filterOnly,
      loose: false,
      looseGap,
      multiWildcard: false,
      wildcardMaxTokens: Infinity,
      wildcardSpanLines: false,
    };
  }

  const withoutPathFilters = removeSpans(remaining, pathTokens);
  const contentTokens = scanContentFilterTokens(withoutPathFilters);
  for (const token of contentTokens) {
    (token.include ? filters.contentInclude : filters.contentExclude).push(token.value);
  }
  remaining = removeTokenSpans(remaining, [...pathTokens, ...contentTokens]).trim();

  let phrase = defaultPhrase;
  let terms: string[] = [];
  let multiWildcard = false;
  let wildcardMaxTokens = Infinity;
  let wildcardSpanLines = false;
  const hasFilters =
    pathTokens.length > 0 ||
    filters.contentInclude.length > 0 ||
    filters.contentExclude.length > 0;

  if (!remaining) {
    return {
      raw,
      terms: [],
      phrase: false,
      caseSensitive: false,
      filters,
      filterOnly: hasFilters,
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
    filterOnly: terms.length === 0 && hasFilters,
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
    const parts = term.split('*').map((part) => part.replace(/"/g, '""'));
    if (parts.length === 2 && parts[0] && !parts[1]) {
      return `${parts[0]}*`;
    }
    if (parts.length === 2 && !parts[0] && parts[1]) {
      return `*${parts[1]}`;
    }
    if (parts.length === 2 && parts[0] && parts[1]) {
      return `${parts[0]}*${parts[1]}`;
    }
    return parts.filter(Boolean).map((part) => `${part}*`).join(' ');
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
  const parts = terms.map((term) => termToFtsQuery(term, false));
  return useOr ? parts.join(' OR ') : parts.join(' ');
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function pathDirname(value: string): string {
  const normalized = normalizePath(value);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '';
}

function compileGlobSource(pattern: string): string {
  const normalized = normalizePath(pattern);
  if (normalized.length > 3 && normalized.endsWith('/**')) {
    return `${compileGlobSource(normalized.slice(0, -3))}(?:/.*)?`;
  }

  let source = '';
  let i = 0;
  while (i < normalized.length) {
    if (normalized[i] === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 3;
      } else {
        source += '.*';
        i += 2;
      }
      continue;
    }
    if (normalized[i] === '*') {
      source += '[^/]*';
      i++;
      continue;
    }
    if (normalized[i] === '?') {
      source += '[^/]';
      i++;
      continue;
    }
    source += normalized[i].replace(REGEX_SPECIAL, '\\$&');
    i++;
  }
  return source;
}

function getGlobRegex(pattern: string, target: 'basename' | 'path' | 'dir'): RegExp {
  const normalized =
    target === 'basename'
      ? normalizePath(pattern)
      : normalizePath(pattern).replace(/^\/+/, '');
  const key = `${target}:${normalized}`;
  const cached = globRegexCache.get(key);
  if (cached) {
    return cached;
  }

  const source = compileGlobSource(normalized);
  const wrapped =
    target === 'basename'
      ? `^${source}$`
      : target === 'path'
        ? `(?:^|/)${source}$`
        : `(?:^|/)${source}$`;
  const regex = new RegExp(wrapped, 'i');
  globRegexCache.set(key, regex);
  return regex;
}

function fileMatchesPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern);
  const basename = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
  return normalizedPattern.includes('/')
    ? getGlobRegex(normalizedPattern, 'path').test(normalizedPath)
    : getGlobRegex(normalizedPattern, 'basename').test(basename);
}

function dirMatchesPattern(directory: string, pattern: string): boolean {
  const normalizedDir = normalizePath(directory);
  const normalizedPattern = normalizePath(pattern);
  if (!/[*?]/.test(normalizedPattern)) {
    return normalizedDir.toLowerCase().includes(normalizedPattern.toLowerCase());
  }
  return getGlobRegex(normalizedPattern, 'dir').test(normalizedDir);
}

export function pathMatchesFilter(
  filePath: string,
  ext: string,
  dir: string,
  filters: QueryFilters,
  mappedFilePath?: string
): boolean {
  const normalizedExt = normalizeExtension(ext);
  const paths = Array.from(
    new Set(
      [filePath, mappedFilePath]
        .filter((value): value is string => Boolean(value))
        .map(normalizePath)
    )
  );
  const directories = Array.from(
    new Set(
      [
        dir,
        mappedFilePath ? pathDirname(mappedFilePath) : undefined,
      ]
        .filter((value): value is string => value !== undefined)
        .map(normalizePath)
    )
  );

  if (filters.extExclude.some((value) => normalizedExt === normalizeExtension(value))) {
    return false;
  }
  if (
    filters.dirExclude.some((pattern) =>
      directories.some((directory) => dirMatchesPattern(directory, pattern))
    )
  ) {
    return false;
  }
  if (
    filters.fileExclude.some((pattern) =>
      paths.some((candidate) => fileMatchesPattern(candidate, pattern))
    )
  ) {
    return false;
  }

  if (
    filters.extInclude.length > 0 &&
    !filters.extInclude.some((value) => normalizedExt === normalizeExtension(value))
  ) {
    return false;
  }
  if (
    filters.dirInclude.length > 0 &&
    !filters.dirInclude.some((pattern) =>
      directories.some((directory) => dirMatchesPattern(directory, pattern))
    )
  ) {
    return false;
  }
  if (
    filters.fileInclude.length > 0 &&
    !filters.fileInclude.some((pattern) =>
      paths.some((candidate) => fileMatchesPattern(candidate, pattern))
    )
  ) {
    return false;
  }
  return true;
}

export function contentMatchesFilter(
  content: string,
  filters: QueryFilters,
  caseSensitive: boolean
): boolean {
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

export function highlightQuery(raw: string, regexMode = false): QueryHighlightSegment[] {
  if (!raw) {
    return [];
  }

  const pathTokens = regexMode
    ? scanRegexSuffixFilters(raw)
    : scanPathFilterTokens(raw);
  const withoutPathFilters = removeSpans(raw, pathTokens);
  const contentTokens = regexMode ? [] : scanContentFilterTokens(withoutPathFilters);
  const special = new Map<number, { end: number; kind: QueryHighlightSegment['kind'] }>();

  for (const token of pathTokens) {
    special.set(token.start, {
      end: token.end,
      kind: token.exclude ? 'filter-exclude' : 'filter-include',
    });
  }
  for (const token of contentTokens) {
    special.set(token.start, {
      end: token.end,
      kind: token.include ? 'filter-include' : 'filter-exclude',
    });
  }

  if (!regexMode) {
    const firstNonSpace = raw.search(/\S/);
    if (firstNonSpace >= 0) {
      const loose = raw.slice(firstNonSpace).match(/^loose\d*:/i);
      if (loose) {
        special.set(firstNonSpace, {
          end: firstNonSpace + loose[0].length,
          kind: 'loose',
        });
      }
    }
  }

  const segments: QueryHighlightSegment[] = [];
  let i = 0;
  while (i < raw.length) {
    const specialToken = special.get(i);
    if (specialToken) {
      segments.push({
        text: raw.slice(i, specialToken.end),
        kind: specialToken.kind,
      });
      i = specialToken.end;
      continue;
    }

    if (/\s/.test(raw[i])) {
      let end = i + 1;
      while (end < raw.length && /\s/.test(raw[end]) && !special.has(end)) {
        end++;
      }
      segments.push({ text: raw.slice(i, end), kind: 'text' });
      i = end;
      continue;
    }

    if (raw[i] === '"' && !isEscaped(raw, i)) {
      const quoted = readQuotedString(raw, i);
      if (quoted) {
        segments.push({ text: raw.slice(i, quoted.end), kind: 'quoted' });
        i = quoted.end;
        continue;
      }
    }

    let end = i + 1;
    while (end < raw.length && !/\s/.test(raw[end]) && !special.has(end)) {
      end++;
    }
    segments.push({ text: raw.slice(i, end), kind: 'term' });
    i = end;
  }
  return segments;
}

// Kept for compatibility with older internal callers. Query matching uses the
// segment-aware glob compiler above rather than SQL LIKE semantics.
export function globToLike(pattern: string): string {
  return normalizePath(pattern)
    .replace(/([%_\\])/g, '\\$1')
    .replace(/\*\*/g, '%')
    .replace(/\*/g, '%')
    .replace(/\?/g, '_');
}
