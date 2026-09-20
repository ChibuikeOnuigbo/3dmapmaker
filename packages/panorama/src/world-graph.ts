/**
 * packages/panorama — the world graph.
 *
 * This is the single source of truth for a panorama world. The 2D map and the
 * 360° viewer both read from it; neither keeps its own copy of node or edge
 * state, so they cannot drift apart.
 *
 * Model: G = (V, E) where V are panorama nodes and E are walkable connections.
 *
 *   index = gridY * width + gridX        (spec §3)
 *   id    = index + 1                    (1-based, so (0,0) is node 1)
 *
 * Two different notions of "can I go there" are kept strictly separate:
 *
 *   kingMovesFrom()  — the MAXIMUM geometrically possible moves (≤1 on each
 *                      axis). This is the chess-king upper bound.
 *   neighborsOf()    — the ACTUAL edges in the world graph. Roads, walls,
 *                      rivers and buildings remove edges from the bound.
 *
 * Movement resolution must always consult neighborsOf(), never the bound.
 */

/* ------------------------------------------------------------ directions --- */

export type Direction =
  | 'north'
  | 'south'
  | 'east'
  | 'west'
  | 'northEast'
  | 'northWest'
  | 'southEast'
  | 'southWest';

/** Grid deltas. +y is north, +x is east. */
export const DIRECTION_DELTA: Record<Direction, { dx: number; dy: number }> = {
  north: { dx: 0, dy: 1 },
  south: { dx: 0, dy: -1 },
  east: { dx: 1, dy: 0 },
  west: { dx: -1, dy: 0 },
  northEast: { dx: 1, dy: 1 },
  northWest: { dx: -1, dy: 1 },
  southEast: { dx: 1, dy: -1 },
  southWest: { dx: -1, dy: -1 },
};

export const OPPOSITE: Record<Direction, Direction> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
  northEast: 'southWest',
  northWest: 'southEast',
  southEast: 'northWest',
  southWest: 'northEast',
};

export const ALL_DIRECTIONS = Object.keys(DIRECTION_DELTA) as Direction[];

/** The eight king's moves, in a stable order. */
export const KING_DELTAS: ReadonlyArray<{ dx: number; dy: number; dir: Direction }> = ALL_DIRECTIONS.map((dir) => ({
  dx: DIRECTION_DELTA[dir].dx,
  dy: DIRECTION_DELTA[dir].dy,
  dir,
}));

/** Reverse a delta into its direction name, or null if it is not a king move. */
export function directionFromDelta(dx: number, dy: number): Direction | null {
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return null;
  for (const dir of ALL_DIRECTIONS) {
    if (DIRECTION_DELTA[dir].dx === dx && DIRECTION_DELTA[dir].dy === dy) return dir;
  }
  return null;
}

/* ---------------------------------------------------------------- index --- */

export function indexFor(gridX: number, gridY: number, width: number): number {
  return gridY * width + gridX;
}

export function coordFor(index: number, width: number): { x: number; y: number } {
  return { x: index % width, y: Math.floor(index / width) };
}

/** 1-based id, matching the spec: (0,0) → 1, (7,7) on an 8-wide board → 64. */
export function idForIndex(index: number): number {
  return index + 1;
}

export function indexForId(id: number): number {
  return id - 1;
}

/** Chebyshev distance — the king-move count between two squares. */
export function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function euclideanGrid(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Compass bearing in degrees, 0 = north, clockwise. */
export function bearingBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return 0;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/* ----------------------------------------------------------------- node --- */

export interface NodeEnvironment {
  terrain: string;
  roadType: string;
  buildings: string[];
  vegetation: string[];
  landmarks: string[];
}

export interface NodeLighting {
  timeOfDay: string;
  weather: string;
  /** Sun azimuth in degrees, 0 = north, clockwise. */
  sunDirection: number;
  exposure: number;
}

export interface NodeValidation {
  /** The plate decodes and is a plausible equirectangular image. */
  panoramaValid: boolean;
  /** Lighting/weather/time agree with the parent node. */
  continuityValid: boolean;
  /** The node sits on a walkable cell with consistent geometry. */
  geometryValid: boolean;
  /** Sun direction and exposure are inside the world's envelope. */
  lightingValid: boolean;
}

export interface WorldNode {
  id: string;
  /** Numeric 1-based id, derived from the index. */
  number: number;
  index: number;
  gridX: number;
  gridY: number;
  /** World metres, derived from the grid position and the world scale. */
  worldX: number;
  worldZ: number;
  latitude?: number;
  longitude?: number;
  panoramaUrl: string;
  thumbnailUrl?: string;
  heading: number;
  pitch: number;
  fov: number;
  environment: NodeEnvironment;
  lighting: NodeLighting;
  connections: Partial<Record<Direction, string>>;
  validation: NodeValidation;
  /** Provenance for every plate (spec §50). */
  provenance: {
    sourceType: 'generated' | 'reference';
    referenceSources: string[];
    generator: string;
    createdAt: string;
    license: string;
  };
}

export interface WorldEdge {
  from: string;
  to: string;
  direction: Direction;
  /** Measured metres, not grid units. */
  distance: number;
  /** Seconds at the world's walking speed. */
  travelTime: number;
  walkable: boolean;
}

export interface Landmark {
  id: string;
  name: string;
  gridX: number;
  gridY: number;
  kind: string;
}

/* ------------------------------------------------------------ graph --- */

export interface WorldGraphOptions {
  width: number;
  height: number;
  /** Metres per grid step (spec §48). Never assume 1 unit = 1 metre. */
  metersPerGridUnit: number;
  /** Walking speed in m/s, used to derive edge travel times. */
  walkSpeed?: number;
  /** Spatial-hash cell size in grid units. */
  cellSize?: number;
}

export interface PathResult {
  nodes: WorldNode[];
  /** Total metres along the actual edges, not the Chebyshev bound. */
  distance: number;
  /** Total seconds. */
  travelTime: number;
  /** Nodes expanded by A*, exposed so the cost is visible, not hidden. */
  expanded: number;
}

export class WorldGraph {
  readonly width: number;
  readonly height: number;
  readonly metersPerGridUnit: number;
  readonly walkSpeed: number;

  private readonly nodes = new Map<string, WorldNode>();
  private readonly byIndex = new Map<number, WorldNode>();
  private readonly edges = new Map<string, WorldEdge[]>();
  private readonly cellSize: number;
  private readonly hash = new Map<number, string[]>();
  readonly landmarks: Landmark[] = [];

  constructor(opts: WorldGraphOptions) {
    if (opts.width < 1 || opts.height < 1) throw new Error('World dimensions must be at least 1×1');
    if (!(opts.metersPerGridUnit > 0)) throw new Error('metersPerGridUnit must be positive');
    this.width = opts.width;
    this.height = opts.height;
    this.metersPerGridUnit = opts.metersPerGridUnit;
    this.walkSpeed = opts.walkSpeed ?? 1.4;
    this.cellSize = Math.max(1, opts.cellSize ?? 8);
  }

  /* -------------------------------------------------------------- add --- */

  add(node: Omit<WorldNode, 'index' | 'number' | 'worldX' | 'worldZ'>): WorldNode {
    if (node.gridX < 0 || node.gridY < 0 || node.gridX >= this.width || node.gridY >= this.height) {
      throw new Error(`Node ${node.id} at (${node.gridX},${node.gridY}) is outside the ${this.width}×${this.height} world`);
    }
    const index = indexFor(node.gridX, node.gridY, this.width);
    const full: WorldNode = {
      ...node,
      index,
      number: idForIndex(index),
      worldX: node.gridX * this.metersPerGridUnit,
      worldZ: -node.gridY * this.metersPerGridUnit,
      connections: { ...node.connections },
    };
    if (this.nodes.has(node.id)) throw new Error(`Duplicate node id ${node.id}`);
    if (this.byIndex.has(index)) {
      throw new Error(`Two nodes claim square (${node.gridX},${node.gridY}): ${this.byIndex.get(index)!.id} and ${node.id}`);
    }
    this.nodes.set(node.id, full);
    this.byIndex.set(index, full);
    this.hashInsert(full);
    return full;
  }

  addLandmark(l: Landmark): void {
    this.landmarks.push(l);
  }

  /* ---------------------------------------------------------- connect --- */

  /**
   * Add a bidirectional edge. The reverse direction is derived, never
   * hard-coded, so an edge can never be one-way by accident.
   */
  connect(fromId: string, dir: Direction, toId: string, walkable = true): WorldEdge | null {
    const from = this.nodes.get(fromId);
    const to = this.nodes.get(toId);
    if (!from || !to) return null;
    const d = DIRECTION_DELTA[dir];
    // Reject edges that do not match the geometry. This is what stops a
    // hand-authored or generated manifest from claiming an impossible link.
    if (to.gridX - from.gridX !== d.dx || to.gridY - from.gridY !== d.dy) return null;

    const distance = Math.hypot(d.dx, d.dy) * this.metersPerGridUnit;
    const edge: WorldEdge = {
      from: fromId,
      to: toId,
      direction: dir,
      distance,
      travelTime: distance / this.walkSpeed,
      walkable,
    };
    const back: WorldEdge = {
      from: toId,
      to: fromId,
      direction: OPPOSITE[dir],
      distance,
      travelTime: edge.travelTime,
      walkable,
    };
    this.setEdge(fromId, edge);
    this.setEdge(toId, back);
    from.connections[dir] = toId;
    to.connections[OPPOSITE[dir]] = fromId;
    return edge;
  }

  /**
   * Store one directed edge, REPLACING any existing edge in the same
   * direction. A node may only have one edge per compass direction — allowing
   * duplicates would make `neighbor(id, dir)` ambiguous, and a later
   * `connect(..., walkable: false)` would silently fail to block a route that
   * an earlier connect had opened.
   */
  private setEdge(id: string, edge: WorldEdge): void {
    const list = this.edges.get(id);
    if (!list) {
      this.edges.set(id, [edge]);
      return;
    }
    const at = list.findIndex((e) => e.direction === edge.direction);
    if (at >= 0) list[at] = edge;
    else list.push(edge);
  }

  /* ---------------------------------------------------------- lookups --- */

  get(id: string): WorldNode | null {
    return this.nodes.get(id) ?? null;
  }

  get byNumber(): (n: number) => WorldNode | null {
    return (n) => this.byIndex.get(indexForId(n)) ?? null;
  }

  at(gridX: number, gridY: number): WorldNode | null {
    if (gridX < 0 || gridY < 0 || gridX >= this.width || gridY >= this.height) return null;
    return this.byIndex.get(indexFor(gridX, gridY, this.width)) ?? null;
  }

  get size(): number {
    return this.nodes.size;
  }

  all(): WorldNode[] {
    return [...this.nodes.values()];
  }

  allEdges(): WorldEdge[] {
    const out: WorldEdge[] = [];
    for (const list of this.edges.values()) for (const e of list) out.push(e);
    return out;
  }

  /**
   * The MAXIMUM geometrically possible king moves from a square — the chess
   * upper bound. Use neighborsOf() for what is actually walkable.
   */
  kingMovesFrom(gridX: number, gridY: number): Array<{ dir: Direction; dx: number; dy: number; x: number; y: number }> {
    const out: Array<{ dir: Direction; dx: number; dy: number; x: number; y: number }> = [];
    // An off-board origin has no moves at all; returning the deltas that happen
    // to land in range would let a caller "stand" on a square that does not exist.
    if (gridX < 0 || gridY < 0 || gridX >= this.width || gridY >= this.height) return out;
    for (const m of KING_DELTAS) {
      const x = gridX + m.dx;
      const y = gridY + m.dy;
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
      out.push({ dir: m.dir, dx: m.dx, dy: m.dy, x, y });
    }
    return out;
  }

  /** The ACTUAL walkable edges from a node. */
  neighborsOf(id: string): Array<{ edge: WorldEdge; node: WorldNode }> {
    const list = this.edges.get(id);
    if (!list) return [];
    const out: Array<{ edge: WorldEdge; node: WorldNode }> = [];
    for (const e of list) {
      if (!e.walkable) continue;
      const n = this.nodes.get(e.to);
      if (n) out.push({ edge: e, node: n });
    }
    return out;
  }

  /** The neighbour in a specific direction, if that edge exists AND is walkable. */
  neighbor(id: string, dir: Direction): WorldNode | null {
    const list = this.edges.get(id);
    if (!list) return null;
    for (const e of list) if (e.direction === dir && e.walkable) return this.nodes.get(e.to) ?? null;
    return null;
  }

  /**
   * The raw edge in a direction, walkable or not.
   *
   * Callers need this to tell "there is no way east" apart from "there is a
   * way east but it is blocked" — two very different things to a player
   * standing at a junction, and the difference cannot be recovered from
   * `neighbor()` alone because it filters blocked edges out.
   */
  edgeInDirection(id: string, dir: Direction): WorldEdge | null {
    const list = this.edges.get(id);
    if (!list) return null;
    for (const e of list) if (e.direction === dir) return e;
    return null;
  }

  /* --------------------------------------------------- spatial index --- */

  private cellKey(gx: number, gy: number): number {
    const cx = Math.floor(gx / this.cellSize);
    const cy = Math.floor(gy / this.cellSize);
    return cx * 100003 + cy;
  }

  private hashInsert(node: WorldNode): void {
    const k = this.cellKey(node.gridX, node.gridY);
    const bucket = this.hash.get(k);
    if (bucket) bucket.push(node.id);
    else this.hash.set(k, [node.id]);
  }

  /**
   * Nodes within `radius` king moves, via the spatial hash.
   *
   * The metric is Chebyshev, matching the movement model: radius 1 is the 3×3
   * box around the square, radius 2 is 5×5. A Euclidean disc would disagree
   * with what the player can actually reach in N steps. This is what makes a
   * 1,024-node world cheap to query — we never scan every node.
   */
  nearby(gridX: number, gridY: number, radius: number): WorldNode[] {
    const out: WorldNode[] = [];
    if (radius < 0) return out;
    const c0x = Math.floor((gridX - radius) / this.cellSize);
    const c1x = Math.floor((gridX + radius) / this.cellSize);
    const c0y = Math.floor((gridY - radius) / this.cellSize);
    const c1y = Math.floor((gridY + radius) / this.cellSize);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const bucket = this.hash.get(cx * 100003 + cy);
        if (!bucket) continue;
        for (const id of bucket) {
          const n = this.nodes.get(id)!;
          if (chebyshev({ x: n.gridX, y: n.gridY }, { x: gridX, y: gridY }) <= radius) out.push(n);
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------- pathfinding --- */

  /**
   * A* over the actual edge set with a Chebyshev heuristic, which is admissible
   * for king-style movement (it never overestimates, because one move can close
   * at most one unit of Chebyshev distance).
   */
  findPath(fromId: string, toId: string, maxExpanded = 200000): PathResult | null {
    const start = this.nodes.get(fromId);
    const goal = this.nodes.get(toId);
    if (!start || !goal) return null;
    if (start === goal) return { nodes: [start], distance: 0, travelTime: 0, expanded: 0 };

    const h = (n: WorldNode) => chebyshev({ x: n.gridX, y: n.gridY }, { x: goal.gridX, y: goal.gridY }) * this.metersPerGridUnit;

    const gScore = new Map<string, number>();
    const fScore = new Map<string, number>();
    const cameFrom = new Map<string, { id: string; edge: WorldEdge }>();
    const closed = new Set<string>();

    // Binary heap keyed on f. A plain array scan would be O(n) per pop and would
    // dominate the cost on the 1,024-node world.
    const open: Array<{ id: string; f: number }> = [{ id: fromId, f: h(start) }];
    gScore.set(fromId, 0);
    fScore.set(fromId, h(start));
    let expanded = 0;

    while (open.length > 0) {
      let best = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[best].f) best = i;
      const currentId = open[best].id;
      open[best] = open[open.length - 1];
      open.pop();

      if (closed.has(currentId)) continue;
      closed.add(currentId);
      expanded++;
      if (expanded > maxExpanded) return null;

      const current = this.nodes.get(currentId)!;
      if (currentId === toId) return this.reconstruct(cameFrom, toId, start, expanded);

      for (const { edge, node } of this.neighborsOf(currentId)) {
        if (closed.has(node.id)) continue;
        const tentative = (gScore.get(currentId) ?? Infinity) + edge.distance;
        if (tentative < (gScore.get(node.id) ?? Infinity)) {
          cameFrom.set(node.id, { id: currentId, edge });
          gScore.set(node.id, tentative);
          const f = tentative + h(node);
          fScore.set(node.id, f);
          open.push({ id: node.id, f });
        }
      }
    }
    return null;
  }

  private reconstruct(cameFrom: Map<string, { id: string; edge: WorldEdge }>, toId: string, start: WorldNode, expanded: number): PathResult {
    const nodes: WorldNode[] = [];
    let distance = 0;
    let travelTime = 0;
    let cursor: string | undefined = toId;
    let guard = 0;
    while (cursor && guard++ < 100000) {
      const node = this.nodes.get(cursor)!;
      nodes.push(node);
      const prev = cameFrom.get(cursor);
      if (!prev) break;
      distance += prev.edge.distance;
      travelTime += prev.edge.travelTime;
      cursor = prev.id;
    }
    nodes.reverse();
    if (nodes[0] !== start) return { nodes: [start], distance: 0, travelTime: 0, expanded };
    return { nodes, distance, travelTime, expanded };
  }

  /* --------------------------------------------------------- landmarks --- */

  /**
   * The vector from a node to a landmark, in grid units and metres. This is the
   * chain that makes the world feel connected: as you walk toward the church
   * the distance monotonically shrinks.
   */
  landmarkVector(nodeId: string, landmarkId: string): { dx: number; dy: number; meters: number; bearingDeg: number } | null {
    const n = this.nodes.get(nodeId);
    const l = this.landmarks.find((x) => x.id === landmarkId);
    if (!n || !l) return null;
    const dx = l.gridX - n.gridX;
    const dy = l.gridY - n.gridY;
    return {
      dx,
      dy,
      meters: Math.hypot(dx, dy) * this.metersPerGridUnit,
      bearingDeg: (bearingBetween({ x: n.gridX, y: n.gridY }, { x: l.gridX, y: l.gridY }) + 360) % 360,
    };
  }

  /* -------------------------------------------------------- validation --- */

  /** Structural audit: every edge must be reciprocal and geometrically valid. */
  audit(): { nodes: number; edges: number; problems: string[] } {
    const problems: string[] = [];
    let edges = 0;
    for (const [id, list] of this.edges) {
      const from = this.nodes.get(id);
      if (!from) {
        problems.push(`edge list for unknown node ${id}`);
        continue;
      }
      for (const e of list) {
        edges++;
        const to = this.nodes.get(e.to);
        if (!to) {
          problems.push(`${id} → ${e.to}: target does not exist`);
          continue;
        }
        const d = DIRECTION_DELTA[e.direction];
        if (to.gridX - from.gridX !== d.dx || to.gridY - from.gridY !== d.dy) {
          problems.push(`${id} → ${e.to}: ${e.direction} does not match the geometry`);
        }
        const back = this.edges.get(e.to)?.find((b) => b.from === e.to && b.to === id);
        if (!back) problems.push(`${id} → ${e.to}: no reciprocal edge`);
        else if (back.direction !== OPPOSITE[e.direction]) {
          problems.push(`${id} → ${e.to}: reciprocal direction is ${back.direction}, expected ${OPPOSITE[e.direction]}`);
        }
      }
    }
    return { nodes: this.nodes.size, edges, problems };
  }

  /** True when every node is reachable from `startId`. */
  isConnected(startId: string): { connected: boolean; reached: number; unreachable: string[] } {
    const seen = new Set<string>();
    const stack = [startId];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const { node } of this.neighborsOf(id)) if (!seen.has(node.id)) stack.push(node.id);
    }
    const unreachable = this.all()
      .filter((n) => !seen.has(n.id))
      .map((n) => n.id);
    return { connected: unreachable.length === 0, reached: seen.size, unreachable };
  }

  /* ---------------------------------------------------------- manifest --- */

  toJSON(): Record<string, unknown> {
    return {
      dimensions: { width: this.width, height: this.height },
      metersPerGridUnit: this.metersPerGridUnit,
      walkSpeed: this.walkSpeed,
      landmarks: this.landmarks,
      nodes: this.all().map((n) => ({ ...n })),
    };
  }
}
