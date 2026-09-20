/**
 * packages/camera — camera transitions (REQUIREMENT 036, 037).
 *
 * A single controller handles:
 *   - duration presets (Fast / Normal / Cinematic / Custom — nothing is
 *     hard-coded slow, which was an explicit complaint about the old app),
 *   - easing curves,
 *   - optional Catmull-Rom spline paths,
 *   - terrain following,
 *   - user interruption (any input cancels and hands control back immediately).
 *
 * The old repository used nested `setTimeout`s plus a synchronous
 * `renderer.domElement.toDataURL()` for its "persistence" effect. That is a
 * full GPU readback on the main thread mid-transition — one of the reasons the
 * panorama moves felt slow. Nothing here blocks.
 */
import type { RigState } from './modes';
import { clamp } from './modes';

export type TransitionSpeed = 'fast' | 'normal' | 'cinematic' | 'custom';
export type EasingName = 'linear' | 'easeInOutCubic' | 'easeOutExpo' | 'easeInOutSine';

export const SPEED_MS: Record<TransitionSpeed, number> = {
  fast: 180,
  normal: 520,
  cinematic: 2200,
  custom: 0, // caller supplies customMs
};

export function durationMs(speed: TransitionSpeed, customMs = 1200): number {
  return speed === 'custom' ? Math.max(1, customMs) : SPEED_MS[speed];
}

export function ease(name: EasingName, t: number): number {
  const x = clamp(t, 0, 1);
  switch (name) {
    case 'linear':
      return x;
    case 'easeInOutCubic':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case 'easeOutExpo':
      return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
    case 'easeInOutSine':
      return -(Math.cos(Math.PI * x) - 1) / 2;
  }
}

export interface Vec3T {
  x: number;
  y: number;
  z: number;
}

export interface TransitionRequest {
  to: Partial<RigState> & { position?: Vec3T; target?: Vec3T };
  durationMs?: number;
  easing?: EasingName;
  /** Optional intermediate control points for a spline flight path. */
  path?: Vec3T[];
  /** Sample terrain height along the path and keep this clearance above it. */
  terrainFollow?: { clearance: number; sample: (x: number, z: number) => number | null };
  /** Called on every tick with the interpolated state. */
  onUpdate?: (state: RigState, t: number) => void;
  onComplete?: (state: RigState) => void;
  onCancel?: (state: RigState, t: number) => void;
  interruptible?: boolean;
}

export type TransitionPhase = 'idle' | 'running' | 'completed' | 'cancelled';

/** Catmull-Rom through the given control points, t in [0,1]. */
export function catmullRom(points: ReadonlyArray<Vec3T>, t: number, out: Vec3T = { x: 0, y: 0, z: 0 }): Vec3T {
  if (points.length === 0) return out;
  if (points.length === 1) return Object.assign(out, points[0]);
  const n = points.length;
  const scaled = clamp(t, 0, 1) * (n - 1);
  const i = Math.min(n - 2, Math.floor(scaled));
  const f = scaled - i;
  const p0 = points[Math.max(0, i - 1)];
  const p1 = points[i];
  const p2 = points[Math.min(n - 1, i + 1)];
  const p3 = points[Math.min(n - 1, i + 2)];
  const f2 = f * f;
  const f3 = f2 * f;
  const w = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f2 + (-a + 3 * b - 3 * c + d) * f3);
  out.x = w(p0.x, p1.x, p2.x, p3.x);
  out.y = w(p0.y, p1.y, p2.y, p3.y);
  out.z = w(p0.z, p1.z, p2.z, p3.z);
  return out;
}

export class CameraTransitionController {
  private phase: TransitionPhase = 'idle';
  private elapsed = 0;
  private duration = 0;
  private easing: EasingName = 'easeInOutCubic';
  private from: RigState | null = null;
  private to: RigState | null = null;
  private path: Vec3T[] | null = null;
  private req: TransitionRequest | null = null;
  private interruptible = true;
  private interruptionCount = 0;
  private completions = 0;

  get currentPhase(): TransitionPhase {
    return this.phase;
  }
  get isRunning(): boolean {
    return this.phase === 'running';
  }
  get progress(): number {
    return this.duration > 0 ? clamp(this.elapsed / this.duration, 0, 1) : 0;
  }
  get stats() {
    return { phase: this.phase, interruptions: this.interruptionCount, completions: this.completions };
  }

  /** Start a transition. Replaces any running one (no queueing surprises). */
  start(state: RigState, req: TransitionRequest): void {
    if (this.phase === 'running') this.cancel(state, 'superseded');
    this.from = {
      position: { ...state.position },
      target: { ...state.target },
      headingDeg: state.headingDeg,
      pitchDeg: state.pitchDeg,
      rollDeg: state.rollDeg,
      fovDeg: state.fovDeg,
      distance: state.distance,
    };
    this.to = { ...this.from, ...req.to, position: { ...(req.to.position ?? state.position) }, target: { ...(req.to.target ?? state.target) } };
    this.duration = Math.max(1, req.durationMs ?? 520);
    this.easing = req.easing ?? 'easeInOutCubic';
    this.path = req.path && req.path.length >= 2 ? req.path : null;
    this.interruptible = req.interruptible !== false;
    this.req = req;
    this.elapsed = 0;
    this.phase = 'running';
  }

  /**
   * Advance. Returns true while the transition owns the camera — the caller
   * must not apply free-look input in that case unless it interrupts.
   */
  update(state: RigState, dt: number): boolean {
    if (this.phase !== 'running' || !this.from || !this.to || !this.req) return false;
    this.elapsed += dt * 1000;
    const raw = clamp(this.elapsed / this.duration, 0, 1);
    const t = ease(this.easing, raw);

    const lerp = (a: number, b: number) => a + (b - a) * t;

    if (this.path) {
      const p = catmullRom(this.path, t);
      state.position.x = p.x;
      state.position.y = p.y;
      state.position.z = p.z;
    } else {
      state.position.x = lerp(this.from.position.x, this.to.position.x);
      state.position.y = lerp(this.from.position.y, this.to.position.y);
      state.position.z = lerp(this.from.position.z, this.to.position.z);
    }

    if (this.req.terrainFollow) {
      const h = this.req.terrainFollow.sample(state.position.x, state.position.z);
      if (h !== null) {
        const minY = h + this.req.terrainFollow.clearance;
        if (state.position.y < minY) state.position.y = minY;
      }
    }

    state.target.x = lerp(this.from.target.x, this.to.target.x);
    state.target.y = lerp(this.from.target.y, this.to.target.y);
    state.target.z = lerp(this.from.target.z, this.to.target.z);

    // heading takes the short way around the circle
    const dh = shortestAngle(this.from.headingDeg, this.to.headingDeg);
    state.headingDeg = this.from.headingDeg + dh * t;
    state.pitchDeg = lerp(this.from.pitchDeg, this.to.pitchDeg);
    state.rollDeg = lerp(this.from.rollDeg, this.to.rollDeg);
    state.fovDeg = lerp(this.from.fovDeg, this.to.fovDeg);
    state.distance = lerp(this.from.distance, this.to.distance);

    this.req.onUpdate?.(state, t);

    if (raw >= 1) {
      this.phase = 'completed';
      this.completions++;
      const cb = this.req.onComplete;
      this.req = null;
      cb?.(state);
    }
    return true;
  }

  /** User input arrived — hand control back immediately (REQUIREMENT 036). */
  cancel(state: RigState, _reason = 'user-input'): boolean {
    if (this.phase !== 'running') return false;
    if (!this.interruptible) return false;
    this.phase = 'cancelled';
    this.interruptionCount++;
    const req = this.req;
    this.req = null;
    req?.onCancel?.(state, this.progress);
    return true;
  }

  /** Force-stop even for non-interruptible transitions (mode switch). */
  abort(state: RigState): void {
    if (this.phase !== 'running') return;
    this.phase = 'cancelled';
    const req = this.req;
    this.req = null;
    req?.onCancel?.(state, this.progress);
  }

  reset(): void {
    this.phase = 'idle';
    this.elapsed = 0;
    this.req = null;
    this.from = null;
    this.to = null;
    this.path = null;
  }
}

/** Signed shortest angular delta a -> b, in degrees, range (-180, 180]. */
export function shortestAngle(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
