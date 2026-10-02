const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const retryScript = path.join(__dirname, '../scripts/ci-retry.js');

// 用计数文件模拟前几次下载失败，覆盖 Windows/macOS/Linux 的 node 子进程与退出码传递。
function checkRetry(successAt, expectedStatus, expectedAttempts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-ci-retry 中文 '));
  const counter = path.join(root, 'attempts');
  const child = `const fs=require('fs');fs.appendFileSync(process.argv[1],'x');` +
    `process.exit(fs.readFileSync(process.argv[1],'utf8').length < Number(process.argv[2]) ? 7 : 0);`;
  try {
    const result = spawnSync(process.execPath, [
      retryScript, '--delays', '0,0', '--', 'node', '-e', child, counter, String(successAt),
    ], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(counter, 'utf8').length, expectedAttempts);
    assert.equal((result.stdout.match(/::warning::/g) || []).length, expectedAttempts - 1);
    if (expectedStatus !== 0) assert.match(result.stdout, /::error::node .* failed after 3 attempts \(exit 7\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

checkRetry(1, 0, 1);
checkRetry(2, 0, 2);
checkRetry(3, 0, 3);
checkRetry(4, 7, 3);

// Windows PowerShell 可能吞掉 `--`；无分隔符时也必须把首个非选项参数当作命令。
const noSeparator = spawnSync(process.execPath, [retryScript, '--delays', '0', 'node', '-e', 'process.exit(3)'], { encoding: 'utf8' });
assert.equal(noSeparator.status, 3);
assert.match(noSeparator.stdout, /failed after 2 attempts \(exit 3\)/);

const usage =spawnSync(process.execPath, [retryScript, '--delays', '5'], { encoding: 'utf8' });
assert.equal(usage.status, 2);
assert.match(usage.stderr, /Usage:/);
const badDelay = spawnSync(process.execPath, [retryScript, '--delays', '-1', '--', 'node', '-e', ''], { encoding: 'utf8' });
assert.equal(badDelay.status, 2);
console.log('CI retry: immediate success, retry recovery, exit-code propagation and argument validation passed.');
