import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const MCP_STATUS_SCHEMA_VERSION = 1;
export const MCP_STATUS_HEARTBEAT_MS = 2000;
export const MCP_STATUS_POLL_MS = 500;
export const MCP_STATUS_STALE_MS = 6000;
export const MCP_STATUS_BUSY_MIN_MS = 2000;
export const MCP_STATUS_CLEANUP_MS = 60_000;

const STATUS_DIR_NAME = 'status';
const STATUS_FILE_PREFIX = 'mcp-session-';
const STATUS_FILE_SUFFIX = '.json';

export type McpToolName =
  | 'list_indexes'
  | 'search_code'
  | 'read_indexed_file'
  | 'find_header_source';

export interface McpRuntimeRequest {
  id: string;
  tool: McpToolName;
  summary: string;
  startedAt: number;
}

export interface McpRecentRequest extends McpRuntimeRequest {
  completedAt: number;
}

export interface McpRuntimeRecordV1 {
  schemaVersion: 1;
  sessionId: string;
  pid: number;
  extensionVersion: string;
  workspaceRoots: string[];
  startedAt: number;
  updatedAt: number;
  activeRequests: McpRuntimeRequest[];
  recentRequest?: McpRecentRequest;
}

export interface McpStatusPayload {
  state: 'waiting' | 'ready' | 'busy';
  summary?: string;
  activeCount?: number;
}

interface McpStatusReporterOptions {
  extensionVersion: string;
  workspaceRoots: readonly string[];
  homeDir?: string;
  heartbeatMs?: number;
  busyMinMs?: number;
  now?: () => number;
  pid?: number;
  sessionId?: string;
  log?: (message: string) => void;
}

interface McpStatusMonitorOptions {
  workspaceRoots?: readonly string[];
  homeDir?: string;
  pollMs?: number;
  staleMs?: number;
  busyMinMs?: number;
  cleanupMs?: number;
  now?: () => number;
}

function normalizeRoots(roots: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const root of roots) {
    if (!root) continue;
    const resolved = path.resolve(root);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    unique.set(key, resolved);
  }
  return Array.from(unique.values());
}

export function resolveMcpStatusDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.ace-code-search', STATUS_DIR_NAME);
}

function isStatusFileName(name: string): boolean {
  return name.startsWith(STATUS_FILE_PREFIX) && name.endsWith(STATUS_FILE_SUFFIX);
}

function statusFileName(pid: number, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
  return `${STATUS_FILE_PREFIX}${pid}-${safeSessionId}${STATUS_FILE_SUFFIX}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sanitizeSummaryText(value: unknown, maxLength = 56): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeBaseName(value: unknown): string {
  const cleaned = sanitizeSummaryText(value, 512);
  if (!cleaned) return '';
  const normalized = cleaned.replace(/\\/g, '/');
  return sanitizeSummaryText(normalized.slice(normalized.lastIndexOf('/') + 1), 56);
}

export function summarizeMcpRequest(tool: McpToolName, args: unknown): string {
  const record = asRecord(args);
  switch (tool) {
    case 'search_code': {
      const query = sanitizeSummaryText(record?.query);
      return query ? `正在搜索 “${query}”` : '正在搜索代码';
    }
    case 'read_indexed_file': {
      const file = safeBaseName(record?.path);
      const start = Number.isInteger(record?.startLine) ? Number(record?.startLine) : undefined;
      const end = Number.isInteger(record?.endLine) ? Number(record?.endLine) : undefined;
      const range = start !== undefined
        ? `:${start}${end !== undefined && end !== start ? `–${end}` : ''}`
        : '';
      return file ? `正在读取 ${file}${range}` : '正在读取索引文件';
    }
    case 'find_header_source': {
      const file = safeBaseName(record?.path);
      return file ? `正在查找配对文件 ${file}` : '正在查找头文件/源文件配对';
    }
    case 'list_indexes':
      return '正在获取索引';
  }
}

function requestFromUnknown(value: unknown, recent: false): McpRuntimeRequest | undefined;
function requestFromUnknown(value: unknown, recent: true): McpRecentRequest | undefined;
function requestFromUnknown(
  value: unknown,
  recent: boolean
): McpRuntimeRequest | McpRecentRequest | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const tool = record.tool;
  if (
    typeof record.id !== 'string' ||
    !['list_indexes', 'search_code', 'read_indexed_file', 'find_header_source'].includes(
      String(tool)
    ) ||
    typeof record.summary !== 'string' ||
    typeof record.startedAt !== 'number'
  ) {
    return undefined;
  }
  const request: McpRuntimeRequest = {
    id: record.id,
    tool: tool as McpToolName,
    summary: sanitizeSummaryText(record.summary, 120),
    startedAt: record.startedAt,
  };
  if (!recent) return request;
  return typeof record.completedAt === 'number'
    ? { ...request, completedAt: record.completedAt }
    : undefined;
}

export function parseMcpRuntimeRecord(value: unknown): McpRuntimeRecordV1 | undefined {
  const record = asRecord(value);
  if (
    !record ||
    record.schemaVersion !== MCP_STATUS_SCHEMA_VERSION ||
    typeof record.sessionId !== 'string' ||
    typeof record.pid !== 'number' ||
    typeof record.extensionVersion !== 'string' ||
    !Array.isArray(record.workspaceRoots) ||
    !record.workspaceRoots.every((root) => typeof root === 'string') ||
    typeof record.startedAt !== 'number' ||
    typeof record.updatedAt !== 'number' ||
    !Array.isArray(record.activeRequests)
  ) {
    return undefined;
  }
  const activeRequests = record.activeRequests
    .map((request) => requestFromUnknown(request, false))
    .filter((request): request is McpRuntimeRequest => Boolean(request));
  if (activeRequests.length !== record.activeRequests.length) return undefined;
  const recentRequest = record.recentRequest === undefined
    ? undefined
    : requestFromUnknown(record.recentRequest, true);
  if (record.recentRequest !== undefined && !recentRequest) return undefined;
  return {
    schemaVersion: MCP_STATUS_SCHEMA_VERSION,
    sessionId: record.sessionId,
    pid: record.pid,
    extensionVersion: record.extensionVersion,
    workspaceRoots: normalizeRoots(record.workspaceRoots),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    activeRequests,
    recentRequest,
  };
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const candidateKey = pathKey(candidate);
  const parentKey = pathKey(parent);
  return candidateKey === parentKey || candidateKey.startsWith(`${parentKey}${path.sep}`);
}

export function workspaceRootsOverlap(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.some((leftRoot) =>
    right.some(
      (rightRoot) =>
        isSameOrInside(leftRoot, rightRoot) || isSameOrInside(rightRoot, leftRoot)
    )
  );
}

export function aggregateMcpStatus(
  records: readonly McpRuntimeRecordV1[],
  workspaceRoots: readonly string[],
  now = Date.now(),
  staleMs = MCP_STATUS_STALE_MS,
  busyMinMs = MCP_STATUS_BUSY_MIN_MS
): McpStatusPayload {
  // Records are aggregated only for the human-facing workspace indicator.
  // Tool requests and responses stay on each server's independent stdio
  // transport and McpIndexSession; this function never participates in routing.
  const matching = records.filter(
    (record) =>
      now - record.updatedAt <= staleMs &&
      record.updatedAt <= now + staleMs &&
      workspaceRootsOverlap(record.workspaceRoots, workspaceRoots)
  );
  if (matching.length === 0) return { state: 'waiting' };

  const active = matching
    .flatMap((record) => record.activeRequests)
    .sort((left, right) => right.startedAt - left.startedAt);
  if (active.length > 0) {
    const extra = active.length > 1 ? `（另有 ${active.length - 1} 个请求）` : '';
    return {
      state: 'busy',
      summary: `${active[0].summary}${extra}`,
      activeCount: active.length,
    };
  }

  const recent = matching
    .map((record) => record.recentRequest)
    .filter((request): request is McpRecentRequest => Boolean(request))
    .filter((request) => now - request.completedAt < busyMinMs)
    .sort((left, right) => right.completedAt - left.completedAt);
  return recent.length > 0
    ? { state: 'busy', summary: recent[0].summary, activeCount: 0 }
    : { state: 'ready' };
}

async function atomicWritePrivate(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await fs.promises.chmod(directory, 0o700).catch(() => undefined);
  }
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  try {
    await fs.promises.writeFile(temporaryPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    let attempt = 0;
    while (true) {
      try {
        await fs.promises.rename(temporaryPath, filePath);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const retryable =
          process.platform === 'win32' &&
          (code === 'EPERM' || code === 'EACCES') &&
          attempt < 3;
        if (!retryable) throw error;
        attempt++;
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * 10));
      }
    }
    if (process.platform !== 'win32') {
      await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
    }
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
  }
}

export class McpStatusReporter {
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly busyMinMs: number;
  private readonly pid: number;
  private readonly sessionId: string;
  private readonly startedAt: number;
  private readonly filePath: string;
  private readonly activeRequests = new Map<string, McpRuntimeRequest>();
  private workspaceRoots: string[];
  private recentRequest: McpRecentRequest | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private recentTimer: NodeJS.Timeout | undefined;
  private writeTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private writeErrorReported = false;

  constructor(private readonly options: McpStatusReporterOptions) {
    this.now = options.now ?? Date.now;
    this.heartbeatMs = options.heartbeatMs ?? MCP_STATUS_HEARTBEAT_MS;
    this.busyMinMs = options.busyMinMs ?? MCP_STATUS_BUSY_MIN_MS;
    this.pid = options.pid ?? process.pid;
    this.sessionId = options.sessionId ?? crypto.randomBytes(12).toString('hex');
    this.startedAt = this.now();
    this.workspaceRoots = normalizeRoots(options.workspaceRoots);
    this.filePath = path.join(
      resolveMcpStatusDir(options.homeDir),
      statusFileName(this.pid, this.sessionId)
    );
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    this.scheduleWrite();
    await this.flush();
    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.scheduleWrite(), this.heartbeatMs);
      this.heartbeatTimer.unref?.();
    }
  }

  updateWorkspaceRoots(workspaceRoots: readonly string[]): void {
    this.workspaceRoots = normalizeRoots(workspaceRoots);
    this.scheduleWrite();
  }

  beginRequest(tool: McpToolName, args: unknown): string {
    const id = crypto.randomBytes(8).toString('hex');
    this.activeRequests.set(id, {
      id,
      tool,
      summary: summarizeMcpRequest(tool, args),
      startedAt: this.now(),
    });
    this.scheduleWrite();
    return id;
  }

  finishRequest(id: string): void {
    const request = this.activeRequests.get(id);
    if (!request) return;
    this.activeRequests.delete(id);
    this.recentRequest = { ...request, completedAt: this.now() };
    if (this.recentTimer) clearTimeout(this.recentTimer);
    this.recentTimer = setTimeout(() => {
      this.recentRequest = undefined;
      this.scheduleWrite();
    }, this.busyMinMs);
    this.recentTimer.unref?.();
    this.scheduleWrite();
  }

  async run<T>(tool: McpToolName, args: unknown, operation: () => T | Promise<T>): Promise<T> {
    const id = this.beginRequest(tool, args);
    try {
      return await operation();
    } finally {
      this.finishRequest(id);
    }
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.recentTimer) clearTimeout(this.recentTimer);
    await this.writeTail.catch(() => undefined);
    await fs.promises.unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') this.logWriteError(error);
    });
  }

  private snapshot(): McpRuntimeRecordV1 {
    return {
      schemaVersion: MCP_STATUS_SCHEMA_VERSION,
      sessionId: this.sessionId,
      pid: this.pid,
      extensionVersion: this.options.extensionVersion,
      workspaceRoots: [...this.workspaceRoots],
      startedAt: this.startedAt,
      updatedAt: this.now(),
      activeRequests: Array.from(this.activeRequests.values()),
      recentRequest: this.recentRequest,
    };
  }

  private scheduleWrite(): void {
    if (this.disposed) return;
    this.writeTail = this.writeTail
      .catch(() => undefined)
      .then(async () => {
        try {
          await atomicWritePrivate(this.filePath, `${JSON.stringify(this.snapshot())}\n`);
          this.writeErrorReported = false;
        } catch (error) {
          this.logWriteError(error);
        }
      });
  }

  private logWriteError(error: unknown): void {
    if (this.writeErrorReported) return;
    this.writeErrorReported = true;
    const message = error instanceof Error ? error.message : String(error);
    this.options.log?.(`MCP status telemetry unavailable: ${message}`);
  }
}

export class McpStatusMonitor extends EventEmitter {
  private readonly now: () => number;
  private readonly statusDir: string;
  private readonly pollMs: number;
  private readonly staleMs: number;
  private readonly busyMinMs: number;
  private readonly cleanupMs: number;
  private workspaceRoots: string[];
  private status: McpStatusPayload = { state: 'waiting' };
  private pollTimer: NodeJS.Timeout | undefined;
  private refreshPromise: Promise<void> | undefined;
  private disposed = false;

  constructor(options: McpStatusMonitorOptions = {}) {
    super();
    this.now = options.now ?? Date.now;
    this.statusDir = resolveMcpStatusDir(options.homeDir);
    this.pollMs = options.pollMs ?? MCP_STATUS_POLL_MS;
    this.staleMs = options.staleMs ?? MCP_STATUS_STALE_MS;
    this.busyMinMs = options.busyMinMs ?? MCP_STATUS_BUSY_MIN_MS;
    this.cleanupMs = options.cleanupMs ?? MCP_STATUS_CLEANUP_MS;
    this.workspaceRoots = normalizeRoots(options.workspaceRoots ?? []);
  }

  start(): void {
    if (this.disposed || this.pollTimer) return;
    void this.refresh();
    if (this.pollMs > 0) {
      this.pollTimer = setInterval(() => void this.refresh(), this.pollMs);
      this.pollTimer.unref?.();
    }
  }

  setWorkspaceRoots(workspaceRoots: readonly string[]): void {
    this.workspaceRoots = normalizeRoots(workspaceRoots);
    void this.refresh();
  }

  getStatus(): McpStatusPayload {
    return { ...this.status };
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshNow().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.refreshPromise?.catch(() => undefined);
    this.removeAllListeners();
  }

  private async refreshNow(): Promise<void> {
    const records: McpRuntimeRecordV1[] = [];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.statusDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Status telemetry is best effort and must never disrupt the editor UI.
      }
      this.updateStatus({ state: 'waiting' });
      return;
    }

    const now = this.now();
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || !isStatusFileName(entry.name)) return;
        const filePath = path.join(this.statusDir, entry.name);
        try {
          const raw = await fs.promises.readFile(filePath, 'utf8');
          const record = parseMcpRuntimeRecord(JSON.parse(raw));
          if (record) {
            records.push(record);
            if (now - record.updatedAt > this.cleanupMs) {
              await fs.promises.unlink(filePath).catch(() => undefined);
            }
            return;
          }
        } catch {
          // A concurrent atomic replacement or malformed file is ignored.
        }
        const stat = await fs.promises.stat(filePath).catch(() => undefined);
        if (stat && now - stat.mtimeMs > this.cleanupMs) {
          await fs.promises.unlink(filePath).catch(() => undefined);
        }
      })
    );

    this.updateStatus(
      aggregateMcpStatus(
        records,
        this.workspaceRoots,
        now,
        this.staleMs,
        this.busyMinMs
      )
    );
  }

  private updateStatus(status: McpStatusPayload): void {
    if (
      this.status.state === status.state &&
      this.status.summary === status.summary &&
      this.status.activeCount === status.activeCount
    ) {
      return;
    }
    this.status = status;
    this.emit('change', this.getStatus());
  }
}
