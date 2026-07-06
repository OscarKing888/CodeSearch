import * as path from 'path';

export interface HighlightToken {
  text: string;
  color?: string;
}

const KEYWORD_COLOR = '#569cd6';
const STRING_COLOR = '#ce9178';
const COMMENT_COLOR = '#6a9955';
const NUMBER_COLOR = '#b5cea8';
const TYPE_COLOR = '#4ec9b0';
const FUNCTION_COLOR = '#dcdcaa';

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'return', 'if', 'else', 'for', 'while',
  'import', 'export', 'from', 'async', 'await', 'public', 'private', 'protected',
  'static', 'void', 'int', 'float', 'double', 'bool', 'string', 'new', 'this',
  'true', 'false', 'null', 'undefined', 'struct', 'enum', 'interface', 'type',
  'namespace', 'using', 'virtual', 'override', 'def', 'elif', 'lambda', 'pass',
  'break', 'continue', 'switch', 'case', 'default', 'try', 'catch', 'finally',
  'throw', 'package', 'func', 'go', 'defer', 'select', 'chan', 'map',
]);

const TYPES = new Set([
  'string', 'int', 'float', 'double', 'bool', 'void', 'char', 'long', 'short',
  'unsigned', 'signed', 'boolean', 'number', 'object', 'any', 'never', 'unknown',
]);

export async function createRegistry(_extensionUri: unknown): Promise<undefined> {
  return undefined;
}

export function scopeForExtension(ext: string): string {
  return ext.toLowerCase();
}

export async function highlightLine(
  line: string,
  ext: string,
  _reg: unknown
): Promise<HighlightToken[]> {
  return fallbackHighlight(line, ext);
}

function fallbackHighlight(line: string, ext: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const regex =
    /(\/\/.*$|#.*$|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b[A-Za-z_][A-Za-z0-9_]*\b|\b\d+\.?\d*\b)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: line.slice(lastIndex, match.index) });
    }
    const text = match[0];
    let color: string | undefined;

    if (text.startsWith('//') || text.startsWith('#') || text.startsWith('/*')) {
      color = COMMENT_COLOR;
    } else if (text.startsWith('"') || text.startsWith("'") || text.startsWith('`')) {
      color = STRING_COLOR;
    } else if (/^\d/.test(text)) {
      color = NUMBER_COLOR;
    } else if (KEYWORDS.has(text)) {
      color = KEYWORD_COLOR;
    } else if (TYPES.has(text)) {
      color = TYPE_COLOR;
    } else if (/^[A-Z]/.test(text)) {
      color = TYPE_COLOR;
    } else if (/^[a-z]/.test(text) && line[match.index + text.length] === '(') {
      color = FUNCTION_COLOR;
    }

    tokens.push({ text, color });
    lastIndex = match.index + text.length;
  }

  if (lastIndex < line.length) {
    tokens.push({ text: line.slice(lastIndex) });
  }

  return tokens.length > 0 ? tokens : [{ text: line }];
}

export async function highlightHits(
  hits: Array<{ lineText: string; path: string; matchStart: number; matchEnd: number }>,
  reg: unknown
): Promise<Array<{ tokens: HighlightToken[]; matchStart: number; matchEnd: number }>> {
  const results = [];
  for (const hit of hits) {
    const ext = path.extname(hit.path).replace(/^\./, '');
    const tokens = await highlightLine(hit.lineText, ext, reg);
    results.push({ tokens, matchStart: hit.matchStart, matchEnd: hit.matchEnd });
  }
  return results;
}
