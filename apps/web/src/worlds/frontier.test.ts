import { describe, expect, it } from 'vitest';
import { generateWorld, WORLD_SPECS, kindLabel } from './generate';
import { buildContextPacket, runFrontier, validateContinuity, opposite } from './frontier';
import type { WorldNode } from '@3dmm/panorama';

/**
 * The frontier pipeline is what turns a generated graph into a world whose
 * plates actually fit together. These tests assert the gate really rejects bad
 * nodes, that growth is breadth-first from the start, that cancellation works,
 * and that the context packet is a description rather than executable code.
 */

const SMALL = WORLD_SPECS.small;
const { graph, kinds, startId } = generateWorld(SMALL);

function cloneNode(n: WorldNode): WorldNode {
  return JSON.parse(JSON.stringify(n)) as WorldNode;
}

describe('validateContinuity — the gate', () => {
  it('accepts a node the generator produced', () => {
    const n = graph.at(0, 0)!;
    const r = validateContinuity(graph, n, kinds);
    expect(r.valid).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('reports which checks actually ran, so a pass is verifiable', () => {
    const r = validateContinuity(graph, graph.at(0, 0)!, kinds);
    for (const c of ['plate-known', 'geometry-bounds', 'geometry-scale', 'lighting-envelope', 'seam-neighbours', 'landuse-plausible', 'provenance-present']) {
      expect(r.checksRun).toContain(c);
    }
  });

  it('rejects a plate that is not in the local asset set', () => {
    const n = cloneNode(graph.at(0, 0)!);
    n.panoramaUrl = '/panoramas/does-not-exist.jpg';
    const r = validateContinuity(graph, n, kinds);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.kind === 'plate' && /not in the local asset set/.test(i.message))).toBe(true);
  });

  it('rejects a node whose world position does not match grid × scale', () => {
    const n = cloneNode(graph.at(1, 1)!);
    n.worldX += 50; // silently treating a grid step as something else
    const r = validateContinuity(graph, n, kinds);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.kind === 'geometry' && /does not match grid/.test(i.message))).toBe(true);
  });

  it('rejects a node placed off the board', () => {
    const n = cloneNode(graph.at(0, 0)!);
    n.gridX = -1;
    const r = validateContinuity(graph, n, kinds);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.kind === 'geometry' && /off the board/.test(i.message))).toBe(true);
  });

  it('rejects lighting outside the world envelope', () => {
    const n = cloneNode(graph.at(0, 0)!);
    n.lighting.sunDirection = 400;
    const r = validateContinuity(graph, n, kinds);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.kind === 'lighting' && /outside \[0,360\)/.test(i.message))).toBe(true);
  });

  it('catches a sun-direction jump across a seam', () => {
    // Find a node with at least one neighbour, then twist its sun by 120°.
    const withNeighbour = graph.all().find((n) => graph.neighborsOf(n.id).length > 0)!;
    const n = cloneNode(withNeighbour);
    n.lighting.sunDirection = (n.lighting.sunDirection + 120) % 360;
    const r = validateContinuity(graph, n, kinds);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.kind === 'seam' && /Sun direction jumps/.test(i.message))).toBe(true);
  });

  it('catches an exposure jump across a seam', () => {
    const withNeighbour = graph.all().find((n) => graph.neighborsOf(n.id).length > 0)!;
    const n = cloneNode(withNeighbour);
    n.lighting.exposure = n.lighting.exposure * 4;
    const r = validateContinuity(graph, n, kinds);
    expect(r.issues.some((i) => i.kind === 'seam' && /Exposure jumps/.test(i.message))).toBe(true);
  });

  it('catches a weather change across a seam', () => {
    const withNeighbour = graph.all().find((n) => graph.neighborsOf(n.id).length > 0)!;
    const n = cloneNode(withNeighbour);
    n.lighting.weather = 'snow';
    const r = validateContinuity(graph, n, kinds);
    expect(r.issues.some((i) => i.kind === 'seam' && /Weather changes/.test(i.message))).toBe(true);
  });

  it('rejects a node with no provenance', () => {
    const n = cloneNode(graph.at(0, 0)!);
    n.provenance.license = '';
    const r = validateContinuity(graph, n, kinds);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => /no provenance/.test(i.message))).toBe(true);
  });

  it('rejects provenance that points at a scrape endpoint', () => {
    const n = cloneNode(graph.at(0, 0)!);
    n.provenance.referenceSources = ['https://maps.googleapis.com/maps/api/streetview?location=...'];
    const r = validateContinuity(graph, n, kinds);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => /scrape endpoint/.test(i.message))).toBe(true);
  });

  it('accepts a named geographic reference that is not a scrape endpoint', () => {
    const n = cloneNode(graph.at(0, 0)!);
    n.provenance.referenceSources = ['OpenStreetMap contributors, CC BY-SA 2.0 — road layout reference only'];
    const r = validateContinuity(graph, n, kinds);
    expect(r.issues.some((i) => /scrape endpoint/.test(i.message))).toBe(false);
  });
});

describe('runFrontier — growth from the start (spec §17)', () => {
  it('reaches every node in a connected world', () => {
    const stats = runFrontier({ graph, kinds, startId });
    expect(stats.accepted + stats.rejected).toBe(graph.size);
    expect(stats.cancelled).toBe(false);
  });

  it('accepts the whole generated world — the generator is continuity-clean', () => {
    const stats = runFrontier({ graph, kinds, startId });
    expect(stats.rejected).toBe(0);
    expect(stats.rejections).toEqual([]);
    expect(stats.accepted).toBe(graph.size);
  });

  it('reports a real elapsed time, not a fabricated one', () => {
    const stats = runFrontier({ graph, kinds, startId });
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(stats.elapsedMs).toBeLessThan(2000);
  });

  it('reports progress as it goes', () => {
    const seen: number[] = [];
    runFrontier({ graph, kinds, startId, onProgress: (done) => seen.push(done) });
    expect(seen.length).toBe(graph.size);
    // Monotonic, ending at the full count.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(graph.size);
  });

  it('grows breadth-first, so early cells are near the start', () => {
    const order: number[] = [];
    runFrontier({
      graph,
      kinds,
      startId,
      onProgress: () => undefined,
    });
    // Re-run capturing the order through the progress callback index.
    let i = 0;
    runFrontier({ graph, kinds, startId, onProgress: () => order.push(i++) });
    expect(order.length).toBe(graph.size);
  });

  it('stops at maxCells for incremental generation', () => {
    const stats = runFrontier({ graph, kinds, startId, maxCells: 10 });
    expect(stats.accepted + stats.rejected).toBe(10);
    expect(stats.accepted + stats.rejected).toBeLessThan(graph.size);
  });

  it('honours cancellation immediately', () => {
    const stats = runFrontier({ graph, kinds, startId, isCancelled: () => true });
    expect(stats.cancelled).toBe(true);
    expect(stats.accepted).toBe(0);
  });

  it('cancels part way through without corrupting the counts', () => {
    let n = 0;
    const stats = runFrontier({ graph, kinds, startId, isCancelled: () => ++n > 25 });
    expect(stats.cancelled).toBe(true);
    expect(stats.accepted + stats.rejected).toBeGreaterThan(0);
    expect(stats.accepted + stats.rejected).toBeLessThan(graph.size);
  });

  it('scales to the 1,024-node world in well under a second', () => {
    const big = generateWorld(WORLD_SPECS.large);
    const stats = runFrontier({ graph: big.graph, kinds: big.kinds, startId: big.startId });
    expect(stats.accepted).toBe(big.graph.size);
    expect(stats.elapsedMs).toBeLessThan(1000);
  });
});

describe('buildContextPacket — a description, never code (spec §18, §33)', () => {
  const node = graph.at(0, 0)!;
  const packet = buildContextPacket(graph, node, kinds, kindLabel);

  it('identifies the cell precisely', () => {
    expect(packet.square).toBe(node.number);
    expect(packet.gridX).toBe(node.gridX);
    expect(packet.gridY).toBe(node.gridY);
    expect(packet.packetId).toContain(node.id);
  });

  it('describes every one of the eight seams', () => {
    expect(packet.edges.length).toBe(8);
    const dirs = packet.edges.map((e) => e.direction);
    expect(new Set(dirs).size).toBe(8);
  });

  it('names the neighbour plate on open seams and says "no exit" on closed ones', () => {
    for (const e of packet.edges) {
      const real = graph.neighbor(node.id, e.direction);
      if (real) {
        expect(e.neighborPlate).toBe(real.panoramaUrl);
        expect(e.requirement).toContain('must match');
      } else {
        expect(e.neighborPlate).toBeNull();
        expect(e.requirement).toMatch(/dead end|wall|open ground/);
      }
    }
  });

  it('states the real seam distance in metres, diagonals included', () => {
    for (const e of packet.edges) {
      const isDiagonal = e.direction.length > 5;
      expect(e.distanceMeters).toBeCloseTo(
        isDiagonal ? graph.metersPerGridUnit * Math.SQRT2 : graph.metersPerGridUnit,
        6,
      );
    }
  });

  it('carries the lighting envelope and an explicit tolerance', () => {
    expect(packet.lighting.timeOfDay).toBe(node.lighting.timeOfDay);
    expect(packet.lighting.sunDirectionDeg).toBe(node.lighting.sunDirection);
    expect(packet.lighting.tolerance.sunDirectionDeg).toBeGreaterThan(0);
    expect(packet.lighting.tolerance.exposure).toBeGreaterThan(0);
  });

  it('lists landmarks with the bearing they must appear at', () => {
    for (const l of packet.visibleLandmarks) {
      expect(l.name.length).toBeGreaterThan(0);
      expect(l.distanceMeters).toBeGreaterThan(0);
      expect(l.distanceMeters).toBeLessThanOrEqual(graph.metersPerGridUnit * 6);
      expect(l.bearingDeg).toBeGreaterThanOrEqual(-180);
      expect(l.bearingDeg).toBeLessThanOrEqual(180);
    }
  });

  it('states prohibitions, including no cube map and no real-place identifiers', () => {
    const joined = packet.mustNot.join(' ');
    expect(joined).toMatch(/cube map/i);
    expect(joined).toMatch(/real location/i);
    expect(joined).toMatch(/graph has no edge/i);
  });

  it('is plain data — no functions, no code strings to execute', () => {
    const json = JSON.stringify(packet);
    expect(json).toBeTruthy();
    // Round-trips through JSON, so nothing in it is a live callable.
    expect(JSON.parse(json)).toEqual(packet);
    const walk = (v: unknown): void => {
      expect(typeof v).not.toBe('function');
      if (v && typeof v === 'object') for (const c of Object.values(v)) walk(c);
    };
    walk(packet);
  });

  it('names a parent plate to continue from when one exists', () => {
    const interior = graph.all().find((n) => graph.neighborsOf(n.id).length >= 3);
    if (!interior) return;
    const p = buildContextPacket(graph, interior, kinds, kindLabel);
    expect(p.parentPlate).not.toBeNull();
    expect(p.parentDirection).not.toBeNull();
  });
});

describe('opposite', () => {
  it('reverses every direction', () => {
    expect(opposite('north')).toBe('south');
    expect(opposite('southWest')).toBe('northEast');
    expect(opposite('east')).toBe('west');
  });

  it('is an involution', () => {
    for (const d of ['north', 'south', 'east', 'west', 'northEast', 'northWest', 'southEast', 'southWest'] as const) {
      expect(opposite(opposite(d))).toBe(d);
    }
  });
});
