import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { getIndexingMatcher } from '../src/index/excludePatterns';
import {
  DEFAULT_EXCLUDE_DIR_NAMES,
  DEFAULT_EXCLUDE_FILE_NAMES,
  DEFAULT_EXCLUDE_GLOBS,
  DEFAULT_INDEXING_SETTINGS,
  DEFAULT_UNREAL_CORE_EXCLUDE_DIR_NAMES,
} from '../src/indexingSettings';

function testPackageDefaultsStayInSync(): void {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  ) as {
    contributes: {
      configuration: {
        properties: Record<string, { default?: unknown }>;
      };
    };
  };
  const properties = packageJson.contributes.configuration.properties;

  assert.deepStrictEqual(properties['codeSearch.excludeGlobs'].default, DEFAULT_EXCLUDE_GLOBS);
  assert.deepStrictEqual(
    properties['codeSearch.excludeDirNames'].default,
    DEFAULT_EXCLUDE_DIR_NAMES
  );
  assert.deepStrictEqual(
    properties['codeSearch.excludeFileNames'].default,
    DEFAULT_EXCLUDE_FILE_NAMES
  );
  assert.deepStrictEqual(
    properties['codeSearch.includeGlobs'].default,
    DEFAULT_INDEXING_SETTINGS.includeGlobs
  );
}

function testUnrealCoreDefaults(): void {
  const matcher = getIndexingMatcher(DEFAULT_INDEXING_SETTINGS);
  for (const dirName of DEFAULT_UNREAL_CORE_EXCLUDE_DIR_NAMES) {
    assert.ok(
      DEFAULT_EXCLUDE_DIR_NAMES.includes(dirName),
      `${dirName} must remain in the effective default directory exclusions`
    );
    assert.strictEqual(
      matcher.isPathIgnored(`D:/Game/Plugins/Feature/${dirName}/Generated.cpp`, false),
      true,
      `${dirName} must be excluded at any Unreal project depth`
    );
  }

  for (const sourcePath of [
    'D:/Game/Source/Game/GameMode.cpp',
    'D:/Game/Plugins/Feature/Source/Feature.cpp',
    'D:/Game/Config/DefaultGame.ini',
  ]) {
    assert.strictEqual(
      matcher.isPathIgnored(sourcePath, false),
      false,
      `${sourcePath} must remain searchable`
    );
  }
}

function run(): void {
  testPackageDefaultsStayInSync();
  testUnrealCoreDefaults();
  console.log('indexingSettings.test.ts: all passed');
}

run();
