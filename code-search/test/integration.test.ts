import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexService } from '../src/index/IndexService';
import { SearchService } from '../src/search/SearchService';

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-test-'));
  const dbPath = path.join(tmpDir, 'index.db');
  const testFile = path.join(tmpDir, 'sample.ts');
  fs.writeFileSync(
    testFile,
    'const myVariable = 42;\nfunction parseQuery(input: string) {\n  return input;\n}\n'
  );

  const index = new IndexService(dbPath);
  await index.initialize([tmpDir]);
  await index.startIndexing(true);

  const search = new SearchService(index);
  const result = search.search('myVariable', {
    caseSensitive: false,
    phraseSearch: true,
    contextLines: 1,
    maxResults: 100,
  });

  if (result.hitCount < 1) {
    throw new Error(`Expected hits, got ${result.hitCount}`);
  }
  if (result.hits[0].path !== testFile) {
    throw new Error('Wrong file path in hit');
  }

  const filterResult = search.search('ext:ts', {
    caseSensitive: false,
    phraseSearch: true,
    contextLines: 0,
    maxResults: 100,
  });
  if (filterResult.hitCount < 1) {
    throw new Error('Filter-only search should find .ts files');
  }

  index.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('Integration test passed:', result.hitCount, 'hits in', result.elapsedMs, 'ms');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
