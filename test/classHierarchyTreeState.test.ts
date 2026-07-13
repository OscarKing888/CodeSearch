import * as assert from 'assert';
import {
  ClassHierarchyTreeNode,
  NamedClassHierarchyTreeNode,
  collapseAllSubclasses,
  collectHierarchyDescendants,
  collectHierarchyFilterMatches,
  expandAllSubclasses,
  prioritizeHierarchyChild,
  prioritizeHierarchyRoot,
  revealHierarchyPath,
} from '../src/ui/classHierarchyTreeState';

function node(id: string, children: string[] = []): ClassHierarchyTreeNode {
  return { id, children };
}

function namedNode(
  id: string,
  name: string,
  children: string[] = []
): NamedClassHierarchyTreeNode {
  return { id, name, children };
}

const nodes = new Map<string, ClassHierarchyTreeNode>([
  ['root', node('root', ['left', 'right'])],
  ['left', node('left', ['shared'])],
  ['right', node('right', ['shared'])],
  ['shared', node('shared', ['leaf', 'root'])],
  ['leaf', node('leaf')],
]);

assert.deepStrictEqual(
  [...collectHierarchyDescendants(nodes, 'root')].sort(),
  ['leaf', 'left', 'right', 'shared'],
  'descendant traversal must deduplicate a DAG and stop at a cycle'
);

const expanded = new Set(['root', 'left', 'right', 'shared', 'unrelated']);
expandAllSubclasses(expanded, nodes, 'root');
assert.deepStrictEqual([...expanded], ['unrelated']);

const collapsed = new Set(['root', 'leaf', 'unrelated']);
collapseAllSubclasses(collapsed, nodes, 'root');
assert.strictEqual(collapsed.has('root'), false, 'the selected class stays expanded');
assert.strictEqual(collapsed.has('left'), true);
assert.strictEqual(collapsed.has('right'), true);
assert.strictEqual(collapsed.has('shared'), true);
assert.strictEqual(collapsed.has('leaf'), false, 'leaf state is not retained as collapsed');
assert.strictEqual(collapsed.has('unrelated'), true);

const pathState = new Set(['root', 'left', 'shared', 'leaf']);
revealHierarchyPath(pathState, ['root', 'left', 'shared', 'leaf']);
assert.deepStrictEqual([...pathState], ['leaf'], 'only ancestors should be expanded');

assert.deepStrictEqual(
  prioritizeHierarchyRoot(['one', 'two', 'three'], ['three', 'child']),
  ['three', 'one', 'two']
);
assert.deepStrictEqual(prioritizeHierarchyRoot(['one', 'two'], undefined), ['one', 'two']);
assert.deepStrictEqual(
  prioritizeHierarchyChild(['early', 'selected', 'late'], 'selected'),
  ['selected', 'early', 'late']
);
assert.deepStrictEqual(
  prioritizeHierarchyChild(['one', 'two'], undefined),
  ['one', 'two']
);
const filterNodes = new Map<string, NamedClassHierarchyTreeNode>([
  ['root', namedNode('root', 'Root', ['left', 'right'])],
  ['left', namedNode('left', 'Left', ['shared'])],
  ['right', namedNode('right', 'Right', ['shared'])],
  ['shared', namedNode('shared', 'SharedTarget', ['cycle'])],
  ['cycle', namedNode('cycle', 'Cycle', ['left'])],
  ['unrelated', namedNode('unrelated', 'Unrelated')],
]);
assert.deepStrictEqual(
  [...collectHierarchyFilterMatches(filterNodes, 'target')].sort(),
  ['cycle', 'left', 'right', 'root', 'shared'],
  'filtering must retain every ancestor in a DAG and terminate when the graph cycles'
);
assert.deepStrictEqual(
  [...collectHierarchyFilterMatches(filterNodes, 'missing')],
  [],
  'a cyclic graph with no direct match must return an empty set'
);

const deepNodeCount = 20_001;
const deepNodes = new Map<string, NamedClassHierarchyTreeNode>();
for (let index = 0; index < deepNodeCount; index++) {
  const id = `deep-${index}`;
  const children = index + 1 < deepNodeCount ? [`deep-${index + 1}`] : [];
  deepNodes.set(id, namedNode(id, index + 1 === deepNodeCount ? 'Needle' : `Node${index}`, children));
}
const deepMatches = collectHierarchyFilterMatches(deepNodes, 'needle');
assert.strictEqual(deepMatches.size, deepNodeCount);
assert.strictEqual(deepMatches.has('deep-0'), true);
assert.strictEqual(deepMatches.has(`deep-${deepNodeCount - 1}`), true);

const wideChildCount = 130_000;
const wideChildren = Array.from({ length: wideChildCount }, (_, index) => `wide-${index}`);
const wideNodes = new Map<string, ClassHierarchyTreeNode>([
  ['root', node('root', ['hub'])],
  ['hub', node('hub', wideChildren)],
]);
assert.strictEqual(
  collectHierarchyDescendants(wideNodes, 'root').size,
  wideChildCount + 1,
  'wide child lists must not be expanded as function arguments'
);

console.log('classHierarchyTreeState tests passed');
