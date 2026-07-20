const fs = require('fs');
const path = require('path');
const {
  NATIVE_BINARY_NAME,
  expectedElectronTags,
  expectedNodeTags,
} = require('./native-matrix');

const ROOT = path.join(__dirname, '..');

function resolveDirectories(argv) {
  const rootArg = argv[2] ? path.resolve(argv[2]) : ROOT;
  if (path.basename(rootArg) === 'native') {
    return {
      nativeDir: rootArg,
      nativeNodeDir: path.join(path.dirname(rootArg), 'native-node'),
    };
  }
  return {
    nativeDir: path.join(rootArg, 'native'),
    nativeNodeDir: path.join(rootArg, 'native-node'),
  };
}

function validateDirectory(dir, tags, label) {
  const missing = [];
  const empty = [];
  for (const tag of tags) {
    const binaryPath = path.join(dir, tag, NATIVE_BINARY_NAME);
    if (!fs.existsSync(binaryPath)) {
      missing.push(binaryPath);
      continue;
    }
    if (fs.statSync(binaryPath).size === 0) {
      empty.push(binaryPath);
    }
  }
  return { label, dir, expected: tags.length, missing, empty };
}

function validateNativeArtifacts(rootOrNativeDir) {
  const argv = ['node', 'validate-native-artifacts.js'];
  if (rootOrNativeDir) {
    argv.push(rootOrNativeDir);
  }
  const { nativeDir, nativeNodeDir } = resolveDirectories(argv);
  const results = [
    validateDirectory(nativeDir, expectedElectronTags(), 'Electron'),
    validateDirectory(nativeNodeDir, expectedNodeTags(), 'Node'),
  ];
  const failures = results.flatMap((result) => [
    ...result.missing.map((file) => ({ kind: 'missing', label: result.label, file })),
    ...result.empty.map((file) => ({ kind: 'empty', label: result.label, file })),
  ]);
  return { results, failures };
}

function main() {
  const rootArg = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;
  const validation = validateNativeArtifacts(rootArg);
  if (validation.failures.length > 0) {
    console.error('Invalid required better-sqlite3 native matrix:');
    for (const failure of validation.failures) {
      console.error(
        `  - [${failure.label}] ${failure.kind}: ${path.relative(ROOT, failure.file)}`
      );
    }
    process.exit(1);
  }

  for (const result of validation.results) {
    console.log(
      `Validated ${result.expected} ${result.label} binaries in ${path.relative(ROOT, result.dir) || '.'}.`
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = { validateNativeArtifacts };
