import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const DEFAULT_MCP_CLASS_HIERARCHY_MAX_NODES = 20;
export const MAX_MCP_CLASS_HIERARCHY_MAX_NODES = 5000;
export const MCP_SETTINGS_SCHEMA_VERSION = 1;

const SETTINGS_DIR_NAME = '.ace-code-search';
const SETTINGS_FILE_NAME = 'settings.json';

interface McpSettingsFileV1 {
  schemaVersion: 1;
  classHierarchyDefaultMaxNodes: number;
}

export interface McpSettingsIoOptions {
  homeDir?: string;
  log?: (message: string) => void;
}

export function resolveMcpSettingsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, SETTINGS_DIR_NAME, SETTINGS_FILE_NAME);
}

export function normalizeMcpClassHierarchyDefaultMaxNodes(
  value: unknown
): number {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_MCP_CLASS_HIERARCHY_MAX_NODES
  ) {
    return value;
  }
  return DEFAULT_MCP_CLASS_HIERARCHY_MAX_NODES;
}

export async function readMcpClassHierarchyDefaultMaxNodes(
  options: McpSettingsIoOptions = {}
): Promise<number | 'all'> {
  const filePath = resolveMcpSettingsPath(options.homeDir);
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      options.log?.(
        `Could not read MCP settings; using ${DEFAULT_MCP_CLASS_HIERARCHY_MAX_NODES}: ${formatError(error)}`
      );
    }
    return DEFAULT_MCP_CLASS_HIERARCHY_MAX_NODES;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<McpSettingsFileV1>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== MCP_SETTINGS_SCHEMA_VERSION ||
      normalizeMcpClassHierarchyDefaultMaxNodes(
        parsed.classHierarchyDefaultMaxNodes
      ) !== parsed.classHierarchyDefaultMaxNodes
    ) {
      throw new Error('unsupported or invalid settings schema');
    }
    return parsed.classHierarchyDefaultMaxNodes === 0
      ? 'all'
      : parsed.classHierarchyDefaultMaxNodes;
  } catch (error) {
    options.log?.(
      `Could not parse MCP settings; using ${DEFAULT_MCP_CLASS_HIERARCHY_MAX_NODES}: ${formatError(error)}`
    );
    return DEFAULT_MCP_CLASS_HIERARCHY_MAX_NODES;
  }
}

export async function writeMcpClassHierarchyDefaultMaxNodes(
  value: unknown,
  options: McpSettingsIoOptions = {}
): Promise<void> {
  const normalized = normalizeMcpClassHierarchyDefaultMaxNodes(value);
  const filePath = resolveMcpSettingsPath(options.homeDir);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const content = `${JSON.stringify(
    {
      schemaVersion: MCP_SETTINGS_SCHEMA_VERSION,
      classHierarchyDefaultMaxNodes: normalized,
    } satisfies McpSettingsFileV1,
    null,
    2
  )}\n`;
  await atomicWritePrivateFile(filePath, content);
}

async function atomicWritePrivateFile(
  filePath: string,
  content: string
): Promise<void> {
  let targetPath = filePath;
  let mode = 0o600;
  try {
    const entry = await fs.promises.lstat(filePath);
    if (entry.isSymbolicLink()) {
      targetPath = await fs.promises.realpath(filePath);
    } else if (!entry.isFile()) {
      throw new Error(`Refusing to replace non-file MCP settings path: ${filePath}`);
    }
    const target = await fs.promises.stat(targetPath);
    if (!target.isFile()) {
      throw new Error(`Refusing to replace non-file MCP settings target: ${targetPath}`);
    }
    mode = target.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    const dangling = await fs.promises.lstat(filePath).catch(
      (lstatError: NodeJS.ErrnoException) => {
        if (lstatError.code === 'ENOENT') {
          return undefined;
        }
        throw lstatError;
      }
    );
    if (dangling?.isSymbolicLink()) {
      throw new Error(`Refusing to replace dangling MCP settings symlink: ${filePath}`);
    }
  }

  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(filePath)}.${process.pid}.${crypto
      .randomBytes(6)
      .toString('hex')}.tmp`
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
