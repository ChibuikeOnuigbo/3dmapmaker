/**
 * packages/terrain — heightfield generation (REQUIREMENT 046).
 *
 * Supports procedural, flat and heightmap (PNG16 / GeoTIFF / raw) sources,
 * plus a provider hook for streamed DEM tiles. Generation is deterministic:
 * same source + same tile = identical heights, on the main thread or in a
 * worker, which is what makes border stitching work.
 */
import { Heightfield } from './heightfield';
import { Simplex2D, fbm } from './noise';

export interface ProceduralSource {
  kind: 'procedural';
  seed: number;
  octaves: number;
  lacunarity: number;
  gain: number;
  amplitude: number;
  frequency: number;
  warp: number;
  ridged: boolean;
}

export interface FlatSource {
  kind: 'flat';
  elevation: number;
}

export interface HeightmapSource {
  kind: 'heightmap';
  url: string;
  scale: number;
  offset: number;
  noDataValue: number | null;
  format: 'png16' | 'geotiff' | 'raw';
}

export interface ProviderSource {
  kind: 'provider';
  providerId: string;
  maxZoom: number;
}

export type TerrainSource = ProceduralSource | FlatSource | HeightmapSource | ProviderSource;

export interface GenerateRequest {
  source: TerrainSource;
  resolution: number;
  size: number;
  originX: number;
  originY: number;
  /** Optional preloaded raster for heightmap sources. */
  raster?: Float32Array | null;
  rasterWidth?: number;
  rasterHeight?: number;
  /** Raster footprint in local metres. */
  rasterBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  /** Authored edits as absolute-index overrides. */
  edits?: Record<string, number>;
}

const noiseCache = new Map<number, Simplex2D>();

function noiseFor(seed: number): Simplex2D {
  let n = noiseCache.get(seed);
  if (!n) {
    n = new Simplex2D(seed);
    if (noiseCache.size > 8) noiseCache.clear();
    noiseCache.set(seed, n);
  }
  return n;
}

export function generateHeightfield(req: GenerateRequest, signal?: AbortSignal): Heightfield {
  const hf = new Heightfield(req.resolution, req.size, req.originX, req.originY);
  const r = req.resolution;
  const step = hf.step;

  switch (req.source.kind) {
    case 'flat': {
      hf.data.fill(req.source.elevation);
      break;
    }
    case 'procedural': {
      const noise = noiseFor(req.source.seed);
      const src = req.source;
      for (let gy = 0; gy < r; gy++) {
        for (let gx = 0; gx < r; gx++) {
          if (signal?.aborted) throw new DOMException('Terrain generation aborted', 'AbortError');
          const wx = req.originX + gx * step;
          const wy = req.originY + gy * step;
          // Evaluate in absolute local space so neighbouring tiles agree exactly.
          hf.data[gy * r + gx] = fbm(noise, wx, wy, src);
        }
      }
      break;
    }
    case 'heightmap': {
      if (!req.raster || !req.rasterWidth || !req.rasterHeight) {
        // Until the raster arrives the tile is a neutral plane rather than
        // garbage — see HARDENING CHECK 004 (no black/NaN gaps).
        hf.data.fill(0);
        break;
      }
      const { minX, minY, maxX, maxY } = req.rasterBounds ?? {
        minX: 0,
        minY: 0,
        maxX: req.rasterWidth,
        maxY: req.rasterHeight,
      };
      const rw = req.rasterWidth;
      const rh = req.rasterHeight;
      const scaleX = (rw - 1) / (maxX - minX || 1);
      const scaleY = (rh - 1) / (maxY - minY || 1);
      for (let gy = 0; gy < r; gy++) {
        for (let gx = 0; gx < r; gx++) {
          const wx = req.originX + gx * step;
          const wy = req.originY + gy * step;
          const fx = (wx - minX) * scaleX;
          const fy = (rh - 1) - (wy - minY) * scaleY; // rasters are row-major top-down
          const v = bilinearRaster(req.raster, rw, rh, fx, fy, req.source.noDataValue);
          hf.data[gy * r + gx] = v === null ? 0 : v * req.source.scale + req.source.offset;
        }
      }
      break;
    }
    case 'provider': {
      hf.data.fill(0);
      break;
    }
  }

  if (req.edits) hf.applyEdits(req.edits);
  return hf;
}

function bilinearRaster(
  data: Float32Array,
  w: number,
  h: number,
  fx: number,
  fy: number,
  noData: number | null,
): number | null {
  const cx = fx < 0 ? 0 : fx > w - 1 ? w - 1 : fx;
  const cy = fy < 0 ? 0 : fy > h - 1 ? h - 1 : fy;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = cx - x0;
  const ty = cy - y0;
  const v00 = data[y0 * w + x0];
  const v10 = data[y0 * w + x1];
  const v01 = data[y1 * w + x0];
  const v11 = data[y1 * w + x1];
  if (noData !== null && (v00 === noData || v10 === noData || v01 === noData || v11 === noData)) return null;
  const a = v00 + (v10 - v00) * tx;
  const b = v01 + (v11 - v01) * tx;
  return a + (b - a) * ty;
}

/** Decode a 16-bit PNG (Mapbox terrain-RGB style or plain gray16) into metres. */
export function decodeTerrainRgb(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  encoding: 'mapbox' | 'terrarium' = 'mapbox',
): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = pixels[p];
    const g = pixels[p + 1];
    const b = pixels[p + 2];
    out[i] =
      encoding === 'mapbox'
        ? -10000 + (r * 256 * 256 + g * 256 + b) * 0.1
        : r * 256 + g + b / 256 - 32768;
  }
  return out;
}

/** Decode a 16-bit grayscale buffer (GeoTIFF strip) into metres. */
export function decodeGray16(buffer: ArrayBuffer, width: number, height: number, littleEndian = true): Float32Array {
  const view = new DataView(buffer);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, littleEndian);
  return out;
}
