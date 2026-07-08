import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { getIndexingSettings } from '../indexingSettings';
import { openDatabase, SqliteDatabase, SqliteStatement } from '../native/betterSqlite3';
import { FileRecord, IndexProgress, IndexStatus } from '../types';
import { mergeIndexingSettings, PerIndexExcludes } from './excludePatterns';
import {
  extractTokens,
  readFileForIndex,
  shouldIndexFile,
  shouldPathRemainInIndex,
  walkDirectory,
} from './FileScanner';
import { IndexingSettings } from '../indexingSettings';
import { FileWatcher } from './FileWatcher';
import { mapWithConcurrency } from './concurrency';
import { resolveIndexThreadCount } from './threadCount';
import {
  counterpartExts,
  extFromPath,
  FileCandidate,
  rankCounterparts,
} from '../pairing/headerSourcePairing';

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
  private db: SqliteDatabase | undefined;
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
  private scanned = 0;
  private activeThreadCount = 1;

  private insertFileStmt: SqliteStatement | undefined;
  private updateFileStmt: SqliteStatement | undefined;
  private deleteFileStmt: SqliteStatement | undefined;
  private deleteFtsStmt: SqliteStatement | undefined;
  private insertFtsStmt: SqliteStatement | undefined;
  private getFileMtimeStmt: SqliteStatement | undefined;
  private upsertTokenStmt: SqliteStatement | undefined;
  private perIndexExcludes: PerIndexExcludes | undefined;

  constructor(
    dbPath: string,
    options?: { readOnly?: boolean; id?: string; name?: string; perIndexExcludes?: PerIndexExcludes }
  ) {
    super();
    this.dbPath = dbPath;
    this.readOnly = options?.readOnly ?? false;
    this.id = options?.id ?? 'primary';
    this._name = options?.name ?? 'Primary';
    this.perIndexExcludes = options?.perIndexExcludes;
  }

  get name(): string {
    return this._name;
  }

  setName(name: string): void {
    this._name = name;
  }

  setPerIndexExcludes(excludes: PerIndexExcludes | undefined): void {
    this.perIndexExcludes = excludes;
  }

  private getEffectiveSettings() {
    return mergeIndexingSettings(getIndexingSettings(), this.perIndexExcludes);
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

    this.db = openDatabase(this.dbPath, { readonly: this.readOnly });
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

  getDatabase(): SqliteDatabase | undefined {
    return this.db;
  }

  isPartialIndex(): boolean {
    return this.status !== 'upToDate';
  }

  getProgress(): IndexProgress {
    let message = 'Up to date';
    if (this.status === 'scanning') {
      message = `Scanning ${this.scanned} files...`;
    } else if (this.status === 'indexing') {
      const threadHint =
        this.activeThreadCount > 1 ? ` (${this.activeThreadCount} threads)` : '';
      message =
        this.total > 0
          ? `Indexing ${this.indexed}/${this.total} files${threadHint}...`
          : 'Indexing...';
    } else if (this.status === 'upToDate') {
      message = `${formatTokenCount(this.getTokenCount())} · Up to date`;
    }
    return {
      status: this.status,
      queued: this.queued,
      indexed: this.indexed,
      total: this.total,
      scanned: this.scanned,
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
    this.scanned = 0;
    this.emit('progress', this.getProgress());

    const config = this.getEffectiveSettings();
    if (forceAll) {
      await this.purgeStaleEntries(config);
    }
    const filesSet = new Set<string>();

    for (const root of this.rootDirs) {
      for await (const filePath of walkDirectory(root, config)) {
        if (this.paused) {
          await this.sleep(100);
        }
        this.scanned++;
        if (this.scanned % 50 === 0) {
          this.emit('progress', this.getProgress());
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
        filesSet.add(filePath);
      }
    }

    const filesToIndex = Array.from(filesSet);

    this.emit('progress', this.getProgress());
    this.total = filesToIndex.length;
    this.queued = filesToIndex.length;
    this.setStatus('indexing');

    const threadCount = resolveIndexThreadCount(config.indexThreads);
    this.activeThreadCount = threadCount;

    for (let i = 0; i < filesToIndex.length; i += BATCH_SIZE) {
      while (this.paused) {
        await this.sleep(200);
      }

      const batch = filesToIndex.slice(i, i + BATCH_SIZE);
      const results = await mapWithConcurrency(batch, threadCount, readFileForIndex, {
        shouldPause: () => this.paused,
        onPause: () => this.sleep(200),
      });
      const records = results.filter((r): r is FileRecord => r !== null);

      this.indexBatch(records);
      this.indexed += batch.length;
      this.queued = filesToIndex.length - this.indexed;
      this.emit('progress', this.getProgress());
    }

    this.activeThreadCount = 1;

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
    const config = this.getEffectiveSettings();
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

  private async purgeStaleEntries(config: IndexingSettings): Promise<void> {
    if (!this.db || this.readOnly) {
      return;
    }
    const rows = this.db.prepare('SELECT path FROM files').all() as { path: string }[];
    for (const { path: filePath } of rows) {
      const remain = await shouldPathRemainInIndex(filePath, this.rootDirs, config);
      if (!remain) {
        this.removeFile(filePath);
      }
    }
  }

  private startWatcher(): void {
    if (this.readOnly) {
      return;
    }
    const config = this.getEffectiveSettings();
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

  fileExistsInIndex(filePath: string): boolean {
    if (!this.getFileMtimeStmt) {
      return false;
    }
    if (this.getFileMtimeStmt.get(filePath)) {
      return true;
    }
    const resolved = path.resolve(filePath);
    return resolved !== filePath && !!this.getFileMtimeStmt.get(resolved);
  }

  findHeaderSourceCounterparts(filePath: string): string[] {
    if (!this.db) {
      return [];
    }

    const ext = extFromPath(filePath);
    const counterparts = counterpartExts(ext);
    if (counterparts.length === 0) {
      return [];
    }

    const placeholders = counterparts.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT path, ext, dir FROM files WHERE ext IN (${placeholders})`)
      .all(...counterparts) as FileCandidate[];

    return rankCounterparts(filePath, rows);
  }

  getTokenCount(): number {
    if (!this.db) {
      return 0;
    }
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM tokens').get() as { count: number };
    return row.count;
  }

  getTokenSuggestions(prefix: string, limit = 20): Array<{ token: string; freq: number }> {
    if (!this.db || !prefix || prefix.length < 2) {
      return [];
    }
    const pattern = `${prefix}%`;
    return this.db
      .prepare(
        `SELECT token, freq FROM tokens WHERE token LIKE ? COLLATE NOCASE ORDER BY LENGTH(token) ASC, freq DESC LIMIT ?`
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

function formatTokenCount(count: number): string {
  return `${count.toLocaleString('en-US')} tokens`;
}
