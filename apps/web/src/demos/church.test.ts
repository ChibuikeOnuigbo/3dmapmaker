/**
 * apps/web — integration test for the "Road to Church" demo.
 *
 * This is the end-to-end proof for the grid-walk feature: it builds the actual
 * demo project document, validates it against the real schema, checks the
 * king-move graph is complete, and then walks a GridWalker from square 1 to the
 * church square using only legal king moves — asserting the panoramas swap and
 * the board state is what the HUD would show.
 */
import { describe, expect, it } from 'vitest';
import { validateProject, loadProject, SCHEMA_VERSION } from '@3dmm/project';
import { GridWalker, kingPath, headingToKingMove } from '@3dmm/panorama';
import { DEMOS } from './demos';

const demo = DEMOS.find((d) => d.id === 'church');

/** The eight king's moves, as (col delta, row delta). Rows run northward. */
const MOVES = [
  { dx: 0, dy: 1, dir: 'north' },
  { dx: 1, dy: 1, dir: 'northeast' },
  { dx: 1, dy: 0, dir: 'east' },
  { dx: 1, dy: -1, dir: 'southeast' },
  { dx: 0, dy: -1, dir: 'south' },
  { dx: -1, dy: -1, dir: 'southwest' },
  { dx: -1, dy: 0, dir: 'west' },
  { dx: -1, dy: 1, dir: 'northwest' },
] as const;

const REVERSE: Record<string, string> = {
  north: 'south',
  northeast: 'southwest',
  east: 'west',
  southeast: 'northwest',
  south: 'north',
  southwest: 'northeast',
  west: 'east',
  northwest: 'southeast',
};

function squareOf(project: ReturnType<typeof build>, col: number, row: number) {
  const spacing = project.panorama.grid!.spacing;
  return project.panorama.nodes.find(
    (n) => Math.round(n.position.x / spacing) === col && Math.round(-n.position.z / spacing) === row,
  );
}

function build() {
  if (!demo) throw new Error('church demo missing');
  return demo.build();
}

describe('demo registry', () => {
  it('includes the road-to-church world', () => {
    expect(demo).toBeDefined();
    expect(demo?.name).toBe('Road to Church');
  });

  it('every demo builds a schema-valid project', () => {
    for (const d of DEMOS) {
      const p = d.build();
      const v = validateProject(p);
      expect(v.issues, `${d.id}: ${v.issues.map((i) => i.message).join('; ')}`).toEqual([]);
      expect(v.ok).toBe(true);
      expect(p.schemaVersion).toBe(SCHEMA_VERSION);
    }
  });

  it('every demo round-trips through serialize/load', () => {
    for (const d of DEMOS) {
      const p = d.build();
      const raw = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
      const loaded = loadProject(raw);
      expect(loaded.project.name).toBe(p.name);
      expect(loaded.project.layers.length).toBe(p.layers.length);
    }
  });
});

describe('church board layout', () => {
  const p = build();
  const grid = p.panorama.grid!;

  it('has 64 capture squares on an 8×8 board', () => {
    expect(grid).not.toBeNull();
    expect(grid.cols).toBe(8);
    expect(grid.rows).toBe(8);
    expect(p.panorama.nodes.length).toBe(64);
  });

  it('starts on the road at square 1 and ends at the church', () => {
    expect(p.panorama.currentNodeId).toBe('sq_1');
    expect(grid.goalNodeId).toBe('sq_64');
    const start = squareOf(p, 0, 0);
    const church = squareOf(p, 7, 7);
    expect(start?.name).toContain('The Road');
    expect(church?.name).toContain('The Church');
  });

  it('rows run northward, so the church is north of the start', () => {
    const start = squareOf(p, 0, 0)!;
    const church = squareOf(p, 7, 7)!;
    // North is -Z, so the church must have a smaller z than the start.
    expect(church.position.z).toBeLessThan(start.position.z);
    expect(church.position.x).toBeGreaterThan(start.position.x);
  });

  it('places every square on the grid spacing', () => {
    for (const n of p.panorama.nodes) {
      expect(Math.abs(n.position.x / grid.spacing - Math.round(n.position.x / grid.spacing))).toBeLessThan(1e-9);
      expect(Math.abs(n.position.z / grid.spacing - Math.round(n.position.z / grid.spacing))).toBeLessThan(1e-9);
    }
  });

  it('links all eight king moves exactly where the neighbour square exists', () => {
    let edges = 0;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const here = squareOf(p, col, row)!;
        for (const m of MOVES) {
          const nc = col + m.dx;
          const nr = row + m.dy;
          const onBoard = nc >= 0 && nr >= 0 && nc < 8 && nr < 8;
          const target = here.neighbors[m.dir];
          if (!onBoard) {
            expect(target, `square ${col},${row} must NOT link ${m.dir} off-board`).toBeUndefined();
            continue;
          }
          expect(target, `square ${col},${row} should link ${m.dir}`).toBeTruthy();
          edges++;
          const tn = p.panorama.nodes.find((n) => n.id === target)!;
          // The reverse direction must point back.
          expect(tn.neighbors[REVERSE[m.dir]], `${m.dir} must be reciprocal`).toBe(here.id);
        }
      }
    }
    // Directed king edges on an 8x8 board:
    //   orthogonal  (7*8 + 8*7) * 2            = 224
    //   diagonal    (7*7) * 2 diagonals * 2    = 196
    //   total                                  = 420
    expect(edges).toBe(420);
  });

  it('omits edges that would leave the board', () => {
    const corner = squareOf(p, 0, 0)!;
    expect(corner.neighbors.south).toBeUndefined();
    expect(corner.neighbors.west).toBeUndefined();
    expect(corner.neighbors.southwest).toBeUndefined();
    expect(Object.keys(corner.neighbors).length).toBe(3);
    const far = squareOf(p, 7, 7)!;
    expect(far.neighbors.north).toBeUndefined();
    expect(Object.keys(far.neighbors).length).toBe(3);
  });

  it('assigns a real panorama plate to every square', () => {
    for (const n of p.panorama.nodes) {
      expect(n.image.startsWith('/panoramas/'), `${n.id} -> ${n.image}`).toBe(true);
      expect(n.image.endsWith('.jpg')).toBe(true);
    }
    // The route uses the road plates; the destination uses the church plate.
    expect(squareOf(p, 0, 0)?.image).toBe('/panoramas/road-straight.jpg');
    expect(squareOf(p, 7, 7)?.image).toBe('/panoramas/church.jpg');
  });

  it('enables environment caps so a partial plate never shows a black gap', () => {
    for (const n of p.panorama.nodes) expect(n.cap.enabled).toBe(true);
  });

  it('authors a road layer along the diagonal route', () => {
    const roads: string[] = [];
    const stack = [...p.layers];
    while (stack.length) {
      const n = stack.pop()!;
      for (const c of n.children) stack.push(c);
      if (n.kind === 'roads') roads.push(n.name);
    }
    expect(roads.length).toBeGreaterThan(0);
  });

  it('marks the church with a marker layer', () => {
    const markers: string[] = [];
    const stack = [...p.layers];
    while (stack.length) {
      const n = stack.pop()!;
      for (const c of n.children) stack.push(c);
      if (n.kind === 'markers') markers.push(n.name);
    }
    expect(markers.some((m) => m.includes('Church'))).toBe(true);
  });
});

describe('walking the board', () => {
  const p = build();
  const grid = p.panorama.grid!;

  /** The authored graph entry for a walker node. */
  function graphNode(id: string) {
    return p.panorama.nodes.find((n) => n.id === id)!;
  }

  function walker(seed = 21) {
    const w = new GridWalker({
      cols: grid.cols,
      rows: grid.rows,
      spacing: grid.spacing,
      walkSpeed: grid.walkSpeed,
      gaitNoise: grid.gaitNoise,
      bobAmplitude: grid.bobAmplitude,
      bobHz: grid.bobHz,
      seed,
    });
    w.setNodes(
      p.panorama.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        col: Math.round(n.position.x / grid.spacing),
        row: Math.round(-n.position.z / grid.spacing),
        x: n.position.x,
        z: n.position.z,
        image: n.image,
        goal: n.id === grid.goalNodeId,
      })),
    );
    return w;
  }

  /** Drain a step that has already been started and return the square it hit. */
  function drain(w: GridWalker): string | null {
    let arrived: string | null = null;
    for (let i = 0; i < 3600 && w.isStepping; i++) {
      const s = w.advance(1 / 60);
      if (s.arrivedAt) arrived = s.arrivedAt;
    }
    return arrived;
  }

  /** Start a step and run it to completion. */
  function walkOne(w: GridWalker, dx: number, dy: number): string | null {
    expect(w.startStep(dx, dy)).toBe(true);
    return drain(w);
  }

  it('walks the diagonal route and warps at every square', () => {
    const w = walker();
    w.teleport('sq_1');
    expect(w.movesToGoal).toBe(7);

    const warps: string[] = [];
    const path = kingPath({ col: 0, row: 0 }, { col: 7, row: 7 });
    expect(path.length).toBe(7);

    for (const move of path) {
      const arrived = walkOne(w, move.dx, move.dy);
      expect(arrived).not.toBeNull();
      warps.push(arrived!);
    }

    expect(warps).toEqual(['sq_10', 'sq_19', 'sq_28', 'sq_37', 'sq_46', 'sq_55', 'sq_64']);
    expect(w.currentNode?.id).toBe('sq_64');
    expect(w.currentNode?.goal).toBe(true);
    expect(w.movesToGoal).toBe(0);
  });

  it('each warp lands the camera on that square with a real plate', () => {
    const w = walker();
    w.teleport('sq_1');
    const arrived = walkOne(w, 1, 1);
    const node = p.panorama.nodes.find((n) => n.id === arrived)!;
    const s = w.advance(1 / 60);
    expect(Math.abs(s.x - node.position.x)).toBeLessThan(0.25);
    expect(Math.abs(s.z - node.position.z)).toBeLessThan(0.25);
    expect(node.image).toBe('/panoramas/lane-corner.jpg');
  });

  it('takes a legal but non-diagonal route too', () => {
    const w = walker(99);
    w.teleport('sq_1');
    // Seven east, then seven north — 14 moves instead of 7.
    for (let i = 0; i < 7; i++) expect(walkOne(w, 1, 0)).not.toBeNull();
    expect(w.currentNode?.id).toBe('sq_8');
    expect(w.movesToGoal).toBe(7);
    for (let i = 0; i < 7; i++) expect(walkOne(w, 0, 1)).not.toBeNull();
    expect(w.currentNode?.id).toBe('sq_64');
    expect(w.movesToGoal).toBe(0);
  });

  it('refuses to walk off the board', () => {
    const w = walker();
    w.teleport('sq_1');
    expect(w.startStep(-1, 0)).toBe(false);
    expect(w.startStep(0, -1)).toBe(false);
    expect(w.currentNode?.id).toBe('sq_1');
  });

  it('every accepted move from every square lands on a real square', () => {
    const w = walker();
    let accepted = 0;
    let refused = 0;
    for (const n of p.panorama.nodes) {
      for (const m of MOVES) {
        // Reset before every probe: a completed step moves the walker, so
        // without this the sweep drifts and stops testing square `n`.
        w.teleport(n.id);
        const before = w.currentNode!;
        const link = graphNode(before.id).neighbors[m.dir];
        const ok = w.startStep(m.dx, m.dy);
        // The walker's notion of a legal move must match the authored graph.
        expect(ok, `${n.id} ${m.dir}`).toBe(Boolean(link));
        if (ok) {
          accepted++;
          // The step is already running — drain it, do not restart it.
          const arrived = drain(w);
          expect(arrived).toBe(link);
        } else {
          refused++;
          expect(w.isStepping).toBe(false);
          expect(w.currentNode?.id).toBe(before.id);
        }
      }
    }
    expect(accepted).toBe(420);
    expect(refused).toBe(64 * 8 - 420);
  });

  it('heading 45° resolves to the northeast square from the start', () => {
    const w = walker();
    w.teleport('sq_1');
    expect(headingToKingMove(45).name).toBe('northeast');
    const arrived = walkOne(w, 1, 1);
    expect(arrived).toBe('sq_10');
  });
});
