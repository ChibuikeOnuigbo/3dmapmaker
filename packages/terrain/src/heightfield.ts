/**
 * packages/terrain — heightfield storage and sampling.
 *
 * A Heightfield is a rectangular grid of elevations in *local metres* covering
 * a square footprint of `size` metres. This is the unit the tile scheduler,
 * the sculpt tools and the analysis passes all agree on.
 *
 * Authored edits are stored as *absolute* elevation overrides in a sparse map
 * so regenerating the procedural base never destroys user sculpting
 * (HARDENING CHECK 004: sculpt -> save -> reload).
 */

export class Heightfield {
  /** Grid edge length in vertices (grid is resolution x resolution). */
  readonly resolution: number;
  /** Footprint edge length in metres. */
  readonly size: number;
  /** World-space X of the grid origin (west edge). */
  readonly originX: number;
  /** World-space Y of the grid origin (south edge). */
  readonly originY: number;
  readonly data: Float32Array;

  constructor(resolution: number, size: number, originX = 0, originY = 0, data?: Float32Array) {
    if (resolution < 2) throw new Error('Heightfield resolution must be >= 2');
    if (!(size > 0)) throw new Error('Heightfield size must be positive');
    this.resolution = resolution | 0;
    this.size = size;
    this.originX = originX;
    this.originY = originY;
    this.data = data ?? new Float32Array(this.resolution * this.resolution);
    if (this.data.length !== this.resolution * this.resolution) {
      throw new Error(`Heightfield data length ${this.data.length} != ${this.resolution * this.resolution}`);
    }
  }

  get step(): number {
    return this.size / (this.resolution - 1);
  }

  index(gx: number, gy: number): number {
    return gy * this.resolution + gx;
  }

  get(gx: number, gy: number): number {
    const r = this.resolution;
    const x = gx < 0 ? 0 : gx > r - 1 ? r - 1 : gx;
    const y = gy < 0 ? 0 : gy > r - 1 ? r - 1 : gy;
    return this.data[y * r + x];
  }

  set(gx: number, gy: number, v: number): void {
    const r = this.resolution;
    if (gx < 0 || gy < 0 || gx >= r || gy >= r) return;
    this.data[gy * r + gx] = v;
  }

  /** Convert local metres -> fractional grid coordinates. */
  worldToGrid(x: number, y: number): { gx: number; gy: number } {
    return {
      gx: (x - this.originX) / this.step,
      gy: (y - this.originY) / this.step,
    };
  }

  gridToWorld(gx: number, gy: number): { x: number; y: number } {
    return { x: this.originX + gx * this.step, y: this.originY + gy * this.step };
  }

  contains(x: number, y: number): boolean {
    const { gx, gy } = this.worldToGrid(x, y);
    return gx >= 0 && gy >= 0 && gx <= this.resolution - 1 && gy <= this.resolution - 1;
  }

  /**
   * Bilinear elevation sample at local metres (x, y). Clamped to the grid so
   * queries outside a loaded tile degrade gracefully instead of returning NaN.
   */
  sample(x: number, y: number): number {
    const r = this.resolution;
    let gx = (x - this.originX) / this.step;
    let gy = (y - this.originY) / this.step;
    gx = gx < 0 ? 0 : gx > r - 1 ? r - 1 : gx;
    gy = gy < 0 ? 0 : gy > r - 1 ? r - 1 : gy;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(x0 + 1, r - 1);
    const y1 = Math.min(y0 + 1, r - 1);
    const tx = gx - x0;
    const ty = gy - y0;
    const h00 = this.data[y0 * r + x0];
    const h10 = this.data[y0 * r + x1];
    const h01 = this.data[y1 * r + x0];
    const h11 = this.data[y1 * r + x1];
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return a + (b - a) * ty;
  }

  /** Central-difference normal in local space (unit length, +Z up). */
  normalAt(x: number, y: number, out = { x: 0, y: 0, z: 1 }): { x: number; y: number; z: number } {
    const h = this.step;
    const hl = this.sample(x - h, y);
    const hr = this.sample(x + h, y);
    const hd = this.sample(x, y - h);
    const hu = this.sample(x, y + h);
    // gradient in metres per metre
    const dzdx = (hr - hl) / (2 * h);
    const dzdy = (hu - hd) / (2 * h);
    const len = Math.hypot(dzdx, dzdy, 1);
    out.x = -dzdx / len;
    out.y = -dzdy / len;
    out.z = 1 / len;
    return out;
  }

  /** Slope in degrees from the surface normal. */
  slopeAt(x: number, y: number): number {
    const n = this.normalAt(x, y);
    return (Math.acos(Math.min(1, Math.max(-1, n.z))) * 180) / Math.PI;
  }

  /** Compass aspect (direction the slope faces downhill), degrees [0,360). */
  aspectAt(x: number, y: number): number {
    const h = this.step;
    const dzdx = (this.sample(x + h, y) - this.sample(x - h, y)) / (2 * h);
    const dzdy = (this.sample(x, y + h) - this.sample(x, y - h)) / (2 * h);
    // +x is East, +y is North. Downhill direction is the negative gradient.
    return ((Math.atan2(-dzdx, -dzdy) * 180) / Math.PI + 360) % 360;
  }

  /** Plan curvature: positive = convex (ridge), negative = concave (valley). */
  curvatureAt(x: number, y: number): number {
    const h = this.step;
    const z0 = this.sample(x, y);
    const zx1 = this.sample(x + h, y);
    const zx2 = this.sample(x - h, y);
    const zy1 = this.sample(x, y + h);
    const zy2 = this.sample(x, y - h);
    const dxx = (zx1 - 2 * z0 + zx2) / (h * h);
    const dyy = (zy1 - 2 * z0 + zy2) / (h * h);
    return dxx + dyy;
  }

  minMax(): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    const d = this.data;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  }

  clone(): Heightfield {
    return new Heightfield(this.resolution, this.size, this.originX, this.originY, new Float32Array(this.data));
  }

  /** Sparse edit overlay: absolute elevation per grid vertex. */
  applyEdits(edits: Record<string, number> | ArrayLike<number> | null): void {
    if (!edits) return;
    if (Array.isArray(edits) || edits instanceof Float32Array || edits instanceof Array) {
      const arr = edits as ArrayLike<number>;
      const n = Math.min(arr.length, this.data.length);
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (Number.isFinite(v)) this.data[i] = v;
      }
      return;
    }
    for (const [key, v] of Object.entries(edits as Record<string, number>)) {
      const i = Number(key);
      if (Number.isInteger(i) && i >= 0 && i < this.data.length && Number.isFinite(v)) this.data[i] = v;
    }
  }

  /** Produce the sparse edit record for the current grid (absolute values). */
  toEdits(base?: Heightfield): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < this.data.length; i++) {
      const v = this.data[i];
      const b = base ? base.data[i] : NaN;
      if (!Number.isFinite(b) || Math.abs(v - b) > 1e-4) out[String(i)] = v;
    }
    return out;
  }
}

/** Merge several heightfields covering disjoint footprints into one sampler. */
export class HeightfieldSet {
  private readonly fields: Heightfield[] = [];

  add(h: Heightfield): void {
    this.fields.push(h);
  }

  clear(): void {
    this.fields.length = 0;
  }

  get count(): number {
    return this.fields.length;
  }

  /** Highest-resolution field containing the point wins. */
  sample(x: number, y: number, fallback = 0): number {
    let best: Heightfield | null = null;
    for (const f of this.fields) {
      if (!f.contains(x, y)) continue;
      if (!best || f.resolution > best.resolution) best = f;
    }
    return best ? best.sample(x, y) : fallback;
  }

  normalAt(x: number, y: number, out = { x: 0, y: 0, z: 1 }) {
    let best: Heightfield | null = null;
    for (const f of this.fields) {
      if (!f.contains(x, y)) continue;
      if (!best || f.resolution > best.resolution) best = f;
    }
    return best ? best.normalAt(x, y, out) : out;
  }
}
