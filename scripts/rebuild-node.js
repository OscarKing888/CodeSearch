const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { NODE_RUNTIMES, nodeRuntimeForMajor } = require('./native-matrix');

const ROOT = path.join(__dirname, '..');
const MODULE_DIR = path.join(ROOT, 'node_modules', 'better-sqlite3');

function getPlatformPath(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function cursorHelperNodePath(cursorCliPath, platform = process.platform) {
  const platformPath = getPlatformPath(platform);
  return platformPath.resolve(
    platformPath.dirname(cursorCliPath),
    '..',
    'resources',
    'helpers',
    platform === 'win32' ? 'node.exe' : 'node'
  );
}

function executablePathKey(value) {
  let resolved;
  try {
    resolved = fs.realpathSync(value);
  } catch {
    resolved = path.resolve(value);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function commandCandidatesFromPath(names) {
  const value = process.env.PATH || process.env.Path || '';
  const candidates = [];
  for (const directory of value.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      candidates.push(path.join(directory, name));
    }
  }
  return candidates;
}

function cursorCliCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = commandCandidatesFromPath(
    process.platform === 'win32' ? ['cursor.cmd', 'cursor.exe', 'cursor'] : ['cursor']
  );
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(
      path.join(programFiles, 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'),
      path.join(localAppData, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd')
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Cursor.app/Contents/Resources/app/bin/cursor');
  } else {
    candidates.push(
      '/usr/share/cursor/resources/app/bin/cursor',
      '/opt/Cursor/resources/app/bin/cursor'
    );
  }
  return candidates;
}

function findCursorHelperNodes() {
  const nodes = new Map();
  for (const candidate of cursorCliCandidates()) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const realCli = fs.realpathSync(candidate);
      const helper = cursorHelperNodePath(realCli);
      if (!fs.statSync(helper).isFile()) continue;
      const realHelper = fs.realpathSync(helper);
      nodes.set(executablePathKey(realHelper), realHelper);
    } catch {
      // Missing/broken CLI candidates are expected on machines without Cursor.
    }
  }
  return Array.from(nodes.values());
}

function inspectNodeExecutable(executable) {
  try {
    const output = execFileSync(
      executable,
      [
        '-p',
        "JSON.stringify({version:process.version,major:process.versions.node.split('.')[0],abi:process.versions.modules,platform:process.platform,arch:process.arch})",
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
    const runtime = JSON.parse(output);
    const expected = nodeRuntimeForMajor(runtime.major);
    if (!expected || expected.abi !== runtime.abi) {
      console.warn(
        `Ignoring unsupported detected Node runtime ${runtime.version} ABI ${runtime.abi}: ${executable}`
      );
      return undefined;
    }
    return { ...runtime, executable: fs.realpathSync(executable) };
  } catch (error) {
    console.warn(
      `Could not inspect detected Node executable ${executable}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}

function discoverLocalNodeRuntimes(targetArch) {
  const executables = new Map();
  for (const executable of [
    process.execPath,
    process.env.ACE_CODE_SEARCH_NODE,
    ...findCursorHelperNodes(),
  ].filter(Boolean)) {
    executables.set(executablePathKey(executable), executable);
  }

  const runtimes = new Map();
  for (const executable of executables.values()) {
    const runtime = inspectNodeExecutable(executable);
    if (!runtime) continue;
    if (runtime.platform !== process.platform || runtime.arch !== targetArch) {
      console.warn(
        `Ignoring detected ${runtime.platform}-${runtime.arch} Node ${runtime.version}; ` +
          `this build targets ${process.platform}-${targetArch}: ${runtime.executable}`
      );
      continue;
    }
    const tag = `${runtime.platform}-${runtime.arch}-${runtime.abi}`;
    if (!runtimes.has(tag)) runtimes.set(tag, runtime);
  }
  return Array.from(runtimes.values());
}

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

function rebuildCurrentRuntime() {
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

function rebuildDetectedRuntimes() {
  const targetArch = getTargetArch();
  const currentExecutableKey = executablePathKey(process.execPath);
  const runtimes = discoverLocalNodeRuntimes(targetArch).sort((left, right) => {
    const leftCurrent = executablePathKey(left.executable) === currentExecutableKey;
    const rightCurrent = executablePathKey(right.executable) === currentExecutableKey;
    return Number(leftCurrent) - Number(rightCurrent);
  });
  if (runtimes.length === 0) {
    throw new Error('No supported local Node.js 20/22/24 runtime was detected.');
  }

  console.log(
    `Detected local Node ABI set: ${runtimes
      .map((runtime) => `${runtime.abi} (${runtime.version})`)
      .join(', ')}`
  );
  for (const runtime of runtimes) {
    if (executablePathKey(runtime.executable) === currentExecutableKey) {
      rebuildCurrentRuntime();
      continue;
    }
    console.log(
      `Rebuilding through detected Node ${runtime.version} ABI ${runtime.abi}: ${runtime.executable}`
    );
    execFileSync(runtime.executable, [__filename, '--single'], {
      stdio: 'inherit',
      cwd: ROOT,
      env: process.env,
    });
  }

  const staged = runtimes.map(
    (runtime) => `${runtime.platform}-${runtime.arch}-${runtime.abi}`
  );
  console.log(`Detected Node runtime rebuild complete: ${staged.join(', ')}`);
  const missingReleaseAbis = NODE_RUNTIMES
    .map((runtime) => runtime.abi)
    .filter((abi) => !runtimes.some((runtime) => runtime.abi === abi));
  if (missingReleaseAbis.length > 0) {
    console.log(
      `Local package note: ABI ${missingReleaseAbis.join(', ')} was not detected on this machine; ` +
        'the release workflow still supplies the complete Node 20/22/24 matrix.'
    );
  }
}

function main() {
  if (process.argv.includes('--all-detected')) {
    rebuildDetectedRuntimes();
  } else {
    rebuildCurrentRuntime();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  cursorHelperNodePath,
  discoverLocalNodeRuntimes,
};
