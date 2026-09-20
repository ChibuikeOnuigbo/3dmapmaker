import { describe, expect, it } from 'vitest';
import {
  WorldGraph,
  type WorldNode,
  indexFor,
  idForIndex,
  resolveMovementIntent,
  intentFromKey,
  quantiseToDirection,
  normaliseDegrees,
  headingOnArrival,
  DIRECTION_ABBR,
} from './index';

/**
 * A 3×3 world where the centre is open on every side but the edges are walled,
 * so intent resolution has both success and failure cases to exercise.
 */
function crossWorld(): WorldGraph {
  const g = new WorldGraph({ width: 3, height: 3, metersPerGridUnit: 10 });
  const add = (x: number, y: number) => g.add({ id: String(idForIndex(indexFor(x, y, g.width))), gridX: x, gridY: y, panoramaUrl: '' } as never);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) add(x, y);
  return g;
}

function openWorld(width = 3, height = 3): WorldGraph {
  const g = new WorldGraph({ width, height, metersPerGridUnit: 10 });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      g.add({
        id: String(idForIndex(indexFor(x, y, g.width))),
        gridX: x,
        gridY: y,
        panoramaUrl: `/p/${x}-${y}.jpg`,
        heading: 0,
        pitch: 0,
        fov: 90,
        environment: { terrain: 'urban', roadType: 'road', buildings: [], vegetation: [], landmarks: [] },
        lighting: { timeOfDay: 'day', weather: 'clear', sunDirection: 180, exposure: 1 },
        connections: {},
        validation: { panoramaValid: true, continuityValid: true, geometryValid: true, lightingValid: true },
        provenance: { sourceType: 'generated', referenceSources: [], generator: 'test', createdAt: '', license: 'test' },
      });
    }
  }
  // Wire every king move that stays on the board.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = g.at(x, y)!;
      for (const m of g.kingMovesFrom(x, y)) g.connect(from.id, m.dir, g.at(m.x, m.y)!.id, true);
    }
  }
  return g;
}

describe('normaliseDegrees / quantiseToDirection', () => {
  it('wraps negative and overflowing headings into [0,360)', () => {
    expect(normaliseDegrees(-45)).toBe(315);
    expect(normaliseDegrees(405)).toBe(45);
    expect(normaliseDegrees(360)).toBe(0);
    expect(normaliseDegrees(0)).toBe(0);
  });

  it('snaps a heading to the nearest of the eight compass points', () => {
    expect(quantiseToDirection(0).dir).toBe('north');
    expect(quantiseToDirection(10).dir).toBe('north');
    expect(quantiseToDirection(23).dir).toBe('northEast');
    expect(quantiseToDirection(45).dir).toBe('northEast');
    expect(quantiseToDirection(89).dir).toBe('east');
    expect(quantiseToDirection(179).dir).toBe('south');
    expect(quantiseToDirection(359).dir).toBe('north');
  });

  it('reports how far the intent had to be snapped', () => {
    expect(quantiseToDirection(45).snapDelta).toBeCloseTo(0);
    expect(quantiseToDirection(30).snapDelta).toBeCloseTo(15);
    // 22.5 is the boundary between north and northEast.
    const onBoundary = quantiseToDirection(22.5);
    expect(onBoundary.snapDelta).toBeCloseTo(22.5);
  });

  it('gives every direction a short label', () => {
    expect(DIRECTION_ABBR.north).toBe('N');
    expect(DIRECTION_ABBR.southWest).toBe('SW');
  });
});

describe('intentFromKey', () => {
  it('maps WASD to the four cardinals', () => {
    expect(intentFromKey('w')).toBe('forward');
    expect(intentFromKey('a')).toBe('left');
    expect(intentFromKey('s')).toBe('back');
    expect(intentFromKey('d')).toBe('right');
  });

  it('maps QEZC to the diagonals', () => {
    expect(intentFromKey('q')).toBe('forwardLeft');
    expect(intentFromKey('e')).toBe('forwardRight');
    expect(intentFromKey('z')).toBe('backLeft');
    expect(intentFromKey('c')).toBe('backRight');
  });

  it('accepts arrow keys as an alternative to WASD', () => {
    expect(intentFromKey('ArrowUp')).toBe('forward');
    expect(intentFromKey('ArrowLeft')).toBe('left');
  });

  it('is case-insensitive and returns null for keys it does not own', () => {
    expect(intentFromKey('W')).toBe('forward');
    expect(intentFromKey('f')).toBeNull();
    expect(intentFromKey('Enter')).toBeNull();
    expect(intentFromKey(' ')).toBeNull();
  });
});

describe('resolveMovementIntent — camera-relative, not camera-translating', () => {
  it('W while facing north moves to the north node, and returns an id not a delta', () => {
    const g = openWorld();
    const centre = g.at(1, 1)!;
    const r = resolveMovementIntent(g, centre.id, 'forward', 0);
    expect(r.ok).toBe(true);
    expect(r.direction).toBe('north');
    expect(r.targetId).toBe(g.at(1, 2)!.id);
    // The result carries a node id and a heading — never a position offset.
    expect(r).not.toHaveProperty('deltaX');
    expect(r).not.toHaveProperty('offset');
    expect(typeof r.targetId).toBe('string');
  });

  it('W while facing east moves east, because W is camera-relative', () => {
    const g = openWorld();
    const centre = g.at(1, 1)!;
    const r = resolveMovementIntent(g, centre.id, 'forward', 90);
    expect(r.ok).toBe(true);
    expect(r.direction).toBe('east');
    expect(r.targetId).toBe(g.at(2, 1)!.id);
  });

  it('W while facing south moves south — the same key, three different outcomes', () => {
    const g = openWorld();
    const centre = g.at(1, 1)!;
    expect(resolveMovementIntent(g, centre.id, 'forward', 180).direction).toBe('south');
    expect(resolveMovementIntent(g, centre.id, 'forward', 0).direction).toBe('north');
    expect(resolveMovementIntent(g, centre.id, 'forward', 90).direction).toBe('east');
  });

  it('A is 90° to the LEFT of the camera, D is 90° to the right', () => {
    const g = openWorld();
    const centre = g.at(1, 1)!;
    // Facing north: left is west, right is east.
    expect(resolveMovementIntent(g, centre.id, 'left', 0).direction).toBe('west');
    expect(resolveMovementIntent(g, centre.id, 'right', 0).direction).toBe('east');
    // Facing east: left is north, right is south.
    expect(resolveMovementIntent(g, centre.id, 'left', 90).direction).toBe('north');
    expect(resolveMovementIntent(g, centre.id, 'right', 90).direction).toBe('south');
  });

  it('E is the forward-right diagonal', () => {
    const g = openWorld();
    const centre = g.at(1, 1)!;
    const r = resolveMovementIntent(g, centre.id, 'forwardRight', 0);
    expect(r.ok).toBe(true);
    expect(r.direction).toBe('northEast');
    expect(r.targetId).toBe(g.at(2, 2)!.id);
  });

  it('S walks backwards along the same edge you came from', () => {
    const g = openWorld();
    const centre = g.at(1, 1)!;
    const north = g.at(1, 2)!;
    // Stand on the north node facing north, then press S: you land back on centre.
    const r = resolveMovementIntent(g, north.id, 'back', 0);
    expect(r.ok).toBe(true);
    expect(r.targetId).toBe(centre.id);
  });

  it('quantises a non-compass camera yaw instead of drifting', () => {
    const g = openWorld();
    const centre = g.at(1, 1)!;
    // Camera at 80° — W should resolve to east, the nearest compass point.
    const r = resolveMovementIntent(g, centre.id, 'forward', 80);
    expect(r.direction).toBe('east');
    expect(r.snapDeltaDeg).toBeCloseTo(10);
    expect(r.worldHeadingDeg).toBeCloseTo(80);
  });

  it('reports the world heading it resolved from, for diagnostics', () => {
    const g = openWorld();
    const r = resolveMovementIntent(g, g.at(1, 1)!.id, 'forwardRight', 30);
    expect(r.worldHeadingDeg).toBeCloseTo(75);
    expect(r.cameraYawDeg).toBe(30);
  });
});

describe('resolveMovementIntent — the graph decides, not the key', () => {
  it('fails with a reason when the resolved direction has no edge', () => {
    const g = openWorld();
    const corner = g.at(0, 0)!;
    // Standing in the SW corner facing west: there is nothing west.
    const r = resolveMovementIntent(g, corner.id, 'forward', 270);
    expect(r.ok).toBe(false);
    expect(r.targetId).toBeNull();
    expect(r.direction).toBe('west');
    expect(r.reason).toContain('No W edge');
    expect(r.available).toContain('north');
    expect(r.available).not.toContain('west');
  });

  it('lists the directions that ARE open so the player can recover', () => {
    const g = openWorld();
    const corner = g.at(0, 0)!;
    const r = resolveMovementIntent(g, corner.id, 'forward', 270);
    expect(r.available.sort()).toEqual(['east', 'north', 'northEast'].sort());
  });

  it('never falls back to a different direction when the exact one is missing', () => {
    const g = openWorld(3, 3);
    // Delete the north edge from the centre, then press W while facing north.
    const centre = g.at(1, 1)!;
    const north = g.at(1, 2)!;
    // Rebuild without the north edge.
    const g2 = openWorld(3, 3);
    const c2 = g2.at(1, 1)!;
    g2.connect(c2.id, 'north', g2.at(1, 2)!.id, false); // present but blocked
    const r = resolveMovementIntent(g2, c2.id, 'forward', 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('blocked');
    // It must NOT have quietly used northEast instead.
    expect(r.targetId).toBeNull();
    expect(north).toBeTruthy();
    expect(centre).toBeTruthy();
  });

  it('treats a blocked edge as unavailable', () => {
    const g = openWorld();
    const centre = g.at(1, 1)!;
    g.connect(centre.id, 'east', g.at(2, 1)!.id, false);
    const r = resolveMovementIntent(g, centre.id, 'right', 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked/i);
  });

  it('refuses to move when the current id is not in the graph', () => {
    const g = openWorld();
    const r = resolveMovementIntent(g, 'does-not-exist', 'forward', 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Not standing on a graph node');
  });

  it('a fully enclosed node reports that it has no walkable edges', () => {
    const g = new WorldGraph({ width: 3, height: 3, metersPerGridUnit: 10 });
    const node: Omit<WorldNode, 'number' | 'index' | 'worldX' | 'worldZ'> = {
      id: '5',
      gridX: 1,
      gridY: 1,
      panoramaUrl: '/p.jpg',
      heading: 0,
      pitch: 0,
      fov: 90,
      environment: { terrain: 'urban', roadType: 'road', buildings: [], vegetation: [], landmarks: [] },
      lighting: { timeOfDay: 'day', weather: 'clear', sunDirection: 180, exposure: 1 },
      connections: {},
      validation: { panoramaValid: true, continuityValid: true, geometryValid: true, lightingValid: true },
      provenance: { sourceType: 'generated', referenceSources: [], generator: 't', createdAt: '', license: 't' },
    };
    g.add(node);
    const r = resolveMovementIntent(g, '5', 'forward', 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no walkable edges');
  });
});

describe('headingOnArrival', () => {
  it('preserves the heading the player intended', () => {
    expect(headingOnArrival('forward', 0)).toBe(0);
    expect(headingOnArrival('forward', 350)).toBe(350);
    expect(headingOnArrival('right', 0)).toBe(90);
    expect(headingOnArrival('back', 0)).toBe(180);
    expect(headingOnArrival('forwardLeft', 0)).toBe(315);
  });

  it('wraps rather than producing a negative heading', () => {
    expect(headingOnArrival('left', 0)).toBe(270);
    expect(headingOnArrival('forwardLeft', 20)).toBe(335);
  });

  it('means walking forward twice leaves you facing the same way', () => {
    const first = headingOnArrival('forward', 37);
    expect(first).toBe(37);
    expect(headingOnArrival('forward', first)).toBe(37);
  });
});

describe('intent resolution is deterministic — no randomness in the decision', () => {
  it('the same inputs always produce the same target', () => {
    const g = openWorld(8, 8);
    const start = g.at(3, 3)!;
    const first = resolveMovementIntent(g, start.id, 'forwardRight', 12);
    for (let i = 0; i < 200; i++) {
      const again = resolveMovementIntent(g, start.id, 'forwardRight', 12);
      expect(again.targetId).toBe(first.targetId);
      expect(again.direction).toBe(first.direction);
      expect(again.snapDeltaDeg).toBe(first.snapDeltaDeg);
    }
  });

  it('every one of the eight intents from the centre of an open world reaches the matching neighbour', () => {
    const g = openWorld(5, 5);
    const c = g.at(2, 2)!;
    const cases: Array<[string, number, [number, number]]> = [
      ['forward', 0, [2, 3]],
      ['forwardRight', 0, [3, 3]],
      ['right', 0, [3, 2]],
      ['backRight', 0, [3, 1]],
      ['back', 0, [2, 1]],
      ['backLeft', 0, [1, 1]],
      ['left', 0, [1, 2]],
      ['forwardLeft', 0, [1, 3]],
    ];
    for (const [intent, yaw, [x, y]] of cases) {
      const r = resolveMovementIntent(g, c.id, intent as never, yaw);
      expect(r.ok).toBe(true);
      expect(r.targetId).toBe(g.at(x, y)!.id);
    }
  });
});

describe('crossWorld sanity', () => {
  it('builds a 3×3 board with nine nodes', () => {
    const g = crossWorld();
    expect(g.size).toBe(9);
  });
});
