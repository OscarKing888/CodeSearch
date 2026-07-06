import * as assert from 'assert';
import * as os from 'os';
import { mapWithConcurrency } from '../src/index/concurrency';
import { getLogicalCpuCount, resolveIndexThreadCount } from '../src/index/threadCount';

async function testMapWithConcurrencyLimitsInFlight(): Promise<void> {
  let inFlight = 0;
  let maxInFlight = 0;
  const concurrency = 3;
  const items = Array.from({ length: 10 }, (_, i) => i);

  await mapWithConcurrency(items, concurrency, async (item) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight--;
    return item * 2;
  });

  assert.strictEqual(maxInFlight, concurrency);
}

async function testMapWithConcurrencyPreservesOrder(): Promise<void> {
  const items = [1, 2, 3, 4, 5];
  const results = await mapWithConcurrency(items, 2, async (n) => n + 10);
  assert.deepStrictEqual(results, [11, 12, 13, 14, 15]);
}

function testResolveIndexThreadCountAuto(): void {
  assert.strictEqual(resolveIndexThreadCount(0), getLogicalCpuCount());
}

function testResolveIndexThreadCountClamp(): void {
  const cpuCount = getLogicalCpuCount();
  assert.strictEqual(resolveIndexThreadCount(999), cpuCount);
  assert.strictEqual(resolveIndexThreadCount(-5), 1);
  assert.strictEqual(resolveIndexThreadCount(2), Math.min(2, cpuCount));
}

function testGetLogicalCpuCount(): void {
  assert.ok(getLogicalCpuCount() >= 1);
  assert.strictEqual(getLogicalCpuCount(), os.cpus().length || 1);
}

async function main(): Promise<void> {
  await testMapWithConcurrencyLimitsInFlight();
  await testMapWithConcurrencyPreservesOrder();
  testResolveIndexThreadCountAuto();
  testResolveIndexThreadCountClamp();
  testGetLogicalCpuCount();
  console.log('concurrency tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
