import * as assert from 'assert';
import {
  SHARED_INDEX_ROOT_NAME,
  canonicalPathKey,
  getSharedIndexRoot,
  getSharedWorkspaceDbPath,
  getSharedWorkspaceKey,
  samePath,
} from '../src/index/sharedIndexStorage';

function testWindowsStorageRoot(): void {
  assert.strictEqual(SHARED_INDEX_ROOT_NAME, 'AceCodeSearch');
  assert.strictEqual(
    getSharedIndexRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: 'D:\\LocalData' },
      homeDir: 'C:\\Users\\alice',
    }),
    'D:\\LocalData\\AceCodeSearch'
  );

  assert.strictEqual(
    getSharedIndexRoot({
      platform: 'win32',
      env: {},
      homeDir: 'C:\\Users\\alice',
    }),
    'C:\\Users\\alice\\AppData\\Local\\AceCodeSearch'
  );

  assert.strictEqual(
    getSharedIndexRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: '   ' },
      homeDir: 'C:\\Users\\alice',
    }),
    'C:\\Users\\alice\\AppData\\Local\\AceCodeSearch'
  );
}

function testMacStorageRoot(): void {
  assert.strictEqual(
    getSharedIndexRoot({
      platform: 'darwin',
      env: { XDG_DATA_HOME: '/ignored' },
      homeDir: '/Users/alice',
    }),
    '/Users/alice/Library/Application Support/AceCodeSearch'
  );
}

function testLinuxStorageRoot(): void {
  assert.strictEqual(
    getSharedIndexRoot({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/var/lib/alice' },
      homeDir: '/home/alice',
    }),
    '/var/lib/alice/AceCodeSearch'
  );

  assert.strictEqual(
    getSharedIndexRoot({
      platform: 'linux',
      env: {},
      homeDir: '/home/alice',
    }),
    '/home/alice/.local/share/AceCodeSearch'
  );
}

function testWorkspaceDbPath(): void {
  assert.strictEqual(
    getSharedWorkspaceDbPath('abc123', {
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Data' },
      homeDir: 'C:\\Users\\alice',
    }),
    'C:\\Data\\AceCodeSearch\\indexes\\abc123\\index.db'
  );

  assert.strictEqual(
    getSharedWorkspaceDbPath('def456', {
      platform: 'linux',
      env: { XDG_DATA_HOME: '/data/alice' },
      homeDir: '/home/alice',
    }),
    '/data/alice/AceCodeSearch/indexes/def456/index.db'
  );
}

function testWindowsPathComparison(): void {
  const mixed = canonicalPathKey(
    'C:\\Work\\Project\\src\\..\\INDEX.db',
    'win32'
  );
  assert.strictEqual(mixed, 'c:\\work\\project\\index.db');
  assert.strictEqual(
    samePath(
      'C:\\Work\\Project\\index.db',
      'c:/work/project/INDEX.db\\',
      'win32'
    ),
    true
  );
}

function testWorkspaceKeyUsesCanonicalUnorderedRoots(): void {
  const first = getSharedWorkspaceKey(
    ['C:\\Work\\Project', 'D:\\SDK'],
    'win32'
  );
  const same = getSharedWorkspaceKey(
    ['d:/sdk/', 'c:/work/project'],
    'win32'
  );
  const different = getSharedWorkspaceKey(['C:\\Work\\Other'], 'win32');
  assert.strictEqual(first, same);
  assert.notStrictEqual(first, different);
  assert.match(first, /^[a-f0-9]{24}$/);
}

function testPosixPathComparisonRetainsCase(): void {
  assert.strictEqual(
    canonicalPathKey('/work/project/src/../index.db', 'linux'),
    '/work/project/index.db'
  );
  assert.strictEqual(
    samePath('/work/Project/index.db', '/work/project/index.db', 'linux'),
    false
  );
  assert.strictEqual(
    samePath('/Users/alice/Repo', '/Users/alice/repo', 'darwin'),
    false
  );
  assert.strictEqual(
    samePath('/work/project/', '/work/project', 'linux'),
    true
  );
}

function run(): void {
  testWindowsStorageRoot();
  testMacStorageRoot();
  testLinuxStorageRoot();
  testWorkspaceDbPath();
  testWindowsPathComparison();
  testWorkspaceKeyUsesCanonicalUnorderedRoots();
  testPosixPathComparisonRetainsCase();
  console.log('sharedIndexStorage.test.ts: all passed');
}

run();
