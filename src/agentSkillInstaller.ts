import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const AGENT_SKILL_NAME = 'ace-code-search-mcp';
const OWNER = 'OscarKing888.ace-code-search';
const CANONICAL_MARKER = '.ace-code-search-managed.json';
const WRAPPER_MARKER = '.ace-code-search-wrapper.json';

interface ManagedMarker {
  owner: string;
  kind: 'canonical' | 'wrapper-copy';
  version: string;
  sourceHash: string;
  canonicalPath?: string;
}

export interface AgentSkillInstallOptions {
  extensionRoot: string;
  version: string;
  homeDir?: string;
}

export interface ProjectAgentSkillInstallOptions {
  extensionRoot: string;
  version: string;
  workspaceRoot: string;
}

export interface AgentSkillPathResult {
  client: 'canonical' | 'cursor' | 'vscode' | 'agents' | 'project-cursor';
  path: string;
  mode: 'canonical' | 'symlink' | 'copy' | 'existing';
  changed: boolean;
  warning?: string;
}

export interface AgentSkillInstallResult {
  canonicalPath: string;
  changed: boolean;
  paths: AgentSkillPathResult[];
  warnings: string[];
}

function skillSourcePath(extensionRoot: string): string {
  return path.join(
    extensionRoot,
    'resources',
    'skills',
    AGENT_SKILL_NAME,
    'SKILL.md'
  );
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function readMarker(markerPath: string): Promise<ManagedMarker | undefined> {
  try {
    const raw = await fs.promises.readFile(markerPath, 'utf8');
    const parsed = JSON.parse(raw) as ManagedMarker;
    return parsed.owner === OWNER ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function lstatOrUndefined(filePath: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function writeManagedSkill(
  targetDir: string,
  content: string,
  marker: ManagedMarker,
  markerName: string
): Promise<void> {
  await fs.promises.mkdir(targetDir, { recursive: true });
  await fs.promises.writeFile(path.join(targetDir, 'SKILL.md'), content, 'utf8');
  await fs.promises.writeFile(
    path.join(targetDir, markerName),
    `${JSON.stringify(marker, null, 2)}\n`,
    'utf8'
  );
}

async function installCanonical(
  canonicalPath: string,
  content: string,
  version: string,
  sourceHash: string
): Promise<AgentSkillPathResult> {
  const existing = await lstatOrUndefined(canonicalPath);
  const markerPath = path.join(canonicalPath, CANONICAL_MARKER);
  const marker = existing?.isDirectory()
    ? await readMarker(markerPath)
    : undefined;

  if (existing && (!existing.isDirectory() || marker?.kind !== 'canonical')) {
    return {
      client: 'canonical',
      path: canonicalPath,
      mode: 'existing',
      changed: false,
      warning:
        `Skipped existing unmanaged skill at ${canonicalPath}. ` +
        'Remove or rename it, then run "Ace Code Search: Install Project Agent Skill and Search Guidance" again.',
    };
  }

  if (
    marker?.version === version &&
    marker.sourceHash === sourceHash &&
    await lstatOrUndefined(path.join(canonicalPath, 'SKILL.md'))
  ) {
    return {
      client: 'canonical',
      path: canonicalPath,
      mode: 'canonical',
      changed: false,
    };
  }

  await writeManagedSkill(
    canonicalPath,
    content,
    {
      owner: OWNER,
      kind: 'canonical',
      version,
      sourceHash,
    },
    CANONICAL_MARKER
  );

  return {
    client: 'canonical',
    path: canonicalPath,
    mode: 'canonical',
    changed: true,
  };
}

async function writeWrapperCopy(
  client: 'cursor' | 'vscode',
  aliasPath: string,
  canonicalPath: string,
  content: string,
  version: string,
  sourceHash: string
): Promise<AgentSkillPathResult> {
  await writeManagedSkill(
    aliasPath,
    content,
    {
      owner: OWNER,
      kind: 'wrapper-copy',
      version,
      sourceHash,
      canonicalPath,
    },
    WRAPPER_MARKER
  );
  return {
    client,
    path: aliasPath,
    mode: 'copy',
    changed: true,
  };
}

async function installAlias(
  client: 'cursor' | 'vscode',
  aliasPath: string,
  canonicalPath: string,
  content: string,
  version: string,
  sourceHash: string
): Promise<AgentSkillPathResult> {
  const existing = await lstatOrUndefined(aliasPath);

  // Cursor/VS Code docs do not guarantee symlink discovery, so wrappers are
  // managed mirrors of ~/.agents/skills. Preserve a correct existing link, but
  // never create new symlinks for new installs.
  if (existing?.isSymbolicLink()) {
    const linked = await fs.promises.readlink(aliasPath);
    const resolved = path.resolve(path.dirname(aliasPath), linked);
    if (resolved === path.resolve(canonicalPath)) {
      return {
        client,
        path: aliasPath,
        mode: 'symlink',
        changed: false,
      };
    }
    return {
      client,
      path: aliasPath,
      mode: 'existing',
      changed: false,
      warning: `Skipped ${client} alias because ${aliasPath} points elsewhere.`,
    };
  }

  if (existing) {
    const marker = existing.isDirectory()
      ? await readMarker(path.join(aliasPath, WRAPPER_MARKER))
      : undefined;
    if (marker?.kind !== 'wrapper-copy') {
      return {
        client,
        path: aliasPath,
        mode: 'existing',
        changed: false,
        warning: `Skipped existing unmanaged ${client} skill at ${aliasPath}.`,
      };
    }

    if (
      marker.version === version &&
      marker.sourceHash === sourceHash &&
      marker.canonicalPath === canonicalPath
    ) {
      return {
        client,
        path: aliasPath,
        mode: 'copy',
        changed: false,
      };
    }

    return writeWrapperCopy(
      client,
      aliasPath,
      canonicalPath,
      content,
      version,
      sourceHash
    );
  }

  await fs.promises.mkdir(path.dirname(aliasPath), { recursive: true });
  return writeWrapperCopy(
    client,
    aliasPath,
    canonicalPath,
    content,
    version,
    sourceHash
  );
}

export async function installPersonalAgentSkill(
  options: AgentSkillInstallOptions
): Promise<AgentSkillInstallResult> {
  const sourcePath = skillSourcePath(options.extensionRoot);
  const content = await fs.promises.readFile(sourcePath, 'utf8');
  const sourceHash = hashContent(content);
  const homeDir = options.homeDir ?? os.homedir();
  const canonicalPath = path.join(
    homeDir,
    '.agents',
    'skills',
    AGENT_SKILL_NAME
  );
  const cursorPath = path.join(
    homeDir,
    '.cursor',
    'skills',
    AGENT_SKILL_NAME
  );
  const vscodePath = path.join(
    homeDir,
    '.copilot',
    'skills',
    AGENT_SKILL_NAME
  );

  const canonical = await installCanonical(
    canonicalPath,
    content,
    options.version,
    sourceHash
  );
  if (canonical.warning) {
    return {
      canonicalPath,
      changed: false,
      paths: [canonical],
      warnings: [canonical.warning],
    };
  }

  const cursor = await installAlias(
    'cursor',
    cursorPath,
    canonicalPath,
    content,
    options.version,
    sourceHash
  );
  const vscode = await installAlias(
    'vscode',
    vscodePath,
    canonicalPath,
    content,
    options.version,
    sourceHash
  );
  const paths = [canonical, cursor, vscode];
  const warnings = paths
    .map((item) => item.warning)
    .filter((item): item is string => Boolean(item));

  return {
    canonicalPath,
    changed: paths.some((item) => item.changed),
    paths,
    warnings,
  };
}

async function installManagedProjectSkillCopy(
  client: 'agents' | 'project-cursor',
  targetDir: string,
  content: string,
  version: string,
  sourceHash: string
): Promise<AgentSkillPathResult> {
  const existing = await lstatOrUndefined(targetDir);
  const markerPath = path.join(targetDir, CANONICAL_MARKER);

  if (existing?.isSymbolicLink()) {
    return {
      client,
      path: targetDir,
      mode: 'existing',
      changed: false,
      warning: `Skipped existing symlink at ${targetDir}.`,
    };
  }

  if (existing && !existing.isDirectory()) {
    return {
      client,
      path: targetDir,
      mode: 'existing',
      changed: false,
      warning: `Skipped existing non-directory skill path at ${targetDir}.`,
    };
  }

  if (existing?.isDirectory()) {
    const marker = await readMarker(markerPath);
    if (!marker) {
      return {
        client,
        path: targetDir,
        mode: 'existing',
        changed: false,
        warning: `Skipped existing unmanaged project skill at ${targetDir}.`,
      };
    }
    if (marker.version === version && marker.sourceHash === sourceHash) {
      return {
        client,
        path: targetDir,
        mode: 'copy',
        changed: false,
      };
    }
  }

  await writeManagedSkill(
    targetDir,
    content,
    {
      owner: OWNER,
      kind: 'canonical',
      version,
      sourceHash,
    },
    CANONICAL_MARKER
  );
  return {
    client,
    path: targetDir,
    mode: 'copy',
    changed: true,
  };
}

/**
 * Install Ace Code Search MCP Skill into the current project so Codex/Cursor
 * discover it from repo-scoped paths (higher priority than personal skills).
 *
 * Writes:
 * - `{workspace}/.agents/skills/ace-code-search-mcp` (Codex / shared)
 * - `{workspace}/.cursor/skills/ace-code-search-mcp` (Cursor)
 */
export async function installProjectAgentSkill(
  options: ProjectAgentSkillInstallOptions
): Promise<AgentSkillInstallResult> {
  const sourcePath = skillSourcePath(options.extensionRoot);
  const content = await fs.promises.readFile(sourcePath, 'utf8');
  const sourceHash = hashContent(content);
  const agentsPath = path.join(
    options.workspaceRoot,
    '.agents',
    'skills',
    AGENT_SKILL_NAME
  );
  const cursorPath = path.join(
    options.workspaceRoot,
    '.cursor',
    'skills',
    AGENT_SKILL_NAME
  );

  const agents = await installManagedProjectSkillCopy(
    'agents',
    agentsPath,
    content,
    options.version,
    sourceHash
  );
  const cursor = await installManagedProjectSkillCopy(
    'project-cursor',
    cursorPath,
    content,
    options.version,
    sourceHash
  );
  const paths = [agents, cursor];
  const warnings = paths
    .map((item) => item.warning)
    .filter((item): item is string => Boolean(item));

  return {
    canonicalPath: agentsPath,
    changed: paths.some((item) => item.changed),
    paths,
    warnings,
  };
}
