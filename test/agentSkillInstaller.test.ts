import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AGENT_SKILL_NAME,
  installPersonalAgentSkill,
  installProjectAgentSkill,
} from '../src/agentSkillInstaller';
import { installProjectAgentRules } from '../src/agentRuleInstaller';

const ROOT = path.join(__dirname, '..');

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function testPersonalCanonicalAndClaudeWrapper(): Promise<void> {
  const homeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'code-search-skill-'));
  try {
    const first = await installPersonalAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      homeDir,
    });
    assert.strictEqual(first.changed, true);
    assert.deepStrictEqual(first.warnings, []);
    assert.deepStrictEqual(first.paths.map((item) => item.client), ['canonical', 'claude']);

    const canonical = path.join(homeDir, '.agents', 'skills', AGENT_SKILL_NAME);
    const canonicalContent = await fs.promises.readFile(
      path.join(canonical, 'SKILL.md'),
      'utf8'
    );
    assert.ok(canonicalContent.includes('name: ace-code-search-mcp'));
    const wrapperPath = path.join(
      homeDir,
      '.claude',
      'skills',
      AGENT_SKILL_NAME,
      'SKILL.md'
    );
    const wrapper = await fs.promises.readFile(wrapperPath, 'utf8');
    assert.ok(wrapper.includes('../../../.agents/skills/ace-code-search-mcp/SKILL.md'));
    assert.ok(!wrapper.includes('## `search_code` matching parameters'));
    assert.strictEqual(
      fs.existsSync(path.join(homeDir, '.cursor', 'skills', AGENT_SKILL_NAME)),
      false
    );
    assert.strictEqual(
      fs.existsSync(path.join(homeDir, '.copilot', 'skills', AGENT_SKILL_NAME)),
      false
    );

    const second = await installPersonalAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      homeDir,
    });
    assert.strictEqual(second.changed, false);

    const upgraded = await installPersonalAgentSkill({
      extensionRoot: ROOT,
      version: '1.1.0',
      homeDir,
    });
    assert.strictEqual(upgraded.changed, true);
    assert.deepStrictEqual(upgraded.warnings, []);

    await fs.promises.appendFile(path.join(canonical, 'SKILL.md'), '\nuser edit\n');
    const preserved = await installPersonalAgentSkill({
      extensionRoot: ROOT,
      version: '1.2.0',
      homeDir,
    });
    assert.ok(preserved.warnings.some((warning) => warning.includes('user-modified')));
    assert.ok(
      (await fs.promises.readFile(path.join(canonical, 'SKILL.md'), 'utf8')).includes(
        'user edit'
      )
    );
  } finally {
    await fs.promises.rm(homeDir, { recursive: true, force: true });
  }
}

async function testUnmanagedCanonicalIsPreserved(): Promise<void> {
  const homeDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-skill-conflict-')
  );
  const canonical = path.join(homeDir, '.agents', 'skills', AGENT_SKILL_NAME);
  try {
    await fs.promises.mkdir(canonical, { recursive: true });
    await fs.promises.writeFile(path.join(canonical, 'SKILL.md'), 'user-owned\n', 'utf8');
    const result = await installPersonalAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      homeDir,
    });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.warnings.length, 1);
    assert.strictEqual(
      await fs.promises.readFile(path.join(canonical, 'SKILL.md'), 'utf8'),
      'user-owned\n'
    );
    assert.strictEqual(fs.existsSync(path.join(homeDir, '.claude', 'skills')), false);
  } finally {
    await fs.promises.rm(homeDir, { recursive: true, force: true });
  }
}

async function testPersonalLegacyCursorIsRetained(): Promise<void> {
  const homeDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-skill-legacy-')
  );
  const legacyDir = path.join(homeDir, '.cursor', 'skills', AGENT_SKILL_NAME);
  try {
    await fs.promises.mkdir(legacyDir, { recursive: true });
    await fs.promises.writeFile(path.join(legacyDir, 'SKILL.md'), 'user-owned\n');
    const preserved = await installPersonalAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      homeDir,
    });
    assert.deepStrictEqual(preserved.warnings, []);
    assert.strictEqual(
      await fs.promises.readFile(path.join(legacyDir, 'SKILL.md'), 'utf8'),
      'user-owned\n'
    );

    await fs.promises.rm(legacyDir, { recursive: true, force: true });
    const source = await fs.promises.readFile(
      path.join(ROOT, 'resources', 'skills', AGENT_SKILL_NAME, 'SKILL.md'),
      'utf8'
    );
    await fs.promises.mkdir(legacyDir, { recursive: true });
    await fs.promises.writeFile(path.join(legacyDir, 'SKILL.md'), source);
    await fs.promises.writeFile(
      path.join(legacyDir, '.ace-code-search-wrapper.json'),
      `${JSON.stringify({
        owner: 'OscarKing888.ace-code-search',
        kind: 'wrapper-copy',
        version: '0.7.0',
        sourceHash: sha256(source),
      })}\n`
    );
    const retained = await installPersonalAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      homeDir,
    });
    assert.ok(!retained.paths.some((item) => item.client === 'legacy-cursor'));
    assert.strictEqual(fs.existsSync(legacyDir), true);
  } finally {
    await fs.promises.rm(homeDir, { recursive: true, force: true });
  }
}

async function writeLegacyProjectCursorSkill(workspaceRoot: string): Promise<string> {
  const source = await fs.promises.readFile(
    path.join(ROOT, 'resources', 'skills', AGENT_SKILL_NAME, 'SKILL.md'),
    'utf8'
  );
  const legacyDir = path.join(workspaceRoot, '.cursor', 'skills', AGENT_SKILL_NAME);
  await fs.promises.mkdir(legacyDir, { recursive: true });
  await fs.promises.writeFile(path.join(legacyDir, 'SKILL.md'), source);
  await fs.promises.writeFile(
    path.join(legacyDir, '.ace-code-search-managed.json'),
    JSON.stringify({
      owner: 'OscarKing888.ace-code-search',
      kind: 'canonical',
      version: '0.7.0',
      sourceHash: sha256(source),
    }) + '\n'
  );
  return legacyDir;
}

async function testProjectLegacyCleanupRequiresCursorRule(): Promise<void> {
  const successfulRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-project-skill-migrate-')
  );
  const conflictRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-project-skill-conflict-')
  );
  try {
    const successfulLegacy = await writeLegacyProjectCursorSkill(successfulRoot);
    const installedRules = await installProjectAgentRules({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot: successfulRoot,
    });
    assert.strictEqual(installedRules.paths[0].mode, 'installed');
    await installProjectAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot: successfulRoot,
      cleanupLegacyCursorSkill: true,
    });
    assert.strictEqual(fs.existsSync(successfulLegacy), false);

    const conflictingLegacy = await writeLegacyProjectCursorSkill(conflictRoot);
    const customRule = path.join(
      conflictRoot,
      '.cursor',
      'rules',
      'ace-code-search-first.mdc'
    );
    await fs.promises.mkdir(path.dirname(customRule), { recursive: true });
    await fs.promises.writeFile(customRule, 'user-owned Cursor rule\n');
    const conflictingRules = await installProjectAgentRules({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot: conflictRoot,
    });
    const cursorRule = conflictingRules.paths[0];
    const cleanupAllowed =
      cursorRule.mode === 'installed' && cursorRule.warning === undefined;
    assert.strictEqual(cursorRule.mode, 'existing');
    assert.ok(cursorRule.warning);
    await installProjectAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot: conflictRoot,
      cleanupLegacyCursorSkill: cleanupAllowed,
    });
    assert.strictEqual(fs.existsSync(conflictingLegacy), true);
  } finally {
    await fs.promises.rm(successfulRoot, { recursive: true, force: true });
    await fs.promises.rm(conflictRoot, { recursive: true, force: true });
  }
}

async function testPackagedTemplateMatchesCanonicalProjectSkill(): Promise<void> {
  const canonical = await fs.promises.readFile(
    path.join(ROOT, '.agents', 'skills', AGENT_SKILL_NAME, 'SKILL.md'),
    'utf8'
  );
  const packaged = await fs.promises.readFile(
    path.join(ROOT, 'resources', 'skills', AGENT_SKILL_NAME, 'SKILL.md'),
    'utf8'
  );
  assert.strictEqual(packaged, canonical);
  assert.strictEqual(
    fs.existsSync(path.join(ROOT, '.cursor', 'skills', AGENT_SKILL_NAME, 'SKILL.md')),
    false
  );
}

async function testProjectInstall(): Promise<void> {
  const workspaceRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-project-skill-')
  );
  try {
    const first = await installProjectAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot,
    });
    assert.strictEqual(first.changed, true);
    assert.deepStrictEqual(first.warnings, []);
    assert.deepStrictEqual(first.paths.map((item) => item.client), ['agents', 'project-claude']);

    const agents = path.join(
      workspaceRoot,
      '.agents',
      'skills',
      AGENT_SKILL_NAME,
      'SKILL.md'
    );
    const claude = path.join(
      workspaceRoot,
      '.claude',
      'skills',
      AGENT_SKILL_NAME,
      'SKILL.md'
    );
    assert.ok((await fs.promises.readFile(agents, 'utf8')).includes('name: ace-code-search-mcp'));
    assert.ok((await fs.promises.readFile(claude, 'utf8')).includes('../../../.agents/skills'));
    assert.strictEqual(
      fs.existsSync(path.join(workspaceRoot, '.cursor', 'skills', AGENT_SKILL_NAME)),
      false
    );

    const second = await installProjectAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot,
    });
    assert.strictEqual(second.changed, false);
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testPersonalCanonicalAndClaudeWrapper();
  await testUnmanagedCanonicalIsPreserved();
  await testPersonalLegacyCursorIsRetained();
  await testProjectLegacyCleanupRequiresCursorRule();
  await testPackagedTemplateMatchesCanonicalProjectSkill();
  await testProjectInstall();
  console.log('agentSkillInstaller tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
