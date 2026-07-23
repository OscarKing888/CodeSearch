import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_MCP_CLASS_HIERARCHY_MAX_NODES,
  normalizeMcpClassHierarchyDefaultMaxNodes,
  readMcpClassHierarchyDefaultMaxNodes,
  resolveMcpSettingsPath,
  writeMcpClassHierarchyDefaultMaxNodes,
} from '../src/mcpSettings';

async function testSettingsLifecycle(): Promise<void> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mcp-settings-'));
  try {
    assert.strictEqual(
      await readMcpClassHierarchyDefaultMaxNodes({ homeDir }),
      DEFAULT_MCP_CLASS_HIERARCHY_MAX_NODES
    );

    await writeMcpClassHierarchyDefaultMaxNodes(75, { homeDir });
    assert.strictEqual(
      await readMcpClassHierarchyDefaultMaxNodes({ homeDir }),
      75
    );
    const settingsPath = resolveMcpSettingsPath(homeDir);
    const parsed = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8')) as {
      schemaVersion: number;
      classHierarchyDefaultMaxNodes: number;
    };
    assert.deepStrictEqual(parsed, {
      schemaVersion: 1,
      classHierarchyDefaultMaxNodes: 75,
    });
    if (process.platform !== 'win32') {
      const mode = (await fs.promises.stat(settingsPath)).mode & 0o777;
      assert.strictEqual(mode, 0o600);
    }

    await writeMcpClassHierarchyDefaultMaxNodes(0, { homeDir });
    assert.strictEqual(
      await readMcpClassHierarchyDefaultMaxNodes({ homeDir }),
      'all'
    );

    const warnings: string[] = [];
    await fs.promises.writeFile(settingsPath, '{ broken json');
    assert.strictEqual(
      await readMcpClassHierarchyDefaultMaxNodes({
        homeDir,
        log: (message) => warnings.push(message),
      }),
      DEFAULT_MCP_CLASS_HIERARCHY_MAX_NODES
    );
    assert.strictEqual(warnings.length, 1);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function testNormalization(): void {
  assert.strictEqual(normalizeMcpClassHierarchyDefaultMaxNodes(0), 0);
  assert.strictEqual(normalizeMcpClassHierarchyDefaultMaxNodes(5000), 5000);
  for (const invalid of [-1, 5001, 1.5, 'all', undefined]) {
    assert.strictEqual(
      normalizeMcpClassHierarchyDefaultMaxNodes(invalid),
      DEFAULT_MCP_CLASS_HIERARCHY_MAX_NODES
    );
  }
}

async function main(): Promise<void> {
  testNormalization();
  await testSettingsLifecycle();
  console.log('mcpSettings tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
