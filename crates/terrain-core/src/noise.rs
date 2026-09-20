//! Deterministic, seedable noise.
//!
//! A faithful port of `packages/terrain/src/noise.ts`. The TypeScript is the
//! reference implementation — these constants and sequences were measured from
//! it and are asserted in `tests/parity.rs`, so a divergence between the two is
//! a test failure rather than a mystery in production.
//!
//! Determinism here is not a nice-to-have: the same tile must produce identical
//! heights whether it was generated in the terrain worker or on the main thread
//! for a preview thumbnail. If the PRNG stream differs by one value, every
//! feature downstream shifts and adjacent tiles stop stitching.

use crate::{to_int32, to_uint32, GOLDEN};

/// SplitMix32-style PRNG. Tiny state, good distribution, fully deterministic.
///
/// State is held as `i32` because JavaScript's `| 0` normalises it to that range
/// on every step anyway. Holding it wider would change nothing observable, but
/// holding it *narrower or differently signed* would change every value.
#[derive(Debug, Clone)]
pub struct Rng {
    s: i32,
}

impl Rng {
    /// Create a generator. A seed of `0` is replaced by the golden ratio
    /// constant, matching `seed | 0 || 0x9e3779b9` in the TypeScript — a zero
    /// seed would otherwise produce a degenerate stream.
    pub fn new(seed: f64) -> Self {
        let as_i32 = to_int32(seed);
        Self {
            s: if as_i32 == 0 { GOLDEN as i32 } else { as_i32 },
        }
    }

    /// Create a generator from an integer seed.
    pub fn from_i32(seed: i32) -> Self {
        Self::new(f64::from(seed))
    }

    /// Next value in `[0, 1)`.
    pub fn next(&mut self) -> f64 {
        // `Math.imul` multiplies as u32 and returns the low 32 bits read as a
        // signed i32, which is exactly what `wrapping_mul` on i32 does.
        self.s = self.s.wrapping_add(GOLDEN as i32);
        let mut t = self.s ^ ((to_uint32(f64::from(self.s)) >> 16) as i32);
        t = t.wrapping_mul(0x21f0_aaad);
        t ^= (to_uint32(f64::from(t)) >> 15) as i32;
        t = t.wrapping_mul(0x735a_2d97);
        t ^= (to_uint32(f64::from(t)) >> 15) as i32;
        f64::from(to_uint32(f64::from(t))) / 4_294_967_296.0
    }

    /// Uniform value in `[min, max)`.
    pub fn range(&mut self, min: f64, max: f64) -> f64 {
        min + self.next() * (max - min)
    }

    /// Uniform integer in `[min, max]`, inclusive at both ends.
    pub fn int(&mut self, min: f64, max: f64) -> f64 {
        self.range(min, max + 1.0).floor()
    }
}

/// The eight unit gradients, in the same order as the TypeScript table.
const GRAD2: [[f64; 2]; 8] = [
    [1.0, 1.0],
    [-1.0, 1.0],
    [1.0, -1.0],
    [-1.0, -1.0],
    [1.0, 0.0],
    [-1.0, 0.0],
    [0.0, 1.0],
    [0.0, -1.0],
];

const SQRT3: f64 = 1.732_050_807_568_877_2;
const F2: f64 = 0.5 * (SQRT3 - 1.0);
const G2: f64 = (3.0 - SQRT3) / 6.0;

/// 2D simplex noise in approximately `[-1, 1]`.
///
/// The permutation table is derived from the seed, so two worlds with different
/// seeds never share features.
#[derive(Clone)]
pub struct Simplex2D {
    perm: Vec<u8>,
    perm_mod8: Vec<u8>,
}

impl Simplex2D {
    /// Build a generator with the default seed of 1337.
    pub fn default_seeded() -> Self {
        Self::new(1337.0)
    }

    /// Build a generator for a seed.
    pub fn new(seed: f64) -> Self {
        let mut rng = Rng::new(seed);
        let mut p: Vec<u8> = (0..=255u8).collect();

        // Fisher-Yates, walking backwards, exactly as in the TypeScript.
        for i in (1..=255usize).rev() {
            let j = (rng.next() * (i as f64 + 1.0)).floor() as usize;
            p.swap(i, j);
        }

        let mut perm = vec![0u8; 512];
        let mut perm_mod8 = vec![0u8; 512];
        for i in 0..512usize {
            perm[i] = p[i & 255];
            perm_mod8[i] = perm[i] % 8;
        }
        Self { perm, perm_mod8 }
    }

    /// The first bytes of the permutation table. Exposed so the parity test can
    /// assert the shuffle itself, not just its downstream effect — a wrong PRNG
    /// is much easier to diagnose from the table than from a noise value.
    pub fn perm_prefix(&self, n: usize) -> Vec<u8> {
        self.perm[..n.min(self.perm.len())].to_vec()
    }

    /// Sample the noise field.
    pub fn noise(&self, xin: f64, yin: f64) -> f64 {
        let s = (xin + yin) * F2;
        let i = (xin + s).floor();
        let j = (yin + s).floor();
        let t = (i + j) * G2;
        let x0 = xin - (i - t);
        let y0 = yin - (j - t);

        // Which simplex we are in: the lower or the upper triangle.
        let (i1, j1) = if x0 > y0 { (1.0, 0.0) } else { (0.0, 1.0) };

        let x1 = x0 - i1 + G2;
        let y1 = y0 - j1 + G2;
        let x2 = x0 - 1.0 + 2.0 * G2;
        let y2 = y0 - 1.0 + 2.0 * G2;

        // `i & 255` in JS coerces the float through ToInt32 first.
        let ii = (to_int32(i) & 255) as usize;
        let jj = (to_int32(j) & 255) as usize;

        let mut n0 = 0.0;
        let mut n1 = 0.0;
        let mut n2 = 0.0;

        let mut t0 = 0.5 - x0 * x0 - y0 * y0;
        if t0 >= 0.0 {
            let gi0 = self.perm_mod8[ii + self.perm[jj] as usize] as usize;
            t0 *= t0;
            n0 = t0 * t0 * (GRAD2[gi0][0] * x0 + GRAD2[gi0][1] * y0);
        }
        let mut t1 = 0.5 - x1 * x1 - y1 * y1;
        if t1 >= 0.0 {
            let gi1 = self.perm_mod8[ii + i1 as usize + self.perm[jj + j1 as usize] as usize] as usize;
            t1 *= t1;
            n1 = t1 * t1 * (GRAD2[gi1][0] * x1 + GRAD2[gi1][1] * y1);
        }
        let mut t2 = 0.5 - x2 * x2 - y2 * y2;
        if t2 >= 0.0 {
            let gi2 = self.perm_mod8[ii + 1 + self.perm[jj + 1] as usize] as usize;
            t2 *= t2;
            n2 = t2 * t2 * (GRAD2[gi2][0] * x2 + GRAD2[gi2][1] * y2);
        }

        // 70 scales the raw sum into roughly [-1, 1].
        70.0 * (n0 + n1 + n2)
    }
}

/// Parameters for [`fbm`]. Mirrors `FbmOptions` in the TypeScript.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FbmOptions {
    /// Number of octaves to sum.
    pub octaves: usize,
    /// Frequency multiplier applied per octave.
    pub lacunarity: f64,
    /// Amplitude multiplier applied per octave.
    pub gain: f64,
    /// Relief budget in metres. The output spans `[-amplitude, +amplitude]`.
    pub amplitude: f64,
    /// Base frequency.
    pub frequency: f64,
    /// Domain-warp strength. `0` disables the warp entirely.
    pub warp: f64,
    /// Ridged multifractal instead of the smooth remap.
    pub ridged: bool,
}

impl Default for FbmOptions {
    fn default() -> Self {
        Self {
            octaves: 6,
            lacunarity: 2.0,
            gain: 0.5,
            amplitude: 240.0,
            frequency: 1.4,
            warp: 0.0,
            ridged: false,
        }
    }
}

/// Fractal Brownian motion with optional domain warp and ridged multifractal.
///
/// Returns metres of elevation.
pub fn fbm(noise: &Simplex2D, x: f64, y: f64, o: &FbmOptions) -> f64 {
    let mut nx = x;
    let mut ny = y;
    if o.warp > 0.0 {
        nx += o.warp * 220.0 * noise.noise(x * o.frequency * 0.4 + 31.7, y * o.frequency * 0.4 - 11.3);
        ny += o.warp * 220.0 * noise.noise(x * o.frequency * 0.4 - 47.2, y * o.frequency * 0.4 + 63.9);
    }

    let mut amp = 1.0;
    let mut freq = o.frequency;
    let mut sum = 0.0;
    let mut norm = 0.0;
    for _ in 0..o.octaves {
        let n = noise.noise(nx * freq, ny * freq);
        // Both shapings land in [0, 1]: ridged peaks at 1 on the crests, the
        // smooth form is plain simplex remapped off the [-1, 1] range.
        let shaped = if o.ridged { 1.0 - n.abs() } else { n * 0.5 + 0.5 };
        sum += shaped * amp;
        norm += amp;
        amp *= o.gain;
        freq *= o.lacunarity;
    }
    if !(norm > 0.0) {
        return 0.0;
    }
    // `sum / norm` is in [0, 1]. Centre it on zero and scale by the requested
    // amplitude so the field spans [-amplitude, +amplitude] in metres. The
    // amplitude parameter is the relief budget — it has to actually do
    // something, which is why this is not simply `sum`.
    (sum / norm) * 2.0 * o.amplitude - o.amplitude
}

/// Cheap hash-based value noise, used for scatter and jitter where smoothness is
/// unneeded.
pub fn hash2(x: f64, y: f64, seed: f64) -> f64 {
    let xi = to_int32(x);
    let yi = to_int32(y);
    let si = to_int32(seed);
    let mut h = xi
        .wrapping_mul(374_761_393)
        ^ yi.wrapping_mul(668_265_263)
        ^ si.wrapping_mul(2_147_483_647);
    h = (h ^ ((to_uint32(f64::from(h)) >> 13) as i32)).wrapping_mul(1_274_126_177);
    let out = h ^ ((to_uint32(f64::from(h)) >> 16) as i32);
    f64::from(to_uint32(f64::from(out))) / 4_294_967_296.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rng_stream_is_in_unit_interval() {
        let mut r = Rng::new(1337.0);
        for _ in 0..10_000 {
            let v = r.next();
            assert!((0.0..1.0).contains(&v), "value {v} escaped [0,1)");
        }
    }

    #[test]
    fn rng_is_deterministic_for_a_seed() {
        let a: Vec<f64> = (0..32).scan(Rng::new(4242.0), |r, _| Some(r.next())).collect();
        let b: Vec<f64> = (0..32).scan(Rng::new(4242.0), |r, _| Some(r.next())).collect();
        assert_eq!(a, b);
    }

    #[test]
    fn different_seeds_diverge() {
        let a: Vec<f64> = (0..8).scan(Rng::new(1.0), |r, _| Some(r.next())).collect();
        let b: Vec<f64> = (0..8).scan(Rng::new(2.0), |r, _| Some(r.next())).collect();
        assert_ne!(a, b);
    }

    #[test]
    fn zero_seed_falls_back_to_the_golden_ratio() {
        // `seed | 0 || 0x9e3779b9` — a zero seed must not produce a dead stream.
        let mut a = Rng::new(0.0);
        let mut b = Rng::new(f64::from(GOLDEN as i32));
        assert!((a.next() - b.next()).abs() < 1e-15);
    }

    #[test]
    fn simplex_stays_in_range() {
        let s = Simplex2D::new(1337.0);
        for i in 0..2000 {
            let x = (i as f64) * 0.137 - 137.0;
            let y = (i as f64) * -0.091 + 55.0;
            let v = s.noise(x, y);
            assert!(v.abs() <= 1.05, "noise {v} escaped [-1,1]");
        }
    }

    #[test]
    fn simplex_is_deterministic() {
        let s = Simplex2D::new(90210.0);
        assert_eq!(s.noise(12.5, -3.25), s.noise(12.5, -3.25));
    }

    #[test]
    fn fbm_respects_the_amplitude_budget() {
        let s = Simplex2D::new(1337.0);
        for amplitude in [10.0, 120.0, 500.0] {
            let o = FbmOptions { amplitude, ..FbmOptions::default() };
            let mut lo = f64::INFINITY;
            let mut hi = f64::NEG_INFINITY;
            for i in 0..500 {
                let v = fbm(&s, (i as f64) * 0.21, (i as f64) * -0.17, &o);
                lo = lo.min(v);
                hi = hi.max(v);
            }
            assert!(lo >= -amplitude - 1e-9, "min {lo} below -{amplitude}");
            assert!(hi <= amplitude + 1e-9, "max {hi} above {amplitude}");
            // The budget must be used, not merely respected.
            assert!(hi - lo > amplitude, "amplitude {amplitude} produced only {hi}-{lo} of relief");
        }
    }

    #[test]
    fn fbm_with_zero_octaves_is_zero() {
        let s = Simplex2D::new(1337.0);
        let o = FbmOptions { octaves: 0, ..FbmOptions::default() };
        assert_eq!(fbm(&s, 3.0, 4.0, &o), 0.0);
    }

    #[test]
    fn hash2_is_in_unit_interval_and_deterministic() {
        for i in 0..500 {
            let v = hash2(i as f64, (i * 7) as f64, 1337.0);
            assert!((0.0..1.0).contains(&v));
            assert_eq!(v, hash2(i as f64, (i * 7) as f64, 1337.0));
        }
    }

    #[test]
    fn ridged_and_smooth_differ() {
        let s = Simplex2D::new(1337.0);
        let smooth = fbm(&s, 5.0, 6.0, &FbmOptions::default());
        let ridged = fbm(
            &s,
            5.0,
            6.0,
            &FbmOptions { ridged: true, ..FbmOptions::default() },
        );
        assert!((smooth - ridged).abs() > 1e-6, "ridged flag had no effect");
    }
}
