import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const matrix = require('../scripts/native-matrix') as {
  NATIVE_BINARY_NAME: string;
};
const {
  cursorHelperNodePath,
  listPackagedNodeTags,
  nodeCommandNames,
  relaunchWithCompatibleMcpNode,
  resolveCompatibleMcpNode,
  wellKnownNodeCandidates,
} = require('../scripts/mcp-node-resolver') as {
  cursorHelperNodePath: (cliPath: string, platform?: NodeJS.Platform) => string;
  listPackagedNodeTags: (extensionRoot: string) => string[];
  nodeCommandNames: (platform?: NodeJS.Platform) => string[];
  relaunchWithCompatibleMcpNode: (
    extensionRoot: string,
    options?: {
      argv?: string[];
      currentExecPath?: string;
      compatibleNode?: string;
      env?: NodeJS.ProcessEnv;
      spawnSync?: typeof spawnSync;
    }
  ) => number | undefined;
  resolveCompatibleMcpNode: (extensionRoot: string) => string;
  wellKnownNodeCandidates: (platform?: NodeJS.Platform) => string[];
};

function writePackagedNodeBinary(extensionRoot: string, tag: string): void {
  const dir = path.join(extensionRoot, 'native-node', tag);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, matrix.NATIVE_BINARY_NAME), Buffer.from([1]));
}

function findSupportedNodeExecutable(targetAbi: string): string | undefined {
  const candidates = [
    process.env.ACE_CODE_SEARCH_NODE,
    '/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node',
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .flatMap((directory) => [
        path.join(directory, 'node'),
        path.join(directory, 'node22'),
        path.join(directory, 'node24'),
        path.join(directory, 'node20'),
      ]),
  ].filter(Boolean) as string[];

  for (const executable of candidates) {
    try {
      if (!fs.statSync(executable).isFile()) continue;
      const output = execFileSync(
        executable,
        ['-p', 'process.versions.modules'],
        { encoding: 'utf8' }
      ).trim();
      if (output === targetAbi) {
        return executable;
      }
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function testCursorHelperNodePath(): void {
  assert.strictEqual(
    cursorHelperNodePath(
      '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
      'darwin'
    ),
    '/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node'
  );
}

function testCrossPlatformNodeCandidates(): void {
  assert.deepStrictEqual(nodeCommandNames('darwin'), [
    'node',
    'node20',
    'node22',
    'node24',
  ]);
  assert.deepStrictEqual(nodeCommandNames('win32'), [
    'node.exe',
    'node20.exe',
    'node22.exe',
    'node24.exe',
    'node',
    'node20',
    'node22',
    'node24',
  ]);
  assert.ok(
    wellKnownNodeCandidates('darwin').includes(
      '/opt/homebrew/opt/node@22/bin/node'
    )
  );
  assert.deepStrictEqual(wellKnownNodeCandidates('win32'), []);
}

function testListPackagedNodeTags(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mcp-node-tags-'));
  try {
    writePackagedNodeBinary(tmpDir, `${process.platform}-${process.arch}-127`);
    writePackagedNodeBinary(tmpDir, `${process.platform}-${process.arch}-115`);
    writePackagedNodeBinary(tmpDir, 'linux-x64-127');

    const tags = listPackagedNodeTags(tmpDir).sort();
    assert.deepStrictEqual(tags, [
      `${process.platform}-${process.arch}-115`,
      `${process.platform}-${process.arch}-127`,
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testResolveCompatibleMcpNodeUsesCurrentRuntimeWhenPackaged(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mcp-node-current-'));
  try {
    const currentTag = `${process.platform}-${process.arch}-${process.versions.modules}`;
    writePackagedNodeBinary(tmpDir, currentTag);
    assert.strictEqual(resolveCompatibleMcpNode(tmpDir), process.execPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testResolveCompatibleMcpNodeUsesEnvOverride(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mcp-node-env-'));
  const previous = process.env.ACE_CODE_SEARCH_NODE;
  try {
    const compatible = findSupportedNodeExecutable('127');
    if (!compatible || process.versions.modules === '127') {
      console.log('Skipping env override test: no distinct Node ABI 127 runtime found.');
      return;
    }

    writePackagedNodeBinary(tmpDir, `${process.platform}-${process.arch}-127`);
    process.env.ACE_CODE_SEARCH_NODE = compatible;
    assert.strictEqual(resolveCompatibleMcpNode(tmpDir), fs.realpathSync(compatible));
  } finally {
    if (previous === undefined) {
      delete process.env.ACE_CODE_SEARCH_NODE;
    } else {
      process.env.ACE_CODE_SEARCH_NODE = previous;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testResolveCompatibleMcpNodeFindsCursorHelperOnMismatch(): void {
  if (process.versions.modules === '127') {
    console.log('Skipping Cursor helper fallback test: current runtime already ABI 127.');
    return;
  }

  const helper =
    '/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node';
  if (!fs.existsSync(helper)) {
    console.log('Skipping Cursor helper fallback test: helper node not installed.');
    return;
  }

  const helperAbi = execFileSync(helper, ['-p', 'process.versions.modules'], {
    encoding: 'utf8',
  }).trim();
  if (helperAbi !== '127') {
    console.log(`Skipping Cursor helper fallback test: helper ABI is ${helperAbi}.`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mcp-node-helper-'));
  try {
    writePackagedNodeBinary(tmpDir, `${process.platform}-${process.arch}-127`);
    assert.strictEqual(resolveCompatibleMcpNode(tmpDir), fs.realpathSync(helper));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testResolveCompatibleMcpNodeThrowsWhenNoMatch(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mcp-node-missing-'));
  const previous = process.env.ACE_CODE_SEARCH_NODE;
  try {
    writePackagedNodeBinary(tmpDir, 'linux-x64-115');
    delete process.env.ACE_CODE_SEARCH_NODE;
    assert.throws(
      () => resolveCompatibleMcpNode(tmpDir),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('cannot load better-sqlite3') &&
        error.message.includes('ACE_CODE_SEARCH_NODE')
    );
  } finally {
    if (previous === undefined) {
      delete process.env.ACE_CODE_SEARCH_NODE;
    } else {
      process.env.ACE_CODE_SEARCH_NODE = previous;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testRelaunchDropsParentNodeExecutableArgument(): void {
  const argv = [
    path.resolve('old-node'),
    path.resolve('mcp-launcher.cjs'),
    '--workspace-root',
    path.resolve('workspace with spaces'),
  ];
  let observed:
    | { command: string; args: readonly string[]; options: unknown }
    | undefined;
  const status = relaunchWithCompatibleMcpNode(path.resolve('extension'), {
    argv,
    currentExecPath: path.resolve('old-node'),
    compatibleNode: path.resolve('compatible-node'),
    spawnSync: ((command: string, args: readonly string[], options: unknown) => {
      observed = { command, args, options };
      return { status: 0 };
    }) as typeof spawnSync,
  });

  assert.strictEqual(status, 0);
  assert.ok(observed);
  assert.strictEqual(observed.command, path.resolve('compatible-node'));
  assert.deepStrictEqual(observed.args, argv.slice(1));
  assert.ok(!observed.args.includes(argv[0]));
}

function testRelaunchRunsScriptWithDistinctRuntimeWhenAvailable(): void {
  const compatible = findSupportedNodeExecutable('127');
  if (!compatible || process.versions.modules === '127') {
    console.log('Skipping live relaunch test: no distinct Node ABI 127 runtime found.');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mcp-node-relaunch-'));
  const probe = path.join(tmpDir, 'probe.js');
  fs.writeFileSync(
    probe,
    'process.stdout.write(JSON.stringify({ abi: process.versions.modules, argv: process.argv.slice(2) }));\n'
  );
  let stdout = '';
  try {
    const status = relaunchWithCompatibleMcpNode(tmpDir, {
      argv: [process.execPath, probe, 'value with spaces'],
      compatibleNode: compatible,
      spawnSync: ((command: string, args: readonly string[], options: unknown) => {
        const result = spawnSync(command, args, {
          ...(options as object),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        stdout = result.stdout;
        return result;
      }) as typeof spawnSync,
    });
    assert.strictEqual(status, 0);
    assert.deepStrictEqual(JSON.parse(stdout), {
      abi: '127',
      argv: ['value with spaces'],
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main(): void {
  testCursorHelperNodePath();
  testCrossPlatformNodeCandidates();
  testListPackagedNodeTags();
  testResolveCompatibleMcpNodeUsesCurrentRuntimeWhenPackaged();
  testResolveCompatibleMcpNodeUsesEnvOverride();
  testResolveCompatibleMcpNodeFindsCursorHelperOnMismatch();
  testResolveCompatibleMcpNodeThrowsWhenNoMatch();
  testRelaunchDropsParentNodeExecutableArgument();
  testRelaunchRunsScriptWithDistinctRuntimeWhenAvailable();
  console.log('mcpNodeResolver tests passed');
}

main();
