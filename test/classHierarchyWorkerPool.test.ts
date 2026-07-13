import * as assert from 'assert';
import {
  ClassHierarchyWorkerLike,
  ClassHierarchyWorkerPool,
  ClassHierarchyWorkerPoolError,
  shouldFallbackFromClassHierarchyWorker,
} from '../src/hierarchy/ClassHierarchyWorkerPool';
import {
  ClassHierarchyWorkerFileInput,
  ClassHierarchyWorkerParseRequest,
  ClassHierarchyWorkerResponse,
  isClassHierarchyWorkerParseRequest,
  isClassHierarchyWorkerResponse,
  parseClassHierarchyFiles,
} from '../src/hierarchy/classHierarchyWorker';

type EventName = 'message' | 'error' | 'exit';

class FakeWorker implements ClassHierarchyWorkerLike {
  readonly requests: ClassHierarchyWorkerParseRequest[] = [];
  terminated = 0;
  private readonly listeners = new Map<EventName, Array<(...args: never[]) => void>>();

  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: EventName, listener: (...args: never[]) => void): unknown {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  postMessage(message: unknown): void {
    assert.ok(isClassHierarchyWorkerParseRequest(message));
    this.requests.push(message);
  }

  terminate(): number {
    this.terminated++;
    return 0;
  }

  ready(): void {
    this.emit('message', { type: 'ready' });
  }

  respond(request = this.requests[0]): void {
    assert.ok(request);
    this.emit('message', {
      type: 'result',
      requestId: request.requestId,
      files: parseClassHierarchyFiles(request.files),
    });
  }

  emitMessage(message: unknown): void {
    this.emit('message', message);
  }

  fail(error: Error): void {
    this.emit('error', error);
  }

  private emit(event: EventName, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (value: unknown) => void)(value);
    }
  }
}

function file(index: number): ClassHierarchyWorkerFileInput {
  return {
    path: `/project/Class${index}.h`,
    mtime: 1000 + index,
    size: 20 + index,
    content: `class Class${index} : public Base${index} {};`,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for fake worker activity.');
}

function assertPoolError(error: unknown, code: ClassHierarchyWorkerPoolError['code']): boolean {
  assert.ok(error instanceof ClassHierarchyWorkerPoolError);
  assert.strictEqual(error.code, code);
  return true;
}

function testProtocolAndPureBatchHandler(): void {
  const request: ClassHierarchyWorkerParseRequest = {
    type: 'parse',
    requestId: 7,
    files: [file(1)],
  };
  assert.strictEqual(isClassHierarchyWorkerParseRequest(request), true);
  assert.strictEqual(isClassHierarchyWorkerParseRequest({ ...request, files: [{}] }), false);

  const results = parseClassHierarchyFiles(request.files);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].ok, true);
  if (results[0].ok) {
    assert.strictEqual(results[0].declarations[0].name, 'Class1');
    assert.strictEqual(results[0].declarations[0].bases[0].lookupName, 'Base1');
  }
  assert.deepStrictEqual(
    { path: results[0].path, mtime: results[0].mtime, size: results[0].size },
    { path: request.files[0].path, mtime: request.files[0].mtime, size: request.files[0].size }
  );
  assert.strictEqual(isClassHierarchyWorkerResponse({ type: 'ready' }), true);
  assert.strictEqual(isClassHierarchyWorkerResponse({ type: 'result', requestId: 1 }), false);
}

async function testBatchesAcrossAtMostTwoWorkersAndCorrelatesResponses(): Promise<void> {
  const workers: FakeWorker[] = [];
  const pool = new ClassHierarchyWorkerPool({
    maxWorkers: 99,
    batchSize: 2,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      setImmediate(() => worker.ready());
      return worker;
    },
  });

  const promise = pool.parseFiles([file(0), file(1), file(2), file(3), file(4)]);
  await waitFor(() => workers.length === 2 && workers.every((worker) => worker.requests.length === 1));
  assert.strictEqual(workers.length, 2, 'pool must clamp worker count to two');

  // Complete the second request first. Promise output must still follow input order.
  workers[1].respond();
  await waitFor(() => workers[1].requests.length === 2);
  workers[1].respond(workers[1].requests[1]);
  workers[0].respond();

  const results = await promise;
  assert.deepStrictEqual(results.map((result) => result.path), [
    file(0).path,
    file(1).path,
    file(2).path,
    file(3).path,
    file(4).path,
  ]);
  assert.ok(results.every((result) => result.ok));
  await pool.terminate();
}

async function testAbortRejectsPromptlyAndPoolRemainsUsable(): Promise<void> {
  const worker = new FakeWorker();
  const pool = new ClassHierarchyWorkerPool({
    maxWorkers: 1,
    batchSize: 1,
    workerFactory: () => {
      setImmediate(() => worker.ready());
      return worker;
    },
  });
  const controller = new AbortController();
  const aborted = pool.parseFiles([file(0), file(1)], controller.signal);
  await waitFor(() => worker.requests.length === 1);
  controller.abort();
  await assert.rejects(aborted, (error) => assertPoolError(error, 'cancelled'));
  assert.strictEqual(shouldFallbackFromClassHierarchyWorker(
    new ClassHierarchyWorkerPoolError('cancelled', 'cancelled')
  ), false);

  // Let the ignored in-flight response release the worker, then reuse it.
  worker.respond(worker.requests[0]);
  const next = pool.parseFiles([file(2)]);
  await waitFor(() => worker.requests.length === 2);
  worker.respond(worker.requests[1]);
  const results = await next;
  assert.deepStrictEqual(results.map((result) => result.path), [file(2).path]);
  await pool.terminate();
}

async function testStartupAndProtocolFailuresAreFallbackErrors(): Promise<void> {
  const unavailable = new ClassHierarchyWorkerPool({
    workerFactory: () => {
      throw new Error('missing worker script');
    },
  });
  await assert.rejects(unavailable.parseFiles([file(0)]), (error) => {
    assertPoolError(error, 'unavailable');
    assert.strictEqual(shouldFallbackFromClassHierarchyWorker(error), true);
    assert.match((error as Error).message, /Unable to start/);
    return true;
  });
  await assert.rejects(
    unavailable.parseFiles([file(1)]),
    (error) => assertPoolError(error, 'unavailable')
  );

  const stalledWorker = new FakeWorker();
  const stalled = new ClassHierarchyWorkerPool({
    startupTimeoutMs: 1,
    workerFactory: () => stalledWorker,
  });
  await assert.rejects(
    stalled.parseFiles([file(0)]),
    (error) => assertPoolError(error, 'unavailable')
  );
  assert.strictEqual(stalledWorker.terminated, 1);

  const worker = new FakeWorker();
  const protocol = new ClassHierarchyWorkerPool({
    workerFactory: () => {
      setImmediate(() => worker.ready());
      return worker;
    },
  });
  const pending = protocol.parseFiles([file(1)]);
  await waitFor(() => worker.requests.length === 1);
  worker.emitMessage({
    type: 'result',
    requestId: worker.requests[0].requestId + 1,
    files: [],
  } satisfies ClassHierarchyWorkerResponse);
  await assert.rejects(pending, (error) => {
    assertPoolError(error, 'protocol');
    assert.strictEqual(shouldFallbackFromClassHierarchyWorker(error), true);
    return true;
  });
}

async function testWorkerFailureAndTerminateRejectPendingWorkOnce(): Promise<void> {
  const worker = new FakeWorker();
  const pool = new ClassHierarchyWorkerPool({
    workerFactory: () => {
      setImmediate(() => worker.ready());
      return worker;
    },
  });
  const failed = pool.parseFiles([file(0)]);
  await waitFor(() => worker.requests.length === 1);
  worker.fail(new Error('worker crashed'));
  await assert.rejects(failed, (error) => {
    assertPoolError(error, 'worker-failed');
    assert.strictEqual(shouldFallbackFromClassHierarchyWorker(error), true);
    return true;
  });

  const terminatingWorker = new FakeWorker();
  const terminatingPool = new ClassHierarchyWorkerPool({
    workerFactory: () => {
      setImmediate(() => terminatingWorker.ready());
      return terminatingWorker;
    },
  });
  const pending = terminatingPool.parseFiles([file(2)]);
  await waitFor(() => terminatingWorker.requests.length === 1);
  await terminatingPool.terminate();
  await assert.rejects(pending, (error) => assertPoolError(error, 'terminated'));
  assert.strictEqual(terminatingWorker.terminated, 1);
  await assert.rejects(
    terminatingPool.parseFiles([file(3)]),
    (error) => assertPoolError(error, 'terminated')
  );
}

async function main(): Promise<void> {
  testProtocolAndPureBatchHandler();
  await testBatchesAcrossAtMostTwoWorkersAndCorrelatesResponses();
  await testAbortRejectsPromptlyAndPoolRemainsUsable();
  await testStartupAndProtocolFailuresAreFallbackErrors();
  await testWorkerFailureAndTerminateRejectPendingWorkOnce();
  console.log('classHierarchyWorkerPool tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
