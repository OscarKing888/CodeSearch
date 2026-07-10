import * as assert from 'assert';
import {
  FIRST_BATCH_SIZE,
  HitStreamBuffer,
  STREAM_BATCH_SIZE,
  UI_POST_CHUNK_SIZE,
} from '../src/search/searchStreamBuffer';

const buffer = new HitStreamBuffer();
const emitted: number[] = [];
for (let i = 0; i < FIRST_BATCH_SIZE + STREAM_BATCH_SIZE * 2; i++) {
  const batch = buffer.add({
    path: `file-${i}.ts`,
    line: 1,
    column: 1,
    lineText: 'match',
    contextBefore: [],
    contextAfter: [],
    matchStart: 0,
    matchEnd: 5,
  });
  if (batch) {
    emitted.push(batch.length);
  }
}

assert.deepStrictEqual(emitted, [FIRST_BATCH_SIZE, STREAM_BATCH_SIZE, STREAM_BATCH_SIZE]);
assert.strictEqual(buffer.flush().length, 0);
assert.strictEqual(UI_POST_CHUNK_SIZE, 100);
console.log('searchStreamBuffer tests passed');
