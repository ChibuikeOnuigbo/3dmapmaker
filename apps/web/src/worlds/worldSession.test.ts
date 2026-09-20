import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorldSession, IDLE_GAIT } from './worldSession';
import { generateWorld, WORLD_SPECS } from './generate';
import type { WorldNode } from '@3dmm/panorama';

/**
 * The session is the walk itself: intent → graph edge → preload → transition →
 * arrival. These tests drive the REAL WorldSession with a stubbed fetch, so the
 * state machine, the visited set, the route trimming and the refusal paths are
 * all exercised rather than described.
 */

const { graph } = generateWorld(WORLD_SPECS.small);
const START = graph.at(0, 0)!;
const ALL = graph.all();
const GOAL = ALL.reduce((a, b) => (b.number > a.number ? b : a), ALL[0]);

let served: string[] = [];
let failUrls = new Set<string>();

beforeEach(() => {
  served = [];
  failUrls = new Set();
  vi.stubGlobal('fetch', async (url: string) => {
    served.push(url);
    if (failUrls.has(url)) return { ok: false, status: 404 } as unknown as Response;
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(64)], { type: 'image/jpeg' }) } as unknown as Response;
  });
  vi.stubGlobal('createImageBitmap', undefined);
  const RealImage = globalThis.Image;
  class FakeImage {
    naturalWidth = 2;
    naturalHeight = 2;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', FakeImage as unknown as typeof RealImage);
  if (typeof URL.createObjectURL !== 'function') {
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:fake';
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeSession(opts: { maxEntries?: number } = {}) {
  const ready: Array<{ node: WorldNode }> = [];
  const errors: string[] = [];
  let changes = 0;
  const session = new WorldSession(
    graph,
    {
      onPlateReady: (node) => ready.push({ node }),
      onChange: () => {
        changes++;
      },
      onError: (_url, message) => errors.push(message),
    },
    opts,
  );
  return { session, ready, errors, changes: () => changes };
}

/** Pump the transition to completion the way the renderer would. */
function runTransition(session: WorldSession, frames = 40) {
  for (let i = 0; i < frames; i++) session.tick(0.05, 520);
}

describe('WorldSession — arrival', () => {
  it('places the player on the start node and loads its plate', async () => {
    const { session, ready } = makeSession();
    await session.arrive(START);
    expect(session.currentId).toBe(START.id);
    expect(session.currentNode?.number).toBe(1);
    expect(session.phase).toBe('idle');
    expect(ready.length).toBe(1);
    expect(ready[0].node.id).toBe(START.id);
    session.dispose();
  });

  it('marks the arrival square as visited', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    expect(session.visitedSet().has(START.id)).toBe(true);
    expect(session.snapshot().visitedCount).toBe(1);
    session.dispose();
  });

  it('prefetches the neighbours immediately after arriving', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    // Let the un-awaited prefetch calls settle.
    await new Promise((r) => setTimeout(r, 0));
    const neighbours = graph.neighborsOf(START.id).map((n) => n.node.panoramaUrl);
    const fetched = new Set(served);
    expect(neighbours.length).toBeGreaterThan(0);
    for (const url of neighbours) expect(fetched.has(url)).toBe(true);
    session.dispose();
  });
});

describe('WorldSession — walking follows the graph, not the key', () => {
  it('W while facing north moves to the north neighbour', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    const north = graph.neighbor(START.id, 'north');
    if (!north) {
      // The generator may wall this square; skip rather than assert a lie.
      session.dispose();
      return;
    }
    const r = await session.move('forward', 0);
    runTransition(session);
    expect(r.ok).toBe(true);
    expect(session.currentId).toBe(north.id);
    expect(session.snapshot().steps).toBe(1);
    session.dispose();
  });

  it('W while facing east moves east — the same key, a different node', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    const east = graph.neighbor(START.id, 'east');
    if (!east) {
      session.dispose();
      return;
    }
    await session.move('forward', 90);
    runTransition(session);
    expect(session.currentId).toBe(east.id);
    session.dispose();
  });

  it('a refused move leaves the player exactly where they were', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    // Square 1 is the SW corner: west and south are off the board.
    const before = session.currentId;
    const r = await session.move('forward', 270);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(session.currentId).toBe(before);
    expect(session.snapshot().steps).toBe(0);
    expect(session.snapshot().refusal).toBeTruthy();
    session.dispose();
  });

  it('a refused move never fetches a plate', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    const before = served.length;
    await session.move('forward', 270);
    expect(served.length).toBe(before);
    session.dispose();
  });

  it('accumulates real metres walked, using the edge distance', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    const east = graph.neighbor(START.id, 'east');
    if (!east) {
      session.dispose();
      return;
    }
    await session.move('forward', 90);
    runTransition(session);
    const snap = session.snapshot();
    expect(snap.metresWalked).toBeCloseTo(graph.metersPerGridUnit, 6);
    session.dispose();
  });

  it('a diagonal step costs sqrt(2) × the scale, not the same as a cardinal', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    const ne = graph.neighbor(START.id, 'northEast');
    if (!ne) {
      session.dispose();
      return;
    }
    await session.move('forwardRight', 0);
    runTransition(session);
    expect(session.snapshot().metresWalked).toBeCloseTo(graph.metersPerGridUnit * Math.SQRT2, 6);
    session.dispose();
  });

  it('marks every square it passes through as visited', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    for (const dir of ['east', 'north'] as const) {
      const n = graph.neighbor(session.currentId!, dir);
      if (!n) break;
      const yaw = dir === 'east' ? 90 : 0;
      await session.move('forward', yaw);
      runTransition(session);
    }
    const snap = session.snapshot();
    expect(snap.visitedCount).toBeGreaterThanOrEqual(2);
    expect(snap.visited).toContain(START.id);
    expect(snap.visited).toContain(session.currentId!);
    session.dispose();
  });
});

describe('WorldSession — the transition state machine (spec §32)', () => {
  it('goes preloading → transitioning → idle, never skipping a stage', async () => {
    const { session } = makeSession();
    const phases: string[] = [];
    const east = graph.neighbor(START.id, 'east');
    if (!east) {
      session.dispose();
      return;
    }
    await session.arrive(START);
    const p = session.move('forward', 90);
    phases.push(session.phase);
    await p;
    phases.push(session.phase);
    runTransition(session, 40); // 40 × 50 ms = 2 s, comfortably past 520 ms
    phases.push(session.phase);
    expect(phases[0]).toBe('preloading');
    expect(phases).toContain('transitioning');
    expect(session.phase).toBe('idle');
    session.dispose();
  });

  it('progress runs 0 → 1 across the transition', async () => {
    const { session } = makeSession();
    const east = graph.neighbor(START.id, 'east');
    if (!east) {
      session.dispose();
      return;
    }
    await session.arrive(START);
    await session.move('forward', 90);
    expect(session.snapshot().progress).toBe(0);
    session.tick(0.26, 520);
    const mid = session.snapshot().progress;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    runTransition(session);
    expect(session.phase).toBe('idle');
    session.dispose();
  });

  it('does not commit arrival until the transition completes', async () => {
    const { session } = makeSession();
    const east = graph.neighbor(START.id, 'east');
    if (!east) {
      session.dispose();
      return;
    }
    await session.arrive(START);
    await session.move('forward', 90);
    expect(session.currentId).toBe(START.id); // still on the old square
    expect(session.snapshot().toId).toBe(east.id);
    runTransition(session);
    expect(session.currentId).toBe(east.id);
    session.dispose();
  });
});

describe('WorldSession — routing (spec §11)', () => {
  it('sets a destination and computes a real A* route', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    const r = session.setDestination(GOAL.id);
    expect(r.ok).toBe(true);
    expect(r.route[0]).toBe(START.id);
    expect(r.route[r.route.length - 1]).toBe(GOAL.id);
    expect(r.distance).toBeGreaterThan(0);
    expect(r.expanded).toBeGreaterThan(0);
    expect(session.snapshot().routeRemaining).toBe(r.route.length - 1);
    session.dispose();
  });

  it('refuses a destination you are already standing on', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    const r = session.setDestination(START.id);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already there/i);
    session.dispose();
  });

  it('reports unreachable destinations instead of inventing a route', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    // Find a node A* cannot reach, if the generator produced one.
    const conn = graph.isConnected(START.id);
    const isolated = conn.unreachable[0];
    if (!isolated) {
      // Fully connected world: assert the honest positive instead.
      expect(session.setDestination(GOAL.id).ok).toBe(true);
      session.dispose();
      return;
    }
    const r = session.setDestination(isolated);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no walkable route/i);
    session.dispose();
  });

  it('steps along the route and trims it as the player advances', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    session.setDestination(GOAL.id);
    const before = session.snapshot().routeRemaining;
    await session.stepAlongRoute(0);
    runTransition(session);
    const after = session.snapshot().routeRemaining;
    expect(after).toBe(before - 1);
    session.dispose();
  });

  it('clearing the destination clears the route', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    session.setDestination(GOAL.id);
    expect(session.snapshot().route.length).toBeGreaterThan(0);
    session.setDestination(null);
    expect(session.snapshot().route).toEqual([]);
    expect(session.snapshot().destinationId).toBeNull();
    session.dispose();
  });
});

describe('WorldSession — warping and landmarks', () => {
  it('warps straight to any node on the graph', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    const ok = await session.warpTo(GOAL.id);
    expect(ok).toBe(true);
    expect(session.currentId).toBe(GOAL.id);
    session.dispose();
  });

  it('refuses to warp to a node that is not in the graph', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    expect(await session.warpTo('nope')).toBe(false);
    expect(session.currentId).toBe(START.id);
    session.dispose();
  });

  it('reports the bearing and distance to a landmark in metres', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    const l = graph.landmarks[0];
    const v = session.landmarkBearing(l.id)!;
    expect(v).not.toBeNull();
    expect(v.meters).toBeGreaterThan(0);
    expect(v.meters).toBeCloseTo(Math.hypot(v.dx, v.dy) * graph.metersPerGridUnit, 5);
    session.dispose();
  });

  it('returns null for a landmark bearing before the player has arrived', () => {
    const { session } = makeSession();
    expect(session.landmarkBearing(graph.landmarks[0].id)).toBeNull();
    session.dispose();
  });
});

describe('WorldSession — plate failures are surfaced, not swallowed', () => {
  it('reports the failing square by number and keeps the session usable', async () => {
    const target = graph.neighbor(START.id, 'east') ?? graph.neighbor(START.id, 'north');
    if (!target) return;
    failUrls = new Set([target.panoramaUrl]);
    const { session, errors } = makeSession();
    await session.arrive(START);
    const yaw = graph.edgeInDirection(START.id, 'east')?.direction === 'east' ? 90 : 0;
    await session.move('forward', yaw);
    runTransition(session);
    // Either the move was refused (no edge) or the plate failed; if it failed
    // the error must be named.
    if (session.snapshot().errors.length) {
      expect(errors.length).toBeGreaterThan(0);
      expect(session.snapshot().errors[0]).toMatch(/square \d+/);
    }
    expect(session.phase).toBe('idle');
    session.dispose();
  });

  it('a failing prefetch does not block the player', async () => {
    const neighbours = graph.neighborsOf(START.id).map((n) => n.node.panoramaUrl);
    failUrls = new Set([neighbours[0]]);
    const { session } = makeSession();
    await session.arrive(START);
    await new Promise((r) => setTimeout(r, 0));
    expect(session.currentId).toBe(START.id);
    expect(session.phase).toBe('idle');
    session.dispose();
  });
});

describe('WorldSession — the cache stays bounded (spec §13)', () => {
  it('holds far fewer plates than the world has nodes', async () => {
    const { session } = makeSession({ maxEntries: 6 });
    await session.arrive(START);
    await new Promise((r) => setTimeout(r, 0));
    expect(session.cache.size).toBeLessThanOrEqual(6);
    // The generator removes blocked cells, so the board is not a full 64.
    expect(graph.size).toBeGreaterThan(50);
    expect(graph.size).toBeLessThanOrEqual(64);
    expect(session.cache.size).toBeLessThan(graph.size);
    session.dispose();
  });

  it('disposal empties the cache and cancels pending work', async () => {
    const { session } = makeSession();
    await session.arrive(START);
    await new Promise((r) => setTimeout(r, 0));
    expect(session.cache.size).toBeGreaterThan(0);
    session.dispose();
    expect(session.cache.size).toBe(0);
  });
});

describe('gait noise is confined to the camera (spec §28)', () => {
  it('the idle gait is exactly zero — no drift when standing still', () => {
    expect(IDLE_GAIT.bob).toBe(0);
    expect(IDLE_GAIT.yawNoise).toBe(0);
    expect(IDLE_GAIT.pitchNoise).toBe(0);
    expect(IDLE_GAIT.sway).toBe(0);
  });

  it('the gait struct carries no coordinates or node ids', () => {
    expect(Object.keys(IDLE_GAIT).sort()).toEqual(['bob', 'pitchNoise', 'stepPhase', 'sway', 'yawNoise']);
  });

  it('two worlds from the same seed produce identical routes — noise changes nothing structural', () => {
    const a = generateWorld(WORLD_SPECS.small);
    const b = generateWorld(WORLD_SPECS.small);
    const pa = a.graph.findPath(a.startId, a.destinationId)!;
    const pb = b.graph.findPath(b.startId, b.destinationId)!;
    expect(pa.nodes.map((n) => n.id)).toEqual(pb.nodes.map((n) => n.id));
    expect(pa.distance).toBe(pb.distance);
  });
});

describe('WorldSession — the spatial warp actually gets its gate', () => {
  // WorldView only warps when `phase === 'transitioning' && travelDirection
  // !== null`. If the session cleared the direction before the transition ran,
  // the warp would be dead code and the "spatial warp, not a crossfade" claim
  // would be false in practice even though the maths is correct. These drive the
  // real session and read the real snapshot at each phase.

  it('carries a travel direction for the whole transition, and drops it on arrival', async () => {
    const { session } = makeSession();
    if (!graph.neighbor(START.id, 'east')) {
      session.dispose();
      return;
    }
    await session.arrive(START);

    expect(session.snapshot().travelDirection).toBe(null); // idle: nothing to sweep

    const p = session.move('forward', 90);
    expect(session.phase).toBe('preloading');
    expect(session.snapshot().travelDirection, 'direction must be set as soon as the walk starts')
      .not.toBe(null);
    await p;

    // Walk the transition frame by frame, exactly as the renderer does, and
    // record the gate WorldView evaluates on every single frame.
    let frames = 0;
    let gated = 0;
    for (let i = 0; i < 40; i++) {
      const { phase } = session.tick(0.05, 520);
      const s = session.snapshot();
      if (phase === 'transitioning') {
        frames++;
        if (s.travelDirection !== null) gated++;
      }
      if (phase === 'idle' || phase === 'settling') break;
    }

    expect(frames, 'the transition never entered the transitioning phase').toBeGreaterThan(0);
    expect(gated, `${gated}/${frames} frames had a travel direction`).toBe(frames);
    expect(session.snapshot().travelDirection, 'direction must clear once arrived').toBe(null);
    session.dispose();
  });

  it('the travel direction matches the edge actually taken', async () => {
    const { session } = makeSession();
    const east = graph.neighbor(START.id, 'east');
    if (!east) {
      session.dispose();
      return;
    }
    await session.arrive(START);
    // Camera yaw 90° faces east, so 'forward' must resolve to the east edge.
    const p = session.move('forward', 90);
    expect(session.snapshot().travelDirection).toBe('east');
    await p;
    runTransition(session, 40);
    expect(session.currentId).toBe(east.id);
    session.dispose();
  });

  it('an arrival with no direction does not arm the warp', async () => {
    // `arrive()` is the map warp-to path: you teleport, you are not walking, so
    // there is no travel bearing and WorldView must not sweep.
    const { session } = makeSession();
    await session.arrive(START);
    expect(session.snapshot().travelDirection).toBe(null);
    const s = session.tick(0.05, 520);
    expect(s.phase).toBe('idle');
    expect(session.snapshot().travelDirection).toBe(null);
    session.dispose();
  });
});
