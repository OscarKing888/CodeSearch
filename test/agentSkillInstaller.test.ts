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

const ROOT = path.join(__dirname, '..');

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function testPersonalCanonicalOnly(): Promise<void> {
  const homeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'code-search-skill-'));
  try {
    const first = await installPersonalAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      homeDir,
    });
    assert.strictEqual(first.changed, true);
    assert.deepStrictEqual(first.warnings, []);
    assert.deepStrictEqual(first.paths.map((item) => item.client), ['canonical']);
    const canonical = path.join(homeDir, '.agents', 'skills', AGENT_SKILL_NAME);
    assert.ok(
      (await fs.promises.readFile(path.join(canonical, 'SKILL.md'), 'utf8')).includes(
        'name: ace-code-search-mcp'
      )
    );
    assert.strictEqual(fs.existsSync(path.join(homeDir, '.claude')), false);
    assert.strictEqual(fs.existsSync(path.join(homeDir, '.cursor')), false);
    assert.strictEqual(fs.existsSync(path.join(homeDir, '.copilot')), false);

    const second = await installPersonalAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      homeDir,
    });
    assert.strictEqual(second.changed, false);

    await fs.promises.appendFile(path.join(canonical, 'SKILL.md'), '\nuser edit\n');
    const preserved = await installPersonalAgentSkill({
      extensionRoot: ROOT,
      version: '1.1.0',
      homeDir,
    });
    assert.ok(preserved.warnings.some((warning) => warning.includes('user-modified')));
  } finally {
    await fs.promises.rm(homeDir, { recursive: true, force: true });
  }
}

async function testUnmanagedCanonicalIsPreserved(): Promise<void> {
  const workspaceRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-skill-conflict-')
  );
  const canonical = path.join(workspaceRoot, '.agents', 'skills', AGENT_SKILL_NAME);
  try {
    await fs.promises.mkdir(canonical, { recursive: true });
    await fs.promises.writeFile(path.join(canonical, 'SKILL.md'), 'user-owned\n', 'utf8');
    const result = await installProjectAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot,
    });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.warnings.length, 1);
    assert.strictEqual(
      await fs.promises.readFile(path.join(canonical, 'SKILL.md'), 'utf8'),
      'user-owned\n'
    );
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function writeManagedLegacySkill(
  workspaceRoot: string,
  client: 'cursor' | 'claude'
): Promise<string> {
  const content = client === 'cursor' ? 'legacy cursor skill\n' : 'legacy claude wrapper\n';
  const targetDir = path.join(
    workspaceRoot,
    client === 'cursor' ? '.cursor' : '.claude',
    'skills',
    AGENT_SKILL_NAME
  );
  const markerName = client === 'cursor'
    ? '.ace-code-search-managed.json'
    : '.ace-code-search-wrapper.json';
  await fs.promises.mkdir(targetDir, { recursive: true });
  await fs.promises.writeFile(path.join(targetDir, 'SKILL.md'), content);
  await fs.promises.writeFile(
    path.join(targetDir, markerName),
    `${JSON.stringify({
      owner: 'OscarKing888.ace-code-search',
      kind: client === 'cursor' ? 'canonical' : 'claude-wrapper',
      version: '0.8.0',
      sourceHash: sha256(content),
    })}\n`
  );
  return targetDir;
}

async function testProjectInstallAndManagedMigration(): Promise<void> {
  const workspaceRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-project-skill-')
  );
  try {
    const legacyCursor = await writeManagedLegacySkill(workspaceRoot, 'cursor');
    const legacyClaude = await writeManagedLegacySkill(workspaceRoot, 'claude');
    const first = await installProjectAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot,
    });
    assert.strictEqual(first.changed, true);
    assert.deepStrictEqual(first.warnings, []);
    assert.deepStrictEqual(first.paths.map((item) => item.client), [
      'agents',
      'legacy-project-cursor',
      'legacy-project-claude',
    ]);
    assert.strictEqual(fs.existsSync(legacyCursor), false);
    assert.strictEqual(fs.existsSync(legacyClaude), false);
    assert.strictEqual(fs.existsSync(path.join(workspaceRoot, '.cursor')), false);
    assert.strictEqual(fs.existsSync(path.join(workspaceRoot, '.claude')), false);

    const skillPath = path.join(
      workspaceRoot,
      '.agents',
      'skills',
      AGENT_SKILL_NAME,
      'SKILL.md'
    );
    assert.ok((await fs.promises.readFile(skillPath, 'utf8')).includes('name: ace-code-search-mcp'));
    assert.strictEqual(fs.existsSync(path.join(workspaceRoot, '.github')), false);

    const second = await installProjectAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot,
    });
    assert.strictEqual(second.changed, false);
    assert.deepStrictEqual(second.paths.map((item) => item.client), ['agents']);
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testModifiedLegacyIsPreserved(): Promise<void> {
  const workspaceRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-project-skill-preserve-')
  );
  try {
    const legacyClaude = await writeManagedLegacySkill(workspaceRoot, 'claude');
    await fs.promises.appendFile(path.join(legacyClaude, 'SKILL.md'), 'user edit\n');
    const result = await installProjectAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot,
    });
    assert.ok(result.warnings.some((warning) => warning.includes('content hash')));
    assert.strictEqual(fs.existsSync(legacyClaude), true);
    assert.ok(
      (await fs.promises.readFile(path.join(legacyClaude, 'SKILL.md'), 'utf8')).includes(
        'user edit'
      )
    );
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testPackagedTemplateAndMultipleRoots(): Promise<void> {
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
    fs.existsSync(path.join(ROOT, 'resources', 'skills', AGENT_SKILL_NAME, 'CLAUDE_WRAPPER.md')),
    false
  );

  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'code-search-multi-root-'));
  try {
    for (const name of ['one', 'two']) {
      const workspaceRoot = path.join(parent, name);
      await fs.promises.mkdir(workspaceRoot);
      await installProjectAgentSkill({
        extensionRoot: ROOT,
        version: '1.0.0',
        workspaceRoot,
      });
      assert.strictEqual(
        fs.existsSync(
          path.join(workspaceRoot, '.agents', 'skills', AGENT_SKILL_NAME, 'SKILL.md')
        ),
        true
      );
      assert.strictEqual(fs.existsSync(path.join(workspaceRoot, '.cursor')), false);
      assert.strictEqual(fs.existsSync(path.join(workspaceRoot, '.claude')), false);
    }
  } finally {
    await fs.promises.rm(parent, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testPersonalCanonicalOnly();
  await testUnmanagedCanonicalIsPreserved();
  await testProjectInstallAndManagedMigration();
  await testModifiedLegacyIsPreserved();
  await testPackagedTemplateAndMultipleRoots();
  console.log('agentSkillInstaller tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
