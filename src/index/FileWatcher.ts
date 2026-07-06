import * as chokidar from 'chokidar';
import * as path from 'path';
import { IndexingSettings } from '../indexingSettings';
import { isPathIgnored } from './excludePatterns';

export type FileChangeHandler = (filePath: string, event: 'add' | 'change' | 'unlink') => void;

export class FileWatcher {
  private watcher: chokidar.FSWatcher | undefined;
  private handler: FileChangeHandler | undefined;

  start(rootDirs: string[], config: IndexingSettings, handler: FileChangeHandler): void {
    this.stop();
    this.handler = handler;

    const normalizedRoots = rootDirs.map((r) => path.normalize(r));

    this.watcher = chokidar.watch(rootDirs, {
      ignored: (watchPath) => {
        const normalized = path.normalize(watchPath);
        if (normalizedRoots.some((root) => normalized === root)) {
          return false;
        }
        return isPathIgnored(normalized, config);
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      depth: undefined,
    });

    this.watcher.on('add', (p) => this.handler?.(path.normalize(p), 'add'));
    this.watcher.on('change', (p) => this.handler?.(path.normalize(p), 'change'));
    this.watcher.on('unlink', (p) => this.handler?.(path.normalize(p), 'unlink'));
  }

  stop(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = undefined;
    }
    this.handler = undefined;
  }
}
