/**
 * packages/terrain — deterministic, seedable noise.
 *
 * Runs identically on the main thread and inside the terrain worker, so a tile
 * generated in a worker matches one generated for a preview thumbnail.
 * No allocations in the hot path.
 */

/** SplitMix32-style PRNG. Tiny state, good distribution, fully deterministic. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed | 0 || 0x9e3779b9;
  }
  /** [0,1) */
  next(): number {
    this.s = (this.s + 0x9e3779b9) | 0;
    let t = this.s ^ (this.s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return (t >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }
}

const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/**
 * 2D simplex noise in [-1, 1]. Permutation table is derived from the seed so
 * two worlds with different seeds never share features.
 */
export class Simplex2D {
  private readonly perm: Uint8Array;
  private readonly permMod8: Uint8Array;

  constructor(seed = 1337) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher-Yates shuffle
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    this.perm = new Uint8Array(512);
    this.permMod8 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod8[i] = this.perm[i] % 8;
    }
  }

  noise(xin: number, yin: number): number {
    const { perm, permMod8 } = this;
    let n0 = 0;
    let n1 = 0;
    let n2 = 0;

    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    let i1: number;
    let j1: number;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const gi0 = permMod8[ii + perm[jj]];
      t0 *= t0;
      n0 = t0 * t0 * (GRAD2[gi0][0] * x0 + GRAD2[gi0][1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const gi1 = permMod8[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      n1 = t1 * t1 * (GRAD2[gi1][0] * x1 + GRAD2[gi1][1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const gi2 = permMod8[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      n2 = t2 * t2 * (GRAD2[gi2][0] * x2 + GRAD2[gi2][1] * y2);
    }
    // 70 scales the raw sum into roughly [-1, 1]
    return 70 * (n0 + n1 + n2);
  }
}

export interface FbmOptions {
  octaves: number;
  lacunarity: number;
  gain: number;
  amplitude: number;
  frequency: number;
  warp: number;
  ridged: boolean;
}

/**
 * Fractal Brownian motion with optional domain warp and ridged multifractal.
 * Returns metres of elevation.
 */
export function fbm(noise: Simplex2D, x: number, y: number, o: FbmOptions): number {
  let nx = x;
  let ny = y;
  if (o.warp > 0) {
    nx += o.warp * 220 * noise.noise(x * o.frequency * 0.4 + 31.7, y * o.frequency * 0.4 - 11.3);
    ny += o.warp * 220 * noise.noise(x * o.frequency * 0.4 - 47.2, y * o.frequency * 0.4 + 63.9);
  }

  let amp = 1;
  let freq = o.frequency;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < o.octaves; i++) {
    const n = noise.noise(nx * freq, ny * freq);
    // Both shapings land in [0, 1]: ridged peaks at 1 on the crests, the
    // smooth form is plain simplex remapped off the [-1, 1] range.
    const shaped = o.ridged ? 1 - Math.abs(n) : n * 0.5 + 0.5;
    sum += shaped * amp;
    norm += amp;
    amp *= o.gain;
    freq *= o.lacunarity;
  }
  if (!(norm > 0)) return 0;
  // `sum / norm` is in [0, 1]. Centre it on zero and scale by the requested
  // amplitude so the field spans [-amplitude, +amplitude] in metres. The
  // amplitude parameter is the relief budget — it must actually do something.
  return (sum / norm) * 2 * o.amplitude - o.amplitude;
}

/** Cheap hash-based value noise, used for scatter/jitter where smoothness is unneeded. */
export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
