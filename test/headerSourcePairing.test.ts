import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexService } from '../src/index/IndexService';
import {
  alternatePublicPrivateDirs,
  extFromPath,
  isHeaderSourceFile,
  rankCounterparts,
  stemFromPath,
  topTiedCounterparts,
} from '../src/pairing/headerSourcePairing';

function testStemAndExt(): void {
  assert.strictEqual(stemFromPath('C:/proj/Foo.cpp'), 'Foo');
  assert.strictEqual(extFromPath('C:/proj/Foo.hpp'), 'hpp');
  assert.strictEqual(isHeaderSourceFile('C:/proj/Foo.ts'), false);
  assert.strictEqual(isHeaderSourceFile('C:/proj/Foo.cpp'), true);
}

function testPublicPrivateDirs(): void {
  assert.deepStrictEqual(alternatePublicPrivateDirs('C:/Game/Source/Module/Public'), [
    'C:/Game/Source/Module/Private',
  ]);
  assert.deepStrictEqual(alternatePublicPrivateDirs('C:/Game/Source/Module/Private/Utils'), [
    'C:/Game/Source/Module/Public/Utils',
  ]);
}

function testRankCounterparts(): void {
  const current = 'C:/proj/Utils/Foo.cpp';
  const ranked = rankCounterparts(current, [
    { path: 'C:/proj/Utils/Foo.h', ext: 'h', dir: 'C:/proj/Utils' },
    { path: 'C:/proj/Utils/Foo.hpp', ext: 'hpp', dir: 'C:/proj/Utils' },
    { path: 'C:/proj/Other/Foo.h', ext: 'h', dir: 'C:/proj/Other' },
  ]);
  assert.deepStrictEqual(ranked, [
    'C:/proj/Utils/Foo.h',
    'C:/proj/Utils/Foo.hpp',
    'C:/proj/Other/Foo.h',
  ]);
}

function testTopTiedCounterparts(): void {
  const current = 'C:/proj/Utils/Foo.cpp';
  const ranked = [
    'C:/proj/Utils/Foo.h',
    'C:/proj/Utils/Foo.hpp',
    'C:/proj/Other/Foo.h',
  ];
  assert.deepStrictEqual(topTiedCounterparts(current, ranked), ['C:/proj/Utils/Foo.h']);
}

async function testIndexServicePairing(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-pairing-'));
  const dbPath = path.join(tmpDir, 'index.db');
  const sameDir = path.join(tmpDir, 'same');
  const publicDir = path.join(tmpDir, 'Module', 'Public');
  const privateDir = path.join(tmpDir, 'Module', 'Private');

  fs.mkdirSync(sameDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true });

  const fooCpp = path.join(sameDir, 'Foo.cpp');
  const fooH = path.join(sameDir, 'Foo.h');
  const barH = path.join(publicDir, 'Bar.h');
  const barCpp = path.join(privateDir, 'Bar.cpp');

  fs.writeFileSync(fooCpp, 'int foo() { return 0; }\n');
  fs.writeFileSync(fooH, 'int foo();\n');
  fs.writeFileSync(barH, 'class Bar {};\n');
  fs.writeFileSync(barCpp, '#include "Bar.h"\n');

  const index = new IndexService(dbPath);
  await index.initialize([tmpDir]);
  await index.startIndexing(true);

  assert.deepStrictEqual(index.findHeaderSourceCounterparts(fooCpp), [fooH]);
  assert.deepStrictEqual(index.findHeaderSourceCounterparts(fooH), [fooCpp]);
  assert.deepStrictEqual(index.findHeaderSourceCounterparts(barH), [barCpp]);
  assert.deepStrictEqual(index.findHeaderSourceCounterparts(barCpp), [barH]);
  assert.deepStrictEqual(index.findHeaderSourceCounterparts(path.join(sameDir, 'Missing.cpp')), []);
  assert.strictEqual(index.fileExistsInIndex(fooCpp), true);

  index.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  testStemAndExt();
  testPublicPrivateDirs();
  testRankCounterparts();
  testTopTiedCounterparts();
  await testIndexServicePairing();
  console.log('headerSourcePairing tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
