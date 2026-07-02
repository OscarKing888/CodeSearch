import * as chokidar from 'chokidar';
import * as path from 'path';
import { getIndexingSettings } from '../indexingSettings';

export type FileChangeHandler = (filePath: string, event: 'add' | 'change' | 'unlink') => void;

export class FileWatcher {
  private watcher: chokidar.FSWatcher | undefined;
  private handler: FileChangeHandler | undefined;

  start(rootDirs: string[], config: { excludeGlobs: string[] }, handler: FileChangeHandler): void {
    this.stop();
    this.handler = handler;

    const ignored = config.excludeGlobs.map((g) => {
      if (g.startsWith('**/')) {
        return g;
      }
      return `**/${g}`;
    });

    this.watcher = chokidar.watch(rootDirs, {
      ignored,
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
