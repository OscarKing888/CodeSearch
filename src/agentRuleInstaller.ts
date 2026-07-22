import * as fs from 'fs';
import * as path from 'path';

const OWNER = 'OscarKing888.ace-code-search';
const INSTRUCTION_FILE = 'ace-code-search.instructions.md';
const CURSOR_RULE_FILE = 'ace-code-search-first.mdc';
const INSTRUCTION_MARKER = '.ace-code-search-instructions-managed.json';
const CURSOR_RULE_MARKER = '.ace-code-search-rule-managed.json';

type ManagedRuleKind =
  | 'cursor-project-rule'
  | 'vscode-project-instruction-opt-in'
  | 'vscode-personal-instruction';

interface ManagedInstructionMarker {
  owner: string;
  version: string;
  sourceHash: string;
  kind?: ManagedRuleKind;
}

export interface ProjectAgentRuleCleanupOptions {
  workspaceRoot: string;
}

export interface AgentRuleInstallResult {
  path: string;
  changed: boolean;
  mode: 'removed' | 'existing';
  warning?: string;
}

export interface ProjectAgentRuleInstallResult {
  changed: boolean;
  paths: AgentRuleInstallResult[];
  warnings: string[];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readMarker(
  markerPath: string
): Promise<ManagedInstructionMarker | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.promises.readFile(markerPath, 'utf8')
    ) as ManagedInstructionMarker;
    return parsed.owner === OWNER &&
      typeof parsed.version === 'string' &&
      typeof parsed.sourceHash === 'string' &&
      (parsed.kind === undefined ||
        [
          'cursor-project-rule',
          'vscode-project-instruction-opt-in',
          'vscode-personal-instruction',
        ].includes(parsed.kind))
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

async function hashFile(filePath: string): Promise<string | undefined> {
  try {
    const crypto = await import('crypto');
    return crypto
      .createHash('sha256')
      .update(await fs.promises.readFile(filePath, 'utf8'))
      .digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function removeEmptyDirectories(directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    try {
      const stat = await fs.promises.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if ((await fs.promises.readdir(directory)).length === 0) {
        await fs.promises.rmdir(directory);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function removeManagedProjectFile(
  targetPath: string,
  markerPath: string,
  acceptedKinds: Array<ManagedRuleKind | undefined>,
  label: string
): Promise<AgentRuleInstallResult | undefined> {
  const targetExists = await pathExists(targetPath);
  const markerExists = await pathExists(markerPath);
  if (!targetExists && !markerExists) return undefined;

  const marker = markerExists ? await readMarker(markerPath) : undefined;
  const actualHash = targetExists ? await hashFile(targetPath) : undefined;
  if (
    !marker ||
    !acceptedKinds.includes(marker.kind) ||
    actualHash !== marker.sourceHash
  ) {
    return {
      path: targetPath,
      changed: false,
      mode: 'existing',
      warning:
        `Preserved ${label} at ${targetPath}; its owner marker is missing/invalid ` +
        'or its content was modified.',
    };
  }

  if (targetExists) await fs.promises.unlink(targetPath);
  await fs.promises.unlink(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const targetDirectory = path.dirname(targetPath);
  await removeEmptyDirectories([targetDirectory, path.dirname(targetDirectory)]);
  return { path: targetPath, changed: true, mode: 'removed' };
}

/**
 * Remove only legacy project guidance that can be proven to be owned by this
 * extension and byte-identical to its last managed write.
 */
export async function cleanupLegacyProjectAgentRules(
  options: ProjectAgentRuleCleanupOptions
): Promise<ProjectAgentRuleInstallResult> {
  const cursorDir = path.join(options.workspaceRoot, '.cursor', 'rules');
  const githubDir = path.join(options.workspaceRoot, '.github', 'instructions');
  const paths = (
    await Promise.all([
      removeManagedProjectFile(
        path.join(cursorDir, CURSOR_RULE_FILE),
        path.join(cursorDir, CURSOR_RULE_MARKER),
        ['cursor-project-rule'],
        'legacy Cursor project rule'
      ),
      removeManagedProjectFile(
        path.join(githubDir, INSTRUCTION_FILE),
        path.join(githubDir, INSTRUCTION_MARKER),
        [undefined, 'vscode-project-instruction-opt-in'],
        'legacy VS Code project instruction'
      ),
    ])
  ).filter((item): item is AgentRuleInstallResult => Boolean(item));
  return {
    changed: paths.some((item) => item.changed),
    paths,
    warnings: paths
      .map((item) => item.warning)
      .filter((warning): warning is string => Boolean(warning)),
  };
}

export async function readCursorUserRule(extensionRoot: string): Promise<string> {
  return fs.promises.readFile(
    path.join(extensionRoot, 'resources', 'rules', 'cursor-user-rule.txt'),
    'utf8'
  );
}
