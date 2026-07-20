import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexingSettings } from '../src/indexingSettings';
import { IndexService } from '../src/index/IndexService';

interface IndexServiceTestHooks {
  startWatcher(config?: IndexingSettings, generation?: number): void;
}

async function run(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-index-recovery-'));
  const sourceRoot = path.join(temp, 'src');
  const dbPath = path.join(temp, 'index.db');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'sample.ts'), 'export const recoverable = true;\n');

  const service = new IndexService(dbPath);
  await service.initialize([sourceRoot]);

  const hooks = service as unknown as IndexServiceTestHooks;
  const originalStartWatcher = hooks.startWatcher.bind(service);
  let failWatcherOnce = true;
  hooks.startWatcher = (config, generation) => {
    if (failWatcherOnce) {
      failWatcherOnce = false;
      throw new Error('simulated watcher startup failure');
    }
    originalStartWatcher(config, generation);
  };

  const progressStatuses: string[] = [];
  service.on('progress', (progress) => progressStatuses.push(progress.status));

  try {
    await assert.rejects(
      service.startIndexing(),
      /simulated watcher startup failure/,
      'the original indexing error should reach the background caller'
    );
    assert.strictEqual(
      service.getProgress().status,
      'idle',
      'a failed attempt must leave the UI out of scanning/indexing state'
    );
    assert.strictEqual(service.getProgress().message, 'Ready');
    assert.strictEqual(
      service.isBackgroundWorkAllowed(),
      true,
      'the failed attempt must release the in-flight indexing guard'
    );
    assert.strictEqual(
      progressStatuses.at(-1),
      'idle',
      'failure recovery must notify progress listeners'
    );

    await service.startIndexing();
    assert.strictEqual(
      service.getProgress().status,
      'upToDate',
      'a later Refresh/startIndexing call must be able to retry successfully'
    );
  } finally {
    service.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }

  console.log('indexServiceRecovery.test.ts: all passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
