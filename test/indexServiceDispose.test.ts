import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexService } from '../src/index/IndexService';

async function run(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-index-dispose-'));
  const dbPath = path.join(temp, 'index.db');
  const delayedPath = path.join(temp, 'delayed.ts');
  fs.writeFileSync(delayedPath, 'export const delayed = true;\n', 'utf8');

  const service = new IndexService(dbPath);
  await service.initialize([temp]);
  const db = service.getDatabase();
  assert.ok(db);
  db.prepare(
    `INSERT INTO files (path, mtime, size, ext, dir, content)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(path.join(temp, 'seed.ts'), 1, 1, 'ts', temp, 'seed');

  // Keep a better-sqlite3 iterator alive across dispose(). Its presence makes
  // Database#close throw, matching a streaming search suspended at a batch.
  const iterator = db.prepare('SELECT path FROM files').iterate()[Symbol.iterator]();
  assert.strictEqual(iterator.next().done, false);

  const promises = fs.promises as unknown as {
    stat: (...args: unknown[]) => Promise<fs.Stats>;
  };
  const originalStat = promises.stat;
  let signalStatStarted!: () => void;
  let resumeStat!: () => void;
  const statStarted = new Promise<void>((resolve) => {
    signalStatStarted = resolve;
  });
  const statGate = new Promise<void>((resolve) => {
    resumeStat = resolve;
  });
  let delayed = false;
  promises.stat = async (...args: unknown[]) => {
    if (!delayed && path.resolve(String(args[0])) === path.resolve(delayedPath)) {
      delayed = true;
      signalStatStarted();
      await statGate;
    }
    return originalStat(...args);
  };

  let pending: Promise<void> | undefined;
  try {
    pending = service.indexSingleFile(delayedPath);
    await statStarted;

    assert.doesNotThrow(() => service.dispose());
    assert.strictEqual(
      service.getDatabase(),
      undefined,
      'dispose must detach the database even when close reports an active iterator'
    );

    resumeStat();
    await pending;
    iterator.return?.();

    const row = db.prepare('SELECT 1 AS found FROM files WHERE path = ?').get(delayedPath);
    assert.strictEqual(
      row,
      undefined,
      'an async file callback must not write after dispose invalidates its generation'
    );
  } finally {
    promises.stat = originalStat;
    resumeStat();
    await pending?.catch(() => undefined);
    iterator.return?.();
    try {
      db.close();
    } catch {
      // The assertions above cover the safety invariant; cleanup is best effort.
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }

  console.log('indexServiceDispose.test.ts: all passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
