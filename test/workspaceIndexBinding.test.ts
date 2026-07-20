import * as assert from 'assert';
import { IndexMeta } from '../src/index/types';
import {
  getWorkspaceSecondaryRestoreSource,
  getWorkspaceIndexBindingKey,
  mergeWorkspaceSecondaryBindings,
  migrateLegacyWorkspaceBinding,
  normalizeWorkspaceIndexBinding,
  WORKSPACE_INDEX_BINDING_VERSION,
} from '../src/index/workspaceIndexBinding';

function meta(id: string, dbPath: string, readOnly: boolean): IndexMeta {
  return {
    id,
    name: id,
    dbPath,
    rootDirs: [pathForTest('src', id)],
    readOnly,
    directoryMappings: [
      { from: pathForTest('indexed', id), to: pathForTest('src', id) },
    ],
    workspaceHashes: ['legacy-hash'],
    createdAt: 1,
    updatedAt: 2,
  };
}

function pathForTest(...parts: string[]): string {
  return ['test-root', ...parts].join('/');
}

function testInvalidInputUsesSafeEmptyBinding(): void {
  assert.notStrictEqual(
    getWorkspaceIndexBindingKey('workspace-a'),
    getWorkspaceIndexBindingKey('workspace-b')
  );
  assert.deepStrictEqual(normalizeWorkspaceIndexBinding(null), {
    version: WORKSPACE_INDEX_BINDING_VERSION,
    primary: undefined,
    secondaries: [],
  });
  assert.deepStrictEqual(normalizeWorkspaceIndexBinding({ primary: { dbPath: 42 } }), {
    version: WORKSPACE_INDEX_BINDING_VERSION,
    primary: undefined,
    secondaries: [],
  });
}

function testNormalizeAndDedupeByPath(): void {
  const binding = normalizeWorkspaceIndexBinding({
    version: 999,
    primary: {
      dbPath: pathForTest('indexes', 'primary.db'),
      accessMode: 'not-valid',
      source: 'manual',
      rootDirs: [pathForTest('src'), '', pathForTest('src')],
      directoryMappings: [
        { from: pathForTest('indexed'), to: pathForTest('src') },
      ],
    },
    secondaries: [
      { dbPath: pathForTest('indexes', 'primary.db'), accessMode: 'readOnly' },
      { dbPath: pathForTest('indexes', 'lib.db'), accessMode: 'readOnly' },
      { dbPath: pathForTest('indexes', 'lib.db'), accessMode: 'auto' },
      { dbPath: '   ' },
    ],
  });

  assert.strictEqual(binding.version, 2);
  assert.strictEqual(binding.primary?.accessMode, 'auto');
  assert.deepStrictEqual(binding.primary?.directoryMappings, [
    { from: pathForTest('indexed'), to: pathForTest('src') },
  ]);
  assert.strictEqual(binding.primary?.source, 'manual');
  assert.deepStrictEqual(binding.primary?.rootDirs, [pathForTest('src')]);
  assert.strictEqual(binding.secondaries.length, 1);
  assert.strictEqual(binding.secondaries[0].dbPath, pathForTest('indexes', 'lib.db'));
  assert.strictEqual(binding.secondaries[0].accessMode, 'readOnly');
}

function testLegacyMigrationStoresPathsAndAttachmentData(): void {
  const primary = meta('primary', pathForTest('indexes', 'primary.db'), false);
  const secondary = meta('library', pathForTest('indexes', 'library.db'), true);
  const binding = migrateLegacyWorkspaceBinding(primary, [secondary]);

  assert.strictEqual(binding.primary?.dbPath, primary.dbPath);
  assert.strictEqual(binding.primary?.source, 'legacy');
  assert.strictEqual(binding.primary?.accessMode, 'auto');
  assert.deepStrictEqual(binding.primary?.directoryMappings, primary.directoryMappings);
  assert.strictEqual(binding.secondaries[0].dbPath, secondary.dbPath);
  assert.strictEqual(binding.secondaries[0].accessMode, 'readOnly');
  assert.deepStrictEqual(binding.secondaries[0].directoryMappings, secondary.directoryMappings);
  assert.ok(!('id' in binding.secondaries[0]));
}

function testLegacySecondaryIdsAreConsumedOnlyOnce(): void {
  assert.strictEqual(
    getWorkspaceSecondaryRestoreSource(undefined, false),
    'legacyIds',
    'the first hash may consume pre-V2 secondary IDs'
  );
  assert.strictEqual(
    getWorkspaceSecondaryRestoreSource(undefined, true),
    'none',
    'a later roots hash must not inherit the first hash secondary IDs'
  );
}

function testKeyedEmptySecondaryListIsAuthoritative(): void {
  const keyedEmptyBinding = {
    version: WORKSPACE_INDEX_BINDING_VERSION,
    secondaries: [],
  };
  assert.strictEqual(
    getWorkspaceSecondaryRestoreSource(keyedEmptyBinding, false),
    'keyedBinding',
    'an explicit empty keyed list must not fall back to legacy IDs'
  );
}

function testUnavailableSecondarySurvivesUntilExplicitRemoval(): void {
  const missing = {
    dbPath: pathForTest('external-drive', 'library.db'),
    accessMode: 'readOnly' as const,
    name: 'External library',
  };

  const afterMissingStartup = mergeWorkspaceSecondaryBindings([], [missing]);
  assert.deepStrictEqual(
    afterMissingStartup,
    [missing],
    'a temporarily unavailable keyed Secondary must remain bound'
  );

  const recovered = {
    ...missing,
    name: 'Recovered library',
  };
  assert.deepStrictEqual(
    mergeWorkspaceSecondaryBindings([recovered], afterMissingStartup),
    [recovered],
    'a later successful restore must replace the preserved metadata without duplication'
  );

  assert.deepStrictEqual(
    mergeWorkspaceSecondaryBindings([], afterMissingStartup, [missing.dbPath]),
    [],
    'an explicit Close/Forget must remove the preserved path'
  );
  assert.deepStrictEqual(
    mergeWorkspaceSecondaryBindings([recovered], afterMissingStartup, [missing.dbPath]),
    [recovered],
    'forgetting duplicate catalog metadata must not remove a still-attached physical path'
  );
}

function run(): void {
  testInvalidInputUsesSafeEmptyBinding();
  testNormalizeAndDedupeByPath();
  testLegacyMigrationStoresPathsAndAttachmentData();
  testLegacySecondaryIdsAreConsumedOnlyOnce();
  testKeyedEmptySecondaryListIsAuthoritative();
  testUnavailableSecondarySurvivesUntilExplicitRemoval();
  console.log('workspaceIndexBinding.test.ts: all passed');
}

run();
