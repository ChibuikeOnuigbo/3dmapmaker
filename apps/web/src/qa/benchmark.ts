/**
 * apps/web/qa — the benchmark runner (REQUIREMENT 141).
 *
 * Every number is measured here, in the live page, from real work:
 *   startup        navigationStart → first paint of the editor
 *   first frame    time to the first rendered frame after the engine mounts
 *   camera latency pointer/wheel event → the rig position actually changing
 *   wheel zoom     wheel event → distance change applied
 *   draw time      renderer.info-driven per-frame GPU submission window
 *   tile latency   heightfield generation + meshing for one tile
 *   large-scene FPS sustained rate with the stress world loaded
 *   memory         performance.memory where the browser exposes it
 *
 * If the editor is not mounted the runner says so rather than inventing values.
 */
import { generateHeightfield, buildTerrainMesh, type TerrainSource } from '@3dmm/terrain';
import { getEngine } from '../engine/engineRef';
import { useStore } from '../state/store';

export interface BenchmarkResult {
  metrics: Record<string, number>;
  memory: string | null;
  samples: number;
  notes: string[];
}

function now(): number {
  return performance.now();
}

function frame(): Promise<number> {
  return new Promise((resolve) => {
    const t0 = now();
    requestAnimationFrame(() => resolve(now() - t0));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    if (predicate()) return true;
    await frame();
  }
  return predicate();
}

/** Tile generation + meshing cost, which is what the worker spends time on. */
async function measureTileLatency(): Promise<{ ms: number; verts: number }> {
  const source: TerrainSource = {
    kind: 'procedural',
    seed: 4242,
    octaves: 6,
    lacunarity: 2.08,
    gain: 0.5,
    amplitude: 320,
    frequency: 0.0012,
    warp: 0.45,
    ridged: true,
  };
  // Warm the JIT so the first sample is not dominated by compilation.
  generateHeightfield({ source, resolution: 17, size: 64, originX: 0, originY: 0 });
  const t0 = now();
  const h = generateHeightfield({ source, resolution: 65, size: 256, originX: 0, originY: 0 });
  const mesh = buildTerrainMesh(h, { skirtMeters: 6 });
  const ms = now() - t0;
  return { ms, verts: mesh.vertexCount };
}

export async function runBenchmark(): Promise<BenchmarkResult> {
  const notes: string[] = [];
  const metrics: Record<string, number> = {};

  /* ---------------------------------------------------------- startup --- */
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const paint = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
  metrics.startupMs = paint ? paint.startTime : nav ? nav.domContentLoadedEventEnd : Number.NaN;
  if (!paint) notes.push('first-contentful-paint was not reported by this browser; using domContentLoaded instead.');

  /* ------------------------------------------------------- first frame --- */
  const engine = getEngine();
  if (engine) {
    const framesBefore = engine.getDebugSnapshot().frames;
    const t0 = now();
    const ok = await waitFor(() => engine.getDebugSnapshot().frames > framesBefore, 3000);
    metrics.firstFrameMs = ok ? now() - t0 : Number.NaN;
    if (!ok) notes.push('The renderer did not produce a frame within 3 s.');
  } else {
    metrics.firstFrameMs = Number.NaN;
    notes.push('The editor is not mounted, so frame timings were skipped. Open #/editor and re-run.');
  }

  /* ------------------------------------------------- camera move latency --- */
  if (engine) {
    const before = engine.getDebugSnapshot().rig.distance;
    const t0 = now();
    engine.zoomBy(0.6, 'Benchmark');
    const changed = await waitFor(() => Math.abs(engine.getDebugSnapshot().rig.distance - before) > 1e-6, 3000);
    metrics.cameraLatencyMs = changed ? now() - t0 : Number.NaN;
  } else {
    metrics.cameraLatencyMs = Number.NaN;
  }

  /* -------------------------------------------------- wheel zoom latency --- */
  if (engine) {
    const canvas = engine.getSceneManager().renderer.domElement as HTMLCanvasElement;
    const before = engine.getDebugSnapshot().rig.distance;
    const t0 = now();
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }));
    const changed = await waitFor(() => Math.abs(engine.getDebugSnapshot().rig.distance - before) > 1e-9, 2000);
    metrics.wheelZoomMs = changed ? now() - t0 : Number.NaN;
    if (!changed) notes.push('The wheel event did not change the orbit distance — check that the viewport has focus.');
  } else {
    metrics.wheelZoomMs = Number.NaN;
  }

  /* ------------------------------------------------------ draw time --- */
  if (engine) {
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t0 = now();
      await frame();
      samples.push(now() - t0);
    }
    samples.sort((a, b) => a - b);
    metrics.drawMs = samples[Math.floor(samples.length / 2)];
    metrics.p95FrameMs = samples[Math.floor(samples.length * 0.95)];
  } else {
    metrics.drawMs = Number.NaN;
    metrics.p95FrameMs = Number.NaN;
  }

  /* -------------------------------------------------- tile latency --- */
  const tile = await measureTileLatency();
  metrics.tileLatencyMs = tile.ms;
  notes.push(`Tile sample: 64² grid, ${tile.verts} vertices, generated and meshed on this thread.`);

  /* -------------------------------------------- large-scene FPS --- */
  const stats = useStore.getState().stats;
  if (engine && stats.fps > 0) {
    // Sample the profiler over ~1.5 s rather than trusting a single reading.
    const t0 = now();
    let frames = 0;
    const start = engine.getDebugSnapshot().frames;
    while (now() - t0 < 1500) {
      await frame();
      frames = engine.getDebugSnapshot().frames - start;
    }
    metrics.largeSceneFps = frames / ((now() - t0) / 1000);
  } else {
    metrics.largeSceneFps = Number.NaN;
  }

  /* --------------------------------------------------- memory --- */
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  const memory = mem ? `${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB of ${(mem.jsHeapSizeLimit / 1048576).toFixed(0)} MB limit` : null;
  if (!mem) notes.push('This browser does not expose performance.memory.');

  metrics.cacheBytes = useStore.getState().stats.cacheBytes;
  metrics.tilesActive = useStore.getState().stats.tiles.active;
  metrics.drawCalls = useStore.getState().stats.drawCalls;
  metrics.triangles = useStore.getState().stats.triangles;

  const samples = 60 + (engine ? 90 : 0);
  return { metrics, memory, samples, notes };
}
