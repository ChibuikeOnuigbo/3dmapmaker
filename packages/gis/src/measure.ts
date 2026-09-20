/**
 * packages/gis — measurements (REQUIREMENT 074, 075, 079).
 *
 * Everything here works on *real* values. Vertical exaggeration (REQ 052) is a
 * render-only transform and must never flow into these functions.
 */
import type { GeoCoord, Vec3 } from './coordinates';
import { WGS84, TangentFrame } from './coordinates';

export interface MeasureResult {
  /** 3D straight-line distance in metres. */
  distance3d: number;
  /** Horizontal (plan) distance in metres. */
  horizontal: number;
  /** Signed vertical difference in metres (b.alt - a.alt). */
  vertical: number;
  /** Slope in degrees, positive uphill from a to b. */
  slopeDeg: number;
  /** Slope as a percentage grade. */
  slopePct: number;
  /** True-north bearing from a to b, degrees [0,360). */
  bearingDeg: number;
}

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Local-space measurement. `a`/`b` are ENU metres in the same tangent frame,
 * so this is exact plane geometry and needs no geodesic approximation.
 */
export function measureLocal(a: Vec3, b: Vec3): MeasureResult {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const horizontal = Math.hypot(dx, dy);
  const distance3d = Math.hypot(dx, dy, dz);
  return {
    distance3d,
    horizontal,
    vertical: dz,
    slopeDeg: horizontal < 1e-9 ? 0 : (Math.atan2(dz, horizontal) * 180) / Math.PI,
    slopePct: horizontal < 1e-9 ? 0 : (dz / horizontal) * 100,
    // In ENU, +x is East and +y is North, so bearing is atan2(east, north).
    bearingDeg: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360,
  };
}

/** Surface distance along a sampled polyline (sum of segment lengths). */
export function polylineLength(points: ReadonlyArray<Vec3>, use3d = true): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    total += use3d ? Math.hypot(dx, dy, dz) : Math.hypot(dx, dy);
  }
  return total;
}

/** Vincenty inverse on WGS84 — accurate to ~0.5 mm, unlike haversine. */
export function geodesicDistance(a: GeoCoord, b: GeoCoord): number {
  const { a: R, f } = WGS84;
  const bAxis = R * (1 - f);
  const toRad = Math.PI / 180;
  const L = (b.lon - a.lon) * toRad;
  const U1 = Math.atan((1 - f) * Math.tan(a.lat * toRad));
  const U2 = Math.atan((1 - f) * Math.tan(b.lat * toRad));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let lambdaPrev: number;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let sinAlpha = 0;
  let cos2Alpha = 0;
  let cos2SigmaM = 0;

  for (let i = 0; i < 200; i++) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.hypot(
      cosU2 * sinLambda,
      cosU1 * sinU2 - sinU1 * cosU2 * cosLambda,
    );
    if (sinSigma === 0) return 0; // coincident points
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0;
    const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    lambdaPrev = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - lambdaPrev) < 1e-12) break;
  }

  const u2 = (cos2Alpha * (R * R - bAxis * bAxis)) / (bAxis * bAxis);
  const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  return bAxis * A * (sigma - deltaSigma);
}

/** Initial great-circle bearing a -> b, degrees true north. */
export function geodesicBearing(a: GeoCoord, b: GeoCoord): number {
  const toRad = Math.PI / 180;
  const phi1 = a.lat * toRad;
  const phi2 = b.lat * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Signed planar area of a closed ring using the shoelace formula on local ENU
 * metres. Returns m^2 (absolute value). Accurate for region-scale polygons.
 */
export function ringArea(ring: ReadonlyArray<Vec3>): number {
  if (ring.length < 3) return 0;
  let twice = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    twice += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  }
  return Math.abs(twice) / 2;
}

export function ringPerimeter(ring: ReadonlyArray<Vec3>, closed = true): number {
  const pts = closed && ring.length > 0 ? [...ring, ring[0]] : [...ring];
  return polylineLength(pts, false);
}

/**
 * Relative-to-centre report (REQUIREMENT 075): distance, bearing and elevation
 * difference from a user-defined centre point.
 */
export function centerRelative(center: Vec3, point: Vec3) {
  const m = measureLocal(center, point);
  return {
    dx: point.x - center.x,
    dy: point.y - center.y,
    dz: point.z - center.z,
    distance: m.distance3d,
    horizontal: m.horizontal,
    bearingDeg: m.bearingDeg,
    elevationDifference: m.vertical,
  };
}

/** Ground metres covered by one pixel at `lat` on a zoom-`z` web-mercator map. */
export function groundResolution(lat: number, z: number, tileSize = 256): number {
  return (WGS84.a * 2 * Math.PI * Math.cos((lat * Math.PI) / 180)) / (tileSize * Math.pow(2, z));
}

export function makeFrame(origin: GeoCoord) {
  return new TangentFrame(origin);
}
