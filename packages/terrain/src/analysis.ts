/**
 * packages/terrain — analysis passes (REQUIREMENT 050, 051, 053, 054).
 *
 * Hillshade, slope/aspect/curvature rasters, contour extraction (marching
 * squares) and elevation profiles. All of it is pure numeric work and is
 * dispatched to `workers/analysis.worker.ts` for anything larger than a
 * preview-sized tile.
 */
import type { Heightfield } from './heightfield';

export interface HillshadeOptions {
  /** Sun azimuth, degrees clockwise from north. */
  azimuthDeg: number;
  /** Sun elevation above the horizon, degrees. */
  elevationDeg: number;
  /** 0..1 brightness multiplier. */
  intensity: number;
  /** Vertical exaggeration used for shading only. */
  zFactor: number;
  /** Cell size in metres. */
  cellSize: number;
}

export const defaultHillshade = (): HillshadeOptions => ({
  azimuthDeg: 315,
  elevationDeg: 45,
  intensity: 1,
  zFactor: 1,
  cellSize: 30,
});

/**
 * Horn's (1981) 3x3 hillshade — the standard algorithm used by GDAL/ArcGIS.
 * Returns a Uint8ClampedArray of luminance values, one per grid vertex.
 */
export function hillshade(hf: Heightfield, opts: HillshadeOptions): Uint8ClampedArray {
  const r = hf.resolution;
  const out = new Uint8ClampedArray(r * r);
  const cell = opts.cellSize > 0 ? opts.cellSize : hf.step;
  const zen = ((90 - opts.elevationDeg) * Math.PI) / 180;
  const az = ((360 - opts.azimuthDeg + 90) * Math.PI) / 180;
  const sinZen = Math.sin(zen);
  const cosZen = Math.cos(zen);

  for (let gy = 0; gy < r; gy++) {
    for (let gx = 0; gx < r; gx++) {
      const i = gy * r + gx;
      const gx0 = Math.max(0, gx - 1);
      const gx1 = Math.min(r - 1, gx + 1);
      const gy0 = Math.max(0, gy - 1);
      const gy1 = Math.min(r - 1, gy + 1);
      const a = hf.data[gy0 * r + gx0];
      const b = hf.data[gy0 * r + gx];
      const c = hf.data[gy0 * r + gx1];
      const d = hf.data[gy * r + gx0];
      const f = hf.data[gy * r + gx1];
      const g = hf.data[gy1 * r + gx0];
      const h = hf.data[gy1 * r + gx];
      const ii = hf.data[gy1 * r + gx1];

      const dzdx = ((c + 2 * f + ii) - (a + 2 * d + g)) / (8 * cell);
      const dzdy = ((g + 2 * h + ii) - (a + 2 * b + c)) / (8 * cell);
      const slope = Math.atan(opts.zFactor * Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      let shade = 255 * (cosZen * Math.cos(slope) + sinZen * Math.sin(slope) * Math.cos(az - aspect));
      shade = Math.max(0, Math.min(255, shade * opts.intensity));
      out[i] = shade;
    }
  }
  return out;
}

export function slopeRaster(hf: Heightfield): Float32Array {
  const r = hf.resolution;
  const out = new Float32Array(r * r);
  for (let gy = 0; gy < r; gy++) {
    for (let gx = 0; gx < r; gx++) {
      const wx = hf.originX + gx * hf.step;
      const wy = hf.originY + gy * hf.step;
      out[gy * r + gx] = hf.slopeAt(wx, wy);
    }
  }
  return out;
}

export function aspectRaster(hf: Heightfield): Float32Array {
  const r = hf.resolution;
  const out = new Float32Array(r * r);
  for (let gy = 0; gy < r; gy++) {
    for (let gx = 0; gx < r; gx++) {
      const wx = hf.originX + gx * hf.step;
      const wy = hf.originY + gy * hf.step;
      out[gy * r + gx] = hf.aspectAt(wx, wy);
    }
  }
  return out;
}

/* --------------------------------------------------------------- contours --- */

export interface ContourSegment {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  elevation: number;
  /** true when this is an index contour (labelled). */
  index: boolean;
}

export interface ContourResult {
  segments: ContourSegment[];
  levels: number[];
  bounds: { min: number; max: number };
}

/**
 * Marching squares contour extraction.
 *
 * `indexEvery` marks every Nth level as an index contour so labels can be
 * attached to the heavier lines only, which is what keeps the label count low
 * enough for collision avoidance to be cheap (REQUIREMENT 051).
 */
export function extractContours(
  hf: Heightfield,
  interval: number,
  indexEvery = 5,
  maxSegments = 200000,
): ContourResult {
  if (!(interval > 0)) throw new Error('Contour interval must be positive');
  const r = hf.resolution;
  const { min, max } = hf.minMax();
  const first = Math.ceil(min / interval) * interval;
  const levels: number[] = [];
  for (let l = first; l <= max; l += interval) levels.push(Number(l.toFixed(6)));

  const segments: ContourSegment[] = [];

  for (let li = 0; li < levels.length; li++) {
    const level = levels[li];
    const index = indexEvery > 0 && li % indexEvery === 0;
    for (let gy = 0; gy < r - 1; gy++) {
      for (let gx = 0; gx < r - 1; gx++) {
        if (segments.length >= maxSegments) {
          return { segments, levels, bounds: { min, max } };
        }
        const v00 = hf.data[gy * r + gx];
        const v10 = hf.data[gy * r + gx + 1];
        const v01 = hf.data[(gy + 1) * r + gx];
        const v11 = hf.data[(gy + 1) * r + gx + 1];

        let caseIndex = 0;
        if (v00 > level) caseIndex |= 1;
        if (v10 > level) caseIndex |= 2;
        if (v11 > level) caseIndex |= 4;
        if (v01 > level) caseIndex |= 8;
        if (caseIndex === 0 || caseIndex === 15) continue;

        const x0 = hf.originX + gx * hf.step;
        const y0 = hf.originY + gy * hf.step;
        const s = hf.step;

        // edge midpoints, interpolated
        const bottom = () => ({ x: x0 + s * interp(v00, v10, level), y: y0 });
        const right = () => ({ x: x0 + s, y: y0 + s * interp(v10, v11, level) });
        const top = () => ({ x: x0 + s * interp(v01, v11, level), y: y0 + s });
        const left = () => ({ x: x0, y: y0 + s * interp(v00, v01, level) });

        const push = (p: { x: number; y: number }, q: { x: number; y: number }) => {
          segments.push({
            ax: p.x,
            ay: p.y,
            az: level,
            bx: q.x,
            by: q.y,
            bz: level,
            elevation: level,
            index,
          });
        };

        switch (caseIndex) {
          case 1:
          case 14:
            push(left(), bottom());
            break;
          case 2:
          case 13:
            push(bottom(), right());
            break;
          case 3:
          case 12:
            push(left(), right());
            break;
          case 4:
          case 11:
            push(right(), top());
            break;
          case 5: // saddle — disambiguate with the cell average
            if ((v00 + v10 + v01 + v11) / 4 > level) {
              push(left(), top());
              push(bottom(), right());
            } else {
              push(left(), bottom());
              push(right(), top());
            }
            break;
          case 6:
          case 9:
            push(bottom(), top());
            break;
          case 7:
          case 8:
            push(left(), top());
            break;
          case 10: // saddle
            if ((v00 + v10 + v01 + v11) / 4 > level) {
              push(left(), bottom());
              push(right(), top());
            } else {
              push(left(), top());
              push(bottom(), right());
            }
            break;
        }
      }
    }
  }

  return { segments, levels, bounds: { min, max } };
}

function interp(a: number, b: number, level: number): number {
  const d = b - a;
  if (Math.abs(d) < 1e-9) return 0.5;
  const t = (level - a) / d;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/* ------------------------------------------------------ elevation profile --- */

export interface ProfilePoint {
  /** Cumulative horizontal distance along the route, metres. */
  distance: number;
  elevation: number;
  /** Slope to the next sample, degrees. */
  slopeDeg: number;
  x: number;
  y: number;
}

export interface ElevationProfile {
  points: ProfilePoint[];
  totalDistance: number;
  minElevation: number;
  maxElevation: number;
  ascent: number;
  descent: number;
  maxSlopeDeg: number;
  averageSlopeDeg: number;
}

/**
 * Sample an elevation profile along a route of local-space points.
 * Values are real metres — vertical exaggeration is never applied here
 * (REQUIREMENT 052).
 */
export function elevationProfile(
  hf: { sample(x: number, y: number): number },
  route: ReadonlyArray<{ x: number; y: number }>,
  samplesPerSegment = 16,
  maxSamples = 4096,
): ElevationProfile {
  const points: ProfilePoint[] = [];
  let distance = 0;
  let prev: { x: number; y: number } | null = null;

  const budget = Math.max(2, Math.floor(maxSamples / Math.max(1, route.length - 1)));
  const per = Math.max(2, Math.min(samplesPerSegment, budget));

  for (let i = 0; i < route.length; i++) {
    const a = route[i];
    if (prev) {
      const dx = a.x - prev.x;
      const dy = a.y - prev.y;
      const segLen = Math.hypot(dx, dy);
      for (let s = 1; s <= per; s++) {
        const t = s / per;
        const x = prev.x + dx * t;
        const y = prev.y + dy * t;
        points.push({ distance: distance + segLen * t, elevation: hf.sample(x, y), slopeDeg: 0, x, y });
      }
      distance += segLen;
    } else {
      points.push({ distance: 0, elevation: hf.sample(a.x, a.y), slopeDeg: 0, x: a.x, y: a.y });
    }
    prev = a;
  }

  let minE = Infinity;
  let maxE = -Infinity;
  let ascent = 0;
  let descent = 0;
  let maxSlope = 0;
  let slopeSum = 0;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.elevation < minE) minE = p.elevation;
    if (p.elevation > maxE) maxE = p.elevation;
    if (i > 0) {
      const prevP = points[i - 1];
      const dd = p.distance - prevP.distance;
      const dz = p.elevation - prevP.elevation;
      if (dz > 0) ascent += dz;
      else descent += -dz;
      const slope = dd > 1e-6 ? (Math.atan2(dz, dd) * 180) / Math.PI : 0;
      p.slopeDeg = slope;
      const absS = Math.abs(slope);
      if (absS > maxSlope) maxSlope = absS;
      slopeSum += absS;
    }
  }

  return {
    points,
    totalDistance: distance,
    minElevation: Number.isFinite(minE) ? minE : 0,
    maxElevation: Number.isFinite(maxE) ? maxE : 0,
    ascent,
    descent,
    maxSlopeDeg: maxSlope,
    averageSlopeDeg: points.length > 1 ? slopeSum / (points.length - 1) : 0,
  };
}
