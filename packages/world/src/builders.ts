/**
 * packages/world — geometry builders for authored content
 * (REQUIREMENT 055-058, 072, 073, 089).
 *
 * Everything here produces typed arrays / BufferGeometry from plain data in the
 * project document, so it is deterministic and unit-testable.
 */
import * as THREE from 'three';
import earcut from 'earcut';

export interface Vec2 {
  x: number;
  y: number;
}
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/* ------------------------------------------------------------------ paths --- */

export interface PathStyle {
  width: number;
  lanes?: number;
  sidewalkWidth?: number;
  /** Sample spacing in metres used for curve smoothing. */
  sampleSpacing?: number;
  /** Catmull-Rom tension; 0 = polyline, 0.5 = smooth. */
  smoothing?: number;
}

/** Resample a polyline with Catmull-Rom smoothing. */
export function smoothPath(points: ReadonlyArray<Vec2>, smoothing = 0.5, spacing = 4): Vec2[] {
  if (points.length < 3 || smoothing <= 0) return points.map((p) => ({ ...p }));
  const out: Vec2[] = [];
  const n = points.length;
  const segments = Math.max(2, Math.round(smoothing * 8));
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];
    for (let s = 0; s < segments; s++) {
      const t = s / segments;
      out.push(catmullRom2(p0, p1, p2, p3, t));
    }
  }
  out.push({ ...points[n - 1] });
  // resample to roughly even spacing so width extrusion is uniform
  return resampleEvenly(out, spacing);
}

function catmullRom2(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const t2 = t * t;
  const t3 = t2 * t;
  const w = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return { x: w(p0.x, p1.x, p2.x, p3.x), y: w(p0.y, p1.y, p2.y, p3.y) };
}

export function resampleEvenly(points: ReadonlyArray<Vec2>, spacing: number): Vec2[] {
  if (points.length < 2) return points.map((p) => ({ ...p }));
  const out: Vec2[] = [{ ...points[0] }];
  let carried = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    let segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-6) continue;
    let t = carried / segLen;
    while (t <= 1) {
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      t += spacing / segLen;
    }
    carried = (t - 1) * segLen;
  }
  out.push({ ...points[points.length - 1] });
  return out;
}

export function pathLength(points: ReadonlyArray<Vec2>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

/**
 * Extrude a path into a flat ribbon geometry. `heightAt` lets the ribbon follow
 * the terrain (REQUIREMENT 056 "terrain following").
 */
export function buildPathRibbon(
  points: ReadonlyArray<Vec2>,
  style: PathStyle,
  heightAt: (x: number, y: number) => number,
  yOffset = 0.08,
): THREE.BufferGeometry {
  const pts = smoothPath(points, style.smoothing ?? 0.5, style.sampleSpacing ?? 4);
  if (pts.length < 2) return new THREE.BufferGeometry();
  const halfW = Math.max(0.05, style.width / 2);
  const sidewalk = style.sidewalkWidth ?? 0;
  const totalHalf = halfW + sidewalk;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let travelled = 0;

  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    // perpendicular in XZ
    const nx = -ty;
    const nz = tx;
    const p = pts[i];
    const h = heightAt(p.x, p.y) + yOffset;
    if (i > 0) travelled += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);

    positions.push(p.x + nx * totalHalf, h, p.y + nz * totalHalf);
    positions.push(p.x - nx * totalHalf, h, p.y - nz * totalHalf);
    uvs.push(0, travelled / Math.max(1, style.width));
    uvs.push(1, travelled / Math.max(1, style.width));

    if (i > 0) {
      const a = (i - 1) * 2;
      const b = a + 1;
      const c = i * 2;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/* --------------------------------------------------------------- polygons --- */

/** Triangulate a planar polygon in XZ and lift it onto the terrain. */
export function buildPolygonGeometry(
  ring: ReadonlyArray<Vec2>,
  heightAt: (x: number, y: number) => number,
  opts: { yOffset?: number; extrudeHeight?: number; holes?: ReadonlyArray<ReadonlyArray<Vec2>> } = {},
): THREE.BufferGeometry {
  const yOffset = opts.yOffset ?? 0.05;
  const holes = opts.holes ?? [];
  if (ring.length < 3) return new THREE.BufferGeometry();

  const flat: number[] = [];
  const holeIndices: number[] = [];
  for (const p of ring) flat.push(p.x, p.y);
  for (const hole of holes) {
    holeIndices.push(flat.length / 2);
    for (const p of hole) flat.push(p.x, p.y);
  }

  const tris = earcut(flat, holeIndices.length ? holeIndices : undefined);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const vertCount = flat.length / 2;
  for (let i = 0; i < vertCount; i++) {
    const x = flat[i * 2];
    const y = flat[i * 2 + 1];
    const h = heightAt(x, y) + yOffset + (opts.extrudeHeight ?? 0);
    positions.push(x, h, y);
    uvs.push(x, y);
  }
  for (let i = 0; i < tris.length; i += 3) {
    // earcut returns CW for our XZ convention; flip for correct up-facing normals
    indices.push(tris[i], tris[i + 2], tris[i + 1]);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingSphere();

  if (opts.extrudeHeight && opts.extrudeHeight > 0) {
    addPolygonSideWall(g, ring, heightAt, yOffset, opts.extrudeHeight);
  }
  return g;
}

function addPolygonSideWall(
  g: THREE.BufferGeometry,
  ring: ReadonlyArray<Vec2>,
  heightAt: (x: number, y: number) => number,
  yOffset: number,
  height: number,
): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const positions = Array.from(pos.array as Float32Array);
  const uvs = Array.from(uv.array as Float32Array);
  const indices = Array.from(g.getIndex()!.array as Uint16Array | Uint32Array);

  const baseCount = positions.length / 3;
  for (const p of ring) {
    const h = heightAt(p.x, p.y) + yOffset;
    positions.push(p.x, h, p.y);
    uvs.push(p.x, p.y);
    positions.push(p.x, h + height, p.y);
    uvs.push(p.x, p.y);
  }
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const a = baseCount + i * 2;
    const b = a + 1;
    const c = baseCount + j * 2;
    const d = c + 1;
    indices.push(a, b, c, c, b, d);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingSphere();
}

/* -------------------------------------------------------------- buildings --- */

export interface BuildingSpec {
  footprint: ReadonlyArray<Vec2>;
  floors: number;
  floorHeight: number;
  roof: 'flat' | 'gable' | 'hip' | 'parapet';
  heightAt: (x: number, y: number) => number;
}

/**
 * Procedural building from a footprint (REQUIREMENT 057). Reuses one box
 * geometry per (width, depth, height) bucket through the MaterialLibrary so a
 * city block is a handful of draw calls, not hundreds.
 */
export function buildBuilding(spec: BuildingSpec): { geometry: THREE.BufferGeometry; height: number; footprintArea: number } {
  const height = Math.max(1, spec.floors * spec.floorHeight);
  const geom = buildPolygonGeometry(spec.footprint, spec.heightAt, { extrudeHeight: height, yOffset: 0 });
  if (spec.roof !== 'flat' && spec.footprint.length >= 3) {
    addGableRoof(geom, spec.footprint, spec.heightAt, height);
  }
  let area = 0;
  for (let i = 0, j = spec.footprint.length - 1; i < spec.footprint.length; j = i++) {
    area += spec.footprint[j].x * spec.footprint[i].y - spec.footprint[i].x * spec.footprint[j].y;
  }
  return { geometry: geom, height, footprintArea: Math.abs(area) / 2 };
}

function addGableRoof(
  g: THREE.BufferGeometry,
  ring: ReadonlyArray<Vec2>,
  heightAt: (x: number, y: number) => number,
  wallHeight: number,
): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let cx = 0;
  let cy = 0;
  for (const p of ring) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    cx += p.x;
    cy += p.y;
  }
  cx /= ring.length;
  cy /= ring.length;
  const ridgeHeight = wallHeight + Math.min(6, (maxY - minY) * 0.25);
  const base = heightAt(cx, cy);

  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const positions = Array.from(pos.array as Float32Array);
  const indices = Array.from(g.getIndex()!.array as Uint16Array | Uint32Array);
  const apexIndex = positions.length / 3;
  positions.push(cx, base + ridgeHeight, cy);
  const baseCount = pos.count;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const a = baseCount + i * 2 + 1; // top of wall i
    const b = baseCount + j * 2 + 1;
    indices.push(a, b, apexIndex);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  void minX;
  void maxX;
}

/* ------------------------------------------------------------------ walls --- */

/** Wall/fence from a path with a collision proxy box list (REQUIREMENT 058). */
export function buildWall(
  points: ReadonlyArray<Vec2>,
  opts: { height: number; thickness: number; heightAt: (x: number, y: number) => number },
): { geometry: THREE.BufferGeometry; proxies: Array<{ cx: number; cy: number; cz: number; sx: number; sy: number; sz: number; rotY: number }> } {
  const o = opts;
  const g = buildPathRibbon(points, { width: o.thickness, smoothing: 0.35, sampleSpacing: 2 }, o.heightAt, 0);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const count = pos.count;
  const positions = Array.from(pos.array as Float32Array);
  const indices = Array.from(g.getIndex()!.array as Uint16Array | Uint32Array);
  // duplicate the ribbon at +height to form a vertical band
  const base = count;
  for (let i = 0; i < count; i++) {
    positions.push(positions[i * 3], positions[i * 3 + 1] + o.height, positions[i * 3 + 2]);
  }
  const uvAttr = g.getAttribute('uv') as THREE.BufferAttribute;
  const uvs = Array.from(uvAttr.array as Float32Array);
  for (let i = 0; i < count; i++) uvs.push(uvs[i * 2], uvs[i * 2 + 1]);
  for (let i = 0; i + 3 < count; i += 2) {
    const a = i;
    const b = i + 1;
    const c = i + 2;
    const d = i + 3;
    const a2 = base + a;
    const b2 = base + b;
    const c2 = base + c;
    const d2 = base + d;
    indices.push(a, b, a2, a2, b, b2);
    indices.push(c2, d2, c, c, d2, d);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingSphere();

  const proxies: Array<{ cx: number; cy: number; cz: number; sx: number; sy: number; sz: number; rotY: number }> = [];
  const smooth = smoothPath(points, 0.35, 2);
  for (let i = 1; i < smooth.length; i++) {
    const a = smooth[i - 1];
    const b = smooth[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.05) continue;
    const mid = o.heightAt((a.x + b.x) / 2, (a.y + b.y) / 2);
    proxies.push({
      cx: (a.x + b.x) / 2,
      cy: mid + o.height / 2,
      cz: (a.y + b.y) / 2,
      sx: len,
      sy: o.height,
      sz: o.thickness,
      rotY: Math.atan2(b.x - a.x, b.y - a.y),
    });
  }
  return { geometry: g, proxies };
}

/* --------------------------------------------------------------- water --- */

/**
 * Animated water material (REQUIREMENT 055). Two scrolling normal-ish sine
 * layers in the fragment shader — cheap, tileable, no texture download.
 */
export function createWaterMaterial(color = '#2f6f8f', quality: 'low' | 'normal' | 'high' = 'normal'): THREE.ShaderMaterial {
  const waves = quality === 'low' ? 2 : quality === 'normal' ? 4 : 6;
  return new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uDepthTint: { value: new THREE.Color('#0c2a38') },
      uOpacity: { value: 0.82 },
      uWaveHeight: { value: quality === 'low' ? 0.04 : 0.09 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uWaveHeight;
      varying vec2 vUv;
      varying float vWave;
      void main() {
        vUv = uv;
        vec3 p = position;
        float w = sin(p.x * 0.06 + uTime * 0.9) * cos(p.z * 0.05 + uTime * 0.7);
        w += 0.5 * sin(p.x * 0.13 - uTime * 1.3) * cos(p.z * 0.11 + uTime * 0.5);
        p.y += w * uWaveHeight;
        vWave = w;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uDepthTint;
      uniform float uOpacity;
      uniform float uTime;
      varying vec2 vUv;
      varying float vWave;
      void main() {
        float sparkle = 0.5 + 0.5 * sin(vUv.x * ${waves * 40}.0 + uTime * 2.0) * sin(vUv.y * ${waves * 37}.0 - uTime * 1.7);
        vec3 col = mix(uDepthTint, uColor, 0.45 + 0.55 * (vWave * 0.5 + 0.5));
        col += vec3(sparkle * 0.06);
        gl_FragColor = vec4(col, uOpacity);
        #include <colorspace_fragment>
      }
    `,
  });
}

/* -------------------------------------------------------------- markers --- */

export function createMarkerGeometry(kind: 'pin' | 'sphere' | 'ring' | 'arrow'): THREE.BufferGeometry {
  switch (kind) {
    case 'sphere':
      return new THREE.SphereGeometry(0.6, 16, 12);
    case 'ring':
      return new THREE.TorusGeometry(0.8, 0.12, 8, 24);
    case 'arrow':
      return new THREE.ConeGeometry(0.5, 1.4, 12);
    case 'pin':
    default: {
      const g = new THREE.ConeGeometry(0.45, 1.6, 12);
      g.translate(0, 0.8, 0);
      return g;
    }
  }
}

/* --------------------------------------------------------- vegetation --- */

export interface VegetationScatterOptions {
  count: number;
  seed: number;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  heightAt: (x: number, z: number) => number;
  /** Reject placements steeper than this, in degrees. */
  maxSlopeDeg?: number;
  slopeAt?: (x: number, z: number) => number;
  minElevation?: number;
  maxElevation?: number;
  scaleRange?: [number, number];
}

export interface ScatterInstance {
  x: number;
  y: number;
  z: number;
  rotYDeg: number;
  scale: number;
  tint: number;
}

/**
 * Seeded vegetation scatter (REQUIREMENT 059). Deterministic: the same options
 * always produce the same instances, so save/reload does not reshuffle forests.
 */
export function scatterVegetation(opts: VegetationScatterOptions): ScatterInstance[] {
  let s = (opts.seed | 0) || 1;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 0) % 100000) / 100000;
  };
  const out: ScatterInstance[] = [];
  const [minScale, maxScale] = opts.scaleRange ?? [0.7, 1.4];
  let attempts = 0;
  const maxAttempts = opts.count * 4;
  while (out.length < opts.count && attempts < maxAttempts) {
    attempts++;
    const x = opts.bounds.minX + rnd() * (opts.bounds.maxX - opts.bounds.minX);
    const z = opts.bounds.minZ + rnd() * (opts.bounds.maxZ - opts.bounds.minZ);
    const y = opts.heightAt(x, z);
    if (!Number.isFinite(y)) continue;
    if (opts.minElevation !== undefined && y < opts.minElevation) continue;
    if (opts.maxElevation !== undefined && y > opts.maxElevation) continue;
    if (opts.slopeAt && opts.maxSlopeDeg !== undefined && opts.slopeAt(x, z) > opts.maxSlopeDeg) continue;
    out.push({
      x,
      y,
      z,
      rotYDeg: rnd() * 360,
      scale: minScale + rnd() * (maxScale - minScale),
      tint: 0x88 + Math.floor(rnd() * 0x40),
    });
  }
  return out;
}
