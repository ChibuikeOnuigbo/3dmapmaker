//! Cross-language parity tests.
//!
//! Every constant in this file was **measured from the shipped TypeScript**
//! (`packages/terrain/src/noise.ts` and `heightfield.ts`) by running it under
//! vitest and printing the values. Nothing here is a hand-computed expectation.
//!
//! That is the whole point of this file. This crate is a port, and a port that
//! diverges does not crash — it silently produces terrain that differs from the
//! preview thumbnail, which is precisely the failure the determinism guarantee
//! exists to prevent. These tests turn that silent failure into a named one.
//!
//! Regenerating the constants: run the TypeScript, print the same expressions,
//! and paste. If a value here ever needs to change, the TypeScript changed too,
//! and that is a conversation rather than a one-sided edit.
//!
//! **Status: these tests have never been run.** This sandbox has no Rust
//! toolchain — see DEVELOPMENT_LOG.md §7. They are written to be run, not to be
//! trusted on sight.

use terrain_core::heightfield::Heightfield;
use terrain_core::noise::{fbm, hash2, FbmOptions, Rng, Simplex2D};

/// Values from `Rng(1337)`.
const RNG_1337_FIRST5: [f64; 5] = [
    0.2853916718158871,
    0.4259378134738654,
    0.7511920523829758,
    0.06261546374298632,
    0.5761158398818225,
];

/// Values from `Rng(0)`, which falls back to the golden-ratio constant.
const RNG_0_FIRST3: [f64; 3] = [0.8505931859835982, 0.684420470148325, 0.4986653965897858];

/// Sample points used for the simplex and fbm constants.
const PTS: [(f64, f64); 5] = [(0.0, 0.0), (1.5, -2.25), (31.25, 7.5), (-100.125, 42.0625), (255.5, 255.5)];

/// `new Simplex2D(1337).noise(x, y)` at each point in `PTS`.
const SIMPLEX_1337: [f64; 5] = [
    0.0,
    -0.5124781555896574,
    -0.20202758549716382,
    -0.1642383172473901,
    -0.49891702776088825,
];

/// The first 16 bytes of the permutation table for seed 1337. Asserting the
/// shuffle itself localises a PRNG bug far better than a downstream noise value
/// does.
const PERM_FIRST16: [u8; 16] = [240, 117, 55, 52, 173, 223, 94, 36, 160, 193, 78, 201, 225, 65, 33, 246];

/// `fbm` with the standard options, at each point in `PTS`.
const FBM_1337: [f64; 5] = [
    -81.71928795693569,
    -112.02562929104,
    38.187484834865074,
    117.83179457477667,
    37.43801136278205,
];

/// The fbm options the heightfield constants below were generated with.
fn standard_options() -> FbmOptions {
    FbmOptions {
        octaves: 6,
        lacunarity: 2.0,
        gain: 0.5,
        amplitude: 240.0,
        frequency: 1.4,
        warp: 0.25,
        ridged: false,
    }
}

/// The first 8 stored elevations of a 9×9, 256 m field centred on the origin.
const HF_DATA_FIRST8: [f64; 8] = [
    -21.618356704711914,
    -146.08917236328125,
    -56.64381408691406,
    -16.776060104370117,
    20.32321548461914,
    -47.87694549560547,
    -8.149736404418945,
    -78.02739715576172,
];

/// `sample()` at a fixed set of points, including two deliberately far outside
/// the footprint, which must clamp rather than return NaN.
const HF_SAMPLE_POINTS: [(f64, f64); 5] =
    [(0.0, 0.0), (-128.0, -128.0), (128.0, 128.0), (13.5, -22.25), (9999.0, 9999.0)];
const HF_SAMPLES: [f64; 5] = [
    -81.71929168701172,
    -21.618356704711914,
    69.17530822753906,
    -29.107262702978915,
    69.17530822753906,
];

/// `normalAt(10, -20)`.
const HF_NORMAL: [f64; 3] = [0.5297664905991002, 0.49386815914029697, 0.6895228109538419];

/// `slopeAt`, `aspectAt`, `curvatureAt` at (10, -20).
const HF_SLOPE_ASPECT_CURV: [f64; 3] = [46.40765291775327, 47.008509871499314, 0.07054537327712751];

/// `minMax()` over the whole field.
const HF_MIN_MAX: (f64, f64) = (-146.08917236328125, 164.99786376953125);

/// The reference field: 9×9, 256 m, centred, filled with the standard options at
/// noise scale 0.35. This is exactly the shape the TypeScript constants came from.
fn reference_field() -> Heightfield {
    let mut hf = Heightfield::new(9, 256.0, -128.0, -128.0).expect("valid field");
    hf.fill_procedural(&Simplex2D::new(1337.0), &standard_options(), 0.35, true);
    hf
}

fn assert_close(label: &str, got: f64, want: f64, tol: f64) {
    assert!(
        (got - want).abs() <= tol,
        "{label}: got {got:.17}, want {want:.17} (Δ {:.3e}, tol {tol:.0e})",
        (got - want).abs()
    );
}

#[test]
fn rng_matches_the_typescript_stream() {
    let mut r = Rng::new(1337.0);
    for (i, want) in RNG_1337_FIRST5.iter().enumerate() {
        // The PRNG is pure integer arithmetic with a single division, so the
        // result should be bit-identical, not merely close.
        assert_close(&format!("rng_1337[{i}]"), r.next(), *want, 0.0);
    }
}

#[test]
fn rng_zero_seed_matches_the_fallback() {
    let mut r = Rng::new(0.0);
    for (i, want) in RNG_0_FIRST3.iter().enumerate() {
        assert_close(&format!("rng_0[{i}]"), r.next(), *want, 0.0);
    }
}

#[test]
fn permutation_shuffle_matches() {
    let s = Simplex2D::new(1337.0);
    let got = s.perm_prefix(16);
    assert_eq!(got, PERM_FIRST16.to_vec());
}

#[test]
fn simplex_matches_the_typescript() {
    let s = Simplex2D::new(1337.0);
    for (i, &(x, y)) in PTS.iter().enumerate() {
        assert_close(&format!("simplex_1337({x},{y})"), s.noise(x, y), SIMPLEX_1337[i], 0.0);
    }
}

#[test]
fn simplex_at_the_origin_is_exactly_zero() {
    // Not a rounding artefact worth tolerating: at (0,0) the three simplex
    // corner contributions are all zero by construction.
    assert_eq!(Simplex2D::new(1337.0).noise(0.0, 0.0), 0.0);
}

#[test]
fn fbm_matches_the_typescript() {
    let s = Simplex2D::new(1337.0);
    let o = standard_options();
    for (i, &(x, y)) in PTS.iter().enumerate() {
        assert_close(&format!("fbm_1337({x},{y})"), fbm(&s, x, y, &o), FBM_1337[i], 0.0);
    }
}

#[test]
fn hash2_matches_the_typescript() {
    let cases: [((f64, f64, f64), f64); 4] = [
        ((3.0, 7.0, 1337.0), 0.4079786299262196),
        ((-1.0, 0.0, 1337.0), 0.7080115142744035),
        ((0.0, 0.0, 0.0), 0.0),
        ((255.0, 255.0, 90210.0), 0.2466275948099792),
    ];
    for ((x, y, seed), want) in cases {
        assert_close(&format!("hash2({x},{y},{seed})"), hash2(x, y, seed), want, 0.0);
    }
}

#[test]
fn heightfield_step_matches() {
    assert_eq!(reference_field().step(), 32.0);
}

#[test]
fn heightfield_stored_values_match() {
    let hf = reference_field();
    for (i, want) in HF_DATA_FIRST8.iter().enumerate() {
        // Storage is f32, so widen to f64 for comparison — exactly the value a
        // Float32Array read back in JavaScript would give.
        assert_close(&format!("hf.data[{i}]"), f64::from(hf.data()[i]), *want, 0.0);
    }
}

#[test]
fn heightfield_samples_match_including_the_clamped_edges() {
    let hf = reference_field();
    for (i, &(x, y)) in HF_SAMPLE_POINTS.iter().enumerate() {
        let got = hf.sample(x, y);
        assert!(got.is_finite(), "sample({x},{y}) returned {got}");
        assert_close(&format!("hf.sample({x},{y})"), got, HF_SAMPLES[i], 0.0);
    }
}

#[test]
fn heightfield_normal_matches() {
    let hf = reference_field();
    let got = hf.normal_at(10.0, -20.0);
    for i in 0..3 {
        // JS `Math.hypot` is not required to be bit-identical to
        // sqrt(a²+b²+1), so allow a last-ulp difference here and nowhere else.
        assert_close(&format!("hf.normal[{i}]"), got[i], HF_NORMAL[i], 1e-15);
    }
}

#[test]
fn heightfield_slope_aspect_curvature_match() {
    let hf = reference_field();
    assert_close("hf.slopeAt", hf.slope_at(10.0, -20.0), HF_SLOPE_ASPECT_CURV[0], 1e-12);
    assert_close("hf.aspectAt", hf.aspect_at(10.0, -20.0), HF_SLOPE_ASPECT_CURV[1], 1e-12);
    assert_close("hf.curvatureAt", hf.curvature_at(10.0, -20.0), HF_SLOPE_ASPECT_CURV[2], 1e-12);
}

#[test]
fn heightfield_min_max_matches() {
    let (lo, hi) = reference_field().min_max();
    assert_close("hf.min", lo, HF_MIN_MAX.0, 0.0);
    assert_close("hf.max", hi, HF_MIN_MAX.1, 0.0);
}

#[test]
fn the_reference_field_is_the_shape_the_constants_describe() {
    // A guard against the reference drifting away from the constants above: if
    // someone changes the field's size or resolution, every constant in this
    // file becomes meaningless rather than merely stale.
    let hf = reference_field();
    assert_eq!(hf.resolution(), 9);
    assert_eq!(hf.size(), 256.0);
    assert_eq!(hf.origin_x(), -128.0);
    assert_eq!(hf.origin_y(), -128.0);
    assert_eq!(hf.data().len(), 81);

    // The centre vertex is the origin sample, which pins the centring behaviour.
    let (cx, cy) = hf.grid_to_world(4.0, 4.0);
    assert_close("centre x", cx, 0.0, 1e-12);
    assert_close("centre y", cy, 0.0, 1e-12);
    assert_close(
        "centre elevation == fbm(0,0)",
        hf.sample(0.0, 0.0),
        FBM_1337[0],
        1e-6,
    );
}
