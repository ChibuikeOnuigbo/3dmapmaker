/**
 * Panorama Maps — core/scale.js
 * MapScale: the single authority for pixel <-> meter conversion.
 *
 * RULE: a browser/map pixel is NEVER assumed to be one meter. All physical
 * distances flow through this class. (Spec §4, §7)
 */
export class MapScale {
  /**
   * @param {object} cfg
   * @param {number} cfg.pixelsPerMeter  map pixels per physical meter (e.g. 2 → 2px = 1m)
   * @param {object} cfg.movement        { stepPixels, stepMinPixels, stepMaxPixels }
   */
  constructor({ pixelsPerMeter = 2, movement = {} } = {}) {
    this.pixelsPerMeter = pixelsPerMeter;
    this.movement = {
      stepPixels: movement.stepPixels ?? 12,
      stepMinPixels: movement.stepMinPixels ?? 10,
      stepMaxPixels: movement.stepMaxPixels ?? 15,
    };
  }

  pxToM(px) { return px / this.pixelsPerMeter; }
  mToPx(m) { return m * this.pixelsPerMeter; }

  /** Physical distance covered by one discrete movement step, in meters. */
  stepMeters() { return this.pxToM(this.movement.stepPixels); }

  /**
   * How many movement steps of `stepPx` pixels are needed to cover `meters`.
   * Used by the mandatory 500 m continuity test (Spec §8, §59, §60).
   */
  stepsForMeters(meters, stepPx = this.movement.stepPixels) {
    const perStep = this.pxToM(stepPx);
    return meters / perStep;
  }

  /** Steps until the boundary is crossed (ceil). 490m→500m still inside, >500 outside. */
  stepsToReachBoundary(meters, stepPx = this.movement.stepPixels) {
    return Math.ceil(this.stepsForMeters(meters, stepPx));
  }

  /** Straight-line distance between two map points in meters. */
  distanceM(x1, y1, x2, y2) {
    return this.pxToM(Math.hypot(x2 - x1, y2 - y1));
  }

  toJSON() {
    return { pixelsPerMeter: this.pixelsPerMeter, movement: { ...this.movement } };
  }

  static fromJSON(json = {}) {
    return new MapScale(json);
  }
}
