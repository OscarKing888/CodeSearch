import * as assert from 'assert';
import { formatIndexDisplayTitle } from '../src/ui/indexDisplayTitle';

function testEmptyRootsUsesFallback(): void {
  assert.strictEqual(formatIndexDisplayTitle([], 'Primary'), 'Primary');
  assert.strictEqual(formatIndexDisplayTitle([], ''), '—');
}

function testSingleRoot(): void {
  assert.strictEqual(
    formatIndexDisplayTitle(['D:\\UnrealEngine\\UE_5.4'], 'Primary'),
    'D:\\UnrealEngine\\UE_5.4'
  );
}

function testMultipleRoots(): void {
  assert.strictEqual(
    formatIndexDisplayTitle(['D:\\repo\\a', 'D:\\repo\\b'], 'Primary'),
    'D:\\repo\\a; D:\\repo\\b'
  );
}

function run(): void {
  testEmptyRootsUsesFallback();
  testSingleRoot();
  testMultipleRoots();
  console.log('indexDisplayTitle.test.ts: all passed');
}

run();
