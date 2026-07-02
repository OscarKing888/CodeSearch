import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isBinaryBuffer,
  isBinaryExtension,
  isUnderRoot,
  shouldIndexFile,
  shouldPathRemainInIndex,
  walkDirectory,
} from '../src/index/FileScanner';
import { DEFAULT_INDEXING_SETTINGS } from '../src/indexingSettings';
import { pruneNestedRoots } from '../src/index/workspaceRoots';

function testPruneNestedRoots(): void {
  const parent = 'E:/prj/dev';
  const child = 'E:/prj/dev/xiawan/Source';
  const other = 'E:/prj/dev/xiawan/Plugins';
  const pruned = pruneNestedRoots([parent, child, other]);
  assert.strictEqual(pruned.length, 2);
  assert.ok(!pruned.includes(path.resolve(parent)));
  assert.ok(pruned.includes(path.resolve(child)));
  assert.ok(pruned.includes(path.resolve(other)));
}

function testBinaryExtension(): void {
  assert.strictEqual(isBinaryExtension('foo.uasset'), true);
  assert.strictEqual(isBinaryExtension('foo.cpp'), false);
}

function testIsBinaryBufferUeLike(): void {
  const sample = Buffer.alloc(256);
  sample.write('SetLifeSpan', 0, 'ascii');
  for (let i = 64; i < 256; i++) {
    sample[i] = i % 32;
  }
  assert.strictEqual(isBinaryBuffer(sample), true);
}

function testShouldIndexFileRejectsUasset(): void {
  const config = { ...DEFAULT_INDEXING_SETTINGS };
  assert.strictEqual(shouldIndexFile('C:/proj/Content/Foo.uasset', config, 1024), false);
  assert.strictEqual(shouldIndexFile('C:/proj/Source/Foo.cpp', config, 1024), true);
}

async function testContentDirExcludedFromParentRoot(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-content-'));
  const content = path.join(tmpDir, 'Content');
  const asset = path.join(content, 'BP.uasset');
  const source = path.join(tmpDir, 'Source');
  fs.mkdirSync(content, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(asset, 'binary');
  fs.writeFileSync(path.join(source, 'Game.cpp'), 'void Foo() {}');

  const config = { ...DEFAULT_INDEXING_SETTINGS };
  const files: string[] = [];
  for await (const filePath of walkDirectory(tmpDir, config)) {
    files.push(filePath);
  }

  assert.strictEqual(files.length, 1);
  assert.ok(files[0].endsWith('Game.cpp'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function testContentPythonRootStillIndexed(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-py-'));
  const pyFile = path.join(tmpDir, 'script.py');
  fs.writeFileSync(pyFile, 'print("ok")');

  const config = { ...DEFAULT_INDEXING_SETTINGS };
  const files: string[] = [];
  for await (const filePath of walkDirectory(tmpDir, config)) {
    files.push(filePath);
  }

  assert.strictEqual(files.length, 1);
  assert.ok(files[0].endsWith('script.py'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function testShouldPathRemainInIndex(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-remain-'));
  const vendorDir = path.join(tmpDir, 'vendor');
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.mkdirSync(srcDir, { recursive: true });
  const vendorFile = path.join(vendorDir, 'secret.ts');
  const keepFile = path.join(srcDir, 'keep.ts');
  fs.writeFileSync(vendorFile, 'const x = 1;');
  fs.writeFileSync(keepFile, 'const y = 2;');

  const config = {
    ...DEFAULT_INDEXING_SETTINGS,
    excludeDirNames: [...DEFAULT_INDEXING_SETTINGS.excludeDirNames, 'vendor'],
  };

  assert.strictEqual(isUnderRoot(keepFile, [tmpDir]), true);
  assert.strictEqual(isUnderRoot(vendorFile, [tmpDir]), true);
  assert.strictEqual(isUnderRoot('C:/other/file.ts', [tmpDir]), false);

  assert.strictEqual(await shouldPathRemainInIndex(keepFile, [tmpDir], config), true);
  assert.strictEqual(await shouldPathRemainInIndex(vendorFile, [tmpDir], config), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  testPruneNestedRoots();
  testBinaryExtension();
  testIsBinaryBufferUeLike();
  testShouldIndexFileRejectsUasset();
  await testContentDirExcludedFromParentRoot();
  await testContentPythonRootStillIndexed();
  await testShouldPathRemainInIndex();
  console.log('fileScanner / workspaceRoots tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
