const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { nodeRuntimeForMajor } = require('./native-matrix');

const ROOT = path.join(__dirname, '..');
const MODULE_DIR = path.join(ROOT, 'node_modules', 'better-sqlite3');

function resolveNodeGyp() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
    path.join(ROOT, 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
    path.join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
    path.join(ROOT, 'node_modules', '@electron', 'node-gyp', 'bin', 'node-gyp.js'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getTargetArch() {
  const targetArch =
    process.env.npm_config_target_arch ||
    process.env.npm_config_arch ||
    process.arch;
  return String(targetArch).trim() || process.arch;
}

function assertSupportedRuntime() {
  const major = process.versions.node.split('.')[0];
  if (!/^\d+$/.test(major) || Number(major) < 20) {
    throw new Error(
      `Unsupported Node.js ${process.version}. Ace Code Search build tooling requires Node.js 20 or newer.`
    );
  }
  const expected = nodeRuntimeForMajor(major);
  if (expected && process.versions.modules !== expected.abi) {
    throw new Error(
      `Unexpected Node.js ${major} module ABI ${process.versions.modules}; expected ABI ${expected.abi}. ` +
        'Update scripts/native-matrix.js and the release workflow together if Node changes its ABI.'
    );
  }
  if (!expected) {
    console.warn(
      `Node.js ${major} is outside the packaged 20/22/24 release matrix; ` +
        `staging local ABI ${process.versions.modules} for compatibility.`
    );
  }
  return { abi: process.versions.modules };
}

function stageNativeNodeBinary(targetArch) {
  const src = path.join(MODULE_DIR, 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(src)) {
    throw new Error(`Expected Node better_sqlite3 binary missing: ${src}`);
  }

  const tag = `${process.platform}-${targetArch}-${process.versions.modules}`;
  const destDir = path.join(ROOT, 'native-node', tag);
  const dest = path.join(destDir, 'better_sqlite3.node');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Staged Node ABI binary: native-node/${tag}/better_sqlite3.node`);
  return dest;
}

function smokeNativeBinary(nativeBinding, targetArch) {
  if (targetArch !== process.arch) {
    console.log(
      `Skipping load smoke test for cross-compiled ${targetArch} binary on ${process.arch} host.`
    );
    return;
  }

  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3');
  const db = new Database(':memory:', { nativeBinding });
  try {
    const row = db.prepare('SELECT 1 AS value').get();
    if (!row || row.value !== 1) {
      throw new Error('Unexpected SQLite smoke-test result.');
    }
  } finally {
    db.close();
  }
  console.log(`Loaded staged Node binary successfully with ${process.version}.`);
}

function main() {
  if (!fs.existsSync(MODULE_DIR)) {
    throw new Error('better-sqlite3 is not installed. Run install.bat first.');
  }

  const runtime = assertSupportedRuntime();
  const targetArch = getTargetArch();
  console.log(
    `Rebuilding better-sqlite3 for system Node.js ${process.version} ` +
      `(ABI ${runtime.abi}, ${process.platform}-${targetArch})...`
  );

  const buildEnv = {
    ...process.env,
    npm_config_arch: targetArch,
    npm_config_target_arch: targetArch,
  };

  const nodeGyp = resolveNodeGyp();
  if (nodeGyp) {
    console.log(`Using node-gyp: ${nodeGyp}`);
    execFileSync(process.execPath, [nodeGyp, 'rebuild', '--release', `--arch=${targetArch}`], {
      stdio: 'inherit',
      cwd: MODULE_DIR,
      env: buildEnv,
    });
  } else {
    console.log('node-gyp not found; falling back to npm rebuild better-sqlite3');
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npmCommand, ['rebuild', 'better-sqlite3', '--build-from-source'], {
      stdio: 'inherit',
      cwd: ROOT,
      env: buildEnv,
    });
  }

  const nativeBinding = stageNativeNodeBinary(targetArch);
  smokeNativeBinary(nativeBinding, targetArch);
  console.log('System Node rebuild complete.');
}

main();
