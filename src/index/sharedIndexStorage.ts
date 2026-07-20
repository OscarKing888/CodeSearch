import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

export const SHARED_INDEX_ROOT_NAME = 'AceCodeSearch';

export interface SharedIndexStorageOptions {
  platform?: NodeJS.Platform;
  env?: Readonly<NodeJS.ProcessEnv>;
  homeDir?: string;
}

function getPlatformPath(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function nonEmptyEnvironmentPath(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

/**
 * Returns the IDE-independent storage root used by Ace Code Search.
 *
 * The optional process values make platform path selection deterministic in
 * tests and keep this module independent of VS Code/Cursor storage locations.
 */
export function getSharedIndexRoot(
  options: SharedIndexStorageOptions = {}
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const platformPath = getPlatformPath(platform);

  if (platform === 'win32') {
    const localAppData =
      nonEmptyEnvironmentPath(env.LOCALAPPDATA) ??
      platformPath.join(homeDir, 'AppData', 'Local');
    return platformPath.join(localAppData, SHARED_INDEX_ROOT_NAME);
  }

  if (platform === 'darwin') {
    return platformPath.join(
      homeDir,
      'Library',
      'Application Support',
      SHARED_INDEX_ROOT_NAME
    );
  }

  const dataHome =
    nonEmptyEnvironmentPath(env.XDG_DATA_HOME) ??
    platformPath.join(homeDir, '.local', 'share');
  return platformPath.join(dataHome, SHARED_INDEX_ROOT_NAME);
}

/** Returns `<shared root>/indexes/<workspaceHash>/index.db`. */
export function getSharedWorkspaceDbPath(
  workspaceHash: string,
  options: SharedIndexStorageOptions = {}
): string {
  const platform = options.platform ?? process.platform;
  return getPlatformPath(platform).join(
    getSharedIndexRoot(options),
    'indexes',
    workspaceHash,
    'index.db'
  );
}

/** Stable, collision-resistant identity for an unordered set of workspace roots. */
export function getSharedWorkspaceKey(
  workspaceRoots: readonly string[],
  platform: NodeJS.Platform = process.platform
): string {
  const canonicalRoots = workspaceRoots
    .map((root) => canonicalPathKey(root, platform))
    .sort();
  return crypto
    .createHash('sha256')
    .update(canonicalRoots.join('\0'))
    .digest('hex')
    .slice(0, 24);
}

/**
 * Produces a stable comparison key for a filesystem path. Windows paths are
 * case-folded; paths on every other platform retain their original case.
 */
export function canonicalPathKey(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  const resolved = getPlatformPath(platform).resolve(value);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return canonicalPathKey(left, platform) === canonicalPathKey(right, platform);
}
