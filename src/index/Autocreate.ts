import * as fs from 'fs';

import * as path from 'path';

import * as vscode from 'vscode';

import {

  DEFAULT_EXCLUDE_DIR_NAMES,

  DEFAULT_EXCLUDE_FILE_NAMES,

  DEFAULT_EXCLUDE_GLOBS,

  DEFAULT_INDEXING_SETTINGS,

} from '../indexingSettings';

import { PerIndexExcludes } from './excludePatterns';
import { AutocreateConfig } from './types';
import { pruneNestedRoots } from './workspaceRoots';



const AUTOCREATE_NAMES = ['code-search.autocreate'];



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

  if (result.excludeDirNames) {

    result.excludeDirNames = result.excludeDirNames.map((s) => resolve(s).replace(/\\\\/g, '\\'));

  }

  if (result.excludeFileNames) {

    result.excludeFileNames = result.excludeFileNames.map((s) => resolve(s));

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

  return path.join(globalStorage, 'code-search', workspaceHash, 'index.db');

}



export function extractPerIndexExcludesFromAutocreate(config: AutocreateConfig): PerIndexExcludes | undefined {

  const rules: PerIndexExcludes = {};

  if (config.excludeDirNames?.length) {

    rules.excludeDirNames = config.excludeDirNames;

  }

  if (config.excludeFileNames?.length) {

    rules.excludeFileNames = config.excludeFileNames;

  }

  if (config.excludeList?.length) {

    rules.excludeGlobs = config.excludeList;

  }

  if (!rules.excludeDirNames?.length && !rules.excludeFileNames?.length && !rules.excludeGlobs?.length) {

    return undefined;

  }

  return rules;

}



function mergeUnique(current: string[], additions: string[]): string[] {

  const seen = new Set(current);

  const merged = [...current];

  for (const item of additions) {

    if (!seen.has(item)) {

      seen.add(item);

      merged.push(item);

    }

  }

  return merged;

}



export function applyAutocreateToConfig(config: AutocreateConfig): void {

  const cfg = vscode.workspace.getConfiguration('codeSearch');



  if (config.ignoreGlobalExclusions) {

    if (config.excludeList?.length) {

      void cfg.update('excludeGlobs', config.excludeList, vscode.ConfigurationTarget.Workspace);

    }

    if (config.excludeDirNames?.length) {

      void cfg.update('excludeDirNames', config.excludeDirNames, vscode.ConfigurationTarget.Workspace);

    }

    if (config.excludeFileNames?.length) {

      void cfg.update('excludeFileNames', config.excludeFileNames, vscode.ConfigurationTarget.Workspace);

    }

  } else {

    if (config.excludeList?.length) {

      const current = cfg.get<string[]>('excludeGlobs', DEFAULT_EXCLUDE_GLOBS);

      void cfg.update(

        'excludeGlobs',

        mergeUnique(current, config.excludeList),

        vscode.ConfigurationTarget.Workspace

      );

    }

    if (config.excludeDirNames?.length) {

      const current = cfg.get<string[]>('excludeDirNames', DEFAULT_EXCLUDE_DIR_NAMES);

      void cfg.update(

        'excludeDirNames',

        mergeUnique(current, config.excludeDirNames),

        vscode.ConfigurationTarget.Workspace

      );

    }

    if (config.excludeFileNames?.length) {

      const current = cfg.get<string[]>('excludeFileNames', DEFAULT_EXCLUDE_FILE_NAMES);

      void cfg.update(

        'excludeFileNames',

        mergeUnique(current, config.excludeFileNames),

        vscode.ConfigurationTarget.Workspace

      );

    }

  }



  if (config.includeList?.length && config.ignoreGlobalInclusions) {

    void cfg.update('includeGlobs', config.includeList, vscode.ConfigurationTarget.Workspace);

  } else if (config.includeList?.length) {

    const current = cfg.get<string[]>('includeGlobs', DEFAULT_INDEXING_SETTINGS.includeGlobs);

    void cfg.update(

      'includeGlobs',

      mergeUnique(current, config.includeList),

      vscode.ConfigurationTarget.Workspace

    );

  }

}



export function getEffectiveRoots(workspaceFolders: readonly vscode.WorkspaceFolder[], autocreateRoot?: string): string[] {

  if (autocreateRoot) {

    return [autocreateRoot];

  }

  return pruneNestedRoots(workspaceFolders.map((f) => f.uri.fsPath));

}


