export type ClassKind = 'class' | 'struct';

export type InheritanceAccess = 'public' | 'protected' | 'private';

export type ClassLocationMetadata = Readonly<Record<string, unknown>>;

export interface ClassLocation<TMetadata = ClassLocationMetadata> {
  /** Absolute or index-relative path supplied by the caller. */
  path: string;
  /** One-based location of the `class`/`struct` keyword. */
  line: number;
  column: number;
  /** One-based location of the opening brace at the end of the declaration header. */
  endLine: number;
  endColumn: number;
  /** Opaque service-owned information, for example indexId/localPath. */
  metadata?: TMetadata;
}

export interface ClassBase {
  /** Base name as it appeared in the source, with insignificant whitespace removed. */
  name: string;
  /** Name used for declaration matching (template arguments are removed). */
  lookupName: string;
  access: InheritanceAccess;
  isVirtual: boolean;
}

export interface ClassDeclaration<TMetadata = ClassLocationMetadata> {
  /** Stable within a source snapshot; suitable for use as a hierarchy node id. */
  id: string;
  kind: ClassKind;
  name: string;
  /** Includes a declaration qualifier when one was written (`Outer::Inner`). */
  qualifiedName: string;
  isFinal: boolean;
  bases: ClassBase[];
  location: ClassLocation<TMetadata>;
}

export interface ExtractClassDeclarationsOptions<TMetadata = ClassLocationMetadata> {
  path: string;
  /**
   * When supplied, only declarations whose header intersects one of these
   * one-based source lines are returned. An empty iterable returns no declarations.
   */
  hitLines?: Iterable<number>;
  metadata?: TMetadata;
}

export interface ClassHierarchyNode<TMetadata = ClassLocationMetadata> {
  id: string;
  name: string;
  qualifiedName: string;
  external: boolean;
  kind?: ClassKind;
  path?: string;
  line?: number;
  column?: number;
  declaration?: ClassDeclaration<TMetadata>;
  /** Parent/base node ids. */
  baseIds: string[];
  /** Child/derived node ids, intended to drive the hierarchy panel. */
  derivedIds: string[];
}

export interface SkippedCycleEdge {
  baseId: string;
  derivedId: string;
}

export interface ClassHierarchy<TMetadata = ClassLocationMetadata> {
  /** Flat, serializable node collection. */
  nodes: ClassHierarchyNode<TMetadata>[];
  /** Nodes with no retained bases. Multiple inheritance makes this a DAG, not a strict tree. */
  roots: string[];
  /** Edges omitted to keep the returned graph acyclic. */
  skippedCycleEdges: SkippedCycleEdge[];
}

interface HeaderScan {
  braceIndex: number;
  colonIndex: number;
}

interface IdentifierToken {
  value: string;
  start: number;
  end: number;
}

interface NamespaceRange {
  start: number;
  end: number;
  name: string;
}

/**
 * Extract C++ class/struct definition headers from a complete source file.
 *
 * This intentionally parses only declaration headers. Bodies are never inspected
 * semantically, but nested declarations are still found by the outer scan.
 */
export function extractClassDeclarations(
  source: string,
  path: string,
  hitLines?: Iterable<number>
): ClassDeclaration[];
export function extractClassDeclarations<TMetadata = ClassLocationMetadata>(
  source: string,
  options: ExtractClassDeclarationsOptions<TMetadata>
): ClassDeclaration<TMetadata>[];
export function extractClassDeclarations<TMetadata = ClassLocationMetadata>(
  source: string,
  optionsOrPath: ExtractClassDeclarationsOptions<TMetadata> | string,
  positionalHitLines?: Iterable<number>
): ClassDeclaration<TMetadata>[] {
  const options: ExtractClassDeclarationsOptions<TMetadata> = typeof optionsOrPath === 'string'
    ? { path: optionsOrPath, hitLines: positionalHitLines }
    : optionsOrPath;
  const clean = maskCommentsAndLiterals(source);
  const lineStarts = collectLineStarts(source);
  const templateParameterRanges = findTemplateParameterRanges(clean);
  const namespaceRanges = findNamespaceRanges(clean);
  const hitLines = options.hitLines === undefined
    ? undefined
    : new Set(Array.from(options.hitLines).filter((line) => Number.isInteger(line) && line > 0));
  const declarations: ClassDeclaration<TMetadata>[] = [];
  const keywordPattern = /\b(class|struct)\b/g;
  let namespaceCursor = 0;
  let activeNamespaces: NamespaceRange[] = [];

  let match: RegExpExecArray | null;
  while ((match = keywordPattern.exec(clean)) !== null) {
    const keywordIndex = match.index;
    const keywordEnd = keywordIndex + match[0].length;
    while (
      namespaceCursor < namespaceRanges.length &&
      namespaceRanges[namespaceCursor].start < keywordIndex
    ) {
      const range = namespaceRanges[namespaceCursor++];
      if (range.end > keywordIndex) {
        activeNamespaces.push(range);
      }
    }
    activeNamespaces = activeNamespaces.filter((range) => range.end > keywordIndex);
    if (isInsideRanges(keywordIndex, templateParameterRanges) || isEnumClass(clean, keywordIndex)) {
      continue;
    }

    const header = scanDefinitionHeader(clean, keywordEnd);
    if (!header) {
      continue;
    }

    const startPosition = positionAt(lineStarts, keywordIndex);
    const filterStartPosition = positionAt(
      lineStarts,
      findDeclarationPrefixStart(clean, keywordIndex)
    );
    const endPosition = positionAt(lineStarts, header.braceIndex);
    if (hitLines && !rangeIntersectsLines(filterStartPosition.line, endPosition.line, hitLines)) {
      continue;
    }

    const nameEnd = header.colonIndex >= 0 ? header.colonIndex : header.braceIndex;
    const namePart = clean.slice(keywordEnd, nameEnd);
    const parsedName = parseDeclarationName(namePart);
    if (!parsedName) {
      continue;
    }

    const kind = match[1] as ClassKind;
    const namespacePrefix = activeNamespaces
      .filter((range) => range.name)
      .map((range) => range.name)
      .join('::');
    const qualifiedName = namespacePrefix
      ? `${namespacePrefix}::${parsedName.qualifiedName}`
      : parsedName.qualifiedName;
    const basePart = header.colonIndex >= 0
      ? clean.slice(header.colonIndex + 1, header.braceIndex)
      : '';
    const bases = parseBases(basePart, kind);
    const location: ClassLocation<TMetadata> = {
      path: options.path,
      line: startPosition.line,
      column: startPosition.column,
      endLine: endPosition.line,
      endColumn: endPosition.column,
    };
    if (options.metadata !== undefined) {
      location.metadata = options.metadata;
    }

    declarations.push({
      id: declarationId(options.path, startPosition.line, startPosition.column, qualifiedName),
      kind,
      name: parsedName.name,
      qualifiedName,
      isFinal: /\bfinal\b/.test(namePart),
      bases,
      location,
    });
  }

  return declarations;
}

/**
 * Build a serializable inheritance DAG. Unknown or ambiguous bases become external
 * nodes. An edge that would introduce a cycle is recorded and omitted, so consumers
 * may traverse `derivedIds` without special recursion semantics.
 */
export function buildClassHierarchy<TMetadata = ClassLocationMetadata>(
  declarations: readonly ClassDeclaration<TMetadata>[]
): ClassHierarchy<TMetadata> {
  const nodes: ClassHierarchyNode<TMetadata>[] = [];
  const nodesById = new Map<string, ClassHierarchyNode<TMetadata>>();
  const declarationsByQualifiedName = new Map<string, ClassHierarchyNode<TMetadata>[]>();

  for (const declaration of declarations) {
    const node: ClassHierarchyNode<TMetadata> = {
      id: uniqueNodeId(declaration.id, nodesById),
      name: declaration.name,
      qualifiedName: declaration.qualifiedName,
      external: false,
      kind: declaration.kind,
      path: declaration.location.path,
      line: declaration.location.line,
      column: declaration.location.column,
      declaration,
      baseIds: [],
      derivedIds: [],
    };
    nodes.push(node);
    nodesById.set(node.id, node);
    addNameCandidate(declarationsByQualifiedName, normalizeLookupName(declaration.qualifiedName), node);
  }

  const externalNodes = new Map<string, ClassHierarchyNode<TMetadata>>();
  const skippedCycleEdges: SkippedCycleEdge[] = [];

  for (const node of nodes.slice()) {
    const declaration = node.declaration;
    if (!declaration) {
      continue;
    }
    for (const base of declaration.bases) {
      let baseNode = resolveBaseNode(
        base.lookupName,
        declaration.qualifiedName,
        declarationsByQualifiedName
      );
      if (!baseNode) {
        const externalKey = normalizeLookupName(base.lookupName) || base.name;
        baseNode = externalNodes.get(externalKey);
        if (!baseNode) {
          baseNode = {
            id: `external:${externalKey}`,
            name: shortName(externalKey),
            qualifiedName: externalKey,
            external: true,
            baseIds: [],
            derivedIds: [],
          };
          externalNodes.set(externalKey, baseNode);
          nodes.push(baseNode);
          nodesById.set(baseNode.id, baseNode);
        }
      }

      if (baseNode.id === node.id || canReach(baseNode.id, node.id, nodesById)) {
        skippedCycleEdges.push({ baseId: baseNode.id, derivedId: node.id });
        continue;
      }
      if (!node.baseIds.includes(baseNode.id)) {
        node.baseIds.push(baseNode.id);
      }
      if (!baseNode.derivedIds.includes(node.id)) {
        baseNode.derivedIds.push(node.id);
      }
    }
  }

  return {
    nodes,
    roots: nodes.filter((node) => node.baseIds.length === 0).map((node) => node.id),
    skippedCycleEdges,
  };
}

function declarationId(path: string, line: number, column: number, name: string): string {
  return `class:${path}:${line}:${column}:${name}`;
}

function uniqueNodeId(
  preferredId: string,
  nodesById: ReadonlyMap<string, ClassHierarchyNode<unknown>>
): string {
  if (!nodesById.has(preferredId)) {
    return preferredId;
  }
  let suffix = 2;
  while (nodesById.has(`${preferredId}#${suffix}`)) {
    suffix++;
  }
  return `${preferredId}#${suffix}`;
}

function addNameCandidate<TMetadata>(
  map: Map<string, ClassHierarchyNode<TMetadata>[]>,
  name: string,
  node: ClassHierarchyNode<TMetadata>
): void {
  const existing = map.get(name);
  if (existing) {
    existing.push(node);
  } else {
    map.set(name, [node]);
  }
}

function resolveBaseNode<TMetadata>(
  lookupName: string,
  derivedQualifiedName: string,
  qualified: ReadonlyMap<string, ClassHierarchyNode<TMetadata>[]>
): ClassHierarchyNode<TMetadata> | undefined {
  const explicitlyGlobal = /^\s*::/.test(lookupName);
  const normalized = normalizeLookupName(lookupName);
  const scope = normalizeLookupName(derivedQualifiedName).split('::');
  scope.pop();
  const candidates: string[] = [];
  if (!explicitlyGlobal) {
    for (let length = scope.length; length > 0; length--) {
      candidates.push(`${scope.slice(0, length).join('::')}::${normalized}`);
    }
  }
  candidates.push(normalized);

  for (const candidate of [...new Set(candidates)]) {
    const exact = qualified.get(candidate);
    if (exact?.length === 1) {
      return exact[0];
    }
    if (exact && exact.length > 1) {
      return undefined;
    }
  }
  return undefined;
}

function canReach<TMetadata>(
  targetId: string,
  startId: string,
  nodesById: ReadonlyMap<string, ClassHierarchyNode<TMetadata>>
): boolean {
  const pending = [startId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const currentId = pending.pop()!;
    if (currentId === targetId) {
      return true;
    }
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);
    const current = nodesById.get(currentId);
    if (current) {
      pending.push(...current.derivedIds);
    }
  }
  return false;
}

function parseDeclarationName(namePart: string): { name: string; qualifiedName: string } | undefined {
  const tokens = topLevelIdentifiers(namePart);
  const candidates = tokens.filter((token) => {
    if (/^(?:final|sealed|abstract|alignas|__declspec)$/.test(token.value)) {
      return false;
    }
    if (/^(?:NO_API|[A-Z][A-Z0-9_]*_API)$/.test(token.value)) {
      return false;
    }
    const following = namePart.slice(token.end).match(/^\s*(.)/);
    return following?.[1] !== '(';
  });
  const selected = candidates[candidates.length - 1];
  if (!selected) {
    return undefined;
  }

  if (!isValidClassHeadSuffix(namePart.slice(selected.end))) {
    return undefined;
  }

  let qualifiedName = selected.value;
  let selectedIndex = tokens.indexOf(selected);
  while (selectedIndex > 0) {
    const previous = tokens[selectedIndex - 1];
    const between = namePart.slice(previous.end, tokens[selectedIndex].start);
    if (!/^\s*::\s*$/.test(between)) {
      break;
    }
    qualifiedName = `${previous.value}::${qualifiedName}`;
    selectedIndex--;
  }
  return { name: selected.value, qualifiedName };
}

function isValidClassHeadSuffix(suffix: string): boolean {
  let remaining = suffix;
  let previous = '';
  while (remaining !== previous) {
    previous = remaining;
    remaining = remaining
      .replace(/^\s*(?:final|sealed)\b/, '')
      .replace(/^\s*\[\[[\s\S]*?\]\]/, '')
      .replace(/^\s*__(?:attribute__|declspec)\s*\(\([\s\S]*?\)\)/, '');
  }
  return remaining.trim().length === 0;
}

function topLevelIdentifiers(text: string): IdentifierToken[] {
  const tokens: IdentifierToken[] = [];
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '(') {
      paren++;
      i++;
    } else if (ch === ')') {
      paren = Math.max(0, paren - 1);
      i++;
    } else if (ch === '[') {
      bracket++;
      i++;
    } else if (ch === ']') {
      bracket = Math.max(0, bracket - 1);
      i++;
    } else if (ch === '<') {
      angle++;
      i++;
    } else if (ch === '>') {
      angle = Math.max(0, angle - 1);
      i++;
    } else if (paren === 0 && bracket === 0 && angle === 0 && /[A-Za-z_]/.test(ch)) {
      const start = i++;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) {
        i++;
      }
      tokens.push({ value: text.slice(start, i), start, end: i });
    } else {
      i++;
    }
  }
  return tokens;
}

function parseBases(text: string, derivedKind: ClassKind): ClassBase[] {
  const defaultAccess: InheritanceAccess = derivedKind === 'struct' ? 'public' : 'private';
  return splitTopLevel(text, ',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      let remainder = stripLeadingAttributes(part);
      let access: InheritanceAccess = defaultAccess;
      let isVirtual = false;
      let changed = true;
      while (changed) {
        changed = false;
        const prefix = remainder.match(/^\s*(public|protected|private|virtual)\b\s*/);
        if (prefix) {
          if (prefix[1] === 'virtual') {
            isVirtual = true;
          } else {
            access = prefix[1] as InheritanceAccess;
          }
          remainder = remainder.slice(prefix[0].length);
          remainder = stripLeadingAttributes(remainder);
          changed = true;
        }
      }
      remainder = remainder.replace(/^\s*typename\s+/, '').replace(/\.\.\.\s*$/, '');
      const name = normalizeDisplayName(remainder);
      const lookupName = normalizeLookupName(name);
      return {
        name,
        lookupName: /^::/.test(name) ? `::${lookupName}` : lookupName,
        access,
        isVirtual,
      };
    })
    .filter((base) => base.name.length > 0);
}

function stripLeadingAttributes(text: string): string {
  let result = text.trimStart();
  while (result.startsWith('[[')) {
    const end = result.indexOf(']]', 2);
    if (end < 0) {
      break;
    }
    result = result.slice(end + 2).trimStart();
  }
  return result;
}

function normalizeDisplayName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*::\s*/g, '::')
    .replace(/\s*<\s*/g, '<')
    .replace(/\s*>\s*/g, '>')
    .replace(/\s*,\s*/g, ', ');
}

function normalizeLookupName(name: string): string {
  let result = '';
  let angle = 0;
  for (const ch of normalizeDisplayName(name)) {
    if (ch === '<') {
      angle++;
    } else if (ch === '>') {
      angle = Math.max(0, angle - 1);
    } else if (angle === 0) {
      result += ch;
    }
  }
  return result
    .replace(/\btemplate\s+/g, '')
    .replace(/^::/, '')
    .replace(/\s+/g, '')
    .trim();
}

function shortName(name: string): string {
  const parts = name.split('::');
  return parts[parts.length - 1] || name;
}

function splitTopLevel(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      paren++;
    } else if (ch === ')') {
      paren = Math.max(0, paren - 1);
    } else if (ch === '[') {
      bracket++;
    } else if (ch === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (ch === '<') {
      angle++;
    } else if (ch === '>') {
      angle = Math.max(0, angle - 1);
    } else if (ch === delimiter && paren === 0 && bracket === 0 && angle === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function scanDefinitionHeader(clean: string, start: number): HeaderScan | undefined {
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  let colonIndex = -1;
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '(') {
      paren++;
    } else if (ch === ')') {
      paren = Math.max(0, paren - 1);
    } else if (ch === '[') {
      bracket++;
    } else if (ch === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (ch === '<') {
      angle++;
    } else if (ch === '>') {
      angle = Math.max(0, angle - 1);
    } else if (paren === 0 && bracket === 0 && angle === 0) {
      if (ch === ';') {
        return undefined;
      }
      if (ch === '{') {
        return { braceIndex: i, colonIndex };
      }
      if (
        ch === ':' &&
        colonIndex < 0 &&
        clean[i - 1] !== ':' &&
        clean[i + 1] !== ':'
      ) {
        colonIndex = i;
      }
    }
  }
  return undefined;
}

function findDeclarationPrefixStart(clean: string, keywordIndex: number): number {
  const windowStart = Math.max(0, keywordIndex - 4096);
  const prefix = clean.slice(windowStart, keywordIndex);
  let best = keywordIndex;

  const macroPattern = /\b(?:UCLASS|USTRUCT|UINTERFACE)\s*\(/g;
  let macro: RegExpExecArray | null;
  while ((macro = macroPattern.exec(prefix)) !== null) {
    const absoluteStart = windowStart + macro.index;
    const open = clean.indexOf('(', absoluteStart);
    const close = findMatchingDelimiter(clean, open, '(', ')', keywordIndex);
    if (close >= 0 && clean.slice(close + 1, keywordIndex).trim().length === 0) {
      best = Math.min(best, absoluteStart);
    }
  }

  const templatePattern = /\btemplate\s*</g;
  let template: RegExpExecArray | null;
  while ((template = templatePattern.exec(prefix)) !== null) {
    const absoluteStart = windowStart + template.index;
    const open = clean.indexOf('<', absoluteStart);
    const close = findMatchingDelimiter(clean, open, '<', '>', keywordIndex);
    if (close >= 0 && clean.slice(close + 1, keywordIndex).trim().length === 0) {
      best = Math.min(best, absoluteStart);
    }
  }

  return best;
}

function findMatchingDelimiter(
  text: string,
  openIndex: number,
  openChar: string,
  closeChar: string,
  limit: number
): number {
  if (openIndex < 0 || openIndex >= limit || text[openIndex] !== openChar) {
    return -1;
  }
  let depth = 0;
  for (let i = openIndex; i < limit; i++) {
    if (text[i] === openChar) {
      depth++;
    } else if (text[i] === closeChar) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function isEnumClass(clean: string, keywordIndex: number): boolean {
  const prefix = clean.slice(Math.max(0, keywordIndex - 100), keywordIndex);
  return /\benum\s*$/.test(prefix);
}

function findTemplateParameterRanges(clean: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  const pattern = /\btemplate\s*</g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean)) !== null) {
    const open = clean.indexOf('<', match.index);
    let depth = 0;
    for (let i = open; i < clean.length; i++) {
      if (clean[i] === '<') {
        depth++;
      } else if (clean[i] === '>') {
        depth--;
        if (depth === 0) {
          ranges.push([open, i]);
          pattern.lastIndex = i + 1;
          break;
        }
      }
    }
  }
  return ranges;
}

function findNamespaceRanges(clean: string): NamespaceRange[] {
  const namespaceByBrace = new Map<number, string>();
  const pattern = /\b(?:inline\s+)?namespace(?:\s+([A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*))?\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean)) !== null) {
    const relativeBrace = match[0].lastIndexOf('{');
    namespaceByBrace.set(
      match.index + relativeBrace,
      (match[1] ?? '').replace(/\s*::\s*/g, '::')
    );
  }

  const braceStack: Array<{ start: number; namespaceName?: string }> = [];
  const ranges: NamespaceRange[] = [];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '{') {
      braceStack.push({ start: i, namespaceName: namespaceByBrace.get(i) });
    } else if (clean[i] === '}') {
      const frame = braceStack.pop();
      if (frame?.namespaceName !== undefined) {
        ranges.push({ start: frame.start, end: i, name: frame.namespaceName });
      }
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function isInsideRanges(index: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([start, end]) => index >= start && index <= end);
}

function rangeIntersectsLines(start: number, end: number, lines: ReadonlySet<number>): boolean {
  for (let line = start; line <= end; line++) {
    if (lines.has(line)) {
      return true;
    }
  }
  return false;
}

function collectLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function positionAt(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { line: high + 1, column: offset - lineStarts[high] + 1 };
}

/** Replace comments and literals with spaces while preserving offsets and newlines. */
function maskCommentsAndLiterals(source: string): string {
  const chars = source.split('');
  const mask = (start: number, end: number): void => {
    for (let i = start; i < end; i++) {
      if (chars[i] !== '\n' && chars[i] !== '\r') {
        chars[i] = ' ';
      }
    }
  };

  for (let i = 0; i < source.length;) {
    if (source[i] === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i + 2);
      const stop = end < 0 ? source.length : end;
      mask(i, stop);
      i = stop;
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const stop = close < 0 ? source.length : close + 2;
      mask(i, stop);
      i = stop;
      continue;
    }
    if (source[i] === 'R' && source[i + 1] === '"') {
      const openParen = source.indexOf('(', i + 2);
      if (openParen >= 0 && openParen - (i + 2) <= 16) {
        const delimiter = source.slice(i + 2, openParen);
        const closeMarker = `)${delimiter}"`;
        const close = source.indexOf(closeMarker, openParen + 1);
        const stop = close < 0 ? source.length : close + closeMarker.length;
        mask(i, stop);
        i = stop;
        continue;
      }
    }
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      const start = i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
        } else if (source[i] === quote) {
          i++;
          break;
        } else {
          i++;
        }
      }
      mask(start, Math.min(i, source.length));
      continue;
    }
    i++;
  }
  return chars.join('');
}
