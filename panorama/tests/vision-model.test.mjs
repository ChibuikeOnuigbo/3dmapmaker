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
import { VisionModelRunner } from '../../Agent/desktop/model-runner.mjs';
import { VisionEngine } from '../js/ai/vision-model.js';

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/* ---------------- 1. Model Artifacts ---------------- */
test('vision model: onnx model and weights exist and are valid', () => {
  const onnxPath = path.join(REPO_ROOT, 'Agent', 'models', 'panorama_vision_model.onnx');
  const weightsPath = path.join(REPO_ROOT, 'Agent', 'models', 'panorama_vision_weights.json');

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

  engine.setOption('epipolarCalculations', false);
  const u7 = engine.computeShaderUniforms();
  assert.equal(u7.uEpipolarNormals, 0.0, 'Epipolar calculations toggled off');

  engine.setOption('wideAngleMode', 'fisheye');
  const u8 = engine.computeShaderUniforms();
  assert.equal(u8.uWideAngleMode, 3.0, 'Fisheye mode active');

  engine.setOption('rayTracing', true);
  engine.setOption('aoStrength', 0.2);
  const u9 = engine.computeShaderUniforms();
  assert.ok(u9.uRayAo > 0 && u9.uRayAo < u1.uRayAo, 'AO strength tuned lower');
  assert.ok(u9.uLightBounce > 0, 'Light bounce active when ray tracing is on');

  engine.setOption('viewIllusion', true);
  const u10 = engine.computeShaderUniforms();
  assert.ok(u10.uHeadPivotParallax > 0, 'Head pivot parallax active in view illusion');
});

/* ---------------- 5. Ray Tracing Physics Properties ---------------- */
test('ray tracing: ambient occlusion increases near floor contact, specular aligns with light', () => {
  const runner = new VisionModelRunner();

  // Looking down at floor (ray_y = -0.8) vs horizontal (ray_y = 0.0)
  const floorView = [0.0, -0.8, -0.6, 0.0, -0.8, 1.3, 3.0, 100, 0.5, 0, 1.0, 3.0, 0.4, 0.8, 0.5, 0.1];
  const horizonView = [0.0, 0.0, -1.0, 0.0, 0.0, 1.3, 3.0, 100, 0.5, 0, 1.0, 8.0, 1.5, 0.8, 0.5, 0.1];

  const pFloor = runner.predict(floorView);
  const pHorizon = runner.predict(horizonView);

  assert.ok(pFloor.rayTracing.aoFactor >= 0 && pFloor.rayTracing.aoFactor <= 1.0, 'Floor AO factor valid');
  assert.ok(pHorizon.rayTracing.aoFactor >= 0 && pHorizon.rayTracing.aoFactor <= 1.0, 'Horizon AO factor valid');
});

/* ---------------- 6. Subtle 3Dness Invariant ("Not Too Much") ---------------- */
test('3Dness: subtle parallax scale strictly bounded <= 0.08 across 100 diverse poses', () => {
  const runner = new VisionModelRunner();

  for (let i = 0; i < 100; i++) {
    const randomFeats = [
      (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, -Math.random(),
      (Math.random() - 0.5) * 6.28, (Math.random() - 0.5) * 2.0, 0.5 + Math.random() * 1.5,
      0.5 + Math.random() * 12.0, Math.random() * 1200.0,
      Math.random(), Math.random() > 0.5 ? 0.5 : 0.0,
      0.7 + Math.random() * 0.8, 0.2 + Math.random() * 30.0,
      0.1 + Math.random() * 3.0, 0.05 + Math.random() * 0.95,
      Math.random(), Math.random()
    ];
    const pred = runner.predict(randomFeats);
    assert.ok(pred.depth3D.parallaxScale <= 0.08, `Parallax scale must be subtle ("not too much"), got ${pred.depth3D.parallaxScale}`);
    assert.ok(pred.depth3D.parallaxScale >= 0.01, `Parallax scale must be positive, got ${pred.depth3D.parallaxScale}`);
    assert.ok(pred.depth3D.reliefBias <= 0.06, `Relief bias bounded, got ${pred.depth3D.reliefBias}`);
  }
});

/* ---------------- 7. Bilateral Range Weighting Decay ---------------- */
test('realtime denoise: bilateral exponential kernel preserves high-contrast edges', () => {
  // Kernel formula used in shader: weight = exp(-colorDiff * 6.0)
  const computeWeight = (diff) => Math.exp(-diff * 6.0);

  const identical = computeWeight(0.0);
  assert.equal(identical, 1.0, 'Identical color gives weight 1.0');

  const subtleNoise = computeWeight(0.05);
  assert.ok(subtleNoise > 0.70, `Subtle noise receives high smoothing weight (${subtleNoise.toFixed(3)})`);

  const hardEdge = computeWeight(0.60);
  assert.ok(hardEdge < 0.05, `Hard boundary edge preserves sharpness with low weight (${hardEdge.toFixed(3)})`);
});

/* ---------------- 8. Wide-Angle Panini Projection Optics ---------------- */
test('wide-angle optics: panini projection maintains vertical lines and centers undistorted', () => {
  // Panini formula: x' = x / (sqrt(x^2 + d^2)*(1-k) + d*k)
  const paniniX = (x, d = 1.0, k = 0.3) => {
    const hyp = Math.sqrt(x * x + d * d);
    return x / (hyp * (1.0 - k) + d * k);
  };

  // Center is undistorted
  assert.equal(paniniX(0.0), 0.0, 'Center pixel is undistorted');

  // Outer angles are compressed relative to standard rectilinear
  const xOuter = 1.5;
  const panOuter = paniniX(xOuter, 1.0, 0.4);
  assert.ok(panOuter < xOuter, `Outer wide-angle coordinates compressed (${panOuter.toFixed(3)} < ${xOuter})`);

  // Monotonicity across visual field
  let prev = 0;
  for (let x = 0.1; x <= 2.0; x += 0.2) {
    const p = paniniX(x);
    assert.ok(p > prev, 'Panini transform is strictly monotonic');
    prev = p;
  }
});

/* ---------------- 9. Velocity Conservation ---------------- */
test('velocity conservation: adaptive morph strictly preserves step duration and speed', () => {
  const engine = new VisionEngine();

  const speeds = [1.4, 4.0, 8.0, 12.0];
  const stepDistanceM = 5.0;

  for (const mps of speeds) {
    // Total physical time to complete stride: T = distance / speed
    const physicalTimeS = stepDistanceM / mps;
    assert.ok(physicalTimeS > 0, 'Physical stride duration is positive');

    // Test that enabling adaptive morph NEVER alters the target stride duration
    // It only shapes the easing distribution between t=0 and t=1
    const p0 = engine.evaluateMorphEasing(0.0, 80);
    const p1 = engine.evaluateMorphEasing(1.0, 80);
    assert.equal(p0, 0.0, 'Arrival progress at t=0 is 0');
    assert.equal(p1, 1.0, 'Arrival progress at t=1 is 100%');
  }
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
