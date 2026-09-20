/**
 * Panorama Maps — core/world-graph.js
 *
 * WorldGraph — THE single source of truth (Spec §4, §12).
 * Contains: map metadata, location nodes (x/y map px), edges with real
 * distances, zones with boundaries, landmarks, and validation metadata.
 * The panorama viewer and the 2D map both read from this object; neither
 * keeps a private copy of the world position.
 *
 * Direction convention: 0° = North (-Y), 90° = East (+X), 180° = South,
 * 270° = West. Diagonals are king-style (Spec §13).
 */

export const DIRS = [
  { name: 'N',  dx: 0,  dy: -1, angle: 0 },
  { name: 'NE', dx: 1,  dy: -1, angle: 45 },
  { name: 'E',  dx: 1,  dy: 0,  angle: 90 },
  { name: 'SE', dx: 1,  dy: 1,  angle: 135 },
  { name: 'S',  dx: 0,  dy: 1,  angle: 180 },
  { name: 'SW', dx: -1, dy: 1,  angle: 225 },
  { name: 'W',  dx: -1, dy: 0,  angle: 270 },
  { name: 'NW', dx: -1, dy: -1, angle: 315 },
];

export function bearingDeg(x1, y1, x2, y2) {
  let a = Math.atan2(x2 - x1, -(y2 - y1)) * 180 / Math.PI;
  if (a < 0) a += 360;
  return a;
}

/** Smallest signed difference a→b in degrees, result in [-180, 180). */
export function angleDelta(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** Snap an angle to the nearest of the 8 king directions (Spec §13). */
export function snapToDir(angleDeg) {
  const norm = ((angleDeg % 360) + 360) % 360;
  let best = DIRS[0], bestDiff = 360;
  for (const d of DIRS) {
    const diff = Math.abs(angleDelta(norm, d.angle));
    if (diff < bestDiff) { bestDiff = diff; best = d; }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Spatial index (Spec §65) — simple grid hash.                        */
/* ------------------------------------------------------------------ */
export class SpatialHash {
  constructor(cellSize = 256) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }
  _key(ix, iy) { return ix + ':' + iy; }
  _cellOf(x, y) { return [Math.floor(x / this.cellSize), Math.floor(y / this.cellSize)]; }

  insert(id, x, y) {
    const [ix, iy] = this._cellOf(x, y);
    const k = this._key(ix, iy);
    if (!this.cells.has(k)) this.cells.set(k, new Set());
    this.cells.get(k).add(id);
  }
  remove(id, x, y) {
    const [ix, iy] = this._cellOf(x, y);
    const set = this.cells.get(this._key(ix, iy));
    if (set) set.delete(id);
  }
  /** All ids within `radius` px of (x, y). Caller filters by exact distance. */
  queryRadius(x, y, radius) {
    const out = [];
    const [x0, x1] = [Math.floor((x - radius) / this.cellSize), Math.floor((x + radius) / this.cellSize)];
    const [y0, y1] = [Math.floor((y - radius) / this.cellSize), Math.floor((y + radius) / this.cellSize)];
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
      const set = this.cells.get(this._key(ix, iy));
      if (set) for (const id of set) out.push(id);
    }
    return out;
  }
  clear() { this.cells.clear(); }
}

/* ------------------------------------------------------------------ */
/* Zones (Spec §22, §23): circle / rect / polygon with explicit         */
/* boundaries and point-inside tests.                                   */
/* ------------------------------------------------------------------ */
export class ZoneManager {
  constructor(scale) {
    this.scale = scale;          // MapScale
    this.zones = new Map();      // id -> zone
  }

  add(zone) {
    // zone: {id, name, shape:'circle'|'rect'|'poly', ...shape params, color?, meta?}
    this.zones.set(zone.id, zone);
    return zone;
  }

  get(id) { return this.zones.get(id) || null; }

  /** Ids of every zone containing map point (x, y) in px. */
  zonesAt(x, y) {
    const out = [];
    for (const z of this.zones.values()) if (this._contains(z, x, y)) out.push(z.id);
    return out;
  }

  _contains(z, x, y) {
    if (z.shape === 'circle') {
      return Math.hypot(x - z.cx, y - z.cy) <= z.radiusPx;
    }
    if (z.shape === 'rect') {
      return x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h;
    }
    if (z.shape === 'poly') {
      const pts = z.points; let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    }
    return false;
  }

  /**
   * Distance in meters from (x,y) to the zone boundary.
   * Positive when inside, negative when outside.
   */
  distanceToBoundaryM(zoneId, x, y) {
    const z = this.zones.get(zoneId);
    if (!z) return null;
    if (z.shape === 'circle') {
      const d = z.radiusPx - Math.hypot(x - z.cx, y - z.cy);
      return this.scale.pxToM(d);
    }
    if (z.shape === 'rect') {
      const inside = this._contains(z, x, y);
      const dx = Math.max(z.x - x, 0, x - (z.x + z.w));
      const dy = Math.max(z.y - y, 0, y - (z.y + z.h));
      if (!inside) return -this.scale.pxToM(Math.hypot(dx, dy));
      const m = Math.min(x - z.x, z.x + z.w - x, y - z.y, z.y + z.h - y);
      return this.scale.pxToM(m);
    }
    return null; // polygon distance not needed for current worlds
  }

  toJSON() { return [...this.zones.values()]; }
  fromJSON(arr = []) { this.zones.clear(); arr.forEach(z => this.add(z)); }
}

/* ------------------------------------------------------------------ */
/* WorldGraph                                                           */
/* ------------------------------------------------------------------ */
let _nodeCounter = 0;
export function generateId(prefix = 'node') {
  _nodeCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_nodeCounter.toString(36)}`;
}

export class WorldGraph {
  /**
   * @param {MapScale} scale
   */
  constructor(scale, { id = 'world', name = 'Untitled World' } = {}) {
    this.id = id;
    this.name = name;
    this.scale = scale;
    this.nodes = new Map();     // id -> node
    this.edges = new Map();     // id -> edge
    this.zones = new ZoneManager(scale);
    this.landmarks = new Map(); // id -> {id, type, name, x, y, importance, meta}
    this.index = new SpatialHash(256);
    this.environment = {        // persistent environment metadata (Spec §32 World Memory)
      timeOfDay: 'day', weather: 'clear', sunAzimuthDeg: 40, sunElevationDeg: 35,
      ambient: '#aebdc9', groundBase: '#7d9b6a', description: '',
    };
    this.settings = {
      walkSpeedMps: 4.2,        // transition pacing
      transitionMs: 420,
      autoCompletePanorama: true,
      nodeSpacingPx: null,      // set by grid builders (informational)
    };
  }

  /* ---------------- nodes ---------------- */
  /**
   * node = { id, x, y, name, zoneId?, pano?: {kind:'generated'|'asset', assetId?|key, seed?, incomplete?:{top,bottom}},
   *          headingDeg?, camera?: {height, fov, pitchDeg, yawDeg}, meta? }
   */
  addNode(node) {
    if (typeof node.x !== 'number' || typeof node.y !== 'number' ||
        !Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      throw new Error(`addNode: node "${node.id}" needs finite numeric x/y`);
    }
    if (!node.name) node.name = node.id;
    this.nodes.set(node.id, node);
    this.index.insert(node.id, node.x, node.y);
    return node;
  }

  getNode(id) { return this.nodes.get(id) || null; }

  moveNode(id, x, y) {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`moveNode: unknown node ${id}`);
    this.index.remove(id, n.x, n.y);
    n.x = x; n.y = y;
    this.index.insert(id, x, y);
    this._refreshEdgeDistances(id);
  }

  removeNode(id) {
    const n = this.nodes.get(id);
    if (!n) return;
    this.index.remove(id, n.x, n.y);
    for (const e of [...this.edges.values()]) {
      if (e.a === id || e.b === id) this.edges.delete(e.id);
    }
    this.nodes.delete(id);
  }

  nearestNode(x, y, maxRadiusPx = Infinity) {
    let best = null, bestD = maxRadiusPx;
    for (const id of this.index.queryRadius(x, y, maxRadiusPx)) {
      const n = this.nodes.get(id);
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= bestD) { bestD = d; best = n; }
    }
    return best;
  }

  /* ---------------- edges ---------------- */
  /**
   * Connect two nodes. Distance is derived from coordinates — never
   * invented (Spec §14). Diagonal distance = sqrt(dx²+dy²).
   */
  connect(aId, bId, { blocked = false, kind = 'walk' } = {}) {
    const a = this.getNode(aId), b = this.getNode(bId);
    if (!a || !b) throw new Error(`connect: unknown node(s) ${aId} -> ${bId}`);
    if (aId === bId) throw new Error('connect: self edge');
    for (const e of this.edges.values()) {
      if ((e.a === aId && e.b === bId) || (e.a === bId && e.b === aId)) return e;
    }
    const distPx = Math.hypot(b.x - a.x, b.y - a.y);
    const edge = {
      id: `edge_${aId}_${bId}`,
      a: aId, b: bId,
      distPx,
      distM: this.scale.pxToM(distPx),
      bearingAB: bearingDeg(a.x, a.y, b.x, b.y),
      dirNameAB: snapToDir(bearingDeg(a.x, a.y, b.x, b.y)).name,
      blocked, kind,
    };
    this.edges.set(edge.id, edge);
    return edge;
  }

  disconnect(aId, bId) {
    for (const e of [...this.edges.values()]) {
      if ((e.a === aId && e.b === bId) || (e.a === bId && e.b === aId)) this.edges.delete(e.id);
    }
  }

  setEdgeBlocked(aId, bId, blocked) {
    for (const e of this.edges.values()) {
      if ((e.a === aId && e.b === bId) || (e.a === bId && e.b === aId)) { e.blocked = blocked; return e; }
    }
    return null;
  }

  edgesOf(nodeId) {
    const out = [];
    for (const e of this.edges.values()) {
      if (e.a === nodeId || e.b === nodeId) out.push(e);
    }
    return out;
  }

  otherEnd(edge, nodeId) { return edge.a === nodeId ? edge.b : edge.a; }

  /** Bearing of travel when leaving `fromId` along `edge`. */
  edgeBearing(edge, fromId) {
    if (edge.a === fromId) return edge.bearingAB;
    let b = edge.bearingAB + 180;
    if (b >= 360) b -= 360;
    return b;
  }

  /**
   * Resolve a desired travel bearing against this node's edges (Spec §13, §38):
   * returns the open edge whose bearing is closest within `coneDeg`, else null.
   */
  resolveEdge(fromId, desiredBearingDeg, { coneDeg = 35 } = {}) {
    let best = null, bestDiff = Infinity;
    for (const e of this.edgesOf(fromId)) {
      if (e.blocked) continue;
      const diff = Math.abs(angleDelta(desiredBearingDeg, this.edgeBearing(e, fromId)));
      if (diff > coneDeg) continue;
      // deterministic tie-break: closest bearing wins; on a true bearing tie,
      // the SHORTER hop wins (the natural next step down the street)
      const better = !best || diff < bestDiff - 1e-9
        || (Math.abs(diff - bestDiff) <= 1e-9 && e.distPx < best.distPx);
      if (better) { best = e; bestDiff = diff; }
    }
    return best;
  }

  _refreshEdgeDistances(nodeId) {
    for (const e of this.edgesOf(nodeId)) {
      const a = this.getNode(e.a), b = this.getNode(e.b);
      e.distPx = Math.hypot(b.x - a.x, b.y - a.y);
      e.distM = this.scale.pxToM(e.distPx);
      e.bearingAB = bearingDeg(a.x, a.y, b.x, b.y);
      e.dirNameAB = snapToDir(e.bearingAB).name;
    }
  }

  /* ---------------- landmarks ---------------- */
  addLandmark(lm) {
    if (typeof lm.x !== 'number' || typeof lm.y !== 'number') throw new Error('landmark needs x/y');
    this.landmarks.set(lm.id, { importance: 0.5, ...lm });
    return this.landmarks.get(lm.id);
  }
  removeLandmark(id) { this.landmarks.delete(id); }

  nearestLandmark(x, y) {
    let best = null, bestD = Infinity;
    for (const lm of this.landmarks.values()) {
      const d = Math.hypot(lm.x - x, lm.y - y);
      if (d < bestD) { bestD = d; best = lm; }
    }
    return best ? { landmark: best, distanceM: this.scale.pxToM(bestD), bearingDeg: bearingDeg(x, y, best.x, best.y) } : null;
  }

  /* ---------------- pathfinding (Dijkstra over edge distances) -------- */
  shortestPath(fromId, toId) {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return null;
    const dist = new Map([[fromId, 0]]);
    const prev = new Map();
    const visited = new Set();
    const queue = [[0, fromId]];
    while (queue.length) {
      queue.sort((p, q) => p[0] - q[0]);
      const [d, id] = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      if (id === toId) break;
      for (const e of this.edgesOf(id)) {
        if (e.blocked) continue;
        const o = this.otherEnd(e, id);
        const nd = d + e.distPx;
        if (nd < (dist.get(o) ?? Infinity)) {
          dist.set(o, nd); prev.set(o, id); queue.push([nd, o]);
        }
      }
    }
    if (!prev.has(toId) && fromId !== toId) return null;
    const path = [toId];
    let cur = toId;
    while (cur !== fromId) { cur = prev.get(cur); if (cur === undefined) return null; path.unshift(cur); }
    return { nodes: path, distanceM: this.scale.pxToM(dist.get(toId) ?? 0) };
  }

  /** Breadth-first reachability — used by tests and the health check. */
  reachableFrom(startId) {
    const seen = new Set([startId]);
    const q = [startId];
    while (q.length) {
      const id = q.shift();
      for (const e of this.edgesOf(id)) {
        if (e.blocked) continue;
        const o = this.otherEnd(e, id);
        if (!seen.has(o)) { seen.add(o); q.push(o); }
      }
    }
    return seen;
  }

  /* ---------------- (de)serialization ---------------- */
  toJSON() {
    return {
      id: this.id, name: this.name,
      scale: this.scale.toJSON(),
      environment: { ...this.environment },
      settings: { ...this.settings },
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      zones: this.zones.toJSON(),
      landmarks: [...this.landmarks.values()],
    };
  }

  static fromJSON(json) {
    const g = new WorldGraph(MapScaleFromJSON(json.scale), { id: json.id, name: json.name });
    if (json.environment) g.environment = { ...g.environment, ...json.environment };
    if (json.settings) g.settings = { ...g.settings, ...json.settings };
    (json.zones || []).forEach(z => g.zones.add(z));
    (json.landmarks || []).forEach(lm => g.landmarks.set(lm.id, lm));
    (json.nodes || []).forEach(n => g.addNode({ ...n }));
    (json.edges || []).forEach(e => {
      g.edges.set(e.id, { ...e });   // keep authored distances; refresh is cheap anyway
    });
    return g;
  }

  /* ---------------- validation / health ---------------- */
  healthCheck() {
    const issues = [];
    for (const e of this.edges.values()) {
      if (!this.nodes.has(e.a)) issues.push(`edge ${e.id}: missing node ${e.a}`);
      if (!this.nodes.has(e.b)) issues.push(`edge ${e.id}: missing node ${e.b}`);
    }
    const authoredEdgeIds = new Set([...this.edges.values()].map(e => e.id));
    if (authoredEdgeIds.size !== this.edges.size) issues.push('duplicate edge ids');
    for (const n of this.nodes.values()) {
      if (n.pano?.kind === 'asset' && !n.pano.assetId && !n.pano.missing) {
        // flagged by importer when an asset is absent — informational only at this layer
      }
      if (n.zoneId && !this.zones.get(n.zoneId)) issues.push(`node ${n.id}: unknown zone ${n.zoneId}`);
    }
    return issues;
  }
}

// local import to avoid a cycle at module top-level evaluation
import { MapScale } from './scale.js';
function MapScaleFromJSON(json) { return MapScale.fromJSON(json); }
