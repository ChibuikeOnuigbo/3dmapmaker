/**
 * packages/terrain — sculpting brushes (REQUIREMENT 048, 049).
 *
 * Every brush takes a real ray-terrain hit point (local metres) produced by the
 * picking layer, not a screen-space guess. Brushes mutate a Heightfield in place
 * and return the affected grid range so only dirty tiles are re-meshed.
 *
 * Falloff model: `w = smoothstep(1, hardness, d/radius) * strength` so hardness
 * and falloff are independent knobs, matching the exposed UI.
 */
import type { Heightfield } from './heightfield';

export type BrushTool =
  | 'raise'
  | 'lower'
  | 'smooth'
  | 'flatten'
  | 'terrace'
  | 'noise'
  | 'erosion'
  | 'stamp'
  | 'ridge'
  | 'valley'
  | 'plateau'
  | 'crater'
  | 'roadcut'
  | 'watercarve';

export interface BrushParams {
  tool: BrushTool;
  /** Radius in metres. */
  radius: number;
  /** Metres of elevation change per second at full strength. */
  strength: number;
  /** 0..1 — how quickly influence falls off from the centre. */
  falloff: number;
  /** 0..1 — size of the flat core before falloff begins. */
  hardness: number;
  /** Noise amount for the 'noise' tool. */
  noiseAmount: number;
  /** Terrace step height in metres. */
  terraceStep: number;
  /** Target elevation for flatten / plateau / roadcut / watercarve. */
  target: number;
  /** Symmetry axis: 'none' | 'x' | 'y' | 'both'. */
  symmetry: 'none' | 'x' | 'y' | 'both';
  /** Stamp height profile name. */
  stampProfile: 'cone' | 'dome' | 'bell' | 'mesa' | 'trench';
  /** Seconds of brush contact for this application (delta time). */
  dt: number;
  /** Deterministic seed for the noise brush. */
  seed: number;
}

export const defaultBrush = (): BrushParams => ({
  tool: 'raise',
  radius: 40,
  strength: 12,
  falloff: 0.5,
  hardness: 0.35,
  noiseAmount: 6,
  terraceStep: 10,
  target: 0,
  symmetry: 'none',
  stampProfile: 'dome',
  dt: 1 / 60,
  seed: 1,
});

export interface BrushResult {
  changed: boolean;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Grid vertices touched, for the dirty-region tracker. */
  touched: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Radial weight in [0,1]. hardness = flat core fraction, falloff = curve power. */
export function brushWeight(dist: number, radius: number, hardness: number, falloff: number): number {
  if (radius <= 0) return 0;
  const d = dist / radius;
  if (d >= 1) return 0;
  const core = Math.max(0, Math.min(0.98, hardness));
  if (d <= core) return 1;
  const p = 1 + falloff * 3; // falloff 0 -> linear-ish, 1 -> very soft
  return Math.pow(1 - (d - core) / (1 - core), p);
}

function stampProfileValue(profile: BrushParams['stampProfile'], t: number): number {
  switch (profile) {
    case 'cone':
      return 1 - t;
    case 'dome':
      return Math.sqrt(Math.max(0, 1 - t * t));
    case 'bell':
      return Math.exp(-4.5 * t * t);
    case 'mesa':
      return t < 0.6 ? 1 : smoothstep(1, 0.6, t);
    case 'trench':
      return -(1 - t * t);
  }
}

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Apply one brush dab at local metres (cx, cy).
 *
 * `hf` is mutated in place; callers are responsible for marking the tile dirty
 * and, for edits that must survive regeneration, recording the delta in the
 * project's edit overlay.
 */
export function applyBrush(hf: Heightfield, cx: number, cy: number, params: BrushParams): BrushResult {
  const p = params;
  const r = Math.max(hf.step * 1.5, p.radius);
  const { gx: cgx, gy: cgy } = hf.worldToGrid(cx, cy);
  const reach = Math.ceil(r / hf.step);

  const targets: Array<[number, number]> = [[cx, cy]];
  if (p.symmetry === 'x' || p.symmetry === 'both') {
    targets.push([hf.originX * 2 + hf.size - cx, cy]);
  }
  if (p.symmetry === 'y' || p.symmetry === 'both') {
    targets.push([cx, hf.originY * 2 + hf.size - cy]);
  }
  if (p.symmetry === 'both') {
    targets.push([hf.originX * 2 + hf.size - cx, hf.originY * 2 + hf.size - cy]);
  }

  let touched = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [tx, ty] of targets) {
    const centre = hf.worldToGrid(tx, ty);
    const x0 = Math.max(0, Math.floor(centre.gx - reach));
    const x1 = Math.min(hf.resolution - 1, Math.ceil(centre.gx + reach));
    const y0 = Math.max(0, Math.floor(centre.gy - reach));
    const y1 = Math.min(hf.resolution - 1, Math.ceil(centre.gy + reach));

    // snapshot for neighbourhood-based tools so the pass is order-independent
    const snapshot =
      p.tool === 'smooth' || p.tool === 'erosion' ? new Float32Array(hf.data) : null;

    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const wx = hf.originX + gx * hf.step;
        const wy = hf.originY + gy * hf.step;
        const dist = Math.hypot(wx - tx, wy - ty);
        const w = brushWeight(dist, r, p.hardness, p.falloff);
        if (w <= 0) continue;

        const idx = gy * hf.resolution + gx;
        const h = hf.data[idx];
        let next = h;
        const dt = Math.max(0, p.dt);

        switch (p.tool) {
          case 'raise':
            next = h + p.strength * dt * w;
            break;
          case 'lower':
            next = h - p.strength * dt * w;
            break;
          case 'smooth': {
            if (!snapshot) break;
            const res = hf.resolution;
            const l = snapshot[idx - 1] ?? h;
            const rt = snapshot[idx + 1] ?? h;
            const dn = snapshot[idx - res] ?? h;
            const up = snapshot[idx + res] ?? h;
            const avg = (l + rt + dn + up + h) / 5;
            next = h + (avg - h) * Math.min(1, p.strength * 0.25 * dt * 4 * w);
            break;
          }
          case 'flatten':
          case 'plateau':
            next = h + (p.target - h) * Math.min(1, p.strength * 0.2 * dt * 4 * w);
            break;
          case 'terrace': {
            const step = Math.max(0.5, p.terraceStep);
            const level = Math.round(h / step) * step;
            next = h + (level - h) * Math.min(1, p.strength * 0.2 * dt * 4 * w);
            break;
          }
          case 'noise': {
            const n = (hash(gx, gy, p.seed) - 0.5) * 2 * p.noiseAmount;
            next = h + n * w * Math.min(1, dt * 4);
            break;
          }
          case 'erosion': {
            if (!snapshot) break;
            // Thermal (talus) erosion: move material downhill when the local
            // slope exceeds the talus angle. Cheap, stable, no external solver.
            const res = hf.resolution;
            const neighbours = [snapshot[idx - 1], snapshot[idx + 1], snapshot[idx - res], snapshot[idx + res]];
            let lowest = h;
            for (const nv of neighbours) if (Number.isFinite(nv) && nv < lowest) lowest = nv;
            const diff = h - lowest;
            const talus = hf.step * 0.8;
            if (diff > talus) {
              const move = (diff - talus) * 0.25 * w * Math.min(1, p.strength * 0.1 * dt * 4);
              next = h - move;
            }
            break;
          }
          case 'stamp': {
            const t = Math.min(1, dist / r);
            const amp = p.strength * 4 * dt;
            next = h + stampProfileValue(p.stampProfile, t) * amp * w;
            break;
          }
          case 'ridge': {
            // pull towards a ridge line through the dab centre along +x
            const ridgeH = p.target !== 0 ? p.target : h + p.strength * 4;
            const lineDist = Math.abs(wy - ty);
            const lw = brushWeight(lineDist, r, p.hardness, p.falloff);
            next = h + (ridgeH - h) * lw * Math.min(1, p.strength * 0.15 * dt * 4);
            break;
          }
          case 'valley': {
            const valleyH = p.target !== 0 ? p.target : h - p.strength * 4;
            const lineDist = Math.abs(wy - ty);
            const lw = brushWeight(lineDist, r, p.hardness, p.falloff);
            next = h + (valleyH - h) * lw * Math.min(1, p.strength * 0.15 * dt * 4);
            break;
          }
          case 'crater': {
            const t = dist / r;
            const rim = Math.exp(-Math.pow((t - 0.78) * 4.2, 2)) * p.strength * 2.2 * dt;
            const bowl = -Math.max(0, 1 - t / 0.8) * p.strength * 2.2 * dt;
            next = h + (rim + bowl) * w;
            break;
          }
          case 'roadcut':
          case 'watercarve': {
            // carve towards `target`, never above the current surface
            const cut = Math.min(h, p.target);
            next = h + (cut - h) * Math.min(1, p.strength * 0.2 * dt * 4 * w);
            break;
          }
        }

        if (!Number.isFinite(next)) continue;
        hf.data[idx] = next;
        touched++;
        if (gx < minX) minX = gx;
        if (gx > maxX) maxX = gx;
        if (gy < minY) minY = gy;
        if (gy > maxY) maxY = gy;
      }
    }
  }

  return {
    changed: touched > 0,
    minX: Number.isFinite(minX) ? minX : 0,
    minY: Number.isFinite(minY) ? minY : 0,
    maxX: Number.isFinite(maxX) ? maxX : 0,
    maxY: Number.isFinite(maxY) ? maxY : 0,
    touched,
  };
}

/**
 * Apply a stroke as a series of dabs spaced by ~radius/4 so fast pointer moves
 * do not leave gaps. This is what the sculpt tool actually calls.
 */
export function applyStroke(
  hf: Heightfield,
  from: { x: number; y: number },
  to: { x: number; y: number },
  params: BrushParams,
): BrushResult {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const spacing = Math.max(hf.step, params.radius * 0.25);
  const steps = Math.min(256, Math.max(1, Math.ceil(dist / spacing)));
  let acc: BrushResult = { changed: false, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, touched: 0 };
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const res = applyBrush(hf, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, {
      ...params,
      dt: params.dt / steps,
    });
    if (res.changed) {
      acc.changed = true;
      acc.touched += res.touched;
      acc.minX = Math.min(acc.minX, res.minX);
      acc.minY = Math.min(acc.minY, res.minY);
      acc.maxX = Math.max(acc.maxX, res.maxX);
      acc.maxY = Math.max(acc.maxY, res.maxY);
    }
  }
  if (!acc.changed) acc = { changed: false, minX: 0, minY: 0, maxX: 0, maxY: 0, touched: 0 };
  return acc;
}
