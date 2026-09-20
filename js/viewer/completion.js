/**
 * Panorama Maps — viewer/completion.js
 *
 * "AutoComplete Panorama" (Spec §45–§58). Detects incomplete equirectangular
 * regions (missing sky / missing floor strips), completes them with
 * edge-extension + blur + feathered seams, and derives pitch limits so the
 * viewer never shows a broken edge (with soft mouse resistance).
 *
 * The analysis functions are pure (Uint8ClampedArray in, report out) so they
 * run under Node in the test-suite too.
 */

/** Row statistics: luminance mean+stddev and alpha ratio (0..1). */
export function rowStats(data, width, y, stride = 1) {
  let sum = 0, sumSq = 0, alphaSum = 0, n = 0;
  const off = y * width * 4;
  for (let x = 0; x < width; x += stride) {
    const i = off + x * 4;
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += l; sumSq += l * l; alphaSum += data[i + 3] / 255; n++;
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)), alpha: alphaSum / n };
}

/**
 * Detect missing top/bottom bands.
 * A row is "missing" when it is BOTH near-uniform AND (near-black OR
 * transparent). A genuinely dark night sky (low but textured variance) is
 * not flagged — contextual thresholds (Spec §47).
 *
 * @param {Uint8ClampedArray} data RGBA pixels
 * @returns {{topMissingPct:number, bottomMissingPct:number, pitchMaxDeg:number,
 *           pitchMinDeg:number, complete:boolean}}
 */
export function detectMissingRegions(data, width, height, opts = {}) {
  const blackLum = opts.blackLum ?? 14;
  const uniformStd = opts.uniformStd ?? 6;
  const minAlpha = opts.minAlpha ?? 0.6;
  const maxScan = Math.floor(height * 0.25);   // never flag more than a quarter
  const stride = Math.max(1, Math.floor(width / 256));

  const isMissing = (y) => {
    const s = rowStats(data, width, y, stride);
    return s.std < uniformStd && (s.mean < blackLum || s.alpha < minAlpha);
  };

  let topRows = 0;
  while (topRows < maxScan && isMissing(topRows)) topRows++;
  let bottomRows = 0;
  while (bottomRows < maxScan && isMissing(height - 1 - bottomRows)) bottomRows++;

  const topMissingPct = (topRows / height) * 100;
  const bottomMissingPct = (bottomRows / height) * 100;

  // Equirect: full height maps 180°. Content edges → pitch limits, with a
  // small safety margin so the seam itself always stays out of view.
  const pitchMaxDeg = 90 - (topMissingPct / 100) * 180 - 2;
  const pitchMinDeg = -90 + (bottomMissingPct / 100) * 180 + 2;

  return {
    topMissingPct, bottomMissingPct, topRows, bottomRows,
    pitchMaxDeg: Math.min(88, pitchMaxDeg), pitchMinDeg: Math.max(-88, pitchMinDeg),
    complete: topRows === 0 && bottomRows === 0,
  };
}

/**
 * Complete a panorama canvas in-place–copy: stretches the nearest valid rows
 * into the missing bands, blurs the fills, feathers the seams (Spec §48–§50).
 * Where data is insufficient we blur rather than invent geometry (Spec §50).
 *
 * @param {HTMLCanvasElement} src
 * @param {{topRows:number, bottomRows:number}} report
 * @returns {HTMLCanvasElement} new canvas (src untouched)
 */
export function completePanorama(src, report) {
  const w = src.width, h = src.height;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);

  const blurPx = Math.max(10, Math.round(h * 0.02));
  const fillBand = (missingRows, isTop) => {
    if (missingRows <= 0) return;
    const ySrc = isTop ? missingRows : h - missingRows - 1;
    const bandH = Math.min(24, h - missingRows - 1);
    const yDst = isTop ? 0 : h - missingRows;
    // 1) stretch the nearest valid band into the gap
    ctx.drawImage(src, 0, ySrc, w, bandH, 0, yDst, w, missingRows + 2);
    // 2) blur the filled region only (temporary canvas keeps blur contained)
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = missingRows + blurPx * 2;
    tmp.getContext('2d').drawImage(out, 0, Math.max(0, yDst - blurPx), w, tmp.height, 0, 0, w, tmp.height);
    ctx.save();
    ctx.filter = `blur(${blurPx}px)`;
    ctx.drawImage(tmp, 0, Math.max(0, yDst - blurPx));
    ctx.restore();
    // 3) feathered seam: alpha gradient of the *unblurred* edge over the blur
    const grad = ctx.createLinearGradient(0, yDst + missingRows - 10, 0, yDst + missingRows + 18);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = grad;
    ctx.fillRect(0, yDst + missingRows - 10, w, 28);
    ctx.restore();
    ctx.drawImage(src, 0, ySrc + (isTop ? 0 : -10), w, 28, 0, yDst + missingRows - 10, w, 28);
  };

  fillBand(report.topRows, true);
  fillBand(report.bottomRows, false);
  return out;
}

/** Seam quality check (Spec §57): max channel delta across the seam rows. */
export function seamDelta(data, width, seamY) {
  let maxDelta = 0;
  for (let x = 0; x < width; x++) {
    const a = (seamY * width + x) * 4, b = ((seamY + 1) * width + x) * 4;
    for (let c = 0; c < 3; c++) maxDelta = Math.max(maxDelta, Math.abs(data[a + c] - data[b + c]));
  }
  return maxDelta;
}

/**
 * Soft-resistance pitch clamp (Spec §52, §53).
 * Inside limits: raw passes through. Beyond limits: the user feels a heavy
 * spring — overdrag decays back each frame instead of a hard freeze.
 *
 * @param {number} rawDeg       unclamped pitch from input accumulation
 * @param {{min:number, max:number}} limits
 * @param {number} dtMs         frame delta
 * @returns {{pitch:number, overdrag:number, limited:boolean}}
 */
export function softClampPitch(rawDeg, limits, dtMs) {
  const clamped = Math.min(limits.max, Math.max(limits.min, rawDeg));
  const over = rawDeg - clamped;
  if (over === 0) return { pitch: rawDeg, overdrag: 0, limited: false };
  // allow a resilient peek of max ±14°, decaying with an exponential spring
  const decay = Math.exp(-dtMs / 180);
  const residual = over * decay;
  const capped = Math.sign(residual) * Math.min(Math.abs(residual), 14);
  return { pitch: clamped + capped * 0.22, overdrag: capped, limited: true };
}
