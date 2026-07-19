const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

function stageNativeNodeBinary() {
  const src = path.join(MODULE_DIR, 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(src)) {
    throw new Error(`Expected Node better_sqlite3 binary missing: ${src}`);
  }

  const tag = `${process.platform}-${process.arch}-${process.versions.modules}`;
  const destDir = path.join(ROOT, 'native-node', tag);
  const dest = path.join(destDir, 'better_sqlite3.node');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Staged Node ABI binary: native-node/${tag}/better_sqlite3.node`);
}

function main() {
  if (!fs.existsSync(MODULE_DIR)) {
    throw new Error('better-sqlite3 is not installed. Run install.bat first.');
  }

  console.log(`Rebuilding better-sqlite3 for system Node.js ${process.version}...`);

  const nodeGyp = resolveNodeGyp();
  if (nodeGyp) {
    console.log(`Using node-gyp: ${nodeGyp}`);
    execSync(`node "${nodeGyp}" rebuild --release`, {
      stdio: 'inherit',
      cwd: MODULE_DIR,
      env: process.env,
    });
  } else {
    console.log('node-gyp not found; falling back to npm rebuild better-sqlite3');
    execSync('npm rebuild better-sqlite3', {
      stdio: 'inherit',
      cwd: ROOT,
      env: process.env,
    });
  }

  stageNativeNodeBinary();
  console.log('System Node rebuild complete.');
}

main();
