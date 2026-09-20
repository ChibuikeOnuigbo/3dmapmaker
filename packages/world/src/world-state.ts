/**
 * packages/world — world document state helpers.
 *
 * Selection, isolation, and the world/anchor bookkeeping that several
 * subsystems need but that does not belong in the schema package.
 */
import type { ObjectNode, Vec3T } from '@3dmm/project';
import { flattenTree, findNode, effectiveVisibility } from '@3dmm/layers';

export interface SelectionState {
  ids: string[];
  /** Id of the object the pointer is hovering. */
  hoverId: string | null;
  mode: 'replace' | 'add' | 'toggle';
}

export const emptySelection = (): SelectionState => ({ ids: [], hoverId: null, mode: 'replace' });

export function select(state: SelectionState, ids: string[], mode: SelectionState['mode'] = 'replace'): SelectionState {
  if (mode === 'replace') return { ids: [...new Set(ids)], hoverId: state.hoverId, mode };
  if (mode === 'add') return { ids: [...new Set([...state.ids, ...ids])], hoverId: state.hoverId, mode };
  const set = new Set(state.ids);
  for (const id of ids) {
    if (set.has(id)) set.delete(id);
    else set.add(id);
  }
  return { ids: [...set], hoverId: state.hoverId, mode };
}

/**
 * Resolve the set of *renderable* node ids: visible, not inside a hidden
 * ancestor, and inside the isolate set when isolation is active.
 */
export function resolveRenderable(
  layers: ReadonlyArray<ObjectNode>,
  isolated: ReadonlyArray<string> | null,
): Set<string> {
  const visibility = effectiveVisibility(layers);
  const iso = isolated && isolated.length ? new Set(isolated) : null;
  const out = new Set<string>();
  for (const f of flattenTree(layers)) {
    if (!visibility.get(f.node.id)) continue;
    if (iso && !iso.has(f.node.id) && !hasDescendantIn(iso, layers, f.node.id)) continue;
    out.add(f.node.id);
  }
  return out;
}

function hasDescendantIn(iso: Set<string>, layers: ReadonlyArray<ObjectNode>, id: string): boolean {
  const node = findNode(layers, id);
  if (!node) return false;
  const stack = [...node.children];
  while (stack.length) {
    const n = stack.pop()!;
    if (iso.has(n.id)) return true;
    for (const c of n.children) stack.push(c);
  }
  return false;
}

/**
 * World anchor of a node, resolved through its anchor chain. Iterative so a
 * malformed parent reference cannot recurse forever.
 */
export function resolveAnchorPosition(
  layers: ReadonlyArray<ObjectNode>,
  id: string,
  terrainHeightAt: (x: number, z: number) => number | null,
  cameraPosition: Vec3T,
  maxDepth = 64,
): Vec3T {
  const node = findNode(layers, id);
  if (!node) return { x: 0, y: 0, z: 0 };
  const anchor = node.anchor;
  switch (anchor.type) {
    case 'world':
      return { ...node.position };
    case 'terrain': {
      const h = terrainHeightAt(node.position.x, node.position.z);
      return { x: node.position.x, y: (h ?? 0) + anchor.offset, z: node.position.z };
    }
    case 'camera':
      return {
        x: cameraPosition.x + anchor.offset.x,
        y: cameraPosition.y + anchor.offset.y,
        z: cameraPosition.z + anchor.offset.z,
      };
    case 'parent': {
      let cur = findNode(layers, anchor.parentId);
      let acc = { ...node.position };
      let depth = 0;
      const seen = new Set<string>([id]);
      while (cur && depth++ < maxDepth) {
        if (seen.has(cur.id)) break; // cycle guard
        seen.add(cur.id);
        acc = { x: acc.x + cur.position.x, y: acc.y + cur.position.y, z: acc.z + cur.position.z };
        if (cur.anchor.type === 'parent') {
          cur = findNode(layers, cur.anchor.parentId);
        } else {
          break;
        }
      }
      return acc;
    }
  }
}

/** Bounding box of a set of nodes, in local metres (for framing the camera). */
export function selectionBounds(
  layers: ReadonlyArray<ObjectNode>,
  ids: ReadonlyArray<string>,
): { min: Vec3T; max: Vec3T; center: Vec3T; size: Vec3T } | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let found = false;
  for (const id of ids) {
    const n = findNode(layers, id);
    if (!n) continue;
    found = true;
    const sx = Math.max(0.1, n.scale.x);
    const sy = Math.max(0.1, n.scale.y);
    const sz = Math.max(0.1, n.scale.z);
    minX = Math.min(minX, n.position.x - sx);
    minY = Math.min(minY, n.position.y - sy);
    minZ = Math.min(minZ, n.position.z - sz);
    maxX = Math.max(maxX, n.position.x + sx);
    maxY = Math.max(maxY, n.position.y + sy);
    maxZ = Math.max(maxZ, n.position.z + sz);
  }
  if (!found) return null;
  const min = { x: minX, y: minY, z: minZ };
  const max = { x: maxX, y: maxY, z: maxZ };
  return {
    min,
    max,
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
    size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
  };
}

/**
 * Road / path graph derived from authored roads (REQUIREMENT 097, 098).
 * Nodes are path endpoints that are close together; edges are the road segments.
 */
export interface RoadGraphNode {
  id: string;
  x: number;
  z: number;
  edges: Array<{ to: string; length: number }>;
}

export function buildRoadGraph(
  roads: Array<{ id: string; points: Array<{ x: number; y: number }> }>,
  snapDistance = 6,
): Map<string, RoadGraphNode> {
  const nodes = new Map<string, RoadGraphNode>();
  const findNear = (x: number, z: number): RoadGraphNode | null => {
    for (const n of nodes.values()) {
      if (Math.hypot(n.x - x, n.z - z) <= snapDistance) return n;
    }
    return null;
  };
  let counter = 0;
  for (const road of roads) {
    const pts = road.points;
    if (pts.length < 2) continue;
    const start = findNear(pts[0].x, pts[0].y) ?? {
      id: `rg_${counter++}`,
      x: pts[0].x,
      z: pts[0].y,
      edges: [],
    };
    nodes.set(start.id, start);
    const end = findNear(pts[pts.length - 1].x, pts[pts.length - 1].y) ?? {
      id: `rg_${counter++}`,
      x: pts[pts.length - 1].x,
      z: pts[pts.length - 1].y,
      edges: [],
    };
    nodes.set(end.id, end);
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    start.edges.push({ to: end.id, length });
    end.edges.push({ to: start.id, length });
  }
  return nodes;
}

/** Dijkstra over the road graph (REQUIREMENT 098). Bounded by `maxVisited`. */
export function routeOnRoadGraph(
  graph: Map<string, RoadGraphNode>,
  fromId: string,
  toId: string,
  maxVisited = 20000,
): { path: string[]; length: number } | null {
  if (!graph.has(fromId) || !graph.has(toId)) return null;
  const dist = new Map<string, number>([[fromId, 0]]);
  const prev = new Map<string, string>();
  const visited = new Set<string>();
  let iterations = 0;

  while (visited.size < graph.size && iterations++ < maxVisited) {
    let current: string | null = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (!visited.has(id) && d < best) {
        best = d;
        current = id;
      }
    }
    if (current === null) break;
    if (current === toId) break;
    visited.add(current);
    const node = graph.get(current)!;
    for (const e of node.edges) {
      if (visited.has(e.to)) continue;
      const nd = best + e.length;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, current);
      }
    }
  }

  if (!visited.has(toId) && fromId !== toId) return null;
  const path: string[] = [toId];
  let cur = toId;
  let guard = 0;
  while (cur !== fromId && guard++ < maxVisited) {
    const p = prev.get(cur);
    if (!p) return null;
    path.unshift(p);
    cur = p;
  }
  return { path, length: dist.get(toId) ?? 0 };
}

/**
 * Walkability mask from terrain slope plus wall proximity (REQUIREMENT 099).
 * Returns a boolean grid the character controller and navmesh builder share.
 */
export function buildWalkableMask(opts: {
  width: number;
  height: number;
  cellSize: number;
  originX: number;
  originY: number;
  heightAt: (x: number, y: number) => number | null;
  slopeLimitDeg: number;
  isWall?: (x: number, y: number) => boolean;
}): { mask: Uint8Array; walkableFraction: number } {
  const { width, height, cellSize, originX, originY } = opts;
  const mask = new Uint8Array(width * height);
  let walkable = 0;
  for (let gy = 0; gy < height; gy++) {
    for (let gx = 0; gx < width; gx++) {
      const x = originX + (gx + 0.5) * cellSize;
      const y = originY + (gy + 0.5) * cellSize;
      const h = opts.heightAt(x, y);
      if (h === null) continue;
      if (opts.isWall?.(x, y)) continue;
      const hx = opts.heightAt(x + cellSize, y);
      const hy = opts.heightAt(x, y + cellSize);
      if (hx === null || hy === null) continue;
      const slopeX = (Math.atan2(Math.abs(hx - h), cellSize) * 180) / Math.PI;
      const slopeY = (Math.atan2(Math.abs(hy - h), cellSize) * 180) / Math.PI;
      if (Math.max(slopeX, slopeY) > opts.slopeLimitDeg) continue;
      mask[gy * width + gx] = 1;
      walkable++;
    }
  }
  return { mask, walkableFraction: walkable / Math.max(1, width * height) };
}
