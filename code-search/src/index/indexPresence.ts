import * as fs from 'fs';
import * as path from 'path';
import { IndexRegistry } from './IndexRegistry';
import { IndexMeta } from './types';

export interface WorkspaceIndexPresence {
  exists: boolean;
  dbPath: string;
  meta?: IndexMeta;
}

export async function hasWorkspaceIndex(
  workspaceHash: string,
  expectedDbPath: string,
  registry: IndexRegistry
): Promise<WorkspaceIndexPresence> {
  const registryMeta = registry.getByWorkspaceHash(workspaceHash);
  const dbPath = registryMeta?.dbPath ?? expectedDbPath;

  try {
    await fs.promises.access(dbPath);
    const meta =
      registryMeta ??
      registry.getAll().find((i) => path.resolve(i.dbPath) === path.resolve(dbPath));
    return { exists: true, dbPath, meta };
  } catch {
    return { exists: false, dbPath: expectedDbPath };
  }
}
