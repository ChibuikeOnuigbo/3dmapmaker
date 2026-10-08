/**
 * Panorama Maps — gen/util.js — deterministic RNG + perceptual hash. (Spec §30, §71)
 */

/** FNV-1a string hash → uint32. */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG. */
export function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic RNG keyed by arbitrary strings (world id, node id, feature id). */
export function rngFor(...keys) { return seededRng(hashStr(keys.join('|'))); }

/**
 * 16×16 average-hash (aHash) of a luminance grid → hex string.
 * @param {number[]} lum gray values length 256 (16×16, row-major)
 */
export function aHash16(lum) {
  let sum = 0; for (let i = 0; i < 256; i++) sum += lum[i];
  const avg = sum / 256;
  let bits = '';
  for (let i = 0; i < 256; i++) bits += lum[i] > avg ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 256; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** Hamming distance between two equal-length hex hash strings. */
export function hammingHex(a, b) {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/**
 * Downsample an RGBA buffer to a 16×16 luminance grid (pure; testable).
 */
export function luminanceGrid16(data, width, height) {
  const out = new Array(256);
  const cw = width / 16, ch = height / 16;
  for (let gy = 0; gy < 16; gy++) {
    for (let gx = 0; gx < 16; gx++) {
      const x = Math.min(width - 1, Math.floor((gx + 0.5) * cw));
      const y = Math.min(height - 1, Math.floor((gy + 0.5) * ch));
      const i = (y * width + x) * 4;
      out[gy * 16 + gx] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
  }
  return out;
}

/**
 * RGB histogram (pure; testable). @param {Uint8ClampedArray} data RGBA
 * @param {number} binsPerChannel (default 4 → 64 bins)
 */
export function rgbHist(data, stride = 4, binsPerChannel = 4) {
  const hist = new Float64Array(binsPerChannel ** 3);
  let n = 0;
  for (let i = 0; i < data.length; i += 4 * stride) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const bin = (r * binsPerChannel / 256 | 0) * binsPerChannel * binsPerChannel
      + (g * binsPerChannel / 256 | 0) * binsPerChannel
      + (b * binsPerChannel / 256 | 0);
    hist[bin]++; n++;
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= n;
  return hist;
}

/** Histogram intersection similarity in [0, 1]. */
export function histIntersect(hA, hB) {
  let s = 0;
  for (let i = 0; i < hA.length; i++) s += Math.min(hA[i], hB[i]);
  return s;
}

/**
 * Distance-aware expected-change model (Spec §27–§28): the minimum histogram
 * similarity acceptable for `distanceMeters` of movement. 1 m ≈ identical,
 * 500 m allows a major but explainable change.
 */
export function expectedMinSimilarity(distanceMeters) {
  return Math.max(0.18, 0.95 - distanceMeters / 900);
}

/** Content hash (sha-256) helper for assets — returns hex. */
export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
