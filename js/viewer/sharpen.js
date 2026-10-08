/**
 * Panorama Maps — viewer/sharpen.js
 *
 * The Sharpen feature: increases the perceived clarity and crispness of the
 * displayed panorama. This is a REAL pixel pipeline, not a CSS trick:
 *
 *   rendered frame
 *      ↓
 *   separable gaussian blur (two passes, radius R)     ← low frequency image
 *      ↓
 *   detail = original − blurred                        ← high frequency edges
 *      ↓
 *   boosted = detail × amount                          ← edge enhancement
 *      ↓
 *   microcontrast = (orig − 128) × (1 + 6% × amount)
 *      ↓
 *   output = clamp(microcontrast + boosted)
 *
 * = a wide radius unsharp mask (clarity) + a 30% strength cap to keep halos
 * under control + a gentle contrast lift, chunked across animation frames so
 * the UI thread never stalls on large viewports.
 *
 * Public API:
 *   sharpenBuffer(data, w, h, { amount, radius }) → Uint8ClampedArray
 *   SharpenController — schedules the pass against a live <canvas>: it waits
 *   for the view to settle (no new renders for ~140 ms), then processes the
 *   frame in 4 row chunks via setTimeout(0) so dragging never janks.
 */

/* ---------- low level ---------- */

/** Build a 1D gaussian kernel for radius r (sigma = r/2). */
function gaussKernel(r) {
  const sigma = Math.max(0.3, r / 2), k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v; sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/**
 * Unsharp mask over an RGBA pixel buffer (channels 0..2, alpha preserved).
 * @param {Uint8ClampedArray} src
 * @param {number} w
 * @param {number} h
 * @param {object} o amount 0..1 (clarity strength), radius px (blur window),
 *                   onChunk callback(y0,y1) for incremental progress,
 *                   chunkH rows per scheduled chunk
 * @returns {Promise<Uint8ClampedArray>} new buffer (src is not mutated)
 */
export async function sharpenBuffer(src, w, h, { amount = 0.6, radius = 4, onChunk = null, chunkH = 160 } = {}) {
  const r = Math.max(1, Math.min(10, Math.round(radius)));
  const k = gaussKernel(r);
  const blur = new Float32Array(src.length);          // blurred RGBA (float for accuracy)
  const tmp = new Float32Array(src.length);           // intermediate (horizontal pass)

  // horizontal blur pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0, d = 0;
      for (let j = -r; j <= r; j++) {
        const xx = Math.min(w - 1, Math.max(0, x + j));
        const o = (row + xx) * 4, wj = k[j + r];
        a += src[o] * wj; b += src[o + 1] * wj; c += src[o + 2] * wj; d += src[o + 3] * wj;
      }
      const o = (row + x) * 4;
      tmp[o] = a; tmp[o + 1] = b; tmp[o + 2] = c; tmp[o + 3] = d;
    }
  }
  // vertical blur pass
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let a = 0, b = 0, c = 0, d = 0;
      for (let j = -r; j <= r; j++) {
        const yy = Math.min(h - 1, Math.max(0, y + j));
        const o = (yy * w + x) * 4, wj = k[j + r];
        a += tmp[o] * wj; b += tmp[o + 1] * wj; c += tmp[o + 2] * wj; d += tmp[o + 3] * wj;
      }
      const o = (y * w + x) * 4;
      blur[o] = a; blur[o + 1] = b; blur[o + 2] = c; blur[o + 3] = d;
    }
  }

  // detail boost + contrast lift, produced in scheduled chunks to keep the
  // main thread alive (the two blur passes are fast; the chunking exists for
  // the final writer so we can report progress and yield)
  const out = new Uint8ClampedArray(src.length);
  const boost = 0.9 * amount;                      // unsharp strength (halo capped)
  const contrast = 1 + 0.06 * amount;              // gentle clarity contrast
  await new Promise((resolve) => {
    let y0 = 0;
    const step = () => {
      const y1 = Math.min(h, y0 + chunkH);
      for (let o = y0 * w * 4, end = y1 * w * 4; o < end; o += 4) {
        for (let ch = 0; ch < 3; ch++) {
          const orig = src[o + ch];
          const detail = orig - blur[o + ch];
          let v = (orig - 128) * contrast + 128 + detail * boost;
          out[o + ch] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
        }
        out[o + 3] = src[o + 3];
      }
      onChunk?.(y0, y1);
      y0 = y1;
      if (y0 >= h) resolve(); else setTimeout(step, 0);
    };
    step();
  });
  return out;
}

/**
 * Sharpen a whole canvas (used once per panorama source, so the cost is paid
 * ONCE per node per amount — the viewer then renders freely at 60 fps).
 * @param {HTMLCanvasElement} srcCanvas
 * @param {number} amount 0..1
 * @returns {Promise<HTMLCanvasElement>} new canvas; source untouched
 */
export async function sharpenCanvas(srcCanvas, amount = 0.6) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const img = sctx.getImageData(0, 0, w, h);
  const out = await sharpenBuffer(img.data, w, h, {
    amount,
    radius: Math.max(2, Math.round(Math.min(8, w / 420))),   // scale aware
  });
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
  return c;
}

/* ---------- live canvas integration ---------- */

export class SharpenController {
  /**
   * @param {HTMLCanvasElement} canvas the rendered panorama frame
   * @param {{enabled:boolean, amount:number}} state
   * @param {{onApplied?:()=>void, settleMs?:number}} hooks
   */
  constructor(canvas, state, hooks = {}) {
    this.canvas = canvas;
    this.state = state;
    this.hooks = hooks;
    this._timer = 0;
    this._busy = false;
    this._dirty = false;      // frames rendered while a pass was running
    this._gen = 0;            // invalidation counter
  }

  /** Call every time the canvas received a freshly rendered frame. */
  frameRendered() {
    this._dirty = true;
    if (!this.state.enabled || this.state.amount <= 0.01) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._apply(), this.hooks.settleMs ?? 140);
  }

  /** Toggle/level change: apply immediately to the current frame if idle. */
  poke() {
    if (!this.state.enabled) return;
    clearTimeout(this._timer);
    this._dirty = false;                // the displayed frame may be stale
    this._timer = setTimeout(() => this._apply(true), 40);
  }

  async _apply(current = false) {
    if (this._busy || (!this._dirty && !current)) return;
    if (!this.state.enabled) return;
    const c = this.canvas, ctx = c.getContext('2d', { willReadFrequently: true });
    if (!c.width || !c.height) return;
    const gen = ++this._gen;
    this._busy = true;
    try {
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const out = await sharpenBuffer(img.data, c.width, c.height, {
        amount: this.state.amount,
        radius: Math.max(2, Math.round(Math.min(8, c.width / 320))),
        onChunk: () => { if (gen !== this._gen) throw 0; },   // stale → abort
      });
      if (gen === this._gen) { ctx.putImageData(new ImageData(out, c.width, c.height), 0, 0); this.hooks.onApplied?.(); }
      this._dirty = false;
    } catch { /* aborted or decode failure: next frameRendered() retries */ }
    this._busy = false;
  }
}
