/**
 * packages/layers — layer tree operations (REQUIREMENT 066, 067).
 *
 * The old repository crashed with `Maximum call stack size exceeded` inside
 * `renderTreeNode` because it recursed over a `links` graph with a `visited`
 * set that was shared between roots and never validated on write. Here:
 *
 *  - every mutation validates cycles / self-parenting / duplicate ids BEFORE
 *    it is applied, so an invalid tree can never enter state;
 *  - every traversal is an explicit stack or a bounded-depth walk, so a hostile
 *    document cannot blow the JS stack;
 *  - flattening for rendering is done once, with a hard depth cap.
 */
import type { ObjectNode } from '@3dmm/project';

export const MAX_TREE_DEPTH = 64;

export type LayerTreeError =
  | { code: 'not_found'; id: string }
  | { code: 'self_parent'; id: string }
  | { code: 'cycle'; path: string[] }
  | { code: 'duplicate_id'; id: string }
  | { code: 'too_deep'; depth: number }
  | { code: 'locked'; id: string };

export class LayerTreeMutationError extends Error {
  constructor(readonly issue: LayerTreeError) {
    super(`Layer tree mutation rejected: ${issue.code}`);
    this.name = 'LayerTreeMutationError';
  }
}

/* ------------------------------------------------------------ traversal --- */

export interface FlatNode {
  node: ObjectNode;
  parentId: string | null;
  depth: number;
  index: number;
}

/**
 * Depth-first flatten with an explicit stack. Returns nodes in display order
 * (parent, then children in order) and never recurses.
 */
export function flattenTree(roots: ReadonlyArray<ObjectNode>, maxNodes = 200000): FlatNode[] {
  const out: FlatNode[] = [];
  // Push children in reverse so the first child pops first.
  const stack: Array<{ node: ObjectNode; parentId: string | null; depth: number }> = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], parentId: null, depth: 0 });

  while (stack.length > 0) {
    const { node, parentId, depth } = stack.pop()!;
    out.push({ node, parentId, depth, index: out.length });
    if (out.length >= maxNodes) break;
    if (depth >= MAX_TREE_DEPTH) continue; // hard cap, see HARDENING CHECK 006
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i], parentId: node.id, depth: depth + 1 });
    }
  }
  return out;
}

export function collectIds(roots: ReadonlyArray<ObjectNode>): Set<string> {
  const ids = new Set<string>();
  for (const f of flattenTree(roots)) ids.add(f.node.id);
  return ids;
}

/** Build a childId -> parentId index in one pass. */
export function buildParentIndex(roots: ReadonlyArray<ObjectNode>): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const f of flattenTree(roots)) map.set(f.node.id, f.parentId);
  return map;
}

export function findNode(roots: ReadonlyArray<ObjectNode>, id: string): ObjectNode | null {
  const stack: ObjectNode[] = [...roots];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return null;
}

export function findPath(roots: ReadonlyArray<ObjectNode>, id: string): ObjectNode[] | null {
  // Iterative walk with a hard depth cap: a cyclic or pathologically deep tree
  // returns null instead of overflowing the stack (HARDENING CHECK 006).
  const stack: Array<{ nodes: ReadonlyArray<ObjectNode>; i: number }> = [{ nodes: roots, i: 0 }];
  const trail: ObjectNode[] = [];
  while (stack.length) {
    if (stack.length > MAX_TREE_DEPTH) return null;
    const frame = stack[stack.length - 1];
    if (frame.i >= frame.nodes.length) {
      stack.pop();
      trail.pop();
      continue;
    }
    const node = frame.nodes[frame.i++];
    trail.push(node);
    if (node.id === id) return [...trail];
    stack.push({ nodes: node.children, i: 0 });
  }
  return null;
}

export function descendantsOf(roots: ReadonlyArray<ObjectNode>, id: string): Set<string> {
  const root = findNode(roots, id);
  if (!root) return new Set();
  const ids = new Set<string>();
  const stack: ObjectNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    ids.add(n.id);
    for (const c of n.children) stack.push(c);
  }
  ids.delete(id);
  return ids;
}

/* ------------------------------------------------------------- mutations --- */

/**
 * Returns a new tree with `nodeId` re-parented under `newParentId`
 * (`null` = move to root) at `index`. Throws LayerTreeMutationError on any
 * invalid request instead of corrupting the tree.
 */
export function reparent(
  roots: ReadonlyArray<ObjectNode>,
  nodeId: string,
  newParentId: string | null,
  index = -1,
): ObjectNode[] {
  if (nodeId === newParentId) throw new LayerTreeMutationError({ code: 'self_parent', id: nodeId });

  const next = cloneTree(roots);
  const moved = detach(next, nodeId);
  if (!moved) throw new LayerTreeMutationError({ code: 'not_found', id: nodeId });

  if (newParentId === null) {
    const at = index < 0 ? next.length : Math.min(index, next.length);
    next.splice(at, 0, moved);
    return next;
  }

  const parent = findNode(next, newParentId);
  if (!parent) throw new LayerTreeMutationError({ code: 'not_found', id: newParentId });

  // Moving under one of our own descendants would create a cycle.
  const movedIds = new Set<string>([moved.id]);
  for (const d of descendantsOf([moved], moved.id)) movedIds.add(d);
  if (movedIds.has(newParentId)) {
    throw new LayerTreeMutationError({ code: 'cycle', path: [...movedIds] });
  }

  const depth = depthOf(next, newParentId) ?? 0;
  if (depth + 1 + subtreeDepth(moved) > MAX_TREE_DEPTH) {
    throw new LayerTreeMutationError({ code: 'too_deep', depth: depth + 1 + subtreeDepth(moved) });
  }
  const at = index < 0 ? parent.children.length : Math.min(index, parent.children.length);
  parent.children.splice(at, 0, moved);
  return next;
}

/** Reorder within the same parent. */
export function reorder(roots: ReadonlyArray<ObjectNode>, nodeId: string, toIndex: number): ObjectNode[] {
  const next = cloneTree(roots);
  const parentIndex = buildParentIndex(next);
  const parentId = parentIndex.get(nodeId);
  if (parentId === undefined) throw new LayerTreeMutationError({ code: 'not_found', id: nodeId });
  const siblings = parentId === null ? next : findNode(next, parentId)!.children;
  const from = siblings.findIndex((n) => n.id === nodeId);
  if (from < 0) throw new LayerTreeMutationError({ code: 'not_found', id: nodeId });
  const [item] = siblings.splice(from, 1);
  const at = Math.max(0, Math.min(toIndex, siblings.length));
  siblings.splice(at, 0, item);
  return next;
}

export function removeNode(roots: ReadonlyArray<ObjectNode>, id: string): ObjectNode[] {
  const next = cloneTree(roots);
  if (!detach(next, id)) throw new LayerTreeMutationError({ code: 'not_found', id });
  return next;
}

export function insertNode(
  roots: ReadonlyArray<ObjectNode>,
  node: ObjectNode,
  parentId: string | null = null,
  index = -1,
): ObjectNode[] {
  const next = cloneTree(roots);
  if (collectIds(next).has(node.id)) throw new LayerTreeMutationError({ code: 'duplicate_id', id: node.id });
  if (parentId === null) {
    const at = index < 0 ? next.length : Math.min(index, next.length);
    next.splice(at, 0, node);
    return next;
  }
  const parent = findNode(next, parentId);
  if (!parent) throw new LayerTreeMutationError({ code: 'not_found', id: parentId });
  if (parent.locked) throw new LayerTreeMutationError({ code: 'locked', id: parentId });
  const at = index < 0 ? parent.children.length : Math.min(index, parent.children.length);
  parent.children.splice(at, 0, node);
  return next;
}

export function updateNode(
  roots: ReadonlyArray<ObjectNode>,
  id: string,
  patch: (node: ObjectNode) => ObjectNode,
): ObjectNode[] {
  const next = cloneTree(roots);
  const node = findNode(next, id);
  if (!node) throw new LayerTreeMutationError({ code: 'not_found', id });
  if (node.locked) throw new LayerTreeMutationError({ code: 'locked', id });
  const updated = patch(node);
  Object.assign(node, updated, { id: node.id, children: node.children });
  return next;
}

export function setVisibility(roots: ReadonlyArray<ObjectNode>, id: string, visible: boolean): ObjectNode[] {
  return updateNode(roots, id, (n) => ({ ...n, visible }));
}

export function setLocked(roots: ReadonlyArray<ObjectNode>, id: string, locked: boolean): ObjectNode[] {
  const next = cloneTree(roots);
  const node = findNode(next, id);
  if (!node) throw new LayerTreeMutationError({ code: 'not_found', id });
  node.locked = locked;
  return next;
}

/** Effective visibility: a node is hidden if it or any ancestor is hidden. */
export function effectiveVisibility(roots: ReadonlyArray<ObjectNode>): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const stack: Array<{ node: ObjectNode; parentVisible: boolean }> = roots.map((n) => ({ node: n, parentVisible: true }));
  while (stack.length) {
    const { node, parentVisible } = stack.pop()!;
    const vis = parentVisible && node.visible;
    out.set(node.id, vis);
    for (const c of node.children) stack.push({ node: c, parentVisible: vis });
  }
  return out;
}

/* --------------------------------------------------------------- helpers --- */

export function cloneTree(roots: ReadonlyArray<ObjectNode>): ObjectNode[] {
  return roots.map(cloneNode);
}

function cloneNode(n: ObjectNode): ObjectNode {
  return {
    ...n,
    position: { ...n.position },
    rotationDeg: { ...n.rotationDeg },
    scale: { ...n.scale },
    anchor: JSON.parse(JSON.stringify(n.anchor)) as ObjectNode['anchor'],
    data: { ...n.data },
    children: n.children.map(cloneNode),
  };
}

function detach(nodes: ObjectNode[], id: string): ObjectNode | null {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return nodes.splice(i, 1)[0];
  }
  for (const n of nodes) {
    const found = detach(n.children, id);
    if (found) return found;
  }
  return null;
}

function depthOf(roots: ReadonlyArray<ObjectNode>, id: string): number | null {
  const path = findPath(roots, id);
  return path ? path.length - 1 : null;
}

function subtreeDepth(node: ObjectNode): number {
  let max = 0;
  const stack: Array<{ n: ObjectNode; d: number }> = [{ n: node, d: 0 }];
  while (stack.length) {
    const { n, d } = stack.pop()!;
    if (d > max) max = d;
    for (const c of n.children) stack.push({ n: c, d: d + 1 });
  }
  return max;
}

/** Full structural audit used by HARDENING CHECK 006. */
export function auditTree(roots: ReadonlyArray<ObjectNode>): {
  nodeCount: number;
  maxDepth: number;
  duplicateIds: string[];
  maxDepthExceeded: boolean;
} {
  const flat = flattenTree(roots);
  const seen = new Map<string, number>();
  let maxDepth = 0;
  for (const f of flat) {
    seen.set(f.node.id, (seen.get(f.node.id) ?? 0) + 1);
    if (f.depth > maxDepth) maxDepth = f.depth;
  }
  return {
    nodeCount: flat.length,
    maxDepth,
    duplicateIds: [...seen.entries()].filter(([, c]) => c > 1).map(([id]) => id),
    maxDepthExceeded: maxDepth >= MAX_TREE_DEPTH,
  };
}
