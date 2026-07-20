import * as assert from 'assert';
import * as path from 'path';
import {
  buildVscodeMcpLaunchSpec,
  VSCODE_MCP_SERVER_DEFINITION_PROVIDER_ID,
} from '../src/vscodeMcpProvider';

function testFullLaunchSpec(): void {
  const extensionRoot = path.resolve('tmp', 'ace-code-search-extension');
  const workspaceRoots = [
    path.resolve('tmp', 'workspace-a'),
    path.resolve('tmp', 'workspace-b'),
  ];
  const executablePath = path.resolve('tmp', 'editor', 'Code.exe');

  const launch = buildVscodeMcpLaunchSpec({
    extensionRoot,
    executablePath,
    version: '1.2.3',
    workspaceRoots,
  });

  assert.ok(launch);
  assert.strictEqual(
    VSCODE_MCP_SERVER_DEFINITION_PROVIDER_ID,
    'ace-code-search.mcp-servers'
  );
  assert.strictEqual(launch.label, 'Ace Code Search');
  assert.strictEqual(launch.command, executablePath);
  assert.strictEqual(launch.cwd, workspaceRoots[0]);
  assert.strictEqual(launch.version, '1.2.3');
  assert.deepStrictEqual(launch.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.deepStrictEqual(launch.args, [
    path.join(extensionRoot, 'dist', 'mcp.js'),
    '--extension-root',
    extensionRoot,
    '--workspace-root',
    workspaceRoots[0],
    '--workspace-root',
    workspaceRoots[1],
  ]);
}

function testNoWorkspaceMeansNoDefinition(): void {
  assert.strictEqual(
    buildVscodeMcpLaunchSpec({
      extensionRoot: path.resolve('tmp', 'ace-code-search-extension'),
      executablePath: process.execPath,
      version: '1.2.3',
      workspaceRoots: [],
    }),
    undefined
  );
}

function main(): void {
  testFullLaunchSpec();
  testNoWorkspaceMeansNoDefinition();
  console.log('VS Code MCP provider tests passed');
}

main();
