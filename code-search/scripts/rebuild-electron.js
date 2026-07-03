const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NATIVE_DIR = path.join(ROOT, 'native');
const SQLITE_NODE = path.join(
  ROOT,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
);

const ELECTRON_BY_VSCODE = {
  '1.106': '37.7.0',
  '1.105': '37.6.0',
  '1.104': '37.3.1',
  '1.103': '37.2.3',
  '1.102': '35.6.0',
  '1.101': '35.5.1',
  '1.100': '34.5.8',
  '1.99': '34.3.2',
  '1.98': '34.2.0',
  '1.97': '32.2.7',
  '1.96': '32.2.6',
  '1.95': '32.2.1',
  '1.94': '30.5.1',
  '1.93': '30.4.0',
  '1.92': '30.1.2',
  '1.91': '30.1.0',
  '1.90': '29.4.0',
  '1.89': '28.2.10',
  '1.88': '28.2.8',
  '1.87': '27.2.3',
  '1.86': '27.2.3',
  '1.85': '27.2.3',
};

// Cursor ships a newer Electron than the matching VS Code base version.
const CURSOR_ELECTRON_BY_VERSION = {
  '3.9': '40.0.0',
  '3.8': '39.0.0',
  '3.7': '38.0.0',
};

const FALLBACK_ELECTRON = {
  vscode: '37.7.0',
  cursor: '40.0.0',
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeVersion(value) {
  return String(value).replace(/^[\^~>=<]*/, '').trim();
}

function electronFromVscodeVersion(version) {
  const majorMinor = String(version).match(/^(\d+\.\d+)/)?.[1];
  return majorMinor ? ELECTRON_BY_VSCODE[majorMinor] : undefined;
}

function electronFromCursorVersion(version) {
  const majorMinor = String(version).match(/^(\d+\.\d+)/)?.[1];
  return majorMinor ? CURSOR_ELECTRON_BY_VERSION[majorMinor] : undefined;
}

function editorPackageCandidates(target) {
  const home = os.homedir();
  const candidates = [];

  if (!target || target === 'vscode') {
    if (process.platform === 'win32') {
      candidates.push(
        path.join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'resources', 'app', 'package.json'),
        'C:\\Program Files\\Microsoft VS Code\\resources\\app\\package.json'
      );
    } else if (process.platform === 'darwin') {
      candidates.push('/Applications/Visual Studio Code.app/Contents/Resources/app/package.json');
    } else {
      candidates.push('/usr/share/code/resources/app/package.json');
    }
  }

  if (!target || target === 'cursor') {
    if (process.platform === 'win32') {
      candidates.push(
        'C:\\Program Files\\cursor\\resources\\app\\package.json',
        path.join(home, 'AppData', 'Local', 'Programs', 'cursor', 'resources', 'app', 'package.json')
      );
    } else if (process.platform === 'darwin') {
      candidates.push('/Applications/Cursor.app/Contents/Resources/app/package.json');
    }
  }

  return candidates;
}

function resolveElectronVersion(target = 'vscode') {
  for (const pkgPath of editorPackageCandidates(target)) {
    if (!fs.existsSync(pkgPath)) {
      continue;
    }

    const pkg = readJson(pkgPath);
    const electron = pkg.devDependencies?.electron || pkg.dependencies?.electron;
    if (electron) {
      const version = normalizeVersion(electron);
      console.log(`Detected Electron ${version} from ${pkgPath}`);
      return version;
    }

    const productPath = path.join(path.dirname(pkgPath), 'product.json');
    if (fs.existsSync(productPath)) {
      const product = readJson(productPath);
      if (target === 'cursor') {
        const mapped = electronFromCursorVersion(product.version);
        if (mapped) {
          console.log(`Mapped Cursor ${product.version} -> Electron ${mapped}`);
          return mapped;
        }
      }

      const vscodeVersion = product.vscodeVersion || product.version;
      const mapped = electronFromVscodeVersion(vscodeVersion);
      if (mapped) {
        console.log(`Mapped ${pkg.name || target} vscode ${vscodeVersion} -> Electron ${mapped}`);
        return mapped;
      }
    }
  }

  const fallback = FALLBACK_ELECTRON[target] || FALLBACK_ELECTRON.vscode;
  console.log(`Editor Electron not detected for ${target}, using fallback ${fallback}`);
  return fallback;
}

function getAbi(electronVersion) {
  const nodeAbi = require('node-abi');
  return nodeAbi.getAbi(electronVersion, 'electron');
}

function rebuildForElectron(electronVersion) {
  console.log(`Rebuilding better-sqlite3 for Electron ${electronVersion}...`);
  execSync(
    `npx --yes @electron/rebuild --version=${electronVersion} --module-dir . -w better-sqlite3 -f`,
    { stdio: 'inherit', cwd: ROOT, env: process.env }
  );
}

function saveNativeBinary(electronVersion, label) {
  if (!fs.existsSync(SQLITE_NODE)) {
    throw new Error(`Expected native module at ${SQLITE_NODE}`);
  }

  const abi = getAbi(electronVersion);
  const tag = `${process.platform}-${process.arch}-${abi}`;
  const destDir = path.join(NATIVE_DIR, tag);
  const dest = path.join(destDir, 'better_sqlite3.node');

  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(SQLITE_NODE, dest);
  console.log(`Saved ${label} binary -> native/${tag}/better_sqlite3.node (ABI ${abi})`);
}

function resolveTargets(target) {
  if (target === 'all') {
    return [
      { label: 'vscode', electronVersion: resolveElectronVersion('vscode') },
      { label: 'cursor', electronVersion: resolveElectronVersion('cursor') },
    ];
  }

  return [{ label: target, electronVersion: resolveElectronVersion(target) }];
}

function main() {
  const target = process.argv[2] || 'all';
  const targets = resolveTargets(target);
  const built = new Map();

  for (const entry of targets) {
    if (built.has(entry.electronVersion)) {
      console.log(
        `Skipping duplicate Electron ${entry.electronVersion} for ${entry.label} (already built).`
      );
      continue;
    }
    built.set(entry.electronVersion, entry.label);
    rebuildForElectron(entry.electronVersion);
    saveNativeBinary(entry.electronVersion, entry.label);
  }

  console.log('Electron rebuild complete.');
}

main();
