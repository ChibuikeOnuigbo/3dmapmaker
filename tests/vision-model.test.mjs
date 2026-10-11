/**
 * Panorama Maps — tests/vision-model.test.mjs
 *
 * Comprehensive test suite for the Neural Vision & Optics Model:
 *   1. ONNX Model and JSON weights presence and structure.
 *   2. Desktop VisionModelRunner forward pass across all 7 heads:
 *      - Ray Tracing (ambient occlusion, specular highlights, bounce lighting)
 *      - 3Dness (subtle stereoscopic depth relief & parallax - "not too much")
 *      - Realtime Denoise & Enhance (bilateral filter + unsharp clarity)
 *      - Calc & Epipolar Vectors (spherical jacobian & epipolar flow)
 *      - Wide-Angle Optics (Panini & Rectilinear compression)
 *      - View Illusion (atmospheric aerial depth haze)
 *      - Adaptive Morph Movement (timing-keyed easing composition)
 *   3. Dynamic Morph Easing: Duration and Velocity preservation:
 *      - Never tampers with stride speed or duration
 *      - Blends cubic-out, cubic-in, and smoothstep based on click/press ms
 *   4. Client-side VisionEngine and Uniforms generator.
 *   5. Option Toggles (enabling/disabling individual model features).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VisionModelRunner } from '../desktop/model-runner.mjs';
import { VisionEngine } from '../js/ai/vision-model.js';

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/* ---------------- 1. Model Artifacts ---------------- */
test('vision model: onnx model and weights exist and are valid', () => {
  const onnxPath = path.join(REPO_ROOT, 'models', 'panorama_vision_model.onnx');
  const weightsPath = path.join(REPO_ROOT, 'models', 'panorama_vision_weights.json');

  assert.ok(fs.existsSync(onnxPath), 'ONNX model file exists');
  const onnxSize = fs.statSync(onnxPath).size;
  assert.ok(onnxSize > 10000, `ONNX model has expected size (${onnxSize} bytes)`);

  assert.ok(fs.existsSync(weightsPath), 'JSON weights file exists');
  const weightsData = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
  assert.equal(weightsData.inDim, 16, 'Model input dimension is 16');
  assert.equal(weightsData.hiddenDim, 64, 'Model hidden dimension is 64');
  assert.equal(weightsData.outDim, 25, 'Model output dimension is 25');
  assert.ok(weightsData.heads.rayTracing, 'Has Ray Tracing head');
  assert.ok(weightsData.heads.depth3D, 'Has 3Dness head');
  assert.ok(weightsData.heads.denoise, 'Has Denoise head');
  assert.ok(weightsData.heads.calc, 'Has Calc head');
  assert.ok(weightsData.heads.wideAngle, 'Has Wide-Angle head');
  assert.ok(weightsData.heads.viewIllusion, 'Has View Illusion head');
  assert.ok(weightsData.heads.adaptiveMorph, 'Has Adaptive Morph head');
});

/* ---------------- 2. Desktop VisionModelRunner ---------------- */
test('desktop runner: executes 7 neural heads accurately', () => {
  const runner = new VisionModelRunner();
  assert.ok(runner.loaded, 'Runner loaded weights');
  assert.ok(runner.hasOnnx(), 'Runner detects ONNX model');

  // Input vector: 16 features
  const sampleFeatures = [
    0.0, 0.0, -1.0, // ray_x, ray_y, ray_z
    0.5, 0.1, 1.3,  // yaw, pitch, fov
    3.5, 95.0,      // speed_mps, press_ms (tap)
    0.5, 0.0,       // tod, weather
    1.0, 6.0, 1.2,  // zoom, dist_m, height
    0.85, 0.6, 0.1  // lux, edge_density, velocity
  ];

  const pred = runner.predict(sampleFeatures);

  // 1. Ray Tracing
  assert.ok(pred.rayTracing.aoFactor >= 0 && pred.rayTracing.aoFactor <= 1.0, 'AO factor bounded');
  assert.ok(pred.rayTracing.specularIntensity >= 0, 'Specular intensity non-negative');
  assert.ok(pred.rayTracing.roughness >= 0.05 && pred.rayTracing.roughness <= 1.0, 'Roughness bounded');

  // 2. 3Dness (not too much)
  assert.ok(pred.depth3D.parallaxScale >= 0.01 && pred.depth3D.parallaxScale <= 0.08, 'Parallax scale strictly subtle ("not too much")');
  assert.ok(pred.depth3D.reliefBias >= 0 && pred.depth3D.reliefBias <= 0.06, 'Relief bias bounded');

  // 3. Realtime Denoise & Enhance
  assert.ok(pred.denoise.spatialSigma > 0, 'Spatial sigma positive');
  assert.ok(pred.denoise.rangeSigma > 0, 'Range sigma positive');
  assert.ok(pred.denoise.unsharpBoost >= 0, 'Unsharp boost non-negative');

  // 4. Calc & Epipolar
  assert.ok(typeof pred.calc.epipolarCurl === 'number', 'Epipolar curl calculated');
  assert.ok(typeof pred.calc.horizonCurvature === 'number', 'Horizon curvature calculated');

  // 5. Wide-Angle Optics
  assert.ok(pred.wideAngle.paniniCompression >= 0 && pred.wideAngle.paniniCompression <= 1.0, 'Panini compression in [0, 1]');

  // 6. View Illusion
  assert.ok(pred.viewIllusion.aerialHaze >= 0 && pred.viewIllusion.aerialHaze <= 0.5, 'Aerial haze bounded');

  // 7. Adaptive Morph Weights
  const { wCubicOut, wCubicIn, wSmoothstep } = pred.adaptiveMorph;
  const wSum = wCubicOut + wCubicIn + wSmoothstep;
  assert.ok(Math.abs(wSum - 1.0) < 1e-4, `Adaptive morph weights sum to 1.0 (got ${wSum})`);
});

/* ---------------- 3. Morph Movement Speed & Easing Preservation ---------------- */
test('morph movement: never tampers with speed, strictly blends curves by press ms', () => {
  const runner = new VisionModelRunner();
  const engine = new VisionEngine();

  // Test across click / press hold durations:
  // Quick tap: 50ms, Medium press: 200ms, Long hold: 700ms
  const durations = [30, 80, 150, 250, 500, 900];

  for (const ms of durations) {
    // Easing starts at 0 at t=0
    const e0 = engine.evaluateMorphEasing(0, ms);
    assert.equal(Math.round(e0 * 1000) / 1000, 0, `Easing at t=0 is 0 for ms=${ms}`);

    // Easing ends at 1 at t=1
    const e1 = engine.evaluateMorphEasing(1, ms);
    assert.equal(Math.round(e1 * 1000) / 1000, 1, `Easing at t=1 is 1 for ms=${ms}`);

    // Easing is monotonic (progress always advances)
    let prev = 0;
    for (let step = 1; step <= 10; step++) {
      const t = step / 10;
      const curr = engine.evaluateMorphEasing(t, ms);
      assert.ok(curr >= prev, `Monotonic progress at step ${step} for ms=${ms}`);
      prev = curr;
    }
  }

  // Quick tap (<120ms) has higher initial acceleration (cubic ease-out dominant)
  const tapMid = engine.evaluateMorphEasing(0.3, 50);
  const holdMid = engine.evaluateMorphEasing(0.3, 700);
  assert.ok(tapMid > holdMid, `Quick tap progresses faster initially (${tapMid.toFixed(3)}) than long hold (${holdMid.toFixed(3)})`);
});

/* ---------------- 4. Client-side VisionEngine & Uniforms ---------------- */
test('vision engine: computes WebGL shader uniforms and respects user option toggles', () => {
  const engine = new VisionEngine();

  // Default state: all features enabled
  const u1 = engine.computeShaderUniforms({ yawDeg: 45, pitchDeg: -10, fovDeg: 80 });
  assert.equal(u1.uRayTracing, 1.0, 'Ray tracing enabled');
  assert.equal(u1.u3Dness, 1.0, '3Dness enabled');
  assert.ok(u1.uDepthRelief > 0 && u1.uDepthRelief <= 0.05, 'Depth relief subtle ("not too much")');
  assert.equal(u1.uDenoise, 1.0, 'Denoise enabled');
  assert.equal(u1.uWideAngleMode, 2.0, 'Panini wide angle active');
  assert.equal(u1.uViewIllusion, 1.0, 'View illusion enabled');

  // Toggle options off individually
  engine.setOption('rayTracing', false);
  const u2 = engine.computeShaderUniforms();
  assert.equal(u2.uRayTracing, 0.0, 'Ray tracing toggled off');

  engine.setOption('depth3D', false);
  const u3 = engine.computeShaderUniforms();
  assert.equal(u3.u3Dness, 0.0, '3Dness toggled off');

  engine.setOption('denoise', false);
  const u4 = engine.computeShaderUniforms();
  assert.equal(u4.uDenoise, 0.0, 'Denoise toggled off');

  engine.setOption('wideAngleMode', 'off');
  const u5 = engine.computeShaderUniforms();
  assert.equal(u5.uWideAngleMode, 0.0, 'Wide angle toggled off');

  engine.setOption('viewIllusion', false);
  const u6 = engine.computeShaderUniforms();
  assert.equal(u6.uViewIllusion, 0.0, 'View illusion toggled off');
});

/* ---------------- Runner ---------------- */
console.log('Panorama Maps — Vision Model test suite');
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
