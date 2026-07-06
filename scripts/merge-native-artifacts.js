const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NATIVE_OUT = path.join(ROOT, 'native');
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(ROOT, '..', 'artifacts');
const BINARY_NAME = 'better_sqlite3.node';

function findNativeBinaries(dir, results = []) {
  if (!fs.existsSync(dir)) {
    return results;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const candidate = path.join(fullPath, BINARY_NAME);
      if (fs.existsSync(candidate)) {
        results.push({ tag: entry.name, file: candidate });
      } else {
        findNativeBinaries(fullPath, results);
      }
    }
  }
  return results;
}

function main() {
  const binaries = findNativeBinaries(ARTIFACTS_DIR);
  if (binaries.length === 0) {
    console.error(`No ${BINARY_NAME} files found under ${ARTIFACTS_DIR}`);
    process.exit(1);
  }

  fs.mkdirSync(NATIVE_OUT, { recursive: true });
  const copied = new Set();

  for (const { tag, file } of binaries) {
    if (copied.has(tag)) {
      console.log(`Skipping duplicate tag ${tag}`);
      continue;
    }

    const destDir = path.join(NATIVE_OUT, tag);
    const dest = path.join(destDir, BINARY_NAME);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(file, dest);
    copied.add(tag);
    console.log(`Merged ${tag}/${BINARY_NAME}`);
  }

  console.log(`Merged ${copied.size} native binaries into native/`);
}

main();
