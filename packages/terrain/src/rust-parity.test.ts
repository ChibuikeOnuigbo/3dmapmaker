/**
 * Cross-language parity guard.
 *
 * `crates/terrain-core` is a Rust port of this package. It exists to run the
 * same maths faster — as a host library and as a wasm module — and the whole
 * point of the determinism guarantee is that a tile generated natively is
 * identical to one generated here.
 *
 * A port that drifts does not crash. It silently produces terrain that differs
 * from the preview thumbnail, which is the exact failure the guarantee exists to
 * prevent. So the constants the Rust parity test asserts against
 * (`crates/terrain-core/tests/parity.rs`) are duplicated here, and this test
 * re-derives them from the live TypeScript.
 *
 * **If this test fails, the TypeScript changed and the Rust port is now stale.**
 * Re-measure, then update `parity.rs` to match. Do not "fix" this test by
 * loosening a comparison — these are exact `f64` equalities for a reason.
 *
 * Note this file cannot itself run the Rust (no toolchain here — see
 * DEVELOPMENT_LOG.md §7). It verifies the *expectations* the Rust test encodes,
 * which is the half that can be checked from this side.
 */
import { describe, expect, it } from 'vitest';
import { Heightfield, Rng, Simplex2D, fbm, hash2 } from './index';

/** Sample points shared by the simplex and fbm constants. */
const PTS: Array<[number, number]> = [
  [0, 0],
  [1.5, -2.25],
  [31.25, 7.5],
  [-100.125, 42.0625],
  [255.5, 255.5],
];

/** The fbm options every heightfield constant below was generated with. */
const OPTS = {
  octaves: 6,
  lacunarity: 2,
  gain: 0.5,
  amplitude: 240,
  frequency: 1.4,
  warp: 0.25,
  ridged: false,
};

/**
 * The reference field the Rust `parity.rs` mirrors: 9×9, 256 m, centred on the
 * origin, noise scale 0.35. Changing its shape invalidates every constant.
 */
function referenceField(): Heightfield {
  const s = new Simplex2D(1337);
  const hf = new Heightfield(9, 256, -128, -128);
  for (let gy = 0; gy < 9; gy++) {
    for (let gx = 0; gx < 9; gx++) {
      hf.set(gx, gy, fbm(s, (gx - 4) * 0.35, (gy - 4) * 0.35, OPTS));
    }
  }
  return hf;
}

describe('rust parity — PRNG', () => {
  it('Rng(1337) reproduces the recorded stream', () => {
    const r = new Rng(1337);
    expect([r.next(), r.next(), r.next(), r.next(), r.next()]).toEqual([
      0.2853916718158871, 0.4259378134738654, 0.7511920523829758, 0.06261546374298632,
      0.5761158398818225,
    ]);
  });

  it('Rng(0) falls back to the golden-ratio constant', () => {
    // `seed | 0 || 0x9e3779b9` — a zero seed must not produce a dead stream.
    const r = new Rng(0);
    expect([r.next(), r.next(), r.next()]).toEqual([
      0.8505931859835982, 0.684420470148325, 0.4986653965897858,
    ]);
  });
});

describe('rust parity — simplex', () => {
  it('the permutation shuffle matches', () => {
    const s = new Simplex2D(1337);
    const perm = (s as unknown as { perm: Uint8Array }).perm;
    expect(Array.from(perm.slice(0, 16))).toEqual([
      240, 117, 55, 52, 173, 223, 94, 36, 160, 193, 78, 201, 225, 65, 33, 246,
    ]);
  });

  it('noise values match', () => {
    const s = new Simplex2D(1337);
    expect(PTS.map(([x, y]) => s.noise(x, y))).toEqual([
      0, -0.5124781555896574, -0.20202758549716382, -0.1642383172473901, -0.49891702776088825,
    ]);
  });
});

describe('rust parity — fbm and hash', () => {
  it('fbm values match', () => {
    const s = new Simplex2D(1337);
    expect(PTS.map(([x, y]) => fbm(s, x, y, OPTS))).toEqual([
      -81.71928795693569, -112.02562929104, 38.187484834865074, 117.83179457477667,
      37.43801136278205,
    ]);
  });

  it('hash2 values match', () => {
    expect([hash2(3, 7, 1337), hash2(-1, 0, 1337), hash2(0, 0, 0), hash2(255, 255, 90210)]).toEqual([
      0.4079786299262196, 0.7080115142744035, 0, 0.2466275948099792,
    ]);
  });
});

describe('rust parity — heightfield', () => {
  it('is the shape the constants describe', () => {
    const hf = referenceField();
    expect(hf.resolution).toBe(9);
    expect(hf.size).toBe(256);
    expect(hf.originX).toBe(-128);
    expect(hf.originY).toBe(-128);
    expect(hf.data.length).toBe(81);
    expect(hf.step).toBe(32);
  });

  it('stored elevations match', () => {
    const hf = referenceField();
    expect(Array.from(hf.data.slice(0, 8))).toEqual([
      -21.618356704711914, -146.08917236328125, -56.64381408691406, -16.776060104370117,
      20.32321548461914, -47.87694549560547, -8.149736404418945, -78.02739715576172,
    ]);
  });

  it('bilinear samples match, including the clamped edges', () => {
    const hf = referenceField();
    const points: Array<[number, number]> = [
      [0, 0],
      [-128, -128],
      [128, 128],
      [13.5, -22.25],
      // Deliberately far outside: these must clamp, not return NaN.
      [9999, 9999],
    ];
    expect(points.map(([x, y]) => hf.sample(x, y))).toEqual([
      -81.71929168701172, -21.618356704711914, 69.17530822753906, -29.107262702978915,
      69.17530822753906,
    ]);
  });

  it('the surface normal matches', () => {
    const hf = referenceField();
    const n = hf.normalAt(10, -20);
    const want = [0.5297664905991002, 0.49386815914029697, 0.6895228109538419];
    [n.x, n.y, n.z].forEach((v, i) => {
      // `Math.hypot` is not required to be bit-identical to sqrt(a²+b²+1), so
      // this is the one comparison that allows a last-ulp difference.
      expect(Math.abs(v - want[i])).toBeLessThan(1e-15);
    });
  });

  it('slope, aspect and curvature match', () => {
    const hf = referenceField();
    expect(hf.slopeAt(10, -20)).toBeCloseTo(46.40765291775327, 12);
    expect(hf.aspectAt(10, -20)).toBeCloseTo(47.008509871499314, 12);
    expect(hf.curvatureAt(10, -20)).toBeCloseTo(0.07054537327712751, 12);
  });

  it('the elevation extrema match', () => {
    const { min, max } = referenceField().minMax();
    expect([min, max]).toEqual([-146.08917236328125, 164.99786376953125]);
  });
});
