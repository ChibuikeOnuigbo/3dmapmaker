/**
 * packages/panorama — world graph tests (spec §47).
 *
 * Every assertion here is on real computed output: indexing, coordinate
 * conversion, neighbour generation, king-movement bounds vs actual edges,
 * A* pathfinding, the spatial index, landmark vectors and the structural audit.
 */
import { describe, expect, it } from 'vitest';
import {
  WorldGraph,
  indexFor,
  coordFor,
  idForIndex,
  indexForId,
  chebyshev,
  directionFromDelta,
  DIRECTION_DELTA,
  OPPOSITE,
  ALL_DIRECTIONS,
  type NodeEnvironment,
  type NodeLighting,
  type NodeValidation,
} from './world-graph';

const ENV: NodeEnvironment = { terrain: 'grassland', roadType: 'dirt', buildings: [], vegetation: ['grass'], landmarks: [] };
const LIGHT: NodeLighting = { timeOfDay: '16:30', weather: 'partly_cloudy', sunDirection: 245, exposure: 1 };
const VALID: NodeValidation = { panoramaValid: true, continuityValid: true, geometryValid: true, lightingValid: true };
const PROV = { sourceType: 'generated' as const, referenceSources: [], generator: 'test', createdAt: '2026-01-01', license: 'CC0-1.0' };

/** Fill an entire w×h board with nodes, no edges. */
function fillBoard(g: WorldGraph, prefix = 'n'): void {
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      g.add({
        id: `${prefix}${indexFor(x, y, g.width)}`,
        gridX: x,
        gridY: y,
        panoramaUrl: `/p/${x}-${y}.jpg`,
        heading: 0,
        pitch: 0,
        fov: 90,
        environment: ENV,
        lighting: LIGHT,
        validation: VALID,
        provenance: PROV,
        connections: {},
      });
    }
  }
}

/** Connect every in-bounds king move — a fully open board. */
function connectAllKingMoves(g: WorldGraph): void {
  for (const n of g.all()) {
    for (const m of g.kingMovesFrom(n.gridX, n.gridY)) {
      const other = g.at(m.x, m.y);
      if (other && !n.connections[m.dir]) g.connect(n.id, m.dir, other.id);
    }
  }
}

describe('indexing math (spec §3, §47)', () => {
  it('computes index = y * width + x', () => {
    expect(indexFor(0, 0, 8)).toBe(0);
    expect(indexFor(1, 0, 8)).toBe(1);
    expect(indexFor(7, 0, 8)).toBe(7);
    expect(indexFor(0, 1, 8)).toBe(8);
    expect(indexFor(1, 1, 8)).toBe(9);
    expect(indexFor(7, 7, 8)).toBe(63);
  });

  it('gives 1-based ids matching the spec table exactly', () => {
    expect(idForIndex(indexFor(0, 0, 8))).toBe(1);
    expect(idForIndex(indexFor(7, 0, 8))).toBe(8);
    expect(idForIndex(indexFor(0, 1, 8))).toBe(9);
    expect(idForIndex(indexFor(0, 7, 8))).toBe(57);
    expect(idForIndex(indexFor(7, 7, 8))).toBe(64);
  });

  it('round-trips index ↔ coordinate', () => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const i = indexFor(x, y, 8);
        expect(coordFor(i, 8)).toEqual({ x, y });
      }
    }
  });

  it('round-trips index ↔ 1-based id', () => {
    for (let i = 0; i < 64; i++) expect(indexForId(idForIndex(i))).toBe(i);
  });

  it('assigns every board node the spec id for its square', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    fillBoard(g);
    expect(g.at(0, 0)!.number).toBe(1);
    expect(g.at(1, 0)!.number).toBe(2);
    expect(g.at(7, 0)!.number).toBe(8);
    expect(g.at(0, 1)!.number).toBe(9);
    expect(g.at(1, 1)!.number).toBe(10);
    expect(g.at(0, 7)!.number).toBe(57);
    expect(g.at(7, 7)!.number).toBe(64);
    expect(g.size).toBe(64);
  });

  it('derives world metres from the grid scale, never assuming 1 unit = 1 m', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    fillBoard(g);
    const n = g.at(3, 2)!;
    expect(n.worldX).toBe(75);
    // +y is north and world north is -Z.
    expect(n.worldZ).toBe(-50);
  });

  it('rejects a node outside the board and a duplicate square', () => {
    const g = new WorldGraph({ width: 4, height: 4, metersPerGridUnit: 10 });
    const mk = (id: string, x: number, y: number) => ({
      id, gridX: x, gridY: y, panoramaUrl: '', heading: 0, pitch: 0, fov: 90,
      environment: ENV, lighting: LIGHT, validation: VALID, provenance: PROV, connections: {},
    });
    expect(() => g.add(mk('a', 4, 0))).toThrow(/outside/);
    expect(() => g.add(mk('b', 0, -1))).toThrow(/outside/);
    g.add(mk('c', 1, 1));
    expect(() => g.add(mk('d', 1, 1))).toThrow(/Two nodes claim/);
  });

  it('rejects a non-positive world scale', () => {
    expect(() => new WorldGraph({ width: 4, height: 4, metersPerGridUnit: 0 })).toThrow();
  });
});

describe('king movement (spec §4)', () => {
  it('defines the eight deltas from the spec table', () => {
    expect(DIRECTION_DELTA.north).toEqual({ dx: 0, dy: 1 });
    expect(DIRECTION_DELTA.south).toEqual({ dx: 0, dy: -1 });
    expect(DIRECTION_DELTA.east).toEqual({ dx: 1, dy: 0 });
    expect(DIRECTION_DELTA.west).toEqual({ dx: -1, dy: 0 });
    expect(DIRECTION_DELTA.northEast).toEqual({ dx: 1, dy: 1 });
    expect(DIRECTION_DELTA.northWest).toEqual({ dx: -1, dy: 1 });
    expect(DIRECTION_DELTA.southEast).toEqual({ dx: 1, dy: -1 });
    expect(DIRECTION_DELTA.southWest).toEqual({ dx: -1, dy: -1 });
  });

  it('resolves a delta back to its direction and rejects non-king moves', () => {
    expect(directionFromDelta(1, 1)).toBe('northEast');
    expect(directionFromDelta(-1, -1)).toBe('southWest');
    expect(directionFromDelta(0, 0)).toBeNull();
    expect(directionFromDelta(2, 0)).toBeNull();
    expect(directionFromDelta(0, -2)).toBeNull();
  });

  it('pairs every direction with a true opposite', () => {
    for (const d of ALL_DIRECTIONS) {
      expect(OPPOSITE[OPPOSITE[d]]).toBe(d);
      expect(DIRECTION_DELTA[OPPOSITE[d]].dx + DIRECTION_DELTA[d].dx).toBe(0);
      expect(DIRECTION_DELTA[OPPOSITE[d]].dy + DIRECTION_DELTA[d].dy).toBe(0);
    }
  });

  it('gives an interior square all eight moves and a corner three', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    expect(g.kingMovesFrom(3, 3).length).toBe(8);
    expect(g.kingMovesFrom(0, 0).map((m) => m.dir).sort()).toEqual(['east', 'north', 'northEast']);
    expect(g.kingMovesFrom(7, 7).map((m) => m.dir).sort()).toEqual(['south', 'southWest', 'west']);
    expect(g.kingMovesFrom(4, 0).length).toBe(5);
    expect(g.kingMovesFrom(-1, 0).length).toBe(0);
  });

  it('counts the king-move bound for a whole 8×8 board', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    let total = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) total += g.kingMovesFrom(x, y).length;
    // Corners 4×3, edges 24×5, interior 36×8.
    expect(total).toBe(4 * 3 + 24 * 5 + 36 * 8);
  });
});

describe('edges (spec §21)', () => {
  it('connects bidirectionally and derives the reverse direction', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    fillBoard(g);
    const a = g.at(0, 0)!;
    const b = g.at(1, 0)!;
    const edge = g.connect(a.id, 'east', b.id);
    expect(edge).not.toBeNull();
    expect(edge!.direction).toBe('east');
    expect(g.neighbor(a.id, 'east')!.id).toBe(b.id);
    expect(g.neighbor(b.id, 'west')!.id).toBe(a.id);
    expect(a.connections.east).toBe(b.id);
    expect(b.connections.west).toBe(a.id);
  });

  it('measures an orthogonal edge as one unit and a diagonal as √2', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    fillBoard(g);
    const straight = g.connect(g.at(0, 0)!.id, 'east', g.at(1, 0)!.id)!;
    const diag = g.connect(g.at(2, 0)!.id, 'northEast', g.at(3, 1)!.id)!;
    expect(straight.distance).toBeCloseTo(25, 9);
    expect(diag.distance).toBeCloseTo(Math.SQRT2 * 25, 9);
  });

  it('derives travel time from the world walk speed', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25, walkSpeed: 1.25 });
    fillBoard(g);
    const e = g.connect(g.at(0, 0)!.id, 'east', g.at(1, 0)!.id)!;
    expect(e.travelTime).toBeCloseTo(20, 9);
  });

  it('refuses an edge whose direction does not match the geometry', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    fillBoard(g);
    // (0,0) → (2,0) is two squares east, not one.
    expect(g.connect(g.at(0, 0)!.id, 'east', g.at(2, 0)!.id)).toBeNull();
    // (0,0) → (1,1) is north-east, not north.
    expect(g.connect(g.at(0, 0)!.id, 'north', g.at(1, 1)!.id)).toBeNull();
    expect(g.at(0, 0)!.connections.east).toBeUndefined();
  });

  it('refuses an edge to a node that does not exist', () => {
    const g = new WorldGraph({ width: 4, height: 4, metersPerGridUnit: 10 });
    fillBoard(g);
    expect(g.connect(g.at(0, 0)!.id, 'east', 'ghost')).toBeNull();
  });

  it('excludes non-walkable edges from the neighbour set', () => {
    const g = new WorldGraph({ width: 4, height: 4, metersPerGridUnit: 10 });
    fillBoard(g);
    const a = g.at(0, 0)!;
    const b = g.at(1, 0)!;
    g.connect(a.id, 'east', b.id, false);
    expect(g.neighborsOf(a.id).length).toBe(0);
    expect(g.neighbor(a.id, 'east')).toBeNull();
    // The connection is still recorded, so the map can draw it as blocked.
    expect(a.connections.east).toBe(b.id);
  });

  it('separates the king-move bound from the actual graph', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    fillBoard(g);
    // Only link east on the bottom row.
    for (let x = 0; x < 7; x++) g.connect(g.at(x, 0)!.id, 'east', g.at(x + 1, 0)!.id);
    const start = g.at(0, 0)!;
    expect(g.kingMovesFrom(0, 0).length).toBe(3);
    expect(g.neighborsOf(start.id).length).toBe(1);
  });

  it('audits a fully connected board as clean', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    fillBoard(g);
    connectAllKingMoves(g);
    const a = g.audit();
    expect(a.nodes).toBe(64);
    expect(a.problems).toEqual([]);
    // Directed edges: 2 × undirected. Undirected = 2×(7×8) orthogonal + 2×(7×7) diagonal.
    expect(a.edges).toBe(2 * (2 * 7 * 8 + 2 * 7 * 7));
  });
});

describe('A* pathfinding (spec §22)', () => {
  it('finds the 7-move diagonal on an open board', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    fillBoard(g);
    connectAllKingMoves(g);
    const path = g.findPath(g.at(0, 0)!.id, g.at(7, 7)!.id)!;
    expect(path.nodes.length).toBe(8);
    expect(path.nodes[0].number).toBe(1);
    expect(path.nodes[7].number).toBe(64);
    expect(path.distance).toBeCloseTo(7 * Math.SQRT2 * 25, 6);
    // Chebyshev bound is 7 moves; the optimum must match it.
    expect(chebyshev({ x: 0, y: 0 }, { x: 7, y: 7 })).toBe(7);
  });

  it('returns a trivial path for start == goal', () => {
    const g = new WorldGraph({ width: 4, height: 4, metersPerGridUnit: 10 });
    fillBoard(g);
    connectAllKingMoves(g);
    const p = g.findPath(g.at(1, 1)!.id, g.at(1, 1)!.id)!;
    expect(p.nodes.length).toBe(1);
    expect(p.distance).toBe(0);
  });

  it('returns null when the goal is unreachable', () => {
    const g = new WorldGraph({ width: 6, height: 6, metersPerGridUnit: 10 });
    fillBoard(g);
    // Two isolated islands.
    for (let x = 0; x < 2; x++) g.connect(g.at(x, 0)!.id, 'east', g.at(x + 1, 0)!.id);
    for (let x = 3; x < 5; x++) g.connect(g.at(x, 0)!.id, 'east', g.at(x + 1, 0)!.id);
    expect(g.findPath(g.at(0, 0)!.id, g.at(5, 0)!.id)).toBeNull();
  });

  it('routes around a wall instead of through it', () => {
    const g = new WorldGraph({ width: 7, height: 7, metersPerGridUnit: 10 });
    // Wall down x=3 from y=0..5 with a gap at y=6. Those squares simply do not
    // exist in the graph, so no edge can cross them.
    const blocked = new Set<string>();
    for (let y = 0; y <= 5; y++) blocked.add(`3,${y}`);
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        if (blocked.has(`${x},${y}`)) continue;
        g.add({
          id: `n${indexFor(x, y, 7)}`, gridX: x, gridY: y, panoramaUrl: '', heading: 0, pitch: 0, fov: 90,
          environment: ENV, lighting: LIGHT, validation: VALID, provenance: PROV, connections: {},
        });
      }
    }
    connectAllKingMoves(g);
    expect(g.size).toBe(49 - 6);

    const path = g.findPath(g.at(0, 3)!.id, g.at(6, 3)!.id)!;
    for (const n of path.nodes) expect(blocked.has(`${n.gridX},${n.gridY}`)).toBe(false);
    // The only way across is the gap at (3,6), so the route must pass through it.
    expect(path.nodes.some((n) => n.gridX === 3 && n.gridY === 6)).toBe(true);
    // Diagonals make that detour free, so A* still hits the Chebyshev optimum.
    expect(path.nodes.length - 1).toBe(chebyshev({ x: 0, y: 3 }, { x: 6, y: 3 }));

    // Now close the gap entirely: the two halves must be disconnected.
    const g2 = new WorldGraph({ width: 7, height: 7, metersPerGridUnit: 10 });
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        if (x === 3) continue; // full wall, no gap
        g2.add({
          id: `m${indexFor(x, y, 7)}`, gridX: x, gridY: y, panoramaUrl: '', heading: 0, pitch: 0, fov: 90,
          environment: ENV, lighting: LIGHT, validation: VALID, provenance: PROV, connections: {},
        });
      }
    }
    connectAllKingMoves(g2);
    expect(g2.findPath(g2.at(0, 3)!.id, g2.at(6, 3)!.id)).toBeNull();
  });

  it('never overestimates: A* cost equals the Chebyshev optimum on an open board', () => {
    const g = new WorldGraph({ width: 16, height: 16, metersPerGridUnit: 10 });
    fillBoard(g);
    connectAllKingMoves(g);
    for (const [a, b] of [
      [[0, 0], [15, 15]],
      [[0, 5], [15, 2]],
      [[7, 7], [12, 3]],
    ] as Array<[[number, number], [number, number]]>) {
      const path = g.findPath(g.at(a[0], a[1])!.id, g.at(b[0], b[1])!.id)!;
      const bound = chebyshev({ x: a[0], y: a[1] }, { x: b[0], y: b[1] });
      expect(path.nodes.length - 1).toBe(bound);
    }
  });

  it('reports how many nodes it expanded', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    fillBoard(g);
    connectAllKingMoves(g);
    const path = g.findPath(g.at(0, 0)!.id, g.at(7, 7)!.id)!;
    expect(path.expanded).toBeGreaterThan(0);
    // An admissible heuristic on an open board expands far fewer than all 64.
    expect(path.expanded).toBeLessThan(64);
  });

  it('accumulates distance along the actual edges, not grid steps', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    fillBoard(g);
    for (let x = 0; x < 7; x++) g.connect(g.at(x, 0)!.id, 'east', g.at(x + 1, 0)!.id);
    const p = g.findPath(g.at(0, 0)!.id, g.at(7, 0)!.id)!;
    expect(p.nodes.length).toBe(8);
    expect(p.distance).toBeCloseTo(7 * 25, 9);
    expect(p.travelTime).toBeCloseTo((7 * 25) / 1.4, 9);
  });

  it('scales: finds a path on a 1024-node board', () => {
    const g = new WorldGraph({ width: 32, height: 32, metersPerGridUnit: 25 });
    fillBoard(g);
    connectAllKingMoves(g);
    const t0 = performance.now();
    const p = g.findPath(g.at(0, 0)!.id, g.at(31, 31)!.id)!;
    const ms = performance.now() - t0;
    expect(p.nodes.length).toBe(32);
    expect(ms).toBeLessThan(2000);
  });
});

describe('spatial index (spec §15)', () => {
  it('finds nearby nodes without scanning the world', () => {
    const g = new WorldGraph({ width: 32, height: 32, metersPerGridUnit: 25, cellSize: 8 });
    fillBoard(g);
    const near = g.nearby(16, 16, 2);
    expect(near.length).toBe(25); // 5×5 box
    for (const n of near) expect(chebyshev({ x: n.gridX, y: n.gridY }, { x: 16, y: 16 })).toBeLessThanOrEqual(2);
  });

  it('respects the radius exactly', () => {
    const g = new WorldGraph({ width: 16, height: 16, metersPerGridUnit: 10, cellSize: 4 });
    fillBoard(g);
    expect(g.nearby(8, 8, 0).length).toBe(1);
    expect(g.nearby(8, 8, 1).length).toBe(9);
    expect(g.nearby(8, 8, 3).length).toBe(49);
  });

  it('clips at the board edge', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 10, cellSize: 4 });
    fillBoard(g);
    expect(g.nearby(0, 0, 1).length).toBe(4);
  });

  it('returns nothing for an empty region', () => {
    const g = new WorldGraph({ width: 32, height: 32, metersPerGridUnit: 10, cellSize: 8 });
    // Only populate one corner.
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      g.add({
        id: `n${x}-${y}`, gridX: x, gridY: y, panoramaUrl: '', heading: 0, pitch: 0, fov: 90,
        environment: ENV, lighting: LIGHT, validation: VALID, provenance: PROV, connections: {},
      });
    }
    expect(g.nearby(28, 28, 3).length).toBe(0);
  });
});

describe('landmarks (spec §19, §35)', () => {
  it('shrinks the landmark distance monotonically as you approach', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    fillBoard(g);
    connectAllKingMoves(g);
    g.addLandmark({ id: 'church', name: 'The Church', gridX: 7, gridY: 7, kind: 'church' });
    const path = g.findPath(g.at(0, 0)!.id, g.at(7, 7)!.id)!;
    const distances = path.nodes.map((n) => g.landmarkVector(n.id, 'church')!.meters);
    expect(distances[0]).toBeCloseTo(Math.hypot(7, 7) * 25, 6);
    expect(distances[distances.length - 1]).toBe(0);
    for (let i = 1; i < distances.length; i++) expect(distances[i]).toBeLessThan(distances[i - 1]);
  });

  it('reports a compass bearing to the landmark', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    fillBoard(g);
    g.addLandmark({ id: 'church', name: 'Church', gridX: 4, gridY: 4, kind: 'church' });
    expect(g.landmarkVector(g.at(4, 0)!.id, 'church')!.bearingDeg).toBeCloseTo(0, 6);
    expect(g.landmarkVector(g.at(0, 4)!.id, 'church')!.bearingDeg).toBeCloseTo(90, 6);
    expect(g.landmarkVector(g.at(0, 0)!.id, 'church')!.bearingDeg).toBeCloseTo(45, 6);
    expect(g.landmarkVector(g.at(4, 7)!.id, 'church')!.bearingDeg).toBeCloseTo(180, 6);
  });

  it('returns null for unknown node or landmark', () => {
    const g = new WorldGraph({ width: 4, height: 4, metersPerGridUnit: 10 });
    fillBoard(g);
    expect(g.landmarkVector('ghost', 'church')).toBeNull();
    expect(g.landmarkVector(g.at(0, 0)!.id, 'ghost')).toBeNull();
  });
});

describe('connectivity audit', () => {
  it('detects an unreachable region', () => {
    const g = new WorldGraph({ width: 6, height: 6, metersPerGridUnit: 10 });
    fillBoard(g);
    for (let x = 0; x < 2; x++) g.connect(g.at(x, 0)!.id, 'east', g.at(x + 1, 0)!.id);
    const r = g.isConnected(g.at(0, 0)!.id);
    expect(r.connected).toBe(false);
    expect(r.reached).toBe(3);
    expect(r.unreachable.length).toBe(33);
  });

  it('reports a fully connected open board as connected', () => {
    const g = new WorldGraph({ width: 8, height: 8, metersPerGridUnit: 25 });
    fillBoard(g);
    connectAllKingMoves(g);
    const r = g.isConnected(g.at(0, 0)!.id);
    expect(r.connected).toBe(true);
    expect(r.reached).toBe(64);
    expect(r.unreachable).toEqual([]);
  });
});

describe('manifest', () => {
  it('serialises dimensions, scale and every node', () => {
    const g = new WorldGraph({ width: 4, height: 4, metersPerGridUnit: 30 });
    fillBoard(g);
    g.addLandmark({ id: 'l1', name: 'Church', gridX: 3, gridY: 3, kind: 'church' });
    const json = g.toJSON() as { dimensions: { width: number; height: number }; metersPerGridUnit: number; nodes: unknown[]; landmarks: unknown[] };
    expect(json.dimensions).toEqual({ width: 4, height: 4 });
    expect(json.metersPerGridUnit).toBe(30);
    expect(json.nodes.length).toBe(16);
    expect(json.landmarks.length).toBe(1);
  });
});
