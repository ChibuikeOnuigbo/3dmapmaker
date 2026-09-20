/**
 * packages/gis — geographic <-> local coordinate separation.
 *
 * REQUIREMENT 008 / 075: geographic coordinates (lat/lon/alt on WGS84) are kept
 * strictly separate from local meter-based scene coordinates. Everything the
 * renderer touches is a *local* position relative to a floating origin.
 *
 * All functions here are pure, allocation-light and safe to call from a worker.
 */

export const WGS84 = {
  a: 6378137.0, // semi-major axis (m)
  f: 1 / 298.257223563, // flattening
  get b() {
    return this.a * (1 - this.f);
  },
  get e2() {
    return this.f * (2 - this.f);
  },
} as const;

export interface GeoCoord {
  lat: number;
  lon: number;
  alt: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ECEF extends Vec3 {}

/** Local East-North-Up metres relative to a tangent-plane origin. */
export interface LocalENU extends Vec3 {}

export function geo(lat: number, lon: number, alt = 0): GeoCoord {
  return { lat, lon, alt };
}

/** Geodetic (lat/lon/height) -> Earth-Centred Earth-Fixed metres. */
export function geodeticToEcef(g: GeoCoord): ECEF {
  const { a, e2 } = WGS84;
  const lat = (g.lat * Math.PI) / 180;
  const lon = (g.lon * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  return {
    x: (n + g.alt) * cosLat * Math.cos(lon),
    y: (n + g.alt) * cosLat * Math.sin(lon),
    z: (n * (1 - e2) + g.alt) * sinLat,
  };
}

/** ECEF metres -> geodetic (Bowring's iterative method, converges in 2 passes). */
export function ecefToGeodetic(p: ECEF): GeoCoord {
  const { a, e2 } = WGS84;
  const b = a * Math.sqrt(1 - e2);
  const ep2 = (a * a - b * b) / (b * b);
  const pLen = Math.hypot(p.x, p.y);
  const th = Math.atan2(a * p.z, b * pLen);
  const lon = Math.atan2(p.y, p.x);
  const lat = Math.atan2(
    p.z + ep2 * b * Math.pow(Math.sin(th), 3),
    pLen - e2 * a * Math.pow(Math.cos(th), 3),
  );
  const sinLat = Math.sin(lat);
  const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const alt = pLen / Math.cos(lat) - n;
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI, alt };
}

/**
 * A local tangent frame. `origin` is the geographic anchor; every local
 * position is metres East / North / Up from that anchor.
 *
 * For city/region scale this linearisation is accurate to well under a
 * millimetre; for very large worlds the caller rebases (see rebase()).
 */
export class TangentFrame {
  readonly origin: GeoCoord;
  private readonly originEcef: ECEF;
  private readonly sinLat: number;
  private readonly cosLat: number;
  private readonly sinLon: number;
  private readonly cosLon: number;

  constructor(origin: GeoCoord) {
    this.origin = origin;
    this.originEcef = geodeticToEcef(origin);
    const lat = (origin.lat * Math.PI) / 180;
    const lon = (origin.lon * Math.PI) / 180;
    this.sinLat = Math.sin(lat);
    this.cosLat = Math.cos(lat);
    this.sinLon = Math.sin(lon);
    this.cosLon = Math.cos(lon);
  }

  /** Geographic -> local ENU metres. */
  toLocal(g: GeoCoord, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const e = geodeticToEcef(g);
    const dx = e.x - this.originEcef.x;
    const dy = e.y - this.originEcef.y;
    const dz = e.z - this.originEcef.z;
    // rotate ECEF delta into ENU
    out.x = -this.sinLon * dx + this.cosLon * dy; // East
    out.y = -this.sinLat * this.cosLon * dx - this.sinLat * this.sinLon * dy + this.cosLat * dz; // North
    out.z = this.cosLat * this.cosLon * dx + this.cosLat * this.sinLon * dy + this.sinLat * dz; // Up
    return out;
  }

  /** Local ENU metres -> geographic. */
  toGeo(l: Vec3, out: GeoCoord = { lat: 0, lon: 0, alt: 0 }): GeoCoord {
    // transpose of the ENU rotation used in toLocal()
    const dx =
      -this.sinLon * l.x - this.sinLat * this.cosLon * l.y + this.cosLat * this.cosLon * l.z;
    const dy =
      this.cosLon * l.x - this.sinLat * this.sinLon * l.y + this.cosLat * this.sinLon * l.z;
    const dz = this.cosLat * l.y + this.sinLat * l.z;
    const g = ecefToGeodetic({
      x: this.originEcef.x + dx,
      y: this.originEcef.y + dy,
      z: this.originEcef.z + dz,
    });
    out.lat = g.lat;
    out.lon = g.lon;
    out.alt = g.alt;
    return out;
  }
}

/**
 * Floating origin / rebasing (REQUIREMENT 008).
 *
 * Scene positions are stored as `double`-precision local metres, but the GPU
 * only sees float32. Past ~10^5 local metres, float32 quantisation makes
 * objects visibly swim. `rebase()` moves the frame origin so the camera stays
 * near (0,0,0) in render space, and returns the delta that must be applied to
 * every scene object.
 */
/* ------------------------------------------------------- scene space map --- */

/**
 * The tangent frame is ENU: x = East, y = North, z = Up.
 * The renderer is Y-up with north along -Z, which is what makes `headingDeg = 0`
 * mean "looking north". These two conversions are the single place where that
 * convention is written down, so nothing else has to guess.
 */
export function enuToScene(e: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  out.x = e.x; // East  -> +X
  out.y = e.z; // Up    -> +Y
  out.z = -e.y; // North -> -Z
  return out;
}

export function sceneToEnu(s: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  out.x = s.x;
  out.y = -s.z;
  out.z = s.y;
  return out;
}

export interface RebaseResult {
  /** Render-space offset subtracted from all stored local positions. */
  offset: Vec3;
  /** True when the offset changed enough to be worth applying. */
  changed: boolean;
}

export const REBASE_THRESHOLD = 5000; // metres from render origin

export function shouldRebase(cameraLocal: Vec3, currentOffset: Vec3, threshold = REBASE_THRESHOLD) {
  const dx = cameraLocal.x - currentOffset.x;
  const dy = cameraLocal.y - currentOffset.y;
  const dz = cameraLocal.z - currentOffset.z;
  return Math.hypot(dx, dy, dz) > threshold;
}

/** Compute the new render offset that recentres the camera (keeps Y=up stable). */
export function rebase(cameraLocal: Vec3, keepVertical = true): Vec3 {
  return {
    x: cameraLocal.x,
    y: keepVertical ? 0 : cameraLocal.y,
    z: cameraLocal.z,
  };
}

/**
 * Convert a stored local position into render space by subtracting the current
 * floating-origin offset. Kept as a single call site so a rebasing bug can only
 * live in one place.
 */
export function toRenderSpace(local: Vec3, offset: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  out.x = local.x - offset.x;
  out.y = local.y - offset.y;
  out.z = local.z - offset.z;
  return out;
}

export function toLocalSpace(render: Vec3, offset: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  out.x = render.x + offset.x;
  out.y = render.y + offset.y;
  out.z = render.z + offset.z;
  return out;
}
