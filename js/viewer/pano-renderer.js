/**
 * Panorama Maps — viewer/pano-renderer.js
 *
 * Minimal WebGL renderer for equirectangular panoramas. Renders a fullscreen
 * triangle; the fragment shader reconstructs the view ray, rotates it by
 * yaw/pitch and samples the panorama. Two texture slots + a mix uniform give
 * crossfade (never-black) transitions (Spec §58).
 *
 * World convention: 3D X = East, Y = Up, Z = South, so North = -Z.
 * Bearing β (deg, 0 = North) maps to equirect u = (β + 180) / 360 — this is
 * the SAME convention the procedural generator paints with. Per-node heading
 * metadata shifts u by headingDeg/360 (Spec §5 camera metadata).
 *
 * Falls back to a simple Canvas2D crop renderer when WebGL is unavailable.
 */

const VERT = `
attribute vec2 aPos;
varying vec2 vNdc;
void main(){ vNdc = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
varying vec2 vNdc;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uHasB;      // 0/1
uniform float uMix;       // 0 = A, 1 = B
uniform float uYaw;       // radians
uniform float uPitch;     // radians
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uZoom;      // transition dolly feel: 1 = neutral
uniform float uHeadA;     // per-node heading offsets, radians
uniform float uHeadB;
const float PI = 3.141592653589793;

vec3 viewRay(){
  float t = uTanHalfFov * uZoom;
  vec3 right   = vec3(cos(uYaw), 0.0, sin(uYaw));
  vec3 fwdH    = vec3(sin(uYaw), 0.0, -cos(uYaw));
  vec3 up      = vec3(0.0, 1.0, 0.0);
  vec3 fwd  = fwdH * cos(uPitch) + up * sin(uPitch);
  vec3 upv  = up * cos(uPitch) - fwdH * sin(uPitch);
  return normalize(right * (vNdc.x * t * uAspect) + upv * (vNdc.y * t) + fwd);
}

vec2 eqUv(vec3 d, float head){
  float bearing = atan(d.x, -d.z);            // 0 at North, +East
  float u = fract(bearing / (2.0 * PI) + 0.5 - head / (2.0 * PI));
  float v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI;
  return vec2(u, v);
}

void main(){
  vec3 dir = viewRay();
  vec4 a = texture2D(uTexA, eqUv(dir, uHeadA));
  vec4 b = texture2D(uTexB, eqUv(dir, uHeadB));
  gl_FragColor = mix(a, b, uMix * uHasB);
}
`;

export class PanoRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.headA = 0; this.headB = 0;
    this._initGL();
  }

  _initGL() {
    const gl = this.canvas.getContext('webgl', { antialias: true, alpha: false })
      || this.canvas.getContext('experimental-webgl');
    if (!gl) { this.gl = null; this._fallback2d = this.canvas.getContext('2d'); return; }
    this.gl = gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('[renderer] shader error:', gl.getShaderInfoLog(s));
        this.gl = null; this._fallback2d = this.canvas.getContext('2d'); return null;
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[renderer] link error:', gl.getProgramInfoLog(prog));
      this.gl = null; this._fallback2d = this.canvas.getContext('2d'); return;
    }
    gl.useProgram(prog);
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const name of ['uTexA', 'uTexB', 'uHasB', 'uMix', 'uYaw', 'uPitch', 'uTanHalfFov', 'uAspect', 'uZoom', 'uHeadA', 'uHeadB']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    gl.uniform1i(this.u.uTexA, 0);
    gl.uniform1i(this.u.uTexB, 1);
    this.texA = this._makeTex();
    this.texB = this._makeTex();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texB);
    // neutral starting texture so the screen is never black
    const neutral = new Uint8Array([24, 28, 34, 255]);
    for (const t of [this.texA, this.texB]) this._uploadTo(t, null, neutral);
    this.ok = true;
  }

  _makeTex() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _uploadTo(tex, unit, source) {
    const gl = this.gl;
    gl.activeTexture(unit === 1 ? gl.TEXTURE1 : gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (source instanceof Uint8Array) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
  }

  /** Load panorama image (canvas | ImageBitmap | HTMLImageElement) into slot A. */
  setImageA(source, headingDeg = 0) { if (this.gl) this._uploadTo(this.texA, 0, source); this.imgA = source; this.headA = headingDeg * Math.PI / 180; }
  setImageB(source, headingDeg = 0) { if (this.gl) this._uploadTo(this.texB, 1, source); this.imgB = source; this.headB = headingDeg * Math.PI / 180; }
  /** Transition finished: make B the new base image. */
  promoteBtoA() {
    if (this.gl && this.imgB) this._uploadTo(this.texA, 0, this.imgB);
    this.imgA = this.imgB; this.headA = this.headB;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    if (this.gl) this.gl.viewport(0, 0, w, h);
  }

  /**
   * @param {object} s {yawDeg, pitchDeg, fovDeg, mix (0..1), hasB (bool), zoom}
   */
  render(s) {
    if (!this.gl) { this._render2dFallback(s); return; }
    const gl = this.gl;
    gl.uniform1f(this.u.uYaw, s.yawDeg * Math.PI / 180);
    gl.uniform1f(this.u.uPitch, s.pitchDeg * Math.PI / 180);
    gl.uniform1f(this.u.uTanHalfFov, Math.tan((s.fovDeg * Math.PI / 180) / 2));
    gl.uniform1f(this.u.uAspect, this.canvas.width / Math.max(1, this.canvas.height));
    gl.uniform1f(this.u.uMix, s.mix ?? 0);
    gl.uniform1f(this.u.uHasB, s.hasB ? 1 : 0);
    gl.uniform1f(this.u.uZoom, s.zoom ?? 1);
    gl.uniform1f(this.u.uHeadA, this.headA);
    gl.uniform1f(this.u.uHeadB, this.headB);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* Coarse 2D fallback: draws a perspective-cropped window of the panorama. */
  _render2dFallback(s) {
    const ctx = this._fallback2d;
    if (!ctx || !this.imgA || !(this.imgA.width > 1)) { ctx && (ctx.fillStyle = '#181c22', ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)); return; }
    const img = this.imgA;
    const W = this.canvas.width, H = this.canvas.height;
    const yawN = (((s.yawDeg % 360) + 360) % 360) / 360;
    const winW = img.width * (s.fovDeg / 360) * 1.15;
    let x = img.width * (0.5 + yawN - 0.5) - winW / 2 + img.width * (this.headA / (2 * Math.PI));
    const vFrac = Math.min(0.95, (s.fovDeg * (W / Math.max(1, H))) / 180);
    const winH = img.height * vFrac * 0.75;
    const y = img.height * (0.5 - vFrac * 0.375) - (s.pitchDeg / 180) * img.height;
    ctx.fillStyle = '#181c22'; ctx.fillRect(0, 0, W, H);
    x = ((x % img.width) + img.width) % img.width;
    if (x + winW <= img.width) ctx.drawImage(img, x, y, winW, winH, 0, 0, W, H);
    else {
      const w1 = img.width - x;
      const frac = w1 / winW;
      ctx.drawImage(img, x, y, w1, winH, 0, 0, W * frac, H);
      ctx.drawImage(img, 0, y, winW - w1, winH, W * frac, 0, W * (1 - frac), H);
    }
  }
}

/** Equirect painting helper shared with the generator: bearing → u fraction. */
export function bearingToU(bearingDeg) {
  let b = ((bearingDeg % 360) + 360) % 360;
  return (b - 180 < 0 ? b + 180 : b - 180) / 360;
}
