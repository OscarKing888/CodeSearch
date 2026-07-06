import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexService } from '../src/index/IndexService';
import { SearchService } from '../src/search/SearchService';

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-purge-'));
  const dbPath = path.join(tmpDir, 'index.db');
  const srcDir = path.join(tmpDir, 'src');
  const vendorDir = path.join(tmpDir, 'vendor');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(vendorDir, { recursive: true });

  const keepFile = path.join(srcDir, 'keep.ts');
  const secretFile = path.join(vendorDir, 'secret.ts');
  fs.writeFileSync(keepFile, 'const keepKeyword = 1;\n');
  fs.writeFileSync(secretFile, 'const secretKeyword = 2;\n');

  const index = new IndexService(dbPath);
  await index.initialize([tmpDir]);
  await index.startIndexing(true);

  const searchOptions = {
    caseSensitive: false,
    phraseSearch: true,
    contextLines: 0,
    maxResults: 100,
    fuzzy: false,
    loose: false,
    looseGap: 10,
  };

  const search = new SearchService(index);
  let result = search.search('secretKeyword', searchOptions);
  assert.strictEqual(result.hitCount, 1, 'secret file should be indexed initially');

  index.setPerIndexExcludes({ excludeDirNames: ['vendor'] });
  await index.refresh(true);

  const db = index.getDatabase();
  assert.ok(db, 'database should be open');
  const secretRow = db.prepare('SELECT path FROM files WHERE path = ?').get(secretFile);
  assert.strictEqual(secretRow, undefined, 'excluded file should be purged from database');

  const keepRow = db.prepare('SELECT path FROM files WHERE path = ?').get(keepFile);
  assert.ok(keepRow, 'non-excluded file should remain in database');

  result = search.search('secretKeyword', searchOptions);
  assert.strictEqual(result.hitCount, 0, 'purged file should not appear in search results');

  const keepResult = search.search('keepKeyword', searchOptions);
  assert.strictEqual(keepResult.hitCount, 1, 'remaining file should still be searchable');

  index.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('purgeStaleEntries tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
