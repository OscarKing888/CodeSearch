import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { getIndexingSettings } from '../indexingSettings';
import { FileRecord, IndexProgress, IndexStatus } from '../types';
import { extractTokens, readFileForIndex, shouldIndexFile, walkDirectory } from './FileScanner';
import { FileWatcher } from './FileWatcher';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  ext TEXT,
  dir TEXT,
  content TEXT NOT NULL DEFAULT ''
);
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  path UNINDEXED,
  content,
  tokenize='unicode61 remove_diacritics 0'
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  freq INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;
const BATCH_SIZE = 100;

export class IndexService extends EventEmitter {
  private db: Database.Database | undefined;
  private dbPath: string;
  private rootDirs: string[] = [];
  private readonly readOnly: boolean;
  readonly id: string;
  private _name: string;

  private watcher = new FileWatcher();
  private paused = false;
  private indexing = false;
  private status: IndexStatus = 'idle';
  private queued = 0;
  private indexed = 0;
  private total = 0;

  private insertFileStmt: Database.Statement | undefined;
  private updateFileStmt: Database.Statement | undefined;
  private deleteFileStmt: Database.Statement | undefined;
  private deleteFtsStmt: Database.Statement | undefined;
  private insertFtsStmt: Database.Statement | undefined;
  private getFileMtimeStmt: Database.Statement | undefined;
  private upsertTokenStmt: Database.Statement | undefined;

  constructor(dbPath: string, options?: { readOnly?: boolean; id?: string; name?: string }) {
    super();
    this.dbPath = dbPath;
    this.readOnly = options?.readOnly ?? false;
    this.id = options?.id ?? 'primary';
    this._name = options?.name ?? 'Primary';
  }

  get name(): string {
    return this._name;
  }

  setName(name: string): void {
    this._name = name;
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getRootDirs(): string[] {
    return [...this.rootDirs];
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  async initialize(rootDirs: string[]): Promise<void> {
    this.rootDirs = rootDirs;
    const dir = path.dirname(this.dbPath);
    await fs.promises.mkdir(dir, { recursive: true });

    this.db = new Database(this.dbPath, { readonly: this.readOnly });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.prepareStatements();
  }

  private prepareStatements(): void {
    if (!this.db) {
      return;
    }
    this.insertFileStmt = this.db.prepare(`
      INSERT INTO files (path, mtime, size, ext, dir, content)
      VALUES (@path, @mtime, @size, @ext, @dir, @content)
    `);
    this.updateFileStmt = this.db.prepare(`
      UPDATE files SET mtime=@mtime, size=@size, ext=@ext, dir=@dir, content=@content
      WHERE path=@path
    `);
    this.deleteFileStmt = this.db.prepare(`DELETE FROM files WHERE path = ?`);
    this.deleteFtsStmt = this.db.prepare(`DELETE FROM files_fts WHERE path = ?`);
    this.insertFtsStmt = this.db.prepare(`
      INSERT INTO files_fts (path, content) VALUES (@path, @content)
    `);
    this.getFileMtimeStmt = this.db.prepare(`SELECT mtime FROM files WHERE path = ?`);
    this.upsertTokenStmt = this.db.prepare(`
      INSERT INTO tokens (token, freq) VALUES (?, 1)
      ON CONFLICT(token) DO UPDATE SET freq = freq + 1
    `);
  }

  getDatabase(): Database.Database | undefined {
    return this.db;
  }

  isPartialIndex(): boolean {
    return this.status !== 'upToDate';
  }

  getProgress(): IndexProgress {
    const pct = this.total > 0 ? Math.round((this.indexed / this.total) * 100) : 100;
    let message = 'Up to date';
    if (this.status === 'scanning') {
      message = 'Scanning...';
    } else if (this.status === 'indexing') {
      message = `Indexing... ${pct}%`;
    }
    return {
      status: this.status,
      queued: this.queued,
      indexed: this.indexed,
      total: this.total,
      message,
    };
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  async startIndexing(forceAll = false): Promise<void> {
    if (this.readOnly || this.indexing || !this.db) {
      if (this.readOnly) {
        this.setStatus('upToDate');
        this.emit('progress', this.getProgress());
      }
      return;
    }
    this.indexing = true;
    this.setStatus('scanning');
    this.indexed = 0;
    this.queued = 0;

    const config = getIndexingSettings();
    const filesToIndex: string[] = [];

    for (const root of this.rootDirs) {
      for await (const filePath of walkDirectory(root, config)) {
        if (this.paused) {
          await this.sleep(100);
        }
        if (!forceAll) {
          const existing = this.getFileMtimeStmt?.get(filePath) as { mtime: number } | undefined;
          if (existing) {
            try {
              const stat = await fs.promises.stat(filePath);
              if (Math.floor(stat.mtimeMs) === existing.mtime) {
                continue;
              }
            } catch {
              continue;
            }
          }
        }
        filesToIndex.push(filePath);
      }
    }

    this.total = filesToIndex.length;
    this.queued = filesToIndex.length;
    this.setStatus('indexing');

    for (let i = 0; i < filesToIndex.length; i += BATCH_SIZE) {
      if (this.paused) {
        await this.sleep(200);
        i -= BATCH_SIZE;
        continue;
      }

      const batch = filesToIndex.slice(i, i + BATCH_SIZE);
      const records: FileRecord[] = [];

      for (const filePath of batch) {
        const record = await readFileForIndex(filePath);
        if (record) {
          records.push(record);
        }
      }

      this.indexBatch(records);
      this.indexed += batch.length;
      this.queued = filesToIndex.length - this.indexed;
      this.emit('progress', this.getProgress());
    }

    this.setStatus('upToDate');
    this.indexing = false;
    this.startWatcher();
    this.emit('progress', this.getProgress());
  }

  private indexBatch(records: FileRecord[]): void {
    if (!this.db) {
      return;
    }

    const tx = this.db.transaction((items: FileRecord[]) => {
      for (const record of items) {
        this.indexFile(record);
      }
    });
    tx(records);
  }

  indexFile(record: FileRecord): void {
    if (this.readOnly) {
      return;
    }
    if (!this.db || !this.insertFileStmt || !this.updateFileStmt) {
      return;
    }

    const existing = this.getFileMtimeStmt?.get(record.path);
    if (existing) {
      this.deleteFtsStmt?.run(record.path);
      this.updateFileStmt.run(record);
    } else {
      this.insertFileStmt.run(record);
    }
    this.insertFtsStmt?.run({ path: record.path, content: record.content });

    const tokens = extractTokens(record.content);
    for (const token of tokens.slice(0, 500)) {
      this.upsertTokenStmt?.run(token);
    }
  }

  async indexSingleFile(filePath: string): Promise<void> {
    if (this.readOnly) {
      return;
    }
    const config = getIndexingSettings();
    try {
      const stat = await fs.promises.stat(filePath);
      if (!shouldIndexFile(filePath, config, stat.size)) {
        this.removeFile(filePath);
        return;
      }
    } catch {
      this.removeFile(filePath);
      return;
    }

    const record = await readFileForIndex(filePath);
    if (record) {
      this.indexFile(record);
    } else {
      this.removeFile(filePath);
    }
    this.emit('progress', this.getProgress());
  }

  removeFile(filePath: string): void {
    this.deleteFtsStmt?.run(filePath);
    this.deleteFileStmt?.run(filePath);
  }

  private startWatcher(): void {
    if (this.readOnly) {
      return;
    }
    const config = getIndexingSettings();
    this.watcher.start(this.rootDirs, config, (filePath, event) => {
      void this.handleFileChange(filePath, event);
    });
  }

  private async handleFileChange(filePath: string, event: 'add' | 'change' | 'unlink'): Promise<void> {
    if (event === 'unlink') {
      this.removeFile(filePath);
      this.emit('progress', this.getProgress());
      return;
    }
    await this.indexSingleFile(filePath);
  }

  async refresh(forceAll = false): Promise<void> {
    if (this.readOnly) {
      return;
    }
    this.watcher.stop();
    await this.startIndexing(forceAll);
  }

  private setStatus(status: IndexStatus): void {
    this.status = status;
    this.emit('status', status);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getTokenSuggestions(prefix: string, limit = 20): Array<{ token: string; freq: number }> {
    if (!this.db || !prefix || prefix.length < 2) {
      return [];
    }
    const pattern = `${prefix}%`;
    return this.db
      .prepare(
        `SELECT token, freq FROM tokens WHERE token LIKE ? COLLATE NOCASE ORDER BY freq DESC LIMIT ?`
      )
      .all(pattern, limit) as Array<{ token: string; freq: number }>;
  }

  dispose(): void {
    this.watcher.stop();
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
  }
}
