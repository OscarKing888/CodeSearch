import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractClassDeclarations } from '../src/hierarchy/classHierarchy';
import {
  ClassHierarchyCacheStore,
  computeClassHierarchySourceFingerprint,
} from '../src/hierarchy/classHierarchyCacheStore';
import { openDatabase, SqliteDatabase } from '../src/native/betterSqlite3';

const BASE_SCHEMA = `
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  ext TEXT,
  dir TEXT,
  content TEXT NOT NULL DEFAULT ''
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

interface InsertedFile {
  id: number;
  fileId: number;
  path: string;
  mtime: number;
  size: number;
  content: string;
}

function insertFile(
  db: SqliteDatabase,
  filePath: string,
  content: string,
  mtime: number,
  ext = path.extname(filePath).replace(/^\./, '')
): InsertedFile {
  const size = Buffer.byteLength(content);
  const result = db.prepare(`
    INSERT INTO files (path, mtime, size, ext, dir, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(filePath, mtime, size, ext, path.dirname(filePath), content);
  const id = Number(result.lastInsertRowid);
  return { id, fileId: id, path: filePath, mtime, size, content };
}

function makeParsed(source: ReturnType<ClassHierarchyCacheStore['readSources']>[number]) {
  return {
    fileId: source.fileId,
    path: source.path,
    mtime: source.mtime,
    size: source.size,
    fingerprint: source.fingerprint,
    declarations: extractClassDeclarations(source.content, source.path),
  };
}

function testWritableLifecycleAndAtomicValidation(): void {
  const db = openDatabase(':memory:');
  db.exec(BASE_SCHEMA);
  const base = insertFile(db, '/src/Base.h', 'class Base {};\n', 100);
  const derived = insertFile(
    db,
    '/src/Derived.cpp',
    'class Derived final : public virtual Base {};\n',
    200
  );
  const managed = insertFile(
    db,
    '/src/Managed/ScriptChild.cs',
    'namespace Game.Managed;\npublic partial class ScriptChild : Base, IDisposable {}\n',
    250
  );
  insertFile(db, '/src/no-classes.hpp', '// intentionally empty\n', 300);
  insertFile(db, '/src/not-cpp.ts', 'class Ignored {}\n', 400);

  const store = new ClassHierarchyCacheStore(db, { readOnly: false, parserVersion: 7 });
  assert.deepStrictEqual(store.initialize(), {
    available: true,
    writable: true,
    schemaVersion: 1,
    reason: undefined,
  });

  const first = store.listPendingFiles({ limit: 2 });
  assert.deepStrictEqual(first.files.map((file) => file.path), ['/src/Base.h', '/src/Derived.cpp']);
  assert.strictEqual(first.done, false);
  const second = store.listPendingFiles({ afterFileId: first.nextAfterFileId, limit: 3 });
  assert.deepStrictEqual(second.files.map((file) => file.path), [
    '/src/Managed/ScriptChild.cs',
    '/src/no-classes.hpp',
  ]);
  assert.strictEqual(second.done, true);

  const pending = [...first.files, ...second.files];
  const sources = store.readSources(pending);
  assert.strictEqual(sources.length, 4);
  assert.strictEqual(
    sources[0].fingerprint,
    computeClassHierarchySourceFingerprint(sources[0].content)
  );
  const applied = store.applyParsedFiles(sources.map(makeParsed));
  assert.deepStrictEqual(applied.appliedFileIds, pending.map((file) => file.fileId));
  assert.deepStrictEqual(applied.skippedFileIds, []);
  assert.deepStrictEqual(store.listPendingFiles().files, [], 'zero-class files need a marker');

  const declarations = store.readCachedDeclarations();
  assert.deepStrictEqual(declarations.map((declaration) => declaration.name), [
    'Base',
    'Derived',
    'ScriptChild',
  ]);
  const cachedDerived = declarations.find((declaration) => declaration.name === 'Derived');
  assert.ok(cachedDerived);
  assert.strictEqual(cachedDerived.isFinal, true);
  assert.deepStrictEqual(cachedDerived.bases, [{
    name: 'Base',
    lookupName: 'Base',
    access: 'public',
    isVirtual: true,
  }]);
  assert.strictEqual(cachedDerived.location.path, '/src/Derived.cpp');
  const cachedManaged = declarations.find((declaration) => declaration.name === 'ScriptChild');
  assert.ok(cachedManaged);
  assert.strictEqual(cachedManaged.qualifiedName, 'Game::Managed::ScriptChild');
  assert.deepStrictEqual(cachedManaged.bases.map((base) => base.lookupName), ['Base']);

  // Initialization is idempotent and does not discard a compatible cache.
  store.initialize();
  assert.strictEqual(store.readCachedDeclarations().length, 3);

  // Keep the indexed signature unchanged to prove fingerprint validation catches
  // a force rewrite that mtime/size alone cannot distinguish.
  const oldBaseSource = sources.find((source) => source.fileId === base.id)!;
  const replacement = 'class Next {};\n';
  assert.strictEqual(Buffer.byteLength(replacement), base.size);
  db.prepare('UPDATE files SET content = ? WHERE id = ?').run(replacement, base.id);
  assert.deepStrictEqual(
    store.readCachedDeclarations().map((declaration) => declaration.name),
    ['Derived', 'ScriptChild'],
    'content-update trigger must hide stale declarations before reparsing'
  );
  assert.deepStrictEqual(store.applyParsedFiles([makeParsed(oldBaseSource)]), {
    appliedFileIds: [],
    skippedFileIds: [base.id],
  });

  const changedBase = store.readSources([base])[0];
  const changedResult = store.applyParsedFiles([makeParsed(changedBase)]);
  assert.deepStrictEqual(changedResult.appliedFileIds, [base.id]);
  assert.deepStrictEqual(
    store.readCachedDeclarations().map((declaration) => declaration.name),
    ['Next', 'Derived', 'ScriptChild']
  );

  assert.strictEqual(store.deleteFiles([derived.id, derived.id]), 1);
  assert.ok(store.listPendingFiles().files.some((file) => file.fileId === derived.id));
  store.applyParsedFiles([makeParsed(store.readSources([derived])[0])]);
  db.prepare('DELETE FROM files WHERE id = ?').run(derived.id);
  for (const table of [
    'class_hierarchy_files',
    'class_hierarchy_declarations',
    'class_hierarchy_bases',
  ]) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE file_id = ?`)
      .get(derived.id) as { count: number };
    assert.strictEqual(row.count, 0, `${table} should be cleaned by the files delete trigger`);
  }
  db.close();
}

function withTemporaryDatabase(
  callback: (dbPath: string) => void
): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-hierarchy-cache-'));
  const dbPath = path.join(directory, 'index.db');
  try {
    callback(dbPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testReadonlyFeatureDetectionAndFallbackSources(): void {
  withTemporaryDatabase((dbPath) => {
    const writable = openDatabase(dbPath);
    writable.exec(BASE_SCHEMA);
    const sourceFile = insertFile(writable, '/sdk/ReadOnly.h', 'class ReadOnly {};\n', 500);
    const writableStore = new ClassHierarchyCacheStore(writable, {
      readOnly: false,
      parserVersion: 2,
    });
    writableStore.initialize();
    const source = writableStore.readSources([sourceFile])[0];
    writableStore.applyParsedFiles([makeParsed(source)]);
    writable.close();

    const readonly = openDatabase(dbPath, { readonly: true, fileMustExist: true });
    const readonlyStore = new ClassHierarchyCacheStore(readonly, {
      readOnly: true,
      parserVersion: 2,
    });
    assert.deepStrictEqual(readonlyStore.initialize(), {
      available: true,
      writable: false,
      schemaVersion: 1,
      reason: undefined,
    });
    assert.strictEqual(readonlyStore.readCachedDeclarations()[0].name, 'ReadOnly');
    assert.deepStrictEqual(readonlyStore.listPendingFiles().files, []);
    assert.throws(() => readonlyStore.applyParsedFiles([makeParsed(source)]), /not writable/);
    readonly.close();
  });

  withTemporaryDatabase((dbPath) => {
    const writable = openDatabase(dbPath);
    writable.exec(BASE_SCHEMA);
    insertFile(writable, '/old/NoCache.h', 'class NoCache {};\n', 600);
    writable.close();

    const readonly = openDatabase(dbPath, { readonly: true, fileMustExist: true });
    const store = new ClassHierarchyCacheStore(readonly, {
      readOnly: true,
      parserVersion: 1,
    });
    const capabilities = store.initialize();
    assert.strictEqual(capabilities.available, false);
    assert.strictEqual(capabilities.writable, false);
    const pending = store.listPendingFiles();
    assert.deepStrictEqual(pending.files.map((file) => file.path), ['/old/NoCache.h']);
    assert.strictEqual(store.readSources(pending.files)[0].content, 'class NoCache {};\n');
    assert.deepStrictEqual(store.readCachedDeclarations(), []);
    readonly.close();
  });
}

function main(): void {
  testWritableLifecycleAndAtomicValidation();
  testReadonlyFeatureDetectionAndFallbackSources();
  console.log('classHierarchyCacheStore tests passed');
}

main();
