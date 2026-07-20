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
import {
  finalizeTokenSuggestions,
  TOKEN_AUTOCOMPLETE_INDEX,
  TOKEN_AUTOCOMPLETE_INDEX_SQL,
  TOKEN_SUGGESTION_CANDIDATE_LIMIT,
} from './tokenSuggestions';

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
${TOKEN_AUTOCOMPLETE_INDEX_SQL}
`;
const BATCH_SIZE = 100;
export const INDEX_BUILD_STATE_META_KEY = 'indexBuildStateV1';
export type IndexBuildState = 'building' | 'complete' | 'failed' | 'unknown';

export class IndexService extends EventEmitter {
  private db: SqliteDatabase | undefined;
  private dbPath: string;
  private rootDirs: string[] = [];
  private readonly readOnly: boolean;
  readonly id: string;
  private _name: string;

  private watcher = new FileWatcher();
  private paused = false;
  private pauseCount = 0;
  private indexing = false;
  private indexingGeneration = 0;
  private disposed = false;
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
  private tokenSuggestionsStmt: SqliteStatement | undefined;
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

  /** True when low-priority hierarchy cache work may touch this database. */
  isBackgroundWorkAllowed(): boolean {
    return !this.disposed &&
      !this.indexing &&
      this.pauseCount === 0 &&
      this.status !== 'scanning' &&
      this.status !== 'indexing';
  }

  async initialize(rootDirs: string[]): Promise<void> {
    this.disposed = false;
    const initializeGeneration = this.indexingGeneration;
    this.rootDirs = rootDirs;
    if (this.readOnly) {
      // A shared/secondary reader must never create or migrate the database.
      // In particular, setting journal_mode and executing CREATE statements can
      // fail on a database owned by another IDE (or silently violate read-only
      // expectations on permissive filesystems).
      this.db = openDatabase(this.dbPath, { readonly: true, fileMustExist: true });
      this.db.pragma('query_only = ON');
      this.validateReadableSchema();
    } else {
      const dir = path.dirname(this.dbPath);
      await fs.promises.mkdir(dir, { recursive: true });
      if (this.disposed || initializeGeneration !== this.indexingGeneration) {
        throw new Error('Index service was disposed during initialization');
      }
      this.db = openDatabase(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.exec(SCHEMA);
      this.ensureTokenAutocompleteIndex();
    }
    this.prepareStatements();
  }

  private validateReadableSchema(): void {
    if (!this.db) {
      return;
    }
    const required = ['files', 'files_fts', 'tokens'];
    const rows = this.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE (type = 'table' OR type = 'view')
           AND name IN (${required.map(() => '?').join(', ')})`
      )
      .all(...required) as Array<{ name: string }>;
    const found = new Set(rows.map((row) => row.name));
    const missing = required.filter((name) => !found.has(name));
    if (missing.length > 0) {
      this.db.close();
      this.db = undefined;
      throw new Error(
        `Not a compatible Ace Code Search database (missing: ${missing.join(', ')})`
      );
    }
  }

  private ensureTokenAutocompleteIndex(): void {
    if (!this.db || this.readOnly) {
      return;
    }
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = ?`
      )
      .get(TOKEN_AUTOCOMPLETE_INDEX) as { ok: number } | undefined;
    if (!row) {
      this.db.exec(TOKEN_AUTOCOMPLETE_INDEX_SQL);
    }
  }

  private prepareStatements(): void {
    if (!this.db) {
      return;
    }
    if (!this.readOnly) {
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
      this.upsertTokenStmt = this.db.prepare(`
        INSERT INTO tokens (token, freq) VALUES (?, 1)
        ON CONFLICT(token) DO UPDATE SET freq = freq + 1
      `);
    }
    this.getFileMtimeStmt = this.db.prepare(`SELECT mtime FROM files WHERE path = ?`);
    this.tokenSuggestionsStmt = this.db.prepare(`
      SELECT token, freq FROM tokens
      WHERE token LIKE ? COLLATE NOCASE
      ORDER BY freq DESC
      LIMIT ?
    `);
  }

  getDatabase(): SqliteDatabase | undefined {
    return this.db;
  }

  isPartialIndex(): boolean {
    return this.getIndexBuildState() !== 'complete';
  }

  /** Read every time so read-only clients observe a concurrent writer dynamically. */
  getIndexBuildState(): IndexBuildState {
    if (!this.db) {
      return 'unknown';
    }
    try {
      const row = this.db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(INDEX_BUILD_STATE_META_KEY) as { value: string } | undefined;
      if (row?.value === 'building' || row?.value === 'complete' || row?.value === 'failed') {
        return row.value;
      }
    } catch {
      // Legacy readable indexes may not have a meta table. Unknown is safely
      // treated as partial instead of claiming that the snapshot is complete.
    }
    return 'unknown';
  }

  private writeIndexBuildState(state: Exclude<IndexBuildState, 'unknown'>): void {
    if (!this.db || this.readOnly || this.disposed) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(INDEX_BUILD_STATE_META_KEY, state);
  }

  private tryWriteIndexBuildState(state: Exclude<IndexBuildState, 'unknown'>): void {
    try {
      this.writeIndexBuildState(state);
    } catch {
      // Preserve the original indexing error. An old/missing marker remains
      // partial, which is the safe state for readers.
    }
  }

  getProgress(): IndexProgress {
    if (this.readOnly) {
      const buildState = this.getIndexBuildState();
      const status: IndexStatus = buildState === 'complete' ? 'upToDate' : 'idle';
      const message =
        buildState === 'complete'
          ? `${formatTokenCount(this.getTokenCount())} · Up to date`
          : buildState === 'building'
            ? 'Index snapshot is still building'
            : buildState === 'failed'
              ? 'Index build failed; snapshot may be incomplete'
              : 'Index completion is unknown (legacy snapshot)';
      return {
        status,
        queued: this.queued,
        indexed: this.indexed,
        total: this.total,
        scanned: this.scanned,
        message,
      };
    }
    let message = this.status === 'idle' ? 'Ready' : 'Up to date';
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
    this.pauseCount++;
    if (this.pauseCount === 1) {
      this.paused = true;
      this.watcher.pause();
    }
  }

  resume(): void {
    if (this.pauseCount === 0) {
      return;
    }
    this.pauseCount--;
    if (this.pauseCount === 0) {
      this.paused = false;
      this.watcher.resume();
    }
  }

  async startIndexing(forceAll = false): Promise<void> {
    if (this.disposed || this.readOnly || this.indexing || !this.db) {
      if (this.readOnly && !this.disposed) {
        this.setStatus(this.getIndexBuildState() === 'complete' ? 'upToDate' : 'idle');
        this.emit('progress', this.getProgress());
      }
      return;
    }
    const generation = ++this.indexingGeneration;
    const cancelled = () => this.disposed || generation !== this.indexingGeneration;
    let failed = false;
    let completed = false;
    try {
      this.writeIndexBuildState('building');
      this.indexing = true;
      this.setStatus('scanning');
      this.indexed = 0;
      this.queued = 0;
      this.scanned = 0;
      this.emit('progress', this.getProgress());
      const config = this.getEffectiveSettings();
      if (forceAll) {
        await this.purgeStaleEntries(config, cancelled);
        if (cancelled()) {
          return;
        }
      }
      const filesSet = new Set<string>();

      for (const root of this.rootDirs) {
        for await (const filePath of walkDirectory(root, config)) {
          if (cancelled()) {
            return;
          }
          if (this.paused) {
            await this.sleep(100);
          }
          this.scanned++;
          if (this.scanned % 50 === 0) {
            this.emit('progress', this.getProgress());
          }
          if (!forceAll) {
            const existing = this.getFileMtimeStmt?.get(filePath) as
              | { mtime: number }
              | undefined;
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
        while (this.paused && !cancelled()) {
          await this.sleep(200);
        }
        if (cancelled()) {
          return;
        }

        const batch = filesToIndex.slice(i, i + BATCH_SIZE);
        const results = await mapWithConcurrency(batch, threadCount, readFileForIndex, {
          shouldPause: () => this.paused && !cancelled(),
          onPause: () => this.sleep(200),
        });
        if (cancelled()) {
          return;
        }
        const records = results.filter((r): r is FileRecord => r !== null);

        this.indexBatch(records, generation);
        this.indexed += batch.length;
        this.queued = filesToIndex.length - this.indexed;
        this.emit('progress', this.getProgress());
      }

      if (cancelled()) {
        return;
      }
      // Do not advertise an idle index until the watcher is registered. On
      // VS Code/Cursor this uses the editor file service instead of walking
      // the workspace again in the extension host.
      this.startWatcher(config, generation);
      this.writeIndexBuildState('complete');
      completed = true;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // A stale indexing attempt must never reset a newer generation. For the
      // current generation, always release the in-flight guard so Refresh can
      // retry after any scanner, database, or watcher failure.
      if (generation === this.indexingGeneration) {
        this.indexing = false;
        this.activeThreadCount = 1;
        if (failed && !this.disposed) {
          this.tryWriteIndexBuildState('failed');
          this.setStatus('idle');
          this.emit('progress', this.getProgress());
        } else if (completed && !this.disposed) {
          this.setStatus('upToDate');
          this.emit('progress', this.getProgress());
        }
      }
    }
  }

  private indexBatch(records: FileRecord[], generation: number): void {
    if (!this.isWriteGenerationActive(generation) || !this.db) {
      return;
    }

    const db = this.db;
    const tx = db.transaction((items: FileRecord[]) => {
      for (const record of items) {
        this.indexFile(record, generation);
      }
    });
    tx(records);
  }

  indexFile(record: FileRecord, generation = this.indexingGeneration): void {
    if (!this.isWriteGenerationActive(generation)) {
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

  async indexSingleFile(
    filePath: string,
    config: IndexingSettings = this.getEffectiveSettings(),
    generation = this.indexingGeneration
  ): Promise<void> {
    if (!this.isWriteGenerationActive(generation)) {
      return;
    }
    try {
      const stat = await fs.promises.stat(filePath);
      if (!this.isWriteGenerationActive(generation)) {
        return;
      }
      if (!shouldIndexFile(filePath, config, stat.size)) {
        this.removeFile(filePath, generation);
        return;
      }
    } catch {
      if (this.isWriteGenerationActive(generation)) {
        this.removeFile(filePath, generation);
      }
      return;
    }

    const record = await readFileForIndex(filePath);
    if (!this.isWriteGenerationActive(generation)) {
      return;
    }
    if (record) {
      this.indexFile(record, generation);
    } else {
      this.removeFile(filePath, generation);
    }
    if (this.isWriteGenerationActive(generation)) {
      this.emit('progress', this.getProgress());
    }
  }

  removeFile(filePath: string, generation = this.indexingGeneration): void {
    if (!this.isWriteGenerationActive(generation) || !this.db) {
      return;
    }
    this.deleteFtsStmt?.run(filePath);
    this.deleteFileStmt?.run(filePath);
  }

  private isWriteGenerationActive(generation: number): boolean {
    return (
      !this.disposed &&
      !this.readOnly &&
      !!this.db &&
      generation === this.indexingGeneration
    );
  }

  private async purgeStaleEntries(
    config: IndexingSettings,
    cancelled: () => boolean = () => this.disposed
  ): Promise<void> {
    if (!this.db || this.readOnly) {
      return;
    }
    const rows = this.db.prepare('SELECT path FROM files').all() as { path: string }[];
    for (const { path: filePath } of rows) {
      if (cancelled()) {
        return;
      }
      const remain = await shouldPathRemainInIndex(filePath, this.rootDirs, config);
      if (cancelled()) {
        return;
      }
      if (!remain) {
        this.removeFile(filePath);
      }
    }
  }

  private startWatcher(
    config: IndexingSettings = this.getEffectiveSettings(),
    generation = this.indexingGeneration
  ): void {
    if (!this.isWriteGenerationActive(generation)) {
      return;
    }
    this.watcher.start(this.rootDirs, config, (filePath, event) => {
      return this.handleFileChange(filePath, event, config, generation);
    });
  }

  private async handleFileChange(
    filePath: string,
    event: 'add' | 'change' | 'unlink',
    config: IndexingSettings,
    generation: number
  ): Promise<void> {
    if (!this.isWriteGenerationActive(generation)) {
      return;
    }
    if (event === 'unlink') {
      this.removeFile(filePath, generation);
      if (this.isWriteGenerationActive(generation)) {
        this.emit('progress', this.getProgress());
      }
      return;
    }
    await this.indexSingleFile(filePath, config, generation);
  }

  async refresh(forceAll = false): Promise<void> {
    if (this.readOnly || this.disposed) {
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
    if (!this.db || !this.tokenSuggestionsStmt || !prefix || prefix.length < 2) {
      return [];
    }
    const candidates = this.tokenSuggestionsStmt.all(
      `${prefix}%`,
      TOKEN_SUGGESTION_CANDIDATE_LIMIT
    ) as Array<{ token: string; freq: number }>;
    return finalizeTokenSuggestions(candidates, limit);
  }

  dispose(): void {
    this.disposed = true;
    this.indexingGeneration++;
    this.indexing = false;
    const db = this.db;
    this.db = undefined;
    this.insertFileStmt = undefined;
    this.updateFileStmt = undefined;
    this.deleteFileStmt = undefined;
    this.deleteFtsStmt = undefined;
    this.insertFtsStmt = undefined;
    this.getFileMtimeStmt = undefined;
    this.upsertTokenStmt = undefined;
    this.tokenSuggestionsStmt = undefined;
    this.watcher.stop();
    if (db) {
      try {
        db.close();
      } catch {
        // A streaming statement iterator can keep better-sqlite3 busy across
        // an async yield. Runtime references were already detached above, so
        // no indexing callback can write after the manager releases its lease;
        // the iterator's owner will release the remaining read handle.
      }
    }
  }
}

function formatTokenCount(count: number): string {
  return `${count.toLocaleString('en-US')} tokens`;
}
