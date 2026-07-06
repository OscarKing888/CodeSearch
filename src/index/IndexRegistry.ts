import * as fs from 'fs';
import * as path from 'path';
import { IndexMeta, IndexRegistryData } from './types';

const REGISTRY_VERSION = 1;

export class IndexRegistry {
  private registryPath: string;
  private data: IndexRegistryData = { indexes: [] };

  constructor(storageRoot: string) {
    this.registryPath = path.join(storageRoot, 'registry.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw) as IndexRegistryData;
      if (parsed.indexes) {
        this.data = parsed;
      }
    } catch {
      this.data = { indexes: [] };
    }
  }

  async save(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.registryPath), { recursive: true });
    await fs.promises.writeFile(this.registryPath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  getAll(): IndexMeta[] {
    return [...this.data.indexes];
  }

  getById(id: string): IndexMeta | undefined {
    return this.data.indexes.find((i) => i.id === id);
  }

  getByWorkspaceHash(hash: string): IndexMeta | undefined {
    return this.data.indexes.find((i) => i.workspaceHashes.includes(hash));
  }

  upsert(meta: IndexMeta): void {
    const idx = this.data.indexes.findIndex((i) => i.id === meta.id);
    if (idx >= 0) {
      this.data.indexes[idx] = meta;
    } else {
      this.data.indexes.push(meta);
    }
  }

  remove(id: string): boolean {
    const before = this.data.indexes.length;
    this.data.indexes = this.data.indexes.filter((i) => i.id !== id);
    return this.data.indexes.length < before;
  }

  rename(id: string, name: string): boolean {
    const meta = this.getById(id);
    if (!meta) {
      return false;
    }
    meta.name = name;
    meta.updatedAt = Date.now();
    return true;
  }

  move(id: string, newDbPath: string): boolean {
    const meta = this.getById(id);
    if (!meta) {
      return false;
    }
    meta.dbPath = newDbPath;
    meta.updatedAt = Date.now();
    return true;
  }

  attachWorkspace(id: string, workspaceHash: string): void {
    const meta = this.getById(id);
    if (!meta) {
      return;
    }
    if (!meta.workspaceHashes.includes(workspaceHash)) {
      meta.workspaceHashes.push(workspaceHash);
      meta.updatedAt = Date.now();
    }
  }

  static generateId(): string {
    return `idx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

export function mapFilePath(filePath: string, mappings: Array<{ from: string; to: string }>): string {
  const normalized = filePath.replace(/\\/g, '/');
  for (const { from, to } of mappings) {
    const fromNorm = from.replace(/\\/g, '/');
    if (normalized.toLowerCase().startsWith(fromNorm.toLowerCase())) {
      const suffix = normalized.slice(fromNorm.length);
      return path.join(to.replace(/\\/g, path.sep), suffix.replace(/^\//, '').replace(/\//g, path.sep));
    }
  }
  return filePath;
}
