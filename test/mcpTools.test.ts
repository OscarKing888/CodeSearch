import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  INDEX_BUILD_STATE_META_KEY,
  IndexService,
} from '../src/index/IndexService';
import {
  discoverIndexMetas,
  fileUriToWorkspacePath,
  findExistingRegistries,
  loadRegistryIndexes,
  parseMcpCliArgs,
  pathComparisonKey,
  resolveRawWorkspacePath,
  resolveIndexMetas,
} from '../src/mcp/discover';
import {
  CompatibleListRootsResultSchema,
  parseClientWorkspaceRoots,
} from '../src/mcp/clientRoots';
import { installPostInitializeToolRefresh } from '../src/mcp/serverLifecycle';
import {
  applyDirectoryMapping,
  McpIndexSession,
  OpenedIndex,
} from '../src/mcp/session';
import { McpToolHandlers, mergeSearchOptions } from '../src/mcp/tools';

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
    '--workspace-root',
    '.',
    '--workspace-root',
    '..',
    '--all-indexes',
  ]);
  assert.ok(opts.db?.endsWith('idx.db'));
  assert.ok(opts.registry?.endsWith('registry.json'));
  assert.ok(opts.extensionRoot);
  assert.strictEqual(opts.workspaceRoots?.length, 2);
  assert.strictEqual(opts.allIndexes, true);
  assert.throws(
    () => parseMcpCliArgs(['node', 'mcp.js', '--workspace-root']),
    /requires a path/
  );
}

function testDefaultOptionsAndPathCase(): void {
  const defaults = mergeSearchOptions({ phraseSearch: undefined, fuzzy: undefined });
  assert.strictEqual(defaults.phraseSearch, true);
  assert.strictEqual(defaults.fuzzy, false);
  assert.strictEqual(mergeSearchOptions({ phraseSearch: false }).phraseSearch, false);
  assert.strictEqual(
    pathComparisonKey('C:\\Project\\File.ts', 'win32'),
    pathComparisonKey('c:/project/file.ts', 'win32')
  );
  assert.notStrictEqual(
    pathComparisonKey('/Project/File.ts', 'linux'),
    pathComparisonKey('/project/file.ts', 'linux')
  );
  assert.strictEqual(
    resolveRawWorkspacePath('C:\\Work\\Project', 'win32'),
    'C:\\Work\\Project'
  );
  assert.strictEqual(
    resolveRawWorkspacePath('\\\\server\\share\\Project', 'win32'),
    '\\\\server\\share\\Project'
  );
  assert.strictEqual(
    resolveRawWorkspacePath('/Users/alice/Project', 'darwin'),
    '/Users/alice/Project'
  );
  assert.strictEqual(resolveRawWorkspacePath('C:\\Work\\Project', 'darwin'), undefined);
  assert.strictEqual(resolveRawWorkspacePath('relative/project', 'win32'), undefined);
  assert.strictEqual(resolveRawWorkspacePath('relative/project', 'darwin'), undefined);

  const windowsMappings = [{ from: 'C:\\SDK', to: 'D:\\Workspace\\SDK' }];
  assert.strictEqual(
    applyDirectoryMapping(
      'C:\\SDK\\Source\\Widget.h',
      windowsMappings,
      false,
      'win32'
    ),
    'D:\\Workspace\\SDK\\Source\\Widget.h'
  );
  assert.strictEqual(
    applyDirectoryMapping(
      'D:\\Workspace\\SDK\\Source\\Widget.h',
      windowsMappings,
      true,
      'win32'
    ),
    'C:\\SDK\\Source\\Widget.h'
  );

  const macMappings = [
    { from: '/Volumes/SharedSDK', to: '/Users/alice/Workspace/SDK' },
  ];
  assert.strictEqual(
    applyDirectoryMapping(
      '/Volumes/SharedSDK/Source/Widget.h',
      macMappings,
      false,
      'darwin'
    ),
    '/Users/alice/Workspace/SDK/Source/Widget.h'
  );
  assert.strictEqual(
    applyDirectoryMapping(
      '/Users/alice/Workspace/SDK/Source/Widget.h',
      macMappings,
      true,
      'darwin'
    ),
    '/Volumes/SharedSDK/Source/Widget.h'
  );
}

async function testPostInitializeToolRefresh(): Promise<void> {
  const calls: string[] = [];
  const target = {
    oninitialized: () => calls.push('previous'),
    sendToolListChanged: async () => {
      calls.push('tools/list_changed');
    },
  };
  installPostInitializeToolRefresh(target, (message) => calls.push(message));
  target.oninitialized();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(calls, ['previous', 'tools/list_changed']);
}

async function withTempIndex(
  setup: (ctx: {
    tmpDir: string;
    dbPath: string;
    sampleTs: string;
    fooCpp: string;
    fooH: string;
    hierarchyH: string;
  }) => Promise<void>
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-mcp-'));
  const dbPath = path.join(tmpDir, 'index.db');
  const sampleTs = path.join(tmpDir, 'sample.ts');
  const fooCpp = path.join(tmpDir, 'Foo.cpp');
  const fooH = path.join(tmpDir, 'Foo.h');
  const hierarchyH = path.join(tmpDir, 'Hierarchy.h');

  fs.writeFileSync(
    sampleTs,
    'const mcpUniqueSymbol = 1;\nfunction helper() { return mcpUniqueSymbol; }\n'
  );
  fs.writeFileSync(fooCpp, 'int foo() { return 0; }\n');
  fs.writeFileSync(fooH, 'int foo();\n');
  fs.writeFileSync(
    hierarchyH,
    [
      'class Root {};',
      'class Left : public Root {};',
      'class Right : public Root {};',
      'class Leaf : public Left, public Right {};',
      'class ExternalChild : public MissingRoot {};',
      'namespace One { class Duplicate {}; class OneChild : public Duplicate {}; }',
      'namespace Two { class Duplicate {}; }',
    ].join('\n')
  );

  const index = new IndexService(dbPath);
  await index.initialize([tmpDir]);
  await index.startIndexing(true);
  index.dispose();

  try {
    await setup({ tmpDir, dbPath, sampleTs, fooCpp, fooH, hierarchyH });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testHandlersAndBuildState(): Promise<void> {
  await withTempIndex(async ({ dbPath, sampleTs, fooCpp, fooH, hierarchyH }) => {
    const session = await McpIndexSession.create({ db: dbPath });
    const handlers = new McpToolHandlers(session, {
      classHierarchyWorkerScript: false,
      readClassHierarchyDefaultMaxNodes: async () => 2,
    });

    const listed = handlers.listIndexes();
    assert.strictEqual(listed.isError, undefined);
    const listPayload = JSON.parse(listed.content[0].text) as {
      indexes: Array<{
        id: string;
        dbPath: string;
        partialIndex: boolean;
        buildState: string;
      }>;
      warnings: string[];
    };
    assert.strictEqual(listPayload.indexes.length, 1);
    assert.strictEqual(path.resolve(listPayload.indexes[0].dbPath), path.resolve(dbPath));
    assert.strictEqual(listPayload.indexes[0].partialIndex, false);
    assert.strictEqual(listPayload.indexes[0].buildState, 'complete');
    assert.deepStrictEqual(listPayload.warnings, []);
    assert.ok(
      !listed.content[0].text.includes('classHierarchyDefaultMaxNodes'),
      'user settings must not be exposed through MCP results'
    );

    const search = handlers.searchCode({ query: 'mcpUniqueSymbol', maxResults: 10 });
    assert.strictEqual(search.isError, undefined);
    const searchPayload = JSON.parse(search.content[0].text) as {
      hitCount: number;
      hits: Array<{ localPath: string; line: number }>;
    };
    assert.ok(searchPayload.hitCount >= 1);
    assert.strictEqual(searchPayload.hits[0].localPath, sampleTs);
    assert.strictEqual(handlers.searchCode({ query: '   ' }).isError, true);

    const read = handlers.readIndexedFile({ path: sampleTs, startLine: 1, endLine: 1 });
    assert.strictEqual(read.isError, undefined);
    const readPayload = JSON.parse(read.content[0].text) as {
      content: string;
      totalLines: number;
    };
    assert.ok(readPayload.content.includes('mcpUniqueSymbol'));
    assert.ok(readPayload.totalLines >= 2);

    const pair = handlers.findHeaderSource({ path: fooCpp });
    assert.strictEqual(pair.isError, undefined);
    const pairPayload = JSON.parse(pair.content[0].text) as {
      results: Array<{ counterparts: Array<{ path: string }> }>;
    };
    assert.ok(pairPayload.results[0].counterparts.some((counterpart) => counterpart.path === fooH));

    const defaultHierarchy = await handlers.searchClassHierarchy({
      className: 'Root',
    });
    assert.strictEqual(defaultHierarchy.isError, undefined);
    const defaultHierarchyPayload = JSON.parse(
      defaultHierarchy.content[0].text
    ) as {
      totalNodeCount: number;
      returnedNodeCount: number;
      truncated: boolean;
    };
    assert.strictEqual(defaultHierarchyPayload.totalNodeCount, 4);
    assert.strictEqual(defaultHierarchyPayload.returnedNodeCount, 2);
    assert.strictEqual(defaultHierarchyPayload.truncated, true);

    const allHierarchy = await handlers.searchClassHierarchy({
      className: 'Root',
      maxNodes: 'all',
    });
    assert.strictEqual(allHierarchy.isError, undefined);
    const allHierarchyPayload = JSON.parse(allHierarchy.content[0].text) as {
      rootId: string;
      returnedNodeCount: number;
      partialIndex: boolean;
      nodes: Array<{
        id: string;
        name: string;
        baseIds: string[];
        path?: string;
        localPath?: string;
        line?: number;
        endLine?: number;
      }>;
    };
    assert.strictEqual(allHierarchyPayload.returnedNodeCount, 4);
    assert.strictEqual(allHierarchyPayload.partialIndex, false);
    const left = allHierarchyPayload.nodes.find((node) => node.name === 'Left');
    const right = allHierarchyPayload.nodes.find((node) => node.name === 'Right');
    const leaf = allHierarchyPayload.nodes.find((node) => node.name === 'Leaf');
    assert.ok(left);
    assert.ok(right);
    assert.ok(leaf);
    assert.deepStrictEqual(
      new Set(leaf.baseIds),
      new Set([left.id, right.id])
    );
    assert.strictEqual(leaf.path, hierarchyH);
    assert.strictEqual(leaf.localPath, hierarchyH);
    assert.ok((leaf.line ?? 0) <= (leaf.endLine ?? 0));

    const ambiguous = await handlers.searchClassHierarchy({
      className: 'Duplicate',
      maxNodes: 'all',
    });
    assert.strictEqual(ambiguous.isError, true);
    const ambiguousPayload = JSON.parse(ambiguous.content[0].text) as {
      error: string;
      candidates: Array<{ qualifiedName: string; localPath?: string }>;
    };
    assert.strictEqual(ambiguousPayload.error, 'ambiguous_class');
    assert.deepStrictEqual(
      ambiguousPayload.candidates.map((candidate) => candidate.qualifiedName),
      ['One::Duplicate', 'Two::Duplicate']
    );
    assert.ok(
      ambiguousPayload.candidates.every(
        (candidate) => candidate.localPath === hierarchyH
      )
    );

    const qualified = await handlers.searchClassHierarchy({
      className: 'One::Duplicate',
      maxNodes: 'all',
    });
    assert.strictEqual(qualified.isError, undefined);
    const qualifiedPayload = JSON.parse(qualified.content[0].text) as {
      nodes: Array<{ qualifiedName: string }>;
    };
    assert.ok(
      qualifiedPayload.nodes.some(
        (node) => node.qualifiedName === 'One::OneChild'
      )
    );

    const external = await handlers.searchClassHierarchy({
      className: 'MissingRoot',
      maxNodes: 'all',
    });
    assert.strictEqual(external.isError, undefined);
    const externalPayload = JSON.parse(external.content[0].text) as {
      nodes: Array<{ name: string; external: boolean; path?: string }>;
    };
    assert.strictEqual(externalPayload.nodes[0].external, true);
    assert.strictEqual(externalPayload.nodes[0].path, undefined);
    assert.ok(externalPayload.nodes.some((node) => node.name === 'ExternalChild'));

    const notFound = await handlers.searchClassHierarchy({
      className: 'NoSuchClass',
    });
    assert.strictEqual(notFound.isError, true);
    assert.strictEqual(
      (JSON.parse(notFound.content[0].text) as { error: string }).error,
      'not_found'
    );
    assert.strictEqual(
      (await handlers.searchClassHierarchy({
        className: 'Root',
        maxNodes: 5001,
      })).isError,
      true
    );

    // A read-only session observes durable state changes without reopening.
    const stateWriter = new IndexService(dbPath);
    await stateWriter.initialize([path.dirname(dbPath)]);
    const stateDb = stateWriter.getDatabase();
    assert.ok(stateDb);
    const hierarchyTables = stateDb!
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'class_hierarchy_%'`
      )
      .all() as Array<{ name: string }>;
    assert.deepStrictEqual(
      hierarchyTables,
      [],
      'read-only MCP hierarchy fallback must not create cache tables'
    );
    stateDb!
      .prepare('UPDATE meta SET value = ? WHERE key = ?')
      .run('building', INDEX_BUILD_STATE_META_KEY);
    assert.strictEqual(session.listIndexes()[0].partialIndex, true);
    assert.strictEqual(session.listIndexes()[0].buildState, 'building');
    stateDb!
      .prepare('UPDATE meta SET value = ? WHERE key = ?')
      .run('complete', INDEX_BUILD_STATE_META_KEY);
    assert.strictEqual(session.listIndexes()[0].partialIndex, false);
    stateDb!.prepare('DELETE FROM meta WHERE key = ?').run(INDEX_BUILD_STATE_META_KEY);
    assert.strictEqual(session.listIndexes()[0].partialIndex, true);
    assert.strictEqual(session.listIndexes()[0].buildState, 'unknown');
    stateDb!
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run(INDEX_BUILD_STATE_META_KEY, 'complete');
    stateWriter.dispose();

    // Read-only opening is repeatable and never rewrites the database.
    const again = await McpIndexSession.create({ db: dbPath });
    assert.strictEqual(again.listIndexes().length, 1);
    again.dispose();
    await handlers.dispose();
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
    const metas = await resolveIndexMetas({ registry: registryPath, allIndexes: true });
    assert.strictEqual(metas.length, 1);
    assert.strictEqual(metas[0].id, 'idx_test');
    const loaded = await loadRegistryIndexes(registryPath);
    assert.strictEqual(loaded[0].directoryMappings[0].to, '/mapped/root');

    const session = await McpIndexSession.create({ registry: registryPath, allIndexes: true });
    const search = new McpToolHandlers(session).searchCode({ query: 'ext:db', maxResults: 5 });
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

async function testPathMappingOnSearchAndRead(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-mcp-map-'));
  const dbPath = path.join(tmpDir, 'index.db');
  const sample = path.join(tmpDir, 'mapped.ts');
  const mappedClass = path.join(tmpDir, 'MappedClass.h');
  fs.writeFileSync(sample, 'const mappedTokenXYZ = 99;\n');
  fs.writeFileSync(mappedClass, 'class MappedClass {};\n');

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
    const session = await McpIndexSession.create({
      registry: registryPath,
      workspaceRoots: [tmpDir],
    });
    const handlers = new McpToolHandlers(session, {
      classHierarchyWorkerScript: false,
    });
    const search = handlers.searchCode({ query: 'mappedTokenXYZ' });
    assert.strictEqual(search.isError, undefined);
    const payload = JSON.parse(search.content[0].text) as {
      hits: Array<{ path: string; localPath: string }>;
    };
    assert.ok(payload.hits.length >= 1);
    assert.strictEqual(payload.hits[0].path, sample);
    assert.ok(payload.hits[0].localPath.includes(`${path.sep}virtual${path.sep}`));

    const read = handlers.readIndexedFile({ path: payload.hits[0].localPath });
    assert.strictEqual(read.isError, undefined);
    const readPayload = JSON.parse(read.content[0].text) as {
      path: string;
      localPath: string;
    };
    assert.strictEqual(readPayload.path, sample);
    assert.strictEqual(readPayload.localPath, payload.hits[0].localPath);
    const hierarchy = await handlers.searchClassHierarchy({
      className: 'MappedClass',
      maxNodes: 'all',
    });
    assert.strictEqual(hierarchy.isError, undefined);
    const hierarchyPayload = JSON.parse(hierarchy.content[0].text) as {
      nodes: Array<{ path?: string; localPath?: string }>;
    };
    assert.strictEqual(hierarchyPayload.nodes[0].path, mappedClass);
    assert.ok(
      hierarchyPayload.nodes[0].localPath?.includes(
        `${path.sep}virtual${path.sep}MappedClass.h`
      )
    );
    await handlers.dispose();
    session.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function createIndexAt(dbPath: string, rootDir: string, symbol: string): Promise<void> {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, `${symbol}.ts`), `const ${symbol} = true;\n`);
  const index = new IndexService(dbPath);
  await index.initialize([rootDir]);
  await index.startIndexing(true);
  index.dispose();
}

function registryMeta(id: string, dbPath: string, rootDirs: string[]) {
  return {
    id,
    name: id,
    dbPath,
    rootDirs,
    readOnly: true,
    directoryMappings: [],
    workspaceHashes: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

async function testSafeAutomaticDiscovery(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-mcp-scope-'));
  const workspaceA = path.join(tmpDir, 'workspace-a');
  const workspaceB = path.join(tmpDir, 'workspace-b');
  const dbA = path.join(tmpDir, 'a.db');
  const dbB = path.join(tmpDir, 'b.db');
  const missingDb = path.join(tmpDir, 'missing.db');
  const goodRegistry = path.join(tmpDir, 'good-registry.json');
  const badRegistry = path.join(tmpDir, 'bad-registry.json');

  try {
    await createIndexAt(dbA, workspaceA, 'scopeSymbolA');
    await createIndexAt(dbB, workspaceB, 'scopeSymbolB');
    fs.writeFileSync(
      goodRegistry,
      JSON.stringify({
        indexes: [
          registryMeta('a', dbA, [workspaceA]),
          registryMeta('missing', missingDb, [workspaceA]),
          registryMeta('b', dbB, [workspaceB]),
          registryMeta('multi-root', path.join(tmpDir, 'multi.db'), [workspaceA, workspaceB]),
          registryMeta('parent-root', path.join(tmpDir, 'parent.db'), [tmpDir]),
        ],
      })
    );
    fs.writeFileSync(badRegistry, '{ definitely not json');

    const candidates = [
      { path: badRegistry, source: 'broken' },
      { path: goodRegistry, source: 'good' },
    ];
    const discovered = await discoverIndexMetas({
      workspaceRoots: [workspaceA],
      registryCandidates: candidates,
    });
    assert.deepStrictEqual(
      discovered.metas.map((meta) => meta.id).sort(),
      ['a', 'missing']
    );
    assert.ok(discovered.warnings.some((warning) => warning.includes('unreadable broken')));
    assert.ok(discovered.warnings.some((warning) => warning.includes('outside the workspace')));

    const session = await McpIndexSession.create({
      workspaceRoots: [workspaceA],
      registryCandidates: candidates,
    });
    assert.deepStrictEqual(session.listIndexes().map((item) => item.id), ['a']);
    assert.ok(session.listWarnings().some((warning) => warning.includes('missing')));

    const otherSession = await McpIndexSession.create({
      workspaceRoots: [workspaceB],
      registryCandidates: candidates,
    });
    assert.deepStrictEqual(otherSession.listIndexes().map((item) => item.id), ['b']);

    const sessionHandlers = new McpToolHandlers(session);
    const otherHandlers = new McpToolHandlers(otherSession);
    const sessionSearch = JSON.parse(
      sessionHandlers.searchCode({ query: 'scopeSymbolA' }).content[0].text
    ) as { hitCount: number; hits: Array<{ localPath: string }> };
    const otherSearch = JSON.parse(
      otherHandlers.searchCode({ query: 'scopeSymbolB' }).content[0].text
    ) as { hitCount: number; hits: Array<{ localPath: string }> };
    const crossWorkspaceSearch = JSON.parse(
      sessionHandlers.searchCode({ query: 'scopeSymbolB' }).content[0].text
    ) as { hitCount: number };
    assert.ok(sessionSearch.hitCount > 0);
    assert.ok(sessionSearch.hits.every((hit) => hit.localPath.startsWith(workspaceA)));
    assert.ok(otherSearch.hitCount > 0);
    assert.ok(otherSearch.hits.every((hit) => hit.localPath.startsWith(workspaceB)));
    assert.strictEqual(crossWorkspaceSearch.hitCount, 0);

    await session.setWorkspaceRoots([]);
    assert.deepStrictEqual(session.getWorkspaceRoots(), []);
    assert.deepStrictEqual(session.listIndexes(), []);
    assert.strictEqual(sessionHandlers.searchCode({ query: 'scopeSymbolA' }).isError, true);
    assert.deepStrictEqual(otherSession.getWorkspaceRoots(), [path.resolve(workspaceB)]);
    assert.deepStrictEqual(otherSession.listIndexes().map((item) => item.id), ['b']);
    assert.strictEqual(otherHandlers.searchCode({ query: 'scopeSymbolB' }).isError, undefined);

    await session.setWorkspaceRoots([workspaceB]);
    assert.deepStrictEqual(session.listIndexes().map((item) => item.id), ['b']);
    otherSession.dispose();
    session.dispose();

    const authoritativeEmpty = await discoverIndexMetas({
      workspaceRoots: [],
      registryCandidates: candidates,
    });
    assert.deepStrictEqual(authoritativeEmpty.workspaceRoots, []);
    assert.deepStrictEqual(authoritativeEmpty.metas, []);

    const all = await McpIndexSession.create({
      allIndexes: true,
      registryCandidates: candidates,
    });
    assert.ok(all.listIndexes().some((item) => item.id === 'b'));
    const choose = new McpToolHandlers(all).searchCode({ query: 'scopeSymbolA' });
    assert.strictEqual(choose.isError, true);
    assert.match(choose.content[0].text, /Choose one with indexId/);
    all.dispose();

    const empty = await McpIndexSession.create({
      workspaceRoots: [workspaceA],
      registryCandidates: [],
    });
    assert.strictEqual(empty.listIndexes().length, 0);
    assert.ok(empty.listWarnings().some((warning) => warning.includes('No Ace Code Search')));
    assert.strictEqual(new McpToolHandlers(empty).searchCode({ query: 'anything' }).isError, true);
    empty.dispose();

    await assert.rejects(
      McpIndexSession.create({ registry: badRegistry, workspaceRoots: [workspaceA] })
    );
    await assert.rejects(
      McpIndexSession.create({ registry: goodRegistry, workspaceRoots: [workspaceA] }),
      /missing\.db|ENOENT/
    );

    assert.strictEqual(
      fileUriToWorkspacePath(pathToFileURL(workspaceA).href),
      path.resolve(workspaceA)
    );
    assert.strictEqual(fileUriToWorkspacePath(workspaceA), path.resolve(workspaceA));
    assert.strictEqual(fileUriToWorkspacePath('https://example.com/project'), undefined);
    assert.strictEqual(fileUriToWorkspacePath('relative/project'), undefined);

    const compatibleRoots = CompatibleListRootsResultSchema.parse({
      roots: [
        { uri: pathToFileURL(workspaceA).href },
        { uri: workspaceA, name: 'duplicate raw path' },
        { uri: 'https://example.com/not-a-workspace' },
      ],
    });
    const parsedRoots = parseClientWorkspaceRoots(compatibleRoots.roots);
    assert.deepStrictEqual(parsedRoots.workspaceRoots, [path.resolve(workspaceA)]);
    assert.strictEqual(parsedRoots.rejectedCount, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testMultiIndexQuotaDoesNotUnderfill(): void {
  const hit = (filePath: string, line: number) => ({
    path: filePath,
    line,
    column: 1,
    lineText: 'quotaSymbol',
    contextBefore: [],
    contextAfter: [],
    matchStart: 0,
    matchEnd: 11,
  });
  const limits: number[] = [];
  const opened = (id: string, hits: ReturnType<typeof hit>[]) =>
    ({
      meta: registryMeta(id, `${id}.db`, [process.cwd()]),
      searcher: {
        search: (_query: string, options: { maxResults: number }) => {
          limits.push(options.maxResults);
          const limited = hits.slice(0, options.maxResults);
          return {
            hits: limited,
            hitCount: limited.length,
            fileCount: limited.length,
            elapsedMs: 0,
            query: 'quotaSymbol',
            partialIndex: false,
          };
        },
      },
    }) as unknown as OpenedIndex;
  const targets = [
    opened('first', [hit('/first.ts', 1)]),
    opened('second', [
      hit('/second.ts', 1),
      hit('/second.ts', 2),
      hit('/second.ts', 3),
      hit('/second.ts', 4),
    ]),
  ];
  const fakeSession = {
    resolveIndexes: () => targets,
    mapPath: (_opened: OpenedIndex, filePath: string) => filePath,
  } as unknown as McpIndexSession;
  const result = new McpToolHandlers(fakeSession).searchCode({
    query: 'quotaSymbol',
    indexId: 'test-multi',
    maxResults: 4,
  });
  const payload = JSON.parse(result.content[0].text) as { hitCount: number };
  assert.strictEqual(payload.hitCount, 4);
  assert.deepStrictEqual(limits, [4, 4]);
}

async function main(): Promise<void> {
  testParseCliArgs();
  testDefaultOptionsAndPathCase();
  await testPostInitializeToolRefresh();
  await testHandlersAndBuildState();
  await testRegistryDiscovery();
  await testPathMappingOnSearchAndRead();
  await testSafeAutomaticDiscovery();
  testMultiIndexQuotaDoesNotUnderfill();
  console.log('mcpTools tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
