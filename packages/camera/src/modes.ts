/**
 * packages/camera — camera modes (REQUIREMENT 032, 033, 034, 111).
 *
 * All three modes write to the same `RigState`, so switching modes cannot lose
 * the camera and the transition controller has one shape to animate.
 *
 * Movement is always `delta time` based and diagonals are normalised, which is
 * the fix for the "WASD moves diagonally faster" class of bug.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface RigState {
  /** Camera position in local metres (already in render space). */
  position: Vec3Like;
  /** Orbit pivot, local metres. Only used by orbit mode. */
  target: Vec3Like;
  /** Yaw in degrees, 0 = looking north (-Z). */
  headingDeg: number;
  /** Pitch in degrees, negative = looking down. */
  pitchDeg: number;
  rollDeg: number;
  fovDeg: number;
  /** Orbit distance in metres. */
  distance: number;
}

export interface AxisInput {
  forward: number; // -1..1
  right: number; // -1..1
  up: number; // -1..1
  yaw: number; // -1..1
  pitch: number; // -1..1
  zoom: number; // accumulated wheel delta this frame
  boost: boolean;
  slow: boolean;
  jump: boolean;
  crouch: boolean;
}

export const emptyInput = (): AxisInput => ({
  forward: 0,
  right: 0,
  up: 0,
  yaw: 0,
  pitch: 0,
  zoom: 0,
  boost: false,
  slow: false,
  jump: false,
  crouch: false,
});

export interface ModeLimits {
  minPitchDeg: number;
  maxPitchDeg: number;
  minDistance: number;
  maxDistance: number;
  maxSpeed: number;
  minFovDeg: number;
  maxFovDeg: number;
}

export const DEFAULT_LIMITS: ModeLimits = {
  minPitchDeg: -89,
  maxPitchDeg: 89,
  minDistance: 1.5,
  maxDistance: 20000,
  maxSpeed: 600,
  minFovDeg: 20,
  maxFovDeg: 110,
};

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Frame-rate independent exponential smoothing. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/** Normalise a 2-axis input vector so diagonals are not faster. */
export function normalizeAxis(x: number, y: number): { x: number; y: number } {
  const len = Math.hypot(x, y);
  if (len > 1) return { x: x / len, y: y / len };
  return { x, y };
}

export function headingVector(headingDeg: number): Vec3Like {
  const rad = (headingDeg * Math.PI) / 180;
  // heading 0 = north = -Z; heading 90 = east = +X
  return { x: Math.sin(rad), y: 0, z: -Math.cos(rad) };
}

export function rightVector(headingDeg: number): Vec3Like {
  const rad = (headingDeg * Math.PI) / 180;
  return { x: Math.cos(rad), y: 0, z: Math.sin(rad) };
}

/* ------------------------------------------------------------------ orbit --- */

export interface OrbitOptions {
  panSpeed?: number;
  rotateSpeed?: number;
  zoomSpeed?: number;
  /** Screen-space panning keeps the grabbed point under the cursor. */
  screenSpacePanning?: boolean;
  damping?: number;
}

export class OrbitMode {
  private desiredHeading: number;
  private desiredPitch: number;
  private desiredDistance: number;
  private pan = { x: 0, y: 0, z: 0 };
  private opts: Required<OrbitOptions>;
  limits: ModeLimits;

  constructor(state: RigState, limits: ModeLimits = DEFAULT_LIMITS, opts: OrbitOptions = {}) {
    this.limits = limits;
    this.opts = {
      panSpeed: opts.panSpeed ?? 1,
      rotateSpeed: opts.rotateSpeed ?? 0.35,
      zoomSpeed: opts.zoomSpeed ?? 1,
      screenSpacePanning: opts.screenSpacePanning ?? true,
      damping: opts.damping ?? 10,
    };
    this.desiredHeading = state.headingDeg;
    this.desiredPitch = state.pitchDeg;
    this.desiredDistance = state.distance;
  }

  syncFrom(state: RigState): void {
    this.desiredHeading = state.headingDeg;
    this.desiredPitch = state.pitchDeg;
    this.desiredDistance = state.distance;
    this.pan = { x: 0, y: 0, z: 0 };
  }

  /** Left-drag orbit in degrees. */
  rotate(dxPx: number, dyPx: number, viewportHeightPx: number): void {
    const scale = this.opts.rotateSpeed * (180 / Math.max(1, viewportHeightPx));
    this.desiredHeading -= dxPx * scale * 2;
    this.desiredPitch -= dyPx * scale * 2;
    this.desiredPitch = clamp(this.desiredPitch, this.limits.minPitchDeg, this.limits.maxPitchDeg);
    // wrap heading into [-180, 180) so the compass never shows 720 degrees
    this.desiredHeading = ((this.desiredHeading + 180) % 360 + 360) % 360 - 180;
  }

  /** Right-drag / two-finger pan. `depthPx` scales pan by distance for a natural feel. */
  panBy(dxPx: number, dyPx: number, viewportHeightPx: number, fovDeg: number): void {
    const distance = Math.max(this.limits.minDistance, this.desiredDistance);
    const worldPerPixel = (2 * distance * Math.tan(((fovDeg * Math.PI) / 180) / 2)) / Math.max(1, viewportHeightPx);
    const f = headingVector(this.desiredHeading);
    const r = rightVector(this.desiredHeading);
    const scale = worldPerPixel * this.opts.panSpeed;
    if (this.opts.screenSpacePanning) {
      this.pan.x += -r.x * dxPx * scale + f.x * dyPx * scale;
      this.pan.y += dyPx * scale * 0; // vertical screen pan handled via forward/pitch blend below
      this.pan.z += -r.z * dxPx * scale + f.z * dyPx * scale;
      // approximate screen-vertical as a mix of forward and world-up
      const pitchRad = (this.desiredPitch * Math.PI) / 180;
      this.pan.x += f.x * dyPx * scale * Math.cos(pitchRad) * 0;
      this.pan.y += -dyPx * scale * Math.sin(pitchRad);
    } else {
      this.pan.x += -r.x * dxPx * scale + f.x * dyPx * scale;
      this.pan.z += -r.z * dxPx * scale + f.z * dyPx * scale;
    }
  }

  dolly(delta: number): void {
    // Multiplicative zoom keeps the feel consistent at every distance.
    const factor = Math.pow(1.0015, delta * 120 * this.opts.zoomSpeed);
    this.desiredDistance = clamp(this.desiredDistance * factor, this.limits.minDistance, this.limits.maxDistance);
  }

  setDistance(d: number): void {
    this.desiredDistance = clamp(d, this.limits.minDistance, this.limits.maxDistance);
  }

  setHeading(h: number): void {
    this.desiredHeading = h;
  }

  setPitch(p: number): void {
    this.desiredPitch = clamp(p, this.limits.minPitchDeg, this.limits.maxPitchDeg);
  }

  /**
   * Advance the rig. WASD in orbit mode pans the pivot along the ground plane
   * (Google-Maps-like), rather than flying the camera — that is the behaviour
   * users expect from a map product.
   */
  update(state: RigState, input: AxisInput, dt: number): void {
    const lambda = this.opts.damping;
    state.headingDeg = damp(state.headingDeg, this.desiredHeading, lambda, dt);
    state.pitchDeg = damp(state.pitchDeg, this.desiredPitch, lambda, dt);
    state.distance = damp(state.distance, this.desiredDistance, lambda * 1.4, dt);

    const speed = clamp(state.distance * 1.2, 5, this.limits.maxSpeed) * (input.boost ? 4 : input.slow ? 0.25 : 1);
    const ax = normalizeAxis(input.right, input.forward);
    const f = headingVector(state.headingDeg);
    const r = rightVector(state.headingDeg);
    state.target.x += (f.x * ax.y + r.x * ax.x) * speed * dt;
    state.target.z += (f.z * ax.y + r.z * ax.x) * speed * dt;
    state.target.y += input.up * speed * dt * 0.5;

    // apply queued pan
    state.target.x += this.pan.x;
    state.target.y += this.pan.y;
    state.target.z += this.pan.z;
    this.pan = { x: 0, y: 0, z: 0 };

    if (input.zoom !== 0) this.dolly(input.zoom);

    this.composePosition(state);
  }

  /** Place the camera on the orbit sphere around the target. */
  composePosition(state: RigState): void {
    const pitch = clamp(state.pitchDeg, this.limits.minPitchDeg, this.limits.maxPitchDeg);
    const d = clamp(state.distance, this.limits.minDistance, this.limits.maxDistance);
    const hRad = (state.headingDeg * Math.PI) / 180;
    const pRad = (pitch * Math.PI) / 180;
    const cosP = Math.cos(pRad);
    // Convention: negative pitch means "looking down", so the camera sits ABOVE
    // the target. sin(pitch) is therefore negated here.
    state.position.x = state.target.x + d * cosP * Math.sin(hRad);
    state.position.y = state.target.y - d * Math.sin(pRad);
    state.position.z = state.target.z + d * cosP * Math.cos(hRad);
  }
}

/* -------------------------------------------------------------------- fly --- */

export interface FlyOptions {
  baseSpeed?: number;
  boostMultiplier?: number;
  slowMultiplier?: number;
  lookSensitivity?: number;
  damping?: number;
}

export class FlyMode {
  private velocity = { x: 0, y: 0, z: 0 };
  private opts: Required<FlyOptions>;
  limits: ModeLimits;

  constructor(limits: ModeLimits = DEFAULT_LIMITS, opts: FlyOptions = {}) {
    this.limits = limits;
    this.opts = {
      baseSpeed: opts.baseSpeed ?? 40,
      boostMultiplier: opts.boostMultiplier ?? 5,
      slowMultiplier: opts.slowMultiplier ?? 0.25,
      lookSensitivity: opts.lookSensitivity ?? 0.12,
      damping: opts.damping ?? 8,
    };
  }

  look(dxPx: number, dyPx: number, state: RigState): void {
    const s = this.opts.lookSensitivity;
    state.headingDeg -= dxPx * s;
    state.pitchDeg = clamp(state.pitchDeg - dyPx * s, this.limits.minPitchDeg, this.limits.maxPitchDeg);
    state.headingDeg = ((state.headingDeg + 180) % 360 + 360) % 360 - 180;
  }

  update(state: RigState, input: AxisInput, dt: number): void {
    let speed = this.opts.baseSpeed;
    if (input.boost) speed *= this.opts.boostMultiplier;
    if (input.slow) speed *= this.opts.slowMultiplier;

    const ax = normalizeAxis(input.right, input.forward);
    const hRad = (state.headingDeg * Math.PI) / 180;
    const pRad = (state.pitchDeg * Math.PI) / 180;

    // forward in full 3D so pitch actually flies you up/down
    // pitch<0 means looking down, so the forward Y component is sin(pitch)
    const fx = Math.sin(hRad) * Math.cos(pRad);
    const fy = Math.sin(pRad);
    const fz = -Math.cos(hRad) * Math.cos(pRad);
    const rx = Math.cos(hRad);
    const rz = Math.sin(hRad);

    const targetVx = (fx * ax.y + rx * ax.x) * speed;
    const targetVy = (fy * ax.y + input.up) * speed;
    const targetVz = (fz * ax.y + rz * ax.x) * speed;

    const lambda = this.opts.damping;
    this.velocity.x = damp(this.velocity.x, targetVx, lambda, dt);
    this.velocity.y = damp(this.velocity.y, targetVy, lambda, dt);
    this.velocity.z = damp(this.velocity.z, targetVz, lambda, dt);

    state.position.x += this.velocity.x * dt;
    state.position.y += this.velocity.y * dt;
    state.position.z += this.velocity.z * dt;

    // fly keeps the orbit target in front of the camera so switching to orbit
    // does not teleport the view
    const lookAhead = Math.max(10, state.distance);
    state.target.x = state.position.x + fx * lookAhead;
    state.target.y = state.position.y + fy * lookAhead;
    state.target.z = state.position.z + fz * lookAhead;

    if (input.zoom !== 0) {
      state.fovDeg = clamp(state.fovDeg + input.zoom * 12, this.limits.minFovDeg, this.limits.maxFovDeg);
    }
  }

  getVelocity(): Vec3Like {
    return { ...this.velocity };
  }
}

/* ------------------------------------------------------------------- walk --- */

export interface WalkOptions {
  walkSpeed?: number;
  sprintMultiplier?: number;
  crouchMultiplier?: number;
  eyeHeight?: number;
  crouchEyeHeight?: number;
  gravity?: number;
  jumpSpeed?: number;
  /** Maximum walkable slope in degrees. */
  slopeLimitDeg?: number;
  /** Step height the controller can climb, metres. */
  stepHeight?: number;
  /** Capsule radius, metres. */
  radius?: number;
  groundProbeDistance?: number;
}

/** Ground query supplied by the terrain system. */
export interface GroundQuery {
  /** Elevation in local metres, or null when nothing is loaded here. */
  heightAt(x: number, z: number): number | null;
  /** Surface normal, +Y up. */
  normalAt(x: number, z: number): Vec3Like;
  /** Optional solid obstacles (walls / buildings). */
  collides?(x: number, y: number, z: number, radius: number): boolean;
}

export interface WalkTelemetry {
  grounded: boolean;
  groundY: number | null;
  slopeDeg: number;
  blockedBySlope: boolean;
  blockedByWall: boolean;
  steppedUp: boolean;
  verticalVelocity: number;
  speed: number;
}

export class WalkMode {
  private vy = 0;
  private grounded = false;
  private eye = 0;
  private opts: Required<WalkOptions>;
  telemetry: WalkTelemetry = {
    grounded: false,
    groundY: null,
    slopeDeg: 0,
    blockedBySlope: false,
    blockedByWall: false,
    steppedUp: false,
    verticalVelocity: 0,
    speed: 0,
  };

  constructor(opts: WalkOptions = {}) {
    this.opts = {
      walkSpeed: opts.walkSpeed ?? 6,
      sprintMultiplier: opts.sprintMultiplier ?? 2.4,
      crouchMultiplier: opts.crouchMultiplier ?? 0.45,
      eyeHeight: opts.eyeHeight ?? 1.7,
      crouchEyeHeight: opts.crouchEyeHeight ?? 1.0,
      gravity: opts.gravity ?? 22,
      jumpSpeed: opts.jumpSpeed ?? 6.5,
      slopeLimitDeg: opts.slopeLimitDeg ?? 46,
      stepHeight: opts.stepHeight ?? 0.45,
      radius: opts.radius ?? 0.35,
      groundProbeDistance: opts.groundProbeDistance ?? 0.6,
    };
    this.eye = this.opts.eyeHeight;
  }

  look(dxPx: number, dyPx: number, state: RigState, sensitivity = 0.12): void {
    state.headingDeg -= dxPx * sensitivity;
    state.pitchDeg = clamp(state.pitchDeg - dyPx * sensitivity, this.limits.minPitchDeg, this.limits.maxPitchDeg);
    state.headingDeg = ((state.headingDeg + 180) % 360 + 360) % 360 - 180;
  }

  private limits = { minPitchDeg: -85, maxPitchDeg: 85 };

  update(state: RigState, input: AxisInput, dt: number, ground: GroundQuery): void {
    // clamp dt so a stalled tab cannot tunnel the character through the floor
    const step = Math.min(dt, 1 / 20);

    let speed = this.opts.walkSpeed;
    if (input.boost) speed *= this.opts.sprintMultiplier;
    if (input.crouch) speed *= this.opts.crouchMultiplier;

    const ax = normalizeAxis(input.right, input.forward);
    const hRad = (state.headingDeg * Math.PI) / 180;
    const fx = Math.sin(hRad);
    const fz = -Math.cos(hRad);
    const rx = Math.cos(hRad);
    const rz = Math.sin(hRad);

    let dx = (fx * ax.y + rx * ax.x) * speed * step;
    let dz = (fz * ax.y + rz * ax.x) * speed * step;

    // --- slope limit -------------------------------------------------------
    const groundYHere = ground.heightAt(state.position.x, state.position.z);
    const groundYNext = ground.heightAt(state.position.x + dx, state.position.z + dz);
    let blockedBySlope = false;
    let slopeDeg = 0;
    if (groundYHere !== null && groundYNext !== null) {
      const horizontal = Math.hypot(dx, dz);
      if (horizontal > 1e-6) {
        slopeDeg = (Math.atan2(groundYNext - groundYHere, horizontal) * 180) / Math.PI;
        if (slopeDeg > this.opts.slopeLimitDeg) {
          blockedBySlope = true;
          dx = 0;
          dz = 0;
        }
      }
    }

    // --- wall collision (optional proxies) ---------------------------------
    let blockedByWall = false;
    if (ground.collides && ground.collides(state.position.x + dx, state.position.y - this.eye, state.position.z + dz, this.opts.radius)) {
      blockedByWall = true;
      dx = 0;
      dz = 0;
    }

    state.position.x += dx;
    state.position.z += dz;

    // --- gravity + ground snapping -----------------------------------------
    const groundY = ground.heightAt(state.position.x, state.position.z);
    const targetFeetY = groundY ?? state.position.y - this.eye;
    const feetY = state.position.y - this.eye;

    let steppedUp = false;
    if (groundY !== null) {
      const delta = targetFeetY - feetY;
      if (delta > 0 && delta <= this.opts.stepHeight && this.grounded) {
        // climb a step instead of jumping
        state.position.y = targetFeetY + this.eye;
        this.vy = 0;
        this.grounded = true;
        steppedUp = true;
      } else if (delta >= -this.opts.groundProbeDistance && delta <= 0 && this.vy <= 0) {
        state.position.y = targetFeetY + this.eye;
        this.vy = 0;
        this.grounded = true;
      } else {
        this.vy -= this.opts.gravity * step;
        state.position.y += this.vy * step;
        this.grounded = false;
        if (state.position.y - this.eye < targetFeetY) {
          state.position.y = targetFeetY + this.eye;
          this.vy = 0;
          this.grounded = true;
        }
      }
    } else {
      this.vy -= this.opts.gravity * step;
      state.position.y += this.vy * step;
      this.grounded = false;
    }

    if (input.jump && this.grounded) {
      this.vy = this.opts.jumpSpeed;
      this.grounded = false;
    }

    // smooth eye height for crouch
    const desiredEye = input.crouch ? this.opts.crouchEyeHeight : this.opts.eyeHeight;
    this.eye = damp(this.eye, desiredEye, 10, step);

    // keep the orbit target consistent for mode switching
    const pRad = (state.pitchDeg * Math.PI) / 180;
    state.target.x = state.position.x + Math.sin(hRad) * 5;
    state.target.y = state.position.y + Math.sin(pRad) * 5;
    state.target.z = state.position.z - Math.cos(hRad) * 5;
    state.distance = 5;

    this.telemetry = {
      grounded: this.grounded,
      groundY,
      slopeDeg,
      blockedBySlope,
      blockedByWall,
      steppedUp,
      verticalVelocity: this.vy,
      speed: Math.hypot(dx, dz) / Math.max(step, 1e-6),
    };
  }

  /** Drop the character onto the terrain at its current x/z. */
  respawnOnGround(state: RigState, ground: GroundQuery): void {
    const h = ground.heightAt(state.position.x, state.position.z);
    if (h === null) return;
    state.position.y = h + this.eye;
    this.vy = 0;
    this.grounded = true;
  }
}
