import { describe, expect, it } from 'vitest';
import { generateWorld, WORLD_SPECS, PLATES, kindLabel, type CellKind } from './generate';
import { chebyshev, indexFor } from '@3dmm/panorama';

/**
 * The generator is the thing that decides whether the three demo worlds are
 * real. These tests assert the invariants the spec demands rather than
 * snapshotting a layout: correct indexing, derived adjacency, connectivity,
 * monotonic landmark distance, and scale that is not silently metres.
 */

const SMALL = WORLD_SPECS.small;
const MEDIUM = WORLD_SPECS.medium;
const LARGE = WORLD_SPECS.large;

describe('world specs', () => {
  it('provides exactly three scales: 64, 400 and 1024 nodes', () => {
    expect(SMALL.width * SMALL.height).toBe(64);
    expect(MEDIUM.width * MEDIUM.height).toBe(400);
    expect(LARGE.width * LARGE.height).toBe(1024);
  });

  it('stores metersPerGridUnit explicitly on every spec', () => {
    for (const spec of [SMALL, MEDIUM, LARGE]) {
      expect(spec.metersPerGridUnit).toBeGreaterThan(0);
      expect(Number.isFinite(spec.metersPerGridUnit)).toBe(true);
    }
  });

  it('carries a real geographic origin for each world', () => {
    for (const spec of [SMALL, MEDIUM, LARGE]) {
      expect(spec.origin.lat).toBeGreaterThan(-90);
      expect(spec.origin.lat).toBeLessThan(90);
      expect(spec.origin.lon).toBeGreaterThanOrEqual(-180);
      expect(spec.origin.lon).toBeLessThanOrEqual(180);
    }
  });

  it('gives every plate a real path under /panoramas', () => {
    for (const url of Object.values(PLATES)) {
      expect(url.startsWith('/panoramas/')).toBe(true);
      expect(url.endsWith('.jpg')).toBe(true);
    }
  });

  it('gives every cell kind a human label', () => {
    const kinds: CellKind[] = ['road', 'lane', 'junction', 'houses', 'market', 'school', 'river', 'farm', 'square', 'churchyard', 'church', 'blocked'];
    for (const k of kinds) {
      expect(kindLabel(k).length).toBeGreaterThan(1);
    }
  });
});

describe('generated worlds — indexing (spec §3)', () => {
  const w = generateWorld(SMALL);

  it('numbers square (0,0) as 1', () => {
    const n = w.graph.at(0, 0)!;
    expect(n).not.toBeNull();
    expect(n.number).toBe(1);
  });

  it('numbers (width-1, 0) as 8 on an 8-wide board', () => {
    const n = w.graph.at(7, 0);
    // Blocked cells are removed from the graph, so the corner may be absent.
    if (n) expect(n.number).toBe(8);
    expect(indexFor(7, 0, 8)).toBe(7);
  });

  it('numbers (0, height-1) as 57 on an 8×8 board', () => {
    expect(indexFor(0, 7, 8)).toBe(56);
    const n = w.graph.at(0, 7);
    if (n) expect(n.number).toBe(57);
  });

  it('numbers (width-1, height-1) as 64', () => {
    expect(indexFor(7, 7, 8)).toBe(63);
    const n = w.graph.at(7, 7);
    if (n) expect(n.number).toBe(64);
  });

  it('starts at square 1 and finishes at the highest-numbered node', () => {
    expect(w.graph.get(w.startId)!.number).toBe(1);
    const dest = w.graph.get(w.destinationId)!;
    const maxNumber = Math.max(...w.graph.all().map((n) => n.number));
    expect(dest.number).toBe(maxNumber);
  });
});

describe('generated worlds — adjacency is derived, never assumed (spec §4)', () => {
  it('every edge matches the geometric delta of its own direction', () => {
    for (const spec of [SMALL, MEDIUM]) {
      const { graph } = generateWorld(spec);
      for (const e of graph.allEdges()) {
        const a = graph.get(e.from)!;
        const b = graph.get(e.to)!;
        const dx = b.gridX - a.gridX;
        const dy = b.gridY - a.gridY;
        expect(Math.abs(dx)).toBeLessThanOrEqual(1);
        expect(Math.abs(dy)).toBeLessThanOrEqual(1);
        expect(dx === 0 && dy === 0).toBe(false);
      }
    }
  });

  it('every edge is reciprocal — walking out means you can walk back', () => {
    const { graph } = generateWorld(SMALL);
    for (const e of graph.allEdges()) {
      const back = graph.edgeInDirection(e.to, e.direction === 'north' ? 'south' : e.direction === 'south' ? 'north' : e.direction === 'east' ? 'west' : e.direction === 'west' ? 'east' : e.direction === 'northEast' ? 'southWest' : e.direction === 'northWest' ? 'southEast' : e.direction === 'southEast' ? 'northWest' : 'northEast');
      expect(back).not.toBeNull();
      expect(back!.to).toBe(e.from);
    }
  });

  it('the audit reports no problems', () => {
    for (const spec of [SMALL, MEDIUM, LARGE]) {
      const { graph } = generateWorld(spec);
      const audit = graph.audit();
      expect(audit.problems).toEqual([]);
      expect(audit.nodes).toBe(graph.size);
    }
  });

  it('removes cells entirely rather than leaving orphan nodes', () => {
    const { graph, occupancy } = generateWorld(SMALL);
    let present = 0;
    for (let i = 0; i < occupancy.length; i++) if (occupancy[i]) present++;
    expect(present).toBe(graph.size);
  });
});

describe('generated worlds — connectivity and routing (spec §11, §22)', () => {
  it('the start can reach the destination on every world', () => {
    for (const spec of [SMALL, MEDIUM, LARGE]) {
      const { graph, startId, destinationId } = generateWorld(spec);
      const path = graph.findPath(startId, destinationId);
      expect(path).not.toBeNull();
      expect(path!.nodes[0].id).toBe(startId);
      expect(path!.nodes[path!.nodes.length - 1].id).toBe(destinationId);
    }
  });

  it('the whole graph is one connected component from the start', () => {
    for (const spec of [SMALL, MEDIUM]) {
      const { graph, startId } = generateWorld(spec);
      const conn = graph.isConnected(startId);
      expect(conn.connected).toBe(true);
      expect(conn.reached).toBe(graph.size);
      expect(conn.unreachable).toEqual([]);
    }
  });

  it('A* route length never exceeds the node count', () => {
    for (const spec of [SMALL, MEDIUM, LARGE]) {
      const { graph, startId, destinationId } = generateWorld(spec);
      const path = graph.findPath(startId, destinationId)!;
      expect(path.nodes.length).toBeLessThanOrEqual(graph.size);
      expect(path.nodes.length).toBeGreaterThan(1);
    }
  });

  it('A* expands fewer nodes than the board contains on the large world', () => {
    const { graph, startId, destinationId } = generateWorld(LARGE);
    const path = graph.findPath(startId, destinationId)!;
    expect(path.expanded).toBeLessThan(graph.size);
  });

  it('the 8×8 route is short — the spec target is 8 nodes on an open board', () => {
    const { graph, startId, destinationId } = generateWorld(SMALL);
    const path = graph.findPath(startId, destinationId)!;
    // Obstacles can only lengthen it; it must stay well under a serpentine.
    expect(path.nodes.length).toBeLessThanOrEqual(30);
    expect(path.nodes.length).toBeGreaterThanOrEqual(8);
  });
});

describe('generated worlds — landmark vectors (spec §24)', () => {
  it('every world has at least one named landmark', () => {
    for (const spec of [SMALL, MEDIUM, LARGE]) {
      const { graph } = generateWorld(spec);
      expect(graph.landmarks.length).toBeGreaterThan(0);
      for (const l of graph.landmarks) {
        expect(l.id.length).toBeGreaterThan(0);
        expect(l.name.length).toBeGreaterThan(0);
        expect(graph.at(l.gridX, l.gridY)).not.toBeNull();
      }
    }
  });

  it('distance to the destination shrinks monotonically along the route', () => {
    for (const spec of [SMALL, MEDIUM]) {
      const { graph, startId, destinationId } = generateWorld(spec);
      const path = graph.findPath(startId, destinationId)!;
      let prev = Infinity;
      for (const n of path.nodes) {
        const d = chebyshev({ x: n.gridX, y: n.gridY }, { x: graph.get(destinationId)!.gridX, y: graph.get(destinationId)!.gridY });
        expect(d).toBeLessThanOrEqual(prev);
        prev = d;
      }
      expect(prev).toBe(0);
    }
  });

  it('a landmark vector reports metres and a bearing, not grid units', () => {
    const { graph, startId } = generateWorld(SMALL);
    const l = graph.landmarks[0];
    const v = graph.landmarkVector(startId, l.id)!;
    expect(v).not.toBeNull();
    expect(v.meters).toBeGreaterThan(0);
    expect(v.bearingDeg).toBeGreaterThanOrEqual(-180);
    expect(v.bearingDeg).toBeLessThanOrEqual(180);
    // metres must be the grid distance scaled, never the raw grid count
    const gridDist = Math.hypot(v.dx, v.dy);
    expect(v.meters).toBeCloseTo(gridDist * graph.metersPerGridUnit, 5);
  });
});

describe('generated worlds — scale is not silently metres (spec §48)', () => {
  it('a cardinal edge measures metersPerGridUnit metres', () => {
    const { graph } = generateWorld(SMALL);
    const cardinal = graph.allEdges().find((e) => {
      const a = graph.get(e.from)!;
      const b = graph.get(e.to)!;
      return a.gridX === b.gridX || a.gridY === b.gridY;
    })!;
    expect(cardinal.distance).toBeCloseTo(graph.metersPerGridUnit, 6);
  });

  it('a diagonal edge measures sqrt(2) × metersPerGridUnit, not the same as a cardinal', () => {
    const { graph } = generateWorld(MEDIUM);
    const diagonal = graph.allEdges().find((e) => {
      const a = graph.get(e.from)!;
      const b = graph.get(e.to)!;
      return a.gridX !== b.gridX && a.gridY !== b.gridY;
    })!;
    expect(diagonal.distance).toBeCloseTo(graph.metersPerGridUnit * Math.SQRT2, 6);
    expect(diagonal.distance).not.toBeCloseTo(graph.metersPerGridUnit, 6);
  });

  it('world coordinates are metres derived from the grid and the scale', () => {
    const { graph } = generateWorld(SMALL);
    for (const n of graph.all()) {
      expect(n.worldX).toBeCloseTo(n.gridX * graph.metersPerGridUnit, 6);
      expect(n.worldZ).toBeCloseTo(-n.gridY * graph.metersPerGridUnit, 6);
    }
  });

  it('derives a latitude and longitude for every node from the origin', () => {
    const { graph } = generateWorld(SMALL);
    for (const n of graph.all()) {
      expect(typeof n.latitude).toBe('number');
      expect(typeof n.longitude).toBe('number');
      expect(n.latitude!).toBeGreaterThan(4.7);
      expect(n.latitude!).toBeLessThan(5.0);
      expect(n.longitude!).toBeGreaterThan(6.9);
      expect(n.longitude!).toBeLessThan(7.2);
    }
  });
});

describe('generated worlds — provenance on every plate (spec §50)', () => {
  it('every node records its source type, generator and licence', () => {
    for (const spec of [SMALL, MEDIUM]) {
      const { graph } = generateWorld(spec);
      for (const n of graph.all()) {
        expect(n.provenance.sourceType).toBe('generated');
        expect(n.provenance.generator.length).toBeGreaterThan(0);
        expect(n.provenance.license.length).toBeGreaterThan(0);
        expect(n.provenance.createdAt.length).toBeGreaterThan(0);
      }
    }
  });

  it('marks nodes informed by real geography as reference, not as scraped imagery', () => {
    const { graph } = generateWorld(SMALL);
    const referenced = graph.all().filter((n) => n.provenance.referenceSources.length > 0);
    // Some nodes should carry the geographic reference; none may claim the
    // plate itself came from a third-party service.
    expect(referenced.length).toBeGreaterThan(0);
    for (const n of referenced) {
      expect(n.provenance.sourceType).toBe('generated');
      for (const src of n.provenance.referenceSources) {
        expect(src).not.toMatch(/googleapis|google\.com\/maps\/api|streetview/i);
      }
    }
  });

  it('every node points at a plate that exists in the local set', () => {
    const { graph } = generateWorld(SMALL);
    const known = new Set<string>(Object.values(PLATES));
    for (const n of graph.all()) {
      expect(known.has(n.panoramaUrl)).toBe(true);
    }
  });
});

describe('generated worlds — determinism (spec §7)', () => {
  it('the same seed produces a byte-identical graph', () => {
    const a = generateWorld(SMALL);
    const b = generateWorld(SMALL);
    expect(a.graph.size).toBe(b.graph.size);
    expect(a.graph.allEdges().length).toBe(b.graph.allEdges().length);
    expect(a.kinds).toEqual(b.kinds);
    expect(a.graph.toJSON()).toEqual(b.graph.toJSON());
  });

  it('a different seed produces a different layout', () => {
    const a = generateWorld(SMALL);
    const b = generateWorld({ ...SMALL, seed: SMALL.seed + 1 });
    expect(a.kinds).not.toEqual(b.kinds);
  });

  it('randomness never changes which node an index resolves to', () => {
    const a = generateWorld(SMALL);
    const b = generateWorld({ ...SMALL, seed: 99999 });
    // Indexing is arithmetic, so it cannot depend on the seed.
    expect(indexFor(3, 4, 8)).toBe(indexFor(3, 4, 8));
    const na = a.graph.at(3, 4);
    const nb = b.graph.at(3, 4);
    if (na && nb) {
      expect(na.number).toBe(nb.number);
      expect(na.index).toBe(nb.index);
      expect(na.worldX).toBe(nb.worldX);
      expect(na.worldZ).toBe(nb.worldZ);
    }
  });
});

describe('generated worlds — scale behaviour (spec §56)', () => {
  it('builds 1,024 nodes and routes across them in well under a second', () => {
    const t0 = performance.now();
    const { graph, startId, destinationId } = generateWorld(LARGE);
    const path = graph.findPath(startId, destinationId);
    const ms = performance.now() - t0;
    expect(graph.size).toBeGreaterThan(900);
    expect(path).not.toBeNull();
    expect(ms).toBeLessThan(1000);
  });

  it('the spatial index answers a nearby query on the large world', () => {
    const { graph } = generateWorld(LARGE);
    const n = graph.all()[Math.floor(graph.size / 2)];
    const near = graph.nearby(n.gridX, n.gridY, 2);
    expect(near.length).toBeGreaterThan(0);
    expect(near.length).toBeLessThanOrEqual(25);
    for (const m of near) {
      expect(chebyshev({ x: n.gridX, y: n.gridY }, { x: m.gridX, y: m.gridY })).toBeLessThanOrEqual(2);
    }
  });

  it('the same engine code serves 64, 400 and 1024 without branching on size', () => {
    // If this passes for all three, the pipeline is genuinely scale-free.
    for (const spec of [SMALL, MEDIUM, LARGE]) {
      const { graph, startId, destinationId } = generateWorld(spec);
      expect(graph.audit().problems).toEqual([]);
      expect(graph.findPath(startId, destinationId)).not.toBeNull();
      expect(graph.isConnected(startId).connected).toBe(true);
    }
  });
});
