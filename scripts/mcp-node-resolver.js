'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { NATIVE_BINARY_NAME, NODE_RUNTIMES, nodeRuntimeForMajor } = require('./native-matrix');

function getPlatformPath(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
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
      return undefined;
    }
    return { ...runtime, executable: fs.realpathSync(executable) };
  } catch {
    return undefined;
  }
}

function listPackagedNodeTags(extensionRoot) {
  const nativeNodeDir = path.join(extensionRoot, 'native-node');
  if (!fs.existsSync(nativeNodeDir)) {
    return [];
  }
  const prefix = `${process.platform}-${process.arch}-`;
  return fs
    .readdirSync(nativeNodeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .filter((entry) =>
      fs.existsSync(path.join(nativeNodeDir, entry.name, NATIVE_BINARY_NAME))
    )
    .map((entry) => entry.name);
}

function collectNodeCandidates() {
  const executables = new Map();
  for (const executable of [
    process.env.ACE_CODE_SEARCH_NODE,
    ...findCursorHelperNodes(),
    process.execPath,
    ...commandCandidatesFromPath(process.platform === 'win32' ? ['node.exe', 'node'] : ['node']),
  ].filter(Boolean)) {
    try {
      if (!fs.statSync(executable).isFile()) continue;
    } catch {
      continue;
    }
    executables.set(executablePathKey(executable), executable);
  }
  return Array.from(executables.values());
}

function formatSupportedAbis() {
  return NODE_RUNTIMES.map((runtime) => `${runtime.major} (ABI ${runtime.abi})`).join(', ');
}

/**
 * Pick a Node executable whose ABI matches a packaged native-node/ binary.
 * @param {string} extensionRoot
 * @returns {string} absolute path to a compatible Node executable
 */
function resolveCompatibleMcpNode(extensionRoot) {
  const packagedTags = new Set(listPackagedNodeTags(extensionRoot));
  const currentTag = `${process.platform}-${process.arch}-${process.versions.modules}`;
  if (packagedTags.has(currentTag)) {
    return process.execPath;
  }

  for (const executable of collectNodeCandidates()) {
    const runtime = inspectNodeExecutable(executable);
    if (!runtime) continue;
    if (runtime.platform !== process.platform || runtime.arch !== process.arch) continue;
    const tag = `${runtime.platform}-${runtime.arch}-${runtime.abi}`;
    if (packagedTags.has(tag)) {
      return runtime.executable;
    }
  }

  const available = Array.from(packagedTags).sort().join(', ') || 'none';
  throw new Error(
    `Ace Code Search MCP cannot load better-sqlite3 with Node.js ${process.version} ` +
      `(ABI ${process.versions.modules}, tag ${currentTag}). ` +
      `Packaged Node builds in this extension: ${available}. ` +
      `Install Node.js ${formatSupportedAbis()}, set ACE_CODE_SEARCH_NODE to a compatible ` +
      'Node executable, or rerun Ace Code Search → Install Agent Integration to refresh the MCP launcher.'
  );
}

module.exports = {
  collectNodeCandidates,
  cursorHelperNodePath,
  findCursorHelperNodes,
  inspectNodeExecutable,
  listPackagedNodeTags,
  resolveCompatibleMcpNode,
  executablePathKey,
};
