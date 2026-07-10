import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexService } from '../src/index/IndexService';
import {
  compareTokenSuggestions,
  finalizeTokenSuggestions,
  TOKEN_AUTOCOMPLETE_INDEX,
} from '../src/index/tokenSuggestions';

function testCompareTokenSuggestions(): void {
  assert.ok(compareTokenSuggestions({ token: 'ab', freq: 1 }, { token: 'abc', freq: 99 }) < 0);
  assert.ok(compareTokenSuggestions({ token: 'ab', freq: 50 }, { token: 'ab', freq: 10 }) < 0);
}

function testFinalizeTokenSuggestions(): void {
  const result = finalizeTokenSuggestions(
    [
      { token: 'Function', freq: 100 },
      { token: 'Fun', freq: 50 },
      { token: 'Fu', freq: 200 },
    ],
    2
  );
  assert.deepStrictEqual(result, [
    { token: 'Fu', freq: 200 },
    { token: 'Fun', freq: 50 },
  ]);
}

async function testIndexServiceTokenSuggestions(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-token-suggest-'));
  const dbPath = path.join(tmpDir, 'index.db');
  const testFile = path.join(tmpDir, 'sample.ts');
  fs.writeFileSync(
    testFile,
    [
      'function getValue() { return getValue(); }',
      'const getOther = () => getValue();',
      'function getLongerName() {}',
    ].join('\n')
  );

  const index = new IndexService(dbPath);
  await index.initialize([tmpDir]);
  await index.startIndexing(true);

  const db = index.getDatabase();
  assert.ok(db);
  const indexRow = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(TOKEN_AUTOCOMPLETE_INDEX) as { ok: number } | undefined;
  assert.ok(indexRow, 'token autocomplete index should exist after initialize');

  const suggestions = index.getTokenSuggestions('get', 5);
  assert.ok(suggestions.length > 0, 'expected suggestions for prefix get');
  for (const s of suggestions) {
    assert.ok(s.token.toLowerCase().startsWith('get'), `token ${s.token} should match prefix get`);
  }
  for (let i = 1; i < suggestions.length; i++) {
    const prev = suggestions[i - 1];
    const curr = suggestions[i];
    assert.ok(
      curr.token.length > prev.token.length ||
        (curr.token.length === prev.token.length && curr.freq <= prev.freq),
      'suggestions should be ordered by length asc, then freq desc'
    );
  }

  index.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  testCompareTokenSuggestions();
  testFinalizeTokenSuggestions();
  await testIndexServiceTokenSuggestions();
  console.log('tokenSuggestions tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
