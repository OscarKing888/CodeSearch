import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexService } from '../src/index/IndexService';
import { SearchService } from '../src/search/SearchService';
import { SearchHit, SearchOptions } from '../src/types';

const BASE_OPTIONS: SearchOptions = {
  caseSensitive: false,
  phraseSearch: true,
  contextLines: 0,
  maxResults: 100,
  fuzzy: false,
  loose: false,
  looseGap: 10,
  regex: false,
};

async function collectStreamingHits(
  search: SearchService,
  query: string,
  options: SearchOptions,
  signal?: AbortSignal
): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  for await (const batch of search.searchStreaming(query, options, signal)) {
    hits.push(...batch.hits);
  }
  return hits;
}

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-filters-regex-'));
  const dbPath = path.join(tmpDir, 'index.db');
  const srcDir = path.join(tmpDir, 'src', 'nested');
  const generatedDir = path.join(tmpDir, 'Generated');
  const decoyDir = path.join(tmpDir, 'decoys');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.mkdirSync(decoyDir, { recursive: true });

  for (let i = 0; i < 12; i++) {
    fs.writeFileSync(
      path.join(decoyDir, `a${String(i).padStart(2, '0')}.ts`),
      [
        'const limitNeedle = true;',
        'limit filler Needle',
        'fallback:token',
      ].join('\n')
    );
  }
  const targetCpp = path.join(decoyDir, 'z-target.cpp');
  fs.writeFileSync(
    targetCpp,
    [
      'bool limitNeedle = true;',
      'limit filler Needle',
      'fallback:token',
    ].join('\n')
  );
  const oldFallbackCpp = path.join(decoyDir, 'z-old.cpp');
  fs.writeFileSync(oldFallbackCpp, 'aged:token\n');
  const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFallbackCpp, oldTime, oldTime);

  const regexFile = path.join(srcDir, 'Regex1.ts');
  fs.writeFileSync(
    regexFile,
    [
      'class Alpha42',
      'CLASS Beta',
      'foo foo',
      'const tail = true;',
    ].join('\n')
  );
  const cancelScanFile = path.join(srcDir, 'CancelScan.ts');
  fs.writeFileSync(
    cancelScanFile,
    Array.from({ length: 500 }, (_, index) => `cancelMarker${index}`).join('\n')
  );
  fs.writeFileSync(
    path.join(generatedDir, 'C++[Actor].cpp'),
    'class GeneratedActor {}\n'
  );

  const index = new IndexService(dbPath);
  try {
    await index.initialize([tmpDir]);
    await index.startIndexing(true);
    const search = new SearchService(index);

    // Regression: the qualifying file is beyond the old maxResults * 10
    // candidate cap, so filtering must continue until a real hit is found.
    const limitedOptions = { ...BASE_OPTIONS, maxResults: 1 };
    const limited = search.search('limitNeedle ext:cpp', limitedOptions);
    assert.strictEqual(limited.hitCount, 1);
    assert.strictEqual(limited.hits[0].path, targetCpp);
    const limitedStream = await collectStreamingHits(
      search,
      'limitNeedle ext:cpp',
      limitedOptions
    );
    assert.strictEqual(limitedStream.length, 1);
    assert.strictEqual(limitedStream[0].path, targetCpp);

    const limitedLoose = search.search(
      'loose:"limit Needle" ext:cpp -file:z-old.cpp',
      limitedOptions
    );
    assert.strictEqual(limitedLoose.hitCount, 1);
    assert.strictEqual(limitedLoose.hits[0].path, targetCpp);
    const limitedLooseStream = await collectStreamingHits(
      search,
      'loose:"limit Needle" ext:cpp -file:z-old.cpp',
      limitedOptions
    );
    assert.deepStrictEqual(
      limitedLooseStream.map((hit) => hit.path),
      [targetCpp]
    );

    const limitedWildcard = search.search(
      '"limit * Needle" ext:cpp -file:z-old.cpp',
      limitedOptions
    );
    assert.strictEqual(limitedWildcard.hitCount, 1);
    assert.strictEqual(limitedWildcard.hits[0].path, targetCpp);
    const limitedWildcardStream = await collectStreamingHits(
      search,
      '"limit * Needle" ext:cpp -file:z-old.cpp',
      limitedOptions
    );
    assert.deepStrictEqual(
      limitedWildcardStream.map((hit) => hit.path),
      [targetCpp]
    );

    const limitedFilterOnly = search.search('file:z-target.cpp', limitedOptions);
    assert.strictEqual(limitedFilterOnly.hitCount, 1);
    assert.strictEqual(limitedFilterOnly.hits[0].path, targetCpp);
    const limitedFilterOnlyStream = await collectStreamingHits(
      search,
      'file:z-target.cpp',
      limitedOptions
    );
    assert.deepStrictEqual(
      limitedFilterOnlyStream.map((hit) => hit.path),
      [targetCpp]
    );

    // The colon makes FTS5 interpret a nonexistent column and enter the SQL
    // LIKE fallback. That path must stay lazy and retain age filtering.
    const limitedFallback = search.search(
      'fallback:token age:1d ext:cpp -file:z-old.cpp',
      limitedOptions
    );
    assert.strictEqual(limitedFallback.hitCount, 1);
    assert.strictEqual(limitedFallback.hits[0].path, targetCpp);
    const limitedFallbackStream = await collectStreamingHits(
      search,
      'fallback:token age:1d ext:cpp -file:z-old.cpp',
      limitedOptions
    );
    assert.deepStrictEqual(
      limitedFallbackStream.map((hit) => hit.path),
      [targetCpp]
    );
    assert.strictEqual(
      search.search('aged:token age:1d', BASE_OPTIONS).hitCount,
      0,
      'fallback must apply ageMaxMs'
    );
    assert.strictEqual(
      search.search('aged:token -age:1d', BASE_OPTIONS).hits[0]?.path,
      oldFallbackCpp,
      'fallback must apply ageMinMs'
    );

    const csv = search.search('limitNeedle ext:ts,cpp -ext:bak', BASE_OPTIONS);
    assert.ok(csv.hits.some((hit) => hit.path === targetCpp));

    const globOnly = search.search(
      'file:**/src/**/Regex?.ts dir:src/** -dir:**/Generated/**',
      BASE_OPTIONS
    );
    assert.strictEqual(globOnly.hitCount, 1);
    assert.strictEqual(globOnly.hits[0].path, regexFile);

    const regexOptions = { ...BASE_OPTIONS, regex: true };
    const regexResult = search.search(
      '^class\\s+[A-Z][A-Za-z0-9]+$ ext:ts dir:src/**',
      { ...regexOptions, caseSensitive: true }
    );
    assert.strictEqual(regexResult.hitCount, 1);
    assert.strictEqual(regexResult.hits[0].line, 1);

    const caseInsensitive = search.search('^class ext:ts', regexOptions);
    assert.strictEqual(caseInsensitive.hitCount, 2);
    const caseSensitive = search.search('^class ext:ts', {
      ...regexOptions,
      caseSensitive: true,
    });
    assert.strictEqual(caseSensitive.hitCount, 1);

    const repeated = search.search('foo ext:ts', regexOptions);
    assert.strictEqual(repeated.hitCount, 2, 'regex should return every match on a line');
    assert.deepStrictEqual(
      repeated.hits.map((hit) => hit.column),
      [1, 5]
    );

    const zeroWidth = search.search('^ ext:ts', {
      ...regexOptions,
      maxResults: 3,
    });
    assert.strictEqual(zeroWidth.hitCount, 3, 'zero-width regex must terminate');

    assert.throws(
      () => search.search('[', regexOptions),
      /invalid regular expression/i
    );
    await assert.rejects(
      () => collectStreamingHits(search, '[', regexOptions),
      /invalid regular expression/i
    );

    const streamedRegex = await collectStreamingHits(
      search,
      '^class ext:ts',
      regexOptions
    );
    assert.deepStrictEqual(
      streamedRegex.map((hit) => `${hit.path}:${hit.line}:${hit.column}`),
      caseInsensitive.hits.map((hit) => `${hit.path}:${hit.line}:${hit.column}`)
    );

    const abortController = new AbortController();
    abortController.abort();
    const cancelled = await collectStreamingHits(
      search,
      'class',
      regexOptions,
      abortController.signal
    );
    assert.deepStrictEqual(cancelled, [], 'an aborted scan must stop without yielding late hits');

    const midScanAbort = new AbortController();
    let midScanHitCount = 0;
    for await (const batch of search.searchStreaming(
      'cancelMarker\\d+ file:CancelScan.ts',
      { ...regexOptions, maxResults: 500 },
      midScanAbort.signal
    )) {
      midScanHitCount += batch.hits.length;
      if (midScanHitCount > 0) {
        midScanAbort.abort();
      }
    }
    assert.strictEqual(midScanHitCount, 50, 'mid-file cancellation should stop after the first batch');
  } finally {
    index.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('searchFiltersRegex tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
