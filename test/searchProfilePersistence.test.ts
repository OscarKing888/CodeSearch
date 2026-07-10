import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  beginSearchProfile,
  ProfileSummary,
  SearchProfileOutcome,
} from '../src/utils/searchProfile';

const options = {
  caseSensitive: false,
  phraseSearch: true,
  contextLines: 0,
  maxResults: 10_000,
  fuzzy: false,
  loose: false,
  looseGap: 10,
};

function readLines(filePath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail('timed out waiting for profile checkpoint');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function testImmediateMetaCheckpointAndSuccess(root: string): Promise<void> {
  const globalStoragePath = path.join(root, 'global-success');
  const workspaceRoot = path.join(root, 'workspace-success');
  const started = Date.now();
  const session = beginSearchProfile(
    { version: 'test', query: 'AActor', options },
    { globalStoragePath, workspaceRoot }
  );
  const logPath = session.getLogPath();
  assert.ok(logPath);

  await waitFor(() => fs.existsSync(logPath!));
  assert.ok(Date.now() - started < 500, 'meta should be visible without waiting for search completion');
  let lines = readLines(logPath!);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].type, 'meta');
  assert.strictEqual(lines[0].query, 'AActor');

  session.mark('running_checkpoint', { value: 1 });
  await waitFor(() => readLines(logPath!).some((line) => line.phase === 'running_checkpoint'));

  session.mark('provider_resultsPartial_ack_timeout', {
    searchId: 1,
    chunkId: 99,
    waitMs: 2_001,
  });
  await waitFor(() =>
    readLines(logPath!).some((line) => line.phase === 'provider_resultsPartial_ack_timeout')
  );

  session.mark('provider_resultsPartial_ack', {
    searchId: 1,
    chunkId: 1,
    outcome: 'ack',
    waitMs: 12.5,
  });
  await session.checkpoint();
  await session.finalize('success');

  lines = readLines(logPath!);
  const summaries = lines.filter((line) => line.type === 'summary') as unknown as ProfileSummary[];
  assert.strictEqual(summaries.length, 1);
  assert.strictEqual(summaries[0].outcome, 'success');
  assert.deepStrictEqual(summaries[0].ackWaits, [
    { searchId: 1, chunkId: 1, outcome: 'ack', waitMs: 12.5 },
  ]);
  assert.strictEqual(lines[lines.length - 1]?.type, 'summary');

  const latestLines = readLines(session.getLatestPath()!);
  assert.strictEqual(latestLines[0].sessionId, session.sessionId);
  const mirrorPath = path.join(workspaceRoot, '.code-search', 'profile-latest.jsonl');
  await waitFor(() => {
    try {
      const mirrorLines = readLines(mirrorPath);
      return mirrorLines[mirrorLines.length - 1]?.type === 'summary';
    } catch {
      return false;
    }
  });
  assert.strictEqual(readLines(mirrorPath)[0].sessionId, session.sessionId);
}

async function testTerminalOutcomesAreIdempotent(root: string): Promise<void> {
  const outcomes: SearchProfileOutcome[] = ['cancelled', 'error', 'disposed'];
  for (const outcome of outcomes) {
    const session = beginSearchProfile(
      { version: 'test', query: outcome, options },
      { globalStoragePath: path.join(root, `global-${outcome}`) }
    );
    session.mark('before_terminal');
    const first = session.finalize(outcome, outcome === 'error' ? new Error('boom') : undefined);
    const second = session.finalize('success');
    assert.strictEqual(first, second, 'finalize must be first-wins and return one promise');
    await first;

    const logPath = session.getLogPath()!;
    const beforeLateMark = fs.readFileSync(logPath, 'utf8');
    session.mark('after_terminal');
    await session.checkpoint();
    assert.strictEqual(fs.readFileSync(logPath, 'utf8'), beforeLateMark);

    const lines = readLines(logPath);
    const summaries = lines.filter((line) => line.type === 'summary');
    assert.strictEqual(summaries.length, 1);
    assert.strictEqual(summaries[0].outcome, outcome);
    assert.strictEqual(lines[lines.length - 1]?.type, 'summary');
    if (outcome === 'error') {
      assert.strictEqual(summaries[0].error, 'boom');
    }
  }
}

async function testLatestOwnershipAndUniqueLogs(root: string): Promise<void> {
  const globalStoragePath = path.join(root, 'global-overlap');
  const workspaceRoot = path.join(root, 'workspace-overlap');
  const older = beginSearchProfile(
    { version: 'test', query: 'same query', options },
    { globalStoragePath, workspaceRoot }
  );
  const newer = beginSearchProfile(
    { version: 'test', query: 'same query', options },
    { globalStoragePath, workspaceRoot }
  );

  assert.notStrictEqual(older.getLogPath(), newer.getLogPath());
  newer.mark('newer_mark');
  await newer.finalize('success');
  older.mark('older_late_mark');
  await older.finalize('cancelled');

  const latest = readLines(newer.getLatestPath()!);
  assert.strictEqual(latest[0].sessionId, newer.sessionId);
  assert.strictEqual(latest[latest.length - 1]?.outcome, 'success');
  const mirrorPath = path.join(workspaceRoot, '.code-search', 'profile-latest.jsonl');
  await waitFor(() => {
    try {
      const mirrorLines = readLines(mirrorPath);
      return mirrorLines[mirrorLines.length - 1]?.outcome === 'success';
    } catch {
      return false;
    }
  });
  const mirror = readLines(mirrorPath);
  assert.strictEqual(mirror[0].sessionId, newer.sessionId);
  const olderLines = readLines(older.getLogPath()!);
  assert.strictEqual(olderLines[olderLines.length - 1]?.outcome, 'cancelled');
}

async function testWorkspaceMirrorFailureIsBestEffort(root: string): Promise<void> {
  const workspaceFile = path.join(root, 'not-a-workspace-directory');
  fs.writeFileSync(workspaceFile, 'file blocks mirror directory creation', 'utf8');
  const session = beginSearchProfile(
    { version: 'test', query: 'mirror failure', options },
    {
      globalStoragePath: path.join(root, 'global-mirror-failure'),
      workspaceRoot: workspaceFile,
    }
  );
  session.mark('still_writes_global');
  await session.finalize('success');
  const lines = readLines(session.getLogPath()!);
  assert.strictEqual(lines[lines.length - 1]?.outcome, 'success');
  assert.ok(lines.some((line) => line.phase === 'still_writes_global'));
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-search-profile-'));
  try {
    await testImmediateMetaCheckpointAndSuccess(root);
    await testTerminalOutcomesAreIdempotent(root);
    await testLatestOwnershipAndUniqueLogs(root);
    await testWorkspaceMirrorFailureIsBestEffort(root);
    console.log('searchProfilePersistence tests passed');
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

void main();
