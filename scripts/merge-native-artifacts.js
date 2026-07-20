const fs = require('fs');
const path = require('path');
const {
  ELECTRON_ABIS,
  NATIVE_BINARY_NAME,
  nodeRuntimeForMajor,
} = require('./native-matrix');

const ROOT = path.join(__dirname, '..');
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(ROOT, '..', 'artifacts');
const OUTPUT_ROOT = process.env.NATIVE_OUTPUT_ROOT
  ? path.resolve(process.env.NATIVE_OUTPUT_ROOT)
  : ROOT;

const ARTIFACT_PATTERNS = [
  {
    kind: 'electron',
    pattern: /^electron-native-(linux|win32|darwin)-(x64|arm64)$/,
    outputDir: path.join(OUTPUT_ROOT, 'native'),
  },
  {
    kind: 'node',
    pattern: /^node-native-(linux|win32|darwin)-(x64|arm64)-node(20|22|24)$/,
    outputDir: path.join(OUTPUT_ROOT, 'native-node'),
  },
];

function findNativeBinaries(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(fullPath, NATIVE_BINARY_NAME);
    if (fs.existsSync(candidate)) {
      results.push({ tag: entry.name, file: candidate });
    } else {
      findNativeBinaries(fullPath, results);
    }
  }
  return results;
}

function parseTag(tag) {
  const match = /^(linux|win32|darwin)-(x64|arm64)-(\d+)$/.exec(tag);
  if (!match) {
    throw new Error(`Invalid native binary tag: ${tag}`);
  }
  return { platform: match[1], arch: match[2], abi: match[3] };
}

function classifyArtifact(name) {
  for (const definition of ARTIFACT_PATTERNS) {
    const match = definition.pattern.exec(name);
    if (match) {
      return {
        ...definition,
        platform: match[1],
        arch: match[2],
        nodeMajor: match[3],
      };
    }
  }
  return undefined;
}

function validateArtifactBinary(artifact, tag) {
  const parsed = parseTag(tag);
  if (parsed.platform !== artifact.platform || parsed.arch !== artifact.arch) {
    throw new Error(
      `Artifact ${artifact.name} contains mismatched target ${tag}.`
    );
  }

  if (artifact.kind === 'electron' && !ELECTRON_ABIS.includes(parsed.abi)) {
    throw new Error(
      `Electron artifact ${artifact.name} contains non-release ABI ${parsed.abi}.`
    );
  }

  if (artifact.kind === 'node') {
    const runtime = nodeRuntimeForMajor(artifact.nodeMajor);
    if (!runtime || parsed.abi !== runtime.abi) {
      throw new Error(
        `Node artifact ${artifact.name} contains ABI ${parsed.abi}; expected ${runtime?.abi ?? 'unknown'}.`
      );
    }
  }
}

function main() {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    throw new Error(`Artifacts directory does not exist: ${ARTIFACTS_DIR}`);
  }

  const copiedByKind = new Map([
    ['electron', new Set()],
    ['node', new Set()],
  ]);
  let artifactCount = 0;

  for (const entry of fs.readdirSync(ARTIFACTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const definition = classifyArtifact(entry.name);
    if (!definition) {
      continue;
    }

    artifactCount++;
    const artifact = { ...definition, name: entry.name };
    const binaries = findNativeBinaries(path.join(ARTIFACTS_DIR, entry.name));
    if (binaries.length === 0) {
      throw new Error(`Artifact ${entry.name} contains no ${NATIVE_BINARY_NAME}.`);
    }

    for (const { tag, file } of binaries) {
      validateArtifactBinary(artifact, tag);
      const copied = copiedByKind.get(artifact.kind);
      if (copied.has(tag)) {
        throw new Error(`Duplicate ${artifact.kind} native binary tag: ${tag}`);
      }

      const destDir = path.join(artifact.outputDir, tag);
      const dest = path.join(destDir, NATIVE_BINARY_NAME);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(file, dest);
      copied.add(tag);
      console.log(
        `Merged ${entry.name}/${tag} -> ${path.basename(artifact.outputDir)}/${tag}/${NATIVE_BINARY_NAME}`
      );
    }
  }

  if (artifactCount === 0) {
    throw new Error(`No typed native artifacts found under ${ARTIFACTS_DIR}.`);
  }

  const electronCount = copiedByKind.get('electron').size;
  const nodeCount = copiedByKind.get('node').size;
  if (electronCount === 0 || nodeCount === 0) {
    throw new Error(
      `Incomplete native artifact set: merged ${electronCount} Electron and ${nodeCount} Node binaries.`
    );
  }
  console.log(
    `Merged ${electronCount} Electron binaries into native/ and ${nodeCount} Node binaries into native-node/.`
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
