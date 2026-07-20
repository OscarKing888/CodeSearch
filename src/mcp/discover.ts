import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
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
  workspaceRoots?: string[];
  allIndexes?: boolean;
  /** Test/integration override for automatic editor-registry discovery. */
  registryCandidates?: DiscoveredRegistry[];
}

export interface IndexDiscoveryResult {
  metas: IndexMeta[];
  warnings: string[];
  workspaceRoots: string[];
}

export function pathComparisonKey(
  filePath: string,
  platform: NodeJS.Platform = process.platform
): string {
  let normalized = filePath.replace(/\\/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/') && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function resolvedPathKey(filePath: string): string {
  return pathComparisonKey(path.resolve(filePath));
}

function isPathInside(candidate: string, container: string): boolean {
  const candidateKey = resolvedPathKey(candidate);
  const containerKey = resolvedPathKey(container);
  const prefix = containerKey.endsWith('/') ? containerKey : `${containerKey}/`;
  return candidateKey === containerKey || candidateKey.startsWith(prefix);
}

function mapOutputRoot(root: string, meta: IndexMeta): string {
  const normalized = root.replace(/\\/g, '/');
  for (const mapping of meta.directoryMappings ?? []) {
    let source = mapping.from.replace(/\\/g, '/');
    if (source.length > 1 && source.endsWith('/') && !/^[A-Za-z]:\/$/.test(source)) {
      source = source.slice(0, -1);
    }
    const rootKey = pathComparisonKey(normalized);
    const sourceKey = pathComparisonKey(source);
    const sourcePrefix = sourceKey.endsWith('/') ? sourceKey : `${sourceKey}/`;
    if (rootKey !== sourceKey && !rootKey.startsWith(sourcePrefix)) {
      continue;
    }
    const suffix = normalized.slice(source.length).replace(/^\//, '');
    return suffix ? path.join(mapping.to, suffix) : mapping.to;
  }
  return root;
}

function isMetaInWorkspace(meta: IndexMeta, workspaceRoots: readonly string[]): boolean {
  const outputRoots = meta.rootDirs
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
    .map((root) => mapOutputRoot(root, meta));
  // An empty/parent/multi-root snapshot cannot be proven safe. Every path the
  // index can return must be contained by one of the client workspace roots.
  return (
    outputRoots.length > 0 &&
    outputRoots.every((indexRoot) =>
      workspaceRoots.some((workspaceRoot) => isPathInside(indexRoot, workspaceRoot))
    )
  );
}

function normalizeWorkspaceRoots(options: McpCliOptions): string[] {
  const configured = options.workspaceRoots?.filter(Boolean) ?? [];
  const roots = configured.length > 0 ? configured : [process.cwd()];
  const unique = new Map<string, string>();
  for (const root of roots) {
    const resolved = path.resolve(root);
    unique.set(resolvedPathKey(resolved), resolved);
  }
  return Array.from(unique.values());
}

function filterToWorkspaceScope(
  metas: IndexMeta[],
  workspaceRoots: string[],
  allIndexes: boolean,
  warnings: string[]
): IndexMeta[] {
  if (allIndexes) {
    return dedupeMetas(metas);
  }
  const groups = new Map<string, IndexMeta[]>();
  for (const meta of metas) {
    const key = resolvedPathKey(meta.dbPath);
    groups.set(key, [...(groups.get(key) ?? []), meta]);
  }
  const included: IndexMeta[] = [];
  let excludedCount = 0;
  for (const group of groups.values()) {
    // Conflicting duplicate metadata is also fail-closed: every registry view
    // of the physical database must prove that all output roots are in scope.
    if (group.every((meta) => isMetaInWorkspace(meta, workspaceRoots))) {
      included.push(group[0]);
    } else {
      excludedCount++;
    }
  }
  if (excludedCount > 0) {
    warnings.push(
      `${excludedCount} index(es) were excluded because they are outside the workspace scope. ` +
        'Pass --all-indexes only when cross-workspace access is intended.'
    );
  }
  return included;
}

export function fileUriToWorkspacePath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') {
      return undefined;
    }
    return path.resolve(fileURLToPath(parsed));
  } catch {
    return undefined;
  }
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
      case '--workspace-root':
        if (!next) {
          throw new Error('--workspace-root requires a path');
        }
        options.workspaceRoots = [...(options.workspaceRoots ?? []), path.resolve(next)];
        i++;
        break;
      case '--all-indexes':
        options.allIndexes = true;
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
      // Missing automatic candidates are expected.
    }
  }
  return found;
}

export async function loadRegistryIndexes(registryPath: string): Promise<IndexMeta[]> {
  const raw = await fs.promises.readFile(registryPath, 'utf8');
  const parsed = JSON.parse(raw) as IndexRegistryData;
  return Array.isArray(parsed.indexes) ? parsed.indexes : [];
}

function validateMeta(meta: IndexMeta, source: string): IndexMeta {
  if (!meta || typeof meta !== 'object' || typeof meta.dbPath !== 'string' || !meta.dbPath) {
    throw new Error(`Invalid index entry in ${source}: dbPath is required`);
  }
  if (typeof meta.id !== 'string' || !meta.id) {
    throw new Error(`Invalid index entry in ${source}: id is required`);
  }
  return {
    ...meta,
    name: typeof meta.name === 'string' && meta.name ? meta.name : meta.id,
    dbPath: path.resolve(meta.dbPath),
    rootDirs: Array.isArray(meta.rootDirs)
      ? meta.rootDirs.filter((root): root is string => typeof root === 'string')
      : [],
    readOnly: true,
    directoryMappings: Array.isArray(meta.directoryMappings)
      ? meta.directoryMappings.filter(
          (mapping) =>
            mapping && typeof mapping.from === 'string' && typeof mapping.to === 'string'
        )
      : [],
    workspaceHashes: Array.isArray(meta.workspaceHashes) ? meta.workspaceHashes : [],
    createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : 0,
    updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : 0,
  };
}

function dedupeMetas(metas: IndexMeta[]): IndexMeta[] {
  const byDb = new Map<string, IndexMeta>();
  for (const meta of metas) {
    const key = resolvedPathKey(meta.dbPath);
    if (!byDb.has(key)) {
      byDb.set(key, meta);
    }
  }
  return Array.from(byDb.values());
}

export async function discoverIndexMetas(options: McpCliOptions): Promise<IndexDiscoveryResult> {
  const warnings: string[] = [];
  const workspaceRoots = normalizeWorkspaceRoots(options);

  if (options.db) {
    const dbPath = path.resolve(options.db);
    await fs.promises.access(dbPath, fs.constants.R_OK);
    return {
      metas: [
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
      ],
      warnings,
      workspaceRoots,
    };
  }

  if (options.registry) {
    const registryPath = path.resolve(options.registry);
    await fs.promises.access(registryPath, fs.constants.R_OK);
    const loaded = await loadRegistryIndexes(registryPath);
    const metas = loaded.map((meta) => validateMeta(meta, registryPath));
    const scoped = filterToWorkspaceScope(
      metas,
      workspaceRoots,
      options.allIndexes === true,
      warnings
    );
    if (scoped.length === 0) {
      warnings.push('The registry contains no index usable in the current workspace scope.');
    }
    return {
      metas: scoped,
      warnings,
      workspaceRoots,
    };
  }

  const found = await findExistingRegistries(
    options.registryCandidates ?? defaultGlobalStorageCandidates()
  );
  if (found.length === 0) {
    warnings.push(
      'No Ace Code Search registry was found. Open/index this workspace in VS Code or Cursor, ' +
        'or pass --db/--registry explicitly.'
    );
    return { metas: [], warnings, workspaceRoots };
  }

  const metas: IndexMeta[] = [];
  for (const registry of found) {
    let loaded: IndexMeta[];
    try {
      loaded = await loadRegistryIndexes(registry.path);
    } catch (error) {
      warnings.push(
        `Skipped unreadable ${registry.source} registry: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      continue;
    }
    for (const rawMeta of loaded) {
      try {
        metas.push(validateMeta(rawMeta, registry.path));
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const scoped = filterToWorkspaceScope(
    metas,
    workspaceRoots,
    options.allIndexes === true,
    warnings
  );
  if (scoped.length === 0) {
    warnings.push('No discovered index is usable in the current workspace scope.');
  }
  return {
    metas: scoped,
    warnings,
    workspaceRoots,
  };
}

export async function resolveIndexMetas(options: McpCliOptions): Promise<IndexMeta[]> {
  return (await discoverIndexMetas(options)).metas;
}
