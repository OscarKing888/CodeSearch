import { SearchHit, SearchStreamBatch } from '../types';

export const FIRST_BATCH_SIZE = 50;
export const STREAM_BATCH_SIZE = 500;
/** Max hits per resultsPartial postMessage after the first batch (webview DOM budget). */
export const UI_POST_CHUNK_SIZE = 100;
/** @deprecated Use FIRST_BATCH_SIZE / STREAM_BATCH_SIZE */
export const SEARCH_BATCH_SIZE = STREAM_BATCH_SIZE;

const YIELD_INTERVAL_MS = 16;

export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export class StreamYieldThrottle {
  private lastYieldMs = 0;

  async maybeYield(): Promise<void> {
    const now = Date.now();
    if (now - this.lastYieldMs >= YIELD_INTERVAL_MS) {
      this.lastYieldMs = now;
      await yieldToEventLoop();
    }
  }
}

export class HitStreamBuffer {
  private pending: SearchHit[] = [];
  private allHits: SearchHit[] = [];
  private fileSet = new Set<string>();
  private firstBatchEmitted = false;

  add(hit: SearchHit): SearchHit[] | null {
    this.fileSet.add(hit.path);
    this.pending.push(hit);
    this.allHits.push(hit);
    const threshold = this.firstBatchEmitted ? STREAM_BATCH_SIZE : FIRST_BATCH_SIZE;
    if (this.pending.length >= threshold) {
      const batch = this.pending;
      this.pending = [];
      this.firstBatchEmitted = true;
      return batch;
    }
    return null;
  }

  flush(): SearchHit[] {
    const batch = this.pending;
    this.pending = [];
    if (batch.length > 0) {
      this.firstBatchEmitted = true;
    }
    return batch;
  }

  getHitCount(): number {
    return this.allHits.length;
  }

  getFileCount(): number {
    return this.fileSet.size;
  }

  getHitKeys(): Set<string> {
    return new Set(this.allHits.map((h) => `${h.path}:${h.line}:${h.matchStart}`));
  }
}

export function makeStreamBatch(
  hits: SearchHit[],
  done: boolean,
  buffer: HitStreamBuffer,
  startMs: number,
  query: string,
  partialIndex: boolean
): SearchStreamBatch {
  return {
    hits,
    done,
    hitCount: buffer.getHitCount(),
    fileCount: buffer.getFileCount(),
    elapsedMs: Date.now() - startMs,
    query,
    partialIndex,
  };
}
