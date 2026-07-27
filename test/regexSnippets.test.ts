import * as assert from 'assert';
import {
  createRegexSnippetEdit,
  REGEX_SNIPPETS,
  RegexSnippet,
} from '../src/ui/regexSnippets';

function snippet(id: string): RegexSnippet {
  const found = REGEX_SNIPPETS.find((candidate) => candidate.id === id);
  assert.ok(found, `missing snippet ${id}`);
  return found;
}

assert.deepStrictEqual(createRegexSnippetEdit('abc', 1, 1, snippet('digit')), {
  value: 'a\\dbc',
  replacement: '\\d',
  rangeStart: 1,
  rangeEnd: 1,
  selectionStart: 3,
  selectionEnd: 3,
});

assert.deepStrictEqual(createRegexSnippetEdit('prefix name suffix', 7, 11, snippet('capture')), {
  value: 'prefix (name) suffix',
  replacement: '(name)',
  rangeStart: 7,
  rangeEnd: 11,
  selectionStart: 8,
  selectionEnd: 12,
});

const placeholder = createRegexSnippetEdit('^', 1, 1, snippet('positive-lookahead'));
assert.strictEqual(placeholder.value, '^(?=expression)');
assert.strictEqual(
  placeholder.value.slice(placeholder.selectionStart, placeholder.selectionEnd),
  'expression'
);

const countPlaceholder = createRegexSnippetEdit('', 0, 0, snippet('count-range'));
assert.strictEqual(countPlaceholder.value, '{n,m}');
assert.strictEqual(
  countPlaceholder.value.slice(countPlaceholder.selectionStart, countPlaceholder.selectionEnd),
  'n,m'
);

assert.deepStrictEqual(createRegexSnippetEdit('abc', -50, 500, snippet('word-boundary')), {
  value: '\\b',
  replacement: '\\b',
  rangeStart: 0,
  rangeEnd: 3,
  selectionStart: 2,
  selectionEnd: 2,
});

assert.deepStrictEqual(createRegexSnippetEdit('abc', undefined, undefined, snippet('line-end')), {
  value: 'abc$',
  replacement: '$',
  rangeStart: 3,
  rangeEnd: 3,
  selectionStart: 4,
  selectionEnd: 4,
});

console.log('regexSnippets.test.ts: all passed');
