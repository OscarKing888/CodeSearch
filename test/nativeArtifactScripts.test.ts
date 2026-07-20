import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const matrix = require('../scripts/native-matrix') as {
  ELECTRON_ABIS: string[];
  NODE_RUNTIMES: Array<{ major: string; abi: string }>;
  RELEASE_TARGETS: Array<{ platform: string; arch: string }>;
};
const { validateNativeArtifacts } = require('../scripts/validate-native-artifacts') as {
  validateNativeArtifacts(root: string): { failures: unknown[] };
};

function writeBinary(root: string, artifactName: string, tag: string): void {
  const dir = path.join(root, artifactName, tag);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'better_sqlite3.node'), Buffer.from([1]));
}

function main(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-native-artifacts-'));
  const artifactsDir = path.join(tmpDir, 'artifacts');
  const outputRoot = path.join(tmpDir, 'merged');
  fs.mkdirSync(artifactsDir, { recursive: true });

  try {
    for (const target of matrix.RELEASE_TARGETS) {
      const electronArtifact =
        `electron-native-${target.platform}-${target.arch}`;
      for (const abi of matrix.ELECTRON_ABIS) {
        writeBinary(
          artifactsDir,
          electronArtifact,
          `${target.platform}-${target.arch}-${abi}`
        );
      }

      for (const runtime of matrix.NODE_RUNTIMES) {
        writeBinary(
          artifactsDir,
          `node-native-${target.platform}-${target.arch}-node${runtime.major}`,
          `${target.platform}-${target.arch}-${runtime.abi}`
        );
      }
    }

    const merge = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'merge-native-artifacts.js')],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ARTIFACTS_DIR: artifactsDir,
          NATIVE_OUTPUT_ROOT: outputRoot,
        },
      }
    );
    assert.strictEqual(merge.status, 0, merge.stderr || merge.stdout);

    const validation = validateNativeArtifacts(outputRoot);
    assert.deepStrictEqual(validation.failures, []);
    assert.ok(
      fs.existsSync(
        path.join(outputRoot, 'native', 'linux-x64-136', 'better_sqlite3.node')
      )
    );
    assert.ok(
      fs.existsSync(
        path.join(outputRoot, 'native-node', 'linux-x64-115', 'better_sqlite3.node')
      )
    );
    assert.ok(
      !fs.existsSync(
        path.join(outputRoot, 'native', 'linux-x64-115', 'better_sqlite3.node')
      ),
      'Node ABI binaries must never be merged into the Electron directory'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('nativeArtifactScripts tests passed');
}

main();
