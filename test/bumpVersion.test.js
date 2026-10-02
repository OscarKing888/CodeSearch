const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-bump-version-'));
const versionFiles = ['CHANGELOG.md', 'package-lock.json', 'package.json'];

function command(executable, args, cwd) {
  return spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function git(root, ...args) {
  const result = command('git', args, root);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function fixture(name, repository = true) {
  const root = path.join(temp, name);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'bump-version.js'), path.join(root, 'scripts', 'bump-version.js'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3' }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'fixture', version: '1.2.3', lockfileVersion: 3,
    packages: { '': { version: '1.2.3' }, 'node_modules/dependency': { version: '9.8.7' } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [1.2.3] - 2026-09-01\n\n- Initial.\n');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'original\n');
  if (repository) {
    git(root, '-c', 'init.defaultBranch=main', 'init');
    git(root, 'config', 'user.name', 'Version Test');
    git(root, 'config', 'user.email', 'version-test@example.invalid');
    git(root, 'config', 'commit.gpgsign', 'false');
    git(root, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
    git(root, 'add', '--', 'scripts/bump-version.js', ...versionFiles, 'unrelated.txt');
    git(root, 'commit', '-m', 'Initial fixture');
  }
  return root;
}

function bump(root, version, ...options) {
  return command(process.execPath, [path.join(root, 'scripts', 'bump-version.js'), version,
    '--date', '2026-10-02', ...options], root);
}

function expectSuccess(result) {
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
}

function versions(root, expected) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.strictEqual(pkg.version, expected);
  assert.strictEqual(lock.version, expected);
  assert.strictEqual(lock.packages[''].version, expected);
  assert.strictEqual(lock.packages['node_modules/dependency'].version, '9.8.7');
}

function snapshot(root) {
  return versionFiles.map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
}

try {
  const root = fixture('repo with spaces 中文');
  expectSuccess(bump(root, '1.2.4', '--notes', '中文版本说明'));
  versions(root, '1.2.4');
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /## \[1\.2\.4\] - 2026-10-02[\s\S]*中文版本说明/);
  assert.strictEqual(git(root, 'log', '-1', '--format=%s'), 'chore: bump version to 1.2.4');
  assert.deepStrictEqual(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort(), versionFiles);
  assert.strictEqual(git(root, 'status', '--porcelain'), '');

  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'staged work\n');
  git(root, 'add', '--', 'unrelated.txt');
  const staged = git(root, 'diff', '--cached', '--binary');
  expectSuccess(bump(root, '1.2.5'));
  assert.strictEqual(git(root, 'show', 'HEAD:unrelated.txt'), 'original');
  assert.strictEqual(git(root, 'diff', '--cached', '--binary'), staged, 'Unrelated staged work must survive unchanged');
  assert.deepStrictEqual(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort(), versionFiles);

  const head = git(root, 'rev-parse', 'HEAD');
  expectSuccess(bump(root, '1.2.5'));
  assert.strictEqual(git(root, 'rev-parse', 'HEAD'), head, 'An unchanged version must not create an empty commit');
  assert.strictEqual(git(root, 'diff', '--cached', '--binary'), staged);

  expectSuccess(bump(root, '1.2.6', '--no-commit'));
  versions(root, '1.2.6');
  assert.strictEqual(git(root, 'rev-parse', 'HEAD'), head);
  assert.strictEqual(git(root, 'diff', '--cached', '--binary'), staged);
  const before = snapshot(root);
  const dirtyResult = bump(root, '1.2.7');
  assert.strictEqual(dirtyResult.status, 1);
  assert.match(dirtyResult.stderr, /already have uncommitted changes/);
  assert.deepStrictEqual(snapshot(root), before, 'Dirty version files must be rejected before writes');
  git(root, 'add', '--', ...versionFiles);
  const dirtyIndex = git(root, 'diff', '--cached', '--binary');
  assert.strictEqual(bump(root, '1.2.7').status, 1);
  assert.deepStrictEqual(snapshot(root), before);
  assert.strictEqual(git(root, 'diff', '--cached', '--binary'), dirtyIndex);

  const archive = fixture('source archive', false);
  const archiveBefore = snapshot(archive);
  assert.strictEqual(bump(archive, '1.2.4').status, 1);
  assert.deepStrictEqual(snapshot(archive), archiveBefore);
  expectSuccess(bump(archive, '1.2.4', '--no-commit'));
  versions(archive, '1.2.4');

  const failed = fixture('failed commit');
  const failedHead = git(failed, 'rev-parse', 'HEAD');
  git(failed, 'config', 'user.name', '');
  const failedResult = bump(failed, '1.2.4');
  assert.strictEqual(failedResult.status, 1);
  assert.match(failedResult.stderr, /updated, but the commit failed/);
  assert.strictEqual(git(failed, 'rev-parse', 'HEAD'), failedHead);
  versions(failed, '1.2.4');
  assert.ok(git(failed, 'diff', '--name-only'), 'A failed commit must keep version updates');

  console.log('bumpVersion tests passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
