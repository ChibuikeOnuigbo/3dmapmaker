/**
 * packages/panorama — grid walker tests.
 *
 * These are the guarantees the "road to church" demo rests on: king moves only,
 * a step that actually takes time (no teleporting), Gaussian gait noise that
 * is bounded, a bob that stays human, and a warp signal emitted exactly once
 * per completed square.
 */
import { describe, expect, it } from 'vitest';
import {
  GaussianRng,
  GridWalker,
  KING_MOVES,
  kingDistance,
  kingPath,
  headingToKingMove,
  type GridNode,
} from './grid';

/**
 * An 8×8 board: square 1 is (0,0) on the road, the church is square 64 at
 * (7,7). Rows run northward, so z decreases as the row grows — walking "north"
 * is walking toward the church.
 */
function board(spacing = 12): GridNode[] {
  const out: GridNode[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      out.push({
        id: `sq_${row * 8 + col + 1}`,
        name: `Square ${row * 8 + col + 1}`,
        col,
        row,
        x: col * spacing,
        z: -row * spacing,
        image: '',
        goal: col === 7 && row === 7,
      });
    }
  }
  return out;
}

function walker(seed = 7): GridWalker {
  const w = new GridWalker({ cols: 8, rows: 8, spacing: 12, seed });
  w.setNodes(board());
  w.teleport('sq_1');
  return w;
}

describe('GaussianRng', () => {
  it('is deterministic for a given seed', () => {
    const a = new GaussianRng(42);
    const b = new GaussianRng(42);
    for (let i = 0; i < 50; i++) expect(a.next()).toBeCloseTo(b.next(), 12);
  });

  it('produces values centred on the mean with roughly the right spread', () => {
    const rng = new GaussianRng(1234);
    const samples = Array.from({ length: 20000 }, () => rng.normal(10, 2));
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
    expect(mean).toBeCloseTo(10, 1);
    expect(Math.sqrt(variance)).toBeCloseTo(2, 1);
  });

  it('never returns a non-finite value', () => {
    const rng = new GaussianRng(9);
    for (let i = 0; i < 5000; i++) expect(Number.isFinite(rng.next())).toBe(true);
  });
});

describe('king geometry', () => {
  it('defines exactly the eight king moves', () => {
    expect(KING_MOVES.length).toBe(8);
    const keys = new Set(KING_MOVES.map((m) => `${m.dx},${m.dy}`));
    expect(keys.size).toBe(8);
    expect(keys.has('0,0')).toBe(false);
  });

  it('measures distance as Chebyshev', () => {
    expect(kingDistance({ col: 0, row: 0 }, { col: 7, row: 7 })).toBe(7);
    expect(kingDistance({ col: 0, row: 0 }, { col: 3, row: 7 })).toBe(7);
    expect(kingDistance({ col: 2, row: 2 }, { col: 2, row: 2 })).toBe(0);
  });

  it('maps headings to the eight compass moves', () => {
    expect(headingToKingMove(0).name).toBe('north');
    expect(headingToKingMove(45).name).toBe('northeast');
    expect(headingToKingMove(90).name).toBe('east');
    expect(headingToKingMove(135).name).toBe('southeast');
    expect(headingToKingMove(180).name).toBe('south');
    expect(headingToKingMove(225).name).toBe('southwest');
    expect(headingToKingMove(270).name).toBe('west');
    expect(headingToKingMove(315).name).toBe('northwest');
    expect(headingToKingMove(359).name).toBe('north');
  });

  it('keeps the move list in heading order with no duplicates', () => {
    const names = KING_MOVES.map((m) => m.name);
    expect(new Set(names).size).toBe(8);
    for (let i = 0; i < 8; i++) expect(headingToKingMove(i * 45)).toBe(KING_MOVES[i]);
  });

  it('plans a diagonal-then-straight path', () => {
    const path = kingPath({ col: 0, row: 0 }, { col: 7, row: 7 });
    expect(path.length).toBe(7);
    for (const m of path) expect(m).toEqual({ dx: 1, dy: 1 });
  });

  it('plans a straight path along one axis', () => {
    const path = kingPath({ col: 0, row: 0 }, { col: 0, row: 4 });
    expect(path.length).toBe(4);
    for (const m of path) expect(m).toEqual({ dx: 0, dy: 1 });
  });

  it('decomposes a mixed offset into diagonals then a straight run', () => {
    const path = kingPath({ col: 0, row: 0 }, { col: 2, row: 5 });
    expect(path.length).toBe(5);
    expect(path.slice(0, 2)).toEqual([
      { dx: 1, dy: 1 },
      { dx: 1, dy: 1 },
    ]);
    expect(path.slice(2)).toEqual([{ dx: 0, dy: 1 }, { dx: 0, dy: 1 }, { dx: 0, dy: 1 }]);
  });
});

describe('GridWalker', () => {
  it('refuses a step that leaves the board', () => {
    const w = walker();
    expect(w.startStep(-1, 0)).toBe(false); // west off the board
    expect(w.startStep(0, -1)).toBe(false); // south off the board
    expect(w.startStep(-1, -1)).toBe(false);
    expect(w.currentNode?.id).toBe('sq_1');
  });

  it('refuses a second step while one is in progress', () => {
    const w = walker();
    expect(w.startStep(1, 0)).toBe(true);
    expect(w.startStep(1, 0)).toBe(false);
  });

  it('does not teleport — the square takes time to reach', () => {
    const w = walker();
    w.startStep(1, 0);
    const first = w.advance(1 / 60);
    expect(first.phase).toBe('stepping');
    expect(first.x).toBeGreaterThan(0);
    expect(first.x).toBeLessThan(12);
    expect(first.arrivedAt).toBeNull();
  });

  it('commits the square exactly once and reports the warp target', () => {
    const w = walker();
    w.startStep(1, 0);
    let arrivals: Array<string | null> = [];
    for (let i = 0; i < 600; i++) {
      const s = w.advance(1 / 60);
      if (s.arrivedAt) arrivals.push(s.arrivedAt);
      if (arrivals.length) break;
    }
    expect(arrivals).toEqual(['sq_2']);
    expect(w.currentNode?.id).toBe('sq_2');
    // A second advance must not re-emit the arrival.
    expect(w.advance(1 / 60).arrivedAt).toBeNull();
  });

  it('lands on the exact square centre after the step', () => {
    const w = walker();
    w.startStep(1, 0);
    for (let i = 0; i < 2400 && w.isStepping; i++) w.advance(1 / 60);
    const s = w.advance(1 / 60);
    expect(Math.abs(s.x - 12)).toBeLessThan(0.05);
    expect(Math.abs(s.z - 0)).toBeLessThan(0.05);
  });

  it('walks the full diagonal to the church in seven king moves', () => {
    const w = walker();
    const visited: string[] = ['sq_1'];
    for (let leg = 0; leg < 7; leg++) {
      expect(w.startStep(1, 1)).toBe(true);
      for (let i = 0; i < 2400 && w.isStepping; i++) {
        const s = w.advance(1 / 60);
        if (s.arrivedAt) visited.push(s.arrivedAt);
      }
      expect(w.isStepping).toBe(false);
    }
    expect(visited[visited.length - 1]).toBe('sq_64');
    expect(w.currentNode?.goal).toBe(true);
    expect(w.movesToGoal).toBe(0);
  });

  it('counts moves to the goal and decrements as you approach', () => {
    const w = walker();
    expect(w.movesToGoal).toBe(7);
    w.startStep(1, 1);
    for (let i = 0; i < 2400 && w.isStepping; i++) w.advance(1 / 60);
    expect(w.movesToGoal).toBe(6);
  });

  it('keeps camera bob within a human range while walking', () => {
    const w = walker();
    w.startStep(1, 1);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 400 && w.isStepping; i++) {
      const s = w.advance(1 / 60);
      min = Math.min(min, s.y);
      max = Math.max(max, s.y);
    }
    // eyeHeight 1.7 default, bob amplitude 0.045 → must stay inside ±0.1 m
    expect(min).toBeGreaterThan(1.6);
    expect(max).toBeLessThan(1.8);
    // And it must actually move, otherwise the bob is fake.
    expect(max - min).toBeGreaterThan(0.01);
  });

  it('gait noise changes step duration but stays bounded', () => {
    const durations: number[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      const w = new GridWalker({ cols: 8, rows: 8, spacing: 12, seed, gaitNoise: 0.25 });
      w.setNodes(board());
      w.teleport('sq_1');
      w.startStep(1, 0);
      let frames = 0;
      while (w.isStepping && frames < 1200) {
        w.advance(1 / 60);
        frames++;
      }
      durations.push(frames / 60);
    }
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    // 12 m at ~1.4 m/s ≈ 8.6 s. Noise must vary it, not break it.
    expect(Math.min(...durations)).toBeGreaterThan(mean * 0.5);
    expect(Math.max(...durations)).toBeLessThan(mean * 2);
    expect(new Set(durations.map((d) => d.toFixed(2))).size).toBeGreaterThan(1);
  });

  it('cancelStep snaps back to the committed square', () => {
    const w = walker();
    w.startStep(1, 0);
    for (let i = 0; i < 60; i++) w.advance(1 / 60);
    w.cancelStep();
    const s = w.advance(1 / 60);
    expect(s.phase).toBe('idle');
    expect(Math.abs(s.x)).toBeLessThan(0.01);
    expect(w.currentNode?.id).toBe('sq_1');
  });

  it('teleport moves without animating', () => {
    const w = walker();
    expect(w.teleport('sq_64')).toBe(true);
    const s = w.advance(1 / 60);
    expect(Math.abs(s.x - 84)).toBeLessThan(0.05);
    expect(Math.abs(s.z + 84)).toBeLessThan(0.05);
    expect(w.movesToGoal).toBe(0);
  });

  it('teleport refuses an unknown square', () => {
    const w = walker();
    expect(w.teleport('nope')).toBe(false);
    expect(w.currentNode?.id).toBe('sq_1');
  });

  it('is reproducible for a given seed', () => {
    const trace = (seed: number) => {
      const w = new GridWalker({ cols: 8, rows: 8, spacing: 12, seed });
      w.setNodes(board());
      w.teleport('sq_1');
      w.startStep(1, 1);
      const out: number[] = [];
      for (let i = 0; i < 200; i++) out.push(Number(w.advance(1 / 60).y.toFixed(5)));
      return out.join(',');
    };
    expect(trace(11)).toBe(trace(11));
    expect(trace(11)).not.toBe(trace(12));
  });

  it('reports exactly the legal king moves for each square', () => {
    const w = walker();
    // Corner: three moves.
    w.teleport('sq_1');
    expect(w.availableMoves().map((m) => m.name).sort()).toEqual(['east', 'north', 'northeast']);
    // Edge: five moves.
    w.teleport('sq_2');
    expect(w.availableMoves().length).toBe(5);
    // Interior: all eight.
    w.teleport('sq_10');
    const names = w.availableMoves().map((m) => m.name).sort();
    expect(names).toEqual(['east', 'north', 'northeast', 'northwest', 'south', 'southeast', 'southwest', 'west']);
    // Every reported move resolves to a real node.
    for (const m of w.availableMoves()) expect(w.nodeAt(1 + m.dx, 1 + m.dy)?.id).toBe(m.to.id);
  });

  it('startStepTowards resolves a heading into a legal move', () => {
    const w = walker();
    expect(w.startStepTowards(45)).toBe(true);
    for (let i = 0; i < 2400 && w.isStepping; i++) w.advance(1 / 60);
    // (0,0) + northeast = (1,1) = square 10 on a row-major 8-wide board.
    expect(w.currentNode?.id).toBe('sq_10');
  });

  it('aims north at heading 0 and reaches the next row', () => {
    const w = walker();
    expect(w.startStepTowards(0)).toBe(true);
    for (let i = 0; i < 2400 && w.isStepping; i++) w.advance(1 / 60);
    expect(w.currentNode?.id).toBe('sq_9');
    const s = w.advance(1 / 60);
    expect(Math.abs(s.z + 12)).toBeLessThan(0.05);
  });
});

describe('Gaussian noise is confined to the camera, never the graph', () => {
  // Hard constraint from the brief: randomness may drive camera bob, micro
  // yaw/pitch and timing variation, but must NEVER affect node selection,
  // coordinates, world geometry or path correctness. The existing GaussianRng
  // tests prove the distribution is well-formed; nothing proved it stays out of
  // the walk. These do, by running the identical walk under different seeds.

  /** Run a fixed sequence of moves and record where the walker actually lands. */
  function walk(seed: number, moves: Array<[number, number]>): { ids: string[]; ys: number[] } {
    const w = walker(seed);
    const ids: string[] = [];
    const ys: number[] = [];
    for (const [dx, dy] of moves) {
      // A step is only refused if one is already in flight, so the frame budget
      // has to actually cover the walk. spacing 12, diagonal ≈ 16.97 units, and
      // the gait can draw a speed as low as 0.55 × 1.4 — so a diagonal can take
      // ~22 s, i.e. ~1330 frames at 60 Hz. Budget well past that rather than
      // letting a slow draw look like a refusal.
      expect(w.startStep(dx, dy), `step ${dx},${dy} refused`).toBe(true);
      let arrived: string | null = null;
      for (let i = 0; i < 3000; i++) {
        const s = w.advance(1 / 60, 1.7);
        ys.push(s.y);
        if (s.arrivedAt) { arrived = s.arrivedAt; break; }
      }
      expect(arrived, `step ${dx},${dy} never completed`).not.toBe(null);
      ids.push(arrived as string);
    }
    return { ids, ys };
  }

  const MOVES: Array<[number, number]> = [
    [1, 0], [1, 1], [0, 1], [1, 0], [1, 1], [0, 1], [1, 0], [1, 1],
  ];

  it('visits exactly the same squares regardless of seed', () => {
    const a = walk(1, MOVES);
    const b = walk(99, MOVES);
    const c = walk(123456, MOVES);
    expect(a.ids.length, 'the walk did not complete').toBe(MOVES.length);
    expect(b.ids).toEqual(a.ids);
    expect(c.ids).toEqual(a.ids);
  });

  it('lands on the square the coordinates say, not a noisy approximation', () => {
    const { ids } = walk(4242, MOVES);
    // Start at sq_1 = (0,0). The moves above are +x, +x+y, +y, ... so the
    // landing squares are fully determined by the arithmetic.
    expect(ids[0]).toBe('sq_2');   // (1,0) -> index 1*1+0 ... row*8+col+1 = 2
    expect(ids[1]).toBe('sq_11');  // (1,1) -> 1*8+1+1
    expect(ids[2]).toBe('sq_19');  // (1,2) -> 2*8+1+1
  });

  it('the camera really does move, so the noise is present and not stubbed out', () => {
    // Guard against the test above passing because noise was removed entirely.
    const a = walk(1, MOVES);
    const b = walk(99, MOVES);
    expect(a.ys.length).toBeGreaterThan(0);
    const differs = a.ys.some((y, i) => Math.abs(y - b.ys[i]) > 1e-9);
    expect(differs, 'eye height was identical across seeds — noise is not applied').toBe(true);
  });

  it('eye height stays inside a human band no matter the seed', () => {
    for (const seed of [1, 7, 99, 4242, 123456]) {
      const { ys } = walk(seed, MOVES);
      for (const y of ys) {
        expect(y, `seed ${seed}`).toBeGreaterThan(1.0);
        expect(y, `seed ${seed}`).toBeLessThan(2.4);
      }
    }
  });

  it('available moves are identical across seeds', () => {
    const a = walker(1);
    const b = walker(987654);
    const movesOf = (w: GridWalker) =>
      w.availableMoves().map((m) => `${m.dx},${m.dy}:${m.to.id}`).sort();
    expect(movesOf(b)).toEqual(movesOf(a));
  });
});
