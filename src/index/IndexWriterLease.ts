import * as crypto from 'crypto';
import * as fs from 'fs';

export const DEFAULT_INDEX_WRITER_LEASE_STALE_TIMEOUT_MS = 30_000;

export interface IndexWriterLeaseOwner {
  readonly pid: number;
  readonly token: string;
  readonly label: string;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
}

export interface IndexWriterLeaseOptions {
  /** Human-readable IDE/window name, used when reporting the current writer. */
  readonly label: string;
  /** Disabled when omitted or zero. */
  readonly heartbeatIntervalMs?: number;
  /**
   * Retained for API compatibility. Unreadable/incomplete locks now fail safe
   * and are never reclaimed automatically, regardless of their age.
   */
  readonly staleTimeoutMs?: number;
  /** Test/embedding hook. Errors are treated as "process may still exist". */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Test/embedding hook for deterministic timestamps. */
  readonly now?: () => number;
}

export type IndexWriterLeaseAcquireResult =
  | {
      readonly acquired: true;
      readonly lease: IndexWriterLease;
      readonly owner: IndexWriterLeaseOwner;
      readonly lockPath: string;
      readonly reclaimedOwner?: IndexWriterLeaseOwner;
    }
  | {
      readonly acquired: false;
      /** Null means that the lock exists but is not valid owner JSON. */
      readonly owner: IndexWriterLeaseOwner | null;
      readonly lockPath: string;
    };

interface NormalizedOptions {
  label: string;
  heartbeatIntervalMs: number;
  staleTimeoutMs: number;
  isProcessAlive: (pid: number) => boolean;
  now: () => number;
}

interface LockSnapshot {
  owner: IndexWriterLeaseOwner | null;
  mtimeMs: number;
}

interface ReclaimGuardOwner {
  pid: number;
  token: string;
  createdAt: number;
}

const MAX_ACQUIRE_ATTEMPTS = 8;

export class IndexWriterLease {
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private active = true;
  private operationTail: Promise<void> = Promise.resolve();

  private constructor(
    public readonly dbPath: string,
    public readonly lockPath: string,
    private currentOwner: IndexWriterLeaseOwner,
    private readonly options: NormalizedOptions
  ) {
    if (options.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        void this.heartbeat().catch(() => undefined);
      }, options.heartbeatIntervalMs);
      this.heartbeatTimer.unref();
    }
  }

  get owner(): IndexWriterLeaseOwner {
    return this.currentOwner;
  }

  static async acquire(
    dbPath: string,
    options: IndexWriterLeaseOptions
  ): Promise<IndexWriterLeaseAcquireResult> {
    return acquireIndexWriterLeaseInternal(
      dbPath,
      options,
      (resolvedDbPath, lockPath, owner, normalized) =>
        new IndexWriterLease(resolvedDbPath, lockPath, owner, normalized)
    );
  }

  /**
   * Refreshes the timestamp only while this instance's token still owns the
   * lock. False means the lock disappeared or belongs to somebody else.
   */
  async heartbeat(): Promise<boolean> {
    return this.runExclusive(async () => {
      if (!this.active) {
        return false;
      }

      const nextOwner = freezeOwner({
        ...this.currentOwner,
        heartbeatAt: this.options.now(),
      });
      const updated = await rewriteLockIfOwned(this.lockPath, nextOwner);
      if (!updated) {
        this.active = false;
        this.stopHeartbeat();
        return false;
      }
      this.currentOwner = nextOwner;
      return true;
    });
  }

  /**
   * Removes the lock only when its on-disk token still matches this instance.
   * Repeated releases, or release after ownership was lost, return false.
   */
  async release(): Promise<boolean> {
    this.stopHeartbeat();
    return this.runExclusive(async () => {
      if (!this.active) {
        return false;
      }
      this.active = false;
      return unlinkLockIfOwned(this.lockPath, this.currentOwner.token);
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export async function acquireIndexWriterLease(
  dbPath: string,
  options: IndexWriterLeaseOptions
): Promise<IndexWriterLeaseAcquireResult> {
  return IndexWriterLease.acquire(dbPath, options);
}

async function acquireIndexWriterLeaseInternal(
  dbPath: string,
  options: IndexWriterLeaseOptions,
  makeLease: (
    dbPath: string,
    lockPath: string,
    owner: IndexWriterLeaseOwner,
    options: NormalizedOptions
  ) => IndexWriterLease
): Promise<IndexWriterLeaseAcquireResult> {
  const normalized = normalizeOptions(dbPath, options);
  const lockPath = `${dbPath}.writer.lock`;
  let reclaimedOwner: IndexWriterLeaseOwner | undefined;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const owner = makeOwner(normalized);
    if (await tryCreateLock(lockPath, owner)) {
      const lease = makeLease(dbPath, lockPath, owner, normalized);
      return {
        acquired: true,
        lease,
        owner,
        lockPath,
        ...(reclaimedOwner ? { reclaimedOwner } : {}),
      };
    }

    const snapshot = await readLockSnapshot(lockPath);
    if (!snapshot) {
      continue;
    }
    if (!isReclaimable(snapshot, normalized)) {
      return { acquired: false, owner: snapshot.owner, lockPath };
    }

    const reclaimResult = await reclaimAndCreate(lockPath, snapshot.owner, normalized);
    if (reclaimResult.kind === 'acquired') {
      const lease = makeLease(
        dbPath,
        lockPath,
        reclaimResult.owner,
        normalized
      );
      return {
        acquired: true,
        lease,
        owner: reclaimResult.owner,
        lockPath,
        ...(reclaimResult.reclaimedOwner
          ? { reclaimedOwner: reclaimResult.reclaimedOwner }
          : {}),
      };
    }
    if (reclaimResult.kind === 'busy') {
      return { acquired: false, owner: reclaimResult.owner, lockPath };
    }
    if (snapshot.owner) {
      reclaimedOwner = snapshot.owner;
    }
  }

  const finalSnapshot = await readLockSnapshot(lockPath);
  if (finalSnapshot) {
    return { acquired: false, owner: finalSnapshot.owner, lockPath };
  }
  throw new Error(`Unable to acquire index writer lease after ${MAX_ACQUIRE_ATTEMPTS} attempts: ${lockPath}`);
}

function normalizeOptions(dbPath: string, options: IndexWriterLeaseOptions): NormalizedOptions {
  if (typeof dbPath !== 'string' || dbPath.length === 0) {
    throw new TypeError('dbPath must be a non-empty string');
  }
  if (!options || typeof options.label !== 'string' || options.label.trim().length === 0) {
    throw new TypeError('Index writer lease label must be a non-empty string');
  }

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 0;
  const staleTimeoutMs =
    options.staleTimeoutMs ?? DEFAULT_INDEX_WRITER_LEASE_STALE_TIMEOUT_MS;
  assertNonNegativeFinite('heartbeatIntervalMs', heartbeatIntervalMs);
  assertNonNegativeFinite('staleTimeoutMs', staleTimeoutMs);

  return {
    label: options.label.trim(),
    heartbeatIntervalMs,
    staleTimeoutMs,
    isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
    now: options.now ?? Date.now,
  };
}

function assertNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

function makeOwner(options: NormalizedOptions): IndexWriterLeaseOwner {
  const now = options.now();
  if (!Number.isFinite(now)) {
    throw new RangeError('Index writer lease clock returned a non-finite timestamp');
  }
  return freezeOwner({
    pid: process.pid,
    token: crypto.randomUUID(),
    label: options.label,
    acquiredAt: now,
    heartbeatAt: now,
  });
}

function freezeOwner(owner: IndexWriterLeaseOwner): IndexWriterLeaseOwner {
  return Object.freeze(owner);
}

async function tryCreateLock(
  lockPath: string,
  owner: IndexWriterLeaseOwner
): Promise<boolean> {
  const tempPath = `${lockPath}.${process.pid}.${owner.token}.tmp`;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(tempPath, 'wx', 0o600);
  } catch (error) {
    throw error;
  }

  try {
    await handle.writeFile(serializeOwner(owner), 'utf8');
    await handle.sync();
  } catch (error) {
    // tempPath contains this token, so cleaning it cannot remove a replacement
    // writer's durable lock.
    await handle.close().catch(() => undefined);
    await fs.promises.unlink(tempPath).catch(() => undefined);
    throw error;
  }
  await handle.close().catch(() => undefined);

  try {
    // Publish only the fully written file. link() is an atomic no-replace
    // operation: exactly one contender can create lockPath, while readers can
    // never observe the temp file's incomplete contents.
    await fs.promises.link(tempPath, lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) {
      return false;
    }
    if (await pathExists(lockPath)) {
      return false;
    }
    if (!isHardLinkUnsupported(error)) {
      throw error;
    }

    // Some network/removable filesystems do not implement hard links. Keep a
    // compatible atomic-create fallback, but never auto-reclaim an incomplete
    // target left by a crash or write failure; fail-safe blocking is preferable
    // to admitting two writers.
    return tryCreateLockDirect(lockPath, owner);
  } finally {
    await fs.promises.unlink(tempPath).catch(() => undefined);
  }
}

async function tryCreateLockDirect(
  lockPath: string,
  owner: IndexWriterLeaseOwner
): Promise<boolean> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) {
      return false;
    }
    throw error;
  }

  try {
    await handle.writeFile(serializeOwner(owner), 'utf8');
    await handle.sync();
    return true;
  } finally {
    await handle.close().catch(() => undefined);
    // Deliberately do not unlink lockPath on failure. It may be incomplete,
    // but removing it with a check-then-unlink sequence could delete a lock
    // that another process has replaced in the meantime.
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

function isHardLinkUnsupported(error: unknown): boolean {
  return (
    isNodeError(error, 'ENOSYS') ||
    isNodeError(error, 'ENOTSUP') ||
    isNodeError(error, 'EOPNOTSUPP') ||
    isNodeError(error, 'EXDEV') ||
    isNodeError(error, 'EMLINK') ||
    isNodeError(error, 'EPERM') ||
    isNodeError(error, 'EACCES')
  );
}

async function readLockSnapshot(lockPath: string): Promise<LockSnapshot | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(lockPath, 'r');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }

  try {
    const [raw, stat] = await Promise.all([handle.readFile('utf8'), handle.stat()]);
    return {
      owner: parseOwner(raw),
      mtimeMs: stat.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

function parseOwner(raw: string): IndexWriterLeaseOwner | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }

  const { pid, token, label, acquiredAt, heartbeatAt } = value;
  if (
    !Number.isSafeInteger(pid) ||
    (pid as number) <= 0 ||
    typeof token !== 'string' ||
    token.length === 0 ||
    typeof label !== 'string' ||
    !Number.isFinite(acquiredAt) ||
    !Number.isFinite(heartbeatAt)
  ) {
    return null;
  }

  return freezeOwner({
    pid: pid as number,
    token,
    label,
    acquiredAt: acquiredAt as number,
    heartbeatAt: heartbeatAt as number,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReclaimable(snapshot: LockSnapshot, options: NormalizedOptions): boolean {
  if (!snapshot.owner) {
    // The file may be an in-progress direct-create fallback whose creator was
    // descheduled between open('wx') and writing the owner JSON. Reclaiming it
    // based only on age can let both creators return success. Invalid locks are
    // therefore deliberately fail-safe and require manual removal after every
    // IDE using the index has been closed.
    return false;
  }

  // A second lease object in this extension host must never evict the first.
  if (snapshot.owner.pid === process.pid) {
    return false;
  }
  try {
    return !options.isProcessAlive(snapshot.owner.pid);
  } catch {
    return false;
  }
}

type ReclaimResult =
  | {
      kind: 'acquired';
      owner: IndexWriterLeaseOwner;
      reclaimedOwner: IndexWriterLeaseOwner | null;
    }
  | { kind: 'busy'; owner: IndexWriterLeaseOwner | null }
  | { kind: 'retry' };

async function reclaimAndCreate(
  lockPath: string,
  observedOwner: IndexWriterLeaseOwner | null,
  options: NormalizedOptions
): Promise<ReclaimResult> {
  const guardPath = `${lockPath}.reclaim`;
  const guard = await tryAcquireReclaimGuard(guardPath, options);
  if (!guard) {
    const current = await readLockSnapshot(lockPath);
    return current
      ? { kind: 'busy', owner: current.owner }
      : { kind: 'retry' };
  }

  try {
    const current = await readLockSnapshot(lockPath);
    if (!current) {
      return { kind: 'retry' };
    }
    if (!sameObservedOwner(observedOwner, current.owner) || !isReclaimable(current, options)) {
      return { kind: 'busy', owner: current.owner };
    }

    try {
      await fs.promises.unlink(lockPath);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        return { kind: 'retry' };
      }
      throw error;
    }

    const owner = makeOwner(options);
    if (await tryCreateLock(lockPath, owner)) {
      return { kind: 'acquired', owner, reclaimedOwner: current.owner };
    }
    const replacement = await readLockSnapshot(lockPath);
    return replacement
      ? { kind: 'busy', owner: replacement.owner }
      : { kind: 'retry' };
  } finally {
    await unlinkGuardIfOwned(guardPath, guard.token);
  }
}

function sameObservedOwner(
  observed: IndexWriterLeaseOwner | null,
  current: IndexWriterLeaseOwner | null
): boolean {
  if (!observed || !current) {
    return observed === current;
  }
  return observed.token === current.token;
}

async function tryAcquireReclaimGuard(
  guardPath: string,
  options: NormalizedOptions
): Promise<ReclaimGuardOwner | null> {
  const owner: ReclaimGuardOwner = {
    pid: process.pid,
    token: crypto.randomUUID(),
    createdAt: options.now(),
  };
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(guardPath, 'wx', 0o600);
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) {
        // Never remove an existing reclaim guard automatically. A liveness
        // check followed by unlink is not an atomic compare-and-delete: a
        // second contender could replace the guard between those operations,
        // then have its live guard deleted. That can admit two writers. A
        // guard orphaned by a crash is deliberately fail-safe and requires
        // manual removal after every IDE using this index has been closed.
        return null;
      }
      throw error;
    }

    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.promises.unlink(guardPath).catch(() => undefined);
      throw error;
    }
    await handle.close().catch(() => undefined);
    return owner;
  }

  return null;
}

async function unlinkGuardIfOwned(guardPath: string, token: string): Promise<void> {
  try {
    const raw = await fs.promises.readFile(guardPath, 'utf8');
    const value = JSON.parse(raw) as Partial<ReclaimGuardOwner>;
    if (value.token === token) {
      await fs.promises.unlink(guardPath).catch(() => undefined);
    }
  } catch {
    // The guard is best-effort and is never the durable writer ownership record.
  }
}

async function rewriteLockIfOwned(
  lockPath: string,
  nextOwner: IndexWriterLeaseOwner
): Promise<boolean> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(lockPath, 'r+');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }

  try {
    const current = parseOwner(await handle.readFile('utf8'));
    if (current?.token !== nextOwner.token) {
      return false;
    }
    const serialized = serializeOwner(nextOwner);
    await handle.truncate(0);
    await handle.write(serialized, 0, 'utf8');
    await handle.truncate(Buffer.byteLength(serialized));
    await handle.sync();
    return true;
  } finally {
    await handle.close();
  }
}

async function unlinkLockIfOwned(lockPath: string, token: string): Promise<boolean> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(lockPath, 'r');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }

  try {
    const current = parseOwner(await handle.readFile('utf8'));
    if (current?.token !== token) {
      return false;
    }
  } finally {
    await handle.close();
  }

  try {
    await fs.promises.unlink(lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

function serializeOwner(owner: IndexWriterLeaseOwner): string {
  return `${JSON.stringify(owner, null, 2)}\n`;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ESRCH')) {
      return false;
    }
    // EPERM means the process exists but cannot be signalled. Unknown platform
    // errors are also treated conservatively to avoid stealing a live writer.
    return true;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
