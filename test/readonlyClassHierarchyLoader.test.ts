import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractClassDeclarations } from '../src/hierarchy/classHierarchy';
import { ClassHierarchyCacheStore } from '../src/hierarchy/classHierarchyCacheStore';
import { ReadonlyClassHierarchyLoader } from '../src/hierarchy/ReadonlyClassHierarchyLoader';
import { IndexService } from '../src/index/IndexService';

function insertFile(
  service: IndexService,
  filePath: string,
  content: string,
  mtime: number
): number {
  const db = service.getDatabase();
  assert.ok(db);
  const result = db.prepare(`
    INSERT INTO files (path, mtime, size, ext, dir, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    filePath,
    mtime,
    Buffer.byteLength(content),
    path.extname(filePath).slice(1),
    path.dirname(filePath),
    content
  );
  return Number(result.lastInsertRowid);
}

async function testCachedAndStaleSnapshots(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readonly-hierarchy-'));
  const service = new IndexService(path.join(directory, 'index.db'), {
    id: 'idx_test',
    name: 'Test',
  });
  const loader = new ReadonlyClassHierarchyLoader({ useWorkers: false });
  try {
    await service.initialize(['/indexed']);
    insertFile(service, '/indexed/Base.h', 'class Base {};\n', 100);
    insertFile(
      service,
      '/indexed/Child.h',
      'class Child : public Base {};\n',
      200
    );
    const db = service.getDatabase();
    assert.ok(db);
    const store = new ClassHierarchyCacheStore(db!, { readOnly: false });
    store.initialize();
    const pending = store.listPendingFiles({ limit: 20 }).files;
    const sources = store.readSources(pending);
    store.applyParsedFiles(
      sources.map((source) => ({
        fileId: source.fileId,
        path: source.path,
        mtime: source.mtime,
        size: source.size,
        fingerprint: source.fingerprint,
        declarations: extractClassDeclarations(source.content, source.path),
      }))
    );

    const cached = await loader.build(service, 'idx_test');
    assert.strictEqual(cached.fallbackParsedFileCount, 0);
    assert.strictEqual(cached.parsedFileCount, 2);
    assert.strictEqual(cached.partialIndex, true);
    assert.ok(cached.hierarchy.nodes.some((node) => node.name === 'Child'));

    const replacement = 'class Renamed : public Base {};\n';
    db!
      .prepare(
        'UPDATE files SET content = ?, mtime = ?, size = ? WHERE path = ?'
      )
      .run(
        replacement,
        300,
        Buffer.byteLength(replacement),
        '/indexed/Child.h'
      );
    assert.strictEqual(store.listPendingFiles({ limit: 20 }).files.length, 1);

    const stale = await loader.build(service, 'idx_test');
    assert.strictEqual(stale.fallbackParsedFileCount, 1);
    assert.ok(stale.hierarchy.nodes.some((node) => node.name === 'Renamed'));
    assert.strictEqual(
      store.listPendingFiles({ limit: 20 }).files.length,
      1,
      'read-only snapshot parsing must not update cache rows'
    );
  } finally {
    await loader.dispose();
    service.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

testCachedAndStaleSnapshots()
  .then(() => console.log('readonlyClassHierarchyLoader tests passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
