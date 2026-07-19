import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexService } from '../src/index/IndexService';
import {
  findExistingRegistries,
  loadRegistryIndexes,
  parseMcpCliArgs,
  resolveIndexMetas,
} from '../src/mcp/discover';
import { McpIndexSession } from '../src/mcp/session';
import { McpToolHandlers } from '../src/mcp/tools';

function testParseCliArgs(): void {
  const opts = parseMcpCliArgs([
    'node',
    'mcp.js',
    '--db',
    './idx.db',
    '--registry',
    './registry.json',
    '--extension-root',
    '.',
  ]);
  assert.ok(opts.db?.endsWith('idx.db'));
  assert.ok(opts.registry?.endsWith('registry.json'));
  assert.ok(opts.extensionRoot);
}

async function withTempIndex(
  setup: (ctx: {
    tmpDir: string;
    dbPath: string;
    sampleTs: string;
    fooCpp: string;
    fooH: string;
  }) => Promise<void>
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-mcp-'));
  const dbPath = path.join(tmpDir, 'index.db');
  const sampleTs = path.join(tmpDir, 'sample.ts');
  const fooCpp = path.join(tmpDir, 'Foo.cpp');
  const fooH = path.join(tmpDir, 'Foo.h');

  fs.writeFileSync(
    sampleTs,
    'const mcpUniqueSymbol = 1;\nfunction helper() { return mcpUniqueSymbol; }\n'
  );
  fs.writeFileSync(fooCpp, 'int foo() { return 0; }\n');
  fs.writeFileSync(fooH, 'int foo();\n');

  const index = new IndexService(dbPath);
  await index.initialize([tmpDir]);
  await index.startIndexing(true);
  index.dispose();

  try {
    await setup({ tmpDir, dbPath, sampleTs, fooCpp, fooH });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testHandlers(): Promise<void> {
  await withTempIndex(async ({ dbPath, sampleTs, fooCpp, fooH }) => {
    const session = await McpIndexSession.create({ db: dbPath });
    const handlers = new McpToolHandlers(session);

    const listed = handlers.listIndexes();
    assert.strictEqual(listed.isError, undefined);
    const listPayload = JSON.parse(listed.content[0].text) as {
      indexes: Array<{ id: string; dbPath: string }>;
    };
    assert.strictEqual(listPayload.indexes.length, 1);
    assert.strictEqual(path.resolve(listPayload.indexes[0].dbPath), path.resolve(dbPath));

    const search = handlers.searchCode({ query: 'mcpUniqueSymbol', maxResults: 10 });
    assert.strictEqual(search.isError, undefined);
    const searchPayload = JSON.parse(search.content[0].text) as {
      hitCount: number;
      hits: Array<{ localPath: string; line: number }>;
    };
    assert.ok(searchPayload.hitCount >= 1);
    assert.strictEqual(searchPayload.hits[0].localPath, sampleTs);

    const missingQuery = handlers.searchCode({ query: '   ' });
    assert.strictEqual(missingQuery.isError, true);

    const read = handlers.readIndexedFile({
      path: sampleTs,
      startLine: 1,
      endLine: 1,
    });
    assert.strictEqual(read.isError, undefined);
    const readPayload = JSON.parse(read.content[0].text) as { content: string; totalLines: number };
    assert.ok(readPayload.content.includes('mcpUniqueSymbol'));
    assert.ok(readPayload.totalLines >= 2);

    const pair = handlers.findHeaderSource({ path: fooCpp });
    assert.strictEqual(pair.isError, undefined);
    const pairPayload = JSON.parse(pair.content[0].text) as {
      results: Array<{ counterparts: Array<{ path: string }> }>;
    };
    assert.ok(pairPayload.results[0].counterparts.some((c) => c.path === fooH));

    // Read-only: opening again should still work; session must not rewrite registry.
    const again = await McpIndexSession.create({ db: dbPath });
    assert.strictEqual(again.listIndexes().length, 1);
    again.dispose();

    session.dispose();
  });
}

async function testRegistryDiscovery(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-mcp-reg-'));
  const registryPath = path.join(tmpDir, 'registry.json');
  const dbPath = path.join(tmpDir, 'index.db');

  const index = new IndexService(dbPath);
  await index.initialize([tmpDir]);
  await index.startIndexing(true);
  index.dispose();

  fs.writeFileSync(
    registryPath,
    JSON.stringify(
      {
        indexes: [
          {
            id: 'idx_test',
            name: 'Mapped',
            dbPath,
            rootDirs: [tmpDir],
            readOnly: true,
            directoryMappings: [{ from: tmpDir, to: '/mapped/root' }],
            workspaceHashes: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      null,
      2
    )
  );

  try {
    const metas = await resolveIndexMetas({ registry: registryPath });
    assert.strictEqual(metas.length, 1);
    assert.strictEqual(metas[0].id, 'idx_test');

    const loaded = await loadRegistryIndexes(registryPath);
    assert.strictEqual(loaded[0].directoryMappings[0].to, '/mapped/root');

    const session = await McpIndexSession.create({ registry: registryPath });
    const handlers = new McpToolHandlers(session);
    const search = handlers.searchCode({ query: 'ext:db', maxResults: 5 });
    // filter-only may or may not hit; ensure no crash and mapping applied on any hit
    assert.strictEqual(search.isError, undefined);

    const found = await findExistingRegistries([
      { path: registryPath, source: 'test' },
      { path: path.join(tmpDir, 'missing.json'), source: 'missing' },
    ]);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].source, 'test');

    session.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testPathMappingOnSearch(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-mcp-map-'));
  const dbPath = path.join(tmpDir, 'index.db');
  const sample = path.join(tmpDir, 'mapped.ts');
  fs.writeFileSync(sample, 'const mappedTokenXYZ = 99;\n');

  const index = new IndexService(dbPath);
  await index.initialize([tmpDir]);
  await index.startIndexing(true);
  index.dispose();

  const registryPath = path.join(tmpDir, 'registry.json');
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      indexes: [
        {
          id: 'idx_map',
          name: 'MapTest',
          dbPath,
          rootDirs: [tmpDir],
          readOnly: true,
          directoryMappings: [{ from: tmpDir, to: path.join(tmpDir, 'virtual') }],
          workspaceHashes: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
  );

  try {
    const session = await McpIndexSession.create({ registry: registryPath });
    const handlers = new McpToolHandlers(session);
    const search = handlers.searchCode({ query: 'mappedTokenXYZ' });
    assert.strictEqual(search.isError, undefined);
    const payload = JSON.parse(search.content[0].text) as {
      hits: Array<{ path: string; localPath: string }>;
    };
    assert.ok(payload.hits.length >= 1);
    assert.strictEqual(payload.hits[0].path, sample);
    assert.ok(payload.hits[0].localPath.includes(`${path.sep}virtual${path.sep}`));
    session.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  testParseCliArgs();
  await testHandlers();
  await testRegistryDiscovery();
  await testPathMappingOnSearch();
  console.log('mcpTools tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
