/**
 * packages/layers — layer tree tests.
 *
 * The old monolith crashed with `RangeError: Maximum call stack size exceeded`
 * because it rendered the layer tree recursively with a shared `visited` set.
 * Every traversal here is iterative and depth-capped, and these tests assert
 * that directly.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_TREE_DEPTH,
  flattenTree,
  collectIds,
  buildParentIndex,
  findNode,
  findPath,
  descendantsOf,
  reparent,
  reorder,
  removeNode,
  insertNode,
  updateNode,
  setVisibility,
  setLocked,
  effectiveVisibility,
  cloneTree,
  auditTree,
} from './tree';
import type { ObjectNode } from '@3dmm/project';

function node(kind: ObjectNode['kind'], id: string, children: ObjectNode[] = []): ObjectNode {
  return {
    id,
    kind,
    name: id,
    visible: true,
    locked: false,
    position: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    anchor: { type: 'world' },
    data: {},
    children,
  };
}

/** A chain `depth` levels deep, ending in a leaf named `leaf`. */
function deepChain(depth: number): ObjectNode {
  let root = node('markers', 'leaf');
  for (let i = depth - 1; i >= 0; i--) root = node('group', `g${i}`, [root]);
  return root;
}

describe('flattenTree', () => {
  it('walks depth-first in document order', () => {
    const roots = [node('group', 'a', [node('markers', 'a1'), node('markers', 'a2')]), node('markers', 'b')];
    expect(flattenTree(roots).map((f) => f.node.id)).toEqual(['a', 'a1', 'a2', 'b']);
  });

  it('records parent and depth for every node', () => {
    const roots = [node('group', 'a', [node('group', 'b', [node('markers', 'c')])])];
    const flat = flattenTree(roots);
    expect(flat.map((f) => [f.node.id, f.parentId, f.depth])).toEqual([
      ['a', null, 0],
      ['b', 'a', 1],
      ['c', 'b', 2],
    ]);
  });

  it('survives a self-referencing node without hanging', () => {
    const a = node('group', 'a');
    a.children = [a];
    const flat = flattenTree([a]);
    expect(flat.length).toBeLessThanOrEqual(MAX_TREE_DEPTH + 1);
  });

  it('survives a cross-referencing cycle', () => {
    const a = node('group', 'a');
    const b = node('group', 'b');
    a.children = [b];
    b.children = [a];
    expect(() => flattenTree([a])).not.toThrow();
  });

  it('stops at the depth cap on a pathologically deep chain', () => {
    const flat = flattenTree([deepChain(500)]);
    expect(flat.length).toBeLessThanOrEqual(MAX_TREE_DEPTH + 1);
    expect(auditTree([deepChain(500)]).maxDepthExceeded).toBe(true);
  });

  it('flattens 20,000 nodes well inside a frame budget', () => {
    const kids = Array.from({ length: 20000 }, (_, i) => node('markers', `n${i}`));
    const t0 = performance.now();
    const flat = flattenTree([node('group', 'root', kids)]);
    const ms = performance.now() - t0;
    expect(flat.length).toBe(20001);
    expect(ms).toBeLessThan(500);
  });
});

describe('lookups', () => {
  const roots = [node('group', 'a', [node('group', 'b', [node('markers', 'c')])]), node('markers', 'd')];

  it('findNode finds nested nodes', () => {
    expect(findNode(roots, 'c')?.kind).toBe('markers');
    expect(findNode(roots, 'nope')).toBeNull();
  });

  it('findPath returns the full ancestor chain', () => {
    expect(findPath(roots, 'c')?.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(findPath(roots, 'd')?.map((n) => n.id)).toEqual(['d']);
    expect(findPath(roots, 'ghost')).toBeNull();
  });

  it('findPath returns null instead of overflowing on a cycle', () => {
    const a = node('group', 'a');
    a.children = [a];
    expect(findPath([a], 'missing')).toBeNull();
  });

  it('collectIds covers the whole tree', () => {
    expect([...collectIds(roots)].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('buildParentIndex maps children to parents', () => {
    const idx = buildParentIndex(roots);
    expect(idx.get('a')).toBeNull();
    expect(idx.get('b')).toBe('a');
    expect(idx.get('c')).toBe('b');
  });

  it('descendantsOf excludes the node itself', () => {
    expect([...descendantsOf(roots, 'a')].sort()).toEqual(['b', 'c']);
  });
});

describe('mutations', () => {
  it('reorder moves a sibling without dropping or duplicating it', () => {
    const roots = [node('group', 'g', [node('markers', 'a'), node('markers', 'b'), node('markers', 'c')])];
    const moved = reorder(roots, 'a', 2);
    expect(moved[0].children.map((c) => c.id)).toEqual(['b', 'c', 'a']);
    expect(moved[0].children.length).toBe(3);
  });

  it('removeNode removes the whole subtree', () => {
    const roots = [node('group', 'g', [node('group', 'h', [node('markers', 'x')])]), node('markers', 'keep')];
    expect(flattenTree(removeNode(roots, 'g')).map((f) => f.node.id)).toEqual(['keep']);
  });

  it('insertNode honours the requested index', () => {
    const roots = [node('markers', 'a'), node('markers', 'c')];
    expect(insertNode(roots, node('markers', 'b'), null, 1).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('reparent moves a subtree', () => {
    const roots = [node('group', 'a'), node('group', 'b', [node('markers', 'm')])];
    const moved = reparent(roots, 'm', 'a', 0);
    expect(findNode(moved, 'a')?.children.map((c) => c.id)).toEqual(['m']);
    expect(findNode(moved, 'b')?.children).toEqual([]);
  });

  it('reparent refuses to create a cycle', () => {
    const roots = [node('group', 'parent', [node('markers', 'child')])];
    let threw = false;
    let result = roots;
    try {
      result = reparent(roots, 'parent', 'child', 0);
    } catch {
      threw = true;
    }
    // Either it throws, or it leaves the parent at the root — never nested
    // under its own descendant.
    if (!threw) expect(findPath(result, 'parent')?.map((n) => n.id)).toEqual(['parent']);
    else expect(threw).toBe(true);
  });

  it('updateNode patches only the requested fields', () => {
    const roots = [node('markers', 'm')];
    const updated = updateNode(roots, 'm', (n) => ({ ...n, name: 'renamed' }));
    expect(updated[0].name).toBe('renamed');
    expect(updated[0].kind).toBe('markers');
  });

  it('preserves id and children through a patch that tries to change them', () => {
    const roots = [node('group', 'g', [node('markers', 'child')])];
    const updated = updateNode(roots, 'g', (n) => ({ ...n, id: 'hijacked', children: [] }));
    expect(updated[0].id).toBe('g');
    expect(updated[0].children.map((c) => c.id)).toEqual(['child']);
  });

  it('refuses to patch a locked node', () => {
    const roots = [node('markers', 'm')];
    const locked = setLocked(roots, 'm', true);
    expect(() => updateNode(locked, 'm', (n) => ({ ...n, name: 'x' }))).toThrow();
  });

  it('throws a typed error for an unknown id', () => {
    expect(() => updateNode([node('markers', 'm')], 'ghost', (n) => n)).toThrow(/not_found|ghost/i);
  });

  it('does not mutate the input tree', () => {
    const roots = [node('group', 'a', [node('markers', 'm')])];
    updateNode(roots, 'm', (n) => ({ ...n, name: 'x' }));
    reorder(roots, 'm', 0);
    expect(roots[0].children[0].name).toBe('m');
  });
});

describe('visibility and locking', () => {
  it('setVisibility reaches nested nodes', () => {
    const roots = [node('group', 'a', [node('markers', 'm')])];
    const updated = setVisibility(roots, 'm', false);
    expect(findNode(updated, 'm')?.visible).toBe(false);
  });

  it('setLocked reaches nested nodes', () => {
    const roots = [node('group', 'a', [node('markers', 'm')])];
    expect(findNode(setLocked(roots, 'm', true), 'm')?.locked).toBe(true);
  });

  it('effectiveVisibility hides children of a hidden group', () => {
    const roots = [node('group', 'a', [node('group', 'b', [node('markers', 'c')])])];
    const hidden = setVisibility(roots, 'a', false);
    const eff = effectiveVisibility(hidden);
    expect(eff.get('a')).toBe(false);
    expect(eff.get('b')).toBe(false);
    expect(eff.get('c')).toBe(false);
  });

  it('effectiveVisibility keeps children of a visible group visible', () => {
    const roots = [node('group', 'a', [node('markers', 'c')])];
    expect(effectiveVisibility(roots).get('c')).toBe(true);
  });
});

describe('auditTree', () => {
  it('reports a clean tree as clean', () => {
    const a = auditTree([node('group', 'a', [node('markers', 'b')])]);
    expect(a.duplicateIds).toEqual([]);
    expect(a.maxDepthExceeded).toBe(false);
    expect(a.nodeCount).toBe(2);
    expect(a.maxDepth).toBe(1);
  });

  it('detects duplicate ids', () => {
    expect(auditTree([node('group', 'dup'), node('markers', 'dup')]).duplicateIds).toEqual(['dup']);
  });

  it('detects a chain that exceeds the depth cap', () => {
    expect(auditTree([deepChain(500)]).maxDepthExceeded).toBe(true);
  });
});

describe('cloneTree', () => {
  it('produces an independent deep copy', () => {
    const roots = [node('group', 'a', [node('markers', 'm')])];
    const copy = cloneTree(roots);
    copy[0].children[0].name = 'changed';
    expect(roots[0].children[0].name).toBe('m');
    expect(copy[0].children[0].name).toBe('changed');
  });

  it('preserves data payloads', () => {
    const n = node('objects', 'o');
    n.data = { size: 5, tags: ['a', 'b'] };
    const copy = cloneTree([n]);
    expect(copy[0].data).toEqual({ size: 5, tags: ['a', 'b'] });
    expect(copy[0].data).not.toBe(n.data);
  });
});
