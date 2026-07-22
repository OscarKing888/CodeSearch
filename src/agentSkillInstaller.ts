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
  kind: 'canonical' | 'wrapper-copy' | 'claude-wrapper';
  version: string;
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
}

export interface AgentSkillPathResult {
  client:
    | 'canonical'
    | 'agents'
    | 'legacy-cursor'
    | 'legacy-vscode'
    | 'legacy-project-cursor'
    | 'legacy-project-claude';
  path: string;
  mode: 'canonical' | 'removed' | 'existing';
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readMarker(markerPath: string): Promise<ManagedMarker | undefined> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(markerPath, 'utf8')) as ManagedMarker;
    return parsed.owner === OWNER &&
      typeof parsed.version === 'string' &&
      typeof parsed.sourceHash === 'string' &&
      ['canonical', 'wrapper-copy', 'claude-wrapper'].includes(parsed.kind)
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function lstatOrUndefined(filePath: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function removeEmptyDirectories(directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    const existing = await lstatOrUndefined(directory);
    if (!existing || !existing.isDirectory() || existing.isSymbolicLink()) continue;
    if ((await fs.promises.readdir(directory)).length === 0) {
      await fs.promises.rmdir(directory);
    }
  }
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  try {
    await fs.promises.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    await fs.promises.rename(temporaryPath, filePath);
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
  }
}

async function writeMarker(markerPath: string, marker: ManagedMarker): Promise<void> {
  await atomicWriteFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
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
  const skillPath = path.join(canonicalPath, 'SKILL.md');
  const actualHash = await readHash(skillPath);

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

  await fs.promises.mkdir(canonicalPath, { recursive: true });
  await atomicWriteFile(skillPath, content);
  await writeMarker(markerPath, {
    owner: OWNER,
    kind: 'canonical',
    version,
    sourceHash,
  });
  return { client, path: canonicalPath, mode: 'canonical', changed: true };
}

async function cleanupLegacyManagedSkill(
  client: 'legacy-project-cursor' | 'legacy-project-claude',
  targetDir: string,
  markerName: string,
  acceptedKinds: ManagedMarker['kind'][]
): Promise<AgentSkillPathResult | undefined> {
  const existing = await lstatOrUndefined(targetDir);
  if (!existing) return undefined;
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
        `Preserved legacy skill at ${targetDir}; its owner marker is missing ` +
        'or its content hash no longer matches.',
    };
  }

  await fs.promises.unlink(skillPath);
  await fs.promises.unlink(markerPath);
  await removeEmptyDirectories([
    targetDir,
    path.dirname(targetDir),
    path.dirname(path.dirname(targetDir)),
  ]);
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
      .filter((warning): warning is string => Boolean(warning)),
  };
}

/** Install one personal canonical Skill under ~/.agents/skills. */
export async function installPersonalAgentSkill(
  options: AgentSkillInstallOptions
): Promise<AgentSkillInstallResult> {
  const content = await fs.promises.readFile(skillSourcePath(options.extensionRoot), 'utf8');
  const sourceHash = hashContent(content);
  const canonicalPath = path.join(
    options.homeDir ?? os.homedir(),
    '.agents',
    'skills',
    AGENT_SKILL_NAME
  );
  const canonical = await installCanonical(
    'canonical',
    canonicalPath,
    content,
    options.version,
    sourceHash
  );
  return makeResult(canonicalPath, [canonical]);
}

/**
 * Install the sole project Skill under .agents/skills, then remove only
 * verifiably managed legacy Cursor and Claude copies.
 */
export async function installProjectAgentSkill(
  options: ProjectAgentSkillInstallOptions
): Promise<AgentSkillInstallResult> {
  const content = await fs.promises.readFile(skillSourcePath(options.extensionRoot), 'utf8');
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
  if (canonical.warning) return makeResult(canonicalPath, [canonical]);

  const [legacyCursor, legacyClaude] = await Promise.all([
    cleanupLegacyManagedSkill(
      'legacy-project-cursor',
      path.join(options.workspaceRoot, '.cursor', 'skills', AGENT_SKILL_NAME),
      CANONICAL_MARKER,
      ['canonical']
    ),
    cleanupLegacyManagedSkill(
      'legacy-project-claude',
      path.join(options.workspaceRoot, '.claude', 'skills', AGENT_SKILL_NAME),
      WRAPPER_MARKER,
      ['claude-wrapper']
    ),
  ]);
  return makeResult(canonicalPath, [canonical, legacyCursor, legacyClaude]);
}
