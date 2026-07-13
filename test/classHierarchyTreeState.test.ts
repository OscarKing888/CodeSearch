import * as assert from 'assert';
import {
  ClassHierarchyTreeNode,
  collapseAllSubclasses,
  collectHierarchyDescendants,
  expandAllSubclasses,
  prioritizeHierarchyChildren,
  prioritizeHierarchyRoot,
  revealHierarchyPath,
} from '../src/ui/classHierarchyTreeState';

function node(id: string, children: string[] = []): ClassHierarchyTreeNode {
  return { id, children };
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
  prioritizeHierarchyChildren(
    ['early', 'selected', 'late'],
    ['root'],
    ['root', 'selected', 'leaf']
  ),
  ['selected', 'early', 'late'],
  'each selected-path child must render before its siblings'
);
assert.deepStrictEqual(
  prioritizeHierarchyChildren(['one', 'two'], ['other'], ['root', 'two']),
  ['one', 'two'],
  'unrelated occurrences keep their original order'
);

console.log('classHierarchyTreeState tests passed');
