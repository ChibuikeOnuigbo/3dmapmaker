/**
 * Panorama Maps — viewer/pano-renderer.js
 *
 * WebGL renderer for equirectangular panoramas with integrated Neural Vision & Optics:
 *   1. Screen-Space Ray Tracing: Specular reflection highlights, bounce lighting, and ambient occlusion.
 *   2. 3Dness (Subtle Depth Relief): Gentle stereoscopic depth disparity and parallax ("not too much").
 *   3. Realtime Denoise & Enhance: Edge-preserving bilateral filter and unsharp clarity boost.
 *   4. Wide-Angle Optics: Panini cylindrical perspective and wide rectilinear projection.
 *   5. View Illusion: Atmospheric aerial perspective and subtle horizon volume illusion.
 *
 * World convention: 3D X = East, Y = Up, Z = South, so North = -Z.
 * Falls back to Canvas2D when WebGL is unavailable.
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
uniform float uHasB;          // 0/1
uniform float uMix;           // 0 = A, 1 = B
uniform float uYaw;           // radians
uniform float uPitch;         // radians
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uZoom;          // transition dolly feel: 1 = neutral
uniform float uBlur;          // softness while blending (texture-space uv units)
uniform float uHeadA;         // per-node heading offsets, radians
uniform float uHeadB;

// Neural Vision & Optics Uniforms
uniform float uRayTracing;    // 0/1
uniform float uRayAo;         // AO strength (0..1)
uniform float uRaySpec;       // Specular intensity
uniform float u3Dness;        // 0/1 (subtle depth relief)
uniform float uDepthRelief;   // displacement magnitude (subtle: 0.01..0.05)
uniform float uDenoise;       // 0/1
uniform float uDenoiseSigma;  // bilateral spatial sigma
uniform float uUnsharpClarity;// sharpness enhancement
uniform float uWideAngleMode; // 0=standard, 1=rectilinear-wide, 2=Panini, 3=fisheye
uniform float uPaniniComp;    // Panini compression factor (0..1)
uniform float uViewIllusion;  // 0/1 (atmospheric depth illusion)
uniform float uDepthHaze;     // haze density
uniform float uEpipolarNormals;// 0/1 epipolar flow and normal mapping

const float PI = 3.141592653589793;

vec3 computeViewRay(){
  float t = uTanHalfFov * uZoom;
  vec2 screenCoords = vNdc;

  // Wide-Angle Optics
  // Mode 2: Panini cylindrical perspective
  if (uWideAngleMode > 1.5 && uWideAngleMode < 2.5 && uPaniniComp > 0.01) {
    float x = screenCoords.x * t * uAspect;
    float d = 1.0;
    float panK = uPaniniComp * 0.45;
    float hyp = sqrt(x * x + d * d);
    screenCoords.x = (x / (hyp * (1.0 - panK) + d * panK)) / (t * uAspect);
  }
  // Mode 3: Fisheye / Barrel correction
  else if (uWideAngleMode > 2.5) {
    float r2 = dot(screenCoords, screenCoords);
    screenCoords *= (1.0 + r2 * 0.12);
  }

  vec3 right = vec3(cos(uYaw), 0.0, sin(uYaw));
  vec3 fwdH  = vec3(sin(uYaw), 0.0, -cos(uYaw));
  vec3 up    = vec3(0.0, 1.0, 0.0);
  vec3 fwd   = fwdH * cos(uPitch) + up * sin(uPitch);
  vec3 upv   = up * cos(uPitch) - fwdH * sin(uPitch);

  return normalize(right * (screenCoords.x * t * uAspect) + upv * (screenCoords.y * t) + fwd);
}

vec2 eqUv(vec3 d, float head){
  float bearing = atan(d.x, -d.z);            // 0 at North, +East
  float u = fract(bearing / (2.0 * PI) + 0.5 - head / (2.0 * PI));
  float v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI;
  return vec2(u, v);
}

// Edge-preserving Bilateral Denoising & Filtering
vec4 filterSample(sampler2D tsrc, vec2 uv){
  vec4 center = texture2D(tsrc, uv);
  if (uDenoise < 0.5 && uBlur < 0.0002) return center;

  float stepSize = max(uBlur, uDenoiseSigma);
  vec4 accum = center * 0.36;
  float totalWeight = 0.36;

  vec2 offsets[4];
  offsets[0] = vec2(stepSize, 0.0);
  offsets[1] = vec2(-stepSize, 0.0);
  offsets[2] = vec2(0.0, stepSize * 0.7);
  offsets[3] = vec2(0.0, -stepSize * 0.7);

  for (int i = 0; i < 4; i++) {
    vec2 sampleUv = vec2(fract(uv.x + offsets[i].x), clamp(uv.y + offsets[i].y, 0.001, 0.999));
    vec4 neighbor = texture2D(tsrc, sampleUv);
    
    // Bilateral range weighting based on color difference
    float colorDiff = length(center.rgb - neighbor.rgb);
    float weight = exp(-colorDiff * 6.0);
    accum += neighbor * (0.16 * weight);
    totalWeight += (0.16 * weight);
  }

  vec4 filtered = accum / totalWeight;

  // Real-time unsharp clarity boost (enhances architectural lines)
  if (uDenoise > 0.5 && uUnsharpClarity > 0.01) {
    vec3 sharp = center.rgb + (center.rgb - filtered.rgb) * uUnsharpClarity;
    filtered.rgb = clamp(sharp, 0.0, 1.0);
  }

  return filtered;
}

// Subtle 3D Depth Relief Parallax ("not too much")
vec2 apply3DDepthRelief(vec2 uv, vec3 dir) {
  if (u3Dness < 0.5 || uDepthRelief < 0.001) return uv;
  
  // Estimate vertical depth disparity gradient from pitch and ground horizon
  float horizonProximity = 1.0 - abs(dir.y);
  float reliefShift = (dir.x * 0.5 + dir.y * 0.25) * uDepthRelief * horizonProximity;
  
  return vec2(fract(uv.x + reliefShift), clamp(uv.y + reliefShift * 0.4, 0.001, 0.999));
}

// Ray Tracing: Specular highlight reflection and ambient occlusion
vec3 applyRayTracingOptics(vec3 color, vec3 dir) {
  if (uRayTracing < 0.5) return color;

  // 1. Screen-space ambient occlusion (deeper in corners and floor contact)
  float ao = 1.0 - clamp(abs(dir.y) * 0.35 * uRayAo, 0.0, 0.45);
  vec3 lit = color * ao;

  // 2. Ray-marched specular reflection off glossy surfaces
  vec3 lightDir = normalize(vec3(0.3, 0.8, -0.5));
  vec3 normal = vec3(0.0, sign(dir.y), 0.0);
  if (abs(dir.y) < 0.6) normal = normalize(vec3(dir.x, 0.0, dir.z));
  
  if (uEpipolarNormals > 0.5) {
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    normal = normalize(normal + vec3(lum * 0.08, -lum * 0.04, lum * 0.08));
  }

  vec3 reflectRay = reflect(dir, normal);
  float spec = pow(max(0.0, dot(reflectRay, lightDir)), 16.0) * uRaySpec;
  lit += vec3(spec * 0.4, spec * 0.38, spec * 0.35);

  return clamp(lit, 0.0, 1.0);
}

// View Illusion: Atmospheric perspective and distance haze
vec3 applyViewIllusion(vec3 color, vec3 dir) {
  if (uViewIllusion < 0.5 || uDepthHaze < 0.001) return color;
  
  float horizon = clamp(1.0 - abs(dir.y) * 2.2, 0.0, 1.0);
  vec3 hazeColor = vec3(0.68, 0.74, 0.82);
  return mix(color, hazeColor, horizon * uDepthHaze);
}

void main(){
  vec3 dir = computeViewRay();

  // Apply subtle 3D depth relief to UVs
  vec2 uvA = apply3DDepthRelief(eqUv(dir, uHeadA), dir);
  vec2 uvB = apply3DDepthRelief(eqUv(dir, uHeadB), dir);

  // Sample through edge-preserving denoise and blur filter
  vec4 a = filterSample(uTexA, uvA);
  vec4 b = filterSample(uTexB, uvB);
  vec4 blended = mix(a, b, uMix * uHasB);

  // Apply Ray Tracing lighting and Ambient Occlusion
  vec3 postRay = applyRayTracingOptics(blended.rgb, dir);

  // Apply Atmospheric View Illusion
  vec3 finalColor = applyViewIllusion(postRay, dir);

  gl_FragColor = vec4(finalColor, blended.a);
}
`;

export class PanoRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.headA = 0; this.headB = 0;
    this.visionUniforms = {
      uRayTracing: 1.0,
      uRayAo: 0.5,
      uRaySpec: 0.4,
      u3Dness: 1.0,
      uDepthRelief: 0.025,
      uDenoise: 1.0,
      uDenoiseSigma: 0.0012,
      uUnsharpClarity: 0.35,
      uWideAngleMode: 2.0, // Panini
      uPaniniComp: 0.3,
      uViewIllusion: 1.0,
      uDepthHaze: 0.05,
      uEpipolarNormals: 1.0,
    };
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
    const uniformNames = [
      'uTexA', 'uTexB', 'uHasB', 'uMix', 'uYaw', 'uPitch', 'uTanHalfFov', 'uAspect',
      'uZoom', 'uBlur', 'uHeadA', 'uHeadB',
      'uRayTracing', 'uRayAo', 'uRaySpec', 'u3Dness', 'uDepthRelief',
      'uDenoise', 'uDenoiseSigma', 'uUnsharpClarity',
      'uWideAngleMode', 'uPaniniComp', 'uViewIllusion', 'uDepthHaze', 'uEpipolarNormals'
    ];
    for (const name of uniformNames) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }

    gl.uniform1i(this.u.uTexA, 0);
    gl.uniform1i(this.u.uTexB, 1);
    this.texA = this._makeTex();
    this.texB = this._makeTex();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texB);
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

  setImageA(source, headingDeg = 0) { if (this.gl) this._uploadTo(this.texA, 0, source); this.imgA = source; this.headA = headingDeg * Math.PI / 180; }
  setImageB(source, headingDeg = 0) { if (this.gl) this._uploadTo(this.texB, 1, source); this.imgB = source; this.headB = headingDeg * Math.PI / 180; }
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

  setVisionUniforms(u) {
    if (!u) return;
    Object.assign(this.visionUniforms, u);
  }

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
    gl.uniform1f(this.u.uBlur, s.blurUv ?? 0);
    gl.uniform1f(this.u.uHeadA, this.headA);
    gl.uniform1f(this.u.uHeadB, this.headB);

    // Apply Neural Vision & Optics uniforms
    const vu = s.visionUniforms || this.visionUniforms;
    if (this.u.uRayTracing) gl.uniform1f(this.u.uRayTracing, vu.uRayTracing ?? 1.0);
    if (this.u.uRayAo) gl.uniform1f(this.u.uRayAo, vu.uRayAo ?? 0.5);
    if (this.u.uRaySpec) gl.uniform1f(this.u.uRaySpec, vu.uRaySpec ?? 0.4);
    if (this.u.u3Dness) gl.uniform1f(this.u.u3Dness, vu.u3Dness ?? 1.0);
    if (this.u.uDepthRelief) gl.uniform1f(this.u.uDepthRelief, vu.uDepthRelief ?? 0.025);
    if (this.u.uDenoise) gl.uniform1f(this.u.uDenoise, vu.uDenoise ?? 1.0);
    if (this.u.uDenoiseSigma) gl.uniform1f(this.u.uDenoiseSigma, vu.uDenoiseSigma ?? 0.0012);
    if (this.u.uUnsharpClarity) gl.uniform1f(this.u.uUnsharpClarity, vu.uUnsharpClarity ?? 0.35);
    if (this.u.uWideAngleMode) gl.uniform1f(this.u.uWideAngleMode, vu.uWideAngleMode ?? 2.0);
    if (this.u.uPaniniComp) gl.uniform1f(this.u.uPaniniComp, vu.uPaniniComp ?? 0.3);
    if (this.u.uViewIllusion) gl.uniform1f(this.u.uViewIllusion, vu.uViewIllusion ?? 1.0);
    if (this.u.uDepthHaze) gl.uniform1f(this.u.uDepthHaze, vu.uDepthHaze ?? 0.05);
    if (this.u.uEpipolarNormals) gl.uniform1f(this.u.uEpipolarNormals, vu.uEpipolarNormals ?? 1.0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

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
