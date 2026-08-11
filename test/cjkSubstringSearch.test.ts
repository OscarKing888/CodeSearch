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
  options: SearchOptions
): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  for await (const batch of search.searchStreaming(query, options)) {
    hits.push(...batch.hits);
  }
  return hits;
}

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-cjk-substring-'));
  const dbPath = path.join(tmpDir, 'index.db');
  const srcDir = path.join(tmpDir, 'src');
  const otherDir = path.join(tmpDir, 'other');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });

  const cjkFile = path.join(srcDir, 'events.ts');
  fs.writeFileSync(
    cjkFile,
    [
      '// 发送区域灯光控制事件',
      'void SendAreaLightControlEvent() {}',
      'const requestAnimationFrame = window.requestAnimationFrame;',
    ].join('\n')
  );
  // Same continuous CJK blob outside the filtered dir/ext — never a standalone 灯光 token.
  const decoyFile = path.join(otherDir, 'decoy.cpp');
  fs.writeFileSync(decoyFile, '// 发送区域灯光控制事件\n');

  const index = new IndexService(dbPath);
  try {
    await index.initialize([tmpDir]);
    await index.startIndexing(true);
    const search = new SearchService(index);

    const phraseOff = { ...BASE_OPTIONS, phraseSearch: false };
    const phraseOn = { ...BASE_OPTIONS, phraseSearch: true };

    const partialOff = search.search('灯光', phraseOff);
    assert.ok(partialOff.hitCount >= 1, `phrase OFF should find 灯光, got ${partialOff.hitCount}`);
    assert.ok(
      partialOff.hits.some((hit) => hit.path === cjkFile && hit.lineText.includes('灯光')),
      'phrase OFF hit should include the CJK source line'
    );

    const partialOffStream = await collectStreamingHits(search, '灯光', phraseOff);
    assert.ok(partialOffStream.length >= 1, 'phrase OFF streaming should find 灯光');

    const partialOn = search.search('灯光', phraseOn);
    assert.strictEqual(
      partialOn.hitCount,
      0,
      'phrase ON should not FTS-match CJK substring 灯光 inside a longer token'
    );

    const fullOff = search.search('发送区域灯光控制事件', phraseOff);
    assert.ok(fullOff.hitCount >= 1, 'phrase OFF should still find the full CJK string');

    const fullOn = search.search('发送区域灯光控制事件', phraseOn);
    assert.ok(fullOn.hitCount >= 1, 'phrase ON should find the full CJK token');

    const filtered = search.search('灯光 ext:ts dir:src/**', phraseOff);
    assert.strictEqual(filtered.hitCount, 1);
    assert.strictEqual(filtered.hits[0].path, cjkFile);
    assert.ok(!filtered.hits.some((hit) => hit.path === decoyFile));
    const filteredStream = await collectStreamingHits(
      search,
      '灯光 ext:ts dir:src/**',
      phraseOff
    );
    assert.strictEqual(filteredStream.length, 1);
    assert.strictEqual(filteredStream[0].path, cjkFile);

    const asciiPartial = search.search('Animation', phraseOff);
    assert.ok(
      asciiPartial.hitCount >= 1,
      'phrase OFF should match ASCII substring inside requestAnimationFrame'
    );
    assert.ok(
      asciiPartial.hits.some((hit) => hit.lineText.includes('requestAnimationFrame')),
      'ASCII substring hit should land on requestAnimationFrame'
    );

    console.log('CJK substring search tests passed');
  } finally {
    index.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
