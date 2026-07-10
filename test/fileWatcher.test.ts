import * as assert from 'assert';
import * as path from 'path';
import {
  FileChangeEvent,
  FileWatchBackend,
  FileWatchBackendStartOptions,
  FileWatcher,
} from '../src/index/FileWatcher';
import { DEFAULT_INDEXING_SETTINGS } from '../src/indexingSettings';

class FakeBackend implements FileWatchBackend {
  starts = 0;
  disposed = false;
  options: FileWatchBackendStartOptions | undefined;

  start(options: FileWatchBackendStartOptions): { dispose(): void } {
    this.starts++;
    this.disposed = false;
    this.options = options;
    return {
      dispose: () => {
        this.disposed = true;
      },
    };
  }

  emit(filePath: string, event: FileChangeEvent): void {
    this.options?.onEvent(filePath, event);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 750): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail('timed out waiting for file watcher event');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function testCoalesceFilterPauseResumeAndDispose(): Promise<void> {
  const backend = new FakeBackend();
  const watcher = new FileWatcher({ backend, settleMs: 15, drainBatchSize: 1 });
  const root = path.join(process.cwd(), 'fake-watcher-root');
  const events: Array<{ filePath: string; event: FileChangeEvent }> = [];
  const config = {
    ...DEFAULT_INDEXING_SETTINGS,
    excludeDirNames: ['vendor'],
    excludeFileNames: ['*.generated.ts'],
    excludeGlobs: [],
    includeGlobs: ['**/*.ts'],
  };

  watcher.start([root], config, async (filePath, event) => {
    events.push({ filePath, event });
    await new Promise((resolve) => setTimeout(resolve, 1));
  });

  assert.strictEqual(backend.starts, 1);
  assert.deepStrictEqual(backend.options?.rootDirs, [path.normalize(root)]);
  assert.deepStrictEqual(backend.options?.includeGlobs, ['**/*.ts']);
  assert.strictEqual(backend.options?.isIgnored(root), false);
  assert.strictEqual(backend.options?.isIgnored(path.join(root, 'vendor', 'skip.ts')), true);

  backend.emit(path.join(root, 'vendor', 'skip.ts'), 'add');
  backend.emit(path.join(root, 'src', 'skip.cpp'), 'add');
  const kept = path.join(root, 'src', 'keep.ts');
  backend.emit(kept, 'add');
  backend.emit(kept, 'change');

  await waitFor(() => events.length === 1);
  assert.deepStrictEqual(events[0], { filePath: path.normalize(kept), event: 'add' });

  watcher.pause();
  const firstPaused = path.join(root, 'src', 'first.ts');
  const secondPaused = path.join(root, 'src', 'second.ts');
  backend.emit(firstPaused, 'change');
  backend.emit(secondPaused, 'unlink');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(events.length, 1, 'paused watcher must not invoke the handler');

  watcher.resume();
  await waitFor(() => events.length === 3);
  assert.deepStrictEqual(
    events.slice(1).map(({ filePath, event }) => [path.basename(filePath), event]),
    [
      ['first.ts', 'change'],
      ['second.ts', 'unlink'],
    ]
  );

  const cancelled = path.join(root, 'src', 'cancelled.ts');
  backend.emit(cancelled, 'change');
  watcher.stop();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.strictEqual(events.length, 3, 'stop should clear unsettled events');
  assert.strictEqual(backend.disposed, true);
}

async function main(): Promise<void> {
  await testCoalesceFilterPauseResumeAndDispose();
  console.log('fileWatcher tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
