import * as assert from 'assert';
import {
  beginSearchProfile,
  getActiveProfile,
  runWithSearchProfile,
} from '../src/utils/searchProfile';

const options = {
  caseSensitive: false,
  phraseSearch: true,
  contextLines: 0,
  maxResults: 100,
  fuzzy: false,
  loose: false,
  looseGap: 10,
};

async function run(): Promise<void> {
  const first = beginSearchProfile({ version: 'test', query: 'first', options });
  const second = beginSearchProfile({ version: 'test', query: 'second', options });
  first.cancel();
  assert.strictEqual(getActiveProfile(), second, 'old cancellation must not clear newer session');

  const contextual = beginSearchProfile({ version: 'test', query: 'contextual', options });
  const contextResult = runWithSearchProfile(contextual, async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return getActiveProfile();
  });
  const newest = beginSearchProfile({ version: 'test', query: 'newest', options });
  assert.strictEqual(await contextResult, contextual, 'async search work must retain its own profile');
  contextual.cancel();
  assert.strictEqual(getActiveProfile(), newest, 'contextual cancellation must preserve active newer session');

  second.cancel();
  newest.cancel();
  console.log('searchProfileContext tests passed');
}

void run();
