import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexMeta, IndexRegistryData } from '../index/types';

const EXTENSION_STORAGE_IDS = [
  'oscarking888.ace-code-search',
  'OscarKing888.ace-code-search',
];

export interface DiscoveredRegistry {
  path: string;
  source: string;
}

export interface McpCliOptions {
  registry?: string;
  db?: string;
  extensionRoot?: string;
}

export function parseMcpCliArgs(argv: string[]): McpCliOptions {
  const options: McpCliOptions = {};
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '--registry':
        if (!next) {
          throw new Error('--registry requires a path');
        }
        options.registry = path.resolve(next);
        i++;
        break;
      case '--db':
        if (!next) {
          throw new Error('--db requires a path');
        }
        options.db = path.resolve(next);
        i++;
        break;
      case '--extension-root':
        if (!next) {
          throw new Error('--extension-root requires a path');
        }
        options.extensionRoot = path.resolve(next);
        i++;
        break;
      case '--help':
      case '-h':
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown argument: ${arg}`);
        }
        break;
    }
  }

  return options;
}

export function defaultGlobalStorageCandidates(): DiscoveredRegistry[] {
  const home = os.homedir();
  const candidates: DiscoveredRegistry[] = [];

  const editorRoots: Array<{ source: string; root: string }> = [];

  if (process.platform === 'darwin') {
    editorRoots.push(
      {
        source: 'vscode',
        root: path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
      },
      {
        source: 'cursor',
        root: path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage'),
      }
    );
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    editorRoots.push(
      { source: 'vscode', root: path.join(appData, 'Code', 'User', 'globalStorage') },
      { source: 'cursor', root: path.join(appData, 'Cursor', 'User', 'globalStorage') }
    );
  } else {
    editorRoots.push(
      { source: 'vscode', root: path.join(home, '.config', 'Code', 'User', 'globalStorage') },
      { source: 'cursor', root: path.join(home, '.config', 'Cursor', 'User', 'globalStorage') }
    );
  }

  for (const editor of editorRoots) {
    for (const id of EXTENSION_STORAGE_IDS) {
      candidates.push({
        source: `${editor.source}:${id}`,
        path: path.join(editor.root, id, 'code-search', 'registry.json'),
      });
    }
  }

  return candidates;
}

export async function findExistingRegistries(
  candidates: DiscoveredRegistry[] = defaultGlobalStorageCandidates()
): Promise<DiscoveredRegistry[]> {
  const found: DiscoveredRegistry[] = [];
  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate.path, fs.constants.R_OK);
      found.push(candidate);
    } catch {
      // skip missing
    }
  }
  return found;
}

export async function loadRegistryIndexes(registryPath: string): Promise<IndexMeta[]> {
  const raw = await fs.promises.readFile(registryPath, 'utf8');
  const parsed = JSON.parse(raw) as IndexRegistryData;
  return Array.isArray(parsed.indexes) ? parsed.indexes : [];
}

export async function resolveIndexMetas(options: McpCliOptions): Promise<IndexMeta[]> {
  if (options.db) {
    const dbPath = path.resolve(options.db);
    await fs.promises.access(dbPath, fs.constants.R_OK);
    return [
      {
        id: 'db',
        name: path.basename(path.dirname(dbPath)) || 'Index',
        dbPath,
        rootDirs: [],
        readOnly: true,
        directoryMappings: [],
        workspaceHashes: [],
        createdAt: 0,
        updatedAt: 0,
      },
    ];
  }

  if (options.registry) {
    const registryPath = path.resolve(options.registry);
    await fs.promises.access(registryPath, fs.constants.R_OK);
    return loadRegistryIndexes(registryPath);
  }

  const found = await findExistingRegistries();
  if (found.length === 0) {
    throw new Error(
      'No Ace Code Search registry found. Pass --registry <registry.json> or --db <index.db>, ' +
        'or open a workspace in VS Code/Cursor so an index is created.'
    );
  }

  const byDb = new Map<string, IndexMeta>();
  for (const registry of found) {
    const indexes = await loadRegistryIndexes(registry.path);
    for (const meta of indexes) {
      const key = path.resolve(meta.dbPath).toLowerCase();
      if (!byDb.has(key)) {
        byDb.set(key, meta);
      }
    }
  }

  return Array.from(byDb.values());
}
