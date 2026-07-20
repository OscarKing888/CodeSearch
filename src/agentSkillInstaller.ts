import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const AGENT_SKILL_NAME = 'ace-code-search-mcp';
const OWNER = 'OscarKing888.ace-code-search';
const CANONICAL_MARKER = '.ace-code-search-managed.json';
const WRAPPER_MARKER = '.ace-code-search-wrapper.json';
const CLAUDE_WRAPPER_TEMPLATE = 'CLAUDE_WRAPPER.md';

interface ManagedMarker {
  owner: string;
  kind: 'canonical' | 'wrapper-copy' | 'claude-wrapper';
  version: string;
  /** Hash of the managed file currently stored beside this marker. */
  sourceHash: string;
  canonicalPath?: string;
  canonicalSourceHash?: string;
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
  /** Remove a verified legacy Cursor mirror only after its routing Rule exists. */
  cleanupLegacyCursorSkill?: boolean;
}

export interface AgentSkillPathResult {
  client:
    | 'canonical'
    | 'agents'
    | 'claude'
    | 'project-claude'
    | 'legacy-cursor'
    | 'legacy-vscode'
    | 'legacy-project-cursor';
  path: string;
  mode: 'canonical' | 'wrapper' | 'removed' | 'existing';
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

function claudeWrapperSourcePath(extensionRoot: string): string {
  return path.join(
    extensionRoot,
    'resources',
    'skills',
    AGENT_SKILL_NAME,
    CLAUDE_WRAPPER_TEMPLATE
  );
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

async function readMarker(markerPath: string): Promise<ManagedMarker | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.promises.readFile(markerPath, 'utf8')
    ) as ManagedMarker;
    if (
      parsed.owner !== OWNER ||
      typeof parsed.sourceHash !== 'string' ||
      !['canonical', 'wrapper-copy', 'claude-wrapper'].includes(parsed.kind)
    ) {
      return undefined;
    }
    return parsed;
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

async function writeMarker(markerPath: string, marker: ManagedMarker): Promise<void> {
  await atomicWriteFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
}

async function writeManagedFile(
  targetDir: string,
  content: string,
  markerName: string,
  marker: ManagedMarker
): Promise<void> {
  await fs.promises.mkdir(targetDir, { recursive: true });
  await atomicWriteFile(path.join(targetDir, 'SKILL.md'), content);
  await writeMarker(path.join(targetDir, markerName), marker);
}

async function installCanonical(
  client: 'canonical' | 'agents',
  canonicalPath: string,
  content: string,
  version: string,
  sourceHash: string
): Promise<AgentSkillPathResult> {
  const existing = await lstatOrUndefined(canonicalPath);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    return {
      client,
      path: canonicalPath,
      mode: 'existing',
      changed: false,
      warning: `Skipped existing unmanaged canonical skill at ${canonicalPath}.`,
    };
  }

  const markerPath = path.join(canonicalPath, CANONICAL_MARKER);
  const markerExists = await pathExists(markerPath);
  const marker = markerExists ? await readMarker(markerPath) : undefined;
  const actualHash = await readHash(path.join(canonicalPath, 'SKILL.md'));

  if (markerExists && !marker) {
    return {
      client,
      path: canonicalPath,
      mode: 'existing',
      changed: false,
      warning: `Preserved canonical skill with an invalid managed marker at ${canonicalPath}.`,
    };
  }

  if (existing && !marker) {
    // A checked-in canonical Skill can be safely adopted when its bytes match
    // the packaged source. Anything else remains user-owned.
    if (actualHash !== sourceHash) {
      return {
        client,
        path: canonicalPath,
        mode: 'existing',
        changed: false,
        warning: `Skipped existing unmanaged canonical skill at ${canonicalPath}.`,
      };
    }
    await writeMarker(markerPath, {
      owner: OWNER,
      kind: 'canonical',
      version,
      sourceHash,
    });
    return { client, path: canonicalPath, mode: 'canonical', changed: true };
  }

  if (marker && marker.kind !== 'canonical') {
    return {
      client,
      path: canonicalPath,
      mode: 'existing',
      changed: false,
      warning: `Skipped canonical skill with an unexpected managed marker at ${canonicalPath}.`,
    };
  }

  if (marker && actualHash !== undefined && actualHash !== marker.sourceHash) {
    return {
      client,
      path: canonicalPath,
      mode: 'existing',
      changed: false,
      warning: `Preserved user-modified canonical skill at ${canonicalPath}.`,
    };
  }

  if (
    marker?.version === version &&
    marker.sourceHash === sourceHash &&
    actualHash === sourceHash
  ) {
    return { client, path: canonicalPath, mode: 'canonical', changed: false };
  }

  await writeManagedFile(canonicalPath, content, CANONICAL_MARKER, {
    owner: OWNER,
    kind: 'canonical',
    version,
    sourceHash,
  });
  return { client, path: canonicalPath, mode: 'canonical', changed: true };
}

function renderClaudeWrapper(template: string, wrapperDir: string, canonicalPath: string): string {
  const canonicalSkill = path.join(canonicalPath, 'SKILL.md');
  const relativePath = path
    .relative(wrapperDir, canonicalSkill)
    .replace(/\\/g, '/');
  return template.replace(/\{\{CANONICAL_SKILL_PATH\}\}/g, relativePath);
}

async function installClaudeWrapper(
  client: 'claude' | 'project-claude',
  wrapperPath: string,
  canonicalPath: string,
  template: string,
  version: string,
  canonicalSourceHash: string
): Promise<AgentSkillPathResult> {
  const content = renderClaudeWrapper(template, wrapperPath, canonicalPath);
  const sourceHash = hashContent(content);
  const existing = await lstatOrUndefined(wrapperPath);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    return {
      client,
      path: wrapperPath,
      mode: 'existing',
      changed: false,
      warning: `Skipped existing unmanaged Claude skill wrapper at ${wrapperPath}.`,
    };
  }

  const markerPath = path.join(wrapperPath, WRAPPER_MARKER);
  const markerExists = await pathExists(markerPath);
  const marker = markerExists ? await readMarker(markerPath) : undefined;
  const actualHash = await readHash(path.join(wrapperPath, 'SKILL.md'));

  if (markerExists && !marker) {
    return {
      client,
      path: wrapperPath,
      mode: 'existing',
      changed: false,
      warning: `Preserved Claude wrapper with an invalid managed marker at ${wrapperPath}.`,
    };
  }

  if (existing && !marker) {
    if (actualHash !== sourceHash) {
      return {
        client,
        path: wrapperPath,
        mode: 'existing',
        changed: false,
        warning: `Skipped existing unmanaged Claude skill wrapper at ${wrapperPath}.`,
      };
    }
    await writeMarker(markerPath, {
      owner: OWNER,
      kind: 'claude-wrapper',
      version,
      sourceHash,
      canonicalPath,
      canonicalSourceHash,
    });
    return { client, path: wrapperPath, mode: 'wrapper', changed: true };
  }

  if (marker && marker.kind !== 'claude-wrapper') {
    return {
      client,
      path: wrapperPath,
      mode: 'existing',
      changed: false,
      warning: `Skipped Claude wrapper with an unexpected managed marker at ${wrapperPath}.`,
    };
  }

  if (marker && actualHash !== undefined && actualHash !== marker.sourceHash) {
    return {
      client,
      path: wrapperPath,
      mode: 'existing',
      changed: false,
      warning: `Preserved user-modified Claude skill wrapper at ${wrapperPath}.`,
    };
  }

  if (
    marker?.version === version &&
    marker.sourceHash === sourceHash &&
    marker.canonicalPath === canonicalPath &&
    marker.canonicalSourceHash === canonicalSourceHash &&
    actualHash === sourceHash
  ) {
    return { client, path: wrapperPath, mode: 'wrapper', changed: false };
  }

  await writeManagedFile(wrapperPath, content, WRAPPER_MARKER, {
    owner: OWNER,
    kind: 'claude-wrapper',
    version,
    sourceHash,
    canonicalPath,
    canonicalSourceHash,
  });
  return { client, path: wrapperPath, mode: 'wrapper', changed: true };
}

async function cleanupLegacyManagedSkill(
  client: 'legacy-cursor' | 'legacy-vscode' | 'legacy-project-cursor',
  targetDir: string,
  markerName: string,
  acceptedKinds: ManagedMarker['kind'][]
): Promise<AgentSkillPathResult | undefined> {
  const existing = await lstatOrUndefined(targetDir);
  if (!existing) {
    return undefined;
  }
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    return {
      client,
      path: targetDir,
      mode: 'existing',
      changed: false,
      warning: `Preserved unmanaged legacy skill path at ${targetDir}.`,
    };
  }

  const markerPath = path.join(targetDir, markerName);
  const marker = await readMarker(markerPath);
  const skillPath = path.join(targetDir, 'SKILL.md');
  const actualHash = await readHash(skillPath);
  if (!marker || !acceptedKinds.includes(marker.kind) || actualHash !== marker.sourceHash) {
    return {
      client,
      path: targetDir,
      mode: 'existing',
      changed: false,
      warning:
        `Preserved legacy skill at ${targetDir}; its owner marker is missing or its content hash no longer matches.`,
    };
  }

  await fs.promises.unlink(skillPath);
  await fs.promises.unlink(markerPath);
  const remaining = await fs.promises.readdir(targetDir);
  if (remaining.length === 0) {
    await fs.promises.rmdir(targetDir);
  }
  return { client, path: targetDir, mode: 'removed', changed: true };
}

function makeResult(
  canonicalPath: string,
  paths: Array<AgentSkillPathResult | undefined>
): AgentSkillInstallResult {
  const present = paths.filter((item): item is AgentSkillPathResult => Boolean(item));
  return {
    canonicalPath,
    changed: present.some((item) => item.changed),
    paths: present,
    warnings: present
      .map((item) => item.warning)
      .filter((item): item is string => Boolean(item)),
  };
}

/**
 * Install one personal canonical Skill plus a thin Claude compatibility
 * wrapper. Legacy client-specific copies are retained because this helper
 * cannot prove that each client already discovers the canonical location.
 */
export async function installPersonalAgentSkill(
  options: AgentSkillInstallOptions
): Promise<AgentSkillInstallResult> {
  const content = await fs.promises.readFile(skillSourcePath(options.extensionRoot), 'utf8');
  const wrapperTemplate = await fs.promises.readFile(
    claudeWrapperSourcePath(options.extensionRoot),
    'utf8'
  );
  const sourceHash = hashContent(content);
  const homeDir = options.homeDir ?? os.homedir();
  const canonicalPath = path.join(homeDir, '.agents', 'skills', AGENT_SKILL_NAME);
  const canonical = await installCanonical(
    'canonical',
    canonicalPath,
    content,
    options.version,
    sourceHash
  );
  if (canonical.warning) {
    return makeResult(canonicalPath, [canonical]);
  }

  const claude = await installClaudeWrapper(
    'claude',
    path.join(homeDir, '.claude', 'skills', AGENT_SKILL_NAME),
    canonicalPath,
    wrapperTemplate,
    options.version,
    sourceHash
  );
  return makeResult(canonicalPath, [canonical, claude]);
}

/**
 * Install one project canonical Skill under `.agents/skills` and a thin Claude
 * wrapper. Cursor is routed to the canonical Skill by the project rule; no
 * full `.cursor/skills` mirror is created.
 */
export async function installProjectAgentSkill(
  options: ProjectAgentSkillInstallOptions
): Promise<AgentSkillInstallResult> {
  const content = await fs.promises.readFile(skillSourcePath(options.extensionRoot), 'utf8');
  const wrapperTemplate = await fs.promises.readFile(
    claudeWrapperSourcePath(options.extensionRoot),
    'utf8'
  );
  const sourceHash = hashContent(content);
  const canonicalPath = path.join(
    options.workspaceRoot,
    '.agents',
    'skills',
    AGENT_SKILL_NAME
  );
  const canonical = await installCanonical(
    'agents',
    canonicalPath,
    content,
    options.version,
    sourceHash
  );
  if (canonical.warning) {
    return makeResult(canonicalPath, [canonical]);
  }

  const claude = await installClaudeWrapper(
    'project-claude',
    path.join(options.workspaceRoot, '.claude', 'skills', AGENT_SKILL_NAME),
    canonicalPath,
    wrapperTemplate,
    options.version,
    sourceHash
  );
  const legacyCursor = options.cleanupLegacyCursorSkill
    ? await cleanupLegacyManagedSkill(
        'legacy-project-cursor',
        path.join(options.workspaceRoot, '.cursor', 'skills', AGENT_SKILL_NAME),
        CANONICAL_MARKER,
        ['canonical']
      )
    : undefined;
  return makeResult(canonicalPath, [canonical, claude, legacyCursor]);
}
