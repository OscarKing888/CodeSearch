import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  installProjectAgentRules,
  installProjectVscodeInstruction,
  installVscodePersonalInstruction,
  readCursorUserRule,
} from '../src/agentRuleInstaller';

const ROOT = path.join(__dirname, '..');

async function testOptionalPersonalInstructionSafety(): Promise<void> {
  const homeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'code-search-rule-'));
  try {
    const first = await installVscodePersonalInstruction({
      extensionRoot: ROOT,
      version: '1.0.0',
      homeDir,
    });
    assert.strictEqual(first.changed, true);
    assert.strictEqual(first.warning, undefined);
    assert.ok((await fs.promises.readFile(first.path, 'utf8')).includes('applyTo: "**"'));

    const second = await installVscodePersonalInstruction({
      extensionRoot: ROOT,
      version: '1.0.0',
      homeDir,
    });
    assert.strictEqual(second.changed, false);

    await fs.promises.appendFile(first.path, '\nuser edit\n');
    const preserved = await installVscodePersonalInstruction({
      extensionRoot: ROOT,
      version: '1.1.0',
      homeDir,
    });
    assert.strictEqual(preserved.changed, false);
    assert.match(preserved.warning ?? '', /modified/);
    assert.ok((await fs.promises.readFile(first.path, 'utf8')).includes('user edit'));
  } finally {
    await fs.promises.rm(homeDir, { recursive: true, force: true });
  }
}

async function testUnmanagedInstructionIsPreserved(): Promise<void> {
  const homeDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-rule-conflict-')
  );
  const target = path.join(
    homeDir,
    '.copilot',
    'instructions',
    'ace-code-search.instructions.md'
  );
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, 'user-owned\n', 'utf8');
    const result = await installVscodePersonalInstruction({
      extensionRoot: ROOT,
      version: '1.0.0',
      homeDir,
    });
    assert.strictEqual(result.changed, false);
    assert.match(result.warning ?? '', /unmanaged/);
    assert.strictEqual(await fs.promises.readFile(target, 'utf8'), 'user-owned\n');
  } finally {
    await fs.promises.rm(homeDir, { recursive: true, force: true });
  }
}

async function testRuleTemplates(): Promise<void> {
  const cursorUserRule = await readCursorUserRule(ROOT);
  assert.ok(cursorUserRule.includes('.agents/skills/ace-code-search-mcp/SKILL.md'));
  assert.ok(cursorUserRule.includes('Fall back to `rg`'));

  const projectRule = await fs.promises.readFile(
    path.join(ROOT, '.cursor', 'rules', 'ace-code-search-first.mdc'),
    'utf8'
  );
  assert.ok(projectRule.includes('alwaysApply: true'));
  assert.ok(projectRule.includes('.agents/skills/ace-code-search-mcp/SKILL.md'));
  const packagedRule = await fs.promises.readFile(
    path.join(ROOT, 'resources', 'rules', 'ace-code-search-first.mdc'),
    'utf8'
  );
  assert.strictEqual(packagedRule, projectRule);
}

async function testProjectRuleAndOptInInstruction(): Promise<void> {
  const workspaceRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-project-rule-')
  );
  try {
    const first = await installProjectAgentRules({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot,
    });
    assert.strictEqual(first.changed, true);
    assert.deepStrictEqual(first.warnings, []);
    assert.strictEqual(first.paths.length, 1);
    const cursorRule = path.join(
      workspaceRoot,
      '.cursor',
      'rules',
      'ace-code-search-first.mdc'
    );
    assert.ok((await fs.promises.readFile(cursorRule, 'utf8')).includes('alwaysApply: true'));
    assert.strictEqual(fs.existsSync(path.join(workspaceRoot, '.github')), false);

    const instruction = await installProjectVscodeInstruction({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot,
    });
    assert.strictEqual(instruction.changed, true);
    assert.ok((await fs.promises.readFile(instruction.path, 'utf8')).includes('applyTo: "**"'));

    const kept = await installProjectAgentRules({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot,
    });
    assert.ok(!kept.paths.some((item) => item.mode === 'removed'));
    assert.strictEqual(fs.existsSync(instruction.path), true);

    // A pre-migration marker has no kind and is safe to remove when its hash
    // still matches; this is the old default `.github` install behavior.
    const markerPath = path.join(
      workspaceRoot,
      '.github',
      'instructions',
      '.ace-code-search-instructions-managed.json'
    );
    const legacyMarker = JSON.parse(await fs.promises.readFile(markerPath, 'utf8')) as {
      kind?: string;
    };
    delete legacyMarker.kind;
    await fs.promises.writeFile(markerPath, `${JSON.stringify(legacyMarker)}\n`);
    const cleaned = await installProjectAgentRules({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot,
    });
    assert.ok(cleaned.paths.some((item) => item.mode === 'removed'));
    assert.strictEqual(fs.existsSync(instruction.path), false);

    const recreated = await installProjectVscodeInstruction({
      extensionRoot: ROOT,
      version: '1.0.0',
      workspaceRoot,
    });
    await fs.promises.appendFile(recreated.path, '\nuser edit\n');
    const preserved = await installProjectAgentRules({
      extensionRoot: ROOT,
      version: '1.0.1',
      workspaceRoot,
    });
    assert.ok(!preserved.paths.some((item) => item.mode === 'removed'));
    assert.ok((await fs.promises.readFile(recreated.path, 'utf8')).includes('user edit'));
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testOptionalPersonalInstructionSafety();
  await testUnmanagedInstructionIsPreserved();
  await testRuleTemplates();
  await testProjectRuleAndOptInInstruction();
  console.log('agentRuleInstaller tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
