import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { SearchOptions } from '../types';

export const PROFILE_LOG_DIR_NAME = 'profile-logs';
export const LATEST_PROFILE_FILENAME = 'latest-profile.jsonl';
export const WORKSPACE_PROFILE_RELATIVE = path.join('.code-search', 'profile-latest.jsonl');

const PROFILE_CHECKPOINT_MS = 250;

export type SearchProfileOutcome = 'success' | 'cancelled' | 'error' | 'disposed';

export interface SearchProfileMeta {
  version: string;
  query: string;
  options: SearchOptions;
}

export interface SearchProfileOutput {
  globalStoragePath: string;
  workspaceRoot?: string;
}

interface ProfileMark {
  type: 'mark';
  phase: string;
  t: number;
  source?: string;
  data?: Record<string, unknown>;
}

interface ProfileMetaLine {
  type: 'meta';
  sessionId: string;
  version: string;
  query: string;
  options: SearchOptions;
  ts: string;
}

export interface ProfileAckWait {
  searchId: number;
  chunkId: number;
  waitMs: number;
  outcome: string;
}

export interface ProfileSummary {
  type: 'summary';
  outcome: SearchProfileOutcome;
  error?: string;
  totalMs: number;
  ttfrMs?: number;
  candidateRows?: number;
  batches?: number;
  hitCount?: number;
  ackWaits: ProfileAckWait[];
  phaseStats: Record<string, { count: number; totalMs: number; maxMs: number }>;
  logPath: string;
  latestPath: string;
  workspaceMirrorPath?: string;
  workspaceMirrorError?: string;
}

type ProfileLine = ProfileMetaLine | ProfileMark | ProfileSummary;

interface ProfilePaths {
  dir: string;
  logPath: string;
  latestPath: string;
  workspaceMirrorPath?: string;
}

let activeProfile: SearchProfileSession | undefined;
let sessionSerial = 0;
const profileContext = new AsyncLocalStorage<SearchProfileSession>();

// latest-profile.jsonl and the workspace mirror are shared by overlapping
// searches. Serialize writes per path and check ownership inside the queue so
// an older session cannot overwrite a newer session after a late finalize.
const sharedPathOwners = new Map<string, string>();
const sharedPathQueues = new Map<string, Promise<void>>();

export function getActiveProfile(): SearchProfileSession | undefined {
  return profileContext.getStore() ?? activeProfile;
}

export function setActiveProfile(session: SearchProfileSession | undefined): void {
  activeProfile = session;
}

export function beginSearchProfile(
  meta: SearchProfileMeta,
  output?: SearchProfileOutput
): SearchProfileSession {
  const session = new SearchProfileSession(meta, output);
  setActiveProfile(session);
  return session;
}

export function runWithSearchProfile<T>(session: SearchProfileSession, callback: () => T): T {
  return profileContext.run(session, callback);
}

export function profileMark(
  phase: string,
  data?: Record<string, unknown>,
  source = 'extension'
): void {
  getActiveProfile()?.mark(phase, data, source);
}

function slugifyQuery(query: string): string {
  const slug = query
    .trim()
    .slice(0, 40)
    .replace(/[^\w\u4e00-\u9fff-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'search';
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function formatTimestamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

function serializeLines(lines: readonly ProfileLine[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

function errorText(error: unknown): string | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }
  return error instanceof Error ? error.message : String(error);
}

function sharedPathKey(filePath: string): string {
  const normalized = path.resolve(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function claimSharedPath(filePath: string, sessionId: string): void {
  sharedPathOwners.set(sharedPathKey(filePath), sessionId);
}

function enqueueOwnedSnapshot(
  filePath: string,
  sessionId: string,
  content: string
): Promise<void> {
  const key = sharedPathKey(filePath);
  const previous = sharedPathQueues.get(key) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      if (sharedPathOwners.get(key) !== sessionId) {
        return;
      }
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      if (sharedPathOwners.get(key) !== sessionId) {
        return;
      }
      await fs.promises.writeFile(filePath, content, 'utf8');
    });
  sharedPathQueues.set(key, write.catch(() => undefined));
  return write;
}

export class SearchProfileSession {
  readonly sessionId: string;

  private readonly startMs = Date.now();
  private readonly lines: ProfileLine[];
  private pendingLines: Array<ProfileMark | ProfileSummary> = [];
  private lastMarkMs = new Map<string, number>();
  private phaseStats = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  private ackWaits: ProfileAckWait[] = [];
  private ttfrMs: number | undefined;
  private candidateRows = 0;
  private batchYields = 0;
  private finalHitCount: number | undefined;
  private paths: ProfilePaths | undefined;
  private checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  private flushQueue: Promise<void> = Promise.resolve();
  private primaryWriteError: unknown;
  private workspaceMirrorError: string | undefined;
  private finalized = false;
  private finalizePromise: Promise<string | undefined> | undefined;

  constructor(
    private readonly meta: SearchProfileMeta,
    output?: SearchProfileOutput
  ) {
    const serial = ++sessionSerial;
    this.sessionId = `${this.startMs}-${serial}`;
    this.lines = [
      {
        type: 'meta',
        sessionId: this.sessionId,
        version: meta.version,
        query: meta.query,
        options: meta.options,
        ts: new Date(this.startMs).toISOString(),
      },
    ];

    if (output) {
      this.configureOutput(output, serial);
    }
  }

  mark(phase: string, data?: Record<string, unknown>, source = 'extension'): void {
    if (this.finalized) {
      return;
    }

    const now = Date.now();
    const t = now - this.startMs;
    const mark: ProfileMark = { type: 'mark', phase, t, source, data };
    this.lines.push(mark);
    this.pendingLines.push(mark);

    const previousMarkMs = this.lastMarkMs.get(phase);
    const delta = previousMarkMs === undefined ? t : now - previousMarkMs;
    this.lastMarkMs.set(phase, now);

    const stats = this.phaseStats.get(phase) ?? { count: 0, totalMs: 0, maxMs: 0 };
    stats.count += 1;
    stats.totalMs += delta;
    stats.maxMs = Math.max(stats.maxMs, delta);
    this.phaseStats.set(phase, stats);

    if (phase === 'search_iterate_first_row') {
      this.candidateRows = Number(data?.rowIndex ?? 1);
    }
    if (phase === 'search_iterate_row' && data?.rowIndex !== undefined) {
      this.candidateRows = Number(data.rowIndex);
    }
    if (phase === 'search_batch_yield') {
      this.batchYields += 1;
      if (data?.hitCount !== undefined) {
        this.finalHitCount = Number(data.hitCount);
      }
    }
    if (phase === 'provider_runSearch_done' && data?.hitCount !== undefined) {
      this.finalHitCount = Number(data.hitCount);
    }
    if (phase === 'webview_first_resultsPartial' && this.ttfrMs === undefined) {
      this.ttfrMs = t;
    }
    if (phase === 'provider_resultsPartial_ack') {
      const waitMs = Number(data?.waitMs);
      const searchId = Number(data?.searchId);
      const chunkId = Number(data?.chunkId);
      if (Number.isFinite(waitMs) && Number.isInteger(searchId) && Number.isInteger(chunkId)) {
        this.ackWaits.push({
          searchId,
          chunkId,
          waitMs,
          outcome: String(data?.outcome ?? 'unknown'),
        });
      }
    }

    const critical =
      phase === 'webview_first_resultsPartial' ||
      phase === 'provider_resultsPartial_ack_timeout' ||
      (phase === 'provider_resultsPartial_sent' && Number(data?.chunkId) === 1);
    if (critical) {
      void this.checkpoint();
    } else {
      this.scheduleCheckpoint();
    }
  }

  /** Flush all marks currently in memory to the unique log and latest mirrors. */
  checkpoint(): Promise<void> {
    if (this.checkpointTimer) {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = undefined;
    }
    if (!this.paths || this.pendingLines.length === 0) {
      return this.flushQueue;
    }

    const pending = this.pendingLines;
    this.pendingLines = [];
    const appendContent = serializeLines(pending);
    const snapshotContent = serializeLines(this.lines);
    return this.enqueueFlush(async () => {
      await fs.promises.appendFile(this.paths!.logPath, appendContent, 'utf8');
      await enqueueOwnedSnapshot(this.paths!.latestPath, this.sessionId, snapshotContent);
      this.queueWorkspaceMirror(snapshotContent);
    });
  }

  finalize(outcome: SearchProfileOutcome, error?: unknown): Promise<string | undefined> {
    if (this.finalizePromise) {
      return this.finalizePromise;
    }

    this.finalized = true;
    if (this.checkpointTimer) {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = undefined;
    }
    if (activeProfile === this) {
      setActiveProfile(undefined);
    }

    const phaseStatsObject: ProfileSummary['phaseStats'] = {};
    for (const [phase, stats] of this.phaseStats) {
      phaseStatsObject[phase] = { ...stats };
    }

    if (this.paths) {
      const summary: ProfileSummary = {
        type: 'summary',
        outcome,
        error: errorText(error),
        totalMs: Date.now() - this.startMs,
        ttfrMs: this.ttfrMs,
        candidateRows: this.candidateRows || undefined,
        batches: this.batchYields || undefined,
        hitCount: this.finalHitCount,
        ackWaits: [...this.ackWaits],
        phaseStats: phaseStatsObject,
        logPath: this.paths.logPath,
        latestPath: this.paths.latestPath,
        workspaceMirrorPath: this.paths.workspaceMirrorPath,
        workspaceMirrorError: this.workspaceMirrorError,
      };
      this.lines.push(summary);
      this.pendingLines.push(summary);
    }

    this.finalizePromise = (async () => {
      await this.checkpoint();
      if (this.primaryWriteError) {
        throw this.primaryWriteError;
      }
      return this.paths?.logPath;
    })();
    return this.finalizePromise;
  }

  cancel(): void {
    void this.finalize('cancelled').catch(() => undefined);
  }

  dispose(): void {
    void this.finalize('disposed').catch(() => undefined);
  }

  async finish(globalStoragePath: string, workspaceRoot?: string): Promise<string | undefined> {
    if (!this.paths) {
      this.configureOutput({ globalStoragePath, workspaceRoot }, ++sessionSerial);
    }
    return this.finalize('success');
  }

  getLogPath(): string | undefined {
    return this.paths?.logPath;
  }

  getLatestPath(): string | undefined {
    return this.paths?.latestPath;
  }

  private configureOutput(output: SearchProfileOutput, serial: number): void {
    if (this.paths) {
      return;
    }

    const dir = getProfileLogDir(output.globalStoragePath);
    const stamp = formatTimestamp(new Date(this.startMs));
    const filename = `search-${stamp}-${serial}-${slugifyQuery(this.meta.query)}.jsonl`;
    const latestPath = path.join(dir, LATEST_PROFILE_FILENAME);
    const workspaceMirrorPath = output.workspaceRoot
      ? path.join(output.workspaceRoot, WORKSPACE_PROFILE_RELATIVE)
      : undefined;
    this.paths = {
      dir,
      logPath: path.join(dir, filename),
      latestPath,
      workspaceMirrorPath,
    };

    claimSharedPath(latestPath, this.sessionId);
    if (workspaceMirrorPath) {
      claimSharedPath(workspaceMirrorPath, this.sessionId);
    }

    const metaContent = serializeLines(this.lines);
    void this.enqueueFlush(async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(this.paths!.logPath, metaContent, 'utf8');
      await enqueueOwnedSnapshot(latestPath, this.sessionId, metaContent);
      this.queueWorkspaceMirror(metaContent);
    });
  }

  private scheduleCheckpoint(): void {
    if (!this.paths || this.checkpointTimer) {
      return;
    }
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = undefined;
      void this.checkpoint();
    }, PROFILE_CHECKPOINT_MS);
  }

  private enqueueFlush(work: () => Promise<void>): Promise<void> {
    const queued = this.flushQueue.then(work);
    this.flushQueue = queued.catch((error) => {
      if (this.primaryWriteError === undefined) {
        this.primaryWriteError = error;
      }
    });
    return queued;
  }

  private queueWorkspaceMirror(content: string): void {
    const mirrorPath = this.paths?.workspaceMirrorPath;
    if (!mirrorPath) {
      return;
    }
    void enqueueOwnedSnapshot(mirrorPath, this.sessionId, content).catch((error) => {
      this.workspaceMirrorError = errorText(error);
    });
  }
}

export function getProfileLogDir(globalStoragePath: string): string {
  return path.join(globalStoragePath, PROFILE_LOG_DIR_NAME);
}
