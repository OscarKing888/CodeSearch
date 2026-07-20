import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

function main(): void {
  const repoRoot = path.join(__dirname, '..');
  const cliPath = path.join(repoRoot, 'dist', 'cli.js');
  assert.ok(fs.existsSync(cliPath), 'Run npm run build before this smoke test.');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-cli-native-'));
  try {
    const sourceRoot = path.join(tmpDir, 'source');
    const dbPath = path.join(tmpDir, 'index.db');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, 'sample.ts'),
      'export const nativeCliSmoke = true;\n'
    );

    const result = spawnSync(
      process.execPath,
      [cliPath, 'create', '--root', sourceRoot, '--db', dbPath],
      { encoding: 'utf8', cwd: repoRoot }
    );
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.ok(fs.existsSync(dbPath));
    assert.match(result.stdout, /Created index:/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('nativeCliSmoke tests passed');
}

main();
