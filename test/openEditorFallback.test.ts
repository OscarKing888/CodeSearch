import * as assert from 'assert';
import {
  formatOpenEditorFailureMessage,
  isExtensionSyncRefusalError,
  openWithFallback,
} from '../src/ui/openEditorFallback';

const NEW_SYNC_MESSAGE =
  'cannot open file:///e%3A/example.h. Detail: Documents above the size limit cannot be synchronized with extensions.';
const OLD_SYNC_MESSAGE =
  'cannot open file:///c%3A/example.h. Detail: Files above 50MB cannot be synchronized with extensions.';

function syncError(message: string): Error {
  return new Error(message);
}

async function testClassifiesOldAndNewSyncMessages(): Promise<void> {
  assert.strictEqual(isExtensionSyncRefusalError(syncError(NEW_SYNC_MESSAGE)), true);
  assert.strictEqual(isExtensionSyncRefusalError(syncError(OLD_SYNC_MESSAGE)), true);
  assert.strictEqual(isExtensionSyncRefusalError(NEW_SYNC_MESSAGE), true);
  assert.strictEqual(isExtensionSyncRefusalError(new Error('ENOENT: no such file')), false);
  assert.strictEqual(isExtensionSyncRefusalError(undefined), false);
}

async function testDocumentPathSucceedsWithoutCommand(): Promise<void> {
  let commandCalls = 0;
  const result = await openWithFallback({
    openViaDocument: async () => undefined,
    openViaCommand: async () => {
      commandCalls += 1;
    },
    fileExists: () => {
      throw new Error('fileExists should not run on success');
    },
  });
  assert.deepStrictEqual(result, { outcome: 'document' });
  assert.strictEqual(commandCalls, 0);
}

async function testCommandFallbackAfterSyncRefusal(): Promise<void> {
  let commandCalls = 0;
  const result = await openWithFallback({
    openViaDocument: async () => {
      throw syncError(NEW_SYNC_MESSAGE);
    },
    openViaCommand: async () => {
      commandCalls += 1;
    },
    fileExists: () => {
      throw new Error('fileExists should not run on fallback success');
    },
  });
  assert.deepStrictEqual(result, { outcome: 'command' });
  assert.strictEqual(commandCalls, 1);
}

async function testCommandFallbackAfterUnknownDocumentError(): Promise<void> {
  const result = await openWithFallback({
    openViaDocument: async () => {
      throw new Error('timeout');
    },
    openViaCommand: async () => undefined,
    fileExists: () => true,
  });
  assert.deepStrictEqual(result, { outcome: 'command' });
}

async function testBothFailFileMissing(): Promise<void> {
  const result = await openWithFallback({
    openViaDocument: async () => {
      throw syncError(NEW_SYNC_MESSAGE);
    },
    openViaCommand: async () => {
      throw new Error('ENOENT: no such file or directory');
    },
    fileExists: () => false,
  });
  assert.deepStrictEqual(result, {
    outcome: 'failed',
    reason: 'missing',
    detail: 'ENOENT: no such file or directory',
  });
}

async function testBothFailSyncRefusedAndFileExists(): Promise<void> {
  const result = await openWithFallback({
    openViaDocument: async () => {
      throw syncError(OLD_SYNC_MESSAGE);
    },
    openViaCommand: async () => {
      throw new Error('still refused');
    },
    fileExists: async () => true,
  });
  assert.deepStrictEqual(result, {
    outcome: 'failed',
    reason: 'syncRefused',
    detail: 'still refused',
  });
}

async function testBothFailUnknownAndFileExists(): Promise<void> {
  const result = await openWithFallback({
    openViaDocument: async () => {
      throw new Error('permission denied');
    },
    openViaCommand: async () => {
      throw new Error('command failed');
    },
    fileExists: () => true,
  });
  assert.deepStrictEqual(result, {
    outcome: 'failed',
    reason: 'unknown',
    detail: 'command failed',
  });
}

async function testFailureMessages(): Promise<void> {
  assert.strictEqual(
    formatOpenEditorFailureMessage('C:\\missing.h', {
      outcome: 'failed',
      reason: 'missing',
      detail: 'ENOENT',
    }),
    'Ace Code Search: 无法打开 C:\\missing.h。文件不存在，索引可能已过期，请刷新索引后再试。'
  );
  assert.strictEqual(
    formatOpenEditorFailureMessage('E:\\game.h', {
      outcome: 'failed',
      reason: 'syncRefused',
      detail: NEW_SYNC_MESSAGE,
    }),
    'Ace Code Search: 无法打开 E:\\game.h。编辑器拒绝将该文档同步到扩展进程，请从资源管理器直接打开该文件。'
  );
  assert.strictEqual(
    formatOpenEditorFailureMessage('D:\\locked.h', {
      outcome: 'failed',
      reason: 'unknown',
      detail: 'EPERM',
    }),
    'Ace Code Search: 无法打开 D:\\locked.h。EPERM'
  );
}

async function main(): Promise<void> {
  await testClassifiesOldAndNewSyncMessages();
  await testDocumentPathSucceedsWithoutCommand();
  await testCommandFallbackAfterSyncRefusal();
  await testCommandFallbackAfterUnknownDocumentError();
  await testBothFailFileMissing();
  await testBothFailSyncRefusedAndFileExists();
  await testBothFailUnknownAndFileExists();
  await testFailureMessages();
  console.log('openEditorFallback.test.ts: all passed');
}

void main();
