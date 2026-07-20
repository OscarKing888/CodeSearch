import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexRegistry } from '../src/index/IndexRegistry';
import { IndexMeta } from '../src/index/types';

function meta(id: string, dbPath: string, hashes: string[]): IndexMeta {
  return {
    id,
    name: id === 'primary' ? 'Primary' : id,
    dbPath,
    rootDirs: [],
    readOnly: id !== 'primary',
    directoryMappings: [],
    workspaceHashes: hashes,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function testStaleManagersMergeDistinctAdds(temp: string): Promise<void> {
  const storageRoot = path.join(temp, 'concurrent-adds');
  const first = new IndexRegistry(storageRoot);
  const second = new IndexRegistry(storageRoot);
  await Promise.all([first.load(), second.load()]);

  first.upsert(meta('first', path.join(temp, 'first.db'), []));
  second.upsert(meta('second', path.join(temp, 'second.db'), []));
  // Save in a fixed order: the second manager still has the original empty
  // baseline, so a last-writer-wins implementation deterministically loses
  // `first` here.
  await first.save();
  await second.save();

  const reloaded = new IndexRegistry(storageRoot);
  await reloaded.load();
  assert.deepStrictEqual(
    reloaded.getAll().map((item) => item.id).sort(),
    ['first', 'second']
  );
}

async function testConcurrentSamePathAddsConverge(temp: string): Promise<void> {
  const storageRoot = path.join(temp, 'same-path-adds');
  const dbPath = path.join(temp, 'shared-physical-index.db');
  const first = new IndexRegistry(storageRoot);
  const second = new IndexRegistry(storageRoot);
  await Promise.all([first.load(), second.load()]);

  first.upsert(meta('first-generated-id', dbPath, []));
  second.upsert(meta('second-generated-id', path.join(temp, '.', 'shared-physical-index.db'), []));
  await first.save();
  await second.save();

  const reloaded = new IndexRegistry(storageRoot);
  await reloaded.load();
  assert.deepStrictEqual(
    reloaded.getAll().map((item) => item.id),
    ['second-generated-id'],
    'the last stale first-open save must replace the concurrent ID for the same physical DB'
  );
  assert.strictEqual(reloaded.getByDbPath(dbPath)?.id, 'second-generated-id');

  assert.strictEqual(first.rename('first-generated-id', 'Renamed by active loser'), true);
  await first.save();
  const afterFirstLoserUpdate = new IndexRegistry(storageRoot);
  await afterFirstLoserUpdate.load();
  assert.deepStrictEqual(
    afterFirstLoserUpdate.getAll().map((item) => item.id),
    ['second-generated-id'],
    'an active loser update must target the winner instead of reviving its old ID'
  );
  assert.strictEqual(
    afterFirstLoserUpdate.getById('second-generated-id')?.name,
    'Renamed by active loser'
  );

  const activeLoserMeta = meta('first-generated-id', dbPath, []);
  activeLoserMeta.name = 'Updated by active loser again';
  activeLoserMeta.directoryMappings = [{ from: path.join(temp, 'old'), to: path.join(temp, 'new') }];
  first.upsertByDbPath(activeLoserMeta);
  await first.save();
  const afterSecondLoserUpdate = new IndexRegistry(storageRoot);
  await afterSecondLoserUpdate.load();
  assert.deepStrictEqual(
    afterSecondLoserUpdate.getAll().map((item) => item.id),
    ['second-generated-id'],
    'later active loser upserts must remain converged on the winner ID'
  );
  assert.strictEqual(
    afterSecondLoserUpdate.getById('second-generated-id')?.name,
    'Updated by active loser again'
  );
  assert.deepStrictEqual(
    afterSecondLoserUpdate.getById('second-generated-id')?.directoryMappings,
    activeLoserMeta.directoryMappings
  );
}

async function testPreExistingSamePathEntriesRemainCompatible(temp: string): Promise<void> {
  const storageRoot = path.join(temp, 'legacy-same-path');
  const dbPath = path.join(temp, 'legacy-duplicate.db');
  const seed = new IndexRegistry(storageRoot);
  await seed.load();
  seed.upsert(meta('legacy-first', dbPath, []));
  seed.upsert(meta('legacy-second', dbPath, []));
  await seed.save();

  const first = new IndexRegistry(storageRoot);
  const second = new IndexRegistry(storageRoot);
  await Promise.all([first.load(), second.load()]);
  assert.strictEqual(first.rename('legacy-first', 'Legacy renamed'), true);
  second.upsert(meta('unrelated-new-entry', path.join(temp, 'unrelated.db'), []));
  await first.save();
  await second.save();

  const reloaded = new IndexRegistry(storageRoot);
  await reloaded.load();
  assert.deepStrictEqual(
    reloaded
      .getAll()
      .filter((item) => path.resolve(item.dbPath) === path.resolve(dbPath))
      .map((item) => item.id)
      .sort(),
    ['legacy-first', 'legacy-second'],
    'three-way merge must not rewrite duplicate IDs that pre-dated both managers'
  );
}

async function testStaleSaveDoesNotResurrectDeletion(temp: string): Promise<void> {
  const storageRoot = path.join(temp, 'deletion-merge');
  const seed = new IndexRegistry(storageRoot);
  await seed.load();
  seed.upsert(meta('deleted', path.join(temp, 'deleted.db'), []));
  seed.upsert(meta('retained', path.join(temp, 'retained.db'), []));
  await seed.save();

  const remover = new IndexRegistry(storageRoot);
  const staleUpdater = new IndexRegistry(storageRoot);
  await Promise.all([remover.load(), staleUpdater.load()]);
  assert.strictEqual(remover.remove('deleted'), true);
  assert.strictEqual(staleUpdater.rename('deleted', 'Stale rename'), true);
  assert.strictEqual(staleUpdater.rename('retained', 'Renamed by stale peer'), true);

  // Save the stale updater after the delete. Its unchanged copy of `deleted`
  // must not recreate the entry, while its unrelated rename must still merge.
  await remover.save();
  await staleUpdater.save();

  const reloaded = new IndexRegistry(storageRoot);
  await reloaded.load();
  assert.strictEqual(reloaded.getById('deleted'), undefined);
  assert.strictEqual(reloaded.getById('retained')?.name, 'Renamed by stale peer');
}

async function testConcurrentWorkspaceAttachmentsAreMerged(temp: string): Promise<void> {
  const storageRoot = path.join(temp, 'workspace-merge');
  const seed = new IndexRegistry(storageRoot);
  await seed.load();
  seed.upsert(meta('shared', path.join(temp, 'shared.db'), []));
  await seed.save();

  const first = new IndexRegistry(storageRoot);
  const second = new IndexRegistry(storageRoot);
  await Promise.all([first.load(), second.load()]);
  first.attachWorkspace('shared', 'workspace-a');
  second.attachWorkspace('shared', 'workspace-b');
  await first.save();
  await second.save();

  const reloaded = new IndexRegistry(storageRoot);
  await reloaded.load();
  assert.deepStrictEqual(
    reloaded.getById('shared')?.workspaceHashes.sort(),
    ['workspace-a', 'workspace-b']
  );
}

async function testConcurrentPrimarySelectionsUseLastSaver(temp: string): Promise<void> {
  const storageRoot = path.join(temp, 'primary-selection-merge');
  const seed = new IndexRegistry(storageRoot);
  await seed.load();
  seed.upsert(meta('first-primary', path.join(temp, 'first-primary.db'), []));
  seed.upsert(meta('second-primary', path.join(temp, 'second-primary.db'), []));
  await seed.save();

  const first = new IndexRegistry(storageRoot);
  const second = new IndexRegistry(storageRoot);
  await Promise.all([first.load(), second.load()]);
  first.setWorkspacePrimary('first-primary', 'workspace');
  second.setWorkspacePrimary('second-primary', 'workspace');

  await first.save();
  await second.save();

  const reloaded = new IndexRegistry(storageRoot);
  await reloaded.load();
  assert.deepStrictEqual(
    reloaded.getAllByWorkspaceHash('workspace').map((item) => item.id),
    ['second-primary'],
    'the last concurrent Primary selection must remove earlier workspace associations'
  );
}

async function run(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-registry-'));
  try {
    const registry = new IndexRegistry(temp);
    await registry.load();
    const primary = meta('primary', path.join(temp, 'a.db'), ['workspace']);
    const secondary = meta('secondary', path.join(temp, 'b.db'), ['workspace']);
    registry.upsert(primary);
    registry.upsert(secondary);

    assert.strictEqual(registry.getByDbPath(path.join(temp, '.', 'a.db'))?.id, 'primary');
    registry.setWorkspacePrimary('secondary', 'workspace');
    assert.deepStrictEqual(primary.workspaceHashes, []);
    assert.deepStrictEqual(secondary.workspaceHashes, ['workspace']);
    assert.strictEqual(registry.getByWorkspaceHash('workspace')?.id, 'secondary');
    await registry.save();

    const reloaded = new IndexRegistry(temp);
    await reloaded.load();
    assert.strictEqual(reloaded.getAll().length, 2);
    assert.strictEqual(reloaded.getByWorkspaceHash('workspace')?.id, 'secondary');

    await testStaleManagersMergeDistinctAdds(temp);
    await testConcurrentSamePathAddsConverge(temp);
    await testPreExistingSamePathEntriesRemainCompatible(temp);
    await testStaleSaveDoesNotResurrectDeletion(temp);
    await testConcurrentWorkspaceAttachmentsAreMerged(temp);
    await testConcurrentPrimarySelectionsUseLastSaver(temp);

    fs.writeFileSync(path.join(temp, 'registry.json'), '{broken json', 'utf8');
    const broken = new IndexRegistry(temp);
    await assert.rejects(() => broken.load());
    assert.strictEqual(fs.readFileSync(path.join(temp, 'registry.json'), 'utf8'), '{broken json');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('indexRegistry.test.ts: all passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
