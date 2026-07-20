import * as assert from 'assert';
import {
  captureWorkspaceOperation,
  isWorkspaceOperationCurrent,
} from '../src/index/workspaceOperationGuard';

function run(): void {
  const managerA = { name: 'manager-a' };
  const managerB = { name: 'manager-b' };
  const workspaceA = { hash: 'workspace-a' };
  const sameHashReplacement = { hash: 'workspace-a' };
  const token = captureWorkspaceOperation(managerA, workspaceA);

  assert.strictEqual(isWorkspaceOperationCurrent(token, managerA, workspaceA), true);
  assert.strictEqual(
    isWorkspaceOperationCurrent(token, managerB, workspaceA),
    false,
    'a replacement manager invalidates the old command'
  );
  assert.strictEqual(
    isWorkspaceOperationCurrent(token, managerA, sameHashReplacement),
    false,
    'object identity guards same-hash workspace reinitialization'
  );
  workspaceA.hash = 'workspace-b';
  assert.strictEqual(
    isWorkspaceOperationCurrent(token, managerA, workspaceA),
    false,
    'the captured hash cannot silently follow a mutated workspace context'
  );
  console.log('workspaceOperationGuard.test.ts: all passed');
}

run();
