#!/usr/bin/env node
// Run a CI command with bounded retries for transient download failures.
// Usage: node scripts/ci-retry.js [--delays 5,10] [--] <command> [args...]
// Attempts = delays + 1; the final failure keeps the command's exit code.
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  let delays = [5, 10];
  let index = 0;
  for (; index < argv.length; index++) {
    if (argv[index] === '--delays' && index + 1 < argv.length) {
      delays = argv[++index].split(',').map((value) => Number(value.trim()));
    } else {
      // `--` is optional: Windows PowerShell may drop it before native commands.
      if (argv[index] === '--') index++;
      break;
    }
  }
  if (index >= argv.length) {
    throw new Error('Usage: node scripts/ci-retry.js [--delays 5,10] [--] <command> [args...]');
  }
  if (delays.some((delay) => !Number.isFinite(delay) || delay < 0)) {
    throw new Error('--delays must be a comma-separated list of non-negative seconds.');
  }
  return { delays, command: argv[index], args: argv.slice(index + 1) };
}

function sleepSeconds(seconds) {
  if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function main() {
  const { delays, command, args } = parseArgs(process.argv.slice(2));
  // Reuse the current runtime for `node` so Windows/setup-node never resolves another binary.
  const executable = command === 'node' ? process.execPath : command;
  const label = [command, ...args].join(' ');
  const attempts = delays.length + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = spawnSync(executable, args, { stdio: 'inherit' });
    if (result.status === 0) return 0;
    const status = result.status ?? 1;
    const reason = result.error ? result.error.message : result.signal || `exit ${status}`;
    if (attempt === attempts) {
      console.log(`::error::${label} failed after ${attempts} attempts (${reason}).`);
      return status;
    }
    const delay = delays[attempt - 1];
    console.log(`::warning::${label} attempt ${attempt} failed (${reason}); retrying in ${delay}s.`);
    sleepSeconds(delay);
  }
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
