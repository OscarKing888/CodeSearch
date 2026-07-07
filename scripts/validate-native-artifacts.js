const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NATIVE_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'native');
const BINARY_NAME = 'better_sqlite3.node';

const REQUIRED_ABIS = ['136', '143', '146'];
const REQUIRED_TARGETS = [
  { platform: 'linux', arch: 'x64' },
  { platform: 'win32', arch: 'x64' },
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
];

function expectedTags() {
  const tags = [];
  for (const target of REQUIRED_TARGETS) {
    for (const abi of REQUIRED_ABIS) {
      tags.push(`${target.platform}-${target.arch}-${abi}`);
    }
  }
  return tags;
}

function main() {
  const missing = [];

  for (const tag of expectedTags()) {
    const binaryPath = path.join(NATIVE_DIR, tag, BINARY_NAME);
    if (!fs.existsSync(binaryPath)) {
      missing.push(path.relative(ROOT, binaryPath));
    }
  }

  if (missing.length > 0) {
    console.error('Missing required better-sqlite3 native binaries:');
    for (const file of missing) {
      console.error(`  - ${file}`);
    }
    process.exit(1);
  }

  console.log(
    `Validated ${REQUIRED_TARGETS.length * REQUIRED_ABIS.length} native binaries in ${path.relative(ROOT, NATIVE_DIR) || '.'}.`
  );
}

main();
