import * as path from 'path';
import { Worker } from 'worker_threads';
import {
  ClassHierarchyWorkerFileInput,
  ClassHierarchyWorkerFileResult,
  ClassHierarchyWorkerParseRequest,
  ClassHierarchyWorkerResponse,
  isClassHierarchyWorkerResponse,
} from './classHierarchyWorker';

const MAX_WORKERS = 2;
const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_STARTUP_TIMEOUT_MS = 5000;

export type ClassHierarchyWorkerPoolErrorCode =
  | 'unavailable'
  | 'worker-failed'
  | 'protocol'
  | 'cancelled'
  | 'terminated';

export class ClassHierarchyWorkerPoolError extends Error {
  constructor(
    message: string,
    readonly code: ClassHierarchyWorkerPoolErrorCode,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ClassHierarchyWorkerPoolError';
  }
}

export function shouldFallbackFromClassHierarchyWorker(error: unknown): boolean {
  return (
    error instanceof ClassHierarchyWorkerPoolError &&
    (error.code === 'unavailable' ||
      error.code === 'worker-failed' ||
      error.code === 'protocol')
  );
}

export interface ClassHierarchyWorkerLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): number | Promise<number>;
}

export interface ClassHierarchyWorkerPoolOptions {
  workerScript?: string | URL;
  maxWorkers?: number;
  batchSize?: number;
  startupTimeoutMs?: number;
  workerFactory?: (workerScript: string | URL) => ClassHierarchyWorkerLike;
}

type TaskState = 'queued' | 'running' | 'settled';

interface ParseOperation {
  tasks: Set<ParseTask>;
  aborted: boolean;
}

interface ParseTask {
  requestId: number;
  files: ClassHierarchyWorkerFileInput[];
  operation: ParseOperation;
  state: TaskState;
  resolve(value: ClassHierarchyWorkerFileResult[]): void;
  reject(error: ClassHierarchyWorkerPoolError): void;
}

interface WorkerSlot {
  worker: ClassHierarchyWorkerLike;
  ready: boolean;
  dead: boolean;
  current?: ParseTask;
  startupTimer?: ReturnType<typeof setTimeout>;
}

/** A small worker_threads pool dedicated to CPU-only class-header parsing. */
export class ClassHierarchyWorkerPool {
  private readonly workerScript: string | URL;
  private readonly maxWorkers: number;
  private readonly batchSize: number;
  private readonly startupTimeoutMs: number;
  private readonly workerFactory: (workerScript: string | URL) => ClassHierarchyWorkerLike;
  private readonly queue: ParseTask[] = [];
  private readonly slots: WorkerSlot[] = [];
  private nextRequestId = 1;
  private creationDisabled = false;
  private unavailableError: ClassHierarchyWorkerPoolError | undefined;
  private terminated = false;

  constructor(options: ClassHierarchyWorkerPoolOptions = {}) {
    this.workerScript = options.workerScript ?? path.join(__dirname, 'classHierarchyWorker.js');
    this.maxWorkers = positiveInteger(options.maxWorkers, MAX_WORKERS, MAX_WORKERS);
    this.batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
    this.startupTimeoutMs = positiveInteger(
      options.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS
    );
    this.workerFactory = options.workerFactory ?? ((workerScript) => new Worker(workerScript));
  }

  async parseFiles(
    files: readonly ClassHierarchyWorkerFileInput[],
    signal?: AbortSignal
  ): Promise<ClassHierarchyWorkerFileResult[]> {
    if (this.terminated) {
      throw poolError('Class hierarchy worker pool has been terminated.', 'terminated');
    }
    if (this.unavailableError) {
      throw this.unavailableError;
    }
    if (signal?.aborted) {
      throw poolError('Class hierarchy worker parsing was cancelled.', 'cancelled');
    }
    if (files.length === 0) {
      return [];
    }

    const operation: ParseOperation = { tasks: new Set(), aborted: false };
    const promises: Array<Promise<ClassHierarchyWorkerFileResult[]>> = [];
    for (let offset = 0; offset < files.length; offset += this.batchSize) {
      const batch = files.slice(offset, offset + this.batchSize);
      promises.push(new Promise((resolve, reject) => {
        const task: ParseTask = {
          requestId: this.nextRequestId++,
          files: batch,
          operation,
          state: 'queued',
          resolve,
          reject,
        };
        operation.tasks.add(task);
        this.queue.push(task);
      }));
    }

    const onAbort = () => {
      operation.aborted = true;
      this.failOperation(
        operation,
        poolError('Class hierarchy worker parsing was cancelled.', 'cancelled')
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    this.ensureWorkers();
    this.pump();

    try {
      const batches = await Promise.all(promises);
      return batches.flat();
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async terminate(): Promise<void> {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    const error = poolError('Class hierarchy worker pool was terminated.', 'terminated');
    for (const task of [...this.queue]) {
      this.settleTask(task, error);
    }
    this.queue.length = 0;

    const slots = this.slots.splice(0);
    const terminations: Array<Promise<unknown>> = [];
    for (const slot of slots) {
      slot.dead = true;
      if (slot.startupTimer) {
        clearTimeout(slot.startupTimer);
      }
      if (slot.current) {
        this.settleTask(slot.current, error);
        slot.current = undefined;
      }
      try {
        terminations.push(Promise.resolve(slot.worker.terminate()).catch(() => undefined));
      } catch {
        // A worker that already failed may throw during termination.
      }
    }
    await Promise.all(terminations);
  }

  private ensureWorkers(): void {
    if (this.terminated || this.creationDisabled || this.queue.length === 0) {
      return;
    }
    const running = this.slots.filter((slot) => !!slot.current).length;
    const desired = Math.min(this.maxWorkers, this.queue.length + running);
    while (this.slots.length < desired) {
      if (!this.createWorker()) {
        break;
      }
    }
  }

  private createWorker(): boolean {
    let worker: ClassHierarchyWorkerLike;
    try {
      worker = this.workerFactory(this.workerScript);
    } catch (error) {
      this.creationDisabled = true;
      if (this.slots.length === 0) {
        this.unavailableError = poolError(
          'Unable to start the class hierarchy worker.',
          'unavailable',
          error
        );
        this.failQueued(this.unavailableError);
      }
      return false;
    }

    const slot: WorkerSlot = { worker, ready: false, dead: false };
    this.slots.push(slot);
    worker.on('message', (message) => this.handleMessage(slot, message));
    worker.on('error', (error) => {
      this.failSlot(
        slot,
        poolError(`Class hierarchy worker failed: ${error.message}`, 'worker-failed', error)
      );
    });
    worker.on('exit', (code) => {
      if (!slot.dead) {
        this.failSlot(
          slot,
          poolError(`Class hierarchy worker exited unexpectedly (code ${code}).`, 'worker-failed')
        );
      }
    });
    slot.startupTimer = setTimeout(() => {
      this.failSlot(
        slot,
        poolError('Class hierarchy worker did not become ready in time.', 'unavailable')
      );
    }, this.startupTimeoutMs);
    return true;
  }

  private handleMessage(slot: WorkerSlot, message: unknown): void {
    if (slot.dead) {
      return;
    }
    if (!isClassHierarchyWorkerResponse(message)) {
      this.failSlot(slot, poolError('Class hierarchy worker sent an invalid response.', 'protocol'));
      return;
    }
    const response: ClassHierarchyWorkerResponse = message;
    if (response.type === 'ready') {
      if (!slot.ready) {
        slot.ready = true;
        if (slot.startupTimer) {
          clearTimeout(slot.startupTimer);
          slot.startupTimer = undefined;
        }
        this.pump();
      }
      return;
    }

    const task = slot.current;
    if (!task || response.requestId !== task.requestId) {
      this.failSlot(
        slot,
        poolError('Class hierarchy worker response did not match its request.', 'protocol')
      );
      return;
    }
    slot.current = undefined;

    if (response.type === 'error') {
      const error = poolError(
        `Class hierarchy worker could not parse its batch: ${response.error}`,
        'worker-failed'
      );
      this.failOperation(task.operation, error);
    } else if (task.state !== 'settled') {
      task.state = 'settled';
      task.operation.tasks.delete(task);
      task.resolve(response.files);
    }

    this.ensureWorkers();
    this.pump();
  }

  private pump(): void {
    if (this.terminated) {
      return;
    }
    for (const slot of this.slots) {
      if (!slot.ready || slot.dead || slot.current) {
        continue;
      }
      let task: ParseTask | undefined;
      while (this.queue.length > 0 && !task) {
        const candidate = this.queue.shift()!;
        if (candidate.state === 'queued' && !candidate.operation.aborted) {
          task = candidate;
        }
      }
      if (!task) {
        continue;
      }

      task.state = 'running';
      slot.current = task;
      const request: ClassHierarchyWorkerParseRequest = {
        type: 'parse',
        requestId: task.requestId,
        files: task.files,
      };
      try {
        slot.worker.postMessage(request);
      } catch (error) {
        this.failSlot(
          slot,
          poolError('Unable to send work to the class hierarchy worker.', 'worker-failed', error)
        );
      }
    }
  }

  private failSlot(slot: WorkerSlot, error: ClassHierarchyWorkerPoolError): void {
    if (slot.dead) {
      return;
    }
    slot.dead = true;
    if (slot.startupTimer) {
      clearTimeout(slot.startupTimer);
    }
    const index = this.slots.indexOf(slot);
    if (index >= 0) {
      this.slots.splice(index, 1);
    }
    if (slot.current) {
      this.failOperation(slot.current.operation, error);
      slot.current = undefined;
    }
    try {
      void Promise.resolve(slot.worker.terminate()).catch(() => undefined);
    } catch {
      // Worker is already gone.
    }

    if (this.slots.length === 0) {
      this.creationDisabled = true;
      this.unavailableError = error;
      this.failQueued(error);
    } else {
      this.pump();
    }
  }

  private failOperation(operation: ParseOperation, error: ClassHierarchyWorkerPoolError): void {
    for (const task of [...operation.tasks]) {
      this.settleTask(task, error);
    }
    this.removeSettledQueueTasks();
  }

  private failQueued(error: ClassHierarchyWorkerPoolError): void {
    for (const task of [...this.queue]) {
      this.settleTask(task, error);
    }
    this.queue.length = 0;
  }

  private settleTask(task: ParseTask, error: ClassHierarchyWorkerPoolError): void {
    if (task.state === 'settled') {
      return;
    }
    task.state = 'settled';
    task.operation.tasks.delete(task);
    task.reject(error);
  }

  private removeSettledQueueTasks(): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].state === 'settled') {
        this.queue.splice(i, 1);
      }
    }
  }
}

function poolError(
  message: string,
  code: ClassHierarchyWorkerPoolErrorCode,
  cause?: unknown
): ClassHierarchyWorkerPoolError {
  return new ClassHierarchyWorkerPoolError(message, code, cause === undefined ? undefined : { cause });
}

function positiveInteger(value: number | undefined, fallback: number, maximum?: number): number {
  const resolved = value !== undefined && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
  return maximum === undefined ? resolved : Math.min(maximum, resolved);
}
