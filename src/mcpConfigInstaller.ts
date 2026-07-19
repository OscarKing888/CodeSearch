import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const MCP_SERVER_NAME = 'ace-code-search';
const CODEX_BEGIN = '# BEGIN ACE-CODE-SEARCH-MCP';
const CODEX_END = '# END ACE-CODE-SEARCH-MCP';

export interface McpConfigInstallOptions {
  extensionRoot: string;
  /** Optional override for home directory (tests). */
  homeDir?: string;
  /** Optional project root; when set, also writes `{workspace}/.codex/config.toml`. */
  workspaceRoot?: string;
}

export interface McpConfigPathResult {
  client: 'codex-user' | 'codex-project' | 'cursor-user';
  path: string;
  changed: boolean;
  warning?: string;
}

export interface McpConfigInstallResult {
  mcpJsPath: string;
  changed: boolean;
  paths: McpConfigPathResult[];
  warnings: string[];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function resolveMcpJsPath(extensionRoot: string): string {
  return path.join(extensionRoot, 'dist', 'mcp.js');
}

export function buildCodexMcpServerBlock(
  mcpJsPath: string,
  extensionRoot: string
): string {
  return [
    CODEX_BEGIN,
    `# Managed by Ace Code Search. Restart Codex after changes.`,
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = "node"`,
    `args = [${tomlString(mcpJsPath)}, "--extension-root", ${tomlString(extensionRoot)}]`,
    `startup_timeout_sec = 30`,
    `tool_timeout_sec = 120`,
    `enabled = true`,
    CODEX_END,
    '',
  ].join('\n');
}

export function upsertCodexMcpBlock(
  existing: string,
  mcpJsPath: string,
  extensionRoot: string
): { content: string; changed: boolean } {
  const block = buildCodexMcpServerBlock(mcpJsPath, extensionRoot);
  const begin = existing.indexOf(CODEX_BEGIN);
  const end = existing.indexOf(CODEX_END);

  if (begin >= 0 && end > begin) {
    const afterEnd = end + CODEX_END.length;
    let nextNewline = afterEnd;
    while (
      nextNewline < existing.length &&
      (existing[nextNewline] === '\n' || existing[nextNewline] === '\r')
    ) {
      nextNewline += 1;
    }
    const before = existing.slice(0, begin).replace(/\s+$/, '');
    const after = existing.slice(nextNewline).replace(/^\s+/, '');
    const parts: string[] = [];
    if (before) {
      parts.push(before);
    }
    parts.push(block.replace(/\s+$/, ''));
    if (after) {
      parts.push(after.replace(/\s+$/, ''));
    }
    const next = `${parts.join('\n\n')}\n`;
    const normalizedExisting = existing.replace(/\s+$/, '') + '\n';
    return {
      content: next,
      changed: normalizedExisting !== next,
    };
  }

  // Remove a prior unmanaged ace-code-search table if present, then append.
  const unmanaged =
    /(?:^|\n)\[mcp_servers\.ace-code-search\][\s\S]*?(?=\n\[|\n*$)/;
  let cleaned = existing.replace(unmanaged, '\n');
  cleaned = cleaned.replace(/\s+$/, '');
  const next = cleaned.length > 0 ? `${cleaned}\n\n${block}` : block;
  return {
    content: next.replace(/\s+$/, '') + '\n',
    changed: true,
  };
}

export function buildCursorMcpServerEntry(
  mcpJsPath: string,
  extensionRoot: string
): Record<string, unknown> {
  return {
    command: 'node',
    args: [mcpJsPath, '--extension-root', extensionRoot],
  };
}

export function upsertCursorMcpJson(
  existingRaw: string | undefined,
  mcpJsPath: string,
  extensionRoot: string
): { content: string; changed: boolean; warning?: string } {
  let parsed: Record<string, unknown> = {};
  if (existingRaw && existingRaw.trim()) {
    try {
      parsed = JSON.parse(existingRaw) as Record<string, unknown>;
    } catch {
      return {
        content: existingRaw ?? '',
        changed: false,
        warning:
          'Skipped Cursor MCP config because ~/.cursor/mcp.json is not valid JSON.',
      };
    }
  }

  const servers =
    parsed.mcpServers && typeof parsed.mcpServers === 'object'
      ? ({ ...(parsed.mcpServers as Record<string, unknown>) } as Record<
          string,
          unknown
        >)
      : {};
  const nextEntry = buildCursorMcpServerEntry(mcpJsPath, extensionRoot);
  const prev = servers[MCP_SERVER_NAME];
  const unchanged =
    prev &&
    JSON.stringify(prev) === JSON.stringify(nextEntry);
  if (unchanged) {
    return {
      content: `${JSON.stringify(parsed, null, 2)}\n`,
      changed: false,
    };
  }
  servers[MCP_SERVER_NAME] = nextEntry;
  const next = {
    ...parsed,
    mcpServers: servers,
  };
  return {
    content: `${JSON.stringify(next, null, 2)}\n`,
    changed: true,
  };
}

async function ensureMcpJsExists(mcpJsPath: string): Promise<void> {
  try {
    await fs.promises.access(mcpJsPath, fs.constants.F_OK);
  } catch {
    throw new Error(
      `MCP entrypoint not found: ${mcpJsPath}. Rebuild the extension (npm run build) and reinstall.`
    );
  }
}

async function writeCodexConfig(
  configPath: string,
  mcpJsPath: string,
  extensionRoot: string,
  client: 'codex-user' | 'codex-project'
): Promise<McpConfigPathResult> {
  let existing = '';
  try {
    existing = await fs.promises.readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const { content, changed } = upsertCodexMcpBlock(
    existing,
    mcpJsPath,
    extensionRoot
  );
  if (changed) {
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, content, 'utf8');
  }
  return { client, path: configPath, changed };
}

/**
 * Register the Ace Code Search stdio MCP server for Codex and Cursor.
 *
 * Codex (VS Code extension / CLI / desktop) reads `~/.codex/config.toml`.
 * Skill files alone do not expose `list_indexes` / `search_code` tools.
 */
export async function installMcpClientConfig(
  options: McpConfigInstallOptions
): Promise<McpConfigInstallResult> {
  const mcpJsPath = resolveMcpJsPath(options.extensionRoot);
  await ensureMcpJsExists(mcpJsPath);

  const homeDir = options.homeDir ?? os.homedir();
  const paths: McpConfigPathResult[] = [];

  paths.push(
    await writeCodexConfig(
      path.join(homeDir, '.codex', 'config.toml'),
      mcpJsPath,
      options.extensionRoot,
      'codex-user'
    )
  );

  if (options.workspaceRoot) {
    paths.push(
      await writeCodexConfig(
        path.join(options.workspaceRoot, '.codex', 'config.toml'),
        mcpJsPath,
        options.extensionRoot,
        'codex-project'
      )
    );
  }

  const cursorPath = path.join(homeDir, '.cursor', 'mcp.json');
  let cursorRaw: string | undefined;
  try {
    cursorRaw = await fs.promises.readFile(cursorPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const cursorUpsert = upsertCursorMcpJson(
    cursorRaw,
    mcpJsPath,
    options.extensionRoot
  );
  if (cursorUpsert.warning) {
    paths.push({
      client: 'cursor-user',
      path: cursorPath,
      changed: false,
      warning: cursorUpsert.warning,
    });
  } else if (cursorUpsert.changed) {
    await fs.promises.mkdir(path.dirname(cursorPath), { recursive: true });
    await fs.promises.writeFile(cursorPath, cursorUpsert.content, 'utf8');
    paths.push({
      client: 'cursor-user',
      path: cursorPath,
      changed: true,
    });
  } else {
    paths.push({
      client: 'cursor-user',
      path: cursorPath,
      changed: false,
    });
  }

  const warnings = paths
    .map((item) => item.warning)
    .filter((item): item is string => Boolean(item));

  return {
    mcpJsPath,
    changed: paths.some((item) => item.changed),
    paths,
    warnings,
  };
}
