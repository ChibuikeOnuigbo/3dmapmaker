/**
 * packages/gis — coordinate and measurement tests.
 *
 * These exercise the real conversion code: geodetic ↔ ECEF ↔ local, the
 * scene-space convention, floating-origin rebasing and measurement math.
 */
import { describe, expect, it } from 'vitest';
import {
  TangentFrame,
  geo,
  geodeticToEcef,
  ecefToGeodetic,
  enuToScene,
  sceneToEnu,
  rebase,
  shouldRebase,
  REBASE_THRESHOLD,
  toRenderSpace,
  toLocalSpace,
} from './coordinates';
import { measureLocal, polylineLength, ringArea, ringPerimeter, centerRelative, geodesicDistance, geodesicBearing } from './measure';

const ORIGIN = geo(46.5197, 8.2104, 0); // somewhere in the Alps

describe('geodetic ↔ ECEF', () => {
  it('round-trips a point to sub-millimetre accuracy', () => {
    const g = geo(46.52, 8.21, 412.5);
    const back = ecefToGeodetic(geodeticToEcef(g));
    expect(Math.abs(back.lat - g.lat)).toBeLessThan(1e-9);
    expect(Math.abs(back.lon - g.lon)).toBeLessThan(1e-9);
    expect(Math.abs(back.alt - g.alt)).toBeLessThan(1e-3);
  });

  it('places the equator/prime-meridian point one semi-major axis out', () => {
    const e = geodeticToEcef(geo(0, 0, 0));
    expect(e.x).toBeCloseTo(6378137, 0);
    expect(Math.abs(e.y)).toBeLessThan(1e-6);
    expect(Math.abs(e.z)).toBeLessThan(1e-6);
  });
});

describe('tangent frame', () => {
  it('maps the origin to (0,0,0)', () => {
    const f = new TangentFrame(ORIGIN);
    const l = f.toLocal(ORIGIN);
    expect(l.x).toBeCloseTo(0, 6);
    expect(l.y).toBeCloseTo(0, 6);
    expect(l.z).toBeCloseTo(0, 6);
  });

  it('round-trips geodetic → local → geodetic without drift', () => {
    const f = new TangentFrame(ORIGIN);
    const g = geo(46.53, 8.23, 120);
    const back = f.toGeo(f.toLocal(g));
    const err = Math.hypot((back.lat - g.lat) * 111320, (back.lon - g.lon) * 111320 * Math.cos((g.lat * Math.PI) / 180), back.alt - g.alt);
    expect(err).toBeLessThan(0.01);
  });

  it('treats north as +y and east as +x', () => {
    const f = new TangentFrame(ORIGIN);
    const north = f.toLocal(geo(ORIGIN.lat + 0.01, ORIGIN.lon, 0));
    const east = f.toLocal(geo(ORIGIN.lat, ORIGIN.lon + 0.01, 0));
    expect(north.y).toBeGreaterThan(1000);
    expect(Math.abs(north.x)).toBeLessThan(5);
    expect(east.x).toBeGreaterThan(500);
    expect(Math.abs(east.y)).toBeLessThan(5);
  });
});

describe('scene-space convention', () => {
  it('puts up on +Y and north on -Z', () => {
    const s = enuToScene({ x: 3, y: 4, z: 5 });
    expect(s).toEqual({ x: 3, y: 5, z: -4 });
  });

  it('is an exact inverse', () => {
    const e = { x: -12.5, y: 7.25, z: 99 };
    expect(sceneToEnu(enuToScene(e))).toEqual(e);
  });
});

describe('floating origin', () => {
  it('does not rebase inside the threshold', () => {
    expect(shouldRebase({ x: 1200, y: 40, z: -900 }, { x: 0, y: 0, z: 0 })).toBe(false);
  });

  it('rebases beyond the threshold and brings the camera back near zero', () => {
    const cam = { x: 9000, y: 120, z: 400 };
    expect(shouldRebase(cam, { x: 0, y: 0, z: 0 })).toBe(true);
    const offset = rebase(cam, true);
    expect(Math.hypot(cam.x - offset.x, cam.z - offset.z)).toBeLessThan(REBASE_THRESHOLD);
    // Vertical is preserved, so the eye height never jumps on a rebase.
    expect(offset.y).toBeCloseTo(0, 6);
  });

  it('render/local space conversion is an exact inverse', () => {
    const local = { x: 120, y: 30, z: -55 };
    const offset = { x: 40, y: 0, z: 20 };
    expect(toLocalSpace(toRenderSpace(local, offset), offset)).toEqual(local);
  });
});

describe('measurements', () => {
  it('computes an exact 3-4-5 triangle', () => {
    const m = measureLocal({ x: 0, y: 0, z: 0 }, { x: 3000, y: 4000, z: 0 });
    expect(m.distance3d).toBeCloseTo(5000, 6);
    expect(m.horizontal).toBeCloseTo(5000, 6);
    expect(m.vertical).toBe(0);
  });

  it('reports slope in degrees and percent grade', () => {
    const m = measureLocal({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 100 });
    expect(m.slopeDeg).toBeCloseTo(45, 6);
    expect(m.slopePct).toBeCloseTo(100, 6);
  });

  it('gives a north bearing of 0 and an east bearing of 90', () => {
    expect(measureLocal({ x: 0, y: 0, z: 0 }, { x: 0, y: 50, z: 0 }).bearingDeg).toBeCloseTo(0, 6);
    expect(measureLocal({ x: 0, y: 0, z: 0 }, { x: 50, y: 0, z: 0 }).bearingDeg).toBeCloseTo(90, 6);
  });

  it('sums polyline length segment by segment', () => {
    const pts = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 10, z: 0 },
    ];
    expect(polylineLength(pts)).toBeCloseTo(20, 6);
    expect(polylineLength(pts, false)).toBeCloseTo(20, 6);
  });

  it('distinguishes 3D from plan distance on a slope', () => {
    const pts = [
      { x: 0, y: 0, z: 0 },
      { x: 30, y: 40, z: 0 },
    ];
    expect(polylineLength(pts, true)).toBeCloseTo(50, 6);
    expect(polylineLength(pts, false)).toBeCloseTo(50, 6);
    const sloped = [
      { x: 0, y: 0, z: 0 },
      { x: 30, y: 0, z: 40 },
    ];
    expect(polylineLength(sloped, true)).toBeCloseTo(50, 6);
    expect(polylineLength(sloped, false)).toBeCloseTo(30, 6);
  });

  it('computes the area of a unit square ring', () => {
    const ring = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 10, z: 0 },
      { x: 0, y: 10, z: 0 },
    ];
    expect(ringArea(ring)).toBeCloseTo(100, 6);
    expect(ringPerimeter(ring)).toBeCloseTo(40, 6);
  });

  it('reports centre-relative distance and bearing', () => {
    const r = centerRelative({ x: 0, y: 0, z: 0 }, { x: 0, y: 100, z: 50 });
    expect(r.distance).toBeCloseTo(Math.hypot(100, 50), 6);
    expect(r.bearingDeg).toBeCloseTo(0, 6);
    expect(r.elevationDifference).toBeCloseTo(50, 6);
  });

  it('agrees with the geodesic formula over a long baseline', () => {
    const a = geo(46.5, 8.2, 0);
    const b = geo(47.5, 8.2, 0);
    // One degree of latitude is ~111.3 km everywhere on the WGS84 ellipsoid.
    expect(geodesicDistance(a, b)).toBeGreaterThan(110500);
    expect(geodesicDistance(a, b)).toBeLessThan(112000);
    expect(geodesicBearing(a, b)).toBeCloseTo(0, 1);
  });
});
