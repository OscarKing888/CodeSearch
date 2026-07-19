import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  installVscodePersonalInstruction,
  readCursorUserRule,
} from '../src/agentRuleInstaller';

const ROOT = path.join(__dirname, '..');

async function testInstallAndUpdate(): Promise<void> {
  const homeDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-rule-')
  );
  try {
    const first = await installVscodePersonalInstruction({
      extensionRoot: ROOT,
      version: '1.0.0',
      homeDir,
    });
    assert.strictEqual(first.changed, true);
    assert.strictEqual(first.warning, undefined);
    const content = await fs.promises.readFile(first.path, 'utf8');
    assert.ok(content.includes('applyTo: "**"'));
    assert.ok(content.includes('Prefer the `ace-code-search-mcp` Skill'));

    const second = await installVscodePersonalInstruction({
      extensionRoot: ROOT,
      version: '1.0.0',
      homeDir,
    });
    assert.strictEqual(second.changed, false);

    const upgraded = await installVscodePersonalInstruction({
      extensionRoot: ROOT,
      version: '1.1.0',
      homeDir,
    });
    assert.strictEqual(upgraded.changed, true);
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
    assert.ok(result.warning?.includes('unmanaged'));
    assert.strictEqual(
      await fs.promises.readFile(target, 'utf8'),
      'user-owned\n'
    );
  } finally {
    await fs.promises.rm(homeDir, { recursive: true, force: true });
  }
}

async function testCursorRuleAndProjectRule(): Promise<void> {
  const cursorRule = await readCursorUserRule(ROOT);
  assert.ok(cursorRule.includes('prefer the ace-code-search-mcp Skill'));
  assert.ok(cursorRule.includes('Fall back to rg'));

  const projectRule = await fs.promises.readFile(
    path.join(
      ROOT,
      '.cursor',
      'rules',
      'ace-code-search-first.mdc'
    ),
    'utf8'
  );
  assert.ok(projectRule.includes('alwaysApply: true'));
  assert.ok(projectRule.includes('partialIndex'));
}

async function main(): Promise<void> {
  await testInstallAndUpdate();
  await testUnmanagedInstructionIsPreserved();
  await testCursorRuleAndProjectRule();
  console.log('agentRuleInstaller tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
