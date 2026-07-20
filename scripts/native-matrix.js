const NATIVE_BINARY_NAME = 'better_sqlite3.node';

// Keep this release matrix aligned with .github/workflows/release.yml. Node's
// module ABI is stable for a major release, so one build per supported major is
// sufficient even when the PATH `node` command moves to a newer patch release.
const RELEASE_TARGETS = Object.freeze([
  Object.freeze({ platform: 'linux', arch: 'x64' }),
  Object.freeze({ platform: 'win32', arch: 'x64' }),
  Object.freeze({ platform: 'darwin', arch: 'arm64' }),
  Object.freeze({ platform: 'darwin', arch: 'x64' }),
]);

const ELECTRON_ABIS = Object.freeze(['136', '143', '146']);

const NODE_RUNTIMES = Object.freeze([
  Object.freeze({ major: '20', abi: '115' }),
  Object.freeze({ major: '22', abi: '127' }),
  Object.freeze({ major: '24', abi: '137' }),
]);

function makeTag(target, abi) {
  return `${target.platform}-${target.arch}-${abi}`;
}

function expectedElectronTags() {
  return RELEASE_TARGETS.flatMap((target) =>
    ELECTRON_ABIS.map((abi) => makeTag(target, abi))
  );
}

function expectedNodeTags() {
  return RELEASE_TARGETS.flatMap((target) =>
    NODE_RUNTIMES.map(({ abi }) => makeTag(target, abi))
  );
}

function nodeRuntimeForMajor(major) {
  return NODE_RUNTIMES.find((runtime) => runtime.major === String(major));
}

module.exports = {
  ELECTRON_ABIS,
  NATIVE_BINARY_NAME,
  NODE_RUNTIMES,
  RELEASE_TARGETS,
  expectedElectronTags,
  expectedNodeTags,
  makeTag,
  nodeRuntimeForMajor,
};
