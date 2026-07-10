import * as assert from 'assert';
import { ResultsPartialAckController } from '../src/ui/resultsPartialAckController';

async function run(): Promise<void> {
  const controller = new ResultsPartialAckController();

  const first = controller.waitFor(1, 1, 1000);
  assert.strictEqual(controller.acknowledge(1, 2), false, 'wrong chunk must not release waiter');
  assert.strictEqual(controller.acknowledge(2, 1), false, 'wrong search must not release waiter');
  assert.strictEqual(controller.acknowledge(1, 1), true);
  assert.strictEqual(await first, 'ack');

  const old = controller.waitFor(2, 1, 1000);
  const current = controller.waitFor(3, 1, 1000);
  assert.strictEqual(await old, 'cancelled', 'installing a new waiter cancels the old one');
  assert.strictEqual(controller.acknowledge(2, 1), false, 'late old ack must be ignored');
  assert.strictEqual(controller.acknowledge(3, 1), true);
  assert.strictEqual(await current, 'ack');

  const cancelled = controller.waitFor(4, 1, 1000);
  controller.cancelActive();
  assert.strictEqual(await cancelled, 'cancelled');

  const timedOut = controller.waitFor(5, 1, 5);
  assert.strictEqual(await timedOut, 'timeout');
  const afterTimeout = controller.waitFor(5, 2, 1000);
  assert.strictEqual(controller.acknowledge(5, 1), false, 'late timed-out ack must not shift the stream');
  assert.strictEqual(controller.acknowledge(5, 2), true);
  assert.strictEqual(await afterTimeout, 'ack');

  console.log('resultsPartialAckController tests passed');
}

void run();
