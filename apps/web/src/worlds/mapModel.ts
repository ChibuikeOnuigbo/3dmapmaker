/**
 * apps/web — the 2D map model (spec §6, §38).
 *
 * Pure math, no React: given a WorldGraph and the current view state it
 * produces the exact geometry the SVG map draws. Keeping it separate means the
 * coordinate conversion, node-state resolution and viewport culling are all
 * unit-testable, and the map can never disagree with the graph because it
 * derives everything from it.
 *
 * Coordinate convention:
 *   grid  +x = east, +y = north
 *   svg   +x = right, +y = DOWN
 * so screenY flips: screenY = (height - 1 - gridY) * cell.
 */
import type { WorldGraph, WorldNode } from '@3dmm/panorama';
import type { CellKind } from './generate';

export type NodeView = 'unseen' | 'visible' | 'visited' | 'current' | 'destination' | 'loading' | 'error';

export interface WorldMapState {
  currentId: string | null;
  destinationId: string | null;
  visited: ReadonlySet<string>;
  loading: ReadonlySet<string>;
  errored: ReadonlySet<string>;
  /** Ids on the highlighted route, in order. */
  route: string[];
  selectedId: string | null;
  /** How many king moves away a node can be and still count as "visible". */
  visibleRadius: number;
}

export const EMPTY_MAP_STATE: WorldMapState = {
  currentId: null,
  destinationId: null,
  visited: new Set(),
  loading: new Set(),
  errored: new Set(),
  route: [],
  selectedId: null,
  visibleRadius: 2,
};

/**
 * Resolve one node's visual state. Precedence is deliberate (spec §38): the
 * current position beats everything, then errors, then loading, then the
 * destination, then visited, then merely visible.
 */
export function resolveNodeState(id: string, state: WorldMapState): NodeView {
  if (state.currentId === id) return 'current';
  if (state.errored.has(id)) return 'error';
  if (state.loading.has(id)) return 'loading';
  if (state.destinationId === id) return 'destination';
  if (state.visited.has(id)) return 'visited';
  return 'unseen';
}

export interface MapNode {
  id: string;
  number: number;
  gridX: number;
  gridY: number;
  cx: number;
  cy: number;
  view: NodeView;
  /** True when the node is on the highlighted route. */
  onRoute: boolean;
  /** Position along the route, or -1. */
  routeIndex: number;
  landmarkName: string | null;
}

export interface MapEdge {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  walkable: boolean;
  onRoute: boolean;
}

export interface MapModel {
  nodes: MapNode[];
  edges: MapEdge[];
  /** Route drawn as a polyline, in screen space. */
  routePath: string | null;
  width: number;
  height: number;
  cell: number;
  pad: number;
  viewBox: string;
  /** Nodes skipped by viewport culling — reported, not silently dropped. */
  culled: number;
  totalNodes: number;
}

export interface BuildMapOptions {
  graph: WorldGraph;
  state: WorldMapState;
  kinds: CellKind[];
  cell: number;
  pad: number;
  /** Screen-space viewport in SVG units; null renders the whole board. */
  viewport?: { x: number; y: number; w: number; h: number; margin: number } | null;
}

/** Grid → screen. */
export function gridToScreen(gridX: number, gridY: number, height: number, cell: number, pad: number): { cx: number; cy: number } {
  return { cx: pad + gridX * cell, cy: pad + (height - 1 - gridY) * cell };
}

/** Screen → grid (the inverse, used for click hit-testing). */
export function screenToGrid(cx: number, cy: number, height: number, cell: number, pad: number): { x: number; y: number } {
  return { x: Math.round((cx - pad) / cell), y: height - 1 - Math.round((cy - pad) / cell) };
}

/**
 * Build the render model.
 *
 * On a 1,024-node board this culls to the viewport plus a margin, so the DOM
 * holds a few hundred elements rather than a thousand (spec §40).
 */
export function buildMapModel(opts: BuildMapOptions): MapModel {
  const { graph, state, cell, pad } = opts;
  const width = graph.width;
  const height = graph.height;
  const boardW = pad * 2 + (width - 1) * cell;
  const boardH = pad * 2 + (height - 1) * cell;

  const vp = opts.viewport;
  const routeSet = new Set(state.route);
  const routeIndex = new Map<string, number>();
  state.route.forEach((id, i) => routeIndex.set(id, i));

  // Pre-compute the visible set once instead of per node.
  const current = state.currentId ? graph.get(state.currentId) : null;
  const visibleSet = new Set<string>();
  if (current && state.visibleRadius > 0) {
    for (const n of graph.nearby(current.gridX, current.gridY, state.visibleRadius)) visibleSet.add(n.id);
  }

  const nodes: MapNode[] = [];
  let culled = 0;

  for (const n of graph.all()) {
    const { cx, cy } = gridToScreen(n.gridX, n.gridY, height, cell, pad);
    if (vp) {
      const inside =
        cx >= vp.x - vp.margin && cx <= vp.x + vp.w + vp.margin && cy >= vp.y - vp.margin && cy <= vp.y + vp.h + vp.margin;
      if (!inside) {
        culled++;
        continue;
      }
    }
    const base = resolveNodeState(n.id, state);
    const view: NodeView = base === 'unseen' && visibleSet.has(n.id) ? 'visible' : base;
    const landmark = graph.landmarks.find((l) => l.gridX === n.gridX && l.gridY === n.gridY);
    nodes.push({
      id: n.id,
      number: n.number,
      gridX: n.gridX,
      gridY: n.gridY,
      cx,
      cy,
      view,
      onRoute: routeSet.has(n.id),
      routeIndex: routeIndex.get(n.id) ?? -1,
      landmarkName: landmark?.name ?? null,
    });
  }

  // Edges: draw each undirected edge once, from the lower id to the higher.
  const edges: MapEdge[] = [];
  const seenEdge = new Set<string>();
  for (const from of graph.all()) {
    if (vp && !nodes.some((n) => n.id === from.id)) continue;
    const a = gridToScreen(from.gridX, from.gridY, height, cell, pad);
    for (const { edge, node: to } of graph.neighborsOf(from.id)) {
      const key = from.id < to.id ? `${from.id}|${to.id}` : `${to.id}|${from.id}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      const b = gridToScreen(to.gridX, to.gridY, height, cell, pad);
      if (vp) {
        const near =
          (b.cx >= vp.x - vp.margin && b.cx <= vp.x + vp.w + vp.margin && b.cy >= vp.y - vp.margin && b.cy <= vp.y + vp.h + vp.margin);
        if (!near) continue;
      }
      edges.push({
        id: key,
        x1: a.cx,
        y1: a.cy,
        x2: b.cx,
        y2: b.cy,
        walkable: edge.walkable,
        onRoute: routeSet.has(from.id) && routeSet.has(to.id) && Math.abs(routeIndex.get(from.id)! - routeIndex.get(to.id)!) === 1,
      });
    }
  }

  let routePath: string | null = null;
  if (state.route.length > 1) {
    const pts = state.route
      .map((id) => graph.get(id))
      .filter((n): n is WorldNode => n !== null)
      .map((n) => gridToScreen(n.gridX, n.gridY, height, cell, pad));
    if (pts.length > 1) routePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(' ');
  }

  return {
    nodes,
    edges,
    routePath,
    width: boardW,
    height: boardH,
    cell,
    pad,
    viewBox: `0 0 ${boardW} ${boardH}`,
    culled,
    totalNodes: graph.size,
  };
}

/**
 * Cell size that fits a board inside a target pixel budget, so an 8×8 world and
 * a 32×32 world both render legibly without the caller guessing.
 */
export function fitCell(width: number, height: number, targetPx: number, pad = 24): number {
  const usable = Math.max(40, targetPx - pad * 2);
  return Math.max(6, Math.min(48, usable / Math.max(1, Math.max(width, height) - 1)));
}
