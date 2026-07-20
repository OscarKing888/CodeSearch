import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const OWNER = 'OscarKing888.ace-code-search';
const INSTRUCTION_FILE = 'ace-code-search.instructions.md';
const CURSOR_RULE_FILE = 'ace-code-search-first.mdc';
const MARKER_FILE = '.ace-code-search-instructions-managed.json';
const CURSOR_RULE_MARKER = '.ace-code-search-rule-managed.json';

interface ManagedInstructionMarker {
  owner: string;
  version: string;
  /** Hash of the managed file when it was last written. */
  sourceHash: string;
  kind?:
    | 'cursor-project-rule'
    | 'vscode-project-instruction-opt-in'
    | 'vscode-personal-instruction';
}

export interface AgentRuleInstallOptions {
  extensionRoot: string;
  version: string;
  homeDir?: string;
}

export interface ProjectAgentRuleInstallOptions {
  extensionRoot: string;
  version: string;
  workspaceRoot: string;
  /** Explicit opt-in. The normal Agent Skill command leaves `.github` alone. */
  includeVscodeInstruction?: boolean;
}

export interface AgentRuleInstallResult {
  path: string;
  changed: boolean;
  mode?: 'installed' | 'removed' | 'existing';
  warning?: string;
}

export interface ProjectAgentRuleInstallResult {
  changed: boolean;
  paths: AgentRuleInstallResult[];
  warnings: string[];
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
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

async function readHash(filePath: string): Promise<string | undefined> {
  try {
    return hashContent(await fs.promises.readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  try {
    await fs.promises.writeFile(temporaryPath, content, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.promises.rename(temporaryPath, filePath);
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
  }
}

async function installManagedTextFile(
  sourcePath: string,
  targetPath: string,
  markerPath: string,
  version: string,
  unmanagedWarning: string,
  kind: ManagedInstructionMarker['kind']
): Promise<AgentRuleInstallResult> {
  const content = await fs.promises.readFile(sourcePath, 'utf8');
  const sourceHash = hashContent(content);
  const targetExists = await pathExists(targetPath);
  const markerExists = await pathExists(markerPath);
  const marker = markerExists ? await readMarker(markerPath) : undefined;
  const actualHash = targetExists ? await readHash(targetPath) : undefined;

  if (markerExists && !marker) {
    return {
      path: targetPath,
      changed: false,
      mode: 'existing',
      warning: `${unmanagedWarning} Its management marker is invalid.`,
    };
  }

  if (targetExists && !marker) {
    if (actualHash !== sourceHash) {
      return {
        path: targetPath,
        changed: false,
        mode: 'existing',
        warning: unmanagedWarning,
      };
    }
    await atomicWriteFile(
      markerPath,
      `${JSON.stringify({ owner: OWNER, version, sourceHash, kind }, null, 2)}\n`
    );
    return { path: targetPath, changed: true, mode: 'installed' };
  }

  if (marker && actualHash !== undefined && actualHash !== marker.sourceHash) {
    return {
      path: targetPath,
      changed: false,
      mode: 'existing',
      warning: `${unmanagedWarning} The managed file was modified after installation, so it was preserved.`,
    };
  }

  if (
    marker?.version === version &&
    marker.sourceHash === sourceHash &&
    marker.kind === kind &&
    actualHash === sourceHash
  ) {
    return { path: targetPath, changed: false, mode: 'installed' };
  }

  await atomicWriteFile(targetPath, content);
  await atomicWriteFile(
    markerPath,
    `${JSON.stringify(
      { owner: OWNER, version, sourceHash, kind } satisfies ManagedInstructionMarker,
      null,
      2
    )}\n`
  );
  return { path: targetPath, changed: true, mode: 'installed' };
}

async function removeLegacyManagedTextFile(
  targetPath: string,
  markerPath: string,
  warningPrefix: string
): Promise<AgentRuleInstallResult | undefined> {
  const targetExists = await pathExists(targetPath);
  const markerExists = await pathExists(markerPath);
  if (!targetExists && !markerExists) {
    return undefined;
  }

  const marker = markerExists ? await readMarker(markerPath) : undefined;
  const actualHash = targetExists ? await readHash(targetPath) : undefined;
  if (marker?.kind === 'vscode-project-instruction-opt-in') {
    return undefined;
  }
  if (!marker || (actualHash !== undefined && actualHash !== marker.sourceHash)) {
    return {
      path: targetPath,
      changed: false,
      mode: 'existing',
      warning: `${warningPrefix}; its owner marker is missing/invalid or its content was modified.`,
    };
  }

  if (targetExists) {
    await fs.promises.unlink(targetPath);
  }
  await fs.promises.unlink(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
  const targetDir = path.dirname(targetPath);
  const remaining = await fs.promises.readdir(targetDir);
  if (remaining.length === 0) {
    await fs.promises.rmdir(targetDir);
  }
  return { path: targetPath, changed: true, mode: 'removed' };
}

function combineResults(paths: Array<AgentRuleInstallResult | undefined>): ProjectAgentRuleInstallResult {
  const present = paths.filter((item): item is AgentRuleInstallResult => Boolean(item));
  return {
    changed: present.some((item) => item.changed),
    paths: present,
    warnings: present
      .map((item) => item.warning)
      .filter((item): item is string => Boolean(item)),
  };
}

function instructionSourcePath(extensionRoot: string): string {
  return path.join(extensionRoot, 'resources', 'rules', INSTRUCTION_FILE);
}

export async function installVscodePersonalInstruction(
  options: AgentRuleInstallOptions
): Promise<AgentRuleInstallResult> {
  const targetDir = path.join(options.homeDir ?? os.homedir(), '.copilot', 'instructions');
  const targetPath = path.join(targetDir, INSTRUCTION_FILE);
  return installManagedTextFile(
    instructionSourcePath(options.extensionRoot),
    targetPath,
    path.join(targetDir, MARKER_FILE),
    options.version,
    `Skipped existing unmanaged VS Code instruction at ${targetPath}. Remove or rename it, then reinstall Ace Code Search guidance.`,
    'vscode-personal-instruction'
  );
}

/** Install only the opt-in VS Code Copilot project instruction. */
export async function installProjectVscodeInstruction(
  options: ProjectAgentRuleInstallOptions
): Promise<AgentRuleInstallResult> {
  const targetDir = path.join(options.workspaceRoot, '.github', 'instructions');
  const targetPath = path.join(targetDir, INSTRUCTION_FILE);
  return installManagedTextFile(
    instructionSourcePath(options.extensionRoot),
    targetPath,
    path.join(targetDir, MARKER_FILE),
    options.version,
    `Skipped existing unmanaged VS Code project instruction at ${targetPath}.`,
    'vscode-project-instruction-opt-in'
  );
}

/**
 * Install the thin Cursor routing rule. By default this also removes only a
 * verifiably managed legacy `.github/instructions` copy; VS Code guidance is
 * now a separate opt-in command.
 */
export async function installProjectAgentRules(
  options: ProjectAgentRuleInstallOptions
): Promise<ProjectAgentRuleInstallResult> {
  const cursorTargetDir = path.join(options.workspaceRoot, '.cursor', 'rules');
  const cursorTargetPath = path.join(cursorTargetDir, CURSOR_RULE_FILE);
  const cursorRule = await installManagedTextFile(
    path.join(options.extensionRoot, 'resources', 'rules', CURSOR_RULE_FILE),
    cursorTargetPath,
    path.join(cursorTargetDir, CURSOR_RULE_MARKER),
    options.version,
    `Skipped existing unmanaged Cursor project rule at ${cursorTargetPath}.`,
    'cursor-project-rule'
  );

  const vscodeInstruction = options.includeVscodeInstruction
    ? await installProjectVscodeInstruction(options)
    : await removeLegacyManagedTextFile(
        path.join(options.workspaceRoot, '.github', 'instructions', INSTRUCTION_FILE),
        path.join(options.workspaceRoot, '.github', 'instructions', MARKER_FILE),
        `Preserved legacy VS Code project instruction at ${path.join(
          options.workspaceRoot,
          '.github',
          'instructions',
          INSTRUCTION_FILE
        )}`
      );

  return combineResults([cursorRule, vscodeInstruction]);
}

export async function readCursorUserRule(extensionRoot: string): Promise<string> {
  return fs.promises.readFile(
    path.join(extensionRoot, 'resources', 'rules', 'cursor-user-rule.txt'),
    'utf8'
  );
}
