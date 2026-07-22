import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cleanupLegacyProjectAgentRules,
  readCursorUserRule,
} from '../src/agentRuleInstaller';

const ROOT = path.join(__dirname, '..');

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function writeManagedFile(
  targetPath: string,
  markerName: string,
  content: string,
  kind?: 'cursor-project-rule' | 'vscode-project-instruction-opt-in'
): Promise<void> {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.writeFile(targetPath, content);
  await fs.promises.writeFile(
    path.join(path.dirname(targetPath), markerName),
    `${JSON.stringify({
      owner: 'OscarKing888.ace-code-search',
      version: '0.8.0',
      sourceHash: sha256(content),
      ...(kind ? { kind } : {}),
    })}\n`
  );
}

async function testManagedLegacyCleanup(): Promise<void> {
  const workspaceRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-rule-cleanup-')
  );
  try {
    const cursorPath = path.join(
      workspaceRoot,
      '.cursor',
      'rules',
      'ace-code-search-first.mdc'
    );
    const githubPath = path.join(
      workspaceRoot,
      '.github',
      'instructions',
      'ace-code-search.instructions.md'
    );
    await writeManagedFile(
      cursorPath,
      '.ace-code-search-rule-managed.json',
      'managed cursor rule\n',
      'cursor-project-rule'
    );
    await writeManagedFile(
      githubPath,
      '.ace-code-search-instructions-managed.json',
      'managed instruction\n',
      'vscode-project-instruction-opt-in'
    );

    const result = await cleanupLegacyProjectAgentRules({ workspaceRoot });
    assert.strictEqual(result.changed, true);
    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(result.paths.map((item) => item.mode), ['removed', 'removed']);
    assert.strictEqual(fs.existsSync(cursorPath), false);
    assert.strictEqual(fs.existsSync(githubPath), false);
    assert.strictEqual(fs.existsSync(path.dirname(cursorPath)), false);
    assert.strictEqual(fs.existsSync(path.dirname(githubPath)), false);
    assert.strictEqual(fs.existsSync(path.join(workspaceRoot, '.cursor')), false);
    assert.strictEqual(fs.existsSync(path.join(workspaceRoot, '.github')), false);
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testLegacyMarkerWithoutKind(): Promise<void> {
  const workspaceRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-rule-old-marker-')
  );
  try {
    const githubPath = path.join(
      workspaceRoot,
      '.github',
      'instructions',
      'ace-code-search.instructions.md'
    );
    await writeManagedFile(
      githubPath,
      '.ace-code-search-instructions-managed.json',
      'old managed instruction\n'
    );
    const result = await cleanupLegacyProjectAgentRules({ workspaceRoot });
    assert.strictEqual(result.changed, true);
    assert.strictEqual(fs.existsSync(githubPath), false);
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testModifiedAndUnmanagedFilesArePreserved(): Promise<void> {
  const workspaceRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'code-search-rule-preserve-')
  );
  try {
    const cursorPath = path.join(
      workspaceRoot,
      '.cursor',
      'rules',
      'ace-code-search-first.mdc'
    );
    const githubPath = path.join(
      workspaceRoot,
      '.github',
      'instructions',
      'ace-code-search.instructions.md'
    );
    await writeManagedFile(
      cursorPath,
      '.ace-code-search-rule-managed.json',
      'managed cursor rule\n',
      'cursor-project-rule'
    );
    await fs.promises.appendFile(cursorPath, 'user edit\n');
    await fs.promises.mkdir(path.dirname(githubPath), { recursive: true });
    await fs.promises.writeFile(githubPath, 'user-owned instruction\n');

    const result = await cleanupLegacyProjectAgentRules({ workspaceRoot });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.warnings.length, 2);
    assert.ok((await fs.promises.readFile(cursorPath, 'utf8')).includes('user edit'));
    assert.strictEqual(
      await fs.promises.readFile(githubPath, 'utf8'),
      'user-owned instruction\n'
    );
  } finally {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testOptionalCursorUserRule(): Promise<void> {
  const cursorUserRule = await readCursorUserRule(ROOT);
  assert.ok(cursorUserRule.includes('.agents/skills/ace-code-search-mcp/SKILL.md'));
  assert.ok(cursorUserRule.includes('Fall back to `rg`'));
}

async function main(): Promise<void> {
  await testManagedLegacyCleanup();
  await testLegacyMarkerWithoutKind();
  await testModifiedAndUnmanagedFilesArePreserved();
  await testOptionalCursorUserRule();
  console.log('agentRuleInstaller tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
