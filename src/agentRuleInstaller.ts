import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const OWNER = 'OscarKing888.ace-code-search';
const INSTRUCTION_FILE = 'ace-code-search.instructions.md';
const MARKER_FILE = '.ace-code-search-instructions-managed.json';

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

export interface AgentRuleInstallResult {
  path: string;
  changed: boolean;
  warning?: string;
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

export async function installVscodePersonalInstruction(
  options: AgentRuleInstallOptions
): Promise<AgentRuleInstallResult> {
  const sourcePath = path.join(
    options.extensionRoot,
    'resources',
    'rules',
    INSTRUCTION_FILE
  );
  const content = await fs.promises.readFile(sourcePath, 'utf8');
  const sourceHash = hashContent(content);
  const targetDir = path.join(
    options.homeDir ?? os.homedir(),
    '.copilot',
    'instructions'
  );
  const targetPath = path.join(targetDir, INSTRUCTION_FILE);
  const markerPath = path.join(targetDir, MARKER_FILE);

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
      warning:
        `Skipped existing unmanaged VS Code instruction at ${targetPath}. ` +
        'Remove or rename it, then reinstall the Ace Code Search Agent Skill.',
    };
  }

  if (
    targetExists &&
    marker?.version === options.version &&
    marker.sourceHash === sourceHash
  ) {
    return {
      path: targetPath,
      changed: false,
    };
  }

  await fs.promises.mkdir(targetDir, { recursive: true });
  await fs.promises.writeFile(targetPath, content, 'utf8');
  await fs.promises.writeFile(
    markerPath,
    `${JSON.stringify(
      {
        owner: OWNER,
        version: options.version,
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
