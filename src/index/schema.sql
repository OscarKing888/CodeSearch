-- File metadata
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  ext TEXT,
  dir TEXT,
  content TEXT NOT NULL DEFAULT ''
);

-- FTS5 full-text index
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  path UNINDEXED,
  content,
  tokenize='unicode61 remove_diacritics 0'
);

-- Token frequency for future autocomplete (Phase 2)
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  freq INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_tokens_token_freq
  ON tokens(token COLLATE NOCASE, freq DESC);

-- Index metadata
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
