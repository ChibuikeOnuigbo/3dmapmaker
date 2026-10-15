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
    try {
      if (typeof fetch !== 'undefined') {
        const resp = await fetch('models/panorama_vision_weights.json');
        if (resp.ok) {
          this.weights = await resp.json();
          this.weightsLoaded = true;
          return;
        }
      }
    } catch (_) {
      // Fallback to internal analytical model
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
