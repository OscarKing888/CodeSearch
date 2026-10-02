import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

function main(): void {
  const repoRoot = path.join(__dirname, '..');
  const cliPath = path.join(repoRoot, 'dist', 'cli.js');
  assert.ok(fs.existsSync(cliPath), 'Run npm run build before this smoke test.');

  const nativeBinding = path.join(
    repoRoot, 'native-node',
    `${process.platform}-${process.arch}-${process.versions.modules}`,
    'better_sqlite3.node'
  );
  assert.ok(fs.existsSync(nativeBinding), 'Run npm run rebuild:node before this smoke test.');
  // Explicit global.gc() does not reproduce Node #65446: allocation-driven GC
  // must reclaim short-lived Statements while the database remains open.
  const gcResult = spawnSync(process.execPath, ['--max-semi-space-size=1', '-e', `
    const assert = require('assert');
    const Database = require('better-sqlite3');
    const db = new Database(':memory:', { nativeBinding: process.argv[1] });
    let junk = [];
    try {
      for (let i = 0; i < 100000; i++) {
        assert.strictEqual(db.prepare('SELECT ? AS value').get(i).value, i);
        junk.push({ i, text: 'allocation pressure'.repeat(20) });
        if (junk.length >= 1024) junk = [];
      }
    } finally {
      db.close();
    }
    console.log('Statement GC smoke passed');
  `, nativeBinding], { encoding: 'utf8', cwd: repoRoot, timeout: 60000 });
  assert.strictEqual(
    gcResult.status, 0,
    `Statement GC smoke failed (${gcResult.signal || gcResult.error || gcResult.status}):\n` +
      (gcResult.stderr || gcResult.stdout)
  );
  assert.match(gcResult.stdout, /Statement GC smoke passed/);

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
