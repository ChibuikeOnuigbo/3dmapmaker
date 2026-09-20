import { describe, expect, it } from 'vitest';
import { generateWorld, WORLD_SPECS } from './generate';
import {
  buildMapModel,
  EMPTY_MAP_STATE,
  fitCell,
  gridToScreen,
  resolveNodeState,
  screenToGrid,
  type WorldMapState,
} from './mapModel';

const SMALL = WORLD_SPECS.small;

describe('gridToScreen / screenToGrid — the map coordinate math', () => {
  it('flips the y axis because SVG grows downward and the grid grows north', () => {
    // (0,0) is the SOUTH-west corner, so it must land at the BOTTOM of the svg.
    const a = gridToScreen(0, 0, 8, 10, 4);
    expect(a.cx).toBe(4);
    expect(a.cy).toBe(4 + 7 * 10);
    // (0,7) is the NORTH-west corner, so it lands at the TOP.
    const b = gridToScreen(0, 7, 8, 10, 4);
    expect(b.cy).toBe(4);
    expect(b.cy).toBeLessThan(a.cy);
  });

  it('grows x to the right', () => {
    expect(gridToScreen(3, 0, 8, 10, 0).cx).toBe(30);
    expect(gridToScreen(7, 0, 8, 10, 0).cx).toBe(70);
  });

  it('round-trips exactly for every cell on an 8×8 board', () => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const s = gridToScreen(x, y, 8, 12, 5);
        const back = screenToGrid(s.cx, s.cy, 8, 12, 5);
        expect(back.x).toBe(x);
        expect(back.y).toBe(y);
      }
    }
  });

  it('round-trips on a 32×32 board too', () => {
    for (const [x, y] of [[0, 0], [31, 31], [17, 4], [2, 29]] as const) {
      const s = gridToScreen(x, y, 32, 9, 24);
      const back = screenToGrid(s.cx, s.cy, 32, 9, 24);
      expect(back).toEqual({ x, y });
    }
  });

  it('keeps distinct cells at distinct screen positions', () => {
    const seen = new Set<string>();
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const s = gridToScreen(x, y, 8, 10, 0);
        const key = `${s.cx},${s.cy}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(64);
  });
});

describe('resolveNodeState — precedence (spec §38)', () => {
  const base: WorldMapState = { ...EMPTY_MAP_STATE };

  it('the current position beats every other state', () => {
    const s: WorldMapState = {
      ...base,
      currentId: 'a',
      destinationId: 'a',
      visited: new Set(['a']),
      loading: new Set(['a']),
      errored: new Set(['a']),
    };
    expect(resolveNodeState('a', s)).toBe('current');
  });

  it('an error outranks loading, destination and visited', () => {
    const s: WorldMapState = {
      ...base,
      destinationId: 'a',
      visited: new Set(['a']),
      loading: new Set(['a']),
      errored: new Set(['a']),
    };
    expect(resolveNodeState('a', s)).toBe('error');
  });

  it('loading outranks destination and visited', () => {
    const s: WorldMapState = { ...base, destinationId: 'a', visited: new Set(['a']), loading: new Set(['a']) };
    expect(resolveNodeState('a', s)).toBe('loading');
  });

  it('the destination outranks visited', () => {
    const s: WorldMapState = { ...base, destinationId: 'a', visited: new Set(['a']) };
    expect(resolveNodeState('a', s)).toBe('destination');
  });

  it('visited beats unseen', () => {
    expect(resolveNodeState('a', { ...base, visited: new Set(['a']) })).toBe('visited');
  });

  it('anything unmarked is unseen', () => {
    expect(resolveNodeState('zzz', base)).toBe('unseen');
  });
});

describe('buildMapModel — one node and one edge per graph element', () => {
  const { graph, kinds } = generateWorld(SMALL);

  it('emits exactly one map node per graph node', () => {
    const m = buildMapModel({ graph, state: EMPTY_MAP_STATE, kinds, cell: 20, pad: 10, viewport: null });
    expect(m.nodes.length).toBe(graph.size);
    expect(m.totalNodes).toBe(graph.size);
    expect(m.culled).toBe(0);
  });

  it('emits no duplicate nodes', () => {
    const m = buildMapModel({ graph, state: EMPTY_MAP_STATE, kinds, cell: 20, pad: 10, viewport: null });
    const ids = m.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('draws each undirected edge exactly once', () => {
    const m = buildMapModel({ graph, state: EMPTY_MAP_STATE, kinds, cell: 20, pad: 10, viewport: null });
    const keys = m.edges.map((e) => e.id);
    expect(new Set(keys).size).toBe(keys.length);
    // The graph stores both directions, so the map should hold half of them.
    const directed = graph.allEdges().length;
    expect(m.edges.length).toBe(directed / 2);
  });

  it('gives the square 1 node the top-left-of-south position and 64 the opposite', () => {
    const m = buildMapModel({ graph, state: EMPTY_MAP_STATE, kinds, cell: 20, pad: 10, viewport: null });
    const first = m.nodes.find((n) => n.number === 1);
    const last = m.nodes.reduce((a, b) => (b.number > a.number ? b : a), m.nodes[0]);
    expect(first).toBeDefined();
    // square 1 is at grid (0,0): smallest cx, largest cy.
    expect(first!.cx).toBe(10);
    expect(first!.cy).toBe(10 + 7 * 20);
    expect(last.number).toBe(64);
    expect(last.cx).toBe(10 + 7 * 20);
    expect(last.cy).toBe(10);
  });

  it('marks the current node and the destination distinctly', () => {
    const start = graph.at(0, 0)!;
    const all = graph.all();
    const dest = all.reduce((a, b) => (b.number > a.number ? b : a), all[0]);
    const state: WorldMapState = { ...EMPTY_MAP_STATE, currentId: start.id, destinationId: dest.id };
    const m = buildMapModel({ graph, state, kinds, cell: 20, pad: 10, viewport: null });
    expect(m.nodes.find((n) => n.id === start.id)!.view).toBe('current');
    expect(m.nodes.find((n) => n.id === dest.id)!.view).toBe('destination');
  });

  it('marks visited nodes as visited', () => {
    const all = graph.all();
    const state: WorldMapState = { ...EMPTY_MAP_STATE, visited: new Set([all[0].id, all[1].id]) };
    const m = buildMapModel({ graph, state, kinds, cell: 20, pad: 10, viewport: null });
    expect(m.nodes.find((n) => n.id === all[0].id)!.view).toBe('visited');
  });

  it('promotes nodes near the player from unseen to visible', () => {
    const start = graph.at(0, 0)!;
    const state: WorldMapState = { ...EMPTY_MAP_STATE, currentId: start.id, visibleRadius: 1 };
    const m = buildMapModel({ graph, state, kinds, cell: 20, pad: 10, viewport: null });
    const visible = m.nodes.filter((n) => n.view === 'visible');
    expect(visible.length).toBeGreaterThan(0);
    // Nothing outside one king move may be promoted.
    for (const n of visible) {
      expect(Math.max(Math.abs(n.gridX - start.gridX), Math.abs(n.gridY - start.gridY))).toBeLessThanOrEqual(1);
    }
  });

  it('does not demote a visited node to merely visible', () => {
    const start = graph.at(0, 0)!;
    const near = graph.nearby(start.gridX, start.gridY, 1).filter((n) => n.id !== start.id)[0];
    const state: WorldMapState = {
      ...EMPTY_MAP_STATE,
      currentId: start.id,
      visibleRadius: 1,
      visited: new Set([near.id]),
    };
    const m = buildMapModel({ graph, state, kinds, cell: 20, pad: 10, viewport: null });
    expect(m.nodes.find((n) => n.id === near.id)!.view).toBe('visited');
  });

  it('builds a route polyline when a route is set', () => {
    const all = graph.all();
    const dest = all.reduce((a, b) => (b.number > a.number ? b : a), all[0]);
    const start = graph.at(0, 0)!;
    const path = graph.findPath(start.id, dest.id)!;
    const state: WorldMapState = { ...EMPTY_MAP_STATE, currentId: start.id, route: path.nodes.map((n) => n.id) };
    const m = buildMapModel({ graph, state, kinds, cell: 20, pad: 10, viewport: null });
    expect(m.routePath).not.toBeNull();
    expect(m.routePath!.startsWith('M')).toBe(true);
    // One command per node on the route.
    expect(m.routePath!.split(/[ML]/).filter(Boolean).length).toBe(path.nodes.length);
    // Every route node is flagged, and consecutive ones light up their edge.
    const onRoute = m.nodes.filter((n) => n.onRoute);
    expect(onRoute.length).toBe(path.nodes.length);
    expect(m.edges.some((e) => e.onRoute)).toBe(true);
  });

  it('emits no route polyline when there is no route', () => {
    const m = buildMapModel({ graph, state: EMPTY_MAP_STATE, kinds, cell: 20, pad: 10, viewport: null });
    expect(m.routePath).toBeNull();
    expect(m.edges.every((e) => !e.onRoute)).toBe(true);
  });

  it('produces a viewBox that matches the board dimensions', () => {
    const m = buildMapModel({ graph, state: EMPTY_MAP_STATE, kinds, cell: 20, pad: 10, viewport: null });
    expect(m.width).toBe(10 * 2 + 7 * 20);
    expect(m.height).toBe(10 * 2 + 7 * 20);
    expect(m.viewBox).toBe(`0 0 ${m.width} ${m.height}`);
  });

  it('attaches landmark names to the node they sit on', () => {
    const m = buildMapModel({ graph, state: EMPTY_MAP_STATE, kinds, cell: 20, pad: 10, viewport: null });
    expect(graph.landmarks.length).toBeGreaterThan(0);
    const named = m.nodes.filter((n) => n.landmarkName);
    expect(named.length).toBe(graph.landmarks.length);
  });
});

describe('buildMapModel — viewport culling (spec §40)', () => {
  const { graph, kinds } = generateWorld(WORLD_SPECS.large);

  it('renders every node when no viewport is given', () => {
    const m = buildMapModel({ graph, state: EMPTY_MAP_STATE, kinds, cell: 10, pad: 10, viewport: null });
    expect(m.nodes.length).toBe(graph.size);
    expect(m.culled).toBe(0);
  });

  it('culls nodes outside the viewport and reports how many', () => {
    const m = buildMapModel({
      graph,
      state: EMPTY_MAP_STATE,
      kinds,
      cell: 10,
      pad: 10,
      viewport: { x: 0, y: 0, w: 100, h: 100, margin: 0 },
    });
    expect(m.nodes.length).toBeLessThan(graph.size);
    expect(m.culled).toBeGreaterThan(0);
    expect(m.nodes.length + m.culled).toBe(graph.size);
  });

  it('every node it keeps is inside the viewport plus margin', () => {
    const vp = { x: 50, y: 50, w: 120, h: 120, margin: 10 };
    const m = buildMapModel({ graph, state: EMPTY_MAP_STATE, kinds, cell: 10, pad: 10, viewport: vp });
    for (const n of m.nodes) {
      expect(n.cx).toBeGreaterThanOrEqual(vp.x - vp.margin);
      expect(n.cx).toBeLessThanOrEqual(vp.x + vp.w + vp.margin);
      expect(n.cy).toBeGreaterThanOrEqual(vp.y - vp.margin);
      expect(n.cy).toBeLessThanOrEqual(vp.y + vp.h + vp.margin);
    }
  });

  it('still reports the true total so the UI can say "n of m"', () => {
    const m = buildMapModel({
      graph,
      state: EMPTY_MAP_STATE,
      kinds,
      cell: 10,
      pad: 10,
      viewport: { x: 0, y: 0, w: 60, h: 60, margin: 0 },
    });
    expect(m.totalNodes).toBe(graph.size);
  });
});

describe('fitCell — legibility across scales', () => {
  it('gives an 8×8 board a larger cell than a 32×32 board in the same space', () => {
    expect(fitCell(8, 8, 600)).toBeGreaterThan(fitCell(32, 32, 600));
  });

  it('never returns a cell so small the nodes would be invisible', () => {
    expect(fitCell(200, 200, 400)).toBeGreaterThanOrEqual(6);
  });

  it('never returns a cell so large the board would not fit', () => {
    const cell = fitCell(8, 8, 4000);
    expect(cell).toBeLessThanOrEqual(48);
  });

  it('is stable for the same inputs', () => {
    expect(fitCell(20, 20, 600)).toBe(fitCell(20, 20, 600));
  });
});
