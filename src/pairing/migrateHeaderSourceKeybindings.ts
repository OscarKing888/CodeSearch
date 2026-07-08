import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type EditorProduct = 'Cursor' | 'Code';

export const LEGACY_HEADER_SOURCE_COMMANDS = new Set([
  'C_Cpp.SwitchHeaderSource',
  'clangd.switchheadersource',
]);

export const TARGET_HEADER_SOURCE_COMMAND = 'codeSearch.switchHeaderSource';

export interface KeybindingEntry {
  key?: string;
  command?: string;
  when?: string;
  mac?: string;
  [extra: string]: unknown;
}

function normalizeKey(key: string): string {
  return key.replace(/\s+/g, '').toLowerCase();
}

function isAltOKey(key: string | undefined): boolean {
  if (!key) {
    return false;
  }
  const normalized = normalizeKey(key);
  return normalized === 'alt+o' || normalized === 'o+alt';
}

export function stripJsoncComments(text: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

export function parseKeybindingsJson(text: string): KeybindingEntry[] {
  const stripped = stripJsoncComments(text).trim();
  if (!stripped) {
    return [];
  }
  const parsed = JSON.parse(stripped) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('keybindings.json must contain a JSON array');
  }
  return parsed as KeybindingEntry[];
}

function defaultCppWhen(when: string | undefined): string | undefined {
  if (when && when.trim().length > 0) {
    return when;
  }
  return "editorTextFocus && (editorLangId == 'cpp' || editorLangId == 'c')";
}

export function migrateKeybindings(entries: KeybindingEntry[]): {
  entries: KeybindingEntry[];
  changed: boolean;
} {
  let changed = false;
  let hadLegacyAltO = false;

  const migrated = entries.map((entry) => {
    if (!entry.command || entry.command.startsWith('-')) {
      return entry;
    }
    if (!LEGACY_HEADER_SOURCE_COMMANDS.has(entry.command)) {
      return entry;
    }
    if (!isAltOKey(entry.key) && !isAltOKey(typeof entry.mac === 'string' ? entry.mac : undefined)) {
      return entry;
    }

    hadLegacyAltO = true;
    changed = true;
    return {
      ...entry,
      command: TARGET_HEADER_SOURCE_COMMAND,
      when: defaultCppWhen(entry.when),
    };
  });

  if (!hadLegacyAltO) {
    return { entries, changed: false };
  }

  const next = [...migrated];
  for (const legacyCommand of LEGACY_HEADER_SOURCE_COMMANDS) {
    const hasUnbind = next.some(
      (entry) => entry.command === `-${legacyCommand}` && isAltOKey(entry.key)
    );
    if (!hasUnbind) {
      next.unshift({
        key: 'alt+o',
        command: `-${legacyCommand}`,
        when: "editorTextFocus && (editorLangId == 'cpp' || editorLangId == 'c')",
      });
      changed = true;
    }
  }

  const hasTargetBinding = next.some(
    (entry) =>
      entry.command === TARGET_HEADER_SOURCE_COMMAND &&
      (isAltOKey(entry.key) || isAltOKey(typeof entry.mac === 'string' ? entry.mac : undefined))
  );

  if (!hasTargetBinding) {
    next.push({
      key: 'alt+o',
      command: TARGET_HEADER_SOURCE_COMMAND,
      when: "editorTextFocus && (editorLangId == 'cpp' || editorLangId == 'c')",
    });
    changed = true;
  }

  return { entries: next, changed };
}

export function serializeKeybindings(entries: KeybindingEntry[], leadingComment?: string): string {
  const prefix = leadingComment ? `${leadingComment}\n` : '';
  return `${prefix}${JSON.stringify(entries, null, 4)}\n`;
}

export function resolveUserKeybindingsPath(
  product: EditorProduct,
  platform: NodeJS.Platform = process.platform,
  appData = process.env.APPDATA,
  homeDir = os.homedir()
): string | undefined {
  if (platform === 'win32') {
    if (!appData) {
      return undefined;
    }
    return path.join(appData, product, 'User', 'keybindings.json');
  }

  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', product, 'User', 'keybindings.json');
  }

  return path.join(homeDir, '.config', product, 'User', 'keybindings.json');
}

export async function migrateUserHeaderSourceKeybindings(
  product: EditorProduct,
  log?: (message: string) => void
): Promise<boolean> {
  const keybindingsPath = resolveUserKeybindingsPath(product);
  if (!keybindingsPath) {
    return false;
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(keybindingsPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    log?.(`无法读取快捷键文件 ${keybindingsPath}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  const leadingComment = raw.match(/^\s*(\/\/[^\n]*)/)?.[1];

  try {
    const parsed = parseKeybindingsJson(raw);
    const { entries, changed } = migrateKeybindings(parsed);
    if (!changed) {
      return false;
    }

    await fs.promises.writeFile(keybindingsPath, serializeKeybindings(entries, leadingComment), 'utf8');
    log?.(`已自动将 Alt+O 头/源切换快捷键迁移到 ${TARGET_HEADER_SOURCE_COMMAND}（${keybindingsPath}）`);
    return true;
  } catch (err) {
    log?.(`快捷键迁移失败: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
