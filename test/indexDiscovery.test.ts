import * as assert from 'assert';
import * as path from 'path';
import {
  collectWorkspaceIndexCandidates,
  IndexRegistrySnapshot,
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

function run(): void {
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

  console.log('indexDiscovery.test.ts: all passed');
}

run();
