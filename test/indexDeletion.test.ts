import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FileChangeEvent,
  FileWatchBackend,
  FileWatchBackendStartOptions,
  FileWatcher,
} from '../src/index/FileWatcher';
import { IndexService } from '../src/index/IndexService';
import { IndexingSettings } from '../src/indexingSettings';
import { SearchService } from '../src/search/SearchService';
import { FileRecord, IndexProgress } from '../src/types';

const searchOptions = {
  caseSensitive: false,
  phraseSearch: true,
  contextLines: 0,
  maxResults: 100,
  fuzzy: false,
  loose: false,
  looseGap: 10,
};

class FakeBackend implements FileWatchBackend {
  private options: FileWatchBackendStartOptions | undefined;

  start(options: FileWatchBackendStartOptions): { dispose(): void } {
    this.options = options;
    return {
      dispose: () => {
        if (this.options === options) {
          this.options = undefined;
        }
      },
    };
  }

  emit(filePath: string, event: FileChangeEvent): void {
    this.options?.onEvent(filePath, event);
  }
}

interface ServiceHooks {
  watcher: FileWatcher;
  indexBatch(records: FileRecord[], generation: number): void;
  handleFileChange(
    filePath: string,
    event: FileChangeEvent,
    config: IndexingSettings,
    generation: number
  ): Promise<void>;
}

interface WatchedService {
  service: IndexService;
  backend: FakeBackend;
  processed: Array<{ path: string; event: FileChangeEvent }>;
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withFixture(
  run: (fixture: {
    root: string;
    write(relativePath: string, keyword: string): string;
    open(): Promise<WatchedService>;
  }) => Promise<void>
): Promise<void> {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-index-deletion-'));
  const root = path.join(temporary, 'sources');
  const dbPath = path.join(temporary, 'database', 'index.db');
  const services: IndexService[] = [];
  fs.mkdirSync(root, { recursive: true });
  try {
    await run({
      root,
      write(relativePath, keyword) {
        const filePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `export const ${keyword} = true;\n`, 'utf8');
        return filePath;
      },
      async open() {
        const service = new IndexService(dbPath);
        services.push(service);
        const backend = new FakeBackend();
        const processed: WatchedService['processed'] = [];
        const hooks = service as unknown as ServiceHooks;
        hooks.watcher = new FileWatcher({ backend, settleMs: 0 });
        const originalHandle = hooks.handleFileChange.bind(service);
        hooks.handleFileChange = async (filePath, event, config, generation) => {
          await originalHandle(filePath, event, config, generation);
          processed.push({ path: filePath, event });
        };
        await service.initialize([root]);
        return { service, backend, processed };
      },
    });
  } finally {
    for (const service of services) {
      service.dispose();
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function assertIndexed(
  service: IndexService,
  filePath: string,
  keyword: string,
  expected: boolean
): void {
  const db = service.getDatabase();
  assert.ok(db, 'the test database must remain open');
  for (const table of ['files', 'files_fts']) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE path = ?`)
      .get(filePath) as { count: number };
    assert.strictEqual(row.count, expected ? 1 : 0, `${table}: ${filePath}`);
  }
  const result = new SearchService(service).search(keyword, searchOptions);
  assert.strictEqual(result.hitCount, expected ? 1 : 0, `search: ${keyword}`);
}

async function testOfflineDeletionOnIncrementalStartup(): Promise<void> {
  await withFixture(async ({ write, open }) => {
    const removed = write('removed.ts', 'offlineDeletedKeyword');
    const kept = write('kept.ts', 'offlineKeptKeyword');
    const first = await open();
    await first.service.startIndexing(false);
    assertIndexed(first.service, removed, 'offlineDeletedKeyword', true);
    first.service.dispose();
    fs.unlinkSync(removed);

    const reopened = await open();
    await reopened.service.startIndexing(false);
    assertIndexed(reopened.service, removed, 'offlineDeletedKeyword', false);
    assertIndexed(reopened.service, kept, 'offlineKeptKeyword', true);
  });
}

async function testMissedDeletionOnIncrementalRefresh(): Promise<void> {
  await withFixture(async ({ write, open }) => {
    const removed = write('removed.ts', 'refreshDeletedKeyword');
    const kept = write('kept.ts', 'refreshKeptKeyword');
    const { service } = await open();
    await service.startIndexing(false);
    fs.unlinkSync(removed);
    // 模拟编辑器漏发删除通知，普通刷新仍须修复已有索引。
    await service.refresh(false);
    assertIndexed(service, removed, 'refreshDeletedKeyword', false);
    assertIndexed(service, kept, 'refreshKeptKeyword', true);
  });
}

async function testUnavailableRootPreservesSnapshot(): Promise<void> {
  await withFixture(async ({ root, write, open }) => {
    const removed = write('removed.ts', 'unavailableRemovedKeyword');
    const kept = write('kept.ts', 'unavailableKeptKeyword');
    const first = await open();
    await first.service.startIndexing(false);
    first.service.dispose();
    const offlineRoot = `${root}-offline`;
    fs.renameSync(root, offlineRoot);
    const reopened = await open();
    await reopened.service.startIndexing(false);
    assertIndexed(reopened.service, removed, 'unavailableRemovedKeyword', true);
    assertIndexed(reopened.service, kept, 'unavailableKeptKeyword', true);

    fs.renameSync(offlineRoot, root);
    fs.unlinkSync(removed);
    await reopened.service.refresh(false);
    assertIndexed(reopened.service, removed, 'unavailableRemovedKeyword', false);
    assertIndexed(reopened.service, kept, 'unavailableKeptKeyword', true);
  });
}

async function testParentDirectoryDeletion(): Promise<void> {
  await withFixture(async ({ root, write, open }) => {
    const removed = write('part%_name/direct.ts', 'directoryDeletedKeyword');
    const descendant = write('part%_name/nested/deep.ts', 'descendantDeletedKeyword');
    const sibling = write('part%_name-copy/keep.ts', 'boundaryKeptKeyword');
    const wildcardNeighbor = write('partZZname/keep.ts', 'wildcardKeptKeyword');
    const special = write('special%_kept.ts', 'specialKeptKeyword');
    const watched = await open();
    await watched.service.startIndexing(false);
    const removedDirectory = path.join(root, 'part%_name');
    fs.rmSync(removedDirectory, { recursive: true });
    watched.backend.emit(removedDirectory, 'unlink');
    await waitFor(() => watched.processed.length === 1, 'parent directory deletion');
    assertIndexed(watched.service, removed, 'directoryDeletedKeyword', false);
    assertIndexed(watched.service, descendant, 'descendantDeletedKeyword', false);
    assertIndexed(watched.service, sibling, 'boundaryKeptKeyword', true);
    assertIndexed(watched.service, wildcardNeighbor, 'wildcardKeptKeyword', true);
    assertIndexed(watched.service, special, 'specialKeptKeyword', true);
  });
}

async function testDeletionDuringScanning(): Promise<void> {
  await withFixture(async ({ write, open }) => {
    const removed = write('removed.ts', 'scanningDeletedKeyword');
    for (let i = 0; i < 60; i++) {
      write(`scan-${i}.ts`, `scanFiller${i}`);
    }
    const watched = await open();
    await watched.service.startIndexing(false);
    let deleted = false;
    watched.service.on('progress', (progress: IndexProgress) => {
      if (!deleted && progress.status === 'scanning' && (progress.scanned ?? 0) >= 50) {
        deleted = true;
        fs.unlinkSync(removed);
        watched.backend.emit(removed, 'unlink');
      }
    });
    await watched.service.refresh(false);
    assert.ok(deleted, 'the deletion must happen while scanning');
    await waitFor(() => watched.processed.some((event) => event.path === removed),
      'deletion queued during scanning');
    assertIndexed(watched.service, removed, 'scanningDeletedKeyword', false);
  });
}

async function testCoalescedDirectoryReplacement(): Promise<void> {
  await withFixture(async ({ root, write, open }) => {
    const removed = write('replaced/removed.ts', 'replacementDeletedKeyword');
    const kept = write('replaced/kept.ts', 'replacementKeptKeyword');
    const watched = await open();
    await watched.service.startIndexing(false);
    const directory = path.join(root, 'replaced');
    fs.rmSync(directory, { recursive: true });
    write('replaced/kept.ts', 'replacementKeptKeyword');
    watched.backend.emit(directory, 'unlink');
    watched.backend.emit(directory, 'add');
    await waitFor(() => watched.processed.length === 1, 'coalesced directory replacement');
    assert.strictEqual(watched.processed[0].event, 'add');
    assertIndexed(watched.service, removed, 'replacementDeletedKeyword', false);
    assertIndexed(watched.service, kept, 'replacementKeptKeyword', true);
  });
}

async function testDeletionAfterBatchRead(): Promise<void> {
  await withFixture(async ({ write, open }) => {
    const removed = write('removed.ts', 'batchDeletedKeyword');
    const kept = write('kept.ts', 'batchKeptKeyword');
    const watched = await open();
    const hooks = watched.service as unknown as ServiceHooks;
    const originalIndexBatch = hooks.indexBatch.bind(watched.service);
    let deleted = false;
    hooks.indexBatch = (records, generation) => {
      if (!deleted && records.some((record) => record.path === removed)) {
        deleted = true;
        // 文件已读入内存，但尚未提交：稍后批量写入不能让删除条目永久复活。
        fs.unlinkSync(removed);
        watched.backend.emit(removed, 'unlink');
      }
      originalIndexBatch(records, generation);
    };
    await watched.service.startIndexing(false);
    assert.ok(deleted, 'the deletion must occur after the batch read');
    await waitFor(() => watched.processed.some((event) => event.path === removed),
      'deletion queued before batch commit');
    assertIndexed(watched.service, removed, 'batchDeletedKeyword', false);
    assertIndexed(watched.service, kept, 'batchKeptKeyword', true);
  });
}

async function testDelayedDeletionAfterRecreation(): Promise<void> {
  await withFixture(async ({ write, open }) => {
    const recreated = write('recreated.ts', 'originalKeyword');
    const watched = await open();
    await watched.service.startIndexing(false);
    fs.unlinkSync(recreated);
    write('recreated.ts', 'recreatedKeyword');
    watched.backend.emit(recreated, 'add');
    await waitFor(() => watched.processed.length === 1, 'recreated file addition');
    assertIndexed(watched.service, recreated, 'recreatedKeyword', true);
    watched.backend.emit(recreated, 'unlink');
    await waitFor(() => watched.processed.length === 2, 'late deletion notification');
    assertIndexed(watched.service, recreated, 'recreatedKeyword', true);
    assert.strictEqual(new SearchService(watched.service).search('originalKeyword', searchOptions).hitCount, 0);

    fs.unlinkSync(recreated);
    write('recreated.ts', 'recreatedWithoutAddKeyword');
    watched.backend.emit(recreated, 'unlink');
    await waitFor(() => watched.processed.length === 3, 'late deletion without an add notification');
    assertIndexed(watched.service, recreated, 'recreatedWithoutAddKeyword', true);
    assert.strictEqual(new SearchService(watched.service).search('recreatedKeyword', searchOptions).hitCount, 0);
  });
}

async function testTransientStatErrorsPreserveSnapshot(): Promise<void> {
  await withFixture(async ({ write, open }) => {
    const retained = write('retained.ts', 'permissionRetainedKeyword');
    const watched = await open();
    await watched.service.startIndexing(false);
    const originalStat = fs.promises.stat;
    let errorCode = 'EACCES';
    fs.promises.stat = ((...args: Parameters<typeof fs.promises.stat>) => {
      if (args[0] === retained) {
        return Promise.reject(Object.assign(new Error('simulated temporary stat failure'), { code: errorCode }));
      }
      return originalStat(...args);
    }) as typeof fs.promises.stat;
    try {
      for (const code of ['EACCES', 'EPERM']) {
        errorCode = code;
        await watched.service.refresh(false);
        assertIndexed(watched.service, retained, 'permissionRetainedKeyword', true);
        for (const event of ['change', 'unlink'] as const) {
          const previousCount = watched.processed.length;
          watched.backend.emit(retained, event);
          await waitFor(() => watched.processed.length === previousCount + 1, `${code} during ${event}`);
          assertIndexed(watched.service, retained, 'permissionRetainedKeyword', true);
        }
      }
    } finally {
      fs.promises.stat = originalStat;
    }
    fs.unlinkSync(retained);
    watched.backend.emit(retained, 'unlink');
    await waitFor(() => watched.processed.length === 5, 'actual deletion after stat recovery');
    assertIndexed(watched.service, retained, 'permissionRetainedKeyword', false);
  });
}

async function testTransientReadErrorPreservesSnapshot(): Promise<void> {
  await withFixture(async ({ write, open }) => {
    const retained = write('retained.ts', 'readRetainedKeyword');
    const watched = await open();
    await watched.service.startIndexing(false);
    const originalReadFile = fs.promises.readFile;
    fs.promises.readFile = ((...args: Parameters<typeof fs.promises.readFile>) => {
      if (args[0] === retained) {
        return Promise.reject(Object.assign(new Error('simulated temporary read failure'), { code: 'EIO' }));
      }
      return originalReadFile(...args);
    }) as typeof fs.promises.readFile;
    try {
      watched.backend.emit(retained, 'change');
      await waitFor(() => watched.processed.length === 1, 'transient read failure');
      assertIndexed(watched.service, retained, 'readRetainedKeyword', true);
    } finally {
      fs.promises.readFile = originalReadFile;
    }
  });
}

async function testWindowsDeletionPathCasing(): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  await withFixture(async ({ root, write, open }) => {
    const removed = write('CaseFolder/MixedCase.ts', 'windowsDeletedKeyword');
    const watched = await open();
    await watched.service.startIndexing(false);
    fs.rmSync(path.join(root, 'CaseFolder'), { recursive: true });
    watched.backend.emit(path.join(root, 'casefolder').toUpperCase(), 'unlink');
    await waitFor(() => watched.processed.length === 1, 'Windows case-insensitive directory deletion');
    assertIndexed(watched.service, removed, 'windowsDeletedKeyword', false);
  });
}

async function run(): Promise<void> {
  const tests = [
    testOfflineDeletionOnIncrementalStartup,
    testMissedDeletionOnIncrementalRefresh,
    testUnavailableRootPreservesSnapshot,
    testParentDirectoryDeletion,
    testDeletionDuringScanning,
    testCoalescedDirectoryReplacement,
    testDeletionAfterBatchRead,
    testDelayedDeletionAfterRecreation,
    testTransientStatErrorsPreserveSnapshot,
    testTransientReadErrorPreservesSnapshot,
    testWindowsDeletionPathCasing,
  ];
  const failures: string[] = [];
  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      failures.push(test.name);
      console.error(`${test.name}:`, error);
    }
  }
  assert.deepStrictEqual(failures, [], 'all index deletion regressions must pass');
  console.log('indexDeletion.test.ts: all passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
