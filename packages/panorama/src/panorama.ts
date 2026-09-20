/**
 * packages/panorama — panorama representation and camera constraints
 * (REQUIREMENT 038, 039, 040, 045).
 *
 * The old repository approximated a panorama with a slightly-curved plane and
 * slid images across it. It looked like a cube at the edges and could expose
 * black background. Here the panorama is a real equirectangular sphere:
 *
 *   - geometry: a UV sphere with the texture mapped 1:1, rendered with
 *     BackSide so the camera sits inside it (see scene-core/PanoramaView);
 *   - poles: when a capture has no valid pole data, top/bottom environment caps
 *     are blended in with a gradient and a colour-matched tint, so looking
 *     straight up never reveals black;
 *   - pitch: clamped to a configurable limit BEFORE the user can expose the
 *     distorted pole region.
 *
 * All of this is pure math, so it is unit-testable without WebGL.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PanoramaCapsConfig {
  enabled: boolean;
  top: string;
  bottom: string;
  /** Blend width in degrees from each pole. */
  blendDeg: number;
}

export interface PanoramaGeometrySpec {
  /** Horizontal field of view of the capture, degrees (360 = full equirect). */
  hfovDeg: number;
  /** Vertical field of view of the capture, degrees (180 = full sphere). */
  vfovDeg: number;
  /** Sphere radius in local metres. Large enough that parallax is negligible. */
  radius: number;
  /** Lat/long segments. 64x48 is visually smooth without wasting vertices. */
  latSegments: number;
  lonSegments: number;
}

export const defaultGeometrySpec = (): PanoramaGeometrySpec => ({
  hfovDeg: 360,
  vfovDeg: 180,
  radius: 500,
  latSegments: 48,
  lonSegments: 96,
});

/**
 * Equirectangular direction -> UV in [0,1].
 * u wraps with heading, v runs 0 at the top (+Y) to 1 at the bottom (-Y).
 */
export function directionToEquirectUv(dir: Vec3, out: Vec2 = { x: 0, y: 0 }): Vec2 {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const nx = dir.x / len;
  const ny = dir.y / len;
  const nz = dir.z / len;
  const u = (Math.atan2(nx, -nz) / (2 * Math.PI) + 0.5) % 1;
  const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, ny))) / Math.PI;
  out.x = u < 0 ? u + 1 : u;
  out.y = v;
  return out;
}

/** UV -> unit direction (inverse of the above). */
export function equirectUvToDirection(u: number, v: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const theta = (u - 0.5) * 2 * Math.PI;
  const phi = (0.5 - v) * Math.PI;
  out.x = Math.sin(theta) * Math.cos(phi);
  out.y = Math.sin(phi);
  out.z = -Math.cos(theta) * Math.cos(phi);
  return out;
}

/**
 * Clamp a panorama look pitch into the safe range.
 *
 * `limitDeg` is how far from the horizon the user may look. A full sphere would
 * allow 90; real street-level captures start degrading hard past ~70-75 because
 * the pole is stitched from a handful of pixels.
 */
export function clampPanoramaPitch(pitchDeg: number, limitDeg: number): number {
  const limit = Math.max(1, Math.min(89.5, limitDeg));
  // A NaN pitch slips through both comparisons — NaN < x and NaN > x are both
  // false — and would propagate into the camera quaternion, silently freezing
  // the view. Anything non-finite falls back to the horizon.
  if (!Number.isFinite(pitchDeg)) return 0;
  return pitchDeg < -limit ? -limit : pitchDeg > limit ? limit : pitchDeg;
}

/**
 * Blend weight for the pole caps at a given pitch.
 * 0 = pure panorama imagery, 1 = pure cap colour.
 * Uses a smoothstep over `blendDeg` starting at `startDeg` from the pole.
 */
export function capBlendWeight(pitchDeg: number, caps: PanoramaCapsConfig): number {
  if (!caps.enabled) return 0;
  const abs = Math.abs(pitchDeg);
  const start = 90 - caps.blendDeg;
  if (abs <= start) return 0;
  if (abs >= 90) return 1;
  const t = (abs - start) / Math.max(0.0001, 90 - start);
  return t * t * (3 - 2 * t);
}

export function capColorForPitch(pitchDeg: number, caps: PanoramaCapsConfig): string {
  return pitchDeg >= 0 ? caps.bottom : caps.top;
}

/**
 * Detect whether an equirect image actually contains valid pole data by
 * sampling the top and bottom rows. Runs on an ImageData / pixel buffer.
 *
 * A row of near-uniform colour, or of pure black/transparent pixels, means the
 * capture has no pole information and caps must be enabled.
 */
export function analyzePoleValidity(pixels: Uint8ClampedArray | Uint8Array, width: number, height: number, channels = 4): {
  topValid: boolean;
  bottomValid: boolean;
  topVariance: number;
  bottomVariance: number;
  topMean: [number, number, number];
  bottomMean: [number, number, number];
} {
  const rowStats = (row: number) => {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumSq = 0;
    let black = 0;
    for (let x = 0; x < width; x++) {
      const i = (row * width + x) * channels;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      sumR += r;
      sumG += g;
      sumB += b;
      sumSq += r * r + g * g + b * b;
      if (r < 8 && g < 8 && b < 8) black++;
    }
    const n = Math.max(1, width);
    const meanR = sumR / n;
    const meanG = sumG / n;
    const meanB = sumB / n;
    const variance = sumSq / n - (meanR * meanR + meanG * meanG + meanB * meanB);
    const blackRatio = black / n;
    return { mean: [meanR, meanG, meanB] as [number, number, number], variance, blackRatio };
  };

  const top = rowStats(0);
  const bottom = rowStats(height - 1);
  // A valid pole row has real colour variation and is not mostly black.
  const valid = (s: { variance: number; blackRatio: number }) => s.variance > 25 && s.blackRatio < 0.5;

  return {
    topValid: valid(top),
    bottomValid: valid(bottom),
    topVariance: top.variance,
    bottomVariance: bottom.variance,
    topMean: top.mean,
    bottomMean: bottom.mean,
  };
}

/**
 * Suggest cap colours from the panorama itself, so the caps colour-match the
 * capture instead of being a hard-coded sky/ground (REQUIREMENT 039).
 */
export function suggestCapColors(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  channels = 4,
): { top: string; bottom: string } {
  const bandMean = (rowStart: number, rowEnd: number) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = rowStart; y < rowEnd; y++) {
      for (let x = 0; x < width; x += 4) {
        const i = (y * width + x) * channels;
        r += pixels[i];
        g += pixels[i + 1];
        b += pixels[i + 2];
        n++;
      }
    }
    n = Math.max(1, n);
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)] as const;
  };
  const toHex = ([r, g, b]: readonly [number, number, number]) =>
    '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  return {
    top: toHex(bandMean(0, Math.max(1, Math.floor(height * 0.06)))),
    bottom: toHex(bandMean(Math.floor(height * 0.94), height)),
  };
}

/** Match exposure between two panoramas so a transition does not flash. */
export function exposureRatio(
  aMean: readonly [number, number, number],
  bMean: readonly [number, number, number],
): number {
  const lum = (c: readonly [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const la = Math.max(1, lum(aMean));
  const lb = Math.max(1, lum(bMean));
  const ratio = lb / la;
  // clamp so a pathological capture cannot blow out the transition
  return ratio < 0.25 ? 0.25 : ratio > 4 ? 4 : ratio;
}

/* --------------------------------------------------------- black-gap guard --- */

export type GapFallback = 'environment' | 'floor' | 'sky' | 'none';

export interface GapGuardResult {
  fallback: GapFallback;
  reason: string;
  /** True when the user should be told data is genuinely missing. */
  reportMissing: boolean;
}

/**
 * REQUIREMENT 045: never reveal black. Decide what to draw behind a panorama
 * whose imagery is incomplete, and say whether it is a genuine data gap that
 * the user should see reported.
 */
export function resolveGapFallback(
  hasImage: boolean,
  imageLoaded: boolean,
  caps: PanoramaCapsConfig,
): GapGuardResult {
  if (!hasImage) {
    return {
      fallback: 'environment',
      reason: 'This panorama node has no image assigned yet.',
      reportMissing: true,
    };
  }
  if (!imageLoaded) {
    // A loading panorama shows the previous frame / environment, never black.
    return { fallback: 'sky', reason: 'Panorama image is still loading.', reportMissing: false };
  }
  if (!caps.enabled) {
    return {
      fallback: 'floor',
      reason: 'Pole caps are disabled; poles fall back to a neutral floor/sky gradient.',
      reportMissing: false,
    };
  }
  return { fallback: 'none', reason: 'Panorama is complete.', reportMissing: false };
}
