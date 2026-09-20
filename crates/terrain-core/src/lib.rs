//! terrain-core — the native terrain kernel for 3DMapMaker Next.
//!
//! This is a **port of `packages/terrain`**, not an independent implementation.
//! The TypeScript is the reference: it is what ships, it is what the tests
//! cover, and it is what generated the reference constants asserted in
//! `tests/parity.rs`. The purpose of this crate is to run the same maths faster
//! — as a host library for the desktop build and as a wasm module in the browser
//! — so the two must agree to the last bit that a `Float32Array` can hold.
//!
//! ## Why zero dependencies
//!
//! Nothing here needs anything external, and the maths is small enough to audit
//! in full. `wasm-bindgen` is deliberately not used: its generated ABI is larger
//! than the hand-written one in [`wasm`], and a hand-written ABI can be read and
//! checked line by line against the JS glue that calls it.
//!
//! ## Numerical fidelity
//!
//! JavaScript does all arithmetic in `f64` and narrows to `f32` only when a
//! value is stored in a `Float32Array`. The port reproduces that exactly:
//! intermediate work is `f64`, storage is `f32`. Bitwise operators are the other
//! trap — JS `|`, `^` and `>>` coerce through `ToInt32`, and `>>>` through
//! `ToUint32`. [`to_int32`] and [`to_uint32`] implement those coercions, and
//! every wrap-around multiply is an explicit `wrapping_mul`.
//!
//! Getting this wrong does not crash anything. It silently produces a terrain
//! that differs from the preview thumbnail, which is exactly the bug the
//! determinism guarantee exists to prevent.

#![forbid(unsafe_op_in_unsafe_fn)]
#![warn(missing_docs)]

pub mod heightfield;
pub mod noise;
pub mod wasm;

pub use heightfield::Heightfield;
pub use noise::{fbm, hash2, FbmOptions, Rng, Simplex2D};

/// The SplitMix32 golden-ratio increment, as a `u32`.
pub const GOLDEN: u32 = 0x9e37_79b9;

/// JavaScript's `ToInt32` abstract operation.
///
/// `NaN`, infinities and both zeros all map to `0`; otherwise the value is
/// truncated toward zero, reduced modulo 2^32 into a non-negative residue, and
/// then mapped into the signed range. Rust's `as i32` does none of this — it
/// saturates — so calling `as i32` where JS would coerce is a real bug.
#[inline]
pub fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let truncated = x.trunc();
    let residue = truncated % 4_294_967_296.0;
    let residue = if residue < 0.0 { residue + 4_294_967_296.0 } else { residue };
    if residue >= 2_147_483_648.0 {
        (residue - 4_294_967_296.0) as i32
    } else {
        residue as i32
    }
}

/// JavaScript's `ToUint32` abstract operation.
#[inline]
pub fn to_uint32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    let truncated = x.trunc();
    let residue = truncated % 4_294_967_296.0;
    if residue < 0.0 {
        (residue + 4_294_967_296.0) as u32
    } else {
        residue as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_int32_wraps_instead_of_saturating() {
        // These are the cases where `as i32` would silently give the wrong
        // answer, because Rust saturates and JavaScript wraps.
        assert_eq!(to_int32(4_294_967_296.0), 0);
        assert_eq!(to_int32(4_294_967_297.0), 1);
        assert_eq!(to_int32(2_147_483_648.0), -2_147_483_648);
        assert_eq!(to_int32(-2_147_483_649.0), 2_147_483_647);
        assert_eq!(to_int32(f64::NAN), 0);
        assert_eq!(to_int32(f64::INFINITY), 0);
        assert_eq!(to_int32(f64::NEG_INFINITY), 0);
        assert_eq!(to_int32(-0.0), 0);
    }

    #[test]
    fn to_int32_truncates_toward_zero() {
        assert_eq!(to_int32(1.9), 1);
        assert_eq!(to_int32(-1.9), -1);
        assert_eq!(to_int32(0.9), 0);
    }

    #[test]
    fn to_uint32_matches_the_signed_view_of_the_same_bits() {
        // -1 as i32 and 4294967295 as u32 are the same bit pattern.
        assert_eq!(to_uint32(-1.0), u32::MAX);
        assert_eq!(to_uint32(-1.0) as i32, to_int32(-1.0));
        assert_eq!(to_uint32(4_294_967_295.0), u32::MAX);
    }

    #[test]
    fn golden_ratio_constant_is_correct() {
        assert_eq!(GOLDEN, 2_654_435_769);
        assert_eq!(GOLDEN as i32, -1_640_531_527);
    }
}
