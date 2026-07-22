import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  aggregateMcpStatus,
  MCP_STATUS_SCHEMA_VERSION,
  McpRuntimeRecordV1,
  McpStatusMonitor,
  McpStatusReporter,
  parseMcpRuntimeRecord,
  resolveMcpStatusDir,
  summarizeMcpRequest,
  workspaceRootsOverlap,
} from '../src/mcpStatus';

function makeRecord(
  workspaceRoot: string,
  updatedAt: number,
  overrides: Partial<McpRuntimeRecordV1> = {}
): McpRuntimeRecordV1 {
  return {
    schemaVersion: MCP_STATUS_SCHEMA_VERSION,
    sessionId: 'session',
    pid: 123,
    extensionVersion: '1.0.0',
    workspaceRoots: [workspaceRoot],
    startedAt: updatedAt - 1000,
    updatedAt,
    activeRequests: [],
    ...overrides,
  };
}

function testSummaries(): void {
  assert.strictEqual(summarizeMcpRequest('list_indexes', {}), '正在获取索引');
  const search = summarizeMcpRequest('search_code', {
    query: '  hello\nworld\u0000  ',
    indexId: 'secret-index',
  });
  assert.strictEqual(search, '正在搜索 “hello world”');
  assert.ok(!search.includes('secret-index'));

  const read = summarizeMcpRequest('read_indexed_file', {
    path: 'C:\\secret\\project\\SourceFile.ts',
    startLine: 12,
    endLine: 20,
  });
  assert.strictEqual(read, '正在读取 SourceFile.ts:12–20');
  assert.ok(!read.includes('secret'));
  assert.strictEqual(
    summarizeMcpRequest('find_header_source', { path: '/private/tree/Widget.cpp' }),
    '正在查找配对文件 Widget.cpp'
  );
  assert.ok(summarizeMcpRequest('search_code', { query: 'x'.repeat(200) }).length < 90);
}

function testParsingAndAggregation(): void {
  const now = 10_000;
  const root = path.resolve('workspace');
  const other = path.resolve('other-workspace');
  assert.strictEqual(parseMcpRuntimeRecord({}), undefined);
  assert.strictEqual(workspaceRootsOverlap([root], [path.join(root, 'child')]), true);
  assert.strictEqual(workspaceRootsOverlap([root], [other]), false);
  assert.deepStrictEqual(aggregateMcpStatus([], [root], now), { state: 'waiting' });

  const ready = makeRecord(root, now);
  assert.deepStrictEqual(aggregateMcpStatus([ready], [root], now), { state: 'ready' });
  assert.deepStrictEqual(aggregateMcpStatus([ready], [other], now), { state: 'waiting' });
  assert.deepStrictEqual(
    aggregateMcpStatus([makeRecord(root, now - 7000)], [root], now),
    { state: 'waiting' }
  );

  const active = makeRecord(root, now, {
    activeRequests: [
      { id: 'old', tool: 'list_indexes', summary: '正在获取索引', startedAt: now - 100 },
      { id: 'new', tool: 'search_code', summary: '正在搜索 “needle”', startedAt: now },
    ],
  });
  assert.deepStrictEqual(aggregateMcpStatus([active], [root], now), {
    state: 'busy',
    summary: '正在搜索 “needle”（另有 1 个请求）',
    activeCount: 2,
  });

  const recent = makeRecord(root, now, {
    recentRequest: {
      id: 'recent',
      tool: 'find_header_source',
      summary: '正在查找配对文件 Widget.cpp',
      startedAt: now - 50,
      completedAt: now - 10,
    },
  });
  assert.deepStrictEqual(aggregateMcpStatus([recent], [root], now), {
    state: 'busy',
    summary: '正在查找配对文件 Widget.cpp',
    activeCount: 0,
  });
  assert.deepStrictEqual(aggregateMcpStatus([recent], [root], now + 2100), {
    state: 'ready',
  });
}

async function testReporterLifecycle(): Promise<void> {
  const homeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'code-search-mcp-status-'));
  let now = 1000;
  const root = path.join(homeDir, 'workspace');
  const reporter = new McpStatusReporter({
    extensionVersion: '1.2.3',
    workspaceRoots: [root],
    homeDir,
    heartbeatMs: 0,
    busyMinMs: 2000,
    now: () => now,
    pid: 42,
    sessionId: 'test-session',
  });
  try {
    await reporter.start();
    const statusDir = resolveMcpStatusDir(homeDir);
    const [fileName] = await fs.promises.readdir(statusDir);
    const filePath = path.join(statusDir, fileName);
    let record = parseMcpRuntimeRecord(JSON.parse(await fs.promises.readFile(filePath, 'utf8')));
    assert.ok(record);
    assert.deepStrictEqual(record.workspaceRoots, [path.resolve(root)]);

    const requestId = reporter.beginRequest('search_code', { query: 'needle' });
    await reporter.flush();
    record = parseMcpRuntimeRecord(JSON.parse(await fs.promises.readFile(filePath, 'utf8')));
    assert.strictEqual(record?.activeRequests.length, 1);
    assert.strictEqual(record?.activeRequests[0].summary, '正在搜索 “needle”');

    now += 25;
    reporter.finishRequest(requestId);
    await reporter.flush();
    record = parseMcpRuntimeRecord(JSON.parse(await fs.promises.readFile(filePath, 'utf8')));
    assert.strictEqual(record?.activeRequests.length, 0);
    assert.strictEqual(record?.recentRequest?.completedAt, now);

    reporter.updateWorkspaceRoots([path.join(root, 'nested')]);
    await reporter.flush();
    record = parseMcpRuntimeRecord(JSON.parse(await fs.promises.readFile(filePath, 'utf8')));
    assert.deepStrictEqual(record?.workspaceRoots, [path.resolve(root, 'nested')]);

    await reporter.dispose();
    assert.strictEqual(fs.existsSync(filePath), false);
  } finally {
    await reporter.dispose();
    await fs.promises.rm(homeDir, { recursive: true, force: true });
  }
}

async function testReporterSessionIsolation(): Promise<void> {
  const homeDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-mcp-status-isolation-')
  );
  const rootA = path.join(homeDir, 'workspace-a');
  const rootB = path.join(homeDir, 'workspace-b');
  const reporterA = new McpStatusReporter({
    extensionVersion: '1.2.3',
    workspaceRoots: [rootA],
    homeDir,
    heartbeatMs: 0,
    pid: 42,
    sessionId: 'ide-a',
  });
  const reporterB = new McpStatusReporter({
    extensionVersion: '1.2.3',
    workspaceRoots: [rootB],
    homeDir,
    heartbeatMs: 0,
    pid: 42,
    sessionId: 'ide-b',
  });
  try {
    await Promise.all([reporterA.start(), reporterB.start()]);
    const requestA = reporterA.beginRequest('search_code', { query: 'only-a' });
    await reporterA.flush();

    const statusDir = resolveMcpStatusDir(homeDir);
    const files = await fs.promises.readdir(statusDir);
    assert.strictEqual(files.length, 2);
    const records = (
      await Promise.all(
        files.map(async (file) =>
          parseMcpRuntimeRecord(
            JSON.parse(await fs.promises.readFile(path.join(statusDir, file), 'utf8'))
          )
        )
      )
    ).filter((record): record is McpRuntimeRecordV1 => Boolean(record));
    const recordA = records.find((record) => record.sessionId === 'ide-a');
    const recordB = records.find((record) => record.sessionId === 'ide-b');
    assert.strictEqual(recordA?.activeRequests.length, 1);
    assert.strictEqual(recordA?.activeRequests[0].summary.includes('only-a'), true);
    assert.strictEqual(recordB?.activeRequests.length, 0);
    assert.deepStrictEqual(recordB?.workspaceRoots, [path.resolve(rootB)]);

    reporterA.finishRequest(requestA);
    await reporterA.dispose();
    assert.strictEqual((await fs.promises.readdir(statusDir)).length, 1);
  } finally {
    await reporterA.dispose();
    await reporterB.dispose();
    await fs.promises.rm(homeDir, { recursive: true, force: true });
  }
}

async function testMonitorFiles(): Promise<void> {
  const homeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'code-search-mcp-monitor-'));
  let now = Date.now();
  const root = path.join(homeDir, 'workspace');
  const statusDir = resolveMcpStatusDir(homeDir);
  const validPath = path.join(statusDir, 'mcp-session-1-valid.json');
  const invalidPath = path.join(statusDir, 'mcp-session-2-invalid.json');
  const stalePath = path.join(statusDir, 'mcp-session-3-stale.json');
  await fs.promises.mkdir(statusDir, { recursive: true });
  await fs.promises.writeFile(validPath, JSON.stringify(makeRecord(root, now)));
  await fs.promises.writeFile(invalidPath, '{broken');
  await fs.promises.writeFile(stalePath, JSON.stringify(makeRecord(root, now - 70_000)));
  await fs.promises.utimes(stalePath, new Date(now - 70_000), new Date(now - 70_000));

  const monitor = new McpStatusMonitor({
    homeDir,
    workspaceRoots: [root],
    pollMs: 0,
    now: () => now,
  });
  try {
    await monitor.refresh();
    assert.deepStrictEqual(monitor.getStatus(), { state: 'ready' });
    assert.strictEqual(fs.existsSync(stalePath), false);

    const busy = makeRecord(root, now, {
      activeRequests: [
        {
          id: 'busy',
          tool: 'read_indexed_file',
          summary: '正在读取 Main.ts:1–2',
          startedAt: now,
        },
      ],
    });
    await fs.promises.writeFile(validPath, JSON.stringify(busy));
    await monitor.refresh();
    assert.deepStrictEqual(monitor.getStatus(), {
      state: 'busy',
      summary: '正在读取 Main.ts:1–2',
      activeCount: 1,
    });

    monitor.setWorkspaceRoots([path.join(homeDir, 'other')]);
    await monitor.refresh();
    assert.deepStrictEqual(monitor.getStatus(), { state: 'waiting' });
  } finally {
    await monitor.dispose();
    await fs.promises.rm(homeDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  testSummaries();
  testParsingAndAggregation();
  await testReporterLifecycle();
  await testReporterSessionIsolation();
  await testMonitorFiles();
  console.log('MCP status tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
