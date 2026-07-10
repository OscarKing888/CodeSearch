export type ResultsPartialAckOutcome = 'ack' | 'timeout' | 'cancelled';

interface ResultsPartialAckWaiter {
  searchId: number;
  chunkId: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (outcome: ResultsPartialAckOutcome) => void;
}

/**
 * Tracks the single in-flight UI chunk. Ack identity is part of the protocol so
 * a late message or timeout from an older search cannot release a newer chunk.
 */
export class ResultsPartialAckController {
  private waiter: ResultsPartialAckWaiter | undefined;

  waitFor(searchId: number, chunkId: number, timeoutMs: number): Promise<ResultsPartialAckOutcome> {
    this.cancelActive();

    return new Promise((resolve) => {
      const waiter: ResultsPartialAckWaiter = {
        searchId,
        chunkId,
        resolve,
      };
      waiter.timer = setTimeout(() => this.settle(waiter, 'timeout'), timeoutMs);
      this.waiter = waiter;
    });
  }

  acknowledge(searchId: number, chunkId: number): boolean {
    const waiter = this.waiter;
    if (!waiter || waiter.searchId !== searchId || waiter.chunkId !== chunkId) {
      return false;
    }
    this.settle(waiter, 'ack');
    return true;
  }

  cancel(searchId: number, chunkId: number): boolean {
    const waiter = this.waiter;
    if (!waiter || waiter.searchId !== searchId || waiter.chunkId !== chunkId) {
      return false;
    }
    this.settle(waiter, 'cancelled');
    return true;
  }

  cancelActive(): void {
    const waiter = this.waiter;
    if (waiter) {
      this.settle(waiter, 'cancelled');
    }
  }

  private settle(waiter: ResultsPartialAckWaiter, outcome: ResultsPartialAckOutcome): void {
    if (this.waiter !== waiter) {
      return;
    }
    if (waiter.timer) {
      clearTimeout(waiter.timer);
    }
    this.waiter = undefined;
    waiter.resolve(outcome);
  }
}
