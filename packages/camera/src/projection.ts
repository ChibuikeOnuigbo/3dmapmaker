/**
 * packages/camera — centralised projection utilities (REQUIREMENT 094, 069, 096).
 *
 * Every place in the app that needs world<->screen math goes through here:
 * picking, gizmos, labels, annotations, measurement endpoints, lasso filtering
 * and terrain snapping. Having one implementation is what makes the
 * "annotations drift from the terrain" class of bug impossible to reintroduce.
 *
 * Pure math on plain objects — no three.js import — so it runs in workers and
 * in vitest without a WebGL context.
 */
import type { Vec3T } from './transition';

export interface ViewportRect {
  width: number;
  height: number;
  /** devicePixelRatio already folded in? keep this in CSS pixels */
  left?: number;
  top?: number;
}

export interface CameraBasis {
  position: Vec3T;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  fovDeg: number;
  aspect: number;
  near: number;
  far: number;
}

export interface Ray {
  origin: Vec3T;
  direction: Vec3T;
}

const DEG = Math.PI / 180;

/**
 * Forward / right / up basis vectors for a camera.
 *
 * Convention used everywhere in this codebase:
 *   heading 0 = looking north = -Z, heading 90 = looking east = +X
 *   pitch < 0 = looking down
 *   +Y is up
 */
export function cameraBasisVectors(cam: CameraBasis) {
  const h = cam.headingDeg * DEG;
  const p = cam.pitchDeg * DEG;
  const fx = Math.sin(h) * Math.cos(p);
  const fy = Math.sin(p);
  const fz = -Math.cos(h) * Math.cos(p);

  // right = normalize(cross(forward, worldUp))
  let rx = -fz;
  let ry = 0;
  let rz = fx;
  const rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-9) {
    rx = 1;
    ry = 0;
    rz = 0;
  } else {
    rx /= rl;
    ry /= rl;
    rz /= rl;
  }
  // up = cross(right, forward)
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;
  return { fx, fy, fz, rx, ry, rz, ux, uy, uz };
}

/**
 * 4x4 view-projection matrix, ROW-MAJOR: element at (row, col) is `out[row*4+col]`.
 * Kept row-major with an explicit accessor because mixing conventions here is
 * exactly how projection bugs hide.
 */
export function viewProjectionMatrix(cam: CameraBasis, out = new Float64Array(16)): Float64Array {
  const b = cameraBasisVectors(cam);
  const r = cam.rollDeg * DEG;
  const cosR = Math.cos(r);
  const sinR = Math.sin(r);

  // roll about the forward axis
  const rrx = b.rx * cosR + b.ux * sinR;
  const rry = b.ry * cosR + b.uy * sinR;
  const rrz = b.rz * cosR + b.uz * sinR;
  const rux = b.ux * cosR - b.rx * sinR;
  const ruy = b.uy * cosR - b.ry * sinR;
  const ruz = b.uz * cosR - b.rz * sinR;
  // the view matrix's third row is -forward
  const v2x = -b.fx;
  const v2y = -b.fy;
  const v2z = -b.fz;

  const px = cam.position.x;
  const py = cam.position.y;
  const pz = cam.position.z;

  // View rows (world -> camera)
  const v0 = [rrx, rry, rrz, -(rrx * px + rry * py + rrz * pz)];
  const v1 = [rux, ruy, ruz, -(rux * px + ruy * py + ruz * pz)];
  const v2 = [v2x, v2y, v2z, -(v2x * px + v2y * py + v2z * pz)];

  // Perspective (OpenGL-style, depth mapped to [-1,1])
  const f = 1 / Math.tan((cam.fovDeg * DEG) / 2);
  const nf = 1 / (cam.near - cam.far);
  const p00 = f / cam.aspect;
  const p11 = f;
  const p22 = (cam.far + cam.near) * nf;
  const p23 = 2 * cam.far * cam.near * nf;

  // M = P * V
  const row0 = v0.map((v) => p00 * v);
  const row1 = v1.map((v) => p11 * v);
  const row2 = [p22 * v2[0], p22 * v2[1], p22 * v2[2], p22 * v2[3] + p23];
  const row3 = [-v2[0], -v2[1], -v2[2], -v2[3]];

  for (let c = 0; c < 4; c++) {
    out[c] = row0[c];
    out[4 + c] = row1[c];
    out[8 + c] = row2[c];
    out[12 + c] = row3[c];
  }
  return out;
}

/**
 * World -> CSS-pixel screen coordinates. Returns null when the point is behind
 * the camera (callers must not draw a label there).
 */
export function worldToScreen(world: Vec3T, cam: CameraBasis, vp: ViewportRect, out = { x: 0, y: 0, visible: true }) {
  const m = viewProjectionMatrix(cam);
  const x = world.x;
  const y = world.y;
  const z = world.z;
  // row-major: row r is m[r*4 .. r*4+3]
  const cx = m[0] * x + m[1] * y + m[2] * z + m[3];
  const cy = m[4] * x + m[5] * y + m[6] * z + m[7];
  const cw = m[12] * x + m[13] * y + m[14] * z + m[15];

  if (cw <= 1e-6) {
    out.x = 0;
    out.y = 0;
    out.visible = false;
    return out;
  }
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  out.x = ((ndcX + 1) / 2) * vp.width;
  out.y = ((1 - ndcY) / 2) * vp.height;
  out.visible = ndcX >= -1.2 && ndcX <= 1.2 && ndcY >= -1.2 && ndcY <= 1.2;
  return out;
}

/** Screen (CSS px, origin top-left) -> world ray. */
export function rayFromScreen(sx: number, sy: number, cam: CameraBasis, vp: ViewportRect): Ray {
  const ndcX = (sx / Math.max(1, vp.width)) * 2 - 1;
  const ndcY = 1 - (sy / Math.max(1, vp.height)) * 2;

  const h = cam.headingDeg * DEG;
  const p = cam.pitchDeg * DEG;
  const fx = Math.sin(h) * Math.cos(p);
  const fy = Math.sin(p);
  const fz = -Math.cos(h) * Math.cos(p);

  let rx = -fz;
  let ry = 0;
  let rz = fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl;
  ry /= rl;
  rz /= rl;

  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  const tanHalf = Math.tan((cam.fovDeg * DEG) / 2);
  const halfH = tanHalf;
  const halfW = tanHalf * cam.aspect;

  const dx = fx + rx * ndcX * halfW + ux * ndcY * halfH;
  const dy = fy + ry * ndcX * halfW + uy * ndcY * halfH;
  const dz = fz + rz * ndcX * halfW + uz * ndcY * halfH;
  const len = Math.hypot(dx, dy, dz) || 1;

  return {
    origin: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
    direction: { x: dx / len, y: dy / len, z: dz / len },
  };
}

/** Unproject to a point on the plane y = planeY (used when there is no terrain). */
export function screenToWorldOnPlane(
  sx: number,
  sy: number,
  cam: CameraBasis,
  vp: ViewportRect,
  planeY = 0,
): Vec3T | null {
  const ray = rayFromScreen(sx, sy, cam, vp);
  if (Math.abs(ray.direction.y) < 1e-6) return null;
  const t = (planeY - ray.origin.y) / ray.direction.y;
  if (t < 0) return null;
  return {
    x: ray.origin.x + ray.direction.x * t,
    y: planeY,
    z: ray.origin.z + ray.direction.z * t,
  };
}

export interface TerrainHit {
  point: Vec3T;
  normal: Vec3T;
  distance: number;
  /** Grid/tile key when the hit came from a real tile. */
  tileKey?: string;
}

/**
 * Ray march against a height sampler. Used for terrain snapping (REQ 096) and
 * as the coarse pass before an exact BVH triangle test.
 *
 * Bounded: `maxSteps` guarantees termination even on pathological rays, which
 * is what keeps hover picking from stalling the frame (REQ 069).
 */
export function rayTerrainHit(
  ray: Ray,
  sample: (x: number, z: number) => number | null,
  opts: { maxDistance?: number; maxSteps?: number; epsilon?: number } = {},
): TerrainHit | null {
  const maxDistance = opts.maxDistance ?? 20000;
  const maxSteps = opts.maxSteps ?? 512;
  const eps = opts.epsilon ?? 0.02;

  // Fast reject: a ray pointing up from above the terrain can never hit.
  let t = 0;
  let prevAbove: boolean | null = null;
  let prevPoint: Vec3T = { ...ray.origin };
  const stepBase = Math.max(0.25, maxDistance / maxSteps);

  for (let i = 0; i < maxSteps; i++) {
    const point = {
      x: ray.origin.x + ray.direction.x * t,
      y: ray.origin.y + ray.direction.y * t,
      z: ray.origin.z + ray.direction.z * t,
    };
    const h = sample(point.x, point.z);
    if (h !== null) {
      const above = point.y >= h;
      if (prevAbove === true && !above) {
        // bisect to refine the crossing
        let lo = t - stepBase;
        let hi = t;
        for (let k = 0; k < 24; k++) {
          const mid = (lo + hi) / 2;
          const mp = {
            x: ray.origin.x + ray.direction.x * mid,
            y: ray.origin.y + ray.direction.y * mid,
            z: ray.origin.z + ray.direction.z * mid,
          };
          const mh = sample(mp.x, mp.z);
          if (mh === null) break;
          if (mp.y >= mh) lo = mid;
          else hi = mid;
        }
        const hitT = (lo + hi) / 2;
        const hitPoint = {
          x: ray.origin.x + ray.direction.x * hitT,
          y: ray.origin.y + ray.direction.y * hitT,
          z: ray.origin.z + ray.direction.z * hitT,
        };
        const hh = sample(hitPoint.x, hitPoint.z);
        return {
          point: { x: hitPoint.x, y: hh ?? hitPoint.y, z: hitPoint.z },
          normal: { x: 0, y: 1, z: 0 },
          distance: hitT,
        };
      }
      prevAbove = above;
      prevPoint = point;
      // Adaptive step: shrink near the surface for accuracy, grow in open air.
      const clearance = Math.abs(point.y - h);
      t += Math.max(eps, Math.min(stepBase * 4, clearance * 0.5 + stepBase * 0.25));
    } else {
      prevAbove = null;
      t += stepBase;
    }
    if (t > maxDistance) break;
  }
  void prevPoint;
  return null;
}

/** Ray vs axis-aligned box, returns entry distance or null. */
export function rayBoxHit(ray: Ray, min: Vec3T, max: Vec3T): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  const o = [ray.origin.x, ray.origin.y, ray.origin.z];
  const d = [ray.direction.x, ray.direction.y, ray.direction.z];
  const lo = [min.x, min.y, min.z];
  const hi = [max.x, max.y, max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
      continue;
    }
    let t1 = (lo[i] - o[i]) / d[i];
    let t2 = (hi[i] - o[i]) / d[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmax < 0 ? null : Math.max(0, tmin);
}

/** Ray vs sphere, returns entry distance or null. */
export function raySphereHit(ray: Ray, center: Vec3T, radius: number): number | null {
  const ox = ray.origin.x - center.x;
  const oy = ray.origin.y - center.y;
  const oz = ray.origin.z - center.z;
  const b = ox * ray.direction.x + oy * ray.direction.y + oz * ray.direction.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c > 0 && b > 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

/**
 * Screen-space candidate filter for lasso selection (REQUIREMENT 095): cheap
 * bounding-sphere projection first, exact geometry test only for survivors.
 */
export function sphereInPolygon(
  center: Vec3T,
  radius: number,
  cam: CameraBasis,
  vp: ViewportRect,
  polygon: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  const s = worldToScreen(center, cam, vp);
  if (!s.visible) return false;
  // projected radius in pixels
  const dist = Math.max(
    1e-3,
    Math.hypot(center.x - cam.position.x, center.y - cam.position.y, center.z - cam.position.z),
  );
  const pxRadius = (radius / (2 * dist * Math.tan((cam.fovDeg * DEG) / 2))) * vp.height;
  if (pointInPolygon(s.x, s.y, polygon)) return true;
  // cheap conservative test: any polygon vertex inside the projected disc
  for (const p of polygon) {
    if (Math.hypot(p.x - s.x, p.y - s.y) <= pxRadius) return true;
  }
  return false;
}

export function pointInPolygon(x: number, y: number, poly: ReadonlyArray<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a segment in screen space — used for path vertex hit testing. */
export function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
