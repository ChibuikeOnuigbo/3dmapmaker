/**
 * packages/panorama — grid walker for node-graph panoramas.
 *
 * This is the "chessboard street view" movement model:
 *
 *   • The world is a discrete grid of capture positions. Valid moves are the
 *     eight king's moves (one square orthogonally or diagonally).
 *   • Pressing a direction does NOT teleport. It starts a *step*: a spring-
 *     driven walk toward the target square whose velocity carries a small
 *     Gaussian perturbation, so the motion reads as a person walking rather
 *     than a linear slide.
 *   • When the step completes, the coordinate is committed and the engine
 *     warps to the panorama registered at that square.
 *
 * Everything here is pure math with no DOM or three.js dependency, so it runs
 * identically in a worker or in a unit test.
 */

/* ------------------------------------------------------------ Gaussian --- */

/**
 * Standard normal deviates via Box-Muller. Seeded, so a run is reproducible —
 * the bobbing is random-looking but never a different walk twice.
 */
export class GaussianRng {
  private state: number;
  private spare: number | null = null;

  constructor(seed = 1) {
    this.state = (seed >>> 0) || 1;
  }

  /** Uniform in [0, 1) — xorshift32, cheap and good enough for jitter. */
  nextUniform(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 4294967296;
  }

  /** Mean 0, standard deviation 1. */
  next(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.nextUniform() * 2 - 1;
      v = this.nextUniform() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * mul;
    return u * mul;
  }

  /** Mean `mean`, standard deviation `sd`. */
  normal(mean: number, sd: number): number {
    return mean + this.next() * sd;
  }
}

/* ---------------------------------------------------------------- grid --- */

export interface GridNode {
  id: string;
  name: string;
  /** Grid coordinates, not world metres. */
  col: number;
  row: number;
  /** World position of the capture point. */
  x: number;
  z: number;
  image: string;
  /** True for the destination square (the church, in the demo). */
  goal?: boolean;
}

export interface GridWalkerOptions {
  cols: number;
  rows: number;
  /** Metres between adjacent squares. */
  spacing: number;
  /** Walking speed in metres per second, before noise. */
  walkSpeed?: number;
  /** How much the stride varies, as a fraction of walkSpeed. */
  gaitNoise?: number;
  /** Camera bob amplitude in metres. */
  bobAmplitude?: number;
  /** Bob frequency in Hz — a normal walking cadence is ~1.8 Hz. */
  bobHz?: number;
  seed?: number;
}

export type StepPhase = 'idle' | 'stepping' | 'arrived';

export interface StepState {
  phase: StepPhase;
  /** Current interpolated world position, including bob. */
  x: number;
  y: number;
  z: number;
  /** Where the walker is heading, or null when idle. */
  targetId: string | null;
  /** 0..1 progress along the current step. */
  progress: number;
  /** Heading in degrees, 0 = north (-Z). */
  headingDeg: number;
  /** Set once per completed step: the id the engine should warp to. */
  arrivedAt: string | null;
  /** Total steps taken, for the HUD and for tests. */
  stepsTaken: number;
  /** Squares left to the goal, using king moves (Chebyshev distance). */
  movesToGoal: number | null;
}

/**
 * The eight king's moves, ordered so index = round(heading / 45) % 8.
 *
 * `dx` is a column delta (+1 = east = +X). `dy` is a ROW delta, and rows run
 * northward: because world north is -Z, row + 1 means z decreases. Keeping the
 * row axis northward is what makes "walk to the church at row 7" read as
 * walking north rather than south.
 */
export const KING_MOVES: ReadonlyArray<{ dx: number; dy: number; name: string }> = [
  { dx: 0, dy: 1, name: 'north' },
  { dx: 1, dy: 1, name: 'northeast' },
  { dx: 1, dy: 0, name: 'east' },
  { dx: 1, dy: -1, name: 'southeast' },
  { dx: 0, dy: -1, name: 'south' },
  { dx: -1, dy: -1, name: 'southwest' },
  { dx: -1, dy: 0, name: 'west' },
  { dx: -1, dy: 1, name: 'northwest' },
];

/** Chebyshev distance — the number of king moves between two squares. */
export function kingDistance(a: { col: number; row: number }, b: { col: number; row: number }): number {
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
}

/**
 * Resolve a world-space heading into the best king move. Diagonals win when
 * the aim is within ±22.5° of them, which is what makes holding W+D feel like
 * "walk northeast" instead of snapping to a cardinal.
 */
export function headingToKingMove(headingDeg: number): { dx: number; dy: number; name: string } {
  const index = Math.round((((headingDeg % 360) + 360) % 360) / 45) % 8;
  return KING_MOVES[index];
}

export class GridWalker {
  private readonly opts: Required<GridWalkerOptions>;
  private readonly rng: GaussianRng;
  private readonly nodes = new Map<string, GridNode>();
  private bySquare = new Map<string, GridNode>();

  private current: GridNode | null = null;
  private target: GridNode | null = null;
  private phase: StepPhase = 'idle';
  private progress = 0;
  /** Per-step speed, drawn from a Gaussian around walkSpeed. */
  private stepSpeed: number;
  private travelled = 0;
  private stepLength = 1;
  private stepsTaken = 0;
  private bobPhase = 0;
  /** Lateral sway, integrated from noise so it wanders rather than jitters. */
  private sway = 0;
  private arrivedAt: string | null = null;
  private goal: GridNode | null = null;

  private posX = 0;
  private posZ = 0;

  constructor(opts: GridWalkerOptions) {
    this.opts = {
      cols: opts.cols,
      rows: opts.rows,
      spacing: opts.spacing,
      walkSpeed: opts.walkSpeed ?? 1.4,
      gaitNoise: opts.gaitNoise ?? 0.18,
      bobAmplitude: opts.bobAmplitude ?? 0.045,
      bobHz: opts.bobHz ?? 1.8,
      seed: opts.seed ?? 7,
    };
    this.rng = new GaussianRng(this.opts.seed);
    this.stepSpeed = this.opts.walkSpeed;
  }

  /* ------------------------------------------------------------- setup --- */

  setNodes(nodes: ReadonlyArray<GridNode>): void {
    this.nodes.clear();
    this.bySquare.clear();
    for (const n of nodes) {
      this.nodes.set(n.id, n);
      this.bySquare.set(`${n.col},${n.row}`, n);
    }
    this.goal = nodes.find((n) => n.goal) ?? null;
  }

  /** Place the walker on a square without animating. */
  teleport(id: string): boolean {
    const n = this.nodes.get(id);
    if (!n) return false;
    this.current = n;
    this.target = null;
    this.phase = 'idle';
    this.progress = 0;
    this.travelled = 0;
    this.arrivedAt = null;
    this.posX = n.x;
    this.posZ = n.z;
    return true;
  }

  get currentNode(): GridNode | null {
    return this.current;
  }

  get isStepping(): boolean {
    return this.phase === 'stepping';
  }

  /** King moves remaining to the goal square, or null if there is no goal. */
  get movesToGoal(): number | null {
    if (!this.goal || !this.current) return null;
    return kingDistance(this.current, this.goal);
  }

  nodeAt(col: number, row: number): GridNode | null {
    return this.bySquare.get(`${col},${row}`) ?? null;
  }

  /* ------------------------------------------------------------ moving --- */

  /**
   * Begin a king's move. Returns false when the move is off the board or when
   * a step is already in progress — the caller should surface that rather than
   * queueing moves the user cannot see.
   */
  startStep(dx: number, dy: number): boolean {
    if (!this.current || this.phase === 'stepping') return false;
    const next = this.nodeAt(this.current.col + dx, this.current.row + dy);
    if (!next) return false;
    this.target = next;
    this.phase = 'stepping';
    this.progress = 0;
    this.travelled = 0;
    this.stepLength = Math.max(0.25, Math.hypot(next.x - this.current.x, next.z - this.current.z));
    // A real gait is not metronomic: draw this step's speed from a Gaussian
    // around the nominal walking speed and clamp it to something sane.
    const sd = this.opts.walkSpeed * this.opts.gaitNoise;
    this.stepSpeed = Math.max(this.opts.walkSpeed * 0.55, Math.min(this.opts.walkSpeed * 1.5, this.rng.normal(this.opts.walkSpeed, sd)));
    this.arrivedAt = null;
    return true;
  }

  /** Convenience: aim by world heading and step if a square is there. */
  startStepTowards(headingDeg: number): boolean {
    const m = headingToKingMove(headingDeg);
    return this.startStep(m.dx, m.dy);
  }

/**
   * The king's moves that are legal from the current square, with the square
   * each one lands on. Corner and edge squares have fewer than eight — that is
   * the board, not a bug, and the UI shows it rather than letting the user
   * press a direction that goes nowhere.
   */
  availableMoves(): Array<{ dx: number; dy: number; name: string; to: GridNode }> {
    if (!this.current) return [];
    const out: Array<{ dx: number; dy: number; name: string; to: GridNode }> = [];
    for (const m of KING_MOVES) {
      const next = this.nodeAt(this.current.col + m.dx, this.current.row + m.dy);
      if (next) out.push({ dx: m.dx, dy: m.dy, name: m.name, to: next });
    }
    return out;
  }

  /** Cancel an in-progress step and snap back to the last committed square. */
  cancelStep(): void {
    if (this.phase !== 'stepping' || !this.current) return;
    this.target = null;
    this.phase = 'idle';
    this.progress = 0;
    this.travelled = 0;
    this.posX = this.current.x;
    this.posZ = this.current.z;
    // Settle the stance: a cancelled step should not leave you mid-sway.
    this.bobPhase = 0;
    this.sway = 0;
  }

  /**
   * Advance the walk. Returns the interpolated camera position including bob
   * and sway, and sets `arrivedAt` exactly once when a square is committed.
   */
  advance(dt: number, eyeHeight = 1.7): StepState {
    this.arrivedAt = null;

    if (this.phase === 'stepping' && this.current && this.target) {
      // Speed itself wanders a little frame to frame — that is the "Gaussian
      // step" the brief asks for: acceleration is noisy, not constant.
      const jitter = this.rng.normal(1, this.opts.gaitNoise * 0.35);
      const speed = Math.max(0.2, this.stepSpeed * jitter);
      this.travelled += speed * dt;
      this.progress = Math.min(1, this.travelled / this.stepLength);

      // Ease in/out so the stride starts and stops like a person, not a lerp.
      const e = this.progress < 0.5 ? 2 * this.progress * this.progress : 1 - Math.pow(-2 * this.progress + 2, 2) / 2;

      const from = this.current;
      const to = this.target;
      this.posX = from.x + (to.x - from.x) * e;
      this.posZ = from.z + (to.z - from.z) * e;

      // Walking cadence drives both the vertical bob and the lateral sway.
      this.bobPhase += dt * this.opts.bobHz * Math.PI * 2 * (speed / Math.max(0.1, this.opts.walkSpeed));
      // Integrated noise: a random walk on the sway, gently pulled to centre so
      // it drifts instead of running away.
      this.sway = this.sway * 0.94 + this.rng.normal(0, 0.012);
      this.sway = Math.max(-0.06, Math.min(0.06, this.sway));

      if (this.progress >= 1) {
        // Commit the coordinate, then let the engine warp the panorama.
        this.current = to;
        this.target = null;
        this.phase = 'arrived';
        this.stepsTaken++;
        this.posX = to.x;
        this.posZ = to.z;
        this.bobPhase = 0;
        this.sway = 0;
        this.arrivedAt = to.id;
      }
    } else if (this.current) {
      // Idle: a small breathing sway so the view is never perfectly frozen,
      // which is what makes a static panorama feel like a photograph.
      this.bobPhase += dt * 0.6;
      this.posX = this.current.x + Math.sin(this.bobPhase) * 0.004;
      this.posZ = this.current.z + Math.cos(this.bobPhase * 0.8) * 0.004;
      if (this.phase === 'arrived') this.phase = 'idle';
    }

    const bob = Math.abs(Math.sin(this.bobPhase)) * this.opts.bobAmplitude * (this.phase === 'stepping' ? 1 : 0.25);

    return {
      phase: this.phase,
      x: this.posX + this.sway,
      y: eyeHeight + bob,
      z: this.posZ,
      targetId: this.target?.id ?? null,
      progress: this.progress,
      headingDeg: this.headingToTarget(),
      arrivedAt: this.arrivedAt,
      stepsTaken: this.stepsTaken,
      movesToGoal: this.movesToGoal,
    };
  }

  private headingToTarget(): number {
    if (!this.current || !this.target) return 0;
    const dx = this.target.x - this.current.x;
    const dz = this.target.z - this.current.z;
    return (Math.atan2(dx, -dz) * 180) / Math.PI;
  }

  /** A short human-readable breadcrumb of the squares visited so far. */
  describePath(path: ReadonlyArray<GridNode>): string {
    return path.map((n) => `${n.col},${n.row}`).join(' → ');
  }
}

/* --------------------------------------------------------- pathfinding --- */

/**
 * Shortest king-move path from one square to another. On an open board this is
 * just the diagonal-then-straight decomposition, but doing it as a search means
 * the same routine works when obstacles are added later.
 */
export function kingPath(from: { col: number; row: number }, to: { col: number; row: number }): Array<{ dx: number; dy: number }> {
  const out: Array<{ dx: number; dy: number }> = [];
  let col = from.col;
  let row = from.row;
  let guard = 0;
  while ((col !== to.col || row !== to.row) && guard++ < 1024) {
    const dx = Math.sign(to.col - col);
    const dy = Math.sign(to.row - row);
    out.push({ dx, dy });
    col += dx;
    row += dy;
  }
  return out;
}
