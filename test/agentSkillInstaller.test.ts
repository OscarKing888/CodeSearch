import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AGENT_SKILL_NAME,
  installPersonalAgentSkill,
  installProjectAgentSkill,
} from '../src/agentSkillInstaller';

const ROOT = path.join(__dirname, '..');

async function testInstallAndUpdate(): Promise<void> {
  const homeDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-skill-')
  );
  try {
    const first = await installPersonalAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      homeDir,
    });
    assert.strictEqual(first.changed, true);
    assert.strictEqual(first.warnings.length, 0);
    assert.strictEqual(first.paths.length, 3);

    const canonical = path.join(
      homeDir,
      '.agents',
      'skills',
      AGENT_SKILL_NAME
    );
    const cursor = path.join(
      homeDir,
      '.cursor',
      'skills',
      AGENT_SKILL_NAME
    );
    const vscode = path.join(
      homeDir,
      '.copilot',
      'skills',
      AGENT_SKILL_NAME
    );
    const canonicalContent = await fs.promises.readFile(
      path.join(canonical, 'SKILL.md'),
      'utf8'
    );
    assert.ok(canonicalContent.includes('name: ace-code-search-mcp'));

    for (const alias of [cursor, vscode]) {
      const aliasContent = await fs.promises.readFile(
        path.join(alias, 'SKILL.md'),
        'utf8'
      );
      assert.strictEqual(aliasContent, canonicalContent);
      const stat = await fs.promises.lstat(alias);
      assert.ok(stat.isSymbolicLink() || stat.isDirectory());
    }

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
    assert.strictEqual(upgraded.warnings.length, 0);
  } finally {
    await fs.promises.rm(homeDir, { recursive: true, force: true });
  }
}

async function testUnmanagedCanonicalIsPreserved(): Promise<void> {
  const homeDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-skill-conflict-')
  );
  const canonical = path.join(
    homeDir,
    '.agents',
    'skills',
    AGENT_SKILL_NAME
  );
  try {
    await fs.promises.mkdir(canonical, { recursive: true });
    await fs.promises.writeFile(
      path.join(canonical, 'SKILL.md'),
      'user-owned\n',
      'utf8'
    );

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
    assert.strictEqual(
      fs.existsSync(
        path.join(homeDir, '.cursor', 'skills', AGENT_SKILL_NAME)
      ),
      false
    );
  } finally {
    await fs.promises.rm(homeDir, { recursive: true, force: true });
  }
}

async function testUnmanagedAliasIsPreserved(): Promise<void> {
  const homeDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-skill-alias-')
  );
  const cursor = path.join(
    homeDir,
    '.cursor',
    'skills',
    AGENT_SKILL_NAME
  );
  try {
    await fs.promises.mkdir(cursor, { recursive: true });
    await fs.promises.writeFile(
      path.join(cursor, 'SKILL.md'),
      'cursor-user-owned\n',
      'utf8'
    );

    const result = await installPersonalAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      homeDir,
    });
    assert.strictEqual(result.changed, true);
    assert.ok(result.warnings.some((warning) => warning.includes('cursor')));
    assert.strictEqual(
      await fs.promises.readFile(path.join(cursor, 'SKILL.md'), 'utf8'),
      'cursor-user-owned\n'
    );
    assert.strictEqual(
      fs.existsSync(
        path.join(homeDir, '.copilot', 'skills', AGENT_SKILL_NAME, 'SKILL.md')
      ),
      true
    );
  } finally {
    await fs.promises.rm(homeDir, { recursive: true, force: true });
  }
}

async function testPackagedTemplateMatchesProjectSkill(): Promise<void> {
  const project = await fs.promises.readFile(
    path.join(ROOT, '.cursor', 'skills', AGENT_SKILL_NAME, 'SKILL.md'),
    'utf8'
  );
  const packaged = await fs.promises.readFile(
    path.join(
      ROOT,
      'resources',
      'skills',
      AGENT_SKILL_NAME,
      'SKILL.md'
    ),
    'utf8'
  );
  assert.strictEqual(packaged, project);
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
    assert.strictEqual(first.warnings.length, 0);
    assert.strictEqual(first.paths.length, 2);

    const agents = path.join(
      workspaceRoot,
      '.agents',
      'skills',
      AGENT_SKILL_NAME,
      'SKILL.md'
    );
    const cursor = path.join(
      workspaceRoot,
      '.cursor',
      'skills',
      AGENT_SKILL_NAME,
      'SKILL.md'
    );
    const content = await fs.promises.readFile(agents, 'utf8');
    assert.ok(content.includes('name: ace-code-search-mcp'));
    assert.strictEqual(await fs.promises.readFile(cursor, 'utf8'), content);

    const second = await installProjectAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot,
    });
    assert.strictEqual(second.changed, false);

    await fs.promises.writeFile(agents, 'user-owned\n', 'utf8');
    await fs.promises.rm(
      path.join(
        workspaceRoot,
        '.agents',
        'skills',
        AGENT_SKILL_NAME,
        '.ace-code-search-managed.json'
      )
    );
    const conflict = await installProjectAgentSkill({
      extensionRoot: ROOT,
      version: '1.0.1',
      workspaceRoot,
    });
    assert.ok(conflict.warnings.some((w) => w.includes('unmanaged')));
    assert.strictEqual(await fs.promises.readFile(agents, 'utf8'), 'user-owned\n');
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testInstallAndUpdate();
  await testUnmanagedCanonicalIsPreserved();
  await testUnmanagedAliasIsPreserved();
  await testPackagedTemplateMatchesProjectSkill();
  await testProjectInstall();
  console.log('agentSkillInstaller tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
