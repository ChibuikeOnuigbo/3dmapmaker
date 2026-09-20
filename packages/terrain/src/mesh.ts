/**
 * packages/terrain — tile mesh generation with stitched borders
 * (REQUIREMENT 047, HARDENING CHECK 004).
 *
 * Two mechanisms kill seams:
 *
 *  1. Heights are always evaluated from a single continuous global function
 *     (procedural noise + absolute-indexed edit overlay), so two tiles that
 *     share an edge compute identical elevations for the shared vertices.
 *
 *  2. When neighbours sit at different LODs, this tile's border vertices are
 *     *quantised* onto the coarser neighbour's grid, and a short skirt is
 *     extruded downward. That guarantees no gap regardless of the neighbour's
 *     resolution or load order.
 *
 * Output is plain typed arrays, so this file runs unchanged in a Web Worker.
 */
import type { Heightfield } from './heightfield';

export interface TerrainMeshOptions {
  /** Vertical exaggeration applied to geometry only (REQUIREMENT 052). */
  verticalExaggeration?: number;
  /** Snap border vertices to this metre spacing (coarse neighbour's step). */
  borderStepMeters?: number;
  /** Skirt height in metres; 0 disables the skirt. */
  skirtMeters?: number;
  /** Emit per-vertex slope in the `aExtra` attribute for shader colouring. */
  withSlope?: boolean;
  /** Emit UVs. */
  withUvs?: boolean;
  /** Compute smooth normals on the CPU (skip when using a normal map / derivative-based normal). */
  withNormals?: boolean;
}

export interface TerrainMeshData {
  positions: Float32Array; // xyz, Y-up local metres
  normals: Float32Array;
  uvs: Float32Array;
  slope: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
}

const UP_AXIS = 1; // three.js convention: +Y is up

export function buildTerrainMesh(hf: Heightfield, opts: TerrainMeshOptions = {}): TerrainMeshData {
  const vex = opts.verticalExaggeration ?? 1;
  const skirt = opts.skirtMeters ?? 0;
  const withUvs = opts.withUvs !== false;
  const withNormals = opts.withNormals !== false;
  const withSlope = opts.withSlope ?? true;

  const r = hf.resolution;
  const step = hf.step;
  const borderStep = opts.borderStepMeters && opts.borderStepMeters > step ? opts.borderStepMeters : 0;

  // ---- heights with optional border quantisation -------------------------
  const heights = new Float32Array(r * r);
  for (let gy = 0; gy < r; gy++) {
    for (let gx = 0; gx < r; gx++) {
      let h = hf.data[gy * r + gx];
      if (borderStep > 0 && (gx === 0 || gy === 0 || gx === r - 1 || gy === r - 1)) {
        // Snap the world position to the coarse grid, then resample. Because the
        // height function is continuous, this yields exactly the neighbour's
        // vertex elevation at that coarse grid point.
        const wx = hf.originX + gx * step;
        const wy = hf.originY + gy * step;
        const sx = Math.round(wx / borderStep) * borderStep;
        const sy = Math.round(wy / borderStep) * borderStep;
        h = hf.sample(sx, sy);
      }
      heights[gy * r + gx] = h * vex;
    }
  }

  // The skirt is two *rings of border vertices* (an upper ring at the border
  // height and a lower ring pushed down), not two extra rows and columns, so
  // the buffer must be sized for 4(r-1) extra vertices per ring. Sizing it as
  // (r+2)^2 instead silently truncates the lower ring on a typed array write
  // past the end — the seam the skirt exists to hide.
  const skirtRings = skirt > 0 ? 1 : 0;
  const skirtVertices = skirtRings * 2 * 4 * (r - 1);
  const vertexCount = r * r + skirtVertices;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const slope = new Float32Array(vertexCount);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  const writeVertex = (vi: number, wx: number, wy: number, h: number) => {
    const o = vi * 3;
    positions[o] = wx - hf.originX - hf.size / 2; // centre the tile on its own origin
    positions[o + UP_AXIS] = h;
    positions[o + 2] = wy - hf.originY - hf.size / 2;
    if (positions[o] < minX) minX = positions[o];
    if (positions[o] > maxX) maxX = positions[o];
    if (h < minY) minY = h;
    if (h > maxY) maxY = h;
    if (positions[o + 2] < minZ) minZ = positions[o + 2];
    if (positions[o + 2] > maxZ) maxZ = positions[o + 2];
  };

  let vi = 0;
  // main grid
  for (let gy = 0; gy < r; gy++) {
    for (let gx = 0; gx < r; gx++, vi++) {
      const wx = hf.originX + gx * step;
      const wy = hf.originY + gy * step;
      const h = heights[gy * r + gx];
      writeVertex(vi, wx, wy, h);
      if (withUvs) {
        uvs[vi * 2] = gx / (r - 1);
        uvs[vi * 2 + 1] = gy / (r - 1);
      }
      if (withSlope) {
        const n = hf.normalAt(wx, wy);
        slope[vi] = (Math.acos(Math.min(1, Math.max(-1, n.z))) * 180) / Math.PI;
      }
    }
  }

  // skirt ring: duplicate the border, pushed straight down. This covers the
  // vertical gap that appears when a neighbour tile has not loaded yet.
  if (skirtRings > 0) {
    const border: Array<[number, number]> = [];
    for (let gx = 0; gx < r; gx++) border.push([gx, 0]);
    for (let gy = 1; gy < r; gy++) border.push([r - 1, gy]);
    for (let gx = r - 1; gx >= 0; gx--) border.push([gx, r - 1]);
    for (let gy = r - 2; gy >= 1; gy--) border.push([0, gy]);

    const innerStart = vi;
    for (const [gx, gy] of border) {
      const wx = hf.originX + gx * step;
      const wy = hf.originY + gy * step;
      const h = heights[gy * r + gx];
      writeVertex(vi, wx, wy, h);
      if (withUvs) {
        uvs[vi * 2] = gx / (r - 1);
        uvs[vi * 2 + 1] = gy / (r - 1);
      }
      vi++;
    }
    for (const [gx, gy] of border) {
      const wx = hf.originX + gx * step;
      const wy = hf.originY + gy * step;
      const h = heights[gy * r + gx];
      writeVertex(vi, wx, wy, h - skirt);
      if (withUvs) {
        uvs[vi * 2] = gx / (r - 1);
        uvs[vi * 2 + 1] = gy / (r - 1);
      }
      vi++;
    }
    void innerStart;
  }

  // ---- indices ------------------------------------------------------------
  const tris: number[] = [];
  for (let gy = 0; gy < r - 1; gy++) {
    for (let gx = 0; gx < r - 1; gx++) {
      const a = gy * r + gx;
      const b = a + 1;
      const c = a + r;
      const d = c + 1;
      tris.push(a, c, b, b, c, d);
    }
  }
  if (skirtRings > 0) {
    const border: Array<[number, number]> = [];
    for (let gx = 0; gx < r; gx++) border.push([gx, 0]);
    for (let gy = 1; gy < r; gy++) border.push([r - 1, gy]);
    for (let gx = r - 1; gx >= 0; gx--) border.push([gx, r - 1]);
    for (let gy = r - 2; gy >= 1; gy--) border.push([0, gy]);
    const n = border.length;
    const topStart = r * r;
    const botStart = topStart + n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const innerIdx = border[i][1] * r + border[i][0];
      const innerNext = border[j][1] * r + border[j][0];
      tris.push(innerIdx, innerNext, topStart + i);
      tris.push(topStart + i, innerNext, topStart + j);
      tris.push(topStart + i, topStart + j, botStart + i);
      tris.push(botStart + i, topStart + j, botStart + j);
    }
  }

  // ---- normals ------------------------------------------------------------
  if (withNormals) {
    computeNormals(positions, tris, normals, vertexCount);
  } else {
    for (let i = 0; i < vertexCount; i++) {
      normals[i * 3] = 0;
      normals[i * 3 + 1] = 1;
      normals[i * 3 + 2] = 0;
    }
  }

  return {
    positions,
    normals,
    uvs,
    slope,
    indices: new Uint32Array(tris),
    vertexCount,
    triangleCount: tris.length / 3,
    bounds: {
      minX: Number.isFinite(minX) ? minX : 0,
      minY: Number.isFinite(minY) ? minY : 0,
      minZ: Number.isFinite(minZ) ? minZ : 0,
      maxX: Number.isFinite(maxX) ? maxX : 0,
      maxY: Number.isFinite(maxY) ? maxY : 0,
      maxZ: Number.isFinite(maxZ) ? maxZ : 0,
    },
  };
}

function computeNormals(positions: Float32Array, tris: number[], normals: Float32Array, vertexCount: number) {
  normals.fill(0);
  for (let i = 0; i < tris.length; i += 3) {
    const ia = tris[i] * 3;
    const ib = tris[i + 1] * 3;
    const ic = tris[i + 2] * 3;
    const ax = positions[ia];
    const ay = positions[ia + 1];
    const az = positions[ia + 2];
    const e1x = positions[ib] - ax;
    const e1y = positions[ib + 1] - ay;
    const e1z = positions[ib + 2] - az;
    const e2x = positions[ic] - ax;
    const e2y = positions[ic + 1] - ay;
    const e2z = positions[ic + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const idx of [tris[i], tris[i + 1], tris[i + 2]]) {
      normals[idx * 3] += nx;
      normals[idx * 3 + 1] += ny;
      normals[idx * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < vertexCount; i++) {
    const o = i * 3;
    const len = Math.hypot(normals[o], normals[o + 1], normals[o + 2]) || 1;
    normals[o] /= len;
    normals[o + 1] /= len;
    normals[o + 2] /= len;
  }
}

/**
 * Estimate GPU/CPU memory for a tile so the LRU cache can account for it
 * (REQUIREMENT 126).
 */
export function terrainMeshBytes(m: TerrainMeshData): number {
  return (
    m.positions.byteLength +
    m.normals.byteLength +
    m.uvs.byteLength +
    m.slope.byteLength +
    m.indices.byteLength
  );
}
