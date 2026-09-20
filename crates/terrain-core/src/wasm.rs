//! Hand-written wasm ABI.
//!
//! There is no `wasm-bindgen` here. crates.io is unreachable from the
//! environment this was developed in, and a hand-written ABI is smaller and can
//! be audited line by line against the JavaScript glue that calls it.
//!
//! ## Calling convention
//!
//! * Opaque objects live in a handle table and are referred to by `u32`.
//!   Handles are 1-based, so `0` is the null handle and every function returns
//!   `0` on failure rather than trapping.
//! * Numbers cross the boundary as `f64`. This is deliberate: JS has no `f32`
//!   arithmetic, and narrowing to `f32` on the way across would change the
//!   values the TypeScript produces.
//! * Variable-length data is returned through a caller-owned buffer. The JS
//!   side allocates with [`tc_alloc`], passes the pointer in, and frees it with
//!   [`tc_free`]. Nothing here returns an allocation the caller has to guess
//!   the length of.
//! * Every function that takes a handle validates it. A bad handle yields a
//!   sentinel value, never a trap, because a trap in a wasm module is
//!   unrecoverable for the page.
//!
//! ## Threading
//!
//! The module is single-threaded, as wasm modules are by default. The handle
//! table is a `RefCell`, which is safe here and would be a bug if this were
//! ever compiled with threads enabled.

use core::cell::RefCell;

use crate::heightfield::Heightfield;
use crate::noise::{fbm, hash2, FbmOptions, Rng, Simplex2D};

/// ABI version. Bumped on any breaking change to the exported signatures, so
/// the JS glue can refuse to bind against a module it was not written for
/// rather than calling into a shifted table.
pub const ABI_VERSION: u32 = 1;

thread_local! {
    static HANDLES: RefCell<Slots> = RefCell::new(Slots {
        rng: Vec::new(),
        simplex: Vec::new(),
        field: Vec::new(),
    });
}

#[derive(Default)]
struct Slots {
    rng: Vec<Option<Rng>>,
    simplex: Vec<Option<Simplex2D>>,
    field: Vec<Option<Heightfield>>,
}

/// Sentinels returned instead of trapping on a bad handle or an invalid
/// construction. Each is outside the range of a legitimate result.
pub const BAD_HANDLE: f64 = f64::NAN;
/// Returned by constructors that could not build their object.
pub const CONSTRUCT_FAILED: u32 = 0;

/// Convert a 1-based handle to a 0-based slot index, or `None` for the null
/// handle.
///
/// Handles are 1-based so that `0` is unambiguously null, which means a bare
/// `handle - 1` underflows on exactly the input this module promises to reject
/// gracefully. In a debug build that is a panic; a panic inside a wasm export is
/// an unrecoverable trap for the page. In a release build it wraps to
/// `usize::MAX` and only works by accident. Neither is acceptable, so the
/// subtraction is checked.
fn slot(handle: u32) -> Option<usize> {
    handle.checked_sub(1).map(|i| i as usize)
}

fn alloc_handle<T>(table: &mut Vec<Option<T>>, value: T) -> u32 {
    // Reuse a freed slot before growing, so a long session that creates and
    // drops many generators does not grow the table without bound.
    if let Some(i) = table.iter().position(|s| s.is_none()) {
        table[i] = Some(value);
        return (i as u32) + 1;
    }
    table.push(Some(value));
    table.len() as u32
}

/// ABI version. Call this first and refuse to continue if it does not match.
#[no_mangle]
pub extern "C" fn tc_version() -> u32 {
    ABI_VERSION
}

/// Allocate `len` bytes the host can write into and later pass back.
///
/// # Safety
/// The caller owns the returned pointer until it is passed to [`tc_free`] with
/// the same length.
#[no_mangle]
pub unsafe extern "C" fn tc_alloc(len: u32) -> *mut u8 {
    if len == 0 {
        return core::ptr::null_mut();
    }
    // Zero-filled rather than `with_capacity` + `set_len`: handing the host
    // uninitialised bytes is undefined behaviour, because uninitialised memory
    // is not a valid `u8`. It also means a buffer the host forgets to fill reads
    // as zeros rather than as whatever was previously on the heap.
    let mut v = vec![0u8; len as usize];
    let ptr = v.as_mut_ptr();
    core::mem::forget(v);
    ptr
}

/// Free a buffer previously returned by [`tc_alloc`].
///
/// # Safety
/// `ptr` must come from [`tc_alloc`] and `len` must be the length it was
/// allocated with. Passing anything else is undefined behaviour.
#[no_mangle]
pub unsafe extern "C" fn tc_free(ptr: *mut u8, len: u32) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe { drop(Vec::from_raw_parts(ptr, len as usize, len as usize)) };
}

/// Create a PRNG. Returns a handle, or `0`.
#[no_mangle]
pub extern "C" fn tc_rng_new(seed: f64) -> u32 {
    HANDLES.with(|h| alloc_handle(&mut h.borrow_mut().rng, Rng::new(seed)))
}

/// Next value in `[0, 1)` from a PRNG handle.
#[no_mangle]
pub extern "C" fn tc_rng_next(handle: u32) -> f64 {
    HANDLES.with(|h| {
        let mut slots = h.borrow_mut();
        let Some(i) = slot(handle) else { return BAD_HANDLE };
        match slots.rng.get_mut(i).and_then(|s| s.as_mut()) {
            Some(r) => r.next(),
            None => BAD_HANDLE,
        }
    })
}

/// Drop a PRNG handle. Returns 1 if it existed.
#[no_mangle]
pub extern "C" fn tc_rng_free(handle: u32) -> u32 {
    HANDLES.with(|h| {
        let mut slots = h.borrow_mut();
        let Some(i) = slot(handle) else { return 0 };
        match slots.rng.get_mut(i) {
            Some(s) if s.is_some() => {
                *s = None;
                1
            }
            _ => 0,
        }
    })
}

/// Create a simplex noise generator. Returns a handle, or `0`.
#[no_mangle]
pub extern "C" fn tc_simplex_new(seed: f64) -> u32 {
    HANDLES.with(|h| alloc_handle(&mut h.borrow_mut().simplex, Simplex2D::new(seed)))
}

/// Sample a simplex generator.
#[no_mangle]
pub extern "C" fn tc_simplex_noise(handle: u32, x: f64, y: f64) -> f64 {
    HANDLES.with(|h| {
        let slots = h.borrow();
        let Some(i) = slot(handle) else { return BAD_HANDLE };
        match slots.simplex.get(i).and_then(|s| s.as_ref()) {
            Some(s) => s.noise(x, y),
            None => BAD_HANDLE,
        }
    })
}

/// Fractal Brownian motion through a simplex handle.
#[no_mangle]
pub extern "C" fn tc_fbm(
    handle: u32,
    x: f64,
    y: f64,
    octaves: u32,
    lacunarity: f64,
    gain: f64,
    amplitude: f64,
    frequency: f64,
    warp: f64,
    ridged: u32,
) -> f64 {
    HANDLES.with(|h| {
        let slots = h.borrow();
        let Some(i) = slot(handle) else { return BAD_HANDLE };
        match slots.simplex.get(i).and_then(|s| s.as_ref()) {
            Some(s) => fbm(
                s,
                x,
                y,
                &FbmOptions {
                    octaves: octaves as usize,
                    lacunarity,
                    gain,
                    amplitude,
                    frequency,
                    warp,
                    ridged: ridged != 0,
                },
            ),
            None => BAD_HANDLE,
        }
    })
}

/// Hash-based value noise. Stateless, so no handle is needed.
#[no_mangle]
pub extern "C" fn tc_hash2(x: f64, y: f64, seed: f64) -> f64 {
    hash2(x, y, seed)
}

/// Create an empty heightfield. Returns a handle, or `0` if the arguments were
/// rejected.
#[no_mangle]
pub extern "C" fn tc_heightfield_new(resolution: u32, size: f64, origin_x: f64, origin_y: f64) -> u32 {
    match Heightfield::new(resolution as usize, size, origin_x, origin_y) {
        Ok(hf) => HANDLES.with(|h| alloc_handle(&mut h.borrow_mut().field, hf)),
        Err(_) => CONSTRUCT_FAILED,
    }
}

/// Fill a heightfield procedurally.
///
/// `scale` converts grid steps into noise-space units and `centre` recentres the
/// sample window on the middle of the grid. Returns 1 on success.
#[no_mangle]
pub extern "C" fn tc_heightfield_fill_procedural(
    handle: u32,
    noise_handle: u32,
    octaves: u32,
    lacunarity: f64,
    gain: f64,
    amplitude: f64,
    frequency: f64,
    warp: f64,
    ridged: u32,
    scale: f64,
    centre: u32,
) -> u32 {
    HANDLES.with(|h| {
        let Some(ni) = slot(noise_handle) else { return 0 };
        let Some(hi) = slot(handle) else { return 0 };
        let mut slots = h.borrow_mut();
        // Clone rather than hold a borrow: filling the field needs `&mut` on the
        // same `RefMut` that the generator was looked up through. The generator
        // is ~1 KiB, so the copy is cheaper than reasoning about the borrow.
        let noise = match slots.simplex.get(ni).and_then(|s| s.as_ref()) {
            Some(s) => s.clone(),
            None => return 0,
        };
        let options = FbmOptions {
            octaves: octaves as usize,
            lacunarity,
            gain,
            amplitude,
            frequency,
            warp,
            ridged: ridged != 0,
        };
        match slots.field.get_mut(hi).and_then(|s| s.as_mut()) {
            Some(hf) => {
                hf.fill_procedural(&noise, &options, scale, centre != 0);
                1
            }
            None => 0,
        }
    })
}

/// Bilinear elevation sample.
#[no_mangle]
pub extern "C" fn tc_heightfield_sample(handle: u32, x: f64, y: f64) -> f64 {
    HANDLES.with(|h| {
        let slots = h.borrow();
        let Some(i) = slot(handle) else { return BAD_HANDLE };
        match slots.field.get(i).and_then(|s| s.as_ref()) {
            Some(hf) => hf.sample(x, y),
            None => BAD_HANDLE,
        }
    })
}

/// Write the surface normal at a point into `out`, which must have room for
/// three `f64`. Returns 1 on success.
///
/// # Safety
/// `out` must point to at least three writable `f64`.
#[no_mangle]
pub unsafe extern "C" fn tc_heightfield_normal_at(handle: u32, x: f64, y: f64, out: *mut f64) -> u32 {
    if out.is_null() {
        return 0;
    }
    let n = HANDLES.with(|h| {
        let slots = h.borrow();
        slot(handle).and_then(|i| {
            slots
                .field
                .get(i)
                .and_then(|s| s.as_ref())
                .map(|hf| hf.normal_at(x, y))
        })
    });
    match n {
        Some(n) => {
            unsafe {
                *out = n[0];
                *out.add(1) = n[1];
                *out.add(2) = n[2];
            }
            1
        }
        None => 0,
    }
}

/// Slope in degrees at a point.
#[no_mangle]
pub extern "C" fn tc_heightfield_slope_at(handle: u32, x: f64, y: f64) -> f64 {
    HANDLES.with(|h| {
        let slots = h.borrow();
        let Some(i) = slot(handle) else { return BAD_HANDLE };
        match slots.field.get(i).and_then(|s| s.as_ref()) {
            Some(hf) => hf.slope_at(x, y),
            None => BAD_HANDLE,
        }
    })
}

/// Number of vertices in the elevation buffer.
#[no_mangle]
pub extern "C" fn tc_heightfield_len(handle: u32) -> u32 {
    HANDLES.with(|h| {
        let slots = h.borrow();
        slot(handle)
            .and_then(|i| slots.field.get(i).and_then(|s| s.as_ref()))
            .map_or(0, |hf| hf.resolution().pow(2) as u32)
    })
}

/// Copy the elevation buffer into a caller-owned `f32` buffer.
///
/// Returns the number of vertices written, or `0` if the handle was bad or the
/// buffer was too small. Writing into a caller buffer avoids handing ownership
/// of an allocation back across the boundary.
///
/// # Safety
/// `out` must point to at least `out_len` writable `f32`.
#[no_mangle]
pub unsafe extern "C" fn tc_heightfield_read(
    handle: u32,
    out: *mut f32,
    out_len: u32,
) -> u32 {
    if out.is_null() {
        return 0;
    }
    HANDLES.with(|h| {
        let slots = h.borrow();
        let Some(i) = slot(handle) else { return 0 };
        let hf = match slots.field.get(i).and_then(|s| s.as_ref()) {
            Some(hf) => hf,
            None => return 0,
        };
        let data = hf.data();
        if (out_len as usize) < data.len() {
            return 0;
        }
        unsafe { core::ptr::copy_nonoverlapping(data.as_ptr(), out, data.len()) };
        data.len() as u32
    })
}

/// Apply absolute elevation overrides. `indices` and `values` must each have
/// `len` elements.
///
/// Returns the number of edits *submitted*, not the number that changed the
/// field: an out-of-range index or a non-finite value is skipped, and the caller
/// cannot distinguish those cases from the count alone. It returns `0` only when
/// the handle or a pointer was invalid.
///
/// # Safety
/// Both pointers must be valid for `len` reads.
#[no_mangle]
pub unsafe extern "C" fn tc_heightfield_apply_edits(
    handle: u32,
    indices: *const u32,
    values: *const f64,
    len: u32,
) -> u32 {
    if indices.is_null() || values.is_null() {
        return 0;
    }
    let pairs = unsafe {
        core::slice::from_raw_parts(indices, len as usize)
            .iter()
            .zip(core::slice::from_raw_parts(values, len as usize).iter())
            .map(|(i, v)| (*i as usize, *v))
            .collect::<Vec<_>>()
    };
    let submitted = pairs.len() as u32;
    HANDLES.with(|h| {
        let mut slots = h.borrow_mut();
        let Some(i) = slot(handle) else { return 0 };
        match slots.field.get_mut(i).and_then(|s| s.as_mut()) {
            Some(hf) => {
                hf.apply_edits(&pairs);
                submitted
            }
            None => 0,
        }
    })
}

/// Drop a heightfield handle. Returns 1 if it existed.
#[no_mangle]
pub extern "C" fn tc_heightfield_free(handle: u32) -> u32 {
    HANDLES.with(|h| {
        let mut slots = h.borrow_mut();
        let Some(i) = slot(handle) else { return 0 };
        match slots.field.get_mut(i) {
            Some(s) if s.is_some() => {
                *s = None;
                1
            }
            _ => 0,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bad_handles_return_sentinels_instead_of_trapping() {
        assert!(tc_rng_next(0).is_nan());
        assert!(tc_rng_next(9999).is_nan());
        assert!(tc_simplex_noise(0, 1.0, 2.0).is_nan());
        assert!(tc_heightfield_sample(0, 0.0, 0.0).is_nan());
        assert_eq!(tc_heightfield_free(0), 0);
        assert_eq!(tc_heightfield_len(0), 0);
    }

    #[test]
    fn rejected_construction_returns_zero() {
        assert_eq!(tc_heightfield_new(1, 100.0, 0.0, 0.0), CONSTRUCT_FAILED);
        assert_eq!(tc_heightfield_new(9, 0.0, 0.0, 0.0), CONSTRUCT_FAILED);
        assert_eq!(tc_heightfield_new(9, f64::NAN, 0.0, 0.0), CONSTRUCT_FAILED);
    }

    #[test]
    fn handles_round_trip_through_the_table() {
        let s = tc_simplex_new(1337.0);
        assert_ne!(s, 0);
        let direct = Simplex2D::new(1337.0).noise(1.5, -2.25);
        assert!((tc_simplex_noise(s, 1.5, -2.25) - direct).abs() < 1e-12);
    }

    #[test]
    fn freed_slots_are_reused() {
        let a = tc_rng_new(1.0);
        let b = tc_rng_new(2.0);
        assert_eq!(tc_rng_free(a), 1);
        assert_eq!(tc_rng_free(a), 0, "double free must not succeed");
        let c = tc_rng_new(3.0);
        assert_eq!(c, a, "a freed slot should be reused rather than growing the table");
        assert_ne!(b, c);
        tc_rng_free(b);
        tc_rng_free(c);
    }

    #[test]
    fn heightfield_workflow_matches_the_rust_api() {
        let noise = tc_simplex_new(1337.0);
        let hf = tc_heightfield_new(9, 256.0, -128.0, -128.0);
        assert_ne!(hf, 0);
        assert_eq!(tc_heightfield_len(hf), 81);

        let filled = tc_heightfield_fill_procedural(
            hf, noise, 6, 2.0, 0.5, 240.0, 1.4, 0.25, 0, 0.35, 1,
        );
        assert_eq!(filled, 1);

        let mut reference = Heightfield::new(9, 256.0, -128.0, -128.0).unwrap();
        reference.fill_procedural(
            &Simplex2D::new(1337.0),
            &FbmOptions { warp: 0.25, ..FbmOptions::default() },
            0.35,
            true,
        );
        assert!(
            (tc_heightfield_sample(hf, 13.5, -22.25) - reference.sample(13.5, -22.25)).abs() < 1e-9
        );

        let mut out = [0.0f64; 3];
        assert_eq!(
            unsafe { tc_heightfield_normal_at(hf, 10.0, -20.0, out.as_mut_ptr()) },
            1
        );
        let expected = reference.normal_at(10.0, -20.0);
        for i in 0..3 {
            assert!((out[i] - expected[i]).abs() < 1e-12);
        }

        assert_eq!(tc_heightfield_free(hf), 1);
        assert!(tc_heightfield_sample(hf, 0.0, 0.0).is_nan(), "handle must be dead");
    }

    #[test]
    fn read_requires_an_adequate_buffer() {
        let hf = tc_heightfield_new(9, 256.0, 0.0, 0.0);
        let mut buf = [0.0f32; 81];
        assert_eq!(unsafe { tc_heightfield_read(hf, buf.as_mut_ptr(), 81) }, 81);
        assert_eq!(unsafe { tc_heightfield_read(hf, buf.as_mut_ptr(), 80) }, 0);
        assert_eq!(unsafe { tc_heightfield_read(hf, core::ptr::null_mut(), 81) }, 0);
        tc_heightfield_free(hf);
    }

    #[test]
    fn alloc_and_free_round_trip() {
        let p = unsafe { tc_alloc(16) };
        assert!(!p.is_null());
        unsafe {
            *p = 7;
            assert_eq!(*p, 7);
            tc_free(p, 16);
        }
        assert!(unsafe { tc_alloc(0) }.is_null());
    }

    #[test]
    fn null_pointers_are_rejected() {
        let hf = tc_heightfield_new(4, 10.0, 0.0, 0.0);
        assert_eq!(unsafe { tc_heightfield_normal_at(hf, 0.0, 0.0, core::ptr::null_mut()) }, 0);
        assert_eq!(
            unsafe { tc_heightfield_apply_edits(hf, core::ptr::null(), core::ptr::null(), 1) },
            0
        );
        tc_heightfield_free(hf);
    }
}
