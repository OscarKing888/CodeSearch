import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildCodexMcpServerBlock,
  installMcpClientConfig,
  MCP_SERVER_NAME,
  upsertCodexMcpBlock,
  upsertCursorMcpJson,
} from '../src/mcpConfigInstaller';

const ROOT = path.join(__dirname, '..');

async function testUpsertCodexBlock(): Promise<void> {
  const mcpJs = '/tmp/ext/dist/mcp.js';
  const extRoot = '/tmp/ext';
  const first = upsertCodexMcpBlock('', mcpJs, extRoot);
  assert.strictEqual(first.changed, true);
  assert.ok(first.content.includes('[mcp_servers.ace-code-search]'));
  assert.ok(first.content.includes(JSON.stringify(mcpJs)));
  assert.ok(first.content.includes('--extension-root'));
  assert.ok(first.content.includes(JSON.stringify(extRoot)));

  const second = upsertCodexMcpBlock(first.content, mcpJs, extRoot);
  assert.strictEqual(second.changed, false);

  const upgraded = upsertCodexMcpBlock(
    first.content,
    '/tmp/ext2/dist/mcp.js',
    '/tmp/ext2'
  );
  assert.strictEqual(upgraded.changed, true);
  assert.ok(upgraded.content.includes('/tmp/ext2/dist/mcp.js'));
  assert.ok(!upgraded.content.includes('/tmp/ext/dist/mcp.js'));
  assert.strictEqual(
    (upgraded.content.match(/BEGIN ACE-CODE-SEARCH-MCP/g) || []).length,
    1
  );
}

async function testUpsertCursorJson(): Promise<void> {
  const mcpJs = '/tmp/ext/dist/mcp.js';
  const extRoot = '/tmp/ext';
  const first = upsertCursorMcpJson(undefined, mcpJs, extRoot);
  assert.strictEqual(first.changed, true);
  const parsed = JSON.parse(first.content) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.strictEqual(parsed.mcpServers[MCP_SERVER_NAME].command, 'node');
  assert.deepStrictEqual(parsed.mcpServers[MCP_SERVER_NAME].args, [
    mcpJs,
    '--extension-root',
    extRoot,
  ]);

  const second = upsertCursorMcpJson(first.content, mcpJs, extRoot);
  assert.strictEqual(second.changed, false);

  const bad = upsertCursorMcpJson('{not-json', mcpJs, extRoot);
  assert.strictEqual(bad.changed, false);
  assert.ok(bad.warning?.includes('not valid JSON'));
}

async function testInstallWritesFiles(): Promise<void> {
  const homeDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-mcp-cfg-')
  );
  const workspaceRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-mcp-ws-')
  );
  try {
    const result = await installMcpClientConfig({
      extensionRoot: ROOT,
      homeDir,
      workspaceRoot,
    });
    assert.strictEqual(result.changed, true);
    assert.ok(result.mcpJsPath.endsWith(`${path.sep}dist${path.sep}mcp.js`));

    const userCodex = await fs.promises.readFile(
      path.join(homeDir, '.codex', 'config.toml'),
      'utf8'
    );
    assert.ok(userCodex.includes(buildCodexMcpServerBlock(result.mcpJsPath, ROOT).trim()));

    const projectCodex = await fs.promises.readFile(
      path.join(workspaceRoot, '.codex', 'config.toml'),
      'utf8'
    );
    assert.ok(projectCodex.includes('[mcp_servers.ace-code-search]'));

    const cursor = JSON.parse(
      await fs.promises.readFile(path.join(homeDir, '.cursor', 'mcp.json'), 'utf8')
    ) as { mcpServers: Record<string, unknown> };
    assert.ok(cursor.mcpServers[MCP_SERVER_NAME]);

    const again = await installMcpClientConfig({
      extensionRoot: ROOT,
      homeDir,
      workspaceRoot,
    });
    assert.strictEqual(again.changed, false);
  } finally {
    await fs.promises.rm(homeDir, { recursive: true, force: true });
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testUpsertCodexBlock();
  await testUpsertCursorJson();
  await testInstallWritesFiles();
  console.log('mcpConfigInstaller tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
