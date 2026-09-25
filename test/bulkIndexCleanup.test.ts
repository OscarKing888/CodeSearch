import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileWatcher } from '../src/index/FileWatcher';
import { IndexService } from '../src/index/IndexService';
import { IndexingSettings } from '../src/indexingSettings';
import { SqliteDatabase, SqliteStatement } from '../src/native/betterSqlite3';
import { SearchService } from '../src/search/SearchService';
import { FileRecord } from '../src/types';

interface ServiceHooks {
  watcher: FileWatcher;
  deleteFtsStmt: SqliteStatement;
  indexingGeneration: number;
  getEffectiveSettings(): IndexingSettings;
  indexBatch(records: FileRecord[], generation: number): void;
  handleFileChange(
    filePath: string,
    event: 'unlink',
    config: IndexingSettings,
    generation: number
  ): Promise<void>;
  reconcileIndexedFiles(
    filePaths: string[],
    config: IndexingSettings,
    generation: number,
    refreshPath?: string
  ): Promise<void>;
}

interface Fixture {
  root: string;
  dbPath: string;
  service: IndexService;
  hooks: ServiceHooks;
  db: SqliteDatabase;
  record(relativePath: string, keyword: string, exists?: boolean): FileRecord;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-bulk-cleanup-'));
  const root = path.join(temporary, 'sources');
  const dbPath = path.join(temporary, 'index.db');
  fs.mkdirSync(root);
  const service = new IndexService(dbPath);
  const hooks = service as unknown as ServiceHooks;
  hooks.watcher = new FileWatcher({
    backend: { start: () => ({ dispose() {} }) },
    settleMs: 0,
  });
  try {
    await service.initialize([root]);
    const db = service.getDatabase();
    assert.ok(db);
    await run({
      root,
      dbPath,
      service,
      hooks,
      db,
      record(relativePath, keyword, exists = false) {
        const filePath = path.join(root, relativePath);
        const content = `export const ${keyword} = true;\n`;
        if (exists) {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content, 'utf8');
        }
        return {
          path: filePath,
          mtime: exists ? Math.floor(fs.statSync(filePath).mtimeMs) : 1,
          size: Buffer.byteLength(content),
          ext: path.extname(filePath).slice(1),
          dir: path.dirname(filePath),
          content,
        };
      },
    });
  } finally {
    service.dispose();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function assertRows(db: SqliteDatabase, filePath: string, expected: number): void {
  for (const table of ['files', 'files_fts']) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE path = ?`)
      .get(filePath) as { count: number };
    assert.strictEqual(row.count, expected, `${table}: ${filePath}`);
  }
}

function assertSearchCount(service: IndexService, query: string, expected: number): void {
  const result = new SearchService(service).search(query, {
    caseSensitive: false,
    phraseSearch: true,
    contextLines: 0,
    maxResults: 100,
    fuzzy: false,
    loose: false,
    looseGap: 10,
  });
  assert.strictEqual(result.hitCount, expected, `search: ${query}`);
}

async function withoutPathFtsDeletes(hooks: ServiceHooks, run: () => Promise<void>): Promise<void> {
  const statement = hooks.deleteFtsStmt;
  const originalRun = statement.run;
  let calls = 0;
  statement.run = ((...args: unknown[]) => {
    calls++;
    return originalRun.apply(statement, args);
  }) as typeof statement.run;
  try {
    await run();
    assert.strictEqual(calls, 0, 'bulk cleanup must not scan FTS once for every removed path');
  } finally {
    statement.run = originalRun;
  }
}

function observeFtsPages(db: SqliteDatabase, afterRead: (page: number) => void): () => void {
  const originalPrepare = db.prepare;
  let pages = 0;
  db.prepare = ((sql: string) => {
    const statement = originalPrepare.call(db, sql) as SqliteStatement;
    if (/SELECT\s+rowid\s*,\s*path\s+FROM\s+files_fts\b/i.test(sql)) {
      const originalAll = statement.all;
      statement.all = ((...args: unknown[]) => {
        const rows = originalAll.apply(statement, args);
        afterRead(++pages);
        return rows;
      }) as typeof statement.all;
    }
    return statement;
  }) as typeof db.prepare;
  return () => { db.prepare = originalPrepare; };
}

async function testRefreshRemovesDriftedAndDuplicateFtsRows(): Promise<void> {
  await withFixture(async ({ service, hooks, db, record }) => {
    const removed = Array.from({ length: 32 }, (_, i) => record(`removed-${i}.ts`, 'bulkRemovedKeyword'));
    const kept = record('kept.ts', 'bulkKeptKeyword', true);
    db.transaction(() => {
      for (const item of [...removed, kept]) {
        service.indexFile(item);
      }
      // 更新会重新插入 FTS 行，不能把 files.id 当作 FTS rowid。
      for (const item of removed) {
        service.indexFile(item);
      }
      db.prepare('INSERT INTO files_fts (path, content) VALUES (?, ?)')
        .run(removed[0].path, removed[0].content);
    })();
    const file = db.prepare('SELECT id FROM files WHERE path = ?').get(removed[1].path) as { id: number };
    const fts = db.prepare('SELECT rowid FROM files_fts WHERE path = ?').get(removed[1].path) as { rowid: number };
    assert.notStrictEqual(file.id, fts.rowid, 'the fixture must exercise historical rowid drift');

    await withoutPathFtsDeletes(hooks, () => service.refresh(false));
    for (const item of removed) {
      assertRows(db, item.path, 0);
    }
    assertRows(db, kept.path, 1);
    assertSearchCount(service, 'bulkRemovedKeyword', 0);
    assertSearchCount(service, 'bulkKeptKeyword', 1);
  });
}

async function testDirectoryDeletionUsesBulkCleanup(): Promise<void> {
  await withFixture(async ({ root, service, hooks, db, record }) => {
    const removed = Array.from({ length: 24 }, (_, i) => record(`removed%_folder/nested/file-${i}.ts`, 'folderRemovedKeyword'));
    const kept = record('removed%_folder-neighbor/kept.ts', 'folderKeptKeyword', true);
    db.transaction(() => {
      for (const item of [...removed, kept]) {
        service.indexFile(item);
      }
    })();
    await withoutPathFtsDeletes(hooks, () => hooks.handleFileChange(
      path.join(root, 'removed%_folder'),
      'unlink',
      hooks.getEffectiveSettings(),
      hooks.indexingGeneration
    ));
    for (const item of removed) {
      assertRows(db, item.path, 0);
    }
    assertRows(db, kept.path, 1);
    assertSearchCount(service, 'folderRemovedKeyword', 0);
  });
}

async function testStartupPurgesBeforeWritingContentBatches(): Promise<void> {
  await withFixture(async ({ service, hooks, db, record }) => {
    const removed = record('removed.ts', 'earlyPurgedKeyword');
    const added = record('added.ts', 'newBatchKeyword', true);
    service.indexFile(removed);
    const originalIndexBatch = hooks.indexBatch;
    let inspected = false;
    hooks.indexBatch = (records, generation) => {
      if (!inspected) {
        inspected = true;
        assertRows(db, removed.path, 0);
      }
      originalIndexBatch.call(service, records, generation);
    };
    try {
      await service.refresh(false);
    } finally {
      hooks.indexBatch = originalIndexBatch;
    }
    assert.ok(inspected, 'the fixture must write a content batch');
    assertRows(db, removed.path, 0);
    assertRows(db, added.path, 1);
    assertSearchCount(service, 'newBatchKeyword', 1);
  });
}

async function testRecreationDuringPausePreservesFile(): Promise<void> {
  await withFixture(async ({ service, hooks, db, record }) => {
    const recreated = record('recreated.ts', 'pausedRecreatedKeyword');
    service.indexFile(recreated);
    const originalStat = fs.promises.stat;
    let signalPaused!: () => void;
    const paused = new Promise<void>((resolve) => { signalPaused = resolve; });
    let targetChecks = 0;
    fs.promises.stat = (async (...args: Parameters<typeof fs.promises.stat>) => {
      if (String(args[0]) === recreated.path && ++targetChecks === 1) {
        try {
          return await originalStat(...args);
        } catch (error) {
          service.pause();
          signalPaused();
          throw error;
        }
      }
      return originalStat(...args);
    }) as typeof fs.promises.stat;
    let pending: Promise<void> | undefined;
    try {
      pending = hooks.reconcileIndexedFiles(
        [recreated.path], hooks.getEffectiveSettings(), hooks.indexingGeneration
      );
      await paused;
      // 让异步 stat 返回，并确保清理已进入暂停等待，再模拟同路径重建。
      await new Promise<void>((resolve) => setImmediate(resolve));
      assertRows(db, recreated.path, 1);
      fs.writeFileSync(recreated.path, recreated.content, 'utf8');
      service.resume();
      await pending;
      assert.ok(targetChecks >= 2, 'resuming cleanup must recheck the filesystem');
      assertRows(db, recreated.path, 1);
    } finally {
      fs.promises.stat = originalStat;
      service.resume();
      await pending?.catch(() => undefined);
    }
  });
}

async function testRecreationWhileScanningFtsPreservesFile(): Promise<void> {
  await withFixture(async ({ service, hooks, db, record }) => {
    const recreated = record('recreated.ts', 'recreatedKeyword');
    const removed = record('removed.ts', 'scannedRemovedKeyword');
    db.transaction(() => {
      service.indexFile(recreated);
      // 额外记录强制跨页扫描，目标路径不需要位于同一页。
      for (let i = 0; i < 2050; i++) {
        service.indexFile(record(`unrelated-${i}.ts`, 'unrelatedKeyword'));
      }
      service.indexFile(removed);
    })();
    let pages = 0;
    const restore = observeFtsPages(db, (page) => {
      pages = page;
      if (page === 1) {
        setImmediate(() => fs.writeFileSync(recreated.path, recreated.content, 'utf8'));
      }
    });
    try {
      await hooks.reconcileIndexedFiles(
        [recreated.path, removed.path], hooks.getEffectiveSettings(), hooks.indexingGeneration
      );
    } finally {
      restore();
    }
    assert.ok(pages >= 2, 'cleanup must scan every FTS page');
    assertRows(db, recreated.path, 1);
    assertRows(db, removed.path, 0);
    assertSearchCount(service, 'recreatedKeyword', 1);
    assertSearchCount(service, 'scannedRemovedKeyword', 0);
  });
}

async function testDisposeWhileScanningFtsDoesNotWrite(): Promise<void> {
  await withFixture(async ({ root, dbPath, service, hooks, db, record }) => {
    const removed = record('removed.ts', 'cancelledCleanupKeyword');
    db.transaction(() => {
      service.indexFile(removed);
      for (let i = 0; i < 2050; i++) {
        service.indexFile(record(`unrelated-${i}.ts`, 'unrelatedKeyword'));
      }
    })();
    let disposedDuringScan = false;
    const restore = observeFtsPages(db, (page) => {
      if (page === 1) {
        setImmediate(() => {
          disposedDuringScan = true;
          service.dispose();
        });
      }
    });
    try {
      await hooks.reconcileIndexedFiles(
        [removed.path], hooks.getEffectiveSettings(), hooks.indexingGeneration
      );
    } finally {
      restore();
    }
    assert.ok(disposedDuringScan, 'dispose must happen during FTS collection');
    const reader = new IndexService(dbPath, { readOnly: true });
    try {
      await reader.initialize([root]);
      const readerDb = reader.getDatabase();
      assert.ok(readerDb);
      assertRows(readerDb, removed.path, 1);
    } finally {
      reader.dispose();
    }
  });
}

async function testGenerationChangeWhileScanningFtsDoesNotWrite(): Promise<void> {
  await withFixture(async ({ service, hooks, db, record }) => {
    const removed = record('removed.ts', 'staleGenerationKeyword');
    db.transaction(() => {
      service.indexFile(removed);
      for (let i = 0; i < 2050; i++) {
        service.indexFile(record(`unrelated-${i}.ts`, 'unrelatedKeyword'));
      }
    })();
    let invalidated = false;
    const restore = observeFtsPages(db, (page) => {
      if (page === 1) {
        setImmediate(() => {
          invalidated = true;
          hooks.indexingGeneration++;
        });
      }
    });
    try {
      await hooks.reconcileIndexedFiles(
        [removed.path], hooks.getEffectiveSettings(), hooks.indexingGeneration
      );
    } finally {
      restore();
    }
    assert.ok(invalidated, 'the generation must change during FTS collection');
    assertRows(db, removed.path, 1);
  });
}

async function run(): Promise<void> {
  const tests = [
    testRefreshRemovesDriftedAndDuplicateFtsRows,
    testDirectoryDeletionUsesBulkCleanup,
    testStartupPurgesBeforeWritingContentBatches,
    testRecreationWhileScanningFtsPreservesFile,
    testRecreationDuringPausePreservesFile,
    testDisposeWhileScanningFtsDoesNotWrite,
    testGenerationChangeWhileScanningFtsDoesNotWrite,
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
  assert.deepStrictEqual(failures, [], 'all bulk cleanup regressions must pass');
  console.log('bulkIndexCleanup.test.ts: all passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
