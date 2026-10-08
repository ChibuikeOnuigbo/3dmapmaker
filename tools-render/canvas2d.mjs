/**
 * Panorama Maps — tools-render/canvas2d.mjs
 *
 * Minimal pure-JS software Canvas2D: implements the API slice used by the
 * procedural panorama provider, so real app panoramas can be rendered in
 * Node for inspection and for feeding the OpenCV validation pipeline.
 * NOT a general canvas replacement — used only by tools-render scripts.
 */

function parseColor(str) {
  if (Array.isArray(str)) return [str[0], str[1], str[2], str[3] ?? 255];
  str = String(str).trim();
  if (str[0] === '#') {
    let h = str.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255;
    return [n >> 16 & 255, n >> 8 & 255, n & 255, a];
  }
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map(s => parseFloat(s));
    return [parts[0], parts[1], parts[2], parts.length > 3 ? Math.round(parts[3] * (parts[3] <= 1 ? 255 : 1)) : 255];
  }
  return [0, 0, 0, 255];
}

class Gradient {
  constructor(type, coords) { this.type = type; this.coords = coords; this.stops = []; }
  addColorStop(t, color) { this.stops.push([t, parseColor(color)]); this.stops.sort((a, b) => a[0] - b[0]); }
  at(t) {
    t = Math.max(0, Math.min(1, t));
    if (!this.stops.length) return [0, 0, 0, 0];
    if (t <= this.stops[0][0]) return this.stops[0][1];
    if (t >= this.stops[this.stops.length - 1][0]) return this.stops[this.stops.length - 1][1];
    for (let i = 0; i < this.stops.length - 1; i++) {
      const [t0, c0] = this.stops[i], [t1, c1] = this.stops[i + 1];
      if (t >= t0 && t <= t1) {
        const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
        return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f, c0[3] + (c1[3] - c0[3]) * f];
      }
    }
    return [0, 0, 0, 0];
  }
}

export class Canvas2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000'; this.strokeStyle = '#000';
    this.lineWidth = 1; this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.imageSmoothingEnabled = true;
    this.lineJoin = 'miter'; this.lineCap = 'butt';
    this.font = '10px sans-serif';
    this._path = []; this._subStart = null;
    this._stack = [];
  }
  createLinearGradient(x0, y0, x1, y1) { return new Gradient('linear', [x0, y0, x1, y1]); }
  createRadialGradient(x0, y0, r0, x1, y1, r1) { return new Gradient('radial', [x0, y0, r0, x1, y1, r1]); }

  save() { this._stack.push({ f: this.fillStyle, s: this.strokeStyle, lw: this.lineWidth, ga: this.globalAlpha, gco: this.globalCompositeOperation }); }
  restore() { const s = this._stack.pop(); if (s) { this.fillStyle = s.f; this.strokeStyle = s.s; this.lineWidth = s.lw; this.globalAlpha = s.ga; this.globalCompositeOperation = s.gco; } }
  translate() {} rotate() {} scale() {}
  set filter(v) {} get filter() { return 'none'; }

  get _buf() { return this.canvas._buf; }
  get _w() { return this.canvas.width; }
  get _h() { return this.canvas.height; }

  _styleColorAt(x, y) {
    const st = this.fillStyle;
    if (st instanceof Gradient) {
      if (st.type === 'linear') {
        const [x0, y0, x1, y1] = st.coords;
        const dx = x1 - x0, dy = y1 - y0;
        const L2 = dx * dx + dy * dy || 1;
        const t = ((x - x0) * dx + (y - y0) * dy) / L2;
        return st.at(t);
      }
      const [cx, cy, r0, , , r1] = st.coords;
      const d = Math.hypot(x - cx, y - cy);
      const t = r1 === r0 ? 1 : (d - r0) / (r1 - r0);
      return st.at(t);
    }
    return parseColor(st);
  }

  _blendPixel(px, idx, c, alphaMul = 1) {
    const a = (c[3] / 255) * this.globalAlpha * alphaMul;
    if (a >= 1) { px[idx] = c[0]; px[idx + 1] = c[1]; px[idx + 2] = c[2]; px[idx + 3] = 255; return; }
    px[idx] = c[0] * a + px[idx] * (1 - a);
    px[idx + 1] = c[1] * a + px[idx + 1] * (1 - a);
    px[idx + 2] = c[2] * a + px[idx + 2] * (1 - a);
    px[idx + 3] = Math.min(255, (c[3] * alphaMul + px[idx + 3] * (1 - a)));
  }

  _destOutPixel(px, idx, alpha) {
    const keep = 1 - alpha * this.globalAlpha;
    px[idx + 3] = px[idx + 3] * keep;
  }

  fillRect(x, y, w, h) {
    if (w <= 0 || h <= 0) return;
    const { _buf: px, _w: W, _h: H } = this;
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(W, Math.ceil(x + w)), y1 = Math.min(H, Math.ceil(y + h));
    if (this.fillStyle instanceof Gradient) {
      for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) {
        this._blendPixel(px, (j * W + i) * 4, this._styleColorAt(i + 0.5, j + 0.5));
      }
    } else {
      const c = parseColor(this.fillStyle);
      for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) this._blendPixel(px, (j * W + i) * 4, c);
    }
  }

  clearRect(x, y, w, h) {
    const { _buf: px, _w: W } = this;
    for (let j = Math.max(0, y | 0); j < Math.min(this._h, y + h); j++) for (let i = Math.max(0, x | 0); i < Math.min(this._w, x + w); i++) {
      const idx = (j * W + i) * 4; px[idx] = px[idx + 1] = px[idx + 2] = px[idx + 3] = 0;
    }
  }

  /* ---------- paths ---------- */
  beginPath() { this._path = []; }
  moveTo(x, y) { this._path.push(['M', x, y]); this._subStart = [x, y]; }
  lineTo(x, y) { this._path.push(['L', x, y]); }
  closePath() { if (this._subStart) this._path.push(['L', this._subStart[0], this._subStart[1]]); }
  rect(x, y, w, h) {
    this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath();
  }
  strokeRect(x, y, w, h) {
    const savedPath = this._path, savedStart = this._subStart;
    this.beginPath(); this.rect(x, y, w, h); this.stroke();
    this._path = savedPath; this._subStart = savedStart;
  }
  roundRect(x, y, w, h) { this.rect(x, y, w, h); }
  arc(cx, cy, r, a0 = 0, a1 = Math.PI * 2, ccw = false) { this.ellipse(cx, cy, r, r, 0, a0, a1, ccw); }
  ellipse(cx, cy, rx, ry, rot = 0, a0 = 0, a1 = Math.PI * 2, ccw = false) {
    let da = a1 - a0;
    if (ccw) { while (da > 0) da -= Math.PI * 2; } else { while (da < 0) da += Math.PI * 2; }
    const steps = Math.max(8, Math.min(72, Math.ceil(Math.abs(da) * Math.max(rx, ry) / 4)));
    for (let s = 0; s <= steps; s++) {
      const a = a0 + da * (s / steps);
      const x = cx + Math.cos(a) * rx, y = cy + Math.sin(a) * ry;
      s === 0 ? this.moveTo(x, y) : this.lineTo(x, y);
    }
  }

  _flatten() {
    // split into subpaths of point lists (close current on 'M')
    const subs = [];
    let cur = null;
    for (const [op, x, y] of this._path) {
      if (op === 'M') { cur = [[x, y]]; subs.push(cur); }
      else if (cur) cur.push([x, y]);
    }
    return subs.filter(s => s.length > 1);
  }

  fill() {
    // scanline even-odd fill of all subpaths
    const { _buf: px, _w: W, _h: H } = this;
    const subs = this._flatten();
    if (!subs.length) return;
    let minY = Infinity, maxY = -Infinity;
    for (const s of subs) for (const [, y] of s) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H - 1, Math.ceil(maxY));
    const isGrad = this.fillStyle instanceof Gradient;
    const solid = isGrad ? null : parseColor(this.fillStyle);
    const destOut = this.globalCompositeOperation === 'destination-out';
    for (let j = y0; j <= y1; j++) {
      const yc = j + 0.5;
      const xs = [];
      for (const s of subs) {
        for (let k = 0; k < s.length; k++) {
          const [xa, ya] = s[k], [xb, yb] = s[(k + 1) % s.length];
          if ((ya <= yc && yb > yc) || (yb <= yc && ya > yc)) {
            xs.push(xa + (yc - ya) * (xb - xa) / (yb - ya));
          }
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.round(xs[k])), xb = Math.min(W - 1, Math.round(xs[k + 1]));
        for (let i = xa; i <= xb; i++) {
          const idx = (j * W + i) * 4;
          if (destOut) { const c = solid || this._styleColorAt(i + 0.5, yc); this._destOutPixel(px, idx, c[3] / 255); }
          else this._blendPixel(px, idx, solid ?? this._styleColorAt(i + 0.5, yc));
        }
      }
    }
  }

  stroke() {
    // draw polylines as quads of width lineWidth
    const subs = this._flatten();
    const w2 = Math.max(0.5, this.lineWidth / 2);
    const saved = this.fillStyle;
    this.fillStyle = this.strokeStyle;
    for (const s of subs) {
      for (let k = 0; k + 1 < s.length; k++) {
        const [xa, ya] = s[k], [xb, yb] = s[k + 1];
        const dx = xb - xa, dy = yb - ya;
        const L = Math.hypot(dx, dy) || 1;
        const nx = -dy / L * w2, ny = dx / L * w2;
        this.beginPathSave();
        this._path = [['M', xa + nx, ya + ny], ['L', xb + nx, yb + ny], ['L', xb - nx, yb - ny], ['L', xa - nx, ya - ny]];
        this.fill();
      }
    }
    this._path = [];
    this.fillStyle = saved;
  }
  beginPathSave() { /* helper to reuse fill() without losing outer path */ }

  /* ---------- images ---------- */
  createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  getImageData(x, y, w, h) {
    const out = this.createImageData(w, h);
    const { _buf: px, _w: W } = this;
    for (let j = 0; j < h; j++) {
      const src = ((y + j) * W + x) * 4;
      out.data.set(px.subarray(src, src + w * 4), j * w * 4);
    }
    return out;
  }
  putImageData(img, x, y) {
    const { _buf: px, _w: W } = this;
    for (let j = 0; j < img.height; j++) {
      const dst = ((y + j) * W + x) * 4;
      px.set(img.data.subarray(j * img.width * 4, (j + 1) * img.width * 4), dst);
    }
  }

  drawImage(src, ...args) {
    let sx = 0, sy = 0, sw = src.width, sh = src.height;
    let dx, dy, dw, dh;
    if (args.length === 4) [dx, dy, dw, dh] = args;
    else if (args.length === 8) [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    else return;
    const srcBuf = src._buf;
    if (!srcBuf) return;
    const { _buf: dst, _w: W, _h: H } = this;
    for (let j = 0; j < dh; j++) {
      const ty = Math.floor(sy + (j / dh) * sh);
      if (ty < 0 || ty >= src.height) continue;
      const oy = Math.round(dy + j);
      if (oy < 0 || oy >= H) continue;
      for (let i = 0; i < dw; i++) {
        const tx = Math.floor(sx + (i / dw) * sw);
        if (tx < 0 || tx >= src.width) continue;
        const ox = Math.round(dx + i);
        if (ox < 0 || ox >= W) continue;
        const c = [srcBuf[(ty * src.width + tx) * 4], srcBuf[(ty * src.width + tx) * 4 + 1], srcBuf[(ty * src.width + tx) * 4 + 2], srcBuf[(ty * src.width + tx) * 4 + 3]];
        this._blendPixel(dst, (oy * W + ox) * 4, c);
      }
    }
  }

  fillText() {} measureText() { return { width: 0 }; }
  setLineDash() {}
}

export class FakeCanvas {
  constructor(w = 300, h = 150) {
    this._width = 0; this._height = 0; this._buf = null;
    this.width = w; this.height = h;
  }
  get width() { return this._width; }
  set width(v) { this._width = Math.max(1, v | 0); this._realloc(); }
  get height() { return this._height; }
  set height(v) { this._height = Math.max(1, v | 0); this._realloc(); }
  _realloc() {
    if (this._width && this._height) {
      this._buf = new Uint8ClampedArray(this._width * this._height * 4);
      delete this._ctx;                        // buffer replaced → context re-created
    }
  }
  getContext(kind) { if (kind !== '2d') return null; this._ctx ??= new Canvas2D(this); return this._ctx; }
  toBuffer() { return Buffer.from(this._buf); }
}

/** Tall/wide BMP encoder (24-bit, no lib) for tools-render output. */
export function bmpEncode(canvas) {
  const { width: w, height: h } = canvas;
  const rowSize = Math.ceil(w * 3 / 4) * 4;
  const size = 54 + rowSize * h;
  const buf = Buffer.alloc(size);
  buf.write('BM'); buf.writeUInt32LE(size, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(-h, 22); // top-down
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(rowSize * h, 34);
  const px = canvas._buf;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dst = 54 + y * rowSize + x * 3;
    const src = (y * w + x) * 4;
    buf[dst] = Math.round(px[src + 2]); buf[dst + 1] = Math.round(px[src + 1]); buf[dst + 2] = Math.round(px[src]);
  }
  return buf;
}
