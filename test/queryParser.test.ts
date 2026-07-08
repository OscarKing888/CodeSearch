import * as assert from 'assert';
import { parseQuery, buildFtsMatch, parseAgeValue, highlightQuery, contentMatchesFilter, unescapeQueryString } from '../src/search/QueryParser';
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

// Highlight segments
const segs = highlightQuery('myVar ext:cpp -file:log');
assert.ok(segs.some((s) => s.kind === 'filter-include'));
assert.ok(segs.some((s) => s.kind === 'filter-exclude'));

const escSegs = highlightQuery('find +\\"only\\"');
assert.ok(escSegs.some((s) => s.kind === 'quoted' || s.kind === 'filter-include'));

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

console.log('All QueryParser / Phase2 tests passed');
