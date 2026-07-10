import * as assert from 'assert';
import {
  migrateKeybindings,
  parseKeybindingsJson,
  TARGET_HEADER_SOURCE_COMMAND,
} from '../src/pairing/migrateHeaderSourceKeybindings';
import { registerHeaderSourceCommandOverrides } from '../src/pairing/registerHeaderSourceCommandOverrides';

function testMigrateLegacyAltO(): void {
  const input = [
    {
      key: 'alt+o',
      command: 'C_Cpp.SwitchHeaderSource',
      when: "editorTextFocus && (editorLangId == 'cpp' || editorLangId == 'c')",
    },
  ];

  const { entries, changed } = migrateKeybindings(input);
  assert.strictEqual(changed, true);
  assert.ok(
    entries.some(
      (entry) => entry.key === 'alt+o' && entry.command === TARGET_HEADER_SOURCE_COMMAND
    )
  );
  assert.ok(entries.some((entry) => entry.command === '-C_Cpp.SwitchHeaderSource'));
  assert.ok(entries.some((entry) => entry.command === '-clangd.switchheadersource'));
}

function testNoChangeWithoutLegacyAltO(): void {
  const input = [
    { key: 'ctrl+i', command: 'composerMode.agent' },
    { key: 'alt+o', command: TARGET_HEADER_SOURCE_COMMAND, when: 'editorTextFocus' },
  ];

  const { entries, changed } = migrateKeybindings(input);
  assert.strictEqual(changed, false);
  assert.strictEqual(entries.length, input.length);
}

function testParseJsoncComments(): void {
  const parsed = parseKeybindingsJson(`// comment
[
  {
    "key": "alt+o",
    "command": "clangd.switchheadersource"
  }
]`);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].command, 'clangd.switchheadersource');
}

function testLegacyOverrideRegistrationIsNoOp(): void {
  const subscriptions: Array<{ dispose(): void }> = [];
  let getIndexManagerCalls = 0;
  let ensureReadyCalls = 0;

  registerHeaderSourceCommandOverrides(
    { subscriptions } as never,
    () => {
      getIndexManagerCalls++;
      return undefined;
    },
    async () => {
      ensureReadyCalls++;
      return true;
    }
  );

  assert.strictEqual(subscriptions.length, 0);
  assert.strictEqual(getIndexManagerCalls, 0);
  assert.strictEqual(ensureReadyCalls, 0);
}

function main(): void {
  testMigrateLegacyAltO();
  testNoChangeWithoutLegacyAltO();
  testParseJsoncComments();
  testLegacyOverrideRegistrationIsNoOp();
  console.log('migrateHeaderSourceKeybindings tests passed');
}

main();
