import * as assert from 'assert';
import * as path from 'path';
import { IndexMeta } from '../src/index/types';
import { mergeIndexCatalog } from '../src/ui/indexCatalog';

function meta(id: string, dbPath: string, name = id): IndexMeta {
  return {
    id,
    name,
    dbPath,
    rootDirs: [],
    readOnly: true,
    directoryMappings: [],
    workspaceHashes: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function run(): void {
  const root = path.resolve('index-catalog-test');
  const activePath = path.join(root, 'active.db');
  const availablePath = path.join(root, 'available.db');

  const activeAfterPeerDelete = mergeIndexCatalog(
    [meta('available', availablePath)],
    [meta('active', activePath)]
  );
  assert.deepStrictEqual(
    activeAfterPeerDelete.map((item) => item.id),
    ['active', 'available'],
    'an active service must remain visible after its registry row is deleted'
  );

  const activeWinsDuplicates = mergeIndexCatalog(
    [
      meta('active', path.join(root, 'moved-in-registry.db'), 'stale id'),
      meta('duplicate-path', activePath, 'stale path'),
      meta('available', availablePath),
    ],
    [meta('active', activePath, 'active service')]
  );
  assert.deepStrictEqual(
    activeWinsDuplicates.map((item) => [item.id, item.name]),
    [
      ['active', 'active service'],
      ['available', 'available'],
    ],
    'active services must win both id and physical-path collisions without duplicate cards'
  );

  const duplicateRegistryPaths = mergeIndexCatalog(
    [meta('first', availablePath), meta('second', availablePath)],
    []
  );
  assert.deepStrictEqual(
    duplicateRegistryPaths.map((item) => item.id),
    ['first'],
    'duplicate catalog rows for one physical database must render once'
  );

  console.log('indexCatalog tests passed');
}

run();
