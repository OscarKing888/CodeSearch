export type RegexSnippetGroupId =
  | 'characters'
  | 'anchors'
  | 'quantifiers'
  | 'groups'
  | 'lookaround';

interface RegexSnippetBase {
  id: string;
  group: RegexSnippetGroupId;
  label: string;
  description: string;
}

export interface RegexInsertionSnippet extends RegexSnippetBase {
  text: string;
  placeholderStart?: number;
  placeholderEnd?: number;
}

export interface RegexWrapperSnippet extends RegexSnippetBase {
  prefix: string;
  suffix: string;
  placeholder: string;
}

export type RegexSnippet = RegexInsertionSnippet | RegexWrapperSnippet;

export interface RegexSnippetGroup {
  id: RegexSnippetGroupId;
  label: string;
}

export interface RegexSnippetEdit {
  value: string;
  replacement: string;
  rangeStart: number;
  rangeEnd: number;
  selectionStart: number;
  selectionEnd: number;
}

export const REGEX_SNIPPET_GROUPS: readonly RegexSnippetGroup[] = [
  { id: 'characters', label: 'Characters' },
  { id: 'anchors', label: 'Anchors' },
  { id: 'quantifiers', label: 'Quantifiers' },
  { id: 'groups', label: 'Groups' },
  { id: 'lookaround', label: 'Lookaround' },
];

export const REGEX_SNIPPETS: readonly RegexSnippet[] = [
  { id: 'any', group: 'characters', label: '.', description: 'Any character', text: '.' },
  { id: 'digit', group: 'characters', label: '\\d', description: 'Digit', text: '\\d' },
  { id: 'word', group: 'characters', label: '\\w', description: 'Word character', text: '\\w' },
  { id: 'space', group: 'characters', label: '\\s', description: 'Whitespace', text: '\\s' },
  {
    id: 'class',
    group: 'characters',
    label: '[]',
    description: 'Character class',
    prefix: '[',
    suffix: ']',
    placeholder: 'abc',
  },
  {
    id: 'negative-class',
    group: 'characters',
    label: '[^]',
    description: 'Negated character class',
    prefix: '[^',
    suffix: ']',
    placeholder: 'abc',
  },
  { id: 'line-start', group: 'anchors', label: '^', description: 'Start of line', text: '^' },
  { id: 'line-end', group: 'anchors', label: '$', description: 'End of line', text: '$' },
  {
    id: 'word-boundary',
    group: 'anchors',
    label: '\\b',
    description: 'Word boundary',
    text: '\\b',
  },
  { id: 'zero-more', group: 'quantifiers', label: '*', description: 'Zero or more', text: '*' },
  { id: 'one-more', group: 'quantifiers', label: '+', description: 'One or more', text: '+' },
  { id: 'optional', group: 'quantifiers', label: '?', description: 'Zero or one', text: '?' },
  {
    id: 'exact-count',
    group: 'quantifiers',
    label: '{n}',
    description: 'Exactly n times',
    text: '{n}',
    placeholderStart: 1,
    placeholderEnd: 2,
  },
  {
    id: 'count-range',
    group: 'quantifiers',
    label: '{n,m}',
    description: 'Between n and m times',
    text: '{n,m}',
    placeholderStart: 1,
    placeholderEnd: 4,
  },
  {
    id: 'capture',
    group: 'groups',
    label: '()',
    description: 'Capturing group',
    prefix: '(',
    suffix: ')',
    placeholder: 'expression',
  },
  {
    id: 'non-capture',
    group: 'groups',
    label: '(?:)',
    description: 'Non-capturing group',
    prefix: '(?:',
    suffix: ')',
    placeholder: 'expression',
  },
  { id: 'alternation', group: 'groups', label: '|', description: 'Alternation', text: '|' },
  {
    id: 'positive-lookahead',
    group: 'lookaround',
    label: '(?=)',
    description: 'Positive lookahead',
    prefix: '(?=',
    suffix: ')',
    placeholder: 'expression',
  },
  {
    id: 'negative-lookahead',
    group: 'lookaround',
    label: '(?!)',
    description: 'Negative lookahead',
    prefix: '(?!',
    suffix: ')',
    placeholder: 'expression',
  },
  {
    id: 'positive-lookbehind',
    group: 'lookaround',
    label: '(?<=)',
    description: 'Positive lookbehind',
    prefix: '(?<=',
    suffix: ')',
    placeholder: 'expression',
  },
  {
    id: 'negative-lookbehind',
    group: 'lookaround',
    label: '(?<!)',
    description: 'Negative lookbehind',
    prefix: '(?<!',
    suffix: ')',
    placeholder: 'expression',
  },
];

export function createRegexSnippetEdit(
  value: string,
  selectionStart: number | null | undefined,
  selectionEnd: number | null | undefined,
  snippet: RegexSnippet
): RegexSnippetEdit {
  const length = value.length;
  let rangeStart = clampPosition(selectionStart, length);
  let rangeEnd = clampPosition(selectionEnd ?? selectionStart, length);
  if (rangeEnd < rangeStart) {
    [rangeStart, rangeEnd] = [rangeEnd, rangeStart];
  }

  const selectedText = value.slice(rangeStart, rangeEnd);
  let replacement: string;
  let relativeSelectionStart: number;
  let relativeSelectionEnd: number;

  if ('prefix' in snippet) {
    const inner = selectedText || snippet.placeholder;
    replacement = `${snippet.prefix}${inner}${snippet.suffix}`;
    relativeSelectionStart = snippet.prefix.length;
    relativeSelectionEnd = relativeSelectionStart + inner.length;
  } else {
    replacement = snippet.text;
    const hasPlaceholder =
      snippet.placeholderStart !== undefined && snippet.placeholderEnd !== undefined;
    relativeSelectionStart = hasPlaceholder ? snippet.placeholderStart! : replacement.length;
    relativeSelectionEnd = hasPlaceholder ? snippet.placeholderEnd! : replacement.length;
  }

  return {
    value: value.slice(0, rangeStart) + replacement + value.slice(rangeEnd),
    replacement,
    rangeStart,
    rangeEnd,
    selectionStart: rangeStart + relativeSelectionStart,
    selectionEnd: rangeStart + relativeSelectionEnd,
  };
}

function clampPosition(position: number | null | undefined, length: number): number {
  if (typeof position !== 'number' || !Number.isFinite(position)) {
    return length;
  }
  return Math.max(0, Math.min(length, Math.trunc(position)));
}
