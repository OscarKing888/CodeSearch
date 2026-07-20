import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findExistingWorkspaceIndexes,
  hasWorkspaceIndex,
} from '../src/index/indexPresence';
import { IndexRegistry } from '../src/index/IndexRegistry';

async function run(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-index-presence-'));
  try {
    const registry = new IndexRegistry(path.join(temp, 'registry'));
    await registry.load();
    const missingLegacy = path.join(temp, 'legacy', 'index.db');
    const shared = path.join(temp, 'shared', 'index.db');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, 'shared');

    registry.upsert({
      id: 'legacy',
      name: 'Primary',
      dbPath: missingLegacy,
      rootDirs: [temp],
      readOnly: false,
      directoryMappings: [],
      workspaceHashes: ['workspace'],
      createdAt: 1,
      updatedAt: 1,
    });

    const fallback = await hasWorkspaceIndex('workspace', shared, registry);
    assert.strictEqual(fallback.exists, true);
    assert.strictEqual(path.resolve(fallback.dbPath), path.resolve(shared));
    assert.strictEqual(fallback.meta, undefined);

    const onlyShared = await findExistingWorkspaceIndexes('workspace', shared, registry);
    assert.deepStrictEqual(onlyShared.map((item) => path.resolve(item.dbPath)), [
      path.resolve(shared),
    ]);

    const registryLost = new IndexRegistry(path.join(temp, 'empty-registry'));
    await registryLost.load();
    const unregisteredLegacy = path.join(temp, 'code-search', 'workspace', 'index.db');
    fs.mkdirSync(path.dirname(unregisteredLegacy), { recursive: true });
    fs.writeFileSync(unregisteredLegacy, 'legacy without registry');
    const recoveredWithoutRegistry = await findExistingWorkspaceIndexes(
      'workspace',
      shared,
      registryLost,
      [unregisteredLegacy]
    );
    assert.deepStrictEqual(
      recoveredWithoutRegistry.map((item) => path.resolve(item.dbPath)),
      [path.resolve(unregisteredLegacy), path.resolve(shared)],
      'the pre-shared default DB must remain discoverable when registry.json is lost'
    );

    fs.mkdirSync(path.dirname(missingLegacy), { recursive: true });
    fs.writeFileSync(missingLegacy, 'legacy');
    const legacy = await hasWorkspaceIndex('workspace', shared, registry);
    assert.strictEqual(legacy.exists, true);
    assert.strictEqual(path.resolve(legacy.dbPath), path.resolve(missingLegacy));
    assert.strictEqual(legacy.meta?.id, 'legacy');

    const ordered = await findExistingWorkspaceIndexes('workspace', shared, registry);
    assert.deepStrictEqual(
      ordered.map((item) => path.resolve(item.dbPath)),
      [path.resolve(missingLegacy), path.resolve(shared)]
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  console.log('indexPresence.test.ts: all passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
