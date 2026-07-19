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
  sourceHash: string;
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
}

export interface AgentRuleInstallResult {
  path: string;
  changed: boolean;
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

async function readMarker(
  markerPath: string
): Promise<ManagedInstructionMarker | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.promises.readFile(markerPath, 'utf8')
    ) as ManagedInstructionMarker;
    return parsed.owner === OWNER ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function installManagedTextFile(
  sourcePath: string,
  targetPath: string,
  markerPath: string,
  version: string,
  unmanagedWarning: string
): Promise<AgentRuleInstallResult> {
  const content = await fs.promises.readFile(sourcePath, 'utf8');
  const sourceHash = hashContent(content);

  let targetExists = false;
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    targetExists = true;
  } catch {
    // New install.
  }

  const marker = await readMarker(markerPath);
  if (targetExists && !marker) {
    return {
      path: targetPath,
      changed: false,
      warning: unmanagedWarning,
    };
  }

  if (
    targetExists &&
    marker?.version === version &&
    marker.sourceHash === sourceHash
  ) {
    return {
      path: targetPath,
      changed: false,
    };
  }

  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.writeFile(targetPath, content, 'utf8');
  await fs.promises.writeFile(
    markerPath,
    `${JSON.stringify(
      {
        owner: OWNER,
        version,
        sourceHash,
      } satisfies ManagedInstructionMarker,
      null,
      2
    )}\n`,
    'utf8'
  );

  return {
    path: targetPath,
    changed: true,
  };
}

export async function installVscodePersonalInstruction(
  options: AgentRuleInstallOptions
): Promise<AgentRuleInstallResult> {
  const sourcePath = path.join(
    options.extensionRoot,
    'resources',
    'rules',
    INSTRUCTION_FILE
  );
  const targetDir = path.join(
    options.homeDir ?? os.homedir(),
    '.copilot',
    'instructions'
  );
  return installManagedTextFile(
    sourcePath,
    path.join(targetDir, INSTRUCTION_FILE),
    path.join(targetDir, MARKER_FILE),
    options.version,
    `Skipped existing unmanaged VS Code instruction at ${path.join(targetDir, INSTRUCTION_FILE)}. ` +
      'Remove or rename it, then reinstall Ace Code Search Agent guidance.'
  );
}

/**
 * Install project-scoped search-preference rules for Cursor and VS Code Copilot.
 *
 * Writes:
 * - `{workspace}/.cursor/rules/ace-code-search-first.mdc`
 * - `{workspace}/.github/instructions/ace-code-search.instructions.md`
 */
export async function installProjectAgentRules(
  options: ProjectAgentRuleInstallOptions
): Promise<ProjectAgentRuleInstallResult> {
  const cursorRule = await installManagedTextFile(
    path.join(
      options.extensionRoot,
      'resources',
      'rules',
      CURSOR_RULE_FILE
    ),
    path.join(
      options.workspaceRoot,
      '.cursor',
      'rules',
      CURSOR_RULE_FILE
    ),
    path.join(
      options.workspaceRoot,
      '.cursor',
      'rules',
      CURSOR_RULE_MARKER
    ),
    options.version,
    `Skipped existing unmanaged Cursor project rule at ${path.join(
      options.workspaceRoot,
      '.cursor',
      'rules',
      CURSOR_RULE_FILE
    )}.`
  );

  const vscodeInstruction = await installManagedTextFile(
    path.join(
      options.extensionRoot,
      'resources',
      'rules',
      INSTRUCTION_FILE
    ),
    path.join(
      options.workspaceRoot,
      '.github',
      'instructions',
      INSTRUCTION_FILE
    ),
    path.join(
      options.workspaceRoot,
      '.github',
      'instructions',
      MARKER_FILE
    ),
    options.version,
    `Skipped existing unmanaged VS Code project instruction at ${path.join(
      options.workspaceRoot,
      '.github',
      'instructions',
      INSTRUCTION_FILE
    )}.`
  );

  const paths = [cursorRule, vscodeInstruction];
  return {
    changed: paths.some((item) => item.changed),
    paths,
    warnings: paths
      .map((item) => item.warning)
      .filter((item): item is string => Boolean(item)),
  };
}

export async function readCursorUserRule(extensionRoot: string): Promise<string> {
  return fs.promises.readFile(
    path.join(
      extensionRoot,
      'resources',
      'rules',
      'cursor-user-rule.txt'
    ),
    'utf8'
  );
}
