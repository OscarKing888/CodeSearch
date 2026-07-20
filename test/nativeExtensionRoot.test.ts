import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveExtensionRoot } from '../src/native/extensionRoot';

function main(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-code-search-root-'));
  try {
    const packageRoot = path.join(tmpDir, 'extension');
    const sourceDir = path.join(packageRoot, 'src', 'cli');
    const tag = `${process.platform}-${process.arch}-${process.versions.modules}`;
    fs.mkdirSync(
      path.join(packageRoot, 'native-node', tag),
      { recursive: true }
    );
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}');
    fs.writeFileSync(
      path.join(packageRoot, 'native-node', tag, 'better_sqlite3.node'),
      'test-placeholder'
    );

    assert.strictEqual(resolveExtensionRoot(sourceDir), packageRoot);

    const packageWithoutNative = path.join(tmpDir, 'fallback');
    const distDir = path.join(packageWithoutNative, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(packageWithoutNative, 'package.json'), '{}');
    assert.strictEqual(resolveExtensionRoot(distDir), packageWithoutNative);

    const noPackage = path.join(tmpDir, 'no-package', 'child');
    fs.mkdirSync(noPackage, { recursive: true });
    assert.throws(() => resolveExtensionRoot(noPackage), /Unable to locate/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('nativeExtensionRoot tests passed');
}

main();
