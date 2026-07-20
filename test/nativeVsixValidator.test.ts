import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const yazl = require('yazl') as {
  ZipFile: new () => {
    addBuffer(buffer: Buffer, name: string): void;
    end(): void;
    outputStream: NodeJS.ReadableStream;
  };
};
const matrix = require('../scripts/native-matrix') as {
  NATIVE_BINARY_NAME: string;
  expectedElectronTags(): string[];
  expectedNodeTags(): string[];
};

async function writeSyntheticVsix(vsixPath: string, repoRoot: string): Promise<void> {
  const zip = new yazl.ZipFile();
  const hostTag = `${process.platform}-${process.arch}-${process.versions.modules}`;
  const hostBinary = path.join(
    repoRoot,
    'native-node',
    hostTag,
    matrix.NATIVE_BINARY_NAME
  );
  const fallback = Buffer.from([1]);

  for (const tag of matrix.expectedElectronTags()) {
    zip.addBuffer(
      fallback,
      `extension/native/${tag}/${matrix.NATIVE_BINARY_NAME}`
    );
  }
  for (const tag of matrix.expectedNodeTags()) {
    const content =
      tag === hostTag && fs.existsSync(hostBinary)
        ? fs.readFileSync(hostBinary)
        : fallback;
    zip.addBuffer(
      content,
      `extension/native-node/${tag}/${matrix.NATIVE_BINARY_NAME}`
    );
  }
  for (const entry of [
    'extension/dist/mcp.js',
    'extension/dist/cli.js',
    'extension/node_modules/better-sqlite3/package.json',
    'extension/node_modules/better-sqlite3/lib/index.js',
    'extension/node_modules/better-sqlite3/lib/database.js',
  ]) {
    zip.addBuffer(Buffer.from('runtime'), entry);
  }

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(vsixPath);
    output.on('close', resolve);
    output.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

async function main(): Promise<void> {
  const repoRoot = path.join(__dirname, '..');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-native-vsix-'));
  const vsixPath = path.join(tmpDir, 'synthetic.vsix');
  try {
    await writeSyntheticVsix(vsixPath, repoRoot);
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'validate-vsix-native.js'), vsixPath],
      { encoding: 'utf8', cwd: repoRoot }
    );
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Validated 24 native binaries and 5 MCP\/CLI runtime entries/);
    if (matrix.expectedNodeTags().includes(
      `${process.platform}-${process.arch}-${process.versions.modules}`
    )) {
      assert.match(result.stdout, /Loaded packaged Node native binding/);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('nativeVsixValidator tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
