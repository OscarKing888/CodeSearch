import * as assert from 'assert';
import {
  parseQuery,
  buildFtsMatch,
  parseAgeValue,
  highlightQuery,
  contentMatchesFilter,
  pathMatchesFilter,
  unescapeQueryString,
} from '../src/search/QueryParser';
import { findLooseHits } from '../src/search/LooseSearch';
import { fuzzyMatch } from '../src/search/FuzzyMatch';
import { findWildcardHits } from '../src/search/WildcardMatcher';

// Age parsing
assert.strictEqual(parseAgeValue('30m'), 30 * 60 * 1000);
assert.strictEqual(parseAgeValue('2h'), 2 * 60 * 60 * 1000);
assert.strictEqual(parseAgeValue('1d'), 24 * 60 * 60 * 1000);

// Basic query
const q1 = parseQuery('myVar ext:cpp', true);
assert.deepStrictEqual(q1.terms, ['myVar']);
assert.deepStrictEqual(q1.filters.extInclude, ['cpp']);

// Exclude filter
const q2 = parseQuery('test -file:ChangeLog dir:utils', true);
assert.deepStrictEqual(q2.filters.fileExclude, ['ChangeLog']);
assert.deepStrictEqual(q2.filters.dirInclude, ['utils']);

// CSV extensions, token boundaries, quoting, and case-insensitive filter names
const qCsv = parseQuery('symbol EXT:h,.cpp,*.inc -ext:bak,tmp', true);
assert.deepStrictEqual(qCsv.filters.extInclude, ['h', 'cpp', 'inc']);
assert.deepStrictEqual(qCsv.filters.extExclude, ['bak', 'tmp']);

const qQuotedFilter = parseQuery('symbol file:"My File?.cpp" dir:"Source Code/**"', true);
assert.deepStrictEqual(qQuotedFilter.filters.fileInclude, ['My File?.cpp']);
assert.deepStrictEqual(qQuotedFilter.filters.dirInclude, ['Source Code/**']);
assert.deepStrictEqual(
  parseQuery('alpha ext:cpp beta +"required text" gamma', true).terms,
  ['alpha beta gamma'],
  'removing filters must not inject extra spaces into phrase searches'
);

assert.deepStrictEqual(parseQuery('context:ts C++ foo-bar', false).terms, [
  'context:ts',
  'C++',
  'foo-bar',
]);
assert.deepStrictEqual(parseQuery('"literal ext:ts"', true).filters.extInclude, []);
const escapedQuoteFilter = parseQuery(String.raw`needle\" ext:ts`, false);
assert.deepStrictEqual(escapedQuoteFilter.filters.extInclude, ['ts']);
assert.deepStrictEqual(escapedQuoteFilter.terms, ['needle"']);
const invalidAge = parseQuery('age:nope', true);
assert.strictEqual(invalidAge.filterOnly, false);
assert.deepStrictEqual(invalidAge.terms, ['age:nope']);

// Phrase
const q3 = parseQuery('"int myVar"', false);
assert.deepStrictEqual(q3.terms, ['int myVar']);
assert.strictEqual(q3.phrase, true);

// Filter only
const q4 = parseQuery('file:*test* ext:ts', true);
assert.strictEqual(q4.filterOnly, true);

// FTS build
assert.strictEqual(buildFtsMatch(['hello'], true), '"hello"');
assert.strictEqual(buildFtsMatch(['foo*'], false), 'foo*');
assert.strictEqual(buildFtsMatch(['a', 'b'], false, true), 'a OR b');

// Loose prefix
const q5 = parseQuery('loose50:"parse query"', true);
assert.strictEqual(q5.loose, true);
assert.strictEqual(q5.looseGap, 50);
assert.deepStrictEqual(q5.terms, ['parse query']);

// Content filters
const q6 = parseQuery('find +"only this" -"not this"', true);
assert.deepStrictEqual(q6.filters.contentInclude, ['only this']);
assert.deepStrictEqual(q6.filters.contentExclude, ['not this']);
const quotedFilterLikeContent = parseQuery('find -"ext:ts" -"file:name"', true);
assert.deepStrictEqual(quotedFilterLikeContent.filters.contentExclude, [
  'ext:ts',
  'file:name',
]);

const repeatedAge = parseQuery('age:30d age:7d -age:14d -age:2d', true);
assert.strictEqual(repeatedAge.filters.ageMaxMs, 30 * 24 * 60 * 60 * 1000);
assert.strictEqual(repeatedAge.filters.ageMinMs, 14 * 24 * 60 * 60 * 1000);

// Escape sequences
assert.strictEqual(unescapeQueryString('\\"AbleCore\\"'), '"AbleCore"');
assert.strictEqual(unescapeQueryString('\\\\'), '\\');

const qEsc1 = parseQuery('\\"AbleCore\\"', true);
assert.deepStrictEqual(qEsc1.terms, ['"AbleCore"']);
assert.strictEqual(qEsc1.phrase, true);

const qEsc2 = parseQuery('"\\"AbleCore\\""', true);
assert.deepStrictEqual(qEsc2.terms, ['"AbleCore"']);
assert.strictEqual(qEsc2.phrase, true);

const qEsc3 = parseQuery('find +\\"only\\"', true);
assert.deepStrictEqual(qEsc3.terms, ['find']);
assert.deepStrictEqual(qEsc3.filters.contentInclude, ['"only"']);

assert.strictEqual(buildFtsMatch(['"AbleCore"'], true), '"""AbleCore"""');

// Multi wildcard
const q7 = parseQuery('"this * that"', true);
assert.strictEqual(q7.multiWildcard, true);

// Regex mode keeps the raw pattern and parses only a trailing filter suffix.
const regexQuery = parseQuery(
  '^class\\s+\\w+ ext:h,cpp -dir:**/Generated/**',
  true,
  10,
  true
);
assert.deepStrictEqual(regexQuery.terms, ['^class\\s+\\w+']);
assert.deepStrictEqual(regexQuery.filters.extInclude, ['h', 'cpp']);
assert.deepStrictEqual(regexQuery.filters.dirExclude, ['**/Generated/**']);
assert.deepStrictEqual(
  parseQuery('ext:literal followed-by-text', true, 10, true).filters.extInclude,
  []
);
assert.deepStrictEqual(
  parseQuery('  padded pattern  ', true, 10, true).terms,
  ['  padded pattern  '],
  'regex patterns without filters should preserve leading and trailing whitespace'
);
const regexWithQuote = parseQuery('"\\s+value ext:ts', true, 10, true);
assert.deepStrictEqual(regexWithQuote.terms, ['"\\s+value']);
assert.deepStrictEqual(
  regexWithQuote.filters.extInclude,
  ['ts'],
  'quotes inside a regex must not hide trailing filters'
);

// Highlight segments
const segs = highlightQuery('myVar ext:cpp -file:log');
assert.ok(segs.some((s) => s.kind === 'filter-include'));
assert.ok(segs.some((s) => s.kind === 'filter-exclude'));

const escSegs = highlightQuery('find +\\"only\\"');
assert.ok(escSegs.some((s) => s.kind === 'quoted' || s.kind === 'filter-include'));
const boundarySegs = highlightQuery('context:ts EXT:cpp');
assert.strictEqual(
  boundarySegs.filter((segment) => segment.kind === 'filter-include').length,
  1
);
assert.ok(
  highlightQuery(String.raw`needle\" ext:ts`).some(
    (segment) => segment.kind === 'filter-include' && segment.text === 'ext:ts'
  )
);

// Loose search
const looseHits = findLooseHits('Query q = parse(input);', ['parse', 'query'], 10, false, false);
assert.ok(looseHits.length >= 1);

// Fuzzy
assert.strictEqual(fuzzyMatch('color', 'colour', false), true);
assert.strictEqual(fuzzyMatch('definitely', 'definately', false), true);

// Wildcard
const wcHits = findWildcardHits('this is a test that works', 'this * that', false);
assert.ok(wcHits.length >= 1);

// Content filter
assert.strictEqual(
  contentMatchesFilter('hello world', { contentInclude: ['world'], contentExclude: ['bad'] } as never, false),
  true
);

// Safe standard glob matching and mapped-path compatibility.
const baseFilters = {
  extInclude: [],
  extExclude: [],
  dirInclude: [],
  dirExclude: [],
  fileInclude: [],
  fileExclude: [],
  contentInclude: [],
  contentExclude: [],
};
assert.strictEqual(
  pathMatchesFilter(
    'C:/Project/src/ui/Actor.cpp',
    'cpp',
    'C:/Project/src/ui',
    { ...baseFilters, fileInclude: ['*Actor.?pp'], dirInclude: ['src/**'] },
  ),
  true
);
assert.strictEqual(
  pathMatchesFilter(
    'C:/Project/src/ui/C++[Actor].cpp',
    'cpp',
    'C:/Project/src/ui',
    { ...baseFilters, fileInclude: ['C++[Actor].cpp'] },
  ),
  true
);
assert.strictEqual(
  pathMatchesFilter(
    '/remote/root/source.cpp',
    'cpp',
    '/remote/root',
    { ...baseFilters, dirInclude: ['**/virtual'], fileInclude: ['**/virtual/source.cpp'] },
    'D:/mapped/virtual/source.cpp'
  ),
  true
);
assert.strictEqual(
  pathMatchesFilter(
    'C:/Project/src/generated/Actor.cpp',
    'cpp',
    'C:/Project/src/generated',
    { ...baseFilters, dirExclude: ['*Generated*'] },
  ),
  false
);
assert.strictEqual(
  pathMatchesFilter(
    'C:\\Project\\src\\nested\\Actor.cpp',
    '.CPP',
    'C:\\Project\\src\\nested',
    { ...baseFilters, fileInclude: ['src\\*.cpp'] },
  ),
  false,
  '* must not cross a directory separator'
);
assert.strictEqual(
  pathMatchesFilter(
    '/root/src/a/b/Actor.cpp',
    'cpp',
    '/root/src/a/b',
    { ...baseFilters, dirInclude: ['src/*'] },
  ),
  false,
  'dir:src/* must not implicitly include deeper descendants'
);
assert.strictEqual(
  pathMatchesFilter(
    '/root/src/a/b/Actor.cpp',
    'cpp',
    '/root/src/a/b',
    { ...baseFilters, dirInclude: ['src/**'] },
  ),
  true,
  'dir:src/** should include deeper descendants'
);
assert.strictEqual(
  pathMatchesFilter(
    'C:\\Project\\src\\nested\\Actor.cpp',
    '.CPP',
    'C:\\Project\\src\\nested',
    { ...baseFilters, fileInclude: ['src\\**\\Actor.?pp'] },
  ),
  true,
  '** and ? should work with Windows separators'
);
assert.strictEqual(
  pathMatchesFilter(
    '/root/src/A.ts',
    'ts',
    '/root/src',
    { ...baseFilters, fileInclude: ['/src/A.ts'] },
  ),
  true,
  'a leading slash in file: should still use path-suffix semantics'
);
assert.strictEqual(
  pathMatchesFilter(
    'C:/Project/src/generated.cpp',
    'cpp',
    'C:/Project/src',
    { ...baseFilters, dirInclude: ['generated'] },
  ),
  false,
  'dir: must inspect directories rather than the file name'
);
assert.strictEqual(
  pathMatchesFilter(
    'C:/Project/src/Actor.cpp',
    'cpp',
    'C:/Project/src',
    {
      ...baseFilters,
      extInclude: ['h', 'cpp'],
      extExclude: ['CPP'],
    },
  ),
  false,
  'a matching exclusion must override an inclusion'
);

console.log('All QueryParser / Phase2 tests passed');
