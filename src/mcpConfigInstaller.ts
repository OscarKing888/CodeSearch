import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const MCP_SERVER_NAME = 'ace-code-search';
const OWNER = 'OscarKing888.ace-code-search';
const CODEX_BEGIN = '# BEGIN ACE-CODE-SEARCH-MCP';
const CODEX_END = '# END ACE-CODE-SEARCH-MCP';
const LAUNCHER_HEADER = '// ACE-CODE-SEARCH-MCP-LAUNCHER v1';
const LAUNCHER_DIR = '.ace-code-search';
const LAUNCHER_FILE = 'mcp-launcher.cjs';
const LAUNCHER_MARKER = '.mcp-launcher-managed.json';

interface ManagedLauncherMarker {
  owner: string;
  kind: 'mcp-launcher';
  version: string;
  sourceHash: string;
}

export interface McpConfigInstallOptions {
  extensionRoot: string;
  /** Optional override for home directory (tests). */
  homeDir?: string;
  /** Legacy project configs under these roots are removed only when verifiably managed. */
  workspaceRoots?: string[];
  /** Backward-compatible single-root cleanup option. */
  workspaceRoot?: string;
}

export interface McpConfigPathResult {
  client: 'launcher' | 'codex-user' | 'codex-project-legacy' | 'cursor-user';
  path: string;
  changed: boolean;
  warning?: string;
}

export interface McpConfigInstallResult {
  mcpJsPath: string;
  launcherPath: string;
  changed: boolean;
  paths: McpConfigPathResult[];
  warnings: string[];
}

interface TextUpdate {
  content: string;
  changed: boolean;
  warning?: string;
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  let targetPath = filePath;
  let mode = 0o600;
  try {
    const entry = await fs.promises.lstat(filePath);
    if (entry.isSymbolicLink()) {
      targetPath = await fs.promises.realpath(filePath);
    } else if (!entry.isFile()) {
      throw new Error('Refusing to replace non-file MCP config path: ' + filePath);
    }
    const target = await fs.promises.stat(targetPath);
    if (!target.isFile()) {
      throw new Error('Refusing to replace non-file MCP config target: ' + targetPath);
    }
    mode = target.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    const entry = await fs.promises.lstat(filePath).catch(
      (lstatError: NodeJS.ErrnoException) => {
        if (lstatError.code === 'ENOENT') return undefined;
        throw lstatError;
      }
    );
    if (entry?.isSymbolicLink()) {
      throw new Error('Refusing to replace dangling MCP config symlink: ' + filePath);
    }
  }

  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  try {
    await fs.promises.writeFile(temporaryPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode,
    });
    await fs.promises.rename(temporaryPath, targetPath);
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
  }
}

async function readTextIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function readLauncherMarker(
  markerPath: string
): Promise<ManagedLauncherMarker | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.promises.readFile(markerPath, 'utf8')
    ) as ManagedLauncherMarker;
    return parsed.owner === OWNER &&
      parsed.kind === 'mcp-launcher' &&
      typeof parsed.version === 'string' &&
      typeof parsed.sourceHash === 'string'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function readExtensionVersion(extensionRoot: string): string {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')
    ) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function resolveMcpJsPath(extensionRoot: string): string {
  return path.join(extensionRoot, 'dist', 'mcp.js');
}

export function resolveMcpLauncherPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, LAUNCHER_DIR, LAUNCHER_FILE);
}

/**
 * The user configs point to this stable file, not a versioned VSIX directory.
 * It selects the newest installed VS Code/Cursor copy on every launch and keeps
 * the current extension root only as a development/nonstandard-install fallback.
 */
export function buildMcpLauncher(extensionRoot: string): string {
  const fallbackRoot = JSON.stringify(path.resolve(extensionRoot));
  return `${LAUNCHER_HEADER}
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const fallbackRoot = ${fallbackRoot};

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function parseVersion(value) {
  const [core, prerelease = ''] = String(value || '0.0.0').split('-', 2);
  return {
    core: core.split('.').map((part) => Number(part) || 0),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index++) {
    const delta = (a.core[index] || 0) - (b.core[index] || 0);
    if (delta !== 0) return delta;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 :
      (a.prerelease.length === 0 ? 1 : -1);
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const aNumber = /^[0-9]+$/.test(a.prerelease[index]) ? Number(a.prerelease[index]) : undefined;
    const bNumber = /^[0-9]+$/.test(b.prerelease[index]) ? Number(b.prerelease[index]) : undefined;
    if (aNumber !== undefined && bNumber !== undefined && aNumber !== bNumber) return aNumber - bNumber;
    if (aNumber !== undefined && bNumber === undefined) return -1;
    if (aNumber === undefined && bNumber !== undefined) return 1;
    const delta = a.prerelease[index].localeCompare(b.prerelease[index]);
    if (delta !== 0) return delta;
  }
  return 0;
}

function inspectRoot(root) {
  try {
    const packagePath = path.join(root, 'package.json');
    const entryPath = path.join(root, 'dist', 'mcp.js');
    if (!fs.existsSync(packagePath) || !fs.existsSync(entryPath)) return undefined;
    const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (String(manifest.publisher || '').toLowerCase() !== 'oscarking888' ||
        manifest.name !== 'ace-code-search') return undefined;
    return {
      root: fs.realpathSync(root),
      version: String(manifest.version || '0.0.0'),
      mtimeMs: fs.statSync(packagePath).mtimeMs,
    };
  } catch {
    return undefined;
  }
}

function collectCandidates() {
  const candidates = [];
  const direct = [process.env.ACE_CODE_SEARCH_EXTENSION_ROOT, fallbackRoot].filter(Boolean);
  for (const root of direct) {
    const candidate = inspectRoot(root);
    if (candidate) candidates.push(candidate);
  }

  const home = os.homedir();
  const extensionDirs = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.vscode-server', 'extensions'),
    path.join(home, '.vscode-server-insiders', 'extensions'),
    path.join(home, '.cursor-server', 'extensions'),
  ];
  for (const extensionDir of extensionDirs) {
    let entries;
    try {
      entries = fs.readdirSync(extensionDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (!entry.name.toLowerCase().startsWith('oscarking888.ace-code-search-')) continue;
      const candidate = inspectRoot(path.join(extensionDir, entry.name));
      if (candidate) candidates.push(candidate);
    }
  }

  const unique = new Map();
  for (const candidate of candidates) unique.set(pathKey(candidate.root), candidate);
  return Array.from(unique.values()).sort((left, right) =>
    compareVersions(right.version, left.version) || right.mtimeMs - left.mtimeMs
  );
}

const selected = collectCandidates()[0];
if (!selected) {
  throw new Error(
    'Ace Code Search MCP extension files were not found. Reinstall the extension, then rerun its Agent Integration command.'
  );
}
const entryPath = path.join(selected.root, 'dist', 'mcp.js');
if (!process.argv.includes('--extension-root')) {
  process.argv.push('--extension-root', selected.root);
}
process.argv[1] = entryPath;
require(entryPath);
`;
}

async function installManagedLauncher(
  launcherPath: string,
  markerPath: string,
  content: string,
  version: string
): Promise<McpConfigPathResult> {
  const existing = await readTextIfPresent(launcherPath);
  const markerExists = await pathExists(markerPath);
  const marker = markerExists ? await readLauncherMarker(markerPath) : undefined;
  const sourceHash = hashContent(content);

  if (markerExists && !marker) {
    return {
      client: 'launcher',
      path: launcherPath,
      changed: false,
      warning: `Preserved MCP launcher because its management marker is invalid: ${launcherPath}`,
    };
  }
  if (existing !== undefined && !marker) {
    if (existing !== content) {
      return {
        client: 'launcher',
        path: launcherPath,
        changed: false,
        warning: `Preserved existing unmanaged MCP launcher at ${launcherPath}.`,
      };
    }
    await atomicWriteFile(
      markerPath,
      `${JSON.stringify({ owner: OWNER, kind: 'mcp-launcher', version, sourceHash }, null, 2)}\n`
    );
    return { client: 'launcher', path: launcherPath, changed: true };
  }
  if (marker && existing !== undefined && hashContent(existing) !== marker.sourceHash) {
    return {
      client: 'launcher',
      path: launcherPath,
      changed: false,
      warning: `Preserved user-modified MCP launcher at ${launcherPath}.`,
    };
  }
  if (
    marker?.version === version &&
    marker.sourceHash === sourceHash &&
    existing === content
  ) {
    return { client: 'launcher', path: launcherPath, changed: false };
  }

  await atomicWriteFile(launcherPath, content);
  await atomicWriteFile(
    markerPath,
    `${JSON.stringify(
      { owner: OWNER, kind: 'mcp-launcher', version, sourceHash } satisfies ManagedLauncherMarker,
      null,
      2
    )}\n`
  );
  return { client: 'launcher', path: launcherPath, changed: true };
}

export function buildCodexMcpServerBlock(
  launcherPath: string,
  _extensionRoot?: string
): string {
  return [
    CODEX_BEGIN,
    '# Managed by Ace Code Search. Restart Codex after changes.',
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    'command = "node"',
    `args = [${tomlString(launcherPath)}]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 120',
    'enabled = true',
    CODEX_END,
    '',
  ].join('\n');
}

interface ManagedRange {
  begin: number;
  end: number;
  block: string;
}

function markerOffsets(content: string, marker: string): number[] {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Array.from(content.matchAll(new RegExp(`^${escaped}[ \\t\\r]*$`, 'gm'))).map(
    (match) => match.index ?? -1
  );
}

function findManagedRange(existing: string): ManagedRange | { warning: string } | undefined {
  const begins = markerOffsets(existing, CODEX_BEGIN);
  const ends = markerOffsets(existing, CODEX_END);
  if (begins.length === 0 && ends.length === 0) {
    return undefined;
  }
  if (begins.length !== 1 || ends.length !== 1 || ends[0] <= begins[0]) {
    return {
      warning:
        'Preserved Codex config because the Ace Code Search BEGIN/END markers are malformed or duplicated.',
    };
  }
  const end = ends[0] + CODEX_END.length;
  return {
    begin: begins[0],
    end,
    block: existing.slice(begins[0], end),
  };
}

function isKnownLauncherPath(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.replace(/\\/g, '/').endsWith(`/${LAUNCHER_DIR}/${LAUNCHER_FILE}`)
  );
}

function isKnownLegacyMcpArgs(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return false;
  }
  const normalized = value.map((item) => item.replace(/\\/g, '/'));
  return (
    (value.length === 1 && isKnownLauncherPath(value[0])) ||
    (value.length === 3 &&
      normalized[0].endsWith('/dist/mcp.js') &&
      value[1] === '--extension-root' &&
      normalized[0] === `${normalized[2].replace(/\/$/, '')}/dist/mcp.js`)
  );
}

function isKnownManagedCodexBlock(block: string): boolean {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[0] !== CODEX_BEGIN || lines[lines.length - 1] !== CODEX_END) {
    return false;
  }
  const body = lines
    .slice(1, -1)
    .filter((line) => !line.startsWith('# Managed by Ace Code Search.'));
  if (
    body.length !== 6 ||
    body[0] !== `[mcp_servers.${MCP_SERVER_NAME}]` ||
    body[1] !== 'command = "node"' ||
    body[3] !== 'startup_timeout_sec = 30' ||
    body[4] !== 'tool_timeout_sec = 120' ||
    body[5] !== 'enabled = true' ||
    !body[2].startsWith('args = ')
  ) {
    return false;
  }
  try {
    return isKnownLegacyMcpArgs(JSON.parse(body[2].slice('args = '.length)));
  } catch {
    return false;
  }
}

function isTomlKey(value: string, expected: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === expected ||
    trimmed === JSON.stringify(expected) ||
    trimmed === "'" + expected + "'"
  );
}

/**
 * Detect user-owned TOML shapes that would conflict with appending our table.
 * This intentionally fails closed instead of normalizing arbitrary TOML
 * without a full parser.
 */
function hasUnmanagedCodexDefinition(existing: string): boolean {
  const targetTable =
    /^[ \t]*\[[ \t]*(?:mcp_servers|"mcp_servers"|'mcp_servers')[ \t]*\.[ \t]*(?:ace-code-search|"ace-code-search"|'ace-code-search')[ \t]*\][ \t]*(?:#.*)?\r?$/m;
  if (targetTable.test(existing)) {
    return true;
  }

  const targetDottedAssignment =
    /^[ \t]*(?:mcp_servers|"mcp_servers"|'mcp_servers')[ \t]*\.[ \t]*(?:ace-code-search|"ace-code-search"|'ace-code-search')[ \t]*(?:\.|=)/m;
  if (targetDottedAssignment.test(existing)) {
    return true;
  }

  // An inline parent table cannot be extended later with a child table.
  const inlineParentAssignment =
    /^[ \t]*(?:mcp_servers|"mcp_servers"|'mcp_servers')[ \t]*=[ \t]*\{/m;
  if (inlineParentAssignment.test(existing)) {
    return true;
  }

  let inParentTable = false;
  for (const line of existing.split(/\r?\n/)) {
    const table = line.match(/^[ \t]*\[([^\]]+)\][ \t]*(?:#.*)?$/);
    if (table) {
      inParentTable = isTomlKey(table[1], 'mcp_servers');
      continue;
    }
    if (!inParentTable || /^[ \t]*(?:#|$)/.test(line)) {
      continue;
    }
    if (
      /^[ \t]*(?:ace-code-search|"ace-code-search"|'ace-code-search')[ \t]*(?:\.|=)/.test(
        line
      )
    ) {
      return true;
    }
  }
  return false;
}

export function upsertCodexMcpBlock(
  existing: string,
  launcherPath: string,
  extensionRoot?: string
): TextUpdate {
  void extensionRoot;
  const block = buildCodexMcpServerBlock(launcherPath);
  const range = findManagedRange(existing);
  if (range && 'warning' in range) {
    return { content: existing, changed: false, warning: range.warning };
  }
  if (range) {
    if (!isKnownManagedCodexBlock(range.block)) {
      return {
        content: existing,
        changed: false,
        warning:
          'Preserved the Ace Code Search Codex block because it was modified after installation.',
      };
    }
    let after = range.end;
    if (existing.slice(after, after + 2) === '\r\n') {
      after += 2;
    } else if (existing[after] === '\n') {
      after += 1;
    }
    const content = `${existing.slice(0, range.begin)}${block}${existing.slice(after)}`;
    return { content, changed: content !== existing };
  }
  if (hasUnmanagedCodexDefinition(existing)) {
    return {
      content: existing,
      changed: false,
      warning:
        'Preserved an existing unmanaged ace-code-search MCP definition in Codex config.',
    };
  }

  let prefix = existing;
  if (prefix.length > 0 && !prefix.endsWith('\n')) {
    prefix += '\n';
  }
  if (prefix.length > 0 && !prefix.endsWith('\n\n')) {
    prefix += '\n';
  }
  return { content: `${prefix}${block}`, changed: true };
}

function removeManagedCodexBlock(existing: string): TextUpdate {
  const range = findManagedRange(existing);
  if (!range) {
    return { content: existing, changed: false };
  }
  if ('warning' in range) {
    return { content: existing, changed: false, warning: range.warning };
  }
  if (!isKnownManagedCodexBlock(range.block)) {
    return {
      content: existing,
      changed: false,
      warning:
        'Preserved legacy project Codex config because its managed block was modified.',
    };
  }
  let after = range.end;
  if (existing.slice(after, after + 2) === '\r\n') {
    after += 2;
  } else if (existing[after] === '\n') {
    after += 1;
  }
  const content = `${existing.slice(0, range.begin)}${existing.slice(after)}`;
  return { content, changed: content !== existing };
}

export function buildCursorMcpServerEntry(
  launcherPath: string,
  _extensionRoot?: string
): Record<string, unknown> {
  return {
    command: 'node',
    args: [launcherPath],
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function configPathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isRecognizedLegacyCursorEntry(
  value: unknown,
  extensionRoot?: string
): boolean {
  if (!isPlainRecord(value) || value.command !== 'node') {
    return false;
  }
  if (Object.keys(value).some((key) => key !== 'command' && key !== 'args')) {
    return false;
  }
  const args = value.args;
  if (!Array.isArray(args) || !args.every((item) => typeof item === 'string')) {
    return false;
  }
  if (args.length === 1 && isKnownLauncherPath(args[0])) {
    return true;
  }
  if (
    args.length !== 3 ||
    args[1] !== '--extension-root' ||
    !args[0].replace(/\\/g, '/').endsWith('/dist/mcp.js')
  ) {
    return false;
  }
  const first = path.resolve(args[0]);
  const root = path.resolve(args[2]);
  if (configPathKey(first) === configPathKey(resolveMcpJsPath(root))) {
    const normalizedRoot = root.replace(/\\/g, '/');
    const installed = /\/(?:\.vscode|\.vscode-insiders|\.cursor|\.vscode-server|\.vscode-server-insiders|\.cursor-server)\/extensions\/oscarking888\.ace-code-search-[^/]+$/i.test(
      normalizedRoot
    );
    return (
      installed ||
      (extensionRoot != null &&
        configPathKey(root) === configPathKey(path.resolve(extensionRoot)))
    );
  }
  return false;
}

export function upsertCursorMcpJson(
  existingRaw: string | undefined,
  launcherPath: string,
  extensionRoot?: string
): TextUpdate {
  let parsed: Record<string, unknown> = {};
  if (existingRaw && existingRaw.trim()) {
    try {
      const value = JSON.parse(existingRaw) as unknown;
      if (!isPlainRecord(value)) {
        return {
          content: existingRaw,
          changed: false,
          warning: 'Preserved Cursor MCP config because its root is not a JSON object.',
        };
      }
      parsed = value;
    } catch {
      return {
        content: existingRaw,
        changed: false,
        warning: 'Preserved Cursor MCP config because ~/.cursor/mcp.json is not valid JSON.',
      };
    }
  }

  if (parsed.mcpServers !== undefined && !isPlainRecord(parsed.mcpServers)) {
    return {
      content: existingRaw ?? '',
      changed: false,
      warning: 'Preserved Cursor MCP config because mcpServers is not a JSON object.',
    };
  }
  const servers = { ...((parsed.mcpServers as Record<string, unknown> | undefined) ?? {}) };
  const nextEntry = buildCursorMcpServerEntry(launcherPath);
  const previous = servers[MCP_SERVER_NAME];
  if (previous !== undefined && !sameJson(previous, nextEntry)) {
    if (!isRecognizedLegacyCursorEntry(previous, extensionRoot)) {
      return {
        content: existingRaw ?? '',
        changed: false,
        warning: 'Preserved existing unmanaged ace-code-search entry in Cursor MCP config.',
      };
    }
  }
  if (sameJson(previous, nextEntry)) {
    return { content: existingRaw ?? `${JSON.stringify(parsed, null, 2)}\n`, changed: false };
  }

  servers[MCP_SERVER_NAME] = nextEntry;
  const next = { ...parsed, mcpServers: servers };
  return { content: `${JSON.stringify(next, null, 2)}\n`, changed: true };
}

async function ensureMcpJsExists(mcpJsPath: string): Promise<void> {
  try {
    await fs.promises.access(mcpJsPath, fs.constants.R_OK);
  } catch {
    throw new Error(
      `MCP entrypoint not found: ${mcpJsPath}. Rebuild the extension (npm run build) and reinstall.`
    );
  }
}

async function writeCodexUserConfig(
  configPath: string,
  launcherPath: string,
  extensionRoot: string
): Promise<McpConfigPathResult> {
  const existing = (await readTextIfPresent(configPath)) ?? '';
  const update = upsertCodexMcpBlock(existing, launcherPath, extensionRoot);
  if (update.changed) {
    await atomicWriteFile(configPath, update.content);
  }
  return {
    client: 'codex-user',
    path: configPath,
    changed: update.changed,
    warning: update.warning,
  };
}

async function writeCursorUserConfig(
  configPath: string,
  launcherPath: string,
  extensionRoot: string
): Promise<McpConfigPathResult> {
  const existing = await readTextIfPresent(configPath);
  const update = upsertCursorMcpJson(existing, launcherPath, extensionRoot);
  if (update.changed) {
    await atomicWriteFile(configPath, update.content);
  }
  return {
    client: 'cursor-user',
    path: configPath,
    changed: update.changed,
    warning: update.warning,
  };
}

async function cleanupLegacyProjectCodexConfig(
  workspaceRoot: string
): Promise<McpConfigPathResult | undefined> {
  const configPath = path.join(workspaceRoot, '.codex', 'config.toml');
  try {
    const entry = await fs.promises.lstat(configPath);
    if (
      entry.isSymbolicLink() ||
      (await fs.promises.lstat(path.dirname(configPath))).isSymbolicLink()
    ) {
      return {
        client: 'codex-project-legacy',
        path: configPath,
        changed: false,
        warning:
          'Preserved legacy project Codex config because config.toml or its parent is a symbolic link.',
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const existing = await readTextIfPresent(configPath);
  if (existing === undefined) {
    return undefined;
  }
  const update = removeManagedCodexBlock(existing);
  if (!update.changed && !update.warning) {
    return undefined;
  }
  if (update.changed) {
    if (update.content.trim().length === 0) {
      await fs.promises.unlink(configPath);
      const configDir = path.dirname(configPath);
      if ((await fs.promises.readdir(configDir)).length === 0) {
        await fs.promises.rmdir(configDir);
      }
    } else {
      await atomicWriteFile(configPath, update.content);
    }
  }
  return {
    client: 'codex-project-legacy',
    path: configPath,
    changed: update.changed,
    warning: update.warning,
  };
}

/** Register one stable user-level stdio MCP launcher for Codex and Cursor. */
export async function installMcpClientConfig(
  options: McpConfigInstallOptions
): Promise<McpConfigInstallResult> {
  const extensionRoot = path.resolve(options.extensionRoot);
  const mcpJsPath = resolveMcpJsPath(extensionRoot);
  await ensureMcpJsExists(mcpJsPath);

  const homeDir = options.homeDir ?? os.homedir();
  const launcherPath = resolveMcpLauncherPath(homeDir);
  const markerPath = path.join(path.dirname(launcherPath), LAUNCHER_MARKER);
  const launcher = await installManagedLauncher(
    launcherPath,
    markerPath,
    buildMcpLauncher(extensionRoot),
    readExtensionVersion(extensionRoot)
  );
  const paths: McpConfigPathResult[] = [launcher];

  // Never point configs at an existing launcher that we could not verify.
  if (!launcher.warning) {
    const codex = await writeCodexUserConfig(
      path.join(homeDir, '.codex', 'config.toml'),
      launcherPath,
      extensionRoot
    );
    paths.push(codex);

    paths.push(
      await writeCursorUserConfig(
        path.join(homeDir, '.cursor', 'mcp.json'),
        launcherPath,
        extensionRoot
      )
    );

    // Do not remove a working project fallback when user-level Codex config
    // could not be installed safely.
    if (!codex.warning) {
      const roots = new Map<string, string>();
      for (const root of [
        ...(options.workspaceRoots ?? []),
        ...(options.workspaceRoot ? [options.workspaceRoot] : []),
      ]) {
        roots.set(path.resolve(root), path.resolve(root));
      }
      for (const root of roots.values()) {
        const cleaned = await cleanupLegacyProjectCodexConfig(root);
        if (cleaned) paths.push(cleaned);
      }
    }
  }

  const warnings = paths
    .map((item) => item.warning)
    .filter((item): item is string => Boolean(item));
  return {
    mcpJsPath,
    launcherPath,
    changed: paths.some((item) => item.changed),
    paths,
    warnings,
  };
}
