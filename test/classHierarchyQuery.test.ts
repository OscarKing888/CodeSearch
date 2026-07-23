import * as assert from 'assert';
import {
  buildClassHierarchy,
  extractClassDeclarations,
} from '../src/hierarchy/classHierarchy';
import { queryClassHierarchy } from '../src/hierarchy/classHierarchyQuery';

function build(source: string) {
  return buildClassHierarchy(
    extractClassDeclarations(source, '/indexed/Hierarchy.h')
  );
}

function testDiamondDagAndLimits(): void {
  const hierarchy = build([
    'class Root {};',
    'class Left : public Root {};',
    'class Right : public Root {};',
    'class Leaf : public Left, public Right {};',
  ].join('\n'));
  const mapped = (filePath: string) =>
    filePath.replace('/indexed/', '/mapped/');

  const all = queryClassHierarchy(hierarchy, 'Root', 'all', mapped);
  assert.strictEqual(all.ok, true);
  if (!all.ok) return;
  assert.strictEqual(all.totalNodeCount, 4);
  assert.strictEqual(all.returnedNodeCount, 4);
  assert.strictEqual(all.truncated, false);
  const leaf = all.nodes.find((node) => node.name === 'Leaf');
  const left = all.nodes.find((node) => node.name === 'Left');
  const right = all.nodes.find((node) => node.name === 'Right');
  assert.ok(leaf);
  assert.ok(left);
  assert.ok(right);
  assert.deepStrictEqual(
    new Set(leaf.baseIds),
    new Set([left.id, right.id])
  );
  assert.strictEqual(leaf.path, '/indexed/Hierarchy.h');
  assert.strictEqual(leaf.localPath, '/mapped/Hierarchy.h');
  assert.ok((leaf.endColumn ?? 0) > (leaf.column ?? 0));

  const limited = queryClassHierarchy(hierarchy, 'Root', 2, mapped);
  assert.strictEqual(limited.ok, true);
  if (!limited.ok) return;
  assert.strictEqual(limited.totalNodeCount, 4);
  assert.strictEqual(limited.returnedNodeCount, 2);
  assert.strictEqual(limited.truncated, true);
  const returnedIds = new Set(limited.nodes.map((node) => node.id));
  assert.ok(
    limited.nodes.every(
      (node) =>
        node.baseIds.every((id) => returnedIds.has(id)) &&
        node.derivedIds.every((id) => returnedIds.has(id))
    )
  );
}

function testQualifiedAndAmbiguousNames(): void {
  const hierarchy = build([
    'class Base {};',
    'namespace One { class Base {}; class Child : public Base {}; }',
    'namespace Two { class Base {}; }',
  ].join('\n'));

  const ambiguous = queryClassHierarchy(
    hierarchy,
    'Base',
    'all',
    (value) => value
  );
  assert.strictEqual(ambiguous.ok, false);
  if (ambiguous.ok) return;
  assert.strictEqual(ambiguous.error, 'ambiguous_class');
  assert.deepStrictEqual(
    ambiguous.candidates.map((candidate) => candidate.qualifiedName),
    ['Base', 'One::Base', 'Two::Base']
  );

  const qualified = queryClassHierarchy(
    hierarchy,
    'One::Base',
    'all',
    (value) => value
  );
  assert.strictEqual(qualified.ok, true);
  if (!qualified.ok) return;
  assert.ok(qualified.nodes.some((node) => node.qualifiedName === 'One::Child'));

  const explicitlyGlobal = queryClassHierarchy(
    hierarchy,
    '::Base',
    'all',
    (value) => value
  );
  assert.strictEqual(explicitlyGlobal.ok, true);
  if (!explicitlyGlobal.ok) return;
  assert.strictEqual(explicitlyGlobal.nodes[0].qualifiedName, 'Base');
}

function testExternalRootAndNotFound(): void {
  const hierarchy = build('class Child : public MissingRoot {};');
  const external = queryClassHierarchy(
    hierarchy,
    'MissingRoot',
    'all',
    (value) => value
  );
  assert.strictEqual(external.ok, true);
  if (!external.ok) return;
  assert.strictEqual(external.nodes[0].external, true);
  assert.strictEqual(external.nodes[0].path, undefined);
  assert.ok(external.nodes.some((node) => node.name === 'Child'));

  const missing = queryClassHierarchy(
    hierarchy,
    'DefinitelyMissing',
    20,
    (value) => value
  );
  assert.deepStrictEqual(missing, {
    ok: false,
    error: 'not_found',
    candidates: [],
  });
}

function main(): void {
  testDiamondDagAndLimits();
  testQualifiedAndAmbiguousNames();
  testExternalRootAndNotFound();
  console.log('classHierarchyQuery tests passed');
}

main();
