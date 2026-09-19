import * as chokidar from 'chokidar';
import * as path from 'path';
import { IndexingSettings } from '../indexingSettings';
import { getIndexingMatcher, IndexingMatcher } from './excludePatterns';

export type FileChangeEvent = 'add' | 'change' | 'unlink';
export type FileChangeHandler = (
  filePath: string,
  event: FileChangeEvent
) => void | Promise<void>;

export interface FileWatchBackendSubscription {
  dispose(): void;
}

export interface FileWatchBackendStartOptions {
  rootDirs: readonly string[];
  includeGlobs: readonly string[];
  isIgnored(filePath: string, isDirectory?: boolean): boolean;
  onEvent(filePath: string, event: FileChangeEvent): void;
}

/** A small boundary that keeps VS Code, chokidar, and tests independent. */
export interface FileWatchBackend {
  start(options: FileWatchBackendStartOptions): FileWatchBackendSubscription;
}

interface PendingEvent {
  filePath: string;
  event: FileChangeEvent;
  ready: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface FileWatcherOptions {
  backend?: FileWatchBackend;
  settleMs?: number;
  drainBatchSize?: number;
}

const DEFAULT_SETTLE_MS = 300;
const DEFAULT_DRAIN_BATCH_SIZE = 50;

export class FileWatcher {
  private readonly backend: FileWatchBackend;
  private readonly settleMs: number;
  private readonly drainBatchSize: number;
  private subscription: FileWatchBackendSubscription | undefined;
  private handler: FileChangeHandler | undefined;
  private matcher: IndexingMatcher | undefined;
  private pending = new Map<string, PendingEvent>();
  private paused = false;
  private draining = false;
  private drainScheduled = false;
  private generation = 0;

  constructor(options: FileWatcherOptions = {}) {
    this.backend = options.backend ?? createDefaultFileWatchBackend();
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.drainBatchSize = options.drainBatchSize ?? DEFAULT_DRAIN_BATCH_SIZE;
  }

  start(rootDirs: string[], config: IndexingSettings, handler: FileChangeHandler): void {
    this.stop();
    this.handler = handler;
    this.matcher = getIndexingMatcher(config);
    const matcher = this.matcher;
    const generation = this.generation;
    const normalizedRoots = rootDirs.map((root) => path.normalize(root));

    this.subscription = this.backend.start({
      rootDirs: normalizedRoots,
      includeGlobs: config.includeGlobs,
      isIgnored: (filePath, isDirectory) => {
        const normalized = path.normalize(filePath);
        if (normalizedRoots.some((root) => pathsEqual(root, normalized))) {
          return false;
        }
        return matcher.isPathIgnored(normalized, isDirectory);
      },
      onEvent: (filePath, event) => {
        if (generation === this.generation) {
          this.acceptEvent(filePath, event);
        }
      },
    });
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.scheduleDrain();
  }

  stop(): void {
    this.generation++;
    this.subscription?.dispose();
    this.subscription = undefined;
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    this.pending.clear();
    this.handler = undefined;
    this.matcher = undefined;
    this.drainScheduled = false;
  }

  private acceptEvent(filePath: string, event: FileChangeEvent): void {
    const matcher = this.matcher;
    if (!matcher) {
      return;
    }

    const normalized = path.normalize(filePath);
    // A delete can name a parent directory rather than its contained files.
    // Even paths excluded by today's settings can still have indexed rows.
    if (event !== 'unlink' &&
      (matcher.isPathIgnored(normalized) || !matcher.matchesIncludeGlob(normalized))) {
      return;
    }

    const key = pathKey(normalized);
    const previous = this.pending.get(key);
    if (previous?.timer) {
      clearTimeout(previous.timer);
    }

    const pending: PendingEvent = {
      filePath: normalized,
      event: mergeEvents(previous?.event, event),
      ready: false,
      timer: undefined,
    };
    pending.timer = setTimeout(() => {
      if (this.pending.get(key) !== pending) {
        return;
      }
      pending.timer = undefined;
      pending.ready = true;
      this.scheduleDrain();
    }, this.settleMs);
    this.pending.set(key, pending);
  }

  private scheduleDrain(): void {
    if (this.paused || this.draining || this.drainScheduled || !this.handler) {
      return;
    }
    let hasReadyEvent = false;
    for (const pending of this.pending.values()) {
      if (pending.ready) {
        hasReadyEvent = true;
        break;
      }
    }
    if (!hasReadyEvent) {
      return;
    }

    const generation = this.generation;
    this.drainScheduled = true;
    setImmediate(() => {
      if (generation !== this.generation) {
        return;
      }
      this.drainScheduled = false;
      void this.drain(generation);
    });
  }

  private async drain(generation: number): Promise<void> {
    if (this.draining || this.paused || generation !== this.generation) {
      return;
    }
    this.draining = true;
    try {
      while (!this.paused && generation === this.generation) {
        const batch: PendingEvent[] = [];
        for (const [key, pending] of this.pending) {
          if (!pending.ready) {
            continue;
          }
          this.pending.delete(key);
          batch.push(pending);
          if (batch.length >= this.drainBatchSize) {
            break;
          }
        }
        if (batch.length === 0) {
          break;
        }

        for (const pending of batch) {
          if (generation !== this.generation) {
            continue;
          }
          if (this.paused) {
            this.restoreReadyEvent(pending);
            continue;
          }
          try {
            await this.handler?.(pending.filePath, pending.event);
          } catch (error) {
            console.error('Ace Code Search: file watcher handler failed', error);
          }
        }

        if (!this.paused && generation === this.generation) {
          await yieldToEventLoop();
        }
      }
    } finally {
      this.draining = false;
      this.scheduleDrain();
    }
  }

  private restoreReadyEvent(event: PendingEvent): void {
    const key = pathKey(event.filePath);
    const newer = this.pending.get(key);
    if (newer) {
      newer.event = mergeEvents(event.event, newer.event);
      return;
    }
    event.ready = true;
    event.timer = undefined;
    this.pending.set(key, event);
  }
}

function mergeEvents(previous: FileChangeEvent | undefined, next: FileChangeEvent): FileChangeEvent {
  if (!previous) {
    return next;
  }
  if (next === 'unlink') {
    return 'unlink';
  }
  if (previous === 'add' && next === 'change') {
    return 'add';
  }
  if (previous === 'unlink') {
    return 'add';
  }
  return next;
}

function pathKey(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsEqual(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDefaultFileWatchBackend(): FileWatchBackend {
  const vscode = tryGetVsCodeApi();
  return vscode ? new VsCodeFileWatchBackend(vscode) : new ChokidarFileWatchBackend();
}

type VsCodeApi = typeof import('vscode');

function tryGetVsCodeApi(): VsCodeApi | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const candidate = require('vscode') as {
      workspace?: { createFileSystemWatcher?: unknown };
      RelativePattern?: unknown;
    };
    if (
      typeof candidate?.workspace?.createFileSystemWatcher === 'function' &&
      typeof candidate.RelativePattern === 'function'
    ) {
      return candidate as unknown as VsCodeApi;
    }
  } catch {
    // CLI and tests intentionally use the chokidar fallback.
  }
  return undefined;
}

export class VsCodeFileWatchBackend implements FileWatchBackend {
  constructor(private readonly vscode: VsCodeApi) {}

  start(options: FileWatchBackendStartOptions): FileWatchBackendSubscription {
    const disposables: Array<{ dispose(): unknown }> = [];
    const registrations = new Set<string>();

    for (const rootDir of options.rootDirs) {
      const rootKey = pathKey(rootDir);
      if (registrations.has(rootKey)) {
        continue;
      }
      registrations.add(rootKey);

      // VS Code folds recursive deletes into the parent folder event. A
      // file-only include glob (e.g. **/*.cpp) cannot receive that event.
      const deleteWatcher = this.vscode.workspace.createFileSystemWatcher(
        new this.vscode.RelativePattern(rootDir, '**'),
        true,
        true,
        false
      );
      disposables.push(
        deleteWatcher.onDidDelete((uri) => options.onEvent(uri.fsPath, 'unlink')),
        deleteWatcher
      );

      for (const includeGlob of new Set(options.includeGlobs)) {
        const watcher = this.vscode.workspace.createFileSystemWatcher(
          new this.vscode.RelativePattern(rootDir, includeGlob),
          false,
          false,
          true
        );
        disposables.push(
          watcher.onDidCreate((uri) => options.onEvent(uri.fsPath, 'add')),
          watcher.onDidChange((uri) => options.onEvent(uri.fsPath, 'change')),
          watcher
        );
      }
    }

    return {
      dispose: () => {
        for (const disposable of disposables.reverse()) {
          disposable.dispose();
        }
      },
    };
  }
}

export class ChokidarFileWatchBackend implements FileWatchBackend {
  start(options: FileWatchBackendStartOptions): FileWatchBackendSubscription {
    if (options.rootDirs.length === 0 || options.includeGlobs.length === 0) {
      return { dispose: () => undefined };
    }
    const normalizedRoots = options.rootDirs.map((root) => path.normalize(root));
    const watcher = chokidar.watch(normalizedRoots, {
      ignored: (watchPath, stats) => {
        const normalized = path.normalize(watchPath);
        if (normalizedRoots.some((root) => pathsEqual(root, normalized))) {
          return false;
        }
        return options.isIgnored(normalized, stats?.isDirectory());
      },
      persistent: true,
      ignoreInitial: true,
      depth: undefined,
    });

    watcher.on('add', (filePath) => options.onEvent(filePath, 'add'));
    watcher.on('change', (filePath) => options.onEvent(filePath, 'change'));
    watcher.on('unlink', (filePath) => options.onEvent(filePath, 'unlink'));
    watcher.on('unlinkDir', (filePath) => options.onEvent(filePath, 'unlink'));

    return {
      dispose: () => {
        void watcher.close();
      },
    };
  }
}
