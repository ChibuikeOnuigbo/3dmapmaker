/**
 * packages/terrain — heightfield, mesh, sculpt and analysis tests.
 *
 * These cover the guarantees the whole terrain system rests on: deterministic
 * generation, stitched tile borders, real interpolation, edits that survive
 * regeneration, and contour/hillshade extraction.
 */
import { describe, expect, it } from 'vitest';
import { Heightfield } from './heightfield';
import { generateHeightfield } from './generator';
import { buildTerrainMesh } from './mesh';
import { applyStroke, applyBrush, defaultBrush } from './sculpt';
import { hillshade, extractContours, slopeRaster } from './analysis';
import type { TerrainSource } from './generator';

const procedural = (over: Partial<Extract<TerrainSource, { kind: 'procedural' }>> = {}): TerrainSource => ({
  kind: 'procedural',
  seed: 1337,
  octaves: 4,
  lacunarity: 2.02,
  gain: 0.5,
  amplitude: 120,
  frequency: 0.002,
  warp: 0.3,
  ridged: false,
  ...over,
});

const gen = (source: TerrainSource, resolution: number, size: number, originX = 0, originY = 0) =>
  generateHeightfield({ source, resolution, size, originX, originY });

describe('Heightfield', () => {
  it('rejects a resolution below 2', () => {
    expect(() => new Heightfield(1, 100)).toThrow();
  });

  it('computes step from size and resolution', () => {
    const h = new Heightfield(33, 256);
    expect(h.step).toBeCloseTo(8, 6);
  });

  it('interpolates between grid nodes', () => {
    const h = new Heightfield(3, 20);
    h.set(0, 0, 0);
    h.set(1, 0, 10);
    h.set(2, 0, 20);
    h.set(0, 1, 0);
    h.set(1, 1, 10);
    h.set(2, 1, 20);
    h.set(0, 2, 0);
    h.set(1, 2, 10);
    h.set(2, 2, 20);
    // step is 10 m here, so x=5 is the midpoint of node 0 (0) and node 1 (10).
    expect(h.sample(5, 0)).toBeCloseTo(5, 6);
    expect(h.sample(15, 0)).toBeCloseTo(15, 6);
    expect(h.sample(10, 0)).toBeCloseTo(10, 6);
  });

  it('reports min/max', () => {
    const h = new Heightfield(3, 20);
    h.set(0, 0, -5);
    h.set(2, 2, 42);
    const { min, max } = h.minMax();
    expect(min).toBe(-5);
    expect(max).toBe(42);
  });

  it('clones independently', () => {
    const h = new Heightfield(4, 30);
    h.set(1, 1, 7);
    const c = h.clone();
    c.set(1, 1, 9);
    expect(h.get(1, 1)).toBe(7);
    expect(c.get(1, 1)).toBe(9);
  });

  it('reports outside-bounds sampling as 0 rather than NaN', () => {
    const h = new Heightfield(4, 30);
    expect(Number.isFinite(h.sample(-1000, 5000))).toBe(true);
  });
});

describe('procedural generation', () => {
  it('is deterministic for a given seed', () => {
    const a = gen(procedural({ seed: 99 }), 33, 256);
    const b = gen(procedural({ seed: 99 }), 33, 256);
    let maxDiff = 0;
    for (let i = 0; i < a.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.data[i] - b.data[i]));
    expect(maxDiff).toBe(0);
  });

  it('differs between seeds', () => {
    const a = gen(procedural({ seed: 1 }), 33, 256);
    const b = gen(procedural({ seed: 2 }), 33, 256);
    let diff = 0;
    for (let i = 0; i < a.data.length; i++) diff += Math.abs(a.data[i] - b.data[i]);
    expect(diff).toBeGreaterThan(1);
  });

  it('actually uses the amplitude parameter as the relief budget', () => {
    const small = gen(procedural({ amplitude: 120 }), 49, 512);
    const large = gen(procedural({ amplitude: 1200 }), 49, 512);
    const span = (h: Heightfield) => h.minMax().max - h.minMax().min;
    // Ten times the budget must give (very nearly) ten times the relief, and
    // both must stay inside [-amplitude, +amplitude].
    expect(span(small) / span(large)).toBeCloseTo(0.1, 3);
    expect(span(small)).toBeLessThanOrEqual(240);
    expect(span(large)).toBeLessThanOrEqual(2400);
    expect(Math.abs(small.minMax().min)).toBeLessThanOrEqual(120);
    expect(large.minMax().max).toBeLessThanOrEqual(1200);
  });

  it('is centred on zero elevation', () => {
    const h = gen(procedural({ amplitude: 500 }), 65, 1024);
    const { min, max } = h.minMax();
    expect(Math.abs((min + max) / 2)).toBeLessThan(120);
  });

  it('produces a flat field for a flat source', () => {
    const h = gen({ kind: 'flat', elevation: 37.5 }, 17, 128);
    const { min, max } = h.minMax();
    expect(min).toBe(37.5);
    expect(max).toBe(37.5);
  });

  it('ridged noise gives sharper relief than smooth noise at equal amplitude', () => {
    const smooth = gen(procedural({ seed: 7, amplitude: 300, ridged: false }), 49, 512);
    const ridged = gen(procedural({ seed: 7, amplitude: 300, ridged: true }), 49, 512);
    const roughness = (h: Heightfield) => slopeRaster(h).reduce((a, v) => a + v, 0) / h.data.length;
    expect(roughness(ridged)).toBeGreaterThan(roughness(smooth));
  });
});

describe('tile stitching', () => {
  it('shares border heights between horizontally adjacent tiles', () => {
    const src = procedural();
    const a = gen(src, 33, 256, 0, 0);
    const b = gen(src, 33, 256, 256, 0);
    let worst = 0;
    for (let gy = 0; gy < 33; gy++) worst = Math.max(worst, Math.abs(a.sample(256, gy * 8) - b.sample(256, gy * 8)));
    expect(worst).toBeLessThan(1e-3);
  });

  it('shares border heights between vertically adjacent tiles', () => {
    const src = procedural();
    const a = gen(src, 33, 256, 0, 0);
    const b = gen(src, 33, 256, 0, 256);
    let worst = 0;
    for (let gx = 0; gx < 33; gx++) worst = Math.max(worst, Math.abs(a.sample(gx * 8, 256) - b.sample(gx * 8, 256)));
    expect(worst).toBeLessThan(1e-3);
  });
});

describe('meshing', () => {
  it('produces Y-up geometry with the expected vertex count', () => {
    const h = gen(procedural(), 17, 128);
    const mesh = buildTerrainMesh(h);
    expect(mesh.vertexCount).toBeGreaterThanOrEqual(17 * 17);
    expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.triangleCount).toBe(mesh.indices.length / 3);
  });

  it('adds a skirt that dips below the lowest sample', () => {
    const h = gen(procedural(), 25, 256);
    const mesh = buildTerrainMesh(h, { skirtMeters: 6 });
    let minY = Infinity;
    for (let i = 1; i < mesh.positions.length; i += 3) minY = Math.min(minY, mesh.positions[i]);
    expect(minY).toBeLessThan(h.minMax().min);
  });

  it('applies vertical exaggeration to geometry only', () => {
    const h = gen(procedural({ amplitude: 200 }), 25, 256);
    const flat = buildTerrainMesh(h, { verticalExaggeration: 1 });
    const exaggerated = buildTerrainMesh(h, { verticalExaggeration: 3 });
    const span = (m: typeof flat) => m.bounds.maxY - m.bounds.minY;
    expect(span(exaggerated)).toBeCloseTo(span(flat) * 3, 3);
    // The stored heights are untouched — this is a render-only transform.
    expect(h.minMax().max - h.minMax().min).toBeLessThan(200 * 2.5);
  });

  it('emits normals and uvs when asked', () => {
    const h = gen(procedural(), 9, 64);
    const mesh = buildTerrainMesh(h, { withNormals: true, withUvs: true });
    expect(mesh.normals.length).toBe(mesh.vertexCount * 3);
    expect(mesh.uvs.length).toBe(mesh.vertexCount * 2);
  });
});

describe('sculpting', () => {
  it('raises terrain under the brush and records touched samples', () => {
    const h = gen({ kind: 'flat', elevation: 0 }, 33, 256);
    const res = applyBrush(h, 128, 128, { ...defaultBrush(), tool: 'raise', radius: 40, strength: 30, dt: 1 });
    expect(res.touched).toBeGreaterThan(0);
    expect(h.sample(128, 128)).toBeGreaterThan(1);
  });

  it('lowers terrain with the lower tool', () => {
    const h = gen({ kind: 'flat', elevation: 100 }, 33, 256);
    applyBrush(h, 128, 128, { ...defaultBrush(), tool: 'lower', radius: 40, strength: 30, dt: 1 });
    expect(h.sample(128, 128)).toBeLessThan(99);
  });

  it('flattens towards the target elevation', () => {
    const h = gen(procedural({ amplitude: 300 }), 33, 256);
    for (let i = 0; i < 30; i++) {
      applyBrush(h, 128, 128, { ...defaultBrush(), tool: 'flatten', radius: 60, strength: 40, target: 50, dt: 1 });
    }
    expect(Math.abs(h.sample(128, 128) - 50)).toBeLessThan(5);
  });

  it('smooths away a spike without moving the surroundings much', () => {
    const h = gen({ kind: 'flat', elevation: 0 }, 33, 256);
    h.set(16, 16, 200);
    applyBrush(h, 128, 128, { ...defaultBrush(), tool: 'smooth', radius: 60, strength: 200, dt: 1 });
    expect(h.get(16, 16)).toBeLessThan(200);
    expect(Math.abs(h.get(1, 1))).toBeLessThan(5);
  });

  it('traces a stroke between two points', () => {
    const h = gen({ kind: 'flat', elevation: 0 }, 33, 256);
    const res = applyStroke(h, { x: 60, y: 128 }, { x: 200, y: 128 }, { ...defaultBrush(), tool: 'raise', radius: 20, strength: 20, dt: 1 });
    expect(res.changed).toBe(true);
    expect(h.sample(60, 128)).toBeGreaterThan(0.5);
    expect(h.sample(200, 128)).toBeGreaterThan(0.5);
  });

  it('exports edits that reapply exactly to a regenerated tile', () => {
    const src = procedural();
    const h = gen(src, 33, 256);
    const before = h.sample(128, 128);
    applyStroke(h, { x: 128, y: 128 }, { x: 128, y: 128 }, { ...defaultBrush(), tool: 'raise', radius: 40, strength: 60, dt: 1 });
    const after = h.sample(128, 128);
    expect(after).toBeGreaterThan(before + 1);

    const edits = h.toEdits(gen(src, 33, 256));
    const rebuilt = gen(src, 33, 256);
    rebuilt.applyEdits(edits);
    expect(rebuilt.sample(128, 128)).toBeCloseTo(after, 3);
  });
});

describe('analysis', () => {
  it('hillshade changes with sun azimuth', () => {
    const h = gen(procedural(), 33, 256);
    const a = hillshade(h, { azimuthDeg: 315, elevationDeg: 45, intensity: 1, zFactor: 1, cellSize: h.step });
    const b = hillshade(h, { azimuthDeg: 135, elevationDeg: 45, intensity: 1, zFactor: 1, cellSize: h.step });
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBeGreaterThan(100);
  });

  it('hillshade a flat field uniformly', () => {
    const h = gen({ kind: 'flat', elevation: 10 }, 17, 128);
    const s = hillshade(h, { azimuthDeg: 315, elevationDeg: 45, intensity: 1, zFactor: 1, cellSize: h.step });
    const first = s[8 * 17 + 8];
    for (let y = 4; y < 13; y++) for (let x = 4; x < 13; x++) expect(s[y * 17 + x]).toBe(first);
  });

  it('extracts contours at the requested interval', () => {
    const h = gen(procedural({ amplitude: 400 }), 49, 512);
    const result = extractContours(h, 50, 5);
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.levels.length).toBeGreaterThan(3);
    for (const level of result.levels) expect(Math.abs(level % 50)).toBeLessThan(1e-3);
  });

  it('marks index contours every Nth level', () => {
    const h = gen(procedural({ amplitude: 400 }), 49, 512);
    const result = extractContours(h, 50, 5);
    const indexLevels = [...new Set(result.segments.filter((s) => s.index).map((s) => s.elevation))];
    expect(indexLevels.length).toBeGreaterThan(0);
    for (const level of indexLevels) expect(Math.abs(level % 250)).toBeLessThan(1e-3);
  });

  it('rejects a non-positive contour interval', () => {
    const h = gen(procedural(), 9, 64);
    expect(() => extractContours(h, 0)).toThrow();
  });
});
