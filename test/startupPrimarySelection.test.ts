import * as assert from 'assert';
import * as path from 'path';
import { selectFirstUsableStartupPrimary } from '../src/index/startupPrimarySelection';

async function testFailedSavedPrimaryContinuesToShared(): Promise<void> {
  const saved = path.resolve('test-indexes', 'saved.db');
  const shared = path.resolve('test-indexes', 'shared.db');
  const attempts: string[] = [];
  const failures: string[] = [];

  const result = await selectFirstUsableStartupPrimary(
    [
      {
        dbPath: saved,
        details: { source: 'saved' },
        open: async () => {
          attempts.push('saved');
          throw new Error('invalid schema');
        },
      },
      {
        // A registry commonly returns the same path as the saved binding. It
        // must not be retried before moving on to the shared candidate.
        dbPath: path.join(path.dirname(saved), '.', path.basename(saved)),
        details: { source: 'legacy' },
        open: async () => {
          attempts.push('duplicate');
          return 'wrong';
        },
      },
      {
        dbPath: shared,
        details: { source: 'shared' },
        open: async () => {
          attempts.push('shared');
          return 'opened-shared';
        },
      },
    ],
    (failure) => failures.push(`${failure.details.source}:${failure.dbPath}`)
  );

  assert.strictEqual(result.selected?.value, 'opened-shared');
  assert.strictEqual(result.selected?.candidate.details.source, 'shared');
  assert.deepStrictEqual(attempts, ['saved', 'shared']);
  assert.strictEqual(result.failures.length, 1);
  assert.strictEqual(failures.length, 1);
}

async function testAllInvalidCandidatesReturnWithoutThrowing(): Promise<void> {
  const result = await selectFirstUsableStartupPrimary([
    {
      dbPath: path.resolve('test-indexes', 'legacy.db'),
      details: 'legacy',
      open: async () => {
        throw new Error('legacy invalid');
      },
    },
    {
      dbPath: path.resolve('test-indexes', 'shared.db'),
      details: 'shared',
      open: async () => {
        throw new Error('shared invalid');
      },
    },
  ]);

  assert.strictEqual(result.selected, undefined);
  assert.deepStrictEqual(
    result.failures.map((failure) => failure.details),
    ['legacy', 'shared']
  );
}

async function run(): Promise<void> {
  await testFailedSavedPrimaryContinuesToShared();
  await testAllInvalidCandidatesReturnWithoutThrowing();
  console.log('startupPrimarySelection.test.ts: all passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
