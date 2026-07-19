import * as fs from 'fs';
import * as path from 'path';
import type BetterSqlite3 from 'better-sqlite3';

type DatabaseConstructor = typeof BetterSqlite3;

let DatabaseCtor: DatabaseConstructor | undefined;
let extensionRoot: string | undefined;

export type SqliteDatabase = BetterSqlite3.Database;
export type SqliteStatement = BetterSqlite3.Statement;

export function configureBetterSqlite3(root: string): void {
  extensionRoot = root;
}

function resolveNativeBinaryPath(root: string): string {
  const abi = process.versions.modules;
  const tag = `${process.platform}-${process.arch}-${abi}`;
  const isElectron = Boolean(process.versions.electron);

  // System Node (CLI / MCP): prefer packaged native-node/, then local npm build.
  if (!isElectron) {
    const nodeBundled = path.join(root, 'native-node', tag, 'better_sqlite3.node');
    if (fs.existsSync(nodeBundled)) {
      return nodeBundled;
    }

    const devBuild = path.join(
      root,
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node'
    );
    if (fs.existsSync(devBuild)) {
      return devBuild;
    }

    const availableNode = listAvailableNativeBinaries(path.join(root, 'native-node'));
    throw new Error(
      `No better_sqlite3 binary for Node ABI ${abi} (${tag}). ` +
        `Available Node builds: ${availableNode.join(', ') || 'none'}. ` +
        'Run `npm run rebuild:node` (or build.sh) so native-node/ is populated, then reinstall the extension.'
    );
  }

  const bundled = path.join(root, 'native', tag, 'better_sqlite3.node');
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  const devBuild = path.join(
    root,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node'
  );
  if (fs.existsSync(devBuild)) {
    return devBuild;
  }

  const available = listAvailableNativeBinaries(path.join(root, 'native'));
  throw new Error(
    `No better_sqlite3 binary for Electron ABI ${abi} (${tag}). ` +
      `Available builds: ${available.join(', ') || 'none'}. ` +
      'This extension package does not include the native binary for this Electron ABI. ' +
      'Install a newer Ace Code Search package that includes this ABI, or rebuild from source with Node.js 20+ using build.bat (or build.sh).'
  );
}

function listAvailableNativeBinaries(nativeDir: string): string[] {
  if (!fs.existsSync(nativeDir)) {
    return [];
  }
  return fs
    .readdirSync(nativeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function getDatabaseConstructor(): DatabaseConstructor {
  if (!DatabaseCtor) {
    // Dynamic require avoids bundling the native module into extension.js.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    DatabaseCtor = require('better-sqlite3') as DatabaseConstructor;
  }
  return DatabaseCtor;
}

export function openDatabase(
  dbPath: string,
  options?: BetterSqlite3.Options
): SqliteDatabase {
  const Database = getDatabaseConstructor();
  const nativeBinding = extensionRoot ? resolveNativeBinaryPath(extensionRoot) : undefined;
  const mergedOptions =
    nativeBinding != null ? { ...options, nativeBinding } : options;
  return new Database(dbPath, mergedOptions);
}
