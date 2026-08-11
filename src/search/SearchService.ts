import * as path from 'path';
import { SqliteDatabase } from '../native/betterSqlite3';
import { IndexService } from '../index/IndexService';
import {
  buildFtsMatch,
  contentMatchesFilter,
  parseQuery,
  pathMatchesFilter,
} from './QueryParser';
import { findLooseHits } from './LooseSearch';
import { fuzzyMatch } from './FuzzyMatch';
import { findWildcardHits } from './WildcardMatcher';
import { ParsedQuery, SearchHit, SearchOptions, SearchResult, SearchStreamBatch } from '../types';
import {
  HitStreamBuffer,
  makeStreamBatch,
  StreamYieldThrottle,
} from './searchStreamBuffer';
import { profileMark } from '../utils/searchProfile';

type CandidateRow = {
  path: string;
  content: string;
  ext: string;
  dir: string;
  mtime: number;
};

type CandidateQuery = { kind: 'stmt'; sql: string; params: (string | number)[] };

export class SearchService {
  constructor(
    private indexService: IndexService,
    private readonly mapPath: (indexedPath: string) => string = (indexedPath) => indexedPath
  ) {}

  search(queryText: string, options: SearchOptions): SearchResult {
    const start = Date.now();
    const db = this.indexService.getDatabase();
    if (!db) {
      return emptyResult(queryText, start, true);
    }

    const parsed = parseQuery(
      queryText,
      options.phraseSearch,
      options.looseGap,
      options.regex ?? false
    );
    const partialIndex = this.indexService.isPartialIndex();

    if (options.loose && !parsed.loose) {
      parsed.loose = true;
      parsed.looseGap = options.looseGap;
    }

    if (parsed.filterOnly) {
      return this.filterOnlySearch(db, parsed, options, start, partialIndex);
    }

    if (parsed.terms.length === 0) {
      return emptyResult(queryText, start, partialIndex);
    }

    this.indexService.pause();

    try {
      let hits: SearchHit[];

      if (options.regex) {
        hits = this.regexSearch(db, parsed, options);
      } else if (parsed.multiWildcard && parsed.terms.length === 1) {
        hits = this.wildcardSearch(db, parsed, options);
      } else if (parsed.loose) {
        hits = this.looseSearch(db, parsed, options);
      } else {
        hits = this.standardSearch(db, parsed, options);
      }

      const fileSet = new Set(hits.map((h) => h.path));
      return {
        hits,
        hitCount: hits.length,
        fileCount: fileSet.size,
        elapsedMs: Date.now() - start,
        query: queryText,
        partialIndex,
      };
    } finally {
      this.indexService.resume();
    }
  }

  async *searchStreaming(
    queryText: string,
    options: SearchOptions,
    signal?: AbortSignal
  ): AsyncGenerator<SearchStreamBatch> {
    const start = Date.now();
    const db = this.indexService.getDatabase();
    if (!db) {
      yield emptyStreamBatch(queryText, start, true);
      return;
    }

    const parsed = parseQuery(
      queryText,
      options.phraseSearch,
      options.looseGap,
      options.regex ?? false
    );
    const partialIndex = this.indexService.isPartialIndex();

    if (options.loose && !parsed.loose) {
      parsed.loose = true;
      parsed.looseGap = options.looseGap;
    }

    this.indexService.pause();

    try {
      if (parsed.filterOnly) {
        profileMark('search_streaming_start', { path: 'filterOnly' });
        yield* this.filterOnlySearchStreaming(
          db,
          parsed,
          options,
          start,
          partialIndex,
          signal
        );
        return;
      }

      if (parsed.terms.length === 0) {
        profileMark('search_streaming_start', { path: 'empty' });
        yield emptyStreamBatch(queryText, start, partialIndex);
        return;
      }

      if (options.regex) {
        profileMark('search_streaming_start', { path: 'regex' });
        yield* this.regexSearchStreaming(db, parsed, options, start, partialIndex, signal);
        return;
      }

      if (parsed.multiWildcard && parsed.terms.length === 1) {
        profileMark('search_streaming_start', { path: 'wildcard' });
        yield* this.wildcardSearchStreaming(
          db,
          parsed,
          options,
          start,
          partialIndex,
          signal
        );
        return;
      }

      if (parsed.loose) {
        profileMark('search_streaming_start', { path: 'loose' });
        yield* this.looseSearchStreaming(
          db,
          parsed,
          options,
          start,
          partialIndex,
          signal
        );
        return;
      }

      profileMark('search_streaming_start', { path: 'standard' });
      yield* this.standardSearchStreaming(
        db,
        parsed,
        options,
        start,
        partialIndex,
        signal
      );
    } finally {
      profileMark('search_streaming_done');
      this.indexService.resume();
    }
  }

  private makeProfileStreamBatch(
    hits: SearchHit[],
    done: boolean,
    buffer: HitStreamBuffer,
    start: number,
    query: string,
    partialIndex: boolean
  ): SearchStreamBatch {
    const batch = makeStreamBatch(hits, done, buffer, start, query, partialIndex);
    profileMark('search_batch_yield', {
      batchHits: batch.hits.length,
      hitCount: batch.hitCount,
      fileCount: batch.fileCount,
      done: batch.done,
    });
    return batch;
  }

  private async *standardSearchStreaming(
    db: SqliteDatabase,
    parsed: ParsedQuery,
    options: SearchOptions,
    start: number,
    partialIndex: boolean,
    signal?: AbortSignal
  ): AsyncGenerator<SearchStreamBatch> {
    const useSubstring = shouldUseSubstringCandidates(parsed);
    const ftsQuery = useSubstring ? '' : buildFtsMatch(parsed.terms, parsed.phrase);
    if (!useSubstring && !ftsQuery) {
      yield emptyStreamBatch(parsed.raw, start, partialIndex);
      return;
    }
    if (useSubstring && parsed.terms.length === 0) {
      yield emptyStreamBatch(parsed.raw, start, partialIndex);
      return;
    }

    yield* this.executeFtsSearchStreaming(
      db,
      ftsQuery,
      parsed,
      options,
      start,
      partialIndex,
      signal
    );
  }

  private async *looseSearchStreaming(
    db: SqliteDatabase,
    parsed: ParsedQuery,
    options: SearchOptions,
    start: number,
    partialIndex: boolean,
    signal?: AbortSignal
  ): AsyncGenerator<SearchStreamBatch> {
    const yieldThrottle = new StreamYieldThrottle();
    const looseTerms = parsed.terms.flatMap((t) =>
      parsed.phrase ? t.split(/\s+/).filter(Boolean) : [t]
    );
    const ftsQuery = buildFtsMatch(looseTerms, false, true);
    const buffer = new HitStreamBuffer();

    for await (const row of this.iterateCandidateRows(db, ftsQuery, parsed, signal)) {
      if (signal?.aborted) {
        return;
      }
      if (!this.rowPassesFilters(row, parsed, options.caseSensitive)) {
        continue;
      }

      const looseHits = findLooseHits(
        row.content,
        looseTerms,
        parsed.looseGap,
        options.caseSensitive,
        options.fuzzy
      );

      for (const lh of looseHits) {
        const batch = buffer.add({
          path: row.path,
          line: lh.line,
          column: lh.column,
          lineText: lh.lineText,
          contextBefore: this.contextBefore(row.content, lh.line, options.contextLines),
          contextAfter: this.contextAfter(row.content, lh.line, options.contextLines),
          matchStart: lh.matchStart,
          matchEnd: lh.matchEnd,
        });
        if (batch) {
          yield this.makeProfileStreamBatch(batch, false, buffer, start, parsed.raw, partialIndex);
          await yieldThrottle.maybeYield();
        }
        if (buffer.getHitCount() >= options.maxResults) {
          yield* this.finalizeStreamBatch(buffer, start, parsed.raw, partialIndex, yieldThrottle);
          return;
        }
      }
    }

    yield* this.finalizeStreamBatch(buffer, start, parsed.raw, partialIndex, yieldThrottle);
  }

  private async *wildcardSearchStreaming(
    db: SqliteDatabase,
    parsed: ParsedQuery,
    options: SearchOptions,
    start: number,
    partialIndex: boolean,
    signal?: AbortSignal
  ): AsyncGenerator<SearchStreamBatch> {
    const yieldThrottle = new StreamYieldThrottle();
    const pattern = parsed.terms[0];
    const literalParts = pattern.split(/\s*\*(?::\d+)?\s*/).filter(Boolean);
    const ftsQuery = buildFtsMatch(literalParts, false, true);
    const buffer = new HitStreamBuffer();

    for await (const row of this.iterateCandidateRows(
      db,
      ftsQuery || pattern.replace(/\*/g, ''),
      parsed,
      signal
    )) {
      if (signal?.aborted) {
        return;
      }
      if (!this.rowPassesFilters(row, parsed, options.caseSensitive)) {
        continue;
      }

      const wcHits = findWildcardHits(row.content, pattern, options.caseSensitive);
      for (const wh of wcHits) {
        const batch = buffer.add({
          path: row.path,
          line: wh.line,
          column: wh.column,
          lineText: wh.lineText,
          contextBefore: this.contextBefore(row.content, wh.line, options.contextLines),
          contextAfter: this.contextAfter(row.content, wh.line, options.contextLines),
          matchStart: wh.matchStart,
          matchEnd: wh.matchEnd,
        });
        if (batch) {
          yield this.makeProfileStreamBatch(batch, false, buffer, start, parsed.raw, partialIndex);
          await yieldThrottle.maybeYield();
        }
        if (buffer.getHitCount() >= options.maxResults) {
          yield* this.finalizeStreamBatch(buffer, start, parsed.raw, partialIndex, yieldThrottle);
          return;
        }
      }
    }

    yield* this.finalizeStreamBatch(buffer, start, parsed.raw, partialIndex, yieldThrottle);
  }

  private async *regexSearchStreaming(
    db: SqliteDatabase,
    parsed: ParsedQuery,
    options: SearchOptions,
    start: number,
    partialIndex: boolean,
    signal?: AbortSignal
  ): AsyncGenerator<SearchStreamBatch> {
    const regex = this.compileRegex(parsed.terms[0] ?? '', options.caseSensitive);
    const yieldThrottle = new StreamYieldThrottle();
    const buffer = new HitStreamBuffer();

    for await (const row of this.iterateCandidateRows(db, '', parsed, signal)) {
      if (signal?.aborted) {
        return;
      }
      if (!this.rowPassesFilters(row, parsed, options.caseSensitive)) {
        continue;
      }

      for await (const hit of this.iterateRegexHitsStreaming(
        row.path,
        row.content,
        regex,
        options.contextLines,
        options.maxResults - buffer.getHitCount(),
        signal
      )) {
        if (signal?.aborted) {
          return;
        }
        const batch = buffer.add(hit);
        if (batch) {
          yield this.makeProfileStreamBatch(
            batch,
            false,
            buffer,
            start,
            parsed.raw,
            partialIndex
          );
          await yieldThrottle.maybeYield();
        }
        if (buffer.getHitCount() >= options.maxResults) {
          yield* this.finalizeStreamBatch(
            buffer,
            start,
            parsed.raw,
            partialIndex,
            yieldThrottle
          );
          return;
        }
      }
    }

    if (!signal?.aborted) {
      yield* this.finalizeStreamBatch(
        buffer,
        start,
        parsed.raw,
        partialIndex,
        yieldThrottle
      );
    }
  }

  private async *filterOnlySearchStreaming(
    db: SqliteDatabase,
    parsed: ParsedQuery,
    options: SearchOptions,
    start: number,
    partialIndex: boolean,
    signal?: AbortSignal
  ): AsyncGenerator<SearchStreamBatch> {
    const yieldThrottle = new StreamYieldThrottle();
    const buffer = new HitStreamBuffer();
    const seenFiles = new Set<string>();

    for await (const row of this.iterateCandidateRows(db, '', parsed, signal)) {
      if (signal?.aborted) {
        return;
      }
      if (!this.rowPassesFilters(row, parsed, options.caseSensitive)) {
        continue;
      }
      if (seenFiles.has(row.path)) {
        continue;
      }
      seenFiles.add(row.path);

      const lines = row.content.split(/\r?\n/);
      const lineText = lines[0] ?? '';
      const batch = buffer.add({
        path: row.path,
        line: 1,
        column: 1,
        lineText,
        contextBefore: [],
        contextAfter: lines.slice(1, 1 + options.contextLines),
        matchStart: 0,
        matchEnd: 0,
      });
      if (batch) {
        yield this.makeProfileStreamBatch(batch, false, buffer, start, parsed.raw, partialIndex);
        await yieldThrottle.maybeYield();
      }
      if (buffer.getHitCount() >= options.maxResults) {
        yield* this.finalizeStreamBatch(buffer, start, parsed.raw, partialIndex, yieldThrottle);
        return;
      }
    }

    yield* this.finalizeStreamBatch(buffer, start, parsed.raw, partialIndex, yieldThrottle);
  }

  private async *executeFtsSearchStreaming(
    db: SqliteDatabase,
    ftsQuery: string,
    parsed: ParsedQuery,
    options: SearchOptions,
    start: number,
    partialIndex: boolean,
    signal?: AbortSignal
  ): AsyncGenerator<SearchStreamBatch> {
    const yieldThrottle = new StreamYieldThrottle();
    const buffer = new HitStreamBuffer();
    const searchTerms = parsed.terms.flatMap((t) =>
      parsed.phrase && !parsed.multiWildcard ? [t] : t.split(/\s+/).filter(Boolean)
    );
    const candidateQuery = shouldUseSubstringCandidates(parsed)
      ? this.buildSubstringCandidateQuery(searchTerms, options.caseSensitive, parsed)
      : null;

    for await (const row of this.iterateCandidateRows(
      db,
      ftsQuery,
      parsed,
      signal,
      candidateQuery
    )) {
      if (signal?.aborted) {
        return;
      }
      if (!this.rowPassesFilters(row, parsed, options.caseSensitive)) {
        continue;
      }

      const fileHits = this.findHitsInContent(
        row.path,
        row.content,
        searchTerms,
        parsed.phrase && !parsed.multiWildcard,
        options.caseSensitive,
        options.contextLines,
        options.fuzzy
      );

      for (const hit of fileHits) {
        const batch = buffer.add(hit);
        if (batch) {
          yield this.makeProfileStreamBatch(batch, false, buffer, start, parsed.raw, partialIndex);
          await yieldThrottle.maybeYield();
        }
        if (buffer.getHitCount() >= options.maxResults) {
          yield* this.finalizeStreamBatch(buffer, start, parsed.raw, partialIndex, yieldThrottle);
          return;
        }
      }
    }

    if (signal?.aborted) {
      return;
    }

    if (options.fuzzy && buffer.getHitCount() < options.maxResults) {
      const primaryKeys = buffer.getHitKeys();
      const fuzzyHits = this.fuzzyContentSearch(db, parsed, {
        ...options,
        maxResults: options.maxResults - buffer.getHitCount(),
      }, signal);
      for (const hit of fuzzyHits) {
        const key = `${hit.path}:${hit.line}:${hit.matchStart}`;
        if (primaryKeys.has(key)) {
          continue;
        }
        primaryKeys.add(key);
        const batch = buffer.add(hit);
        if (batch) {
          yield this.makeProfileStreamBatch(batch, false, buffer, start, parsed.raw, partialIndex);
          await yieldThrottle.maybeYield();
        }
        if (buffer.getHitCount() >= options.maxResults) {
          break;
        }
      }
    }

    if (!signal?.aborted) {
      yield* this.finalizeStreamBatch(buffer, start, parsed.raw, partialIndex, yieldThrottle);
    }
  }

  private async *finalizeStreamBatch(
    buffer: HitStreamBuffer,
    start: number,
    query: string,
    partialIndex: boolean,
    yieldThrottle: StreamYieldThrottle = new StreamYieldThrottle()
  ): AsyncGenerator<SearchStreamBatch> {
    const tail = buffer.flush();
    yield this.makeProfileStreamBatch(tail, true, buffer, start, query, partialIndex);
    if (tail.length > 0) {
      await yieldThrottle.maybeYield();
    }
  }

  private standardSearch(
    db: SqliteDatabase,
    parsed: ParsedQuery,
    options: SearchOptions
  ): SearchHit[] {
    const useSubstring = shouldUseSubstringCandidates(parsed);
    const ftsQuery = useSubstring ? '' : buildFtsMatch(parsed.terms, parsed.phrase);
    if (!useSubstring && !ftsQuery) {
      return [];
    }
    if (useSubstring && parsed.terms.length === 0) {
      return [];
    }

    let hits = this.executeFtsSearch(db, ftsQuery, parsed, options);

    if (options.fuzzy && hits.length < options.maxResults) {
      const fuzzyHits = this.fuzzyContentSearch(db, parsed, options);
      hits = mergeHits(hits, fuzzyHits, options.maxResults);
    }

    return hits.slice(0, options.maxResults);
  }

  private regexSearch(
    db: SqliteDatabase,
    parsed: ParsedQuery,
    options: SearchOptions
  ): SearchHit[] {
    const regex = this.compileRegex(parsed.terms[0] ?? '', options.caseSensitive);
    const hits: SearchHit[] = [];

    for (const row of this.iterateCandidateRowsSync(db, '', parsed)) {
      if (!this.rowPassesFilters(row, parsed, options.caseSensitive)) {
        continue;
      }
      hits.push(
        ...this.findRegexHits(
          row.path,
          row.content,
          regex,
          options.contextLines,
          options.maxResults - hits.length
        )
      );
      if (hits.length >= options.maxResults) {
        break;
      }
    }
    return hits.slice(0, options.maxResults);
  }

  private looseSearch(
    db: SqliteDatabase,
    parsed: ParsedQuery,
    options: SearchOptions
  ): SearchHit[] {
    const looseTerms = parsed.terms.flatMap((t) =>
      parsed.phrase ? t.split(/\s+/).filter(Boolean) : [t]
    );

    const ftsQuery = buildFtsMatch(looseTerms, false, true);
    const hits: SearchHit[] = [];
    for (const row of this.iterateCandidateRowsSync(db, ftsQuery, parsed)) {
      if (!this.rowPassesFilters(row, parsed, options.caseSensitive)) {
        continue;
      }

      const looseHits = findLooseHits(
        row.content,
        looseTerms,
        parsed.looseGap,
        options.caseSensitive,
        options.fuzzy
      );

      for (const lh of looseHits) {
        hits.push({
          path: row.path,
          line: lh.line,
          column: lh.column,
          lineText: lh.lineText,
          contextBefore: this.contextBefore(row.content, lh.line, options.contextLines),
          contextAfter: this.contextAfter(row.content, lh.line, options.contextLines),
          matchStart: lh.matchStart,
          matchEnd: lh.matchEnd,
        });
        if (hits.length >= options.maxResults) {
          return hits;
        }
      }
    }
    return hits;
  }

  private wildcardSearch(
    db: SqliteDatabase,
    parsed: ParsedQuery,
    options: SearchOptions
  ): SearchHit[] {
    const pattern = parsed.terms[0];
    const literalParts = pattern.split(/\s*\*(?::\d+)?\s*/).filter(Boolean);
    const ftsQuery = buildFtsMatch(literalParts, false, true);
    const hits: SearchHit[] = [];
    for (const row of this.iterateCandidateRowsSync(
      db,
      ftsQuery || pattern.replace(/\*/g, ''),
      parsed
    )) {
      if (!this.rowPassesFilters(row, parsed, options.caseSensitive)) {
        continue;
      }

      const wcHits = findWildcardHits(row.content, pattern, options.caseSensitive);
      for (const wh of wcHits) {
        hits.push({
          path: row.path,
          line: wh.line,
          column: wh.column,
          lineText: wh.lineText,
          contextBefore: this.contextBefore(row.content, wh.line, options.contextLines),
          contextAfter: this.contextAfter(row.content, wh.line, options.contextLines),
          matchStart: wh.matchStart,
          matchEnd: wh.matchEnd,
        });
        if (hits.length >= options.maxResults) {
          return hits;
        }
      }
    }
    return hits;
  }

  private fuzzyContentSearch(
    db: SqliteDatabase,
    parsed: ParsedQuery,
    options: SearchOptions,
    signal?: AbortSignal
  ): SearchHit[] {
    const term = parsed.terms[0] ?? '';
    if (!term || term.includes('*')) {
      return [];
    }

    const hits: SearchHit[] = [];

    for (const row of this.iterateCandidateRowsSync(
      db,
      buildFtsMatch([term.slice(0, 3)], false),
      parsed
    )) {
      if (signal?.aborted) {
        return hits;
      }
      if (!this.rowPassesFilters(row, parsed, options.caseSensitive)) {
        continue;
      }

      const lines = row.content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const words = line.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [];
        for (const word of words) {
          if (fuzzyMatch(term, word, options.caseSensitive)) {
            const idx = line.indexOf(word);
            hits.push({
              path: row.path,
              line: i + 1,
              column: idx + 1,
              lineText: line,
              contextBefore: lines.slice(Math.max(0, i - options.contextLines), i),
              contextAfter: lines.slice(i + 1, i + 1 + options.contextLines),
              matchStart: idx,
              matchEnd: idx + word.length,
            });
            if (hits.length >= options.maxResults) {
              return hits;
            }
          }
        }
      }
    }
    return hits;
  }

  private buildCandidateQuery(
    ftsQuery: string,
    parsed: ParsedQuery
  ): CandidateQuery {
    const now = Date.now();

    if (!ftsQuery) {
      let sql = `SELECT path, content, ext, dir, mtime FROM files WHERE 1=1`;
      const params: (string | number)[] = [];
      sql += this.buildMtimeFilter(parsed, now, params);
      return { kind: 'stmt', sql, params };
    }

    let sql = `
      SELECT f.path, f.content, f.ext, f.dir, f.mtime
      FROM files_fts
      JOIN files f ON f.path = files_fts.path
      WHERE files_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];
    sql += this.buildMtimeFilter(parsed, now, params, 'f');
    return { kind: 'stmt', sql, params };
  }

  /**
   * Coarse filter for Phrase Search OFF: each term must appear as a content
   * substring (AND). Avoids FTS unicode61 token boundaries so CJK/partial
   * identifier substrings can reach findHitsInContent.
   */
  private buildSubstringCandidateQuery(
    terms: string[],
    caseSensitive: boolean,
    parsed: ParsedQuery
  ): CandidateQuery {
    const params: (string | number)[] = [];
    let sql = 'SELECT path, content, ext, dir, mtime FROM files WHERE 1=1';
    for (const term of terms) {
      if (!term) {
        continue;
      }
      if (caseSensitive) {
        sql += ' AND INSTR(content, ?) > 0';
        params.push(term);
      } else {
        sql += ` AND content LIKE '%' || ? || '%' ESCAPE '\\'`;
        params.push(escapeLikePattern(term));
      }
    }
    sql += this.buildMtimeFilter(parsed, Date.now(), params);
    return { kind: 'stmt', sql, params };
  }

  private buildFallbackCandidateQuery(parsed: ParsedQuery): CandidateQuery {
    const params: (string | number)[] = [];
    let sql = 'SELECT path, content, ext, dir, mtime FROM files WHERE 1=1';
    sql += this.buildMtimeFilter(parsed, Date.now(), params);
    return { kind: 'stmt', sql, params };
  }

  private *iterateCandidateRowsSync(
    db: SqliteDatabase,
    ftsQuery: string,
    parsed: ParsedQuery,
    overrideQuery?: CandidateQuery | null
  ): Generator<CandidateRow> {
    const query = overrideQuery ?? this.buildCandidateQuery(ftsQuery, parsed);
    const iterateRows = function* (
      sql: string,
      params: (string | number)[]
    ): Generator<CandidateRow> {
      const stmt = db.prepare(sql);
      for (const row of stmt.iterate(...params)) {
        yield row as CandidateRow;
      }
    };

    try {
      yield* iterateRows(query.sql, query.params);
    } catch {
      const fallback = this.buildFallbackCandidateQuery(parsed);
      yield* iterateRows(fallback.sql, fallback.params);
    }
  }

  private async *iterateCandidateRows(
    db: SqliteDatabase,
    ftsQuery: string,
    parsed: ParsedQuery,
    signal?: AbortSignal,
    overrideQuery?: CandidateQuery | null
  ): AsyncGenerator<CandidateRow> {
    const yieldThrottle = new StreamYieldThrottle();
    const query = overrideQuery ?? this.buildCandidateQuery(ftsQuery, parsed);

    const iterateRows = async function* (
      sql: string,
      params: (string | number)[]
    ): AsyncGenerator<CandidateRow> {
      const stmt = db.prepare(sql);
      let rowIndex = 0;
      for (const row of stmt.iterate(...params)) {
        if (signal?.aborted) {
          return;
        }
        rowIndex++;
        if (rowIndex === 1) {
          profileMark('search_iterate_first_row', {
            rowIndex,
            path: (row as CandidateRow).path,
          });
        } else if (rowIndex % 100 === 0) {
          profileMark('search_iterate_row', {
            rowIndex,
            path: (row as CandidateRow).path,
          });
        }
        yield row as CandidateRow;
        await yieldThrottle.maybeYield();
      }
    };

    try {
      yield* iterateRows(query.sql, query.params);
    } catch {
      const fallback = this.buildFallbackCandidateQuery(parsed);
      yield* iterateRows(fallback.sql, fallback.params);
    }
  }

  private rowPassesFilters(
    row: { path: string; content: string; ext: string; dir: string },
    parsed: ParsedQuery,
    caseSensitive: boolean
  ): boolean {
    let mappedPath = row.path;
    try {
      mappedPath = this.mapPath(row.path);
    } catch {
      // Path mappings are a compatibility aid; a broken mapper must not make
      // the underlying indexed path unsearchable.
    }
    return (
      pathMatchesFilter(row.path, row.ext, row.dir, parsed.filters, mappedPath) &&
      contentMatchesFilter(row.content, parsed.filters, caseSensitive)
    );
  }

  private filterOnlySearch(
    db: SqliteDatabase,
    parsed: ParsedQuery,
    options: SearchOptions,
    start: number,
    partialIndex: boolean
  ): SearchResult {
    const hits: SearchHit[] = [];
    const seenFiles = new Set<string>();

    for (const row of this.iterateCandidateRowsSync(db, '', parsed)) {
      if (!this.rowPassesFilters(row, parsed, options.caseSensitive)) {
        continue;
      }
      if (seenFiles.has(row.path)) {
        continue;
      }
      seenFiles.add(row.path);

      const lines = row.content.split(/\r?\n/);
      const lineText = lines[0] ?? '';
      hits.push({
        path: row.path,
        line: 1,
        column: 1,
        lineText,
        contextBefore: [],
        contextAfter: lines.slice(1, 1 + options.contextLines),
        matchStart: 0,
        matchEnd: 0,
      });

      if (hits.length >= options.maxResults) {
        break;
      }
    }

    return {
      hits,
      hitCount: hits.length,
      fileCount: seenFiles.size,
      elapsedMs: Date.now() - start,
      query: parsed.raw,
      partialIndex,
    };
  }

  private executeFtsSearch(
    db: SqliteDatabase,
    ftsQuery: string,
    parsed: ParsedQuery,
    options: SearchOptions
  ): SearchHit[] {
    const hits: SearchHit[] = [];
    const searchTerms = parsed.terms.flatMap((t) =>
      parsed.phrase && !parsed.multiWildcard ? [t] : t.split(/\s+/).filter(Boolean)
    );
    const candidateQuery = shouldUseSubstringCandidates(parsed)
      ? this.buildSubstringCandidateQuery(searchTerms, options.caseSensitive, parsed)
      : null;

    for (const row of this.iterateCandidateRowsSync(db, ftsQuery, parsed, candidateQuery)) {
      if (!this.rowPassesFilters(row, parsed, options.caseSensitive)) {
        continue;
      }

      const fileHits = this.findHitsInContent(
        row.path,
        row.content,
        searchTerms,
        parsed.phrase && !parsed.multiWildcard,
        options.caseSensitive,
        options.contextLines,
        options.fuzzy
      );
      hits.push(...fileHits);

      if (hits.length >= options.maxResults) {
        break;
      }
    }

    return hits.slice(0, options.maxResults);
  }

  private compileRegex(pattern: string, caseSensitive: boolean): RegExp {
    try {
      return new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        message.toLowerCase().includes('invalid regular expression')
          ? message
          : `Invalid regular expression: ${message}`
      );
    }
  }

  private findRegexHits(
    filePath: string,
    content: string,
    regex: RegExp,
    contextLines: number,
    maxResults: number
  ): SearchHit[] {
    if (maxResults <= 0) {
      return [];
    }

    const hits: SearchHit[] = [];
    const lines = content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        hits.push(
          this.makeHit(
            filePath,
            lines,
            lineIndex,
            match.index,
            match.index + match[0].length,
            contextLines
          )
        );
        if (hits.length >= maxResults) {
          return hits;
        }
        if (match[0].length === 0) {
          regex.lastIndex = match.index + 1;
        }
      }
    }
    return hits;
  }

  private async *iterateRegexHitsStreaming(
    filePath: string,
    content: string,
    regex: RegExp,
    contextLines: number,
    maxResults: number,
    signal?: AbortSignal
  ): AsyncGenerator<SearchHit> {
    if (maxResults <= 0 || signal?.aborted) {
      return;
    }

    const lines = content.split(/\r?\n/);
    const yieldThrottle = new StreamYieldThrottle();
    let hitCount = 0;
    let workSinceYield = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      if (signal?.aborted) {
        return;
      }

      const line = lines[lineIndex];
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        yield this.makeHit(
          filePath,
          lines,
          lineIndex,
          match.index,
          match.index + match[0].length,
          contextLines
        );
        hitCount++;
        if (hitCount >= maxResults || signal?.aborted) {
          return;
        }
        if (match[0].length === 0) {
          regex.lastIndex = match.index + 1;
        }
        if (++workSinceYield >= 64) {
          workSinceYield = 0;
          await yieldThrottle.maybeYield();
          if (signal?.aborted) {
            return;
          }
        }
      }
      if (++workSinceYield >= 64) {
        workSinceYield = 0;
        await yieldThrottle.maybeYield();
        if (signal?.aborted) {
          return;
        }
      }
    }
  }

  private findHitsInContent(
    filePath: string,
    content: string,
    terms: string[],
    phrase: boolean,
    caseSensitive: boolean,
    contextLines: number,
    fuzzy: boolean
  ): SearchHit[] {
    const hits: SearchHit[] = [];
    const lines = content.split(/\r?\n/);

    if (phrase && terms.length === 1) {
      const phraseText = terms[0];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (fuzzy) {
          const words = line.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [];
          for (const word of words) {
            if (fuzzyMatch(phraseText, word, caseSensitive)) {
              const idx = line.indexOf(word);
              hits.push(this.makeHit(filePath, lines, i, idx, idx + word.length, contextLines));
            }
          }
        } else {
          const regex = this.termToRegex(phraseText, caseSensitive);
          const match = regex.exec(line);
          if (match) {
            hits.push(
              this.makeHit(filePath, lines, i, match.index, match.index + match[0].length, contextLines)
            );
          }
        }
      }
      return hits;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const term of terms) {
        if (fuzzy) {
          const words = line.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [];
          for (const word of words) {
            if (fuzzyMatch(term, word, caseSensitive)) {
              const idx = line.indexOf(word);
              hits.push(this.makeHit(filePath, lines, i, idx, idx + word.length, contextLines));
            }
          }
        } else {
          const regex = this.termToRegex(term, caseSensitive);
          let match: RegExpExecArray | null;
          while ((match = regex.exec(line)) !== null) {
            hits.push(
              this.makeHit(filePath, lines, i, match.index, match.index + match[0].length, contextLines)
            );
          }
        }
      }
    }
    return hits;
  }

  private termToRegex(term: string, caseSensitive: boolean): RegExp {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = escaped.replace(/\\\*/g, '[^\\s]*');
    const flags = caseSensitive ? 'g' : 'gi';
    return new RegExp(pattern, flags);
  }

  private makeHit(
    filePath: string,
    lines: string[],
    lineIndex: number,
    matchStart: number,
    matchEnd: number,
    contextLines: number
  ): SearchHit {
    return {
      path: filePath,
      line: lineIndex + 1,
      column: matchStart + 1,
      lineText: lines[lineIndex],
      contextBefore: lines.slice(Math.max(0, lineIndex - contextLines), lineIndex),
      contextAfter: lines.slice(lineIndex + 1, lineIndex + 1 + contextLines),
      matchStart,
      matchEnd,
    };
  }

  private contextBefore(content: string, line: number, n: number): string[] {
    const lines = content.split(/\r?\n/);
    return lines.slice(Math.max(0, line - 1 - n), line - 1);
  }

  private contextAfter(content: string, line: number, n: number): string[] {
    const lines = content.split(/\r?\n/);
    return lines.slice(line, line + n);
  }

  private buildMtimeFilter(
    parsed: ParsedQuery,
    now: number,
    params: (string | number)[],
    alias = ''
  ): string {
    const prefix = alias ? `${alias}.` : '';
    let sql = '';

    if (parsed.filters.ageMaxMs !== undefined) {
      sql += ` AND ${prefix}mtime >= ?`;
      params.push(now - parsed.filters.ageMaxMs);
    }
    if (parsed.filters.ageMinMs !== undefined) {
      sql += ` AND ${prefix}mtime < ?`;
      params.push(now - parsed.filters.ageMinMs);
    }
    return sql;
  }
}

function shouldUseSubstringCandidates(parsed: ParsedQuery): boolean {
  return (
    !parsed.phrase &&
    parsed.terms.length > 0 &&
    !parsed.terms.some((term) => term.includes('*'))
  );
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function emptyStreamBatch(query: string, start: number, partialIndex: boolean): SearchStreamBatch {
  return {
    hits: [],
    hitCount: 0,
    fileCount: 0,
    elapsedMs: Date.now() - start,
    query,
    partialIndex,
    done: true,
  };
}

function emptyResult(query: string, start: number, partialIndex: boolean): SearchResult {
  return {
    hits: [],
    hitCount: 0,
    fileCount: 0,
    elapsedMs: Date.now() - start,
    query,
    partialIndex,
  };
}

function mergeHits(primary: SearchHit[], extra: SearchHit[], max: number): SearchHit[] {
  const seen = new Set(primary.map((h) => `${h.path}:${h.line}:${h.matchStart}`));
  const merged = [...primary];
  for (const h of extra) {
    const key = `${h.path}:${h.line}:${h.matchStart}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(h);
      if (merged.length >= max) {
        break;
      }
    }
  }
  return merged;
}

export function getRelativePath(filePath: string, workspaceRoots: string[]): string {
  const normalized = filePath.replace(/\\/g, '/');
  for (const root of workspaceRoots) {
    const rootNorm = root.replace(/\\/g, '/');
    if (normalized.startsWith(rootNorm)) {
      return normalized.slice(rootNorm.length).replace(/^\//, '');
    }
  }
  return path.basename(filePath);
}
