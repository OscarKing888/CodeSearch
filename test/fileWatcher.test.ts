import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as path from 'path';
import { minimatch } from 'minimatch';
import {
  ChokidarFileWatchBackend,
  FileChangeEvent,
  FileWatchBackend,
  FileWatchBackendStartOptions,
  FileWatcher,
  VsCodeFileWatchBackend,
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

async function testDirectoryDeletesSurviveFileFiltersAndOldCallbacksAreIgnored(): Promise<void> {
  const backend = new FakeBackend();
  const watcher = new FileWatcher({ backend, settleMs: 5 });
  const root = path.join(process.cwd(), 'fake-watcher-root');
  const events: Array<{ filePath: string; event: FileChangeEvent }> = [];
  const config = {
    ...DEFAULT_INDEXING_SETTINGS,
    includeGlobs: ['**/*.ts'],
    excludeDirNames: ['vendor'],
    excludeFileNames: [],
    excludeGlobs: [],
  };
  const onEvent = (filePath: string, event: FileChangeEvent): void => {
    events.push({ filePath, event });
  };

  try {
    watcher.start([root], config, onEvent);
    const oldSubscription = backend.options!;
    const sourceDir = path.join(root, 'src');
    const previouslyIncludedDir = path.join(root, 'vendor');
    backend.emit(sourceDir, 'unlink');
    backend.emit(previouslyIncludedDir, 'unlink');
    backend.emit(path.join(root, 'vendor', 'ignored.ts'), 'add');
    await waitFor(() => events.length === 2);
    assert.deepStrictEqual(events, [
      { filePath: sourceDir, event: 'unlink' },
      { filePath: previouslyIncludedDir, event: 'unlink' },
    ]);

    watcher.start([root], config, onEvent);
    oldSubscription.onEvent(path.join(root, 'stale.ts'), 'unlink');
    const currentFile = path.join(root, 'current.ts');
    backend.emit(currentFile, 'change');
    await waitFor(() => events.some((event) => event.filePath === currentFile));
    assert.deepStrictEqual(events.slice(2), [
      { filePath: currentFile, event: 'change' },
    ], 'events queued by a disposed backend must not enter the new watch generation');
  } finally {
    watcher.stop();
  }
}

async function testVsCodeReceivesCollapsedDirectoryDeletesWithNarrowIncludes(): Promise<void> {
  type Uri = { fsPath: string };
  type Listener = (uri: Uri) => void;
  type Registration = {
    pattern: { base: string; pattern: string };
    listeners: Partial<Record<FileChangeEvent, Listener>>;
    ignored: Record<FileChangeEvent, boolean>;
    disposed: boolean;
  };
  const registrations: Registration[] = [];
  const vscode = {
    RelativePattern: class {
      constructor(readonly base: string, readonly pattern: string) {}
    },
    workspace: {
      createFileSystemWatcher(
        pattern: Registration['pattern'],
        ignoreCreateEvents = false,
        ignoreChangeEvents = false,
        ignoreDeleteEvents = false
      ) {
        const registration: Registration = {
          pattern,
          listeners: {},
          ignored: {
            add: ignoreCreateEvents,
            change: ignoreChangeEvents,
            unlink: ignoreDeleteEvents,
          },
          disposed: false,
        };
        registrations.push(registration);
        const listen = (event: FileChangeEvent, callback: Listener) => {
          registration.listeners[event] = callback;
          return { dispose: () => { delete registration.listeners[event]; } };
        };
        return {
          onDidCreate: (callback: Listener) => listen('add', callback),
          onDidChange: (callback: Listener) => listen('change', callback),
          onDidDelete: (callback: Listener) => listen('unlink', callback),
          dispose: () => { registration.disposed = true; },
        };
      },
    },
  };
  const emit = (filePath: string, event: FileChangeEvent): void => {
    for (const registration of registrations) {
      const relative = path.relative(registration.pattern.base, filePath).replace(/\\/g, '/');
      if (!registration.ignored[event] && minimatch(relative, registration.pattern.pattern)) {
        registration.listeners[event]?.({ fsPath: filePath });
      }
    }
  };
  const watcher = new FileWatcher({
    backend: new VsCodeFileWatchBackend(vscode as unknown as typeof import('vscode')),
    settleMs: 5,
  });
  const root = path.join(process.cwd(), 'fake-watcher-root');
  const events: Array<{ filePath: string; event: FileChangeEvent }> = [];

  try {
    watcher.start([root, root], {
      ...DEFAULT_INDEXING_SETTINGS,
      includeGlobs: ['**/*.ts', '**/*.ts'],
    }, (filePath, event) => { events.push({ filePath, event }); });
    const sourceDir = path.join(root, 'src');
    const sourceFile = path.join(root, 'keep.ts');
    emit(sourceDir, 'unlink');
    emit(sourceFile, 'change');
    emit(path.join(root, 'skip.cpp'), 'change');
    await waitFor(() => events.length === 2);
    assert.deepStrictEqual(events, [
      { filePath: sourceDir, event: 'unlink' },
      { filePath: sourceFile, event: 'change' },
    ]);
    assert.strictEqual(registrations.length, 2, 'duplicate roots and include globs need no duplicate watchers');
  } finally {
    watcher.stop();
  }
  assert.ok(registrations.every((registration) => registration.disposed));
}

async function testChokidarForwardsDirectoryDeletes(): Promise<void> {
  const chokidar = require('chokidar') as typeof import('chokidar');
  const originalWatch = chokidar.watch;
  const nativeWatcher = new EventEmitter() as EventEmitter & { close(): Promise<void> };
  let closed = false;
  nativeWatcher.close = async () => { closed = true; };
  const watcher = new FileWatcher({ backend: new ChokidarFileWatchBackend(), settleMs: 5 });
  const root = path.join(process.cwd(), 'fake-watcher-root');
  const events: Array<{ filePath: string; event: FileChangeEvent }> = [];
  try {
    chokidar.watch = (() => nativeWatcher) as unknown as typeof chokidar.watch;
    watcher.start([root], {
      ...DEFAULT_INDEXING_SETTINGS,
      includeGlobs: ['**/*.ts'],
    }, (filePath, event) => { events.push({ filePath, event }); });
    const sourceDir = path.join(root, 'src');
    nativeWatcher.emit('unlinkDir', sourceDir);
    await waitFor(() => events.length === 1);
    assert.deepStrictEqual(events, [{ filePath: sourceDir, event: 'unlink' }]);
  } finally {
    chokidar.watch = originalWatch;
    watcher.stop();
  }
  assert.strictEqual(closed, true);
}

async function main(): Promise<void> {
  await testCoalesceFilterPauseResumeAndDispose();
  await testDirectoryDeletesSurviveFileFiltersAndOldCallbacksAreIgnored();
  await testVsCodeReceivesCollapsedDirectoryDeletesWithNarrowIncludes();
  await testChokidarForwardsDirectoryDeletes();
  console.log('fileWatcher tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
