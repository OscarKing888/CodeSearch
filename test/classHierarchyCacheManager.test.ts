import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { ClassHierarchyCacheManager } from '../src/hierarchy/ClassHierarchyCacheManager';
import { IndexManager } from '../src/index/IndexManager';
import { IndexService } from '../src/index/IndexService';

class FakeIndexManager extends EventEmitter {
  mappedRoot = '/mapped/';
  emitProgressDuringNextMap = false;

  constructor(private readonly service: IndexService) {
    super();
  }

  getAllServices(): IndexService[] {
    return [this.service];
  }

  isPartialIndex(): boolean {
    return false;
  }

  mapHitPath(_indexId: string, filePath: string): string {
    if (this.emitProgressDuringNextMap) {
      this.emitProgressDuringNextMap = false;
      this.emit('progress', {});
    }
    return filePath.replace('/indexed/', this.mappedRoot);
  }
}

function insertFile(service: IndexService, filePath: string, content: string, mtime: number): void {
  const db = service.getDatabase();
  assert.ok(db);
  db.prepare(`
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
}

async function testBuildsAndRefreshesWorkspaceCache(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-hierarchy-manager-'));
  const service = new IndexService(path.join(directory, 'index.db'), {
    id: 'primary',
    name: 'Primary',
  });
  let cache: ClassHierarchyCacheManager | undefined;
  try {
    await service.initialize(['/indexed']);
    insertFile(service, '/indexed/Base.h', 'class Base {};\n', 100);
    insertFile(service, '/indexed/Child.h', 'class Child : public Base {};\n', 200);

    const fakeManager = new FakeIndexManager(service);
    cache = new ClassHierarchyCacheManager(
      fakeManager as unknown as IndexManager,
      path.join(directory, 'missing-worker.js')
    );
    cache.start();

    const first = await cache.buildModel();
    assert.strictEqual(first.classCount, 2);
    assert.strictEqual(first.parsedFileCount, 2);
    assert.strictEqual(first.partialIndex, false);
    const base = first.nodes.find((node) => node.name === 'Base');
    const child = first.nodes.find((node) => node.name === 'Child');
    assert.ok(base);
    assert.ok(child);
    assert.strictEqual(child.path, '/mapped/Child.h');
    assert.ok(base.children.includes(child.id));

    fakeManager.mappedRoot = '/remapped/';
    fakeManager.emit('indexesChanged');
    const remapped = await cache.buildModel();
    assert.strictEqual(
      remapped.nodes.find((node) => node.name === 'Child')?.path,
      '/remapped/Child.h',
      'index metadata changes must invalidate mapped navigation paths'
    );

    fakeManager.mappedRoot = '/forced/';
    assert.strictEqual(
      (await cache.buildModel()).nodes.find((node) => node.name === 'Child')?.path,
      '/remapped/Child.h',
      'the normal in-memory model remains cheap when no invalidation was reported'
    );
    assert.strictEqual(
      (await cache.buildModel(undefined, true)).nodes.find((node) => node.name === 'Child')?.path,
      '/forced/Child.h',
      'an explicit panel refresh must bypass the in-memory model'
    );

    const db = service.getDatabase();
    assert.ok(db);
    const markerCount = db.prepare(
      'SELECT COUNT(*) AS count FROM class_hierarchy_files'
    ).get() as { count: number };
    assert.strictEqual(markerCount.count, 2, 'one idle sync should atomically cache the batch');

    const replacement = 'class Renamed : public Base {};\n';
    db.prepare('UPDATE files SET content = ?, mtime = ?, size = ? WHERE path = ?').run(
      replacement,
      300,
      Buffer.byteLength(replacement),
      '/indexed/Child.h'
    );
    fakeManager.emit('progress', {});
    const second = await cache.buildModel();
    assert.strictEqual(second.nodes.some((node) => node.name === 'Child'), false);
    const renamed = second.nodes.find((node) => node.name === 'Renamed');
    assert.ok(renamed);
    assert.strictEqual(renamed.path, '/forced/Child.h');
    assert.ok(second.nodes.find((node) => node.name === 'Base')?.children.includes(renamed.id));

    fakeManager.emitProgressDuringNextMap = true;
    const raced = await cache.buildModel(undefined, true);
    assert.strictEqual(raced.partialIndex, true, 'a model invalidated while building is not cached as current');

    db.prepare('DELETE FROM files WHERE path = ?').run('/indexed/Child.h');
    fakeManager.emit('progress', {});
    const afterDelete = await cache.buildModel();
    assert.strictEqual(afterDelete.nodes.some((node) => node.name === 'Renamed'), false);

    await cache.dispose();
    service.pause();
    const busyCache = new ClassHierarchyCacheManager(
      fakeManager as unknown as IndexManager,
      path.join(directory, 'missing-worker.js')
    );
    cache = busyCache;
    busyCache.start();
    const whileBusy = await busyCache.buildModel();
    assert.strictEqual(whileBusy.classCount, 1);
    assert.strictEqual(
      whileBusy.nodes.find((node) => node.name === 'Base')?.path,
      '/forced/Base.h',
      'a fresh manager may inspect an existing writable cache without schema writes while busy'
    );
    service.resume();
  } finally {
    await cache?.dispose();
    service.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

testBuildsAndRefreshesWorkspaceCache()
  .then(() => console.log('classHierarchyCacheManager tests passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
