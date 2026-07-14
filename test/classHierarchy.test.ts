import * as assert from 'assert';
import {
  buildClassHierarchy,
  ClassDeclaration,
  extractClassDeclarations,
} from '../src/hierarchy/classHierarchy';

function testExtractionAndHitFiltering(): void {
  const source = [
    '// class CommentedOut : public Nope {',
    'const char* text = "struct StringFake {";',
    'const char* raw = R"tag(class RawFake {})tag";',
    '/* struct BlockFake { }; */',
    'class ForwardOnly;',
    'enum class Colour { Red };',
    'template <class T, template<class> class Container>',
    'class GAMEPLAY_API TChild final',
    '  : public virtual Engine::TBase<T, Pair<int, int>>,',
    '    virtual protected Outer<T>::template Mixin<float>,',
    '    PrivateBase',
    '{',
    '};',
    'struct PlainStruct : Package::Base<int> {',
    '};',
  ].join('\n');

  const declarations = extractClassDeclarations(source, {
    path: '/project/Child.h',
    hitLines: new Set([9, 14]),
    metadata: { indexId: 'secondary', localPath: 'Child.h' },
  });

  assert.deepStrictEqual(declarations.map((item) => item.name), ['TChild', 'PlainStruct']);
  const child = declarations[0];
  assert.strictEqual(child.kind, 'class');
  assert.strictEqual(child.isFinal, true);
  assert.deepStrictEqual(
    { line: child.location.line, column: child.location.column, endLine: child.location.endLine },
    { line: 8, column: 1, endLine: 12 }
  );
  assert.deepStrictEqual(child.location.metadata, {
    indexId: 'secondary',
    localPath: 'Child.h',
  });
  assert.deepStrictEqual(child.bases, [
    {
      name: 'Engine::TBase<T, Pair<int, int>>',
      lookupName: 'Engine::TBase',
      access: 'public',
      isVirtual: true,
    },
    {
      name: 'Outer<T>::template Mixin<float>',
      lookupName: 'Outer::Mixin',
      access: 'protected',
      isVirtual: true,
    },
    {
      name: 'PrivateBase',
      lookupName: 'PrivateBase',
      access: 'private',
      isVirtual: false,
    },
  ]);
  assert.strictEqual(declarations[1].bases[0].access, 'public');

  const noHeaderHit = extractClassDeclarations(source, '/project/Child.h', [1, 13, 15]);
  assert.deepStrictEqual(noHeaderHit, []);
  assert.deepStrictEqual(extractClassDeclarations(source, '/project/Child.h', []), []);
}

function testAnnotationsAndQualifiedDeclaration(): void {
  const source = [
    'class [[nodiscard]] CORE_API Namespace::Exported final : virtual public Root {',
    '};',
    'struct alignas(16) Aligned {',
    '};',
  ].join('\n');
  const declarations = extractClassDeclarations(source, '/project/Annotated.h');
  assert.deepStrictEqual(declarations.map((item) => item.name), ['Exported', 'Aligned']);
  assert.strictEqual(declarations[0].qualifiedName, 'Namespace::Exported');
  assert.deepStrictEqual(declarations[0].bases[0], {
    name: 'Root',
    lookupName: 'Root',
    access: 'public',
    isVirtual: true,
  });
}

function testUnrealMetadataLinesCountAsDeclarationHits(): void {
  const source = [
    'UCLASS(',
    '  BlueprintType',
    ')',
    'class GAME_API UThing : public UObject {',
    '};',
    'template <class T>',
    'struct TWrapper {',
    '};',
  ].join('\n');

  const unreal = extractClassDeclarations(source, '/project/Thing.h', [2]);
  assert.deepStrictEqual(unreal.map((item) => item.name), ['UThing']);
  assert.strictEqual(unreal[0].location.line, 4, 'navigation should stay on the class keyword');

  const template = extractClassDeclarations(source, '/project/Thing.h', [6]);
  assert.deepStrictEqual(template.map((item) => item.name), ['TWrapper']);
  assert.strictEqual(template[0].location.line, 7);
}

function testCSharpUnrealSharpClassesJoinNativeBases(): void {
  const native = extractClassDeclarations(
    'class ANativePawn {};\n',
    '/project/NativePawn.h'
  );
  const managed = extractClassDeclarations([
    'namespace Game.Managed;',
    '[UClass]',
    'public partial class ManagedPawn : ANativePawn, IDisposable {',
    '}',
    'public sealed class ScriptPawn : ManagedPawn {',
    '}',
  ].join('\n'), '/project/Scripts/ManagedPawn.cs');

  assert.deepStrictEqual(managed.map((item) => item.qualifiedName), [
    'Game::Managed::ManagedPawn',
    'Game::Managed::ScriptPawn',
  ]);
  assert.strictEqual(managed[0].location.line, 3);
  assert.deepStrictEqual(managed[0].bases, [{
    name: 'ANativePawn',
    lookupName: 'ANativePawn',
    access: 'public',
    isVirtual: false,
  }]);
  assert.strictEqual(managed[1].isFinal, true);

  const hierarchy = buildClassHierarchy([...native, ...managed]);
  const nativePawn = findNode(hierarchy, 'ANativePawn');
  const managedPawn = findNode(hierarchy, 'Game::Managed::ManagedPawn');
  const scriptPawn = findNode(hierarchy, 'Game::Managed::ScriptPawn');
  assert.ok(nativePawn.derivedIds.includes(managedPawn.id));
  assert.ok(managedPawn.derivedIds.includes(scriptPawn.id));
  assert.strictEqual(
    hierarchy.nodes.some((node) => node.qualifiedName === 'IDisposable'),
    false,
    'C# interface entries must not become class-hierarchy bases'
  );
}

function findNode(hierarchy: ReturnType<typeof buildClassHierarchy>, name: string) {
  const node = hierarchy.nodes.find((candidate) => candidate.qualifiedName === name);
  assert.ok(node, `expected hierarchy node ${name}`);
  return node;
}

function testHierarchyDagAndExternalNodes(): void {
  const source = [
    'class Base {};',
    'class Mixin {};',
    'class Derived : public Base, public ns::Mixin<int>, public Missing<T> {};',
    'class Leaf : public Derived {};',
  ].join('\n');
  const declarations = extractClassDeclarations(source, '/project/Tree.h');
  const hierarchy = buildClassHierarchy(declarations);
  const base = findNode(hierarchy, 'Base');
  const mixin = findNode(hierarchy, 'Mixin');
  const derived = findNode(hierarchy, 'Derived');
  const leaf = findNode(hierarchy, 'Leaf');
  const qualifiedMixin = findNode(hierarchy, 'ns::Mixin');
  const missing = findNode(hierarchy, 'Missing');

  assert.strictEqual(qualifiedMixin.external, true);
  assert.strictEqual(missing.external, true);
  assert.deepStrictEqual(derived.baseIds, [base.id, qualifiedMixin.id, missing.id]);
  assert.ok(base.derivedIds.includes(derived.id));
  assert.deepStrictEqual(mixin.derivedIds, []);
  assert.deepStrictEqual(derived.derivedIds, [leaf.id]);
  assert.strictEqual(derived.path, '/project/Tree.h');
  assert.strictEqual(derived.line, 3);
  assert.ok(hierarchy.roots.includes(base.id));
  assert.ok(hierarchy.roots.includes(missing.id));
  assert.deepStrictEqual(hierarchy.skippedCycleEdges, []);
}

function testRejectsElaboratedTypeUses(): void {
  const source = [
    'class RealType {};',
    'class RealType* GetRealType() { return nullptr; }',
    'void Use(class RealType value) { (void)value; }',
    'class Derived : public Other::RealType {};',
  ].join('\n');
  const declarations = extractClassDeclarations(source, '/project/FalsePositives.cpp');
  assert.deepStrictEqual(declarations.map((item) => item.name), ['RealType', 'Derived']);

  const hierarchy = buildClassHierarchy(declarations);
  const derived = findNode(hierarchy, 'Derived');
  const local = findNode(hierarchy, 'RealType');
  const external = findNode(hierarchy, 'Other::RealType');
  assert.strictEqual(external.external, true);
  assert.ok(external.derivedIds.includes(derived.id));
  assert.deepStrictEqual(local.derivedIds, []);
}

function testAmbiguityAndCyclesAreSafe(): void {
  const duplicateBase = (path: string, line: number): ClassDeclaration => ({
    id: `class:${path}:${line}:1:Base`,
    kind: 'class',
    name: 'Base',
    qualifiedName: 'Base',
    isFinal: false,
    bases: [],
    location: { path, line, column: 1, endLine: line, endColumn: 12 },
  });
  const ambiguousDerived: ClassDeclaration = {
    id: 'class:/Derived.h:1:1:Derived',
    kind: 'class',
    name: 'Derived',
    qualifiedName: 'Derived',
    isFinal: false,
    bases: [{ name: 'Base', lookupName: 'Base', access: 'public', isVirtual: false }],
    location: { path: '/Derived.h', line: 1, column: 1, endLine: 1, endColumn: 30 },
  };
  const ambiguous = buildClassHierarchy([
    duplicateBase('/One.h', 1),
    duplicateBase('/Two.h', 1),
    ambiguousDerived,
  ]);
  const externalBase = ambiguous.nodes.find((node) => node.external && node.name === 'Base');
  assert.ok(externalBase, 'ambiguous names should not be linked to an arbitrary declaration');

  const cycleDeclarations = extractClassDeclarations(
    ['class A : public B {};', 'class B : public A {};'].join('\n'),
    '/Cycle.h'
  );
  const cycle = buildClassHierarchy(cycleDeclarations);
  assert.strictEqual(cycle.skippedCycleEdges.length, 1);
  assert.ok(cycle.roots.length >= 1);

  // The retained graph is a DAG and can be traversed without recursive cycle guards.
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    assert.ok(!visiting.has(id), 'a retained inheritance edge formed a cycle');
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    const node = cycle.nodes.find((candidate) => candidate.id === id);
    assert.ok(node);
    node.derivedIds.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  cycle.roots.forEach(visit);
  assert.strictEqual(visited.size, cycle.nodes.length);
}

function testDiamondInheritanceRemainsADag(): void {
  const declarations = extractClassDeclarations([
    'class Root {};',
    'class Left : public Root {};',
    'class Right : public Root {};',
    'class Leaf : public Left, public Right {};',
  ].join('\n'), '/Diamond.h');
  const hierarchy = buildClassHierarchy(declarations);
  const left = findNode(hierarchy, 'Left');
  const right = findNode(hierarchy, 'Right');
  const leaf = findNode(hierarchy, 'Leaf');
  assert.deepStrictEqual(leaf.baseIds, [left.id, right.id]);
  assert.ok(left.derivedIds.includes(leaf.id));
  assert.ok(right.derivedIds.includes(leaf.id));
  assert.deepStrictEqual(hierarchy.skippedCycleEdges, []);
}

function testNamespaceScopesResolveLocalBases(): void {
  const declarations = extractClassDeclarations([
    'namespace One {',
    'class Base {};',
    'class Derived : public Base {};',
    '}',
    'namespace Two { class Base {}; }',
    'namespace Three::Nested {',
    'class Derived : public One::Base {};',
    '}',
  ].join('\n'), '/Namespaces.h');
  assert.deepStrictEqual(declarations.map((item) => item.qualifiedName), [
    'One::Base',
    'One::Derived',
    'Two::Base',
    'Three::Nested::Derived',
  ]);

  const hierarchy = buildClassHierarchy(declarations);
  const oneBase = findNode(hierarchy, 'One::Base');
  const oneDerived = findNode(hierarchy, 'One::Derived');
  const nestedDerived = findNode(hierarchy, 'Three::Nested::Derived');
  assert.ok(oneBase.derivedIds.includes(oneDerived.id));
  assert.ok(oneBase.derivedIds.includes(nestedDerived.id));
}

function testExplicitGlobalBaseSkipsLocalNamespaceCandidate(): void {
  const declarations = extractClassDeclarations([
    'class Base {};',
    'namespace Local {',
    'class Base {};',
    'class Derived : public ::Base {};',
    '}',
  ].join('\n'), '/GlobalBase.h');
  const hierarchy = buildClassHierarchy(declarations);
  const globalBase = findNode(hierarchy, 'Base');
  const localBase = findNode(hierarchy, 'Local::Base');
  const derived = findNode(hierarchy, 'Local::Derived');
  assert.ok(globalBase.derivedIds.includes(derived.id));
  assert.strictEqual(localBase.derivedIds.includes(derived.id), false);
}

function main(): void {
  testExtractionAndHitFiltering();
  testAnnotationsAndQualifiedDeclaration();
  testUnrealMetadataLinesCountAsDeclarationHits();
  testCSharpUnrealSharpClassesJoinNativeBases();
  testHierarchyDagAndExternalNodes();
  testRejectsElaboratedTypeUses();
  testAmbiguityAndCyclesAreSafe();
  testDiamondInheritanceRemainsADag();
  testNamespaceScopesResolveLocalBases();
  testExplicitGlobalBaseSkipsLocalNamespaceCandidate();
  console.log('classHierarchy tests passed');
}

main();
