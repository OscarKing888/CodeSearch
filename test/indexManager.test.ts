import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexManager } from '../src/index/IndexManager';
import { IndexRegistry } from '../src/index/IndexRegistry';
import { IndexService } from '../src/index/IndexService';
import { IndexMeta } from '../src/index/types';

async function run(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-manager-'));
  const storage = path.join(temp, 'storage');
  const sourceRoot = path.join(temp, 'source');
  const aPath = path.join(temp, 'indexes', 'a.db');
  const bPath = path.join(temp, 'indexes', 'b.db');
  fs.mkdirSync(sourceRoot, { recursive: true });

  const manager = new IndexManager(storage, 'workspace', {
    writerLabel: 'test',
    workspaceRoots: [sourceRoot],
    sharedDbPath: aPath,
  });
  await manager.initialize();

  try {
    const first = await manager.createPrimary(aPath, [sourceRoot], 'A');
    assert.strictEqual(path.resolve(first.getDbPath()), path.resolve(aPath));

    const invalidPath = path.join(temp, 'indexes', 'not-an-index.db');
    const invalidContents = Buffer.from('this is not an Ace Code Search database');
    fs.writeFileSync(invalidPath, invalidContents);
    await assert.rejects(() => manager.openPrimary(invalidPath, [sourceRoot], 'Invalid'));
    assert.deepStrictEqual(fs.readFileSync(invalidPath), invalidContents);
    assert.strictEqual(manager.getPrimary(), first);
    assert.strictEqual(fs.existsSync(`${invalidPath}.writer.lock`), false);

    const registry = manager.getRegistry();
    const saveRegistry = registry.save.bind(registry);
    registry.save = async () => {
      throw new Error('simulated registry failure');
    };
    await assert.rejects(
      () => manager.openPrimary(bPath, [sourceRoot], 'B'),
      /simulated registry failure/
    );
    assert.strictEqual(manager.getPrimary(), first, 'failed persistence must keep the old primary');
    assert.strictEqual(registry.getByDbPath(bPath), undefined);
    assert.strictEqual(fs.existsSync(`${bPath}.writer.lock`), false);
    registry.save = saveRegistry;

    const second = await manager.openPrimary(bPath, [sourceRoot], 'B');
    assert.strictEqual(path.resolve(second.getDbPath()), path.resolve(bPath));
    assert.strictEqual(manager.getRegistry().getByWorkspaceHash('workspace')?.dbPath, path.resolve(bPath));
    assert.strictEqual(manager.getRegistry().getAll().length, 2);

    await assert.rejects(
      () => manager.attachSecondary(bPath, { readOnly: true }),
      /primary index cannot also be opened as a secondary/i
    );

    const secondary = await manager.attachSecondary(aPath, {
      name: 'A',
      readOnly: true,
      rootDirs: [sourceRoot],
    });
    assert.strictEqual(manager.getAllServices().length, 2);
    assert.strictEqual(secondary.isReadOnly(), true);

    const promoted = await manager.openPrimary(aPath, [sourceRoot], 'A', { readOnly: true });
    assert.strictEqual(path.resolve(promoted.getDbPath()), path.resolve(aPath));
    assert.strictEqual(manager.getAllServices().length, 1);
    assert.strictEqual(manager.getWorkspaceSecondaryIds().length, 0);
    assert.strictEqual(manager.getRegistry().getByWorkspaceHash('workspace')?.dbPath, path.resolve(aPath));
    const indexedRoot = path.join(temp, 'indexed-root');
    const mappedRoot = path.join(temp, 'mapped-root');
    assert.strictEqual(
      await manager.setDirectoryMappings(promoted.id, [
        { from: indexedRoot, to: mappedRoot },
      ]),
      true
    );
    assert.strictEqual(
      manager.mapHitPath(promoted.id, path.join(indexedRoot, 'src', 'file.ts')),
      path.join(mappedRoot, 'src', 'file.ts'),
      'primary mappings must apply to manually selected databases too'
    );
    const outside = `${indexedRoot}-other${path.sep}file.ts`;
    assert.strictEqual(manager.mapHitPath(promoted.id, outside), outside);

    const duplicateId = 'legacy-duplicate-path';
    registry.upsert({
      ...registry.getById(promoted.id)!,
      id: duplicateId,
      name: 'Legacy duplicate',
      workspaceHashes: [],
    });
    await registry.save();
    assert.strictEqual(await manager.deleteIndex(duplicateId, true), false);
    assert.strictEqual(fs.existsSync(aPath), true, 'duplicate metadata must not delete an active DB');

    const deferredSecondaryPath = path.join(temp, 'indexes', 'deferred-secondary.db');
    const deferredSecondary = await manager.attachSecondary(deferredSecondaryPath, {
      name: 'Deferred writable secondary',
      readOnly: false,
      rootDirs: [sourceRoot],
      waitForInitialIndex: false,
    });
    assert.strictEqual(
      deferredSecondary.getProgress().status,
      'idle',
      'startup mode must return after open/register instead of waiting for a full scan'
    );
    assert.strictEqual(
      manager.getAttachedIndex(deferredSecondary.id)?.service,
      deferredSecondary,
      'the service must be registered before callers start background indexing'
    );
    await deferredSecondary.startIndexing();
    assert.strictEqual(deferredSecondary.getProgress().status, 'upToDate');
    await manager.detachSecondary(deferredSecondary.id);

    const legacySecondaryPath = path.join(temp, 'indexes', 'legacy-secondary.db');
    const legacySecondary = await manager.attachSecondary(legacySecondaryPath, {
      name: 'Legacy writable secondary',
      readOnly: false,
      rootDirs: [sourceRoot],
    });
    await manager.detachSecondary(legacySecondary.id);
    const legacyMeta = registry.getById(legacySecondary.id)!;
    legacyMeta.rootDirs = [];
    legacyMeta.readOnly = false;
    await registry.save();
    const restoredLegacy = await manager.loadWorkspaceSecondaries(
      [legacySecondary.id],
      { waitForInitialIndex: false }
    );
    assert.strictEqual(restoredLegacy.length, 1);
    assert.strictEqual(
      restoredLegacy[0].getProgress().status,
      'upToDate',
      'a restored read-only service reports the persisted complete snapshot without starting a scan'
    );
    await restoredLegacy[0].startIndexing();
    assert.strictEqual(
      manager.getAttachedIndexes().find((item) => item.meta.id === legacySecondary.id)?.service.isReadOnly(),
      true,
      'legacy writable secondaries without roots must restore as readers'
    );
  } finally {
    await manager.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }

  await runTopologyMutationTests();
  await runPromotionTopologyTests();
  await runDestructiveSafetyTests();
  await runConcurrentSamePathRegistryConvergenceTests();

  const sharedPath = path.join(temp, 'indexes', 'takeover.db');
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  const firstManager = new IndexManager(path.join(temp, 'first'), 'workspace', {
    writerLabel: 'VS Code',
    workspaceRoots: [sourceRoot],
    writerRetryIntervalMs: 20,
  });
  const secondManager = new IndexManager(path.join(temp, 'second'), 'workspace', {
    writerLabel: 'Cursor',
    workspaceRoots: [sourceRoot],
    writerRetryIntervalMs: 20,
  });
  await firstManager.initialize();
  await secondManager.initialize();
  try {
    const [firstService, secondService] = await Promise.all([
      firstManager.createPrimary(sharedPath, [sourceRoot]),
      secondManager.createPrimary(sharedPath, [sourceRoot]),
    ]);
    assert.strictEqual(
      Number(firstService.isReadOnly()) + Number(secondService.isReadOnly()),
      1,
      'concurrent first-use must produce one writer and one readable fallback'
    );
    const writerManager = firstService.isReadOnly() ? secondManager : firstManager;
    const readerManager = firstService.isReadOnly() ? firstManager : secondManager;
    const reader = readerManager.getPrimary()!;
    assert.strictEqual(readerManager.getRuntimeAccess(reader.id)?.requestedReadOnly, false);

    await writerManager.dispose();
    await waitForWritable(readerManager);
    const promoted = readerManager.getPrimary()!;
    assert.strictEqual(
      promoted.isReadOnly(),
      false,
      'the automatic reader should take over after the original writer exits'
    );
  } finally {
    await firstManager.dispose();
    await secondManager.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }

  console.log('indexManager.test.ts: all passed');
}

async function runConcurrentSamePathRegistryConvergenceTests(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-manager-same-path-registry-'));
  const storage = path.join(temp, 'shared-catalog');
  const registryStorage = path.join(storage, 'code-search');
  const sourceRoot = path.join(temp, 'source');
  const dbPath = path.join(temp, 'indexes', 'shared.db');
  fs.mkdirSync(sourceRoot, { recursive: true });

  const firstManager = new IndexManager(storage, 'same-workspace', {
    writerLabel: 'first IDE',
    workspaceRoots: [sourceRoot],
    writerRetryIntervalMs: 60_000,
  });
  const secondManager = new IndexManager(storage, 'same-workspace', {
    writerLabel: 'second IDE',
    workspaceRoots: [sourceRoot],
    writerRetryIntervalMs: 60_000,
  });
  await Promise.all([firstManager.initialize(), secondManager.initialize()]);

  try {
    const [firstService, secondService] = await Promise.all([
      firstManager.createPrimary(dbPath, [sourceRoot], 'First IDE'),
      secondManager.createPrimary(dbPath, [sourceRoot], 'Second IDE'),
    ]);
    assert.notStrictEqual(
      firstService.id,
      secondService.id,
      'both stale managers must exercise independently generated runtime IDs'
    );

    let catalog = new IndexRegistry(registryStorage);
    await catalog.load();
    let pathEntries = catalog
      .getAll()
      .filter((item) => path.resolve(item.dbPath) === path.resolve(dbPath));
    assert.strictEqual(pathEntries.length, 1, 'the shared registry must converge by physical path');
    const winnerId = pathEntries[0].id;
    const loserManager = firstService.id === winnerId ? secondManager : firstManager;
    const loserService = firstService.id === winnerId ? secondService : firstService;
    assert.strictEqual(loserManager.getPrimary(), loserService);
    assert.strictEqual(loserManager.getIndexMeta(loserService.id)?.id, loserService.id);

    assert.strictEqual(
      await loserManager.renameIndex(loserService.id, 'Renamed by active loser'),
      true
    );
    catalog = new IndexRegistry(registryStorage);
    await catalog.load();
    pathEntries = catalog
      .getAll()
      .filter((item) => path.resolve(item.dbPath) === path.resolve(dbPath));
    assert.deepStrictEqual(pathEntries.map((item) => item.id), [winnerId]);
    assert.strictEqual(pathEntries[0].name, 'Renamed by active loser');

    const indexedRoot = path.join(temp, 'indexed-root');
    const mappedRoot = path.join(temp, 'mapped-root');
    assert.strictEqual(
      await loserManager.setDirectoryMappings(loserService.id, [
        { from: indexedRoot, to: mappedRoot },
      ]),
      true
    );
    catalog = new IndexRegistry(registryStorage);
    await catalog.load();
    pathEntries = catalog
      .getAll()
      .filter((item) => path.resolve(item.dbPath) === path.resolve(dbPath));
    assert.deepStrictEqual(
      pathEntries.map((item) => item.id),
      [winnerId],
      'a second active-loser update must not reintroduce its runtime ID'
    );
    assert.deepStrictEqual(pathEntries[0].directoryMappings, [
      { from: indexedRoot, to: mappedRoot },
    ]);
    assert.strictEqual(loserManager.getPrimary(), loserService, 'the active service ID stays stable');
    assert.strictEqual(
      loserManager.mapHitPath(loserService.id, path.join(indexedRoot, 'file.ts')),
      path.join(mappedRoot, 'file.ts'),
      'runtime metadata remains addressable through the losing service ID'
    );
    assert.deepStrictEqual(
      catalog.getAllByWorkspaceHash('same-workspace').map((item) => item.id),
      [winnerId],
      'Primary workspace membership must follow the converged catalog ID'
    );
  } finally {
    await firstManager.dispose();
    await secondManager.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function runDestructiveSafetyTests(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-manager-destructive-'));
  const sourceRoot = path.join(temp, 'source-root');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const manager = new IndexManager(path.join(temp, 'catalog'), 'destructive-workspace', {
    writerLabel: 'destructive-test',
    workspaceRoots: [sourceRoot],
  });
  const owner = new IndexManager(path.join(temp, 'owner'), 'owner-workspace', {
    writerLabel: 'other-writer',
    workspaceRoots: [sourceRoot],
  });
  await manager.initialize();
  await owner.initialize();

  try {
    const registry = manager.getRegistry();
    const duplicatePath = path.join(temp, 'duplicate.db');
    fs.writeFileSync(duplicatePath, 'duplicate physical database', 'utf8');
    registry.upsert(makeCatalogMeta('duplicate-a', duplicatePath));
    registry.upsert(makeCatalogMeta('duplicate-b', duplicatePath));
    await registry.save();

    assert.strictEqual(await manager.deleteIndex('duplicate-a', true), false);
    assert.strictEqual(
      fs.readFileSync(duplicatePath, 'utf8'),
      'duplicate physical database',
      'deleting one inactive legacy duplicate must not remove their shared file'
    );
    assert.ok(registry.getById('duplicate-a'));
    registry.remove('duplicate-b');
    await registry.save();

    const concurrentDeletePath = path.join(temp, 'concurrent-delete.db');
    fs.writeFileSync(concurrentDeletePath, 'must remain for peer', 'utf8');
    registry.upsert(makeCatalogMeta('delete-current', concurrentDeletePath));
    await registry.save();
    const peerRegistry = new IndexRegistry(path.dirname(registry.getPath()));
    await peerRegistry.load();
    const saveWithExclusiveHooks = registry.saveWithExclusiveHooks.bind(registry);
    let injectConcurrentDeleteReference = true;
    registry.saveWithExclusiveHooks = async <T>(
      prepare: (mergedDraft: IndexMeta[]) => T | Promise<T>,
      afterWrite?: (prepared: T, persisted: readonly IndexMeta[]) => void | Promise<void>
    ): Promise<T> => {
      if (injectConcurrentDeleteReference) {
        injectConcurrentDeleteReference = false;
        peerRegistry.upsert(makeCatalogMeta('delete-peer', concurrentDeletePath));
        await peerRegistry.save();
      }
      return saveWithExclusiveHooks(prepare, afterWrite);
    };
    assert.strictEqual(await manager.deleteIndex('delete-current', true), true);
    registry.saveWithExclusiveHooks = saveWithExclusiveHooks;
    assert.strictEqual(
      fs.readFileSync(concurrentDeletePath, 'utf8'),
      'must remain for peer',
      'a peer reference merged under the registry lease must suppress physical deletion'
    );
    assert.strictEqual(registry.getById('delete-current'), undefined);
    assert.ok(registry.getById('delete-peer'));

    const lockedPath = path.join(temp, 'locked.db');
    await owner.createPrimary(lockedPath, [sourceRoot], 'Locked elsewhere');
    registry.upsert(makeCatalogMeta('locked', lockedPath));
    await registry.save();
    const lockedDestination = path.join(temp, 'locked-moved.db');
    assert.strictEqual(await manager.moveIndex('locked', lockedDestination), false);
    assert.strictEqual(fs.existsSync(lockedDestination), false);
    assert.strictEqual(await manager.deleteIndex('locked', true), false);
    assert.ok(registry.getById('locked'), 'a busy physical delete must retain its catalog entry');

    await owner.dispose();
    assert.strictEqual(await manager.deleteIndex('locked', true), true);
    assert.strictEqual(fs.existsSync(lockedPath), false);
    assert.strictEqual(fs.existsSync(`${lockedPath}.writer.lock`), false);

    const sourcePath = path.join(temp, 'move-source.db');
    const destinationPath = path.join(temp, 'move-destination.db');
    fs.writeFileSync(sourcePath, 'source bytes', 'utf8');
    fs.writeFileSync(destinationPath, 'destination bytes', 'utf8');
    registry.upsert(makeCatalogMeta('move-source', sourcePath));
    registry.upsert(makeCatalogMeta('move-destination', destinationPath));
    await registry.save();

    assert.strictEqual(await manager.moveIndex('move-source', destinationPath), false);
    assert.strictEqual(fs.readFileSync(destinationPath, 'utf8'), 'destination bytes');
    assert.strictEqual(registry.getById('move-source')?.dbPath, sourcePath);

    fs.unlinkSync(destinationPath);
    registry.remove('move-destination');
    const catalogOnlyDestination = path.join(temp, 'catalog-only-destination.db');
    registry.upsert(makeCatalogMeta('catalog-only', catalogOnlyDestination));
    await registry.save();
    assert.strictEqual(await manager.moveIndex('move-source', catalogOnlyDestination), false);
    assert.strictEqual(fs.existsSync(catalogOnlyDestination), false);
    registry.remove('catalog-only');
    await registry.save();

    const movedPath = path.join(temp, 'moved', 'index.db');
    assert.strictEqual(await manager.moveIndex('move-source', movedPath), true);
    assert.strictEqual(fs.readFileSync(movedPath, 'utf8'), 'source bytes');
    assert.strictEqual(fs.existsSync(sourcePath), true, 'move keeps the legacy source copy');
    assert.strictEqual(registry.getById('move-source')?.dbPath, path.resolve(movedPath));
    assert.strictEqual(fs.existsSync(`${sourcePath}.writer.lock`), false);
    assert.strictEqual(fs.existsSync(`${movedPath}.writer.lock`), false);

    const rollbackSource = path.join(temp, 'rollback-source.db');
    const rollbackDestination = path.join(temp, 'rollback-destination.db');
    fs.writeFileSync(rollbackSource, 'rollback source bytes', 'utf8');
    registry.upsert(makeCatalogMeta('rollback-current', rollbackSource));
    await registry.save();
    const exclusiveMoveSave = registry.saveWithExclusiveHooks.bind(registry);
    let injectMoveDestinationClaim = true;
    registry.saveWithExclusiveHooks = async <T>(
      prepare: (mergedDraft: IndexMeta[]) => T | Promise<T>,
      afterWrite?: (prepared: T, persisted: readonly IndexMeta[]) => void | Promise<void>
    ): Promise<T> =>
      exclusiveMoveSave(async (mergedDraft) => {
        if (injectMoveDestinationClaim) {
          injectMoveDestinationClaim = false;
          mergedDraft.push(makeCatalogMeta('rollback-peer', rollbackDestination));
        }
        return prepare(mergedDraft);
      }, afterWrite);
    assert.strictEqual(
      await manager.moveIndex('rollback-current', rollbackDestination),
      false,
      'a destination claim in the merged draft must roll the move back atomically'
    );
    registry.saveWithExclusiveHooks = exclusiveMoveSave;
    assert.strictEqual(registry.getById('rollback-current')?.dbPath, rollbackSource);
    assert.strictEqual(registry.getById('rollback-peer')?.dbPath, rollbackDestination);
    assert.strictEqual(fs.readFileSync(rollbackDestination, 'utf8'), 'rollback source bytes');
    assert.strictEqual(fs.readFileSync(rollbackSource, 'utf8'), 'rollback source bytes');
    assert.strictEqual(fs.existsSync(`${rollbackSource}.writer.lock`), false);
    assert.strictEqual(fs.existsSync(`${rollbackDestination}.writer.lock`), false);
  } finally {
    await owner.dispose();
    await manager.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function makeCatalogMeta(id: string, dbPath: string): IndexMeta {
  return {
    id,
    name: id,
    dbPath,
    rootDirs: [],
    readOnly: true,
    directoryMappings: [],
    workspaceHashes: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

async function runTopologyMutationTests(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-manager-topology-'));
  const storage = path.join(temp, 'storage');
  const sourceRoot = path.join(temp, 'source');
  const originalPath = path.join(temp, 'indexes', 'original.db');
  const intermediatePath = path.join(temp, 'indexes', 'intermediate.db');
  const finalPath = path.join(temp, 'indexes', 'final.db');
  const secondaryPath = path.join(temp, 'indexes', 'secondary.db');
  fs.mkdirSync(sourceRoot, { recursive: true });

  const manager = new IndexManager(storage, 'topology-workspace', {
    writerLabel: 'topology-test',
    workspaceRoots: [sourceRoot],
  });
  await manager.initialize();
  try {
    const original = await manager.createPrimary(originalPath, [sourceRoot], 'Original');
    const [intermediate, final] = await Promise.all([
      manager.openPrimary(intermediatePath, [sourceRoot], 'Intermediate'),
      manager.openPrimary(finalPath, [sourceRoot], 'Final'),
    ]);

    assert.strictEqual(manager.getPrimary(), final, 'queued Primary changes must finish in call order');
    assert.strictEqual(manager.getAllServices().length, 1, 'an intermediate Primary must not remain active');
    assert.strictEqual(original.isBackgroundWorkAllowed(), false, 'the original Primary must be disposed');
    assert.strictEqual(intermediate.isBackgroundWorkAllowed(), false, 'the intermediate Primary must be disposed');
    assert.strictEqual(fs.existsSync(`${originalPath}.writer.lock`), false);
    assert.strictEqual(fs.existsSync(`${intermediatePath}.writer.lock`), false);
    assert.strictEqual(fs.existsSync(`${finalPath}.writer.lock`), true);

    const indexedRoot = path.join(temp, 'indexed-root');
    const mappedRoot = path.join(temp, 'mapped-root');
    assert.strictEqual(
      await manager.setDirectoryMappings(final.id, [{ from: indexedRoot, to: mappedRoot }]),
      true
    );
    assert.strictEqual(manager.getRegistry().remove(final.id), true);
    await manager.getRegistry().save();
    const reopened = await manager.openPrimary(finalPath, [sourceRoot], 'Final');
    assert.strictEqual(reopened, final, 'same-path open must retain the active service');
    assert.strictEqual(
      manager.getRegistry().getByDbPath(finalPath)?.id,
      final.id,
      'same-path open after a peer delete must not split registry/runtime ids'
    );
    assert.strictEqual(
      manager.mapHitPath(final.id, path.join(indexedRoot, 'file.ts')),
      path.join(mappedRoot, 'file.ts'),
      'active Primary mappings must survive a missing registry row'
    );

    assert.strictEqual(manager.getRegistry().remove(final.id), true);
    await manager.getRegistry().save();
    assert.strictEqual(await manager.renameIndex(final.id, 'Renamed active Primary'), true);
    assert.strictEqual(manager.getRegistry().getById(final.id)?.name, 'Renamed active Primary');
    assert.strictEqual(final.name, 'Renamed active Primary');

    const remappedRoot = path.join(temp, 'remapped-root');
    assert.strictEqual(manager.getRegistry().remove(final.id), true);
    await manager.getRegistry().save();
    assert.strictEqual(
      await manager.setDirectoryMappings(final.id, [{ from: indexedRoot, to: remappedRoot }]),
      true
    );
    assert.strictEqual(
      manager.mapHitPath(final.id, path.join(indexedRoot, 'file.ts')),
      path.join(remappedRoot, 'file.ts')
    );

    assert.strictEqual(manager.getRegistry().remove(final.id), true);
    await manager.getRegistry().save();
    assert.strictEqual(
      await manager.setExcludeRules(final.id, { excludeDirNames: ['Generated'] }),
      true
    );
    assert.deepStrictEqual(manager.getIndexMeta(final.id)?.excludeDirNames, ['Generated']);
    assert.deepStrictEqual(manager.getRegistry().getById(final.id)?.excludeDirNames, ['Generated']);

    const [firstAttach, secondAttach] = await Promise.all([
      manager.attachSecondary(secondaryPath, {
        name: 'Concurrent Secondary',
        readOnly: false,
        rootDirs: [sourceRoot],
      }),
      manager.attachSecondary(secondaryPath, {
        name: 'Concurrent Secondary',
        readOnly: false,
        rootDirs: [sourceRoot],
      }),
    ]);
    assert.strictEqual(firstAttach, secondAttach, 'concurrent same-path attaches must reuse one service');
    assert.strictEqual(manager.getAttachedIndexes().length, 1);
    assert.strictEqual(manager.getAllServices().length, 2);
    assert.strictEqual(fs.existsSync(`${secondaryPath}.writer.lock`), true);

    const attachedId = firstAttach.id;
    assert.strictEqual(manager.getRegistry().remove(attachedId), true);
    await manager.getRegistry().save();
    assert.strictEqual(manager.getRegistry().getById(attachedId), undefined);
    assert.strictEqual(
      manager.getAttachedIndex(attachedId)?.service.getDbPath(),
      path.resolve(secondaryPath),
      'runtime Secondary metadata must retain the path after a peer/catalog delete'
    );
    assert.strictEqual(await manager.detachSecondary(attachedId), true);
    assert.strictEqual(fs.existsSync(`${secondaryPath}.writer.lock`), false);
  } finally {
    await manager.dispose();
    assert.strictEqual(fs.existsSync(`${finalPath}.writer.lock`), false);
    assert.strictEqual(fs.existsSync(`${secondaryPath}.writer.lock`), false);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function runPromotionTopologyTests(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-manager-promotion-'));
  const sourceRoot = path.join(temp, 'source');
  const sharedPath = path.join(temp, 'indexes', 'shared.db');
  const switchedPath = path.join(temp, 'indexes', 'switched.db');
  fs.mkdirSync(sourceRoot, { recursive: true });

  const owner = new IndexManager(path.join(temp, 'owner'), 'promotion-workspace', {
    writerLabel: 'owner',
    workspaceRoots: [sourceRoot],
  });
  const contender = new IndexManager(path.join(temp, 'contender'), 'promotion-workspace', {
    writerLabel: 'contender',
    workspaceRoots: [sourceRoot],
    writerRetryIntervalMs: 60_000,
  });
  await owner.initialize();
  await contender.initialize();
  try {
    await owner.createPrimary(sharedPath, [sourceRoot], 'Shared');
    const reader = await contender.openPrimary(sharedPath, [sourceRoot], 'Shared');
    assert.strictEqual(reader.isReadOnly(), true);
    await owner.dispose();

    const registry = contender.getRegistry();
    const saveRegistry = registry.save.bind(registry);
    let releaseSave: (() => void) | undefined;
    let markSaveEntered: (() => void) | undefined;
    const saveEntered = new Promise<void>((resolve) => {
      markSaveEntered = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let blockNextSave = true;
    registry.save = async () => {
      if (blockNextSave) {
        blockNextSave = false;
        markSaveEntered?.();
        await saveGate;
      }
      await saveRegistry();
    };

    const switchPromise = contender.openPrimary(switchedPath, [sourceRoot], 'Switched');
    await saveEntered;
    const promotionPromise = promoteAutomaticReader(contender, reader);
    releaseSave?.();
    await Promise.all([switchPromise, promotionPromise]);
    registry.save = saveRegistry;

    assert.strictEqual(contender.getPrimary()?.getDbPath(), path.resolve(switchedPath));
    assert.strictEqual(contender.getAllServices().length, 1);
    assert.strictEqual(reader.isBackgroundWorkAllowed(), false, 'a disposed reader must reject background work');
    assert.strictEqual(fs.existsSync(`${sharedPath}.writer.lock`), false);
    assert.strictEqual(fs.existsSync(`${switchedPath}.writer.lock`), true);

    const secondOwner = new IndexManager(path.join(temp, 'second-owner'), 'promotion-workspace', {
      writerLabel: 'second-owner',
      workspaceRoots: [sourceRoot],
    });
    await secondOwner.initialize();
    try {
      await secondOwner.createPrimary(sharedPath, [sourceRoot], 'Shared');
      const secondaryReader = await contender.attachSecondary(sharedPath, {
        name: 'Shared reader',
        readOnly: false,
        rootDirs: [sourceRoot],
      });
      assert.strictEqual(secondaryReader.isReadOnly(), true);
      assert.strictEqual(contender.getRegistry().remove(secondaryReader.id), true);
      await contender.getRegistry().save();
      await secondOwner.dispose();

      await promoteAutomaticReader(contender, secondaryReader);
      assert.strictEqual(
        contender.getAttachedIndex(secondaryReader.id)?.service.isReadOnly(),
        false,
        'promotion must use active Secondary metadata after its registry row is deleted'
      );
      assert.ok(contender.getIndexMeta(secondaryReader.id));
      await contender.detachSecondary(secondaryReader.id);
      assert.strictEqual(contender.getAttachedIndex(secondaryReader.id), undefined);
      assert.strictEqual(fs.existsSync(`${sharedPath}.writer.lock`), false);
    } finally {
      await secondOwner.dispose();
    }

    const raceSharedPath = path.join(temp, 'indexes', 'race-shared.db');
    const raceOwner = new IndexManager(path.join(temp, 'race-owner'), 'promotion-workspace', {
      writerLabel: 'race-owner',
      workspaceRoots: [sourceRoot],
    });
    await raceOwner.initialize();
    try {
      await raceOwner.createPrimary(raceSharedPath, [sourceRoot], 'Race shared');
      const raceReader = await contender.attachSecondary(raceSharedPath, {
        name: 'Race reader',
        readOnly: false,
        rootDirs: [sourceRoot],
      });
      assert.strictEqual(raceReader.isReadOnly(), true);
      await raceOwner.dispose();
      await Promise.all([
        promoteAutomaticReader(contender, raceReader),
        contender.detachSecondary(raceReader.id),
      ]);
      assert.strictEqual(contender.getAttachedIndex(raceReader.id), undefined);
      assert.strictEqual(fs.existsSync(`${raceSharedPath}.writer.lock`), false);
    } finally {
      await raceOwner.dispose();
    }
  } finally {
    await owner.dispose();
    await contender.dispose();
    assert.strictEqual(fs.existsSync(`${sharedPath}.writer.lock`), false);
    assert.strictEqual(fs.existsSync(`${switchedPath}.writer.lock`), false);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function promoteAutomaticReader(manager: IndexManager, service: IndexService): Promise<void> {
  return (
    manager as unknown as {
      tryPromoteAutomaticReader(current: IndexService): Promise<void>;
    }
  ).tryPromoteAutomaticReader(service);
}

async function waitForWritable(manager: IndexManager): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (manager.getPrimary() && !manager.getPrimary()!.isReadOnly()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the automatic reader to take over writes');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
