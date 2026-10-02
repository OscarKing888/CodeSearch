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
  fs.copyFileSync(path.join(__dirname, '..', 'bump-version.sh'), path.join(root, 'bump-version.sh'));
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
    git(root, 'config', 'tag.gpgsign', 'false');
    git(root, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
    git(root, 'add', '--', 'scripts/bump-version.js', 'bump-version.sh', ...versionFiles, 'unrelated.txt');
    git(root, 'commit', '-m', 'Initial fixture');
    // A local bare repository stands in for origin so pushes can be verified.
    git(temp, '-c', 'init.defaultBranch=main', 'init', '--bare', `${name}.git`);
    git(root, 'remote', 'add', 'origin', path.join(temp, `${name}.git`));
    git(root, 'push', '-q', 'origin', 'main');
  }
  return root;
}

function remoteRef(root, ref) {
  const result = command('git', ['rev-parse', '-q', '--verify', ref], path.join(temp, `${path.basename(root)}.git`));
  return result.status === 0 ? result.stdout.trim() : '';
}

// The entry scripts own the commit, tag, and push, so end-to-end checks run through bump-version.sh.
function bump(root, version, ...options) {
  return command('bash', [path.join(root, 'bump-version.sh'), version, '--date', '2026-10-02', ...options], root);
}

function prepare(root, version, ...options) {
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
  assert.strictEqual(git(root, 'cat-file', '-t', 'refs/tags/v1.2.4'), 'tag');
  assert.strictEqual(git(root, 'rev-parse', 'v1.2.4^{commit}'), git(root, 'rev-parse', 'HEAD'));
  assert.strictEqual(git(root, 'for-each-ref', '--format=%(contents:subject)', 'refs/tags/v1.2.4'), 'Release 1.2.4');
  assert.strictEqual(remoteRef(root, 'refs/heads/main'), git(root, 'rev-parse', 'HEAD'), 'main must be pushed');
  assert.strictEqual(remoteRef(root, 'refs/tags/v1.2.4'), git(root, 'rev-parse', 'refs/tags/v1.2.4'), 'The tag must be pushed');

  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'staged work\n');
  git(root, 'add', '--', 'unrelated.txt');
  const staged = git(root, 'diff', '--cached', '--binary');
  expectSuccess(bump(root, '1.2.5'));
  assert.strictEqual(git(root, 'show', 'HEAD:unrelated.txt'), 'original');
  assert.strictEqual(git(root, 'diff', '--cached', '--binary'), staged, 'Unrelated staged work must survive unchanged');
  assert.deepStrictEqual(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort(), versionFiles);

  const head = git(root, 'rev-parse', 'HEAD');
  const tag = git(root, 'rev-parse', 'refs/tags/v1.2.5');
  expectSuccess(bump(root, '1.2.5'));
  assert.strictEqual(git(root, 'rev-parse', 'HEAD'), head, 'An unchanged version must not create an empty commit');
  assert.strictEqual(git(root, 'diff', '--cached', '--binary'), staged);
  assert.strictEqual(git(root, 'rev-parse', 'refs/tags/v1.2.5'), tag, 'Repeated bumps must not replace the tag');

  git(root, 'commit', '-m', 'Unrelated change');
  const laterHead = git(root, 'rev-parse', 'HEAD');
  expectSuccess(bump(root, '1.2.5'));
  assert.strictEqual(git(root, 'rev-parse', 'HEAD'), laterHead);
  assert.strictEqual(git(root, 'rev-parse', 'refs/tags/v1.2.5'), tag, 'Unrelated commits must not move release tags');

  expectSuccess(bump(root, '1.2.6', '--no-tag'));
  assert.strictEqual(git(root, 'tag', '--list', 'v1.2.6'), '');
  const untaggedHead = git(root, 'rev-parse', 'HEAD');
  assert.strictEqual(remoteRef(root, 'refs/heads/main'), untaggedHead, '--no-tag still pushes main');
  assert.strictEqual(remoteRef(root, 'refs/tags/v1.2.6'), '');
  expectSuccess(bump(root, '1.2.6'));
  assert.strictEqual(git(root, 'rev-parse', 'HEAD'), untaggedHead, 'Missing tags can be created without another commit');
  assert.strictEqual(git(root, 'rev-parse', 'v1.2.6^{commit}'), untaggedHead);
  assert.strictEqual(remoteRef(root, 'refs/tags/v1.2.6'), git(root, 'rev-parse', 'refs/tags/v1.2.6'));

  expectSuccess(bump(root, '1.2.7', '--no-commit'));
  versions(root, '1.2.7');
  assert.strictEqual(git(root, 'rev-parse', 'HEAD'), untaggedHead);
  assert.strictEqual(git(root, 'tag', '--list', 'v1.2.7'), '');
  const before = snapshot(root);
  const dirtyResult = bump(root, '1.2.8');
  assert.strictEqual(dirtyResult.status, 1);
  assert.match(dirtyResult.stderr, /already have uncommitted changes/);
  assert.deepStrictEqual(snapshot(root), before, 'Dirty version files must be rejected before writes');
  git(root, 'add', '--', ...versionFiles);
  const dirtyIndex = git(root, 'diff', '--cached', '--binary');
  assert.strictEqual(bump(root, '1.2.8').status, 1);
  assert.deepStrictEqual(snapshot(root), before);
  assert.strictEqual(git(root, 'diff', '--cached', '--binary'), dirtyIndex);

  const archive = fixture('source archive', false);
  const archiveBefore = snapshot(archive);
  assert.strictEqual(bump(archive, '1.2.4').status, 1);
  assert.deepStrictEqual(snapshot(archive), archiveBefore);
  expectSuccess(bump(archive, '1.2.4', '--no-commit'));
  versions(archive, '1.2.4');

  const direct = fixture('direct script');
  const directFiles = snapshot(direct);
  const directResult = prepare(direct, '1.2.4');
  assert.strictEqual(directResult.status, 1, 'Running the JS directly must not skip the commit silently');
  assert.match(directResult.stderr, /Run \.\/bump-version\.sh or bump-version\.bat/);
  assert.deepStrictEqual(snapshot(direct), directFiles);
  const directPlan = prepare(direct, '1.2.4', '--no-commit');
  expectSuccess(directPlan);
  assert.deepStrictEqual(directPlan.stdout.trim().split('\n'),
    ['version=1.2.4', 'commit=0', 'create_tag=0', 'push=0', 'push_tag=0']);
  versions(direct, '1.2.4');

  const local = fixture('no push');
  const remoteHead = remoteRef(local, 'refs/heads/main');
  expectSuccess(bump(local, '1.2.4', '--no-push'));
  assert.strictEqual(git(local, 'rev-parse', 'v1.2.4^{commit}'), git(local, 'rev-parse', 'HEAD'));
  assert.strictEqual(remoteRef(local, 'refs/heads/main'), remoteHead, '--no-push must leave origin unchanged');
  assert.strictEqual(remoteRef(local, 'refs/tags/v1.2.4'), '');
  const localHead = git(local, 'rev-parse', 'HEAD');
  expectSuccess(bump(local, '1.2.4'));
  assert.strictEqual(git(local, 'rev-parse', 'HEAD'), localHead, 'A later push must not create another commit');
  assert.strictEqual(remoteRef(local, 'refs/heads/main'), localHead);
  assert.strictEqual(remoteRef(local, 'refs/tags/v1.2.4'), git(local, 'rev-parse', 'refs/tags/v1.2.4'));

  const branch = fixture('work branch');
  git(branch, 'switch', '-q', '-c', 'work/feature');
  const branchFiles = snapshot(branch);
  const branchResult = bump(branch, '1.2.4');
  assert.strictEqual(branchResult.status, 1);
  assert.match(branchResult.stderr, /requires this checkout to be on main/);
  assert.deepStrictEqual(snapshot(branch), branchFiles, 'A non-main push must be rejected before writes');
  expectSuccess(bump(branch, '1.2.4', '--no-push'));
  assert.strictEqual(git(branch, 'rev-parse', 'v1.2.4^{commit}'), git(branch, 'rev-parse', 'HEAD'));

  const rejected = fixture('rejected push');
  const other = path.join(temp, 'rejected push clone');
  git(temp, 'clone', '-q', path.join(temp, 'rejected push.git'), other);
  git(other, 'config', 'user.name', 'Version Test');
  git(other, 'config', 'user.email', 'version-test@example.invalid');
  fs.writeFileSync(path.join(other, 'unrelated.txt'), 'remote change\n');
  git(other, 'commit', '-qam', 'Remote change');
  git(other, 'push', '-q', 'origin', 'main');
  const rejectedRemote = remoteRef(rejected, 'refs/heads/main');
  const rejectedResult = bump(rejected, '1.2.4');
  assert.strictEqual(rejectedResult.status, 1);
  assert.match(rejectedResult.stderr, /commit and tag were kept, but pushing to origin failed/);
  assert.strictEqual(git(rejected, 'rev-parse', 'v1.2.4^{commit}'), git(rejected, 'rev-parse', 'HEAD'));
  assert.strictEqual(remoteRef(rejected, 'refs/heads/main'), rejectedRemote, 'An atomic push must not update main alone');
  assert.strictEqual(remoteRef(rejected, 'refs/tags/v1.2.4'), '', 'An atomic push must not publish the tag alone');
  git(rejected, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
  expectSuccess(bump(rejected, '1.2.4'));
  assert.strictEqual(remoteRef(rejected, 'refs/heads/main'), git(rejected, 'rev-parse', 'HEAD'));
  assert.strictEqual(remoteRef(rejected, 'refs/tags/v1.2.4'), git(rejected, 'rev-parse', 'refs/tags/v1.2.4'));

  const failed = fixture('failed commit');
  const failedHead = git(failed, 'rev-parse', 'HEAD');
  git(failed, 'config', 'user.name', '');
  const failedResult = bump(failed, '1.2.4');
  assert.strictEqual(failedResult.status, 1);
  assert.match(failedResult.stderr, /updated, but the commit failed/);
  assert.strictEqual(git(failed, 'rev-parse', 'HEAD'), failedHead);
  versions(failed, '1.2.4');
  assert.ok(git(failed, 'diff', '--name-only'), 'A failed commit must keep version updates');
  assert.strictEqual(git(failed, 'tag', '--list', 'v1.2.4'), '', 'A failed commit must not create a tag');

  const collision = fixture('tag collision');
  git(collision, 'tag', '-a', 'v1.2.4', '-m', 'Existing unrelated tag');
  const originalTag = git(collision, 'rev-parse', 'refs/tags/v1.2.4');
  const originalHead = git(collision, 'rev-parse', 'HEAD');
  const originalFiles = snapshot(collision);
  const collisionResult = bump(collision, '1.2.4');
  assert.strictEqual(collisionResult.status, 1);
  assert.match(collisionResult.stderr, /already exists for different version files/);
  assert.deepStrictEqual(snapshot(collision), originalFiles);
  assert.strictEqual(git(collision, 'rev-parse', 'HEAD'), originalHead);
  assert.strictEqual(git(collision, 'rev-parse', 'refs/tags/v1.2.4'), originalTag);
  assert.strictEqual(bump(collision, '1.2.5-invalid..tag').status, 1);
  assert.deepStrictEqual(snapshot(collision), originalFiles, 'Invalid tag names must be rejected before writes');
  assert.strictEqual(git(collision, 'rev-parse', 'HEAD'), originalHead);

  const failedTag = fixture('failed tag');
  git(failedTag, 'config', 'tag.gpgsign', 'true');
  git(failedTag, 'config', 'gpg.program', path.join(failedTag, 'missing-gpg'));
  const tagResult = bump(failedTag, '1.2.4');
  assert.strictEqual(tagResult.status, 1);
  assert.match(tagResult.stderr, /commit .* was kept, but creating tag v1\.2\.4 failed/);
  versions(failedTag, '1.2.4');
  assert.strictEqual(git(failedTag, 'status', '--porcelain'), '');
  assert.strictEqual(git(failedTag, 'tag', '--list', 'v1.2.4'), '');
  const recoveryHead = git(failedTag, 'rev-parse', 'HEAD');
  git(failedTag, 'config', 'tag.gpgsign', 'false');
  expectSuccess(bump(failedTag, '1.2.4'));
  assert.strictEqual(git(failedTag, 'rev-parse', 'HEAD'), recoveryHead);
  assert.strictEqual(git(failedTag, 'rev-parse', 'v1.2.4^{commit}'), recoveryHead);

  console.log('bumpVersion tests passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
