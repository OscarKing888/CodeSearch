import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isExcludedDir,
  isExcludedFile,
  isPathIgnored,
  matchesName,
  mergeIndexingSettings,
  parsePatternLines,
} from '../src/index/excludePatterns';
import { DEFAULT_INDEXING_SETTINGS } from '../src/indexingSettings';
import { walkDirectory } from '../src/index/FileScanner';

function testMatchesName(): void {
  assert.strictEqual(matchesName('Intermediate', ['Intermediate']), true);
  assert.strictEqual(matchesName('DerivedDataCache', ['Derived*']), true);
  assert.strictEqual(matchesName('foo.cpp', ['*.pdb']), false);
  assert.strictEqual(matchesName('app.pdb', ['*.pdb']), true);
}

function testIsExcludedDir(): void {
  const settings = {
    excludeDirNames: ['Intermediate', '.vscode', 'Derived*'],
    excludeFileNames: [],
    excludeGlobs: [],
    includeGlobs: ['**/*'],
    maxFileSizeKB: 2048,
  };
  assert.strictEqual(isExcludedDir('Intermediate', settings), true);
  assert.strictEqual(isExcludedDir('src', settings), false);
  assert.strictEqual(isExcludedDir('DerivedDataCache', settings), true);
}

function testIsExcludedFile(): void {
  const settings = {
    excludeDirNames: [],
    excludeFileNames: ['*.pdb', 'package-lock.json'],
    excludeGlobs: ['**/temp/**'],
    includeGlobs: ['**/*'],
    maxFileSizeKB: 2048,
  };
  assert.strictEqual(isExcludedFile('C:/proj/foo.pdb', settings), true);
  assert.strictEqual(isExcludedFile('C:/proj/foo.cpp', settings), false);
  assert.strictEqual(isExcludedFile('C:/proj/temp/foo.cpp', settings), true);
  assert.strictEqual(isExcludedFile('C:\\proj\\foo.pdb', settings), true);
}

function testIsPathIgnored(): void {
  const settings = {
    excludeDirNames: ['Intermediate'],
    excludeFileNames: ['*.pdb'],
    excludeGlobs: ['**/node_modules/**'],
    includeGlobs: ['**/*'],
    maxFileSizeKB: 2048,
  };
  assert.strictEqual(isPathIgnored('C:/proj/Intermediate/foo.cpp', settings), true);
  assert.strictEqual(isPathIgnored('C:/proj/src/foo.pdb', settings), true);
  assert.strictEqual(isPathIgnored('C:/proj/node_modules/pkg/index.js', settings), true);
  assert.strictEqual(isPathIgnored('C:/proj/src/foo.cpp', settings), false);
}

function testMergeIndexingSettings(): void {
  const merged = mergeIndexingSettings(DEFAULT_INDEXING_SETTINGS, {
    excludeDirNames: ['CustomDir'],
    excludeFileNames: ['*.log'],
    excludeGlobs: ['**/vendor/**'],
  });
  assert.ok(merged.excludeDirNames.includes('Intermediate'));
  assert.ok(merged.excludeDirNames.includes('CustomDir'));
  assert.ok(merged.excludeFileNames.includes('*.pdb'));
  assert.ok(merged.excludeFileNames.includes('*.log'));
  assert.ok(merged.excludeGlobs.includes('**/node_modules/**'));
  assert.ok(merged.excludeGlobs.includes('**/vendor/**'));
}

function testParsePatternLines(): void {
  const patterns = parsePatternLines('# comment\nIntermediate\n\n*.pdb\n');
  assert.deepStrictEqual(patterns, ['Intermediate', '*.pdb']);
}

async function testWalkDirectorySkipsExcluded(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-exclude-'));
  const intermediate = path.join(tmpDir, 'Intermediate');
  const src = path.join(tmpDir, 'src');
  fs.mkdirSync(intermediate, { recursive: true });
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(intermediate, 'skip.ts'), 'const skip = 1;');
  fs.writeFileSync(path.join(src, 'keep.ts'), 'const keep = 1;');

  const config = {
    excludeDirNames: ['Intermediate'],
    excludeFileNames: [],
    excludeGlobs: [],
    includeGlobs: ['**/*'],
    maxFileSizeKB: 2048,
  };

  const files: string[] = [];
  for await (const filePath of walkDirectory(tmpDir, config)) {
    files.push(filePath);
  }

  assert.strictEqual(files.length, 1);
  assert.ok(files[0].endsWith('keep.ts'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  testMatchesName();
  testIsExcludedDir();
  testIsExcludedFile();
  testIsPathIgnored();
  testMergeIndexingSettings();
  testParsePatternLines();
  await testWalkDirectorySkipsExcluded();
  console.log('excludePatterns tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
