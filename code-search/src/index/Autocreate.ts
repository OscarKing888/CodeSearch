import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AutocreateConfig } from './types';

const AUTOCREATE_NAMES = ['source-search.autocreate', 'EntrianSourceSearch.autocreate'];

export async function findAutocreateConfig(
  workspaceFolders: readonly vscode.WorkspaceFolder[]
): Promise<{ configPath: string; config: AutocreateConfig; rootDir: string } | null> {
  for (const folder of workspaceFolders) {
    let dir = folder.uri.fsPath;
    const root = dir;

    while (true) {
      for (const name of AUTOCREATE_NAMES) {
        const configPath = path.join(dir, name);
        try {
          await fs.promises.access(configPath);
          const config = await parseAutocreateFile(configPath, dir);
          return { configPath, config, rootDir: dir };
        } catch {
          // not found
        }
      }

      const parent = path.dirname(dir);
      if (parent === dir || !isUnderWorkspace(parent, root)) {
        break;
      }
      dir = parent;
    }
  }
  return null;
}

function isUnderWorkspace(dir: string, workspaceRoot: string): boolean {
  const d = dir.replace(/\\/g, '/').toLowerCase();
  const w = workspaceRoot.replace(/\\/g, '/').toLowerCase();
  return d.startsWith(w);
}

async function parseAutocreateFile(configPath: string, autocreateDir: string): Promise<AutocreateConfig> {
  const content = (await fs.promises.readFile(configPath, 'utf8')).trim();
  if (!content) {
    return {};
  }
  try {
    const raw = JSON.parse(content) as AutocreateConfig;
    return resolveAutocreateMacros(raw, autocreateDir);
  } catch {
    return {};
  }
}

function resolveAutocreateMacros(config: AutocreateConfig, autocreateDir: string): AutocreateConfig {
  const resolve = (s: string) => s.replace(/\$\(AutocreateDir\)/g, autocreateDir.replace(/\\/g, '\\\\'));
  const result: AutocreateConfig = { ...config };
  if (result.indexLocation) {
    result.indexLocation = resolve(result.indexLocation).replace(/\\\\/g, '\\');
  }
  if (result.excludeList) {
    result.excludeList = result.excludeList.map((s) => resolve(s).replace(/\\\\/g, '\\'));
  }
  if (result.includeList) {
    result.includeList = result.includeList.map((s) => resolve(s));
  }
  return result;
}

export function resolveIndexDbPath(
  config: AutocreateConfig,
  autocreateDir: string,
  globalStorage: string,
  workspaceHash: string
): string {
  if (config.indexLocation) {
    return path.join(config.indexLocation, workspaceHash, 'index.db');
  }
  return path.join(globalStorage, 'source-search', workspaceHash, 'index.db');
}

export function applyAutocreateToConfig(config: AutocreateConfig): void {
  const cfg = vscode.workspace.getConfiguration('codeSearch');
  if (config.excludeList?.length && config.ignoreGlobalExclusions) {
    void cfg.update('excludeGlobs', config.excludeList, vscode.ConfigurationTarget.Workspace);
  }
  if (config.includeList?.length && config.ignoreGlobalInclusions) {
    void cfg.update('includeGlobs', config.includeList, vscode.ConfigurationTarget.Workspace);
  }
}

export function getEffectiveRoots(workspaceFolders: readonly vscode.WorkspaceFolder[], autocreateRoot?: string): string[] {
  if (autocreateRoot) {
    return [autocreateRoot];
  }
  return workspaceFolders.map((f) => f.uri.fsPath);
}
