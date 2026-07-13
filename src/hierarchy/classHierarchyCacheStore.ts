import { createHash } from 'crypto';
import { SqliteDatabase } from '../native/betterSqlite3';
import { ClassDeclaration } from './classHierarchy';

export const CLASS_HIERARCHY_CACHE_SCHEMA_VERSION = 1;
export const DEFAULT_CLASS_HIERARCHY_PARSER_VERSION = 1;

export const CLASS_HIERARCHY_SOURCE_EXTENSIONS = [
  'c',
  'cc',
  'cpp',
  'cxx',
  'cu',
  'cuh',
  'h',
  'hh',
  'hpp',
  'hxx',
  'inl',
  'ipp',
  'ixx',
  'm',
  'mm',
  'tcc',
  'txx',
] as const;

const CACHE_SCHEMA_META_KEY = 'class_hierarchy_cache_schema_version';
const SQLITE_PARAMETER_BATCH_SIZE = 400;

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  class_hierarchy_files: [
    'file_id',
    'source_mtime',
    'source_size',
    'source_fingerprint',
    'parser_version',
    'declaration_count',
    'updated_at',
  ],
  class_hierarchy_declarations: [
    'file_id',
    'decl_ordinal',
    'declaration_key',
    'kind',
    'name',
    'qualified_name',
    'is_final',
    'line',
    'column_number',
    'end_line',
    'end_column',
  ],
  class_hierarchy_bases: [
    'file_id',
    'decl_ordinal',
    'base_ordinal',
    'name',
    'lookup_name',
    'access',
    'is_virtual',
  ],
};

const CREATE_CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS class_hierarchy_files (
  file_id INTEGER PRIMARY KEY,
  source_mtime INTEGER NOT NULL,
  source_size INTEGER NOT NULL,
  source_fingerprint TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  declaration_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS class_hierarchy_declarations (
  file_id INTEGER NOT NULL,
  decl_ordinal INTEGER NOT NULL,
  declaration_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  is_final INTEGER NOT NULL,
  line INTEGER NOT NULL,
  column_number INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  PRIMARY KEY (file_id, decl_ordinal)
);

CREATE TABLE IF NOT EXISTS class_hierarchy_bases (
  file_id INTEGER NOT NULL,
  decl_ordinal INTEGER NOT NULL,
  base_ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  lookup_name TEXT NOT NULL,
  access TEXT NOT NULL,
  is_virtual INTEGER NOT NULL,
  PRIMARY KEY (file_id, decl_ordinal, base_ordinal)
);

CREATE INDEX IF NOT EXISTS idx_class_hierarchy_declarations_qualified_name
  ON class_hierarchy_declarations(qualified_name);
CREATE INDEX IF NOT EXISTS idx_class_hierarchy_declarations_name
  ON class_hierarchy_declarations(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_class_hierarchy_bases_lookup_name
  ON class_hierarchy_bases(lookup_name);

CREATE TRIGGER IF NOT EXISTS trg_class_hierarchy_files_content_update
AFTER UPDATE OF content ON files
BEGIN
  DELETE FROM class_hierarchy_files WHERE file_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_class_hierarchy_files_delete
AFTER DELETE ON files
BEGIN
  DELETE FROM class_hierarchy_bases WHERE file_id = OLD.id;
  DELETE FROM class_hierarchy_declarations WHERE file_id = OLD.id;
  DELETE FROM class_hierarchy_files WHERE file_id = OLD.id;
END;
`;

const DROP_CACHE_SCHEMA_SQL = `
DROP TRIGGER IF EXISTS trg_class_hierarchy_files_content_update;
DROP TRIGGER IF EXISTS trg_class_hierarchy_files_delete;
DROP TABLE IF EXISTS class_hierarchy_bases;
DROP TABLE IF EXISTS class_hierarchy_declarations;
DROP TABLE IF EXISTS class_hierarchy_files;
`;

export interface ClassHierarchyCacheCapabilities {
  /** The three cache tables have the columns understood by this extension. */
  available: boolean;
  /** False for a secondary index opened with SQLite's readonly option. */
  writable: boolean;
  schemaVersion?: number;
  reason?: string;
}

export interface ClassHierarchyPendingFile {
  fileId: number;
  path: string;
  mtime: number;
  size: number;
}

export interface ClassHierarchyPendingFilePage {
  files: ClassHierarchyPendingFile[];
  /** Pass this to the next call. It is unchanged for an empty page. */
  nextAfterFileId: number;
  /** False means another page may exist; an exact-limit final page needs one empty read. */
  done: boolean;
}

export interface ClassHierarchySourceSnapshot extends ClassHierarchyPendingFile {
  content: string;
  fingerprint: string;
}

export interface ParsedClassHierarchyFile extends ClassHierarchyPendingFile {
  /** Fingerprint returned by readSources(). It protects same-mtime/size rewrites. */
  fingerprint?: string;
  declarations: readonly ClassDeclaration[];
}

export interface ApplyClassHierarchyCacheResult {
  appliedFileIds: number[];
  skippedFileIds: number[];
}

interface FileRow {
  id: number;
  path: string;
  mtime: number;
  size: number;
  content?: string;
}

interface DeclarationRow {
  file_id: number;
  decl_ordinal: number;
  declaration_key: string;
  kind: 'class' | 'struct';
  name: string;
  qualified_name: string;
  is_final: number;
  path: string;
  line: number;
  column_number: number;
  end_line: number;
  end_column: number;
}

interface BaseRow {
  file_id: number;
  decl_ordinal: number;
  name: string;
  lookup_name: string;
  access: 'public' | 'protected' | 'private';
  is_virtual: number;
}

/**
 * Persistence boundary for the class parser cache.
 *
 * The store deliberately does no parsing and owns no worker. That lets a
 * coordinator page source snapshots on the extension thread, parse elsewhere,
 * and return compact results for one atomic apply.
 */
export class ClassHierarchyCacheStore {
  private capabilities: ClassHierarchyCacheCapabilities | undefined;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: {
      readOnly: boolean;
      parserVersion?: number;
    }
  ) {}

  get parserVersion(): number {
    return this.options.parserVersion ?? DEFAULT_CLASS_HIERARCHY_PARSER_VERSION;
  }

  /**
   * Creates or replaces the disposable cache schema only for writable DBs.
   * Readonly indexes are inspected without issuing any schema or PRAGMA writes.
   */
  initialize(): ClassHierarchyCacheCapabilities {
    if (this.options.readOnly) {
      this.capabilities = this.detectCapabilities(false);
      return this.capabilities;
    }

    const schemaVersion = this.readSchemaVersion();
    const compatible = this.hasCompatibleTables();
    const tx = this.db.transaction(() => {
      if ((schemaVersion !== undefined && schemaVersion !== CLASS_HIERARCHY_CACHE_SCHEMA_VERSION) ||
          (this.hasAnyCacheTable() && !compatible)) {
        this.db.exec(DROP_CACHE_SCHEMA_SQL);
      }
      this.db.exec(CREATE_CACHE_SCHEMA_SQL);
      this.db.prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(CACHE_SCHEMA_META_KEY, String(CLASS_HIERARCHY_CACHE_SCHEMA_VERSION));
    });
    tx();

    this.capabilities = this.detectCapabilities(true);
    return this.capabilities;
  }

  getCapabilities(): ClassHierarchyCacheCapabilities {
    return this.capabilities ?? this.initialize();
  }

  /** Lists only source metadata so callers can keep content reads bounded. */
  listPendingFiles(options: {
    afterFileId?: number;
    limit?: number;
    extensions?: readonly string[];
  } = {}): ClassHierarchyPendingFilePage {
    const afterFileId = normalizeNonNegativeInteger(options.afterFileId, 0);
    const limit = Math.max(1, Math.min(normalizeNonNegativeInteger(options.limit, 50), 1000));
    const extensions = normalizeExtensions(
      options.extensions ?? CLASS_HIERARCHY_SOURCE_EXTENSIONS
    );
    if (extensions.length === 0) {
      return { files: [], nextAfterFileId: afterFileId, done: true };
    }

    const placeholders = extensions.map(() => '?').join(',');
    const cacheAvailable = this.getCapabilities().available;
    const cacheJoin = cacheAvailable
      ? 'LEFT JOIN class_hierarchy_files chf ON chf.file_id = f.id'
      : '';
    const pendingPredicate = cacheAvailable
      ? `AND (
          chf.file_id IS NULL OR
          chf.parser_version <> ? OR
          chf.source_mtime <> f.mtime OR
          chf.source_size <> f.size
        )`
      : '';
    const parameters: Array<string | number> = [afterFileId, ...extensions];
    if (cacheAvailable) {
      parameters.push(this.parserVersion);
    }
    parameters.push(limit);

    const rows = this.db.prepare(`
      SELECT f.id, f.path, f.mtime, f.size
      FROM files f
      ${cacheJoin}
      WHERE f.id > ?
        AND LOWER(COALESCE(f.ext, '')) IN (${placeholders})
        ${pendingPredicate}
      ORDER BY f.id
      LIMIT ?
    `).all(...parameters) as FileRow[];
    const files = rows.map(toPendingFile);
    return {
      files,
      nextAfterFileId: files.length > 0 ? files[files.length - 1].fileId : afterFileId,
      done: files.length < limit,
    };
  }

  /**
   * Reads current contents for a metadata batch. A row deleted between the diff
   * and this call is omitted; a changed row is returned with its new signature.
   */
  readSources(files: readonly ClassHierarchyPendingFile[]): ClassHierarchySourceSnapshot[] {
    if (files.length === 0) {
      return [];
    }
    const ids = Array.from(new Set(files.map((file) => file.fileId)));
    const result: ClassHierarchySourceSnapshot[] = [];
    for (let offset = 0; offset < ids.length; offset += SQLITE_PARAMETER_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + SQLITE_PARAMETER_BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT id, path, mtime, size, content
        FROM files
        WHERE id IN (${placeholders})
      `).all(...batch) as Array<FileRow & { content: string }>;
      for (const row of rows) {
        result.push({
          ...toPendingFile(row),
          content: row.content,
          fingerprint: computeClassHierarchySourceFingerprint(row.content),
        });
      }
    }
    result.sort((a, b) => a.fileId - b.fileId);
    return result;
  }

  /** Convenience for coordinators that do not need separate diff/source phases. */
  readPendingSourcePage(options: {
    afterFileId?: number;
    limit?: number;
    extensions?: readonly string[];
  } = {}): ClassHierarchyPendingFilePage & { sources: ClassHierarchySourceSnapshot[] } {
    const page = this.listPendingFiles(options);
    return { ...page, sources: this.readSources(page.files) };
  }

  /**
   * Replaces all supplied files atomically. The marker is inserted last, so a
   * zero-declaration file is distinguishable from an unparsed file.
   */
  applyParsedFiles(files: readonly ParsedClassHierarchyFile[]): ApplyClassHierarchyCacheResult {
    const capabilities = this.getCapabilities();
    if (!capabilities.writable || !capabilities.available) {
      throw new Error('Class hierarchy cache is not writable');
    }

    const getCurrentFile = this.db.prepare(
      'SELECT id, path, mtime, size, content FROM files WHERE id = ?'
    );
    const deleteBases = this.db.prepare(
      'DELETE FROM class_hierarchy_bases WHERE file_id = ?'
    );
    const deleteDeclarations = this.db.prepare(
      'DELETE FROM class_hierarchy_declarations WHERE file_id = ?'
    );
    const deleteMarker = this.db.prepare(
      'DELETE FROM class_hierarchy_files WHERE file_id = ?'
    );
    const insertDeclaration = this.db.prepare(`
      INSERT INTO class_hierarchy_declarations (
        file_id, decl_ordinal, declaration_key, kind, name, qualified_name,
        is_final, line, column_number, end_line, end_column
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertBase = this.db.prepare(`
      INSERT INTO class_hierarchy_bases (
        file_id, decl_ordinal, base_ordinal, name, lookup_name, access, is_virtual
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMarker = this.db.prepare(`
      INSERT INTO class_hierarchy_files (
        file_id, source_mtime, source_size, source_fingerprint,
        parser_version, declaration_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const appliedFileIds: number[] = [];
    const skippedFileIds: number[] = [];
    const tx = this.db.transaction((items: readonly ParsedClassHierarchyFile[]) => {
      for (const file of items) {
        const current = getCurrentFile.get(file.fileId) as (FileRow & { content: string }) | undefined;
        if (!current ||
            current.path !== file.path ||
            current.mtime !== file.mtime ||
            current.size !== file.size ||
            (file.fingerprint !== undefined &&
              computeClassHierarchySourceFingerprint(current.content) !== file.fingerprint)) {
          skippedFileIds.push(file.fileId);
          continue;
        }

        deleteBases.run(file.fileId);
        deleteDeclarations.run(file.fileId);
        deleteMarker.run(file.fileId);

        file.declarations.forEach((declaration, declarationIndex) => {
          insertDeclaration.run(
            file.fileId,
            declarationIndex,
            declaration.id,
            declaration.kind,
            declaration.name,
            declaration.qualifiedName,
            declaration.isFinal ? 1 : 0,
            declaration.location.line,
            declaration.location.column,
            declaration.location.endLine,
            declaration.location.endColumn
          );
          declaration.bases.forEach((base, baseIndex) => {
            insertBase.run(
              file.fileId,
              declarationIndex,
              baseIndex,
              base.name,
              base.lookupName,
              base.access,
              base.isVirtual ? 1 : 0
            );
          });
        });

        insertMarker.run(
          file.fileId,
          file.mtime,
          file.size,
          file.fingerprint ?? computeClassHierarchySourceFingerprint(current.content),
          this.parserVersion,
          file.declarations.length,
          Date.now()
        );
        appliedFileIds.push(file.fileId);
      }
    });
    tx(files);
    return { appliedFileIds, skippedFileIds };
  }

  /** Removes cache rows without requiring the source row to still exist. */
  deleteFiles(fileIds: readonly number[]): number {
    const capabilities = this.getCapabilities();
    if (!capabilities.writable || !capabilities.available || fileIds.length === 0) {
      return 0;
    }
    const uniqueIds = Array.from(new Set(fileIds));
    const deleteBases = this.db.prepare('DELETE FROM class_hierarchy_bases WHERE file_id = ?');
    const deleteDeclarations = this.db.prepare(
      'DELETE FROM class_hierarchy_declarations WHERE file_id = ?'
    );
    const deleteMarker = this.db.prepare('DELETE FROM class_hierarchy_files WHERE file_id = ?');
    let deletedFileCount = 0;
    const tx = this.db.transaction((ids: readonly number[]) => {
      for (const id of ids) {
        const changes = deleteBases.run(id).changes +
          deleteDeclarations.run(id).changes +
          deleteMarker.run(id).changes;
        if (changes > 0) {
          deletedFileCount++;
        }
      }
    });
    tx(uniqueIds);
    return deletedFileCount;
  }

  /** Reads only complete, current, same-parser-version files. */
  readCachedDeclarations(): ClassDeclaration[] {
    if (!this.getCapabilities().available) {
      return [];
    }
    const declarations = this.db.prepare(`
      SELECT
        d.file_id, d.decl_ordinal, d.declaration_key, d.kind, d.name,
        d.qualified_name, d.is_final, f.path, d.line, d.column_number,
        d.end_line, d.end_column
      FROM class_hierarchy_declarations d
      JOIN class_hierarchy_files chf ON chf.file_id = d.file_id
      JOIN files f ON f.id = d.file_id
      WHERE chf.parser_version = ?
        AND chf.source_mtime = f.mtime
        AND chf.source_size = f.size
      ORDER BY d.file_id, d.decl_ordinal
    `).all(this.parserVersion) as DeclarationRow[];
    if (declarations.length === 0) {
      return [];
    }

    const bases = this.db.prepare(`
      SELECT b.file_id, b.decl_ordinal, b.name, b.lookup_name, b.access, b.is_virtual
      FROM class_hierarchy_bases b
      JOIN class_hierarchy_files chf ON chf.file_id = b.file_id
      JOIN files f ON f.id = b.file_id
      WHERE chf.parser_version = ?
        AND chf.source_mtime = f.mtime
        AND chf.source_size = f.size
      ORDER BY b.file_id, b.decl_ordinal, b.base_ordinal
    `).all(this.parserVersion) as BaseRow[];
    const basesByDeclaration = new Map<string, BaseRow[]>();
    for (const base of bases) {
      const key = declarationRowKey(base.file_id, base.decl_ordinal);
      const existing = basesByDeclaration.get(key);
      if (existing) {
        existing.push(base);
      } else {
        basesByDeclaration.set(key, [base]);
      }
    }

    return declarations.map((row) => ({
      id: row.declaration_key,
      kind: row.kind,
      name: row.name,
      qualifiedName: row.qualified_name,
      isFinal: row.is_final !== 0,
      bases: (basesByDeclaration.get(declarationRowKey(row.file_id, row.decl_ordinal)) ?? [])
        .map((base) => ({
          name: base.name,
          lookupName: base.lookup_name,
          access: base.access,
          isVirtual: base.is_virtual !== 0,
        })),
      location: {
        path: row.path,
        line: row.line,
        column: row.column_number,
        endLine: row.end_line,
        endColumn: row.end_column,
      },
    }));
  }

  /** Counts source files represented by a complete current cache marker. */
  countCachedFiles(): number {
    if (!this.getCapabilities().available) {
      return 0;
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM class_hierarchy_files chf
      JOIN files f ON f.id = chf.file_id
      WHERE chf.parser_version = ?
        AND chf.source_mtime = f.mtime
        AND chf.source_size = f.size
    `).get(this.parserVersion) as { count: number };
    return row.count;
  }

  private detectCapabilities(writable: boolean): ClassHierarchyCacheCapabilities {
    const schemaVersion = this.readSchemaVersion();
    const available = this.hasCompatibleTables() &&
      (schemaVersion === undefined || schemaVersion === CLASS_HIERARCHY_CACHE_SCHEMA_VERSION);
    return {
      available,
      writable,
      schemaVersion,
      reason: available ? undefined : 'Class hierarchy cache schema is unavailable or incompatible',
    };
  }

  private readSchemaVersion(): number | undefined {
    if (!this.tableExists('meta')) {
      return undefined;
    }
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?')
      .get(CACHE_SCHEMA_META_KEY) as { value: string } | undefined;
    if (!row) {
      return undefined;
    }
    const parsed = Number.parseInt(row.value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private hasCompatibleTables(): boolean {
    return Object.entries(REQUIRED_COLUMNS).every(([table, columns]) => {
      if (!this.tableExists(table)) {
        return false;
      }
      const actual = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .map((column) => column.name)
      );
      return columns.every((column) => actual.has(column));
    });
  }

  private hasAnyCacheTable(): boolean {
    return Object.keys(REQUIRED_COLUMNS).some((table) => this.tableExists(table));
  }

  private tableExists(table: string): boolean {
    return !!this.db.prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`
    ).get(table);
  }
}

export function computeClassHierarchySourceFingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function normalizeExtensions(extensions: readonly string[]): string[] {
  return Array.from(new Set(
    extensions
      .map((extension) => extension.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean)
  ));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value != null && value >= 0 ? value : fallback;
}

function toPendingFile(row: FileRow): ClassHierarchyPendingFile {
  return { fileId: row.id, path: row.path, mtime: row.mtime, size: row.size };
}

function declarationRowKey(fileId: number, declarationOrdinal: number): string {
  return `${fileId}:${declarationOrdinal}`;
}
