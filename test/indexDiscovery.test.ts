import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  collectWorkspaceIndexCandidates,
  IndexRegistrySnapshot,
  loadPeerRegistryIndexes,
} from '../src/index/indexDiscovery';
import { IndexMeta } from '../src/index/types';

function makeMeta(
  id: string,
  dbPath: string,
  rootDirs: string[],
  workspaceHashes: string[],
  updatedAt: number
): IndexMeta {
  return {
    id,
    name: id,
    dbPath,
    rootDirs,
    readOnly: false,
    directoryMappings: [],
    workspaceHashes,
    createdAt: 1,
    updatedAt,
  };
}

function writeRegistry(filePath: string, indexes: IndexMeta[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ indexes }, null, 2), 'utf8');
}

async function testLoadPeerRegistryIndexes(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-peer-discovery-'));
  try {
    const localRegistry = path.join(temp, 'local', 'registry.json');
    const vscodeRegistry = path.join(temp, 'vscode', 'registry.json');
    const cursorRegistry = path.join(temp, 'cursor', 'registry.json');
    const brokenRegistry = path.join(temp, 'broken', 'registry.json');

    const sharedDb = path.join(temp, 'shared.db');
    const onlyCursorDb = path.join(temp, 'cursor-only.db');
    const onlyLocalDb = path.join(temp, 'local-only.db');
    fs.writeFileSync(sharedDb, '');
    fs.writeFileSync(onlyCursorDb, '');
    fs.writeFileSync(onlyLocalDb, '');

    writeRegistry(localRegistry, [
      makeMeta('local-only', onlyLocalDb, [temp], [], 1),
      makeMeta('local-shared', sharedDb, [temp], [], 1),
    ]);
    writeRegistry(vscodeRegistry, [
      makeMeta('vscode-shared', sharedDb, [temp], [], 5),
      makeMeta('vscode-only', path.join(temp, 'vscode-only.db'), [temp], [], 2),
    ]);
    writeRegistry(cursorRegistry, [
      makeMeta('cursor-shared', sharedDb, [temp], [], 4),
      makeMeta('cursor-only', onlyCursorDb, [temp], [], 6),
    ]);
    fs.mkdirSync(path.dirname(brokenRegistry), { recursive: true });
    fs.writeFileSync(brokenRegistry, '{ not valid json', 'utf8');

    const peers = await loadPeerRegistryIndexes(localRegistry, [
      { source: 'vscode:oscarking888.ace-code-search', path: vscodeRegistry },
      { source: 'vscode:OscarKing888.ace-code-search', path: vscodeRegistry },
      { source: 'cursor:oscarking888.ace-code-search', path: cursorRegistry },
      { source: 'broken:oscarking888.ace-code-search', path: brokenRegistry },
      { source: 'current-ide', path: localRegistry },
    ]);

    assert.ok(
      !peers.some((entry) => entry.meta.id === 'local-only' || entry.meta.id === 'local-shared'),
      'local registry entries must be excluded'
    );

    const shared = peers.find((entry) => path.resolve(entry.meta.dbPath) === path.resolve(sharedDb));
    assert.ok(shared, 'shared db from peers must appear once');
    assert.strictEqual(shared.meta.id, 'vscode-shared', 'newest updatedAt meta wins');
    assert.deepStrictEqual(
      shared.sources.sort(),
      ['cursor:oscarking888.ace-code-search', 'vscode:oscarking888.ace-code-search'].sort(),
      'duplicate candidate paths for the same registry file must not double-count sources'
    );

    const cursorOnly = peers.find(
      (entry) => path.resolve(entry.meta.dbPath) === path.resolve(onlyCursorDb)
    );
    assert.ok(cursorOnly);
    assert.strictEqual(cursorOnly.meta.id, 'cursor-only');

    const vscodeOnly = peers.find((entry) => entry.meta.id === 'vscode-only');
    assert.ok(vscodeOnly, 'peer-only indexes must appear without workspace filtering');

    assert.ok(
      !peers.some((entry) => entry.sources.some((source) => source.startsWith('broken:'))),
      'unreadable peer registries must be skipped without failing the load'
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  const root = path.resolve('test-workspace');
  const sameDb = path.resolve('test-indexes', 'shared.db');
  const missingDb = path.resolve('test-indexes', 'missing.db');
  const snapshots: IndexRegistrySnapshot[] = [
    {
      source: 'vscode',
      path: 'vscode-registry.json',
      indexes: [makeMeta('code', sameDb, [root], [], 1)],
    },
    {
      source: 'cursor',
      path: 'cursor-registry.json',
      indexes: [
        makeMeta('cursor', sameDb, [root], ['hash'], 2),
        makeMeta('legacy-only', missingDb, [path.resolve('other-workspace')], ['hash'], 3),
        makeMeta(
          'unrelated',
          path.resolve('test-indexes', 'other.db'),
          [path.resolve('other-workspace')],
          [],
          4
        ),
      ],
    },
  ];

  const candidates = collectWorkspaceIndexCandidates(snapshots, [root], 'hash');
  assert.strictEqual(candidates.length, 2);
  const shared = candidates.find((item) => item.meta.dbPath === sameDb);
  assert.ok(shared);
  assert.deepStrictEqual(shared.sources.sort(), ['cursor', 'vscode']);
  assert.strictEqual(shared.exactRoots, true);
  assert.strictEqual(shared.legacyHashMatch, true);
  assert.strictEqual(shared.meta.id, 'cursor');
  assert.ok(!candidates.some((item) => item.meta.id === 'unrelated'));

  await testLoadPeerRegistryIndexes();

  console.log('indexDiscovery.test.ts: all passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
