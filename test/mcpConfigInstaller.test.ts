import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildCodexMcpServerBlock,
  buildCursorMcpServerEntry,
  buildMcpLauncher,
  installMcpClientConfig,
  resolveMcpJsPath,
  resolveMcpLauncherPath,
  upsertCodexMcpBlock,
  upsertCursorMcpJson,
} from '../src/mcpConfigInstaller';

function legacyCodexBlock(extensionRoot: string): string {
  return [
    '# BEGIN ACE-CODE-SEARCH-MCP',
    '# Managed by Ace Code Search. Restart Codex after changes.',
    '[mcp_servers.ace-code-search]',
    'command = "node"',
    `args = [${JSON.stringify(resolveMcpJsPath(extensionRoot))}, "--extension-root", ${JSON.stringify(extensionRoot)}]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 120',
    'enabled = true',
    '# END ACE-CODE-SEARCH-MCP',
    '',
  ].join('\n');
}

function testCodexMergeSafety(): void {
  const launcher = path.join(os.tmpdir(), '.ace-code-search', 'mcp-launcher.cjs');
  const root = path.join(os.tmpdir(), 'extension-root');
  const first = upsertCodexMcpBlock('model = "gpt"\n', launcher, root);
  assert.strictEqual(first.changed, true);
  assert.ok(first.content.includes(JSON.stringify(launcher)));
  assert.ok(first.content.startsWith('model = "gpt"\n'));
  assert.ok(!first.content.includes(resolveMcpJsPath(root)));

  const second = upsertCodexMcpBlock(first.content, launcher, root);
  assert.strictEqual(second.changed, false);
  assert.strictEqual(second.content, first.content);

  const migrated = upsertCodexMcpBlock(
    `model = "gpt"\n\n${legacyCodexBlock(root)}`,
    launcher,
    root
  );
  assert.strictEqual(migrated.changed, true);
  assert.ok(migrated.content.includes(JSON.stringify(launcher)));
  assert.ok(!migrated.content.includes(resolveMcpJsPath(root)));

  const displacedEnd = legacyCodexBlock(root).replace(
    '# END ACE-CODE-SEARCH-MCP\n',
    [
      '[mcp_servers.node_repl]',
      'command = "/managed/node_repl"',
      '',
      '[mcp_servers.node_repl.env]',
      'KEEP = "true"',
      '',
      '[mcp_servers.computer-use]',
      'command = "/managed/computer-use"',
      'enabled = false',
      '# END ACE-CODE-SEARCH-MCP',
      '',
    ].join('\n')
  );
  const recovered = upsertCodexMcpBlock(displacedEnd, launcher, root);
  assert.strictEqual(recovered.changed, true);
  assert.strictEqual(recovered.warning, undefined);
  assert.ok(recovered.content.includes(JSON.stringify(launcher)));
  assert.ok(!recovered.content.includes(resolveMcpJsPath(root)));
  assert.strictEqual(
    recovered.content.match(/\[mcp_servers\.node_repl\]/g)?.length,
    1
  );
  assert.ok(recovered.content.includes('KEEP = "true"'));
  assert.ok(recovered.content.includes('command = "/managed/computer-use"'));
  assert.ok(
    recovered.content.indexOf('# END ACE-CODE-SEARCH-MCP') <
      recovered.content.indexOf('[mcp_servers.node_repl]')
  );
  assert.ok(
    recovered.content.includes(
      '# END ACE-CODE-SEARCH-MCP\n\n[mcp_servers.node_repl]'
    )
  );

  const displacedEndCrlf = displacedEnd.replace(/\n/g, '\r\n');
  const recoveredCrlf = upsertCodexMcpBlock(
    displacedEndCrlf,
    launcher,
    root
  );
  assert.strictEqual(recoveredCrlf.changed, true);
  assert.strictEqual(recoveredCrlf.warning, undefined);
  assert.ok(recoveredCrlf.content.includes(JSON.stringify(launcher)));
  assert.ok(recoveredCrlf.content.includes('KEEP = "true"'));
  assert.strictEqual(
    recoveredCrlf.content.match(/\[mcp_servers\.node_repl\]/g)?.length,
    1
  );

  const windowsLauncher = 'C:\\Users\\tester\\.ace-code-search\\mcp-launcher.cjs';
  const windowsDisplacedEnd = buildCodexMcpServerBlock(windowsLauncher)
    .replace(
      '# END ACE-CODE-SEARCH-MCP\n',
      '[mcp_servers.keep]\ncommand = "keep-me"\n# END ACE-CODE-SEARCH-MCP\n'
    )
    .replace(/\n/g, '\r\n');
  const recoveredWindowsPath = upsertCodexMcpBlock(
    windowsDisplacedEnd,
    windowsLauncher
  );
  assert.strictEqual(recoveredWindowsPath.changed, true);
  assert.strictEqual(recoveredWindowsPath.warning, undefined);
  assert.ok(
    recoveredWindowsPath.content.includes(JSON.stringify(windowsLauncher))
  );
  assert.ok(recoveredWindowsPath.content.includes('command = "keep-me"'));

  const modifiedDisplacedEnd = displacedEnd.replace(
    'command = "node"',
    'command = "custom-node"'
  );
  const preservedDisplaced = upsertCodexMcpBlock(
    modifiedDisplacedEnd,
    launcher,
    root
  );
  assert.strictEqual(preservedDisplaced.changed, false);
  assert.strictEqual(preservedDisplaced.content, modifiedDisplacedEnd);
  assert.match(preservedDisplaced.warning ?? '', /modified/);

  const malformed = '# BEGIN ACE-CODE-SEARCH-MCP\nkeep = true\n';
  const malformedResult = upsertCodexMcpBlock(malformed, launcher, root);
  assert.strictEqual(malformedResult.changed, false);
  assert.strictEqual(malformedResult.content, malformed);
  assert.match(malformedResult.warning ?? '', /malformed|duplicated/);

  const unmanaged = "[mcp_servers . 'ace-code-search']\ncommand = 'custom'\n";
  const unmanagedResult = upsertCodexMcpBlock(unmanaged, launcher, root);
  assert.strictEqual(unmanagedResult.changed, false);
  assert.strictEqual(unmanagedResult.content, unmanaged);
  assert.match(unmanagedResult.warning ?? '', /unmanaged/);

  for (const customDefinition of [
    'mcp_servers.ace-code-search = { command = "custom" }\n',
    '["mcp_servers"."ace-code-search"]\ncommand = "custom"\n',
    "['mcp_servers'.'ace-code-search']\ncommand = 'custom'\n",
    '[mcp_servers]\nace-code-search = { command = "custom" }\n',
    '[mcp_servers]\n"ace-code-search".command = "custom"\n',
    'mcp_servers = { other = { command = "custom" } }\n',
  ]) {
    const customResult = upsertCodexMcpBlock(customDefinition, launcher, root);
    assert.strictEqual(customResult.changed, false);
    assert.strictEqual(customResult.content, customDefinition);
    assert.match(customResult.warning ?? '', /unmanaged/);
  }

  const modified = buildCodexMcpServerBlock(launcher).replace(
    'command = "node"',
    'command = "custom-node"'
  );
  const modifiedResult = upsertCodexMcpBlock(modified, launcher, root);
  assert.strictEqual(modifiedResult.changed, false);
  assert.strictEqual(modifiedResult.content, modified);
  assert.match(modifiedResult.warning ?? '', /modified/);
}

function testCursorMergeSafety(): void {
  const launcher = path.join(os.tmpdir(), '.ace-code-search', 'mcp-launcher.cjs');
  const root = path.join(os.tmpdir(), 'extension-root');
  const original = JSON.stringify({
    keep: true,
    mcpServers: { other: { command: 'other' } },
  });
  const first = upsertCursorMcpJson(original, launcher, root);
  assert.strictEqual(first.changed, true);
  const parsed = JSON.parse(first.content) as {
    keep: boolean;
    mcpServers: Record<string, unknown>;
  };
  assert.strictEqual(parsed.keep, true);
  assert.deepStrictEqual(parsed.mcpServers.other, { command: 'other' });
  assert.deepStrictEqual(
    parsed.mcpServers['ace-code-search'],
    buildCursorMcpServerEntry(launcher)
  );

  const second = upsertCursorMcpJson(first.content, launcher, root);
  assert.strictEqual(second.changed, false);
  assert.strictEqual(second.content, first.content);

  const invalid = '{ not json';
  const invalidResult = upsertCursorMcpJson(invalid, launcher, root);
  assert.strictEqual(invalidResult.changed, false);
  assert.strictEqual(invalidResult.content, invalid);
  assert.ok(invalidResult.warning);

  const wrongShape = '{"mcpServers":[]}';
  const wrongShapeResult = upsertCursorMcpJson(wrongShape, launcher, root);
  assert.strictEqual(wrongShapeResult.changed, false);
  assert.strictEqual(wrongShapeResult.content, wrongShape);
  assert.ok(wrongShapeResult.warning);

  const custom = JSON.stringify({
    mcpServers: {
      'ace-code-search': { command: 'custom', args: ['do-not-touch'] },
    },
  });
  const customResult = upsertCursorMcpJson(custom, launcher, root);
  assert.strictEqual(customResult.changed, false);
  assert.strictEqual(customResult.content, custom);
  assert.match(customResult.warning ?? '', /unmanaged/);

  const legacy = JSON.stringify({
    mcpServers: {
      'ace-code-search': {
        command: 'node',
        args: [resolveMcpJsPath(root), '--extension-root', root],
      },
    },
  });
  const migrated = upsertCursorMcpJson(legacy, launcher, root);
  assert.strictEqual(migrated.changed, true);
  assert.deepStrictEqual(
    (JSON.parse(migrated.content) as { mcpServers: Record<string, unknown> }).mcpServers[
      'ace-code-search'
    ],
    buildCursorMcpServerEntry(launcher)
  );
}

async function testInstallAndLauncher(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mcp-config-'));
  const extensionRoot = path.join(tmpDir, 'oscarking888.ace-code-search-999.0.0');
  const homeDir = path.join(tmpDir, 'home');
  const workspaceRoot = path.join(tmpDir, 'workspace');
  const displacedWorkspaceRoot = path.join(tmpDir, 'displaced-workspace');
  const mcpPath = resolveMcpJsPath(extensionRoot);
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(displacedWorkspaceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(extensionRoot, 'package.json'),
    JSON.stringify({ publisher: 'OscarKing888', name: 'ace-code-search', version: '999.0.0' })
  );
  fs.writeFileSync(
    mcpPath,
    'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1) }));\n'
  );
  const userCodexConfig = path.join(homeDir, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(userCodexConfig), { recursive: true });
  fs.writeFileSync(userCodexConfig, 'model = "gpt"\n', { mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(userCodexConfig, 0o600);
  }
  const projectConfig = path.join(workspaceRoot, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
  fs.writeFileSync(projectConfig, legacyCodexBlock(extensionRoot));
  const displacedProjectConfig = path.join(
    displacedWorkspaceRoot,
    '.codex',
    'config.toml'
  );
  const preservedProjectTable = [
    '[mcp_servers.keep]',
    'command = "keep-me"',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(displacedProjectConfig), { recursive: true });
  fs.writeFileSync(
    displacedProjectConfig,
    legacyCodexBlock(extensionRoot).replace(
      '# END ACE-CODE-SEARCH-MCP\n',
      `${preservedProjectTable}# END ACE-CODE-SEARCH-MCP\n`
    )
  );

  try {
    const first = await installMcpClientConfig({
      extensionRoot,
      homeDir,
      workspaceRoots: [workspaceRoot, displacedWorkspaceRoot],
    });
    assert.deepStrictEqual(first.warnings, []);
    assert.strictEqual(first.changed, true);
    const launcherPath = resolveMcpLauncherPath(homeDir);
    assert.strictEqual(first.launcherPath, launcherPath);
    assert.ok(fs.existsSync(launcherPath));
    assert.ok(fs.existsSync(path.join(homeDir, '.ace-code-search', '.mcp-launcher-managed.json')));
    assert.ok(!fs.existsSync(projectConfig), 'managed project .codex fallback should be removed');
    assert.strictEqual(
      fs.readFileSync(displacedProjectConfig, 'utf8'),
      preservedProjectTable
    );

    const codex = fs.readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8');
    assert.ok(codex.startsWith('model = "gpt"\n'));
    assert.ok(codex.includes(JSON.stringify(launcherPath)));
    assert.ok(!codex.includes(mcpPath));
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(userCodexConfig).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(launcherPath).mode & 0o777, 0o600);
    }
    const cursor = JSON.parse(
      fs.readFileSync(path.join(homeDir, '.cursor', 'mcp.json'), 'utf8')
    ) as { mcpServers: Record<string, unknown> };
    assert.deepStrictEqual(
      cursor.mcpServers['ace-code-search'],
      buildCursorMcpServerEntry(launcherPath)
    );

    const launched = spawnSync(
      process.execPath,
      [launcherPath, '--workspace-root', workspaceRoot],
      { encoding: 'utf8', env: { ...process.env, ACE_CODE_SEARCH_EXTENSION_ROOT: extensionRoot } }
    );
    assert.strictEqual(launched.status, 0, launched.stderr);
    const payload = JSON.parse(launched.stdout) as { argv: string[] };
    assert.strictEqual(fs.realpathSync(payload.argv[0]), fs.realpathSync(mcpPath));
    assert.ok(payload.argv.includes('--workspace-root'));
    const extensionRootFlag = payload.argv.indexOf('--extension-root');
    assert.ok(extensionRootFlag >= 0);
    assert.strictEqual(
      fs.realpathSync(payload.argv[extensionRootFlag + 1]),
      fs.realpathSync(extensionRoot)
    );

    const second = await installMcpClientConfig({ extensionRoot, homeDir });
    assert.strictEqual(second.changed, false);
    assert.deepStrictEqual(second.warnings, []);

    if (process.platform !== 'win32') {
      const symlinkHome = path.join(tmpDir, 'symlink-home');
      const dotfilesDir = path.join(tmpDir, 'dotfiles');
      const symlinkConfig = path.join(symlinkHome, '.codex', 'config.toml');
      const realConfig = path.join(dotfilesDir, 'codex.toml');
      fs.mkdirSync(path.dirname(symlinkConfig), { recursive: true });
      fs.mkdirSync(dotfilesDir, { recursive: true });
      fs.writeFileSync(realConfig, 'model = "symlinked"\n', { mode: 0o600 });
      fs.symlinkSync(realConfig, symlinkConfig, 'file');

      const symlinked = await installMcpClientConfig({
        extensionRoot,
        homeDir: symlinkHome,
      });
      assert.deepStrictEqual(symlinked.warnings, []);
      assert.strictEqual(fs.lstatSync(symlinkConfig).isSymbolicLink(), true);
      assert.ok(fs.readFileSync(realConfig, 'utf8').includes('[mcp_servers.ace-code-search]'));
      assert.strictEqual(fs.statSync(realConfig).mode & 0o777, 0o600);

      const symlinkWorkspace = path.join(tmpDir, 'symlink-workspace');
      const projectLink = path.join(symlinkWorkspace, '.codex', 'config.toml');
      const projectTarget = path.join(dotfilesDir, 'project-codex.toml');
      fs.mkdirSync(path.dirname(projectLink), { recursive: true });
      fs.writeFileSync(projectTarget, legacyCodexBlock(extensionRoot));
      fs.symlinkSync(projectTarget, projectLink, 'file');
      const preservedProjectLink = await installMcpClientConfig({
        extensionRoot,
        homeDir: symlinkHome,
        workspaceRoots: [symlinkWorkspace],
      });
      assert.ok(
        preservedProjectLink.warnings.some((warning) =>
          warning.includes('symbolic link')
        )
      );
      assert.strictEqual(fs.lstatSync(projectLink).isSymbolicLink(), true);
      assert.strictEqual(fs.readFileSync(projectTarget, 'utf8'), legacyCodexBlock(extensionRoot));

      const parentLinkWorkspace = path.join(tmpDir, 'parent-link-workspace');
      const realProjectDir = path.join(dotfilesDir, 'project-codex-dir');
      const parentLinkedConfig = path.join(realProjectDir, 'config.toml');
      fs.mkdirSync(parentLinkWorkspace, { recursive: true });
      fs.mkdirSync(realProjectDir, { recursive: true });
      fs.writeFileSync(parentLinkedConfig, legacyCodexBlock(extensionRoot));
      fs.symlinkSync(realProjectDir, path.join(parentLinkWorkspace, '.codex'), 'dir');
      const preservedParentLink = await installMcpClientConfig({
        extensionRoot,
        homeDir: symlinkHome,
        workspaceRoots: [parentLinkWorkspace],
      });
      assert.ok(
        preservedParentLink.warnings.some((warning) =>
          warning.includes('symbolic link')
        )
      );
      assert.strictEqual(
        fs.lstatSync(path.join(parentLinkWorkspace, '.codex')).isSymbolicLink(),
        true
      );
      assert.strictEqual(
        fs.readFileSync(parentLinkedConfig, 'utf8'),
        legacyCodexBlock(extensionRoot)
      );
    }

    fs.appendFileSync(launcherPath, '// user edit\n');
    const preserved = await installMcpClientConfig({ extensionRoot, homeDir });
    assert.strictEqual(preserved.changed, false);
    assert.ok(preserved.warnings.some((warning) => warning.includes('user-modified')));
    assert.ok(fs.readFileSync(launcherPath, 'utf8').includes('// user edit'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  testCodexMergeSafety();
  testCursorMergeSafety();
  assert.ok(buildMcpLauncher(process.cwd()).startsWith('// ACE-CODE-SEARCH-MCP-LAUNCHER'));
  await testInstallAndLauncher();
  console.log('mcpConfigInstaller tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
