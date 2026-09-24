/**
 * Panorama Maps — viewer/smooth.js
 *
 * The Smoothen feature: removes aliasing artifacts from panorama sources
 * without turning the scene into mush. What it fixes:
 *
 *  - jagged stair steps on slanted straight edges (roads, kerb lines,
 *    rooflines) produced by low-resolution or procedural sources
 *  - "poor line connection" pepper noise — single bright/dark pixels
 *    breaking otherwise continuous lines
 *
 * How: an edge-considerate 5×5 weighted average. Each neighbor's gaussian
 * weight is multiplied by a luminance-similarity factor, so across a real
 * contrast edge (building silhouette vs sky) almost nothing leaks through,
 * while stair-step artifacts along the SAME edge get averaged into a clean
 * line. Strength scales how much of the smoothed value is mixed back.
 *
 *   out = mix(original, Σ(wij · simij · pij) / Σ(wij · simij), amount)
 *
 * Applied ONCE per panorama source (cached on the cache entry) — the viewer
 * loop itself carries no extra cost per frame.
 */

/** generic weighted neighborhood filter producing a Promise (chunked by rows) */
function filterRows(src, w, h, makePixel, { chunkH = 128, onChunk = null } = {}) {
  const out = new Uint8ClampedArray(src.length);
  return new Promise((resolve) => {
    let y0 = 0;
    const step = async () => {
      const y1 = Math.min(h, y0 + chunkH);
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) makePixel(src, out, x, y, w, h);
      }
      onChunk?.(y0, y1);
      y0 = y1;
      if (y0 < h) { await new Promise((r) => setTimeout(r, 0)); step(); }
      else resolve(out);
    };
    step();
  });
}

const G1 = 1, G2 = 4, G3 = 6, G4 = 4, G5 = 1;   // 1-4-6-4-1 kernel
const GW = [G1, G2, G3, G4, G5];
const GS = 16;                                   // 1D kernel sum

/**
 * Edge-aware smooth of an RGBA buffer.
 * strength 0..1. Returns a NEW buffer, source untouched.
 */
export async function smoothBuffer(src, w, h, { strength = 0.6, onChunk = null, chunkH = 128 } = {}) {
  const k = Math.max(0, Math.min(1, strength));
  return filterRows(src, w, h, (src, out, x, y, W, H) => {
    const o0 = (y * W + x) * 4;
    const cL = src[o0];
    let numR = 0, numG = 0, numB = 0, den = 0;
    for (let j = -2; j <= 2; j++) {
      const yy = Math.min(H - 1, Math.max(0, y + j));
      const wj = GW[j + 2];
      for (let i = -2; i <= 2; i++) {
        const xx = Math.min(W - 1, Math.max(0, x + i));
        const o = (yy * W + xx) * 4;
        const dl = Math.abs(src[o] - cL);          // luminance distance (R ch prox)
        // edge guard: big difference → almost no contribution across the edge
        const sim = dl > 64 ? 0.02 : dl > 28 ? 0.25 : dl > 12 ? 0.65 : 1;
        const w = wj * GW[i + 2] * sim;            // (256 max base × sim)
        numR += src[o] * w; numG += src[o + 1] * w; numB += src[o + 2] * w;
        den += w;
      }
    }
    const sR = numR / den, sG = numG / den, sB = numB / den;
    out[o0] = src[o0] + (sR - src[o0]) * k;
    out[o0 + 1] = src[o0 + 1] + (sG - src[o0 + 1]) * k;
    out[o0 + 2] = src[o0 + 2] + (sB - src[o0 + 2]) * k;
    out[o0 + 3] = src[o0 + 3];
  }, { chunkH, onChunk });
}

/**
 * Smoothen a whole canvas (once per source, per strength).
 * @returns {Promise<HTMLCanvasElement>} new canvas, source untouched
 */
export async function smoothCanvas(srcCanvas, strength = 0.6) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const img = sctx.getImageData(0, 0, w, h);
  const out = await smoothBuffer(img.data, w, h, { strength });
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
  return c;
}

/**
 * Wrap seam care for equirectangular sources (pure buffer core).
 * The left and right columns of an equirectangular image are neighbors in
 * the 360 projection; a hard cut there reads as a razor line inside the
 * viewer. For every column within `strip` pixels of the seam we recompute
 * it as a wrap-aware 5-tap gaussian neighborhood (1-4-6-4-1), so the two
 * ends blend continuously. Columns deeper than `strip` into the image are
 * untouched, so the center stays bit-identical.
 */
export function seamBlendBuffer(data, w, h, { strip = 14 } = {}) {
  const s = Math.max(2, Math.min(strip, Math.floor(w / 8)));
  const out = new Uint8ClampedArray(data);
  const K = [1, 4, 6, 4, 1];
  const sample = (x, y, ch) => data[(y * w + ((x % w) + w) % w) * 4 + ch];
  for (let y = 0; y < h; y++) {
    for (let x = -s; x < s; x++) {
      const col = ((x % w) + w) % w;
      const o = (y * w + col) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let acc = 0;
        for (let k = -2; k <= 2; k++) acc += K[k + 2] * sample(col + k, y, ch);
        out[o + ch] = acc >> 4;
      }
    }
  }
  return out;
}

/** Canvas wrapper: softens the wrap seam of a full-resolution source. */
export function seamBlendCanvas(srcCanvas, stripPx = 14) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const ctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const out = seamBlendBuffer(img.data, w, h, { strip: stripPx });
  if (typeof ImageData !== 'undefined') { ctx.putImageData(new ImageData(out, w, h), 0, 0); return srcCanvas; }
  img.data.set(out); ctx.putImageData(img, 0, 0);
  return srcCanvas;
}
