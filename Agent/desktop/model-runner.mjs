/**
 * Panorama Maps — desktop/model-runner.mjs
 *
 * Neural Vision & Optics Model Runner for the Desktop and Node environment.
 * Loads and executes the multi-task trained Panorama Vision Model.
 * Supports:
 *   - Direct forward pass from exported weights (0 dependencies)
 *   - ONNX Runtime execution if available
 *   - 7 Neural Heads:
 *       1. Ray Tracing (ambient occlusion, specular intensity, bounce gain, roughness)
 *       2. 3Dness / Depth Relief (subtle parallax scale, depth relief bias, clipping)
 *       3. Realtime Denoise & Enhance (bilateral spatial, bilateral range, unsharp boost, contrast lift)
 *       4. Calc & Epipolar Vectors (epipolar curl, horizon curvature, spherical jacobian, irradiance flux)
 *       5. Wide-Angle Optics (rectilinear k1, panini compression, barrel compensation)
 *       6. View Illusion (aerial haze, micro wobble, depth shift)
 *       7. Adaptive Morph Movement (cubic ease out, cubic ease in, smoothstep weights, dynamic exponent)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Canonical artifacts live in Agent/models (this file's parent folder).
const MODELS_DIR = process.env.PM_MODEL_ROOT || path.resolve(__dirname, '..', 'models');
const WEIGHTS_PATH = path.join(MODELS_DIR, 'panorama_vision_weights.json');
const ONNX_PATH = path.join(MODELS_DIR, 'panorama_vision_model.onnx');

export class VisionModelRunner {
  constructor(weightsPath = WEIGHTS_PATH, onnxPath = ONNX_PATH) {
    this.weightsPath = weightsPath;
    this.onnxPath = onnxPath;
    this.loaded = false;
    this.modelData = null;
    this._loadWeights();
  }

  _loadWeights() {
    if (fs.existsSync(this.weightsPath)) {
      const raw = fs.readFileSync(this.weightsPath, 'utf8');
      this.modelData = JSON.parse(raw);
      this.loaded = true;
    }
  }

  hasOnnx() {
    return fs.existsSync(this.onnxPath);
  }

  /**
   * Run forward inference on a 16-element feature vector.
   * @param {number[]} features 16 input features
   * @returns {object} structured outputs from all 7 heads
   */
  predict(features) {
    if (!this.loaded || !this.modelData) {
      throw new Error(`VisionModelRunner: weights file not loaded from ${this.weightsPath}`);
    }

    const { inDim, hiddenDim, outDim, weights, heads } = this.modelData;
    if (features.length < inDim) {
      const padded = new Array(inDim).fill(0);
      for (let i = 0; i < features.length; i++) padded[i] = features[i];
      features = padded;
    }

    const { W1, B1, W2, B2, W3, B3 } = weights;

    // Layer 1: Gemm + LeakyReLU(0.05)
    const z1 = new Float32Array(hiddenDim);
    const a1 = new Float32Array(hiddenDim);
    for (let j = 0; j < hiddenDim; j++) {
      let sum = B1[j];
      for (let i = 0; i < inDim; i++) {
        sum += features[i] * W1[i][j];
      }
      z1[j] = sum;
      a1[j] = sum > 0 ? sum : sum * 0.05;
    }

    // Layer 2: Gemm + LeakyReLU(0.05) + Residual (0.5 * a1)
    const z2 = new Float32Array(hiddenDim);
    const a2 = new Float32Array(hiddenDim);
    for (let j = 0; j < hiddenDim; j++) {
      let sum = B2[j];
      for (let i = 0; i < hiddenDim; i++) {
        sum += a1[i] * W2[i][j];
      }
      z2[j] = sum;
      const act = sum > 0 ? sum : sum * 0.05;
      a2[j] = act + a1[j] * 0.5;
    }

    // Layer 3: Output Gemm
    const rawOut = new Float32Array(outDim);
    for (let j = 0; j < outDim; j++) {
      let sum = B3[j];
      for (let i = 0; i < hiddenDim; i++) {
        sum += a2[i] * W3[i][j];
      }
      rawOut[j] = sum;
    }

    // Unpack into named heads
    const parseHead = (spec) => {
      const res = {};
      for (let i = 0; i < spec.size; i++) {
        res[spec.names[i]] = rawOut[spec.offset + i];
      }
      return res;
    };

    const rayTracing = parseHead(heads.rayTracing);
    const depth3D = parseHead(heads.depth3D);
    const denoise = parseHead(heads.denoise);
    const calc = parseHead(heads.calc);
    const wideAngle = parseHead(heads.wideAngle);
    const viewIllusion = parseHead(heads.viewIllusion);
    const adaptiveMorph = parseHead(heads.adaptiveMorph);

    // Ensure non-negative and normalize so sum === 1.0 (velocity-preserving guarantee)
    const wOutRaw = Math.max(0.01, adaptiveMorph.w_cubic_out);
    const wInRaw = Math.max(0.01, adaptiveMorph.w_cubic_in);
    const wSSRaw = Math.max(0.01, adaptiveMorph.w_smoothstep);
    const wTotal = wOutRaw + wInRaw + wSSRaw;
    adaptiveMorph.w_cubic_out = wOutRaw / wTotal;
    adaptiveMorph.w_cubic_in = wInRaw / wTotal;
    adaptiveMorph.w_smoothstep = wSSRaw / wTotal;

    return {
      raw: Array.from(rawOut),
      rayTracing: {
        aoFactor: Math.max(0.0, Math.min(1.0, rayTracing.ao_factor)),
        specularIntensity: Math.max(0.0, rayTracing.specular_intensity),
        lightBounceGain: Math.max(0.0, rayTracing.light_bounce_gain),
        roughness: Math.max(0.05, Math.min(1.0, rayTracing.roughness)),
      },
      depth3D: {
        // Bound subtle parallax strictly between 0.01 and 0.08 ("not too much")
        parallaxScale: Math.max(0.01, Math.min(0.08, depth3D.subtle_parallax_scale)),
        reliefBias: Math.max(0.0, Math.min(0.06, depth3D.depth_relief_bias)),
        depthClipping: Math.min(1.0, Math.max(0.8, depth3D.depth_clipping)),
      },
      denoise: {
        spatialSigma: Math.max(0.5, Math.min(4.0, denoise.bilateral_spatial)),
        rangeSigma: Math.max(0.02, Math.min(0.3, denoise.bilateral_range)),
        unsharpBoost: Math.max(0.0, Math.min(1.0, denoise.unsharp_boost)),
        contrastLift: Math.max(0.9, Math.min(1.3, denoise.contrast_lift)),
      },
      calc: {
        epipolarCurl: calc.epipolar_curl,
        horizonCurvature: calc.horizon_curvature,
        sphericalJacobian: calc.spherical_jacobian,
        irradianceFlux: calc.irradiance_flux,
      },
      wideAngle: {
        rectilinearK1: wideAngle.rectilinear_k1,
        paniniCompression: Math.max(0.0, Math.min(1.0, wideAngle.panini_compression)),
        barrelCompensation: wideAngle.fov_barrel_compensation,
      },
      viewIllusion: {
        aerialHaze: Math.max(0.0, Math.min(0.5, viewIllusion.aerial_haze)),
        microWobble: Math.max(0.0, Math.min(0.04, viewIllusion.micro_wobble)),
        depthShift: Math.max(0.0, Math.min(0.03, viewIllusion.depth_shift)),
      },
      adaptiveMorph: {
        wCubicOut: adaptiveMorph.w_cubic_out,
        wCubicIn: adaptiveMorph.w_cubic_in,
        wSmoothstep: adaptiveMorph.w_smoothstep,
        dynamicExponent: Math.max(1.5, Math.min(4.0, adaptiveMorph.dynamic_exp)),
      },
    };
  }

  /**
   * Computes the blended easing progress at normalized time t in [0, 1]
   * based on the keypress duration in milliseconds.
   * Speed and duration are never modified; only the easing curve blend adapts.
   */
  evaluateEasing(t, pressMs) {
    const dummyFeatures = new Array(16).fill(0);
    dummyFeatures[7] = pressMs;
    const pred = this.predict(dummyFeatures);
    const { wCubicOut, wCubicIn, wSmoothstep } = pred.adaptiveMorph;

    // 1. Cubic ease-out: 1 - (1 - t)^3
    const eOut = 1 - Math.pow(1 - t, 3);
    // 2. Cubic ease-in: t^3
    const eIn = Math.pow(t, 3);
    // 3. Smoothstep: 3*t^2 - 2*t^3
    const eSS = t * t * (3 - 2 * t);

    // Composite blend: sum of weights is 1.0, so at t=0 result is 0, at t=1 result is 1.0
    return wCubicOut * eOut + wCubicIn * eIn + wSmoothstep * eSS;
  }
}

// CLI Runner
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const runner = new VisionModelRunner();
  console.log('=== Panorama Vision & Optics Model Runner (Desktop CLI) ===');
  console.log(`Weights file: ${runner.weightsPath} (loaded: ${runner.loaded})`);
  console.log(`ONNX model:   ${runner.onnxPath} (exists: ${runner.hasOnnx()})`);

  // Sample test run with quick tap (80ms)
  const tapPred = runner.predict([0, 0, -1, 0, 0, 1.3, 3.5, 80, 0.5, 0, 1.0, 5.0, 1.2, 0.8, 0.5, 0.2]);
  console.log('\n--- Prediction (Quick Tap 80ms) ---');
  console.log('Ray Tracing:', tapPred.rayTracing);
  console.log('3Dness (Subtle):', tapPred.depth3D);
  console.log('Denoise & Enhance:', tapPred.denoise);
  console.log('Wide Angle Optics:', tapPred.wideAngle);
  console.log('View Illusion:', tapPred.viewIllusion);
  console.log('Adaptive Morph Weights:', tapPred.adaptiveMorph);
  console.log('Easing curve at t=0.5:', runner.evaluateEasing(0.5, 80).toFixed(4));

  // Sample test run with sustained hold (600ms)
  const holdPred = runner.predict([0, 0, -1, 0, 0, 1.3, 3.5, 600, 0.5, 0, 1.0, 5.0, 1.2, 0.8, 0.5, 0.2]);
  console.log('\n--- Prediction (Sustained Hold 600ms) ---');
  console.log('Adaptive Morph Weights:', holdPred.adaptiveMorph);
  console.log('Easing curve at t=0.5:', runner.evaluateEasing(0.5, 600).toFixed(4));
}
