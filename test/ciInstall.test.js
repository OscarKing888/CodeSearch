const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const action = fs.readFileSync(path.join(__dirname, '../.github/actions/install-dependencies/action.yml'), 'utf8');
const script = action.split('      run: |\n')[1].split('\n').map(line => line.replace(/^        /, '')).join('\n');

// 执行 Action 的实际 Bash 内容，用临时 npm/sleep 模拟网络失败而不下载依赖。
function checkInstall(successAt, expectedStatus, expectedAttempts, expectedDelays) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-ci-install 中文 '));
  try {
    fs.writeFileSync(path.join(root, 'npm'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CI_INSTALL_TEST_LOG"
attempt=$(wc -l < "$CI_INSTALL_TEST_LOG")
if [ "$attempt" -lt "$CI_INSTALL_TEST_SUCCESS_AT" ]; then exit 7; fi
exit 0
`, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'sleep'), '#!/usr/bin/env bash\nprintf "%s\\n" "$1" >> "$CI_INSTALL_TEST_DELAYS"\n', { mode: 0o755 });
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: root + path.delimiter + process.env.PATH,
        CI_INSTALL_TEST_LOG: path.join(root, 'attempts'),
        CI_INSTALL_TEST_DELAYS: path.join(root, 'delays'),
        CI_INSTALL_TEST_SUCCESS_AT: String(successAt),
      },
    });
    assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
    assert.deepEqual(fs.readFileSync(path.join(root, 'attempts'), 'utf8').trim().split('\n'), Array(expectedAttempts).fill('ci'));
    const delays = fs.existsSync(path.join(root, 'delays')) ? fs.readFileSync(path.join(root, 'delays'), 'utf8').trim().split('\n').map(Number) : [];
    assert.deepEqual(delays, expectedDelays);
    if (expectedStatus !== 0) assert.match(result.stdout, /::error::npm ci failed after 3 attempts/);
  } finally {
    for (const name of fs.readdirSync(root)) fs.unlinkSync(path.join(root, name));
    fs.rmdirSync(root);
  }
}

checkInstall(1, 0, 1, []);
checkInstall(2, 0, 2, [5]);
checkInstall(3, 0, 3, [5, 10]);
checkInstall(4, 7, 3, [5, 10]);
console.log('CI install: immediate success, download retry recovery and final failure propagation passed.');
