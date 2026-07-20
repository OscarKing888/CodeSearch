const fs = require('fs');
const os = require('os');
const path = require('path');
const yauzl = require('yauzl');
const {
  NATIVE_BINARY_NAME,
  expectedElectronTags,
  expectedNodeTags,
} = require('./native-matrix');

const REQUIRED_RUNTIME_ENTRIES = [
  'extension/dist/mcp.js',
  'extension/dist/cli.js',
  'extension/node_modules/better-sqlite3/package.json',
  'extension/node_modules/better-sqlite3/lib/index.js',
  'extension/node_modules/better-sqlite3/lib/database.js',
];

function openZip(vsixPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(vsixPath, { lazyEntries: true }, (error, zip) => {
      if (error) {
        reject(error);
      } else {
        resolve(zip);
      }
    });
  });
}

async function listEntries(vsixPath) {
  const zip = await openZip(vsixPath);
  return new Promise((resolve, reject) => {
    const entries = new Map();
    zip.on('error', reject);
    zip.on('entry', (entry) => {
      entries.set(entry.fileName.replace(/\\/g, '/'), entry.uncompressedSize);
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.readEntry();
  });
}

async function extractEntry(vsixPath, entryName, outputPath) {
  const zip = await openZip(vsixPath);
  return new Promise((resolve, reject) => {
    let found = false;
    const fail = (error) => {
      try {
        zip.close();
      } catch {
        // Ignore close errors while reporting the original extraction failure.
      }
      reject(error);
    };

    zip.on('error', fail);
    zip.on('entry', (entry) => {
      if (entry.fileName.replace(/\\/g, '/') !== entryName) {
        zip.readEntry();
        return;
      }
      found = true;
      zip.openReadStream(entry, (error, stream) => {
        if (error) {
          fail(error);
          return;
        }
        const output = fs.createWriteStream(outputPath);
        stream.on('error', fail);
        output.on('error', fail);
        output.on('close', () => {
          zip.close();
          resolve();
        });
        stream.pipe(output);
      });
    });
    zip.on('end', () => {
      if (!found) {
        reject(new Error(`VSIX entry not found: ${entryName}`));
      }
    });
    zip.readEntry();
  });
}

function expectedVsixEntries() {
  return [
    ...expectedElectronTags().map(
      (tag) => `extension/native/${tag}/${NATIVE_BINARY_NAME}`
    ),
    ...expectedNodeTags().map(
      (tag) => `extension/native-node/${tag}/${NATIVE_BINARY_NAME}`
    ),
  ];
}

function validateEntries(entries) {
  const missing = [];
  const empty = [];
  for (const expected of [...expectedVsixEntries(), ...REQUIRED_RUNTIME_ENTRIES]) {
    if (!entries.has(expected)) {
      missing.push(expected);
    } else if (entries.get(expected) === 0) {
      empty.push(expected);
    }
  }
  if (missing.length > 0 || empty.length > 0) {
    const details = [
      ...missing.map((entry) => `missing: ${entry}`),
      ...empty.map((entry) => `empty: ${entry}`),
    ].join('\n  - ');
    throw new Error(`Invalid required entries in VSIX:\n  - ${details}`);
  }
}

async function smokePackagedNodeBinding(vsixPath, entries, requireSmoke) {
  const tag = `${process.platform}-${process.arch}-${process.versions.modules}`;
  const entryName = `extension/native-node/${tag}/${NATIVE_BINARY_NAME}`;
  if (!entries.has(entryName)) {
    const message =
      `Cannot smoke-test packaged native binding on ${tag}; that runtime is outside the release matrix.`;
    if (requireSmoke) {
      throw new Error(message);
    }
    console.log(`${message} Skipping load test.`);
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-code-search-vsix-native-'));
  const nativeBinding = path.join(tempDir, NATIVE_BINARY_NAME);
  try {
    await extractEntry(vsixPath, entryName, nativeBinding);
    // Use the installed JavaScript wrapper but force it to load the bytes from
    // the VSIX, proving the packaged host ABI binary is usable.
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
    console.log(`Loaded packaged Node native binding ${tag} successfully.`);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows may retain a loaded native library until process exit.
    }
  }
}

async function main() {
  const vsixArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (!vsixArg) {
    throw new Error(
      'Usage: node scripts/validate-vsix-native.js <extension.vsix> [--require-smoke]'
    );
  }
  const vsixPath = path.resolve(vsixArg);
  if (!fs.existsSync(vsixPath)) {
    throw new Error(`VSIX does not exist: ${vsixPath}`);
  }

  const entries = await listEntries(vsixPath);
  validateEntries(entries);
  console.log(
    `Validated ${expectedVsixEntries().length} native binaries and ` +
      `${REQUIRED_RUNTIME_ENTRIES.length} MCP/CLI runtime entries in ${path.basename(vsixPath)}.`
  );
  await smokePackagedNodeBinding(
    vsixPath,
    entries,
    process.argv.includes('--require-smoke')
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
