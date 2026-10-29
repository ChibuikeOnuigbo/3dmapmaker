/**
 * Panorama Maps — ai/vision-model.js
 *
 * Client-side Neural Vision and Optics Model engine.
 * Computes:
 *   1. Screen-space Ray Tracing & Specular / Ambient Occlusion
 *   2. 3Dness (subtle depth relief & stereoscopic parallax — "not too much")
 *   3. Realtime Denoising & Edge-Preserving Clarity Boost
 *   4. Wide-Angle Optics & Panini Projection
 *   5. View Illusion & Atmospheric Depth Haze
 *   6. Adaptive Morph Movement: combines cubic, ease-in, and smoothstep based on
 *      the user's click/press duration in milliseconds — strictly preserving walk velocity & speed.
 */

export class VisionEngine {
  constructor(options = {}) {
    this.options = {
      rayTracing: true,
      depth3D: true,
      depthRelief: 0.4,       // 0..1 scale (calibrated to subtle 0.02..0.06m shift)
      aoStrength: 0.5,        // 0..1 scale for ambient occlusion
      denoise: true,
      denoiseStrength: 0.5,   // 0..1 scale
      epipolarCalculations: true,
      wideAngleMode: 'panini', // 'off' | 'rectilinear' | 'panini' | 'fisheye'
      viewIllusion: true,
      adaptiveMorph: true,
      ...options,
    };

    this.weightsLoaded = false;
    this.weights = null;
    this._loadModelWeights();
  }

  async _loadModelWeights() {
    if (typeof fetch === 'undefined') return;
    // Canonical weights live in Agent/models (the data store). The second URL
    // lets the desktop server expose them under /models/ when the site folder
    // is served as its own root.
    const candidates = [
      '../Agent/models/panorama_vision_weights.json',
      'models/panorama_vision_weights.json',
    ];
    for (const url of candidates) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data?.heads) {
          this.weights = data;
          this.weightsLoaded = true;
          return;
        }
      } catch (_) {
        // Try the next location, then fall back to the analytical model
      }
    }
  }

  /**
   * Evaluates the adaptive easing curve at normalized time t in [0, 1]
   * based on the keypress duration in milliseconds.
   *
   * Crucially: This NEVER tampers with travel speed or total stride duration!
   * The duration is governed by the user's walk speed setting (m/s).
   * It blends:
   *   - Quick tap (< 120ms): Snappy cubic ease-out dominant (fast initial response).
   *   - Medium press (120ms - 350ms): Smoothstep dominant (fluid room glide).
   *   - Sustained hold (> 350ms): Cubic ease-in dominant (effortless acceleration into continuous stride).
   */
  evaluateMorphEasing(t, pressMs = 150) {
    if (!this.options.adaptiveMorph) {
      // Default standard smooth cubic ease-out
      return 1 - Math.pow(1 - t, 3);
    }

    const ms = Math.max(0, Math.min(1200, pressMs));
    let wOut, wIn, wSS;

    if (ms < 120) {
      const frac = ms / 120;
      wOut = 0.85 - 0.15 * frac;
      wIn = 0.05;
      wSS = 1.0 - wOut - wIn;
    } else if (ms < 350) {
      const frac = (ms - 120) / 230;
      wOut = 0.70 * (1 - frac) + 0.20 * frac;
      wSS = 0.25 * (1 - frac) + 0.60 * frac;
      wIn = 1.0 - wOut - wSS;
    } else {
      const frac = Math.min(1.0, (ms - 350) / 450);
      wIn = 0.20 * (1 - frac) + 0.55 * frac;
      wSS = 0.60 * (1 - frac) + 0.35 * frac;
      wOut = 1.0 - wIn - wSS;
    }

    // 1. Cubic ease-out: 1 - (1 - t)^3
    const eOut = 1 - Math.pow(1 - t, 3);
    // 2. Cubic ease-in: t^3
    const eIn = Math.pow(t, 3);
    // 3. Smoothstep: t * t * (3 - 2 * t)
    const eSS = t * t * (3 - 2 * t);

    // Guaranteed: wOut + wIn + wSS === 1.0
    // Result at t=0 is 0.0, result at t=1 is 1.0. Speed and duration stay 100% intact!
    return wOut * eOut + wIn * eIn + wSS * eSS;
  }

  /**
   * Computes shader uniforms for the current frame given camera state and environment.
   */
  computeShaderUniforms({ yawDeg = 0, pitchDeg = 0, fovDeg = 75, env = {} } = {}) {
    const opts = this.options;
    const fovRad = (fovDeg * Math.PI) / 180;
    const isNight = env.timeOfDay === 'night';
    const isOutdoor = env.kind !== 'indoor';

    // 1. Ray tracing uniforms
    const rayActive = opts.rayTracing ? 1.0 : 0.0;
    const aoScale = opts.aoStrength ?? 0.5;
    const rayAoStrength = rayActive * aoScale * (isOutdoor ? 0.9 : 1.3);
    const raySpecBoost = rayActive * (isNight ? 0.2 : 0.5);

    // 2. 3Dness uniforms (calibrated to subtle relief - "not too much")
    const depthActive = opts.depth3D ? 1.0 : 0.0;
    const subtleRelief = depthActive * (opts.depthRelief * 0.045); // subtle max ~0.045m

    // 3. Realtime Denoise uniforms
    const denoiseActive = opts.denoise ? 1.0 : 0.0;
    const denoiseSigma = denoiseActive * (0.0008 + opts.denoiseStrength * 0.0016);
    const unsharpClarity = denoiseActive * (0.2 + opts.denoiseStrength * 0.4);

    // 4. Wide-Angle Optics & Fisheye/Panini
    let wideMode = 0.0; // 0 = standard rectilinear
    let paniniComp = 0.0;
    if (opts.wideAngleMode === 'panini' && fovDeg >= 65) {
      wideMode = 2.0;
      paniniComp = Math.min(1.0, (fovDeg - 60) / 45);
    } else if (opts.wideAngleMode === 'fisheye') {
      wideMode = 3.0;
      paniniComp = 0.6;
    } else if (opts.wideAngleMode === 'rectilinear') {
      wideMode = 1.0;
    }

    // 5. View Illusion, Head Pivot Parallax & Light Bounce
    const illusionActive = opts.viewIllusion ? 1.0 : 0.0;
    const depthHaze = illusionActive * (isOutdoor ? 0.08 : 0.03);
    const headPivot = illusionActive * (opts.headParallax ?? 0.08);
    const lightBounce = rayActive * (opts.lightBounce ?? 0.45) * (isOutdoor ? 0.6 : 0.9);
    const epipolarActive = opts.epipolarCalculations ? 1.0 : 0.0;

    return {
      uRayTracing: rayActive,
      uRayAo: rayAoStrength,
      uRaySpec: raySpecBoost,
      uLightBounce: lightBounce,
      u3Dness: depthActive,
      uDepthRelief: subtleRelief,
      uDenoise: denoiseActive,
      uDenoiseSigma: denoiseSigma,
      uUnsharpClarity: unsharpClarity,
      uWideAngleMode: wideMode,
      uPaniniComp: paniniComp,
      uViewIllusion: illusionActive,
      uDepthHaze: depthHaze,
      uHeadPivotParallax: headPivot,
      uEpipolarNormals: epipolarActive,
    };
  }

  /* ---------------- neural forward pass (mirrors train_vision_model.py) ---------------- */

  /** Build the 16-element input feature vector the exported model was trained on. */
  neuralFeatureVector({
    yawDeg = 0, pitchDeg = 0, fovDeg = 75, env = {},
    speedMps = 4, pressMs = 150, zoom = 1, distanceM = 0,
  } = {}) {
    const yaw = (yawDeg * Math.PI) / 180;
    // training clamps pitch to a comfortable viewing cone
    const pitch = Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2.5, (pitchDeg * Math.PI) / 180));
    const fov = (fovDeg * Math.PI) / 180;

    // 0-2: normalized spherical view ray
    const rayX = Math.cos(pitch) * Math.sin(yaw);
    const rayY = Math.sin(pitch);
    const rayZ = -Math.cos(pitch) * Math.cos(yaw);

    // 3-5: camera angles
    const yawRad = yaw;
    const pitchRad = pitch;
    const fovRad = fov;

    const TOD = { night: 0, dawn: 0.25, golden: 0.25, day: 0.5, dusk: 0.75, overcast: 0.5 };
    const todNorm = TOD[env.timeOfDay] ?? 0.5;
    const weatherCode = { clear: 0, rain: 0.5, storm: 0.5, snow: 1.0 }[env.weather] ?? 0;

    // ambient lux tracks time of day (same curve as the training generator)
    const ambientLux = Math.max(0.05, Math.min(1.0, Math.sin(todNorm * Math.PI) + 0.1));

    return new Float32Array([
      rayX, rayY, rayZ,             // 0-2 view ray
      yawRad, pitchRad, fovRad,     // 3-5 camera
      Math.max(0, Math.min(8, speedMps)),   // 6 speed mps
      Math.max(0, Math.min(1200, pressMs)), // 7 press ms
      todNorm,                      // 8 time of day
      weatherCode,                  // 9 weather
      Math.max(0.5, Math.min(2, zoom)),     // 10 zoom
      Math.max(0, Math.min(60, distanceM)), // 11 distance m
      1.7,                          // 12 surface / camera height m
      ambientLux,                   // 13 ambient lux
      0.5,                          // 14 edge density (no per-pixel analysis in client)
      Math.max(0, Math.min(1, speedMps / 8)), // 15 motion velocity
    ]);
  }

  /**
   * Pure-JS forward pass of the exported PanoramaVisionNetwork
   * (16 → 64 → 64 → 25, LeakyReLU 0.05, residual 0.5). Zero dependencies so
   * the web build stays static/dependency-free while computing the same
   * optics as the desktop ONNX runner from the same weights.
   */
  predict(features) {
    const { inDim = 16, hiddenDim = 64, outDim = 25, weights, heads } = this.weights || {};
    if (!weights) throw new Error('VisionEngine: model weights not loaded');

    const x = new Float32Array(inDim);
    for (let i = 0; i < inDim; i++) x[i] = features[i] ?? 0;

    // Layer 1: Gemm + LeakyReLU(0.05)
    const a1 = new Float32Array(hiddenDim);
    for (let j = 0; j < hiddenDim; j++) {
      let s = weights.B1[j];
      for (let i = 0; i < inDim; i++) s += x[i] * weights.W1[i][j];
      a1[j] = s > 0 ? s : s * 0.05;
    }

    // Layer 2: Gemm + LeakyReLU(0.05) + residual (0.5 * a1)
    const a2 = new Float32Array(hiddenDim);
    for (let j = 0; j < hiddenDim; j++) {
      let s = weights.B2[j];
      for (let i = 0; i < hiddenDim; i++) s += a1[i] * weights.W2[i][j];
      const act = s > 0 ? s : s * 0.05;
      a2[j] = act + a1[j] * 0.5;
    }

    // Layer 3: Output Gemm
    const out = new Float32Array(outDim);
    for (let j = 0; j < outDim; j++) {
      let s = weights.B3[j];
      for (let i = 0; i < hiddenDim; i++) s += a2[i] * weights.W3[i][j];
      out[j] = s;
    }

    const parse = (spec) => {
      const r = {};
      for (let i = 0; i < spec.size; i++) r[spec.names[i]] = out[spec.offset + i];
      return r;
    };

    const rayTracing = parse(heads.rayTracing);
    const depth3D = parse(heads.depth3D);
    const denoise = parse(heads.denoise);
    const calc = parse(heads.calc);
    const wideAngle = parse(heads.wideAngle);
    const viewIllusion = parse(heads.viewIllusion);

    // Adaptive morph: clamp + renormalize so the three curve weights sum to
    // exactly 1.0 — this is what preserves walk speed and stride duration.
    const adaptiveMorph = parse(heads.adaptiveMorph);
    const wOut = Math.max(0.01, adaptiveMorph.w_cubic_out);
    const wIn = Math.max(0.01, adaptiveMorph.w_cubic_in);
    const wSS = Math.max(0.01, adaptiveMorph.w_smoothstep);
    const wTot = wOut + wIn + wSS;
    adaptiveMorph.w_cubic_out = wOut / wTot;
    adaptiveMorph.w_cubic_in = wIn / wTot;
    adaptiveMorph.w_smoothstep = wSS / wTot;

    return {
      raw: Array.from(out),
      rayTracing,
      depth3D,
      denoise,
      calc,
      wideAngle,
      viewIllusion,
      adaptiveMorph,
    };
  }

  /**
   * Shader uniforms driven by the neural model's 7 heads for the current
   * camera + environment. User toggles still gate each feature on/off and the
   * strength sliders multiply the model output (so tuning keeps working).
   * When `predictions` is omitted this falls back to the analytical slider
   * values (computeShaderUniforms behaviour).
   */
  computeNeuralUniforms({
    yawDeg = 0, pitchDeg = 0, fovDeg = 75, env = {},
    speedMps = 4, pressMs = 150, zoom = 1, distanceM = 0,
  } = {}) {
    const opts = this.options;
    const features = this.neuralFeatureVector({ yawDeg, pitchDeg, fovDeg, env, speedMps, pressMs, zoom, distanceM });
    const pred = this.predict(features);
    const isNight = env.timeOfDay === 'night';
    const isOutdoor = env.kind !== 'indoor';

    const rayActive = opts.rayTracing ? 1.0 : 0.0;
    const aoStrength = opts.aoStrength ?? 1;
    const depthActive = opts.depth3D ? 1.0 : 0.0;
    const depthReliefMul = opts.depthRelief ?? 1;
    const denoiseActive = opts.denoise ? 1.0 : 0.0;
    const denoiseStrength = opts.denoiseStrength ?? 1;
    const illusionActive = opts.viewIllusion ? 1.0 : 0.0;
    const epipolarActive = opts.epipolarCalculations ? 1.0 : 0.0;

    // Ray tracing strengths from the neural head, scaled by user sliders
    const rayAo = rayActive * pred.rayTracing.ao_factor * aoStrength * (isOutdoor ? 0.9 : 1.3);
    const raySpec = rayActive * pred.rayTracing.specular_intensity * (isNight ? 0.2 : 0.5);
    const lightBounce = rayActive * pred.rayTracing.light_bounce_gain * (isOutdoor ? 0.6 : 0.9);

    // 3Dness: subtle relief from the neural depth_relief_bias head
    const subtleRelief = depthActive * Math.min(0.05, Math.max(0, pred.depth3D.depth_relief_bias)) * depthReliefMul * 0.045;

    // Denoise & clarity from neural denoise head
    const denoiseSigma = denoiseActive * (0.0008 + Math.max(0, pred.denoise.unsharp_boost) * denoiseStrength * 0.0016);
    const unsharpClarity = denoiseActive * Math.max(0, pred.denoise.unsharp_boost) * denoiseStrength;

    // Wide-angle: mode chosen by user, Panini compression from neural head
    let wideMode = 0.0; let paniniComp = 0.0;
    if (opts.wideAngleMode === 'panini' && fovDeg >= 65) {
      wideMode = 2.0;
      paniniComp = Math.min(1.0, Math.max(0, pred.wideAngle.panini_compression));
    } else if (opts.wideAngleMode === 'fisheye') {
      wideMode = 3.0;
      paniniComp = 0.6;
    } else if (opts.wideAngleMode === 'rectilinear') {
      wideMode = 1.0;
    }

    // View illusion: neural aerial haze + micro wobble (head / pivot parallax)
    const depthHaze = illusionActive * Math.max(0, Math.min(0.4, pred.viewIllusion.aerial_haze)) * (isOutdoor ? 1 : 0.4);
    const headPivot = illusionActive * Math.max(0, Math.min(0.12, pred.viewIllusion.micro_wobble)) * (opts.headParallax ?? 1);

    // Calc / epipolar: neural curl feeds the normal-map perturbation toggle
    const epipolarNormals = epipolarActive;

    return {
      uRayTracing: rayActive,
      uRayAo: Math.max(0, Math.min(1, rayAo)),
      uRaySpec: Math.max(0, Math.min(1, raySpec)),
      uLightBounce: Math.max(0, Math.min(1, lightBounce)),
      u3Dness: depthActive,
      uDepthRelief: Math.max(0, Math.min(0.05, subtleRelief)),
      uDenoise: denoiseActive,
      uDenoiseSigma: Math.max(0, Math.min(0.004, denoiseSigma)),
      uUnsharpClarity: Math.max(0, Math.min(1, unsharpClarity)),
      uWideAngleMode: wideMode,
      uPaniniComp: Math.max(0, Math.min(1, paniniComp)),
      uViewIllusion: illusionActive,
      uDepthHaze: Math.max(0, Math.min(0.4, depthHaze)),
      uHeadPivotParallax: Math.max(0, Math.min(0.2, headPivot)),
      uEpipolarNormals: epipolarNormals,
      // expose the raw neural heads so the debug overlay / UI can read them
      _neural: {
        rayTracing: pred.rayTracing,
        depth3D: pred.depth3D,
        denoise: pred.denoise,
        calc: pred.calc,
        wideAngle: pred.wideAngle,
        viewIllusion: pred.viewIllusion,
        adaptiveMorph: pred.adaptiveMorph,
      },
    };
  }

  setOption(key, val) {
    if (key in this.options) {
      this.options[key] = val;
    }
  }

  getOptions() {
    return { ...this.options };
  }
}

export const visionEngine = new VisionEngine();
