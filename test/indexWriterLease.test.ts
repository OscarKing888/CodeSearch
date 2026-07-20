import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquireIndexWriterLease,
  IndexWriterLease,
  IndexWriterLeaseOwner,
} from '../src/index/IndexWriterLease';

function readOwner(lockPath: string): IndexWriterLeaseOwner {
  return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as IndexWriterLeaseOwner;
}

async function testAcquireHeartbeatAndRelease(root: string): Promise<void> {
  const dbPath = path.join(root, 'basic', 'index.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let now = 1_000;
  const result = await IndexWriterLease.acquire(dbPath, {
    label: 'VS Code test window',
    now: () => now,
  });

  assert.strictEqual(result.acquired, true);
  if (!result.acquired) {
    assert.fail('first writer should acquire the lease');
  }
  assert.strictEqual(result.lockPath, `${dbPath}.writer.lock`);
  assert.strictEqual(result.owner.pid, process.pid);
  assert.strictEqual(result.owner.label, 'VS Code test window');
  assert.ok(result.owner.token.length > 0);
  assert.strictEqual(result.owner.acquiredAt, 1_000);
  assert.strictEqual(result.owner.heartbeatAt, 1_000);
  assert.deepStrictEqual(readOwner(result.lockPath), result.owner);

  now = 1_500;
  assert.strictEqual(await result.lease.heartbeat(), true);
  assert.strictEqual(readOwner(result.lockPath).heartbeatAt, 1_500);
  assert.strictEqual(await result.lease.release(), true);
  assert.strictEqual(fs.existsSync(result.lockPath), false);
  assert.strictEqual(await result.lease.release(), false, 'release must be idempotent');

  const reacquired = await acquireIndexWriterLease(dbPath, { label: 'Cursor test window' });
  assert.strictEqual(reacquired.acquired, true, 'release should make the DB available again');
  if (reacquired.acquired) {
    await reacquired.lease.release();
  }
}

async function testSameProcessCompetitionAndOwnerOnlyRelease(root: string): Promise<void> {
  const dbPath = path.join(root, 'competition', 'index.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const first = await IndexWriterLease.acquire(dbPath, { label: 'first IDE' });
  assert.strictEqual(first.acquired, true);
  if (!first.acquired) {
    assert.fail('first writer should acquire the lease');
  }

  const second = await IndexWriterLease.acquire(dbPath, {
    label: 'second IDE',
    // Even a hostile liveness hook must not let another instance in this
    // process evict the active lease.
    isProcessAlive: () => false,
  });
  assert.strictEqual(second.acquired, false);
  if (second.acquired) {
    assert.fail('same-process competitor must not acquire the lease');
  }
  assert.strictEqual(second.owner?.pid, process.pid);
  assert.strictEqual(second.owner?.token, first.owner.token);
  assert.strictEqual(second.owner?.label, 'first IDE');

  const replacement: IndexWriterLeaseOwner = {
    ...first.owner,
    token: 'replacement-owner-token',
    label: 'replacement owner',
  };
  fs.writeFileSync(first.lockPath, `${JSON.stringify(replacement)}\n`, 'utf8');
  assert.strictEqual(
    await first.lease.release(),
    false,
    'an old lease must not unlink a replacement owner'
  );
  assert.strictEqual(readOwner(first.lockPath).token, replacement.token);
  fs.unlinkSync(first.lockPath);
}

async function testParallelAtomicAcquire(root: string): Promise<void> {
  const dbPath = path.join(root, 'parallel', 'index.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const results = await Promise.all([
    IndexWriterLease.acquire(dbPath, { label: 'VS Code' }),
    IndexWriterLease.acquire(dbPath, { label: 'Cursor' }),
  ]);
  const acquired = results.filter((result) => result.acquired);
  const busy = results.filter((result) => !result.acquired);
  assert.strictEqual(acquired.length, 1, 'atomic create must admit exactly one writer');
  assert.strictEqual(busy.length, 1);
  if (acquired[0].acquired && !busy[0].acquired) {
    assert.strictEqual(busy[0].owner?.token, acquired[0].owner.token);
    await acquired[0].lease.release();
  }
}

async function testIncompleteLockIsNeverPublished(root: string): Promise<void> {
  const dbPath = path.join(root, 'delayed-publication', 'index.db');
  const lockPath = `${dbPath}.writer.lock`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const promises = fs.promises as unknown as {
    open: (...args: unknown[]) => Promise<fs.promises.FileHandle>;
  };
  const originalOpen = promises.open;
  let intercepted = false;
  let signalWriteStarted!: () => void;
  let resumeWrite!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve;
  });
  const writeGate = new Promise<void>((resolve) => {
    resumeWrite = resolve;
  });

  promises.open = async (...args: unknown[]) => {
    const handle = await originalOpen(...args);
    const candidatePath = String(args[0]);
    if (
      !intercepted &&
      args[1] === 'wx' &&
      (candidatePath === lockPath || candidatePath.startsWith(`${lockPath}.`))
    ) {
      intercepted = true;
      const originalWriteFile = handle.writeFile.bind(handle);
      (handle as unknown as { writeFile: (...writeArgs: unknown[]) => Promise<void> }).writeFile =
        async (...writeArgs: unknown[]) => {
          signalWriteStarted();
          await writeGate;
          await (originalWriteFile as (...writeArgs: unknown[]) => Promise<void>)(...writeArgs);
        };
    }
    return handle;
  };

  let first: Awaited<ReturnType<typeof IndexWriterLease.acquire>> | undefined;
  let second: Awaited<ReturnType<typeof IndexWriterLease.acquire>> | undefined;
  try {
    const firstPromise = IndexWriterLease.acquire(dbPath, {
      label: 'delayed writer',
      staleTimeoutMs: 0,
    });
    await writeStarted;
    assert.strictEqual(
      fs.existsSync(lockPath),
      false,
      'an incomplete owner file must remain private until it is fully written'
    );

    second = await IndexWriterLease.acquire(dbPath, {
      label: 'competing writer',
      staleTimeoutMs: 0,
    });
    assert.strictEqual(second.acquired, true);
    resumeWrite();
    first = await firstPromise;
    assert.strictEqual(first.acquired, false);
    assert.strictEqual(
      Number(first.acquired) + Number(second.acquired),
      1,
      'delaying lock-file I/O must still admit at most one writer'
    );
  } finally {
    promises.open = originalOpen;
    resumeWrite();
    if (first?.acquired) {
      await first.lease.release();
    }
    if (second?.acquired) {
      await second.lease.release();
    }
  }
}

async function testDeadOwnerReclaim(root: string): Promise<void> {
  const dbPath = path.join(root, 'dead-owner', 'index.db');
  const lockPath = `${dbPath}.writer.lock`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const staleOwner: IndexWriterLeaseOwner = {
    pid: 424_242,
    token: 'dead-owner-token',
    label: 'closed IDE',
    acquiredAt: 100,
    heartbeatAt: 200,
  };
  fs.writeFileSync(lockPath, `${JSON.stringify(staleOwner)}\n`, 'utf8');

  const result = await IndexWriterLease.acquire(dbPath, {
    label: 'new IDE',
    isProcessAlive: (pid) => pid !== staleOwner.pid,
  });
  assert.strictEqual(result.acquired, true);
  if (!result.acquired) {
    assert.fail('a lock owned by a dead process should be reclaimed');
  }
  assert.deepStrictEqual(result.reclaimedOwner, staleOwner);
  assert.notStrictEqual(result.owner.token, staleOwner.token);
  assert.strictEqual(fs.existsSync(`${lockPath}.reclaim`), false);
  await result.lease.release();
}

async function testParallelDeadOwnerReclaimAdmitsOneWriter(root: string): Promise<void> {
  const dbPath = path.join(root, 'parallel-dead-owner', 'index.db');
  const lockPath = `${dbPath}.writer.lock`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const staleOwner: IndexWriterLeaseOwner = {
    pid: 818_181,
    token: 'parallel-dead-owner-token',
    label: 'closed IDE',
    acquiredAt: 100,
    heartbeatAt: 200,
  };
  fs.writeFileSync(lockPath, `${JSON.stringify(staleOwner)}\n`, 'utf8');

  const results = await Promise.all(
    Array.from({ length: 32 }, (_, index) =>
      IndexWriterLease.acquire(dbPath, {
        label: `contender ${index}`,
        isProcessAlive: () => false,
      })
    )
  );
  const acquired = results.filter((result) => result.acquired);
  assert.strictEqual(
    acquired.length,
    1,
    'parallel dead-owner recovery must admit exactly one writer'
  );
  assert.strictEqual(
    readOwner(lockPath).token,
    acquired[0].owner.token,
    'the only acquired lease must own the durable lock'
  );
  if (acquired[0].acquired) {
    await acquired[0].lease.release();
  }
}

async function testCorruptLockAlwaysFailsSafe(root: string): Promise<void> {
  const dbPath = path.join(root, 'corrupt', 'index.db');
  const lockPath = `${dbPath}.writer.lock`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(lockPath, '{ unfinished owner JSON', 'utf8');
  const now = Date.now();

  const freshResult = await IndexWriterLease.acquire(dbPath, {
    label: 'fresh contender',
    staleTimeoutMs: 5_000,
    now: () => now,
  });
  assert.strictEqual(freshResult.acquired, false);
  if (!freshResult.acquired) {
    assert.strictEqual(freshResult.owner, null);
  }
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), '{ unfinished owner JSON');

  const oldTime = new Date(now - 10_000);
  fs.utimesSync(lockPath, oldTime, oldTime);
  const staleResult = await IndexWriterLease.acquire(dbPath, {
    label: 'stale reclaimer',
    staleTimeoutMs: 5_000,
    now: () => now,
  });
  assert.strictEqual(
    staleResult.acquired,
    false,
    'an old corrupt lock must fail safe instead of racing an in-progress creator'
  );
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), '{ unfinished owner JSON');
}

async function testDeadReclaimGuardFailsSafe(root: string): Promise<void> {
  const dbPath = path.join(root, 'dead-reclaim-guard', 'index.db');
  const lockPath = `${dbPath}.writer.lock`;
  const guardPath = `${lockPath}.reclaim`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const staleOwner: IndexWriterLeaseOwner = {
    pid: 515_151,
    token: 'dead-main-owner-token',
    label: 'closed IDE',
    acquiredAt: 100,
    heartbeatAt: 200,
  };
  fs.writeFileSync(lockPath, `${JSON.stringify(staleOwner)}\n`, 'utf8');
  fs.writeFileSync(
    guardPath,
    `${JSON.stringify({
      pid: 616_161,
      token: 'dead-reclaim-owner-token',
      createdAt: 300,
    })}\n`,
    'utf8'
  );

  const result = await IndexWriterLease.acquire(dbPath, {
    label: 'new IDE',
    isProcessAlive: () => false,
  });
  assert.strictEqual(
    result.acquired,
    false,
    'an orphaned guard must fail safe instead of risking two writers'
  );
  assert.strictEqual(fs.existsSync(guardPath), true);
  assert.strictEqual(readOwner(lockPath).token, staleOwner.token);
}

async function testUnreadableReclaimGuardFailsSafeAfterTimeout(root: string): Promise<void> {
  const dbPath = path.join(root, 'corrupt-reclaim-guard', 'index.db');
  const lockPath = `${dbPath}.writer.lock`;
  const guardPath = `${lockPath}.reclaim`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const staleOwner: IndexWriterLeaseOwner = {
    pid: 717_171,
    token: 'dead-main-owner-token',
    label: 'closed IDE',
    acquiredAt: 100,
    heartbeatAt: 200,
  };
  fs.writeFileSync(lockPath, `${JSON.stringify(staleOwner)}\n`, 'utf8');
  fs.writeFileSync(guardPath, '{ unfinished reclaim JSON', 'utf8');
  const now = Date.now();

  const freshResult = await IndexWriterLease.acquire(dbPath, {
    label: 'fresh contender',
    staleTimeoutMs: 5_000,
    now: () => now,
    isProcessAlive: () => false,
  });
  assert.strictEqual(freshResult.acquired, false);
  assert.strictEqual(fs.readFileSync(guardPath, 'utf8'), '{ unfinished reclaim JSON');

  const oldTime = new Date(now - 10_000);
  fs.utimesSync(guardPath, oldTime, oldTime);
  const staleResult = await IndexWriterLease.acquire(dbPath, {
    label: 'stale guard reclaimer',
    staleTimeoutMs: 5_000,
    now: () => now,
    isProcessAlive: () => false,
  });
  assert.strictEqual(
    staleResult.acquired,
    false,
    'even an old unreadable guard must not be deleted with a racy check-then-unlink'
  );
  assert.strictEqual(fs.existsSync(guardPath), true);
  assert.strictEqual(readOwner(lockPath).token, staleOwner.token);
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-index-writer-lease-'));
  try {
    await testAcquireHeartbeatAndRelease(root);
    await testSameProcessCompetitionAndOwnerOnlyRelease(root);
    await testParallelAtomicAcquire(root);
    await testIncompleteLockIsNeverPublished(root);
    await testDeadOwnerReclaim(root);
    await testParallelDeadOwnerReclaimAdmitsOneWriter(root);
    await testCorruptLockAlwaysFailsSafe(root);
    await testDeadReclaimGuardFailsSafe(root);
    await testUnreadableReclaimGuardFailsSafeAfterTimeout(root);
    console.log('indexWriterLease tests passed');
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
