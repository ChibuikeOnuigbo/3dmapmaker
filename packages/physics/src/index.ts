/**
 * packages/physics — fixed-timestep simulation and collision proxies
 * (REQUIREMENT 021, 110, 111, 113, 114).
 *
 * Rapier WASM was evaluated (see RESEARCH.md). It is the right choice when a
 * project needs real rigid-body dynamics, but it is a 2 MB download that must be
 * optional: a map builder that cannot open offline because a physics engine
 * failed to fetch is worse than one with a small built-in solver. So this
 * package provides a dependency-free fixed-step controller that covers walking,
 * slopes, steps, walls and surfaces, and exposes a clean seam
 * (`PhysicsBackend`) where Rapier can be plugged in per-project.
 *
 * The timestep is a fixed accumulator with visual interpolation, which is the
 * specific thing REQUIREMENT 114 asks for.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type SurfaceKind = 'terrain' | 'road' | 'wall' | 'water' | 'building' | 'custom';

export interface SurfaceProps {
  kind: SurfaceKind;
  /** Kinetic friction coefficient. */
  friction: number;
  walkable: boolean;
  /** True when the surface should stop movement (walls). */
  solid: boolean;
  /** Max slope the character can stand on, degrees. */
  slopeLimitDeg: number;
  /** Step height the controller can climb, metres. */
  stepHeight: number;
}

export const SURFACES: Record<SurfaceKind, SurfaceProps> = {
  terrain: { kind: 'terrain', friction: 0.85, walkable: true, solid: false, slopeLimitDeg: 46, stepHeight: 0.45 },
  road: { kind: 'road', friction: 0.95, walkable: true, solid: false, slopeLimitDeg: 30, stepHeight: 0.2 },
  wall: { kind: 'wall', friction: 0.4, walkable: false, solid: true, slopeLimitDeg: 90, stepHeight: 0 },
  water: { kind: 'water', friction: 0.3, walkable: false, solid: false, slopeLimitDeg: 10, stepHeight: 0 },
  building: { kind: 'building', friction: 0.9, walkable: true, solid: true, slopeLimitDeg: 40, stepHeight: 0.3 },
  custom: { kind: 'custom', friction: 0.8, walkable: true, solid: false, slopeLimitDeg: 45, stepHeight: 0.4 },
};

/* ------------------------------------------------------- collision proxies --- */

export type CollisionShape =
  | { type: 'box'; center: Vec3; halfExtents: Vec3; rotYDeg: number }
  | { type: 'sphere'; center: Vec3; radius: number }
  | { type: 'capsule'; center: Vec3; radius: number; halfHeight: number };

export interface Collider {
  id: string;
  shape: CollisionShape;
  surface: SurfaceProps;
  /** Owner layer id, so unloading a layer unloads its colliders (HC 008). */
  ownerId: string;
  loaded: boolean;
}

/** Uniform grid broadphase so collider counts do not turn into O(n) per query. */
export class CollisionWorld {
  private colliders = new Map<string, Collider>();
  private grid = new Map<string, string[]>();
  private cellSize: number;
  private queries = 0;

  constructor(cellSize = 32) {
    this.cellSize = Math.max(1, cellSize);
  }

  private key(cx: number, cz: number): string {
    return `${cx}:${cz}`;
  }

  private cellsFor(shape: CollisionShape): string[] {
    let minX: number;
    let maxX: number;
    let minZ: number;
    let maxZ: number;
    if (shape.type === 'box') {
      const r = Math.max(shape.halfExtents.x, shape.halfExtents.z) * 1.5;
      minX = shape.center.x - r;
      maxX = shape.center.x + r;
      minZ = shape.center.z - r;
      maxZ = shape.center.z + r;
    } else {
      const r = shape.type === 'sphere' ? shape.radius : shape.radius;
      minX = shape.center.x - r;
      maxX = shape.center.x + r;
      minZ = shape.center.z - r;
      maxZ = shape.center.z + r;
    }
    const out: string[] = [];
    const cs = this.cellSize;
    for (let cx = Math.floor(minX / cs); cx <= Math.floor(maxX / cs); cx++) {
      for (let cz = Math.floor(minZ / cs); cz <= Math.floor(maxZ / cs); cz++) out.push(this.key(cx, cz));
    }
    return out;
  }

  add(c: Collider): void {
    this.colliders.set(c.id, { ...c, loaded: true });
    for (const k of this.cellsFor(c.shape)) {
      const arr = this.grid.get(k) ?? [];
      arr.push(c.id);
      this.grid.set(k, arr);
    }
  }

  remove(id: string): void {
    const c = this.colliders.get(id);
    if (!c) return;
    for (const k of this.cellsFor(c.shape)) {
      const arr = this.grid.get(k);
      if (!arr) continue;
      const next = arr.filter((x) => x !== id);
      if (next.length) this.grid.set(k, next);
      else this.grid.delete(k);
    }
    this.colliders.delete(id);
  }

  /** Unload every collider owned by a layer (HARDENING CHECK 008). */
  removeByOwner(ownerId: string): number {
    let n = 0;
    for (const [id, c] of [...this.colliders]) {
      if (c.ownerId === ownerId) {
        this.remove(id);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.colliders.size;
  }

  get stats() {
    return { colliders: this.colliders.size, cells: this.grid.size, queries: this.queries };
  }

  /** Does a vertical capsule at (x,y,z) with the given radius overlap anything solid? */
  overlaps(x: number, y: number, z: number, radius: number, height = 1.8): Collider | null {
    this.queries++;
    const cs = this.cellSize;
    const cx = Math.floor(x / cs);
    const cz = Math.floor(z / cs);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const ids = this.grid.get(this.key(cx + dx, cz + dz));
        if (!ids) continue;
        for (const id of ids) {
          const c = this.colliders.get(id);
          if (!c || !c.surface.solid) continue;
          if (capsuleHitsShape(x, y, z, radius, height, c.shape)) return c;
        }
      }
    }
    return null;
  }
}

function capsuleHitsShape(x: number, y: number, z: number, radius: number, height: number, shape: CollisionShape): boolean {
  if (shape.type === 'box') {
    // approximate rotated box with an AABB inflated by the capsule radius
    const r = Math.abs(Math.cos((shape.rotYDeg * Math.PI) / 180)) * shape.halfExtents.x + Math.abs(Math.sin((shape.rotYDeg * Math.PI) / 180)) * shape.halfExtents.z;
    const r2 = Math.abs(Math.sin((shape.rotYDeg * Math.PI) / 180)) * shape.halfExtents.x + Math.abs(Math.cos((shape.rotYDeg * Math.PI) / 180)) * shape.halfExtents.z;
    const withinX = Math.abs(x - shape.center.x) <= r + radius;
    const withinZ = Math.abs(z - shape.center.z) <= r2 + radius;
    const withinY = y + height > shape.center.y - shape.halfExtents.y && y < shape.center.y + shape.halfExtents.y;
    return withinX && withinZ && withinY;
  }
  if (shape.type === 'sphere') {
    const d = Math.hypot(x - shape.center.x, y + height / 2 - shape.center.y, z - shape.center.z);
    return d <= shape.radius + radius;
  }
  const dy = Math.max(0, Math.abs(y + height / 2 - shape.center.y) - shape.halfHeight);
  const d = Math.hypot(x - shape.center.x, dy, z - shape.center.z);
  return d <= shape.radius + radius;
}

/* -------------------------------------------------------- fixed timestep --- */

export interface FixedStepOptions {
  /** Simulation step in seconds. 1/60 matches most displays. */
  step?: number;
  /** Never simulate more than this many steps in one frame (spiral of death guard). */
  maxSubSteps?: number;
}

export interface StepResult {
  steps: number;
  /** Interpolation alpha in [0,1] for smoothing visuals between steps. */
  alpha: number;
  simulatedSeconds: number;
  clamped: boolean;
}

/**
 * Accumulator-based fixed timestep (REQUIREMENT 114).
 *
 * `maxSubSteps` caps catch-up work: after a tab is backgrounded for 30s the
 * simulation runs a bounded number of steps instead of freezing the frame.
 */
export class FixedTimestep {
  private accumulator = 0;
  private readonly step: number;
  private readonly maxSubSteps: number;
  private totalSteps = 0;
  private clampedFrames = 0;

  constructor(opts: FixedStepOptions = {}) {
    this.step = opts.step ?? 1 / 60;
    this.maxSubSteps = opts.maxSubSteps ?? 5;
  }

  get stats() {
    return { step: this.step, totalSteps: this.totalSteps, clampedFrames: this.clampedFrames };
  }

  /** Advance the accumulator by `dt` seconds and return how many steps to run. */
  advance(dt: number): StepResult {
    const clamped = dt > this.step * this.maxSubSteps;
    this.accumulator += Math.min(dt, this.step * (this.maxSubSteps + 2));
    let steps = 0;
    while (this.accumulator >= this.step && steps < this.maxSubSteps) {
      this.accumulator -= this.step;
      steps++;
    }
    if (clamped) {
      this.clampedFrames++;
      // drop the backlog so we do not stay permanently behind
      this.accumulator = Math.min(this.accumulator, this.step);
    }
    this.totalSteps += steps;
    return { steps, alpha: this.accumulator / this.step, simulatedSeconds: steps * this.step, clamped };
  }

  reset(): void {
    this.accumulator = 0;
  }
}

/* --------------------------------------------------- character controller --- */

export interface CharacterInput {
  forward: number;
  right: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  headingDeg: number;
}

export interface CharacterState {
  /**
   * The EYE position, not the feet.
   *
   * Ground contact is `position.y - eyeHeight`. Comparing `position.y`
   * directly against a ground sample is off by exactly the eye height — a
   * mistake that reads like a 1.65 m ground-snap failure when the snap is in
   * fact exact. Use `feetY(state)`.
   */
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  groundSurface: SurfaceKind | null;
  eyeHeight: number;
}

/** The character's ground-contact height — what a ground sample is compared against. */
export function feetY(state: Pick<CharacterState, 'position' | 'eyeHeight'>): number {
  return state.position.y - state.eyeHeight;
}

export interface CharacterOptions {
  radius?: number;
  height?: number;
  eyeHeight?: number;
  crouchEyeHeight?: number;
  walkSpeed?: number;
  sprintMultiplier?: number;
  crouchMultiplier?: number;
  gravity?: number;
  jumpSpeed?: number;
  /** Acceleration in m/s^2; gives a real weight to movement. */
  acceleration?: number;
  groundSnapDistance?: number;
}

export interface GroundSample {
  height: number | null;
  slopeDeg: number;
  surface: SurfaceProps;
}

export interface CharacterTelemetry {
  grounded: boolean;
  slopeDeg: number;
  blockedBySlope: boolean;
  blockedByWall: boolean;
  steppedUp: boolean;
  speed: number;
  groundSurface: SurfaceKind | null;
}

/**
 * Capsule character controller (REQUIREMENT 111).
 *
 * Solves: gravity, ground snapping, slope limit, step climbing, wall sliding,
 * and surface-dependent friction. Deterministic for a given input sequence at a
 * fixed timestep, which is what makes HARDENING CHECK 008 testable.
 */
export class CharacterController {
  private opts: Required<CharacterOptions>;
  private world: CollisionWorld;
  state: CharacterState;
  telemetry: CharacterTelemetry = {
    grounded: false,
    slopeDeg: 0,
    blockedBySlope: false,
    blockedByWall: false,
    steppedUp: false,
    speed: 0,
    groundSurface: null,
  };

  constructor(world: CollisionWorld, spawn: Vec3, opts: CharacterOptions = {}) {
    this.world = world;
    this.opts = {
      radius: opts.radius ?? 0.35,
      height: opts.height ?? 1.8,
      eyeHeight: opts.eyeHeight ?? 1.65,
      crouchEyeHeight: opts.crouchEyeHeight ?? 1.0,
      walkSpeed: opts.walkSpeed ?? 5.5,
      sprintMultiplier: opts.sprintMultiplier ?? 2.2,
      crouchMultiplier: opts.crouchMultiplier ?? 0.45,
      gravity: opts.gravity ?? 22,
      jumpSpeed: opts.jumpSpeed ?? 6.2,
      acceleration: opts.acceleration ?? 40,
      groundSnapDistance: opts.groundSnapDistance ?? 0.35,
    };
    this.state = {
      position: { ...spawn },
      velocity: { x: 0, y: 0, z: 0 },
      grounded: false,
      groundSurface: null,
      eyeHeight: this.opts.eyeHeight,
    };
  }

  getState(): CharacterState {
    return this.state;
  }

  /** One fixed simulation step. `dt` must be the fixed step, not the frame delta. */
  step(input: CharacterInput, dt: number, sampleGround: (x: number, z: number) => GroundSample): void {
    const o = this.opts;
    const s = this.state;

    let speed = o.walkSpeed;
    if (input.sprint) speed *= o.sprintMultiplier;
    if (input.crouch) speed *= o.crouchMultiplier;

    const hRad = (input.headingDeg * Math.PI) / 180;
    const fx = Math.sin(hRad);
    const fz = -Math.cos(hRad);
    const rx = Math.cos(hRad);
    const rz = Math.sin(hRad);

    let ax = input.right;
    let ay = input.forward;
    const alen = Math.hypot(ax, ay);
    if (alen > 1) {
      ax /= alen;
      ay /= alen;
    }

    const desiredX = (fx * ay + rx * ax) * speed;
    const desiredZ = (fz * ay + rz * ax) * speed;

    const ground = sampleGround(s.position.x, s.position.z);
    const surface = ground.surface;
    const friction = s.grounded ? surface.friction : 1;
    const accel = o.acceleration * friction;

    s.velocity.x += (desiredX - s.velocity.x) * Math.min(1, accel * dt / Math.max(speed, 1));
    s.velocity.z += (desiredZ - s.velocity.z) * Math.min(1, accel * dt / Math.max(speed, 1));

    // gravity
    s.velocity.y -= o.gravity * dt;

    // --- slope limit -------------------------------------------------------
    let blockedBySlope = false;
    if (s.grounded && ground.slopeDeg > surface.slopeLimitDeg) {
      // slide downhill instead of climbing
      blockedBySlope = true;
      s.velocity.x *= 0.3;
      s.velocity.z *= 0.3;
    }

    // --- horizontal move with wall sliding ---------------------------------
    let nx = s.position.x + s.velocity.x * dt;
    let nz = s.position.z + s.velocity.z * dt;
    let blockedByWall = false;
    const feetY = s.position.y - s.eyeHeight;
    if (this.world.overlaps(nx, feetY, nz, o.radius, o.height)) {
      blockedByWall = true;
      // try axis-separated moves so we slide along walls rather than sticking
      if (!this.world.overlaps(nx, feetY, s.position.z, o.radius, o.height)) {
        nz = s.position.z;
        s.velocity.z = 0;
      } else if (!this.world.overlaps(s.position.x, feetY, nz, o.radius, o.height)) {
        nx = s.position.x;
        s.velocity.x = 0;
      } else {
        nx = s.position.x;
        nz = s.position.z;
        s.velocity.x = 0;
        s.velocity.z = 0;
      }
    }
    s.position.x = nx;
    s.position.z = nz;

    // --- step climbing -----------------------------------------------------
    let steppedUp = false;
    const groundNow = sampleGround(s.position.x, s.position.z);
    if (groundNow.height !== null) {
      const targetFeet = groundNow.height;
      const currentFeet = s.position.y - s.eyeHeight;
      const delta = targetFeet - currentFeet;
      if (delta > 0 && delta <= surface.stepHeight && s.grounded && !blockedBySlope) {
        s.position.y = targetFeet + s.eyeHeight;
        s.velocity.y = 0;
        s.grounded = true;
        steppedUp = true;
      } else if (delta >= -o.groundSnapDistance && delta <= 0 && s.velocity.y <= 0) {
        s.position.y = targetFeet + s.eyeHeight;
        s.velocity.y = 0;
        s.grounded = true;
      } else {
        s.position.y += s.velocity.y * dt;
        s.grounded = false;
        const feet = s.position.y - s.eyeHeight;
        if (feet < targetFeet) {
          s.position.y = targetFeet + s.eyeHeight;
          s.velocity.y = 0;
          s.grounded = true;
        }
      }
      s.groundSurface = surface.kind;
    } else {
      s.position.y += s.velocity.y * dt;
      s.grounded = false;
      s.groundSurface = null;
    }

    if (input.jump && s.grounded && surface.walkable) {
      s.velocity.y = o.jumpSpeed;
      s.grounded = false;
    }

    // crouch eye height (smoothed)
    const desiredEye = input.crouch ? o.crouchEyeHeight : o.eyeHeight;
    s.eyeHeight += (desiredEye - s.eyeHeight) * Math.min(1, dt * 12);

    this.telemetry = {
      grounded: s.grounded,
      slopeDeg: groundNow.slopeDeg,
      blockedBySlope,
      blockedByWall,
      steppedUp,
      speed: Math.hypot(s.velocity.x, s.velocity.z),
      groundSurface: s.groundSurface,
    };
  }

  teleport(p: Vec3): void {
    this.state.position = { ...p };
    this.state.velocity = { x: 0, y: 0, z: 0 };
  }

  /** Drop onto the terrain at the current x/z. */
  spawnOnGround(sampleGround: (x: number, z: number) => GroundSample): boolean {
    const g = sampleGround(this.state.position.x, this.state.position.z);
    if (g.height === null) return false;
    this.state.position.y = g.height + this.state.eyeHeight;
    this.state.velocity = { x: 0, y: 0, z: 0 };
    this.state.grounded = true;
    return true;
  }
}

/** Backend seam for swapping in Rapier (or another engine) per project. */
export interface PhysicsBackend {
  readonly id: string;
  readonly available: boolean;
  init(): Promise<boolean>;
  step(dt: number): void;
  dispose(): void;
}

/** The always-available built-in backend. */
export class BuiltinPhysicsBackend implements PhysicsBackend {
  readonly id = 'builtin';
  readonly available = true;
  private timestep = new FixedTimestep();
  constructor(private world: CollisionWorld) {}
  async init(): Promise<boolean> {
    return true;
  }
  step(dt: number): void {
    // Colliders are static in the built-in backend; the timestep still runs so
    // callers have a single place to hook deterministic simulation.
    this.timestep.advance(dt);
    void this.world;
  }
  dispose(): void {
    this.timestep.reset();
  }
}

/**
 * Optional lightweight spring deformation for props (REQUIREMENT 112).
 * Explicitly NOT cloth: one damped spring per prop, O(1) per frame.
 */
export class SpringDeformer {
  private offset = 0;
  private velocity = 0;
  constructor(
    private stiffness = 180,
    private damping = 12,
    private maxOffset = 0.6,
  ) {}

  /** Apply an impulse (e.g. the player brushed past the prop). */
  impulse(amount: number): void {
    this.velocity += amount;
  }

  step(dt: number, targetRest = 0): number {
    const force = -this.stiffness * (this.offset - targetRest) - this.damping * this.velocity;
    this.velocity += force * dt;
    this.offset += this.velocity * dt;
    if (this.offset > this.maxOffset) this.offset = this.maxOffset;
    if (this.offset < -this.maxOffset) this.offset = -this.maxOffset;
    return this.offset;
  }

  get current(): number {
    return this.offset;
  }

  reset(): void {
    this.offset = 0;
    this.velocity = 0;
  }
}
