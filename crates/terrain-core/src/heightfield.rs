//! Heightfield storage and sampling.
//!
//! Port of `packages/terrain/src/heightfield.ts`. A [`Heightfield`] is a
//! rectangular grid of elevations in *local metres* covering a square footprint
//! of `size` metres. This is the unit the tile scheduler, the sculpt tools and
//! the analysis passes all agree on.
//!
//! ## Storage precision
//!
//! Elevations are stored as `f32`, because the TypeScript stores them in a
//! `Float32Array`. Every arithmetic operation is `f64` — JavaScript has no `f32`
//! arithmetic — and the value is narrowed only on the way into storage. Doing
//! the maths in `f32` throughout would be both slower and *different*, and
//! "different" is the thing that breaks tile stitching.
//!
//! ## Authored edits
//!
//! Edits are absolute elevation overrides keyed by vertex index, so regenerating
//! the procedural base never destroys user sculpting.

use crate::noise::{fbm, FbmOptions, Simplex2D};

/// A rectangular grid of elevations in local metres.
#[derive(Debug, Clone)]
pub struct Heightfield {
    /// Grid edge length in vertices.
    resolution: usize,
    /// Footprint edge length in metres.
    size: f64,
    /// World-space X of the grid origin (west edge).
    origin_x: f64,
    /// World-space Y of the grid origin (south edge).
    origin_y: f64,
    /// Elevations, row-major, `resolution * resolution` long.
    data: Vec<f32>,
}

/// Errors that constructing or filling a heightfield can produce.
#[derive(Debug, Clone, PartialEq)]
pub enum HeightfieldError {
    /// Resolution must be at least 2, so that a step size exists.
    ResolutionTooSmall(usize),
    /// The footprint must have positive area.
    NonPositiveSize(f64),
    /// Supplied data did not match `resolution * resolution`.
    DataLengthMismatch { expected: usize, got: usize },
}

impl core::fmt::Display for HeightfieldError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::ResolutionTooSmall(r) => {
                write!(f, "Heightfield resolution must be >= 2, got {r}")
            }
            Self::NonPositiveSize(s) => write!(f, "Heightfield size must be positive, got {s}"),
            Self::DataLengthMismatch { expected, got } => {
                write!(f, "Heightfield data length {got} != {expected}")
            }
        }
    }
}

impl std::error::Error for HeightfieldError {}

impl Heightfield {
    /// Create a zero-filled heightfield.
    pub fn new(resolution: usize, size: f64, origin_x: f64, origin_y: f64) -> Result<Self, HeightfieldError> {
        if resolution < 2 {
            return Err(HeightfieldError::ResolutionTooSmall(resolution));
        }
        if !(size > 0.0) {
            return Err(HeightfieldError::NonPositiveSize(size));
        }
        Ok(Self {
            resolution,
            size,
            origin_x,
            origin_y,
            data: vec![0.0; resolution * resolution],
        })
    }

    /// Create a heightfield from existing data.
    pub fn with_data(
        resolution: usize,
        size: f64,
        origin_x: f64,
        origin_y: f64,
        data: Vec<f32>,
    ) -> Result<Self, HeightfieldError> {
        if resolution < 2 {
            return Err(HeightfieldError::ResolutionTooSmall(resolution));
        }
        if !(size > 0.0) {
            return Err(HeightfieldError::NonPositiveSize(size));
        }
        let expected = resolution * resolution;
        if data.len() != expected {
            return Err(HeightfieldError::DataLengthMismatch { expected, got: data.len() });
        }
        Ok(Self { resolution, size, origin_x, origin_y, data })
    }

    /// Distance between adjacent vertices, in metres.
    pub fn step(&self) -> f64 {
        self.size / (self.resolution as f64 - 1.0)
    }

    /// Grid edge length in vertices.
    pub fn resolution(&self) -> usize {
        self.resolution
    }

    /// Footprint edge length in metres.
    pub fn size(&self) -> f64 {
        self.size
    }

    /// World-space X of the grid origin.
    pub fn origin_x(&self) -> f64 {
        self.origin_x
    }

    /// World-space Y of the grid origin.
    pub fn origin_y(&self) -> f64 {
        self.origin_y
    }

    /// Direct read of the elevation buffer.
    pub fn data(&self) -> &[f32] {
        &self.data
    }

    /// Row-major index for a grid coordinate. Does not bounds-check, matching
    /// the TypeScript — callers use [`Heightfield::set`] for that.
    pub fn index(&self, gx: usize, gy: usize) -> usize {
        gy * self.resolution + gx
    }

    /// Read a vertex, clamping out-of-range coordinates to the edge.
    pub fn get(&self, gx: isize, gy: isize) -> f32 {
        let r = self.resolution as isize;
        let x = gx.clamp(0, r - 1) as usize;
        let y = gy.clamp(0, r - 1) as usize;
        self.data[y * self.resolution + x]
    }

    /// Write a vertex. Out-of-range writes are ignored rather than clamped, so
    /// a brush stroke that runs off the edge cannot smear the border.
    pub fn set(&mut self, gx: isize, gy: isize, v: f64) {
        let r = self.resolution as isize;
        if gx < 0 || gy < 0 || gx >= r || gy >= r {
            return;
        }
        self.data[(gy as usize) * self.resolution + gx as usize] = v as f32;
    }

    /// Local metres to fractional grid coordinates.
    pub fn world_to_grid(&self, x: f64, y: f64) -> (f64, f64) {
        let step = self.step();
        ((x - self.origin_x) / step, (y - self.origin_y) / step)
    }

    /// Fractional grid coordinates to local metres.
    pub fn grid_to_world(&self, gx: f64, gy: f64) -> (f64, f64) {
        let step = self.step();
        (self.origin_x + gx * step, self.origin_y + gy * step)
    }

    /// Whether a point in local metres falls inside the footprint.
    pub fn contains(&self, x: f64, y: f64) -> bool {
        let (gx, gy) = self.world_to_grid(x, y);
        let max = self.resolution as f64 - 1.0;
        gx >= 0.0 && gy >= 0.0 && gx <= max && gy <= max
    }

    /// Bilinear elevation sample at local metres.
    ///
    /// Clamped to the grid so queries outside a loaded tile degrade gracefully
    /// instead of returning NaN — a NaN elevation propagates into vertex
    /// positions and silently drops the whole draw call.
    pub fn sample(&self, x: f64, y: f64) -> f64 {
        let r = self.resolution as f64;
        let step = self.step();
        let gx = ((x - self.origin_x) / step).clamp(0.0, r - 1.0);
        let gy = ((y - self.origin_y) / step).clamp(0.0, r - 1.0);
        let x0 = gx.floor() as usize;
        let y0 = gy.floor() as usize;
        let x1 = (x0 + 1).min(self.resolution - 1);
        let y1 = (y0 + 1).min(self.resolution - 1);
        let tx = gx - x0 as f64;
        let ty = gy - y0 as f64;
        let res = self.resolution;
        let h00 = f64::from(self.data[y0 * res + x0]);
        let h10 = f64::from(self.data[y0 * res + x1]);
        let h01 = f64::from(self.data[y1 * res + x0]);
        let h11 = f64::from(self.data[y1 * res + x1]);
        let a = h00 + (h10 - h00) * tx;
        let b = h01 + (h11 - h01) * tx;
        a + (b - a) * ty
    }

    /// Central-difference normal in local space, unit length, +Z up.
    pub fn normal_at(&self, x: f64, y: f64) -> [f64; 3] {
        let h = self.step();
        let hl = self.sample(x - h, y);
        let hr = self.sample(x + h, y);
        let hd = self.sample(x, y - h);
        let hu = self.sample(x, y + h);
        // Gradient in metres per metre.
        let dzdx = (hr - hl) / (2.0 * h);
        let dzdy = (hu - hd) / (2.0 * h);
        let len = (dzdx * dzdx + dzdy * dzdy + 1.0).sqrt();
        [-dzdx / len, -dzdy / len, 1.0 / len]
    }

    /// Slope in degrees, from the surface normal.
    pub fn slope_at(&self, x: f64, y: f64) -> f64 {
        let n = self.normal_at(x, y);
        n[2].clamp(-1.0, 1.0).acos().to_degrees()
    }

    /// Compass aspect — the direction the slope faces downhill — in `[0, 360)`.
    pub fn aspect_at(&self, x: f64, y: f64) -> f64 {
        let h = self.step();
        let dzdx = (self.sample(x + h, y) - self.sample(x - h, y)) / (2.0 * h);
        let dzdy = (self.sample(x, y + h) - self.sample(x, y - h)) / (2.0 * h);
        // +x is East, +y is North. Downhill is the negative gradient.
        ((-dzdx).atan2(-dzdy).to_degrees() + 360.0) % 360.0
    }

    /// Plan curvature. Positive is convex (a ridge), negative concave (a valley).
    pub fn curvature_at(&self, x: f64, y: f64) -> f64 {
        let h = self.step();
        let z0 = self.sample(x, y);
        let zx1 = self.sample(x + h, y);
        let zx2 = self.sample(x - h, y);
        let zy1 = self.sample(x, y + h);
        let zy2 = self.sample(x, y - h);
        let dxx = (zx1 - 2.0 * z0 + zx2) / (h * h);
        let dyy = (zy1 - 2.0 * z0 + zy2) / (h * h);
        dxx + dyy
    }

    /// Minimum and maximum stored elevation.
    pub fn min_max(&self) -> (f64, f64) {
        let mut min = f64::INFINITY;
        let mut max = f64::NEG_INFINITY;
        for v in &self.data {
            let v = f64::from(*v);
            if v < min {
                min = v;
            }
            if v > max {
                max = v;
            }
        }
        (min, max)
    }

    /// Apply absolute elevation overrides by vertex index.
    ///
    /// Non-finite values are skipped: a NaN in the edit map would otherwise
    /// poison the whole heightfield and every mesh built from it.
    pub fn apply_edits(&mut self, edits: &[(usize, f64)]) {
        for (i, v) in edits {
            if *i < self.data.len() && v.is_finite() {
                self.data[*i] = *v as f32;
            }
        }
    }

    /// Produce the sparse edit record for the current grid, as absolute values.
    ///
    /// Vertices that match `base` within `1e-4` are omitted, so the record stays
    /// small and contains only what the user actually changed.
    pub fn to_edits(&self, base: Option<&Heightfield>) -> Vec<(usize, f64)> {
        let mut out = Vec::new();
        for (i, v) in self.data.iter().enumerate() {
            let v = f64::from(*v);
            let b = base.and_then(|b| b.data.get(i).copied()).map(f64::from);
            match b {
                Some(b) if b.is_finite() && (v - b).abs() <= 1e-4 => {}
                _ => out.push((i, v)),
            }
        }
        out
    }

    /// Fill the grid procedurally from a noise field.
    ///
    /// `scale` converts grid steps into noise-space units, so the same options
    /// produce the same features at any resolution.
    pub fn fill_procedural(
        &mut self,
        noise: &Simplex2D,
        options: &FbmOptions,
        scale: f64,
        centre: bool,
    ) {
        let r = self.resolution;
        let mid = (r as f64 - 1.0) / 2.0;
        for gy in 0..r {
            for gx in 0..r {
                let nx = if centre { (gx as f64 - mid) * scale } else { gx as f64 * scale };
                let ny = if centre { (gy as f64 - mid) * scale } else { gy as f64 * scale };
                self.data[gy * r + gx] = fbm(noise, nx, ny, options) as f32;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field() -> Heightfield {
        Heightfield::new(9, 256.0, -128.0, -128.0).expect("valid field")
    }

    #[test]
    fn rejects_a_degenerate_resolution() {
        assert_eq!(
            Heightfield::new(1, 100.0, 0.0, 0.0),
            Err(HeightfieldError::ResolutionTooSmall(1))
        );
        assert_eq!(
            Heightfield::new(0, 100.0, 0.0, 0.0),
            Err(HeightfieldError::ResolutionTooSmall(0))
        );
        assert!(Heightfield::new(2, 100.0, 0.0, 0.0).is_ok());
    }

    #[test]
    fn rejects_a_non_positive_size() {
        assert!(matches!(
            Heightfield::new(9, 0.0, 0.0, 0.0),
            Err(HeightfieldError::NonPositiveSize(_))
        ));
        assert!(matches!(
            Heightfield::new(9, -5.0, 0.0, 0.0),
            Err(HeightfieldError::NonPositiveSize(_))
        ));
        // NaN is not > 0, so it must be rejected rather than accepted.
        assert!(matches!(
            Heightfield::new(9, f64::NAN, 0.0, 0.0),
            Err(HeightfieldError::NonPositiveSize(_))
        ));
    }

    #[test]
    fn step_matches_the_footprint() {
        let hf = field();
        assert!((hf.step() - 32.0).abs() < 1e-12);
    }

    #[test]
    fn round_trips_grid_and_world_coordinates() {
        let hf = field();
        for gx in 0..9 {
            for gy in 0..9 {
                let (x, y) = hf.grid_to_world(gx as f64, gy as f64);
                let (bx, by) = hf.world_to_grid(x, y);
                assert!((bx - gx as f64).abs() < 1e-9);
                assert!((by - gy as f64).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn set_ignores_out_of_range_but_get_clamps() {
        let mut hf = field();
        hf.set(-1, 0, 999.0);
        hf.set(9, 0, 999.0);
        assert_eq!(hf.get(0, 0), 0.0, "out-of-range write must not smear the border");
        assert_eq!(hf.get(8, 0), 0.0);
        // Reads clamp, so a query just off the edge degrades gracefully.
        assert_eq!(hf.get(-5, -5), hf.get(0, 0));
        assert_eq!(hf.get(100, 100), hf.get(8, 8));
    }

    #[test]
    fn sample_never_returns_nan() {
        let mut hf = field();
        hf.fill_procedural(&Simplex2D::new(1337.0), &FbmOptions::default(), 0.35, true);
        for (x, y) in [
            (0.0, 0.0),
            (-128.0, -128.0),
            (128.0, 128.0),
            (13.5, -22.25),
            (9999.0, 9999.0),
            (-9999.0, -9999.0),
        ] {
            let v = hf.sample(x, y);
            assert!(v.is_finite(), "sample({x},{y}) = {v}");
        }
    }

    #[test]
    fn bilinear_sample_is_exact_at_vertices() {
        let mut hf = field();
        hf.set(4, 4, 12.5);
        let (x, y) = hf.grid_to_world(4.0, 4.0);
        assert!((hf.sample(x, y) - 12.5).abs() < 1e-6);
    }

    #[test]
    fn normal_is_unit_length() {
        let mut hf = field();
        hf.fill_procedural(&Simplex2D::new(1337.0), &FbmOptions::default(), 0.35, true);
        let n = hf.normal_at(10.0, -20.0);
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        assert!((len - 1.0).abs() < 1e-12, "normal length {len}");
        assert!(n[2] > 0.0, "normal must point up");
    }

    #[test]
    fn slope_is_zero_on_flat_ground() {
        let hf = field();
        assert!(hf.slope_at(0.0, 0.0) < 1e-9);
    }

    #[test]
    fn aspect_is_within_compass_range() {
        let mut hf = field();
        hf.fill_procedural(&Simplex2D::new(1337.0), &FbmOptions::default(), 0.35, true);
        for i in 0..20 {
            let a = hf.aspect_at(i as f64 * 6.0 - 60.0, i as f64 * -4.0 + 40.0);
            assert!((0.0..360.0).contains(&a), "aspect {a}");
        }
    }

    #[test]
    fn edits_are_absolute_and_survive_regeneration() {
        let mut hf = field();
        hf.fill_procedural(&Simplex2D::new(1337.0), &FbmOptions::default(), 0.35, true);
        let base = hf.clone();

        hf.apply_edits(&[(0, 77.25), (40, -33.5)]);
        assert!((f64::from(hf.data[0]) - 77.25).abs() < 1e-6);

        // The edit record must contain exactly what changed.
        let edits = hf.to_edits(Some(&base));
        assert!(edits.iter().any(|(i, v)| *i == 0 && (*v - 77.25).abs() < 1e-6));
        assert!(edits.iter().any(|(i, v)| *i == 40 && (*v + 33.5).abs() < 1e-6));
        assert!(
            edits.len() < hf.data.len(),
            "edit record should be sparse, got {}",
            edits.len()
        );
    }

    #[test]
    fn edits_reject_nan() {
        let mut hf = field();
        hf.apply_edits(&[(0, f64::NAN), (1, f64::INFINITY), (2, 5.0)]);
        assert_eq!(hf.data[0], 0.0);
        assert_eq!(hf.data[1], 0.0);
        assert!((f64::from(hf.data[2]) - 5.0).abs() < 1e-6);
    }

    #[test]
    fn edits_outside_the_buffer_are_ignored() {
        let mut hf = field();
        hf.apply_edits(&[(9999, 1.0)]);
        assert_eq!(hf.data.len(), 81);
    }

    #[test]
    fn min_max_tracks_the_data() {
        let mut hf = field();
        hf.set(0, 0, -10.0);
        hf.set(8, 8, 42.0);
        let (lo, hi) = hf.min_max();
        assert!((lo + 10.0).abs() < 1e-6);
        assert!((hi - 42.0).abs() < 1e-6);
    }

    #[test]
    fn rejects_mismatched_supplied_data() {
        assert_eq!(
            Heightfield::with_data(3, 10.0, 0.0, 0.0, vec![0.0; 4]),
            Err(HeightfieldError::DataLengthMismatch { expected: 9, got: 4 })
        );
    }

    #[test]
    fn fill_is_deterministic_for_a_seed() {
        let mut a = field();
        let mut b = field();
        let o = FbmOptions::default();
        a.fill_procedural(&Simplex2D::new(1337.0), &o, 0.35, true);
        b.fill_procedural(&Simplex2D::new(1337.0), &o, 0.35, true);
        assert_eq!(a.data, b.data);
    }
}
