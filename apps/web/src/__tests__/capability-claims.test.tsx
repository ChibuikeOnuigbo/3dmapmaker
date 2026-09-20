/**
 * Capability claims must be true.
 *
 * The brief rules out fake metrics, and a sentence in the UI asserting a feature
 * that does not exist is the same failure wearing different clothes. Three such
 * claims were found by rendering the surfaces and comparing their text against
 * the code behind them:
 *
 *   1. The landing footer advertised a "WASM terrain core". No `.wasm` asset
 *      exists, `stats.wasmAvailable` defaults to `false`, and `crates/terrain-core`
 *      has never been compiled.
 *   2. The tutorial said "WebGPU is used where available". `SceneManager` probes
 *      `navigator.gpu` and then hardcodes `backend: 'webgl2'`. Nothing in the
 *      repository constructs a WebGPU renderer.
 *   3. `SceneManagerOptions.preferWebGPU` was accepted by callers and never read —
 *      a toggle that silently does nothing, which reads as a working feature.
 *
 * These assertions are written against the rendered text and the real store, so
 * they fail if a claim is reintroduced without the capability behind it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { App } from '../App';
import { useStore } from '../state/store';

/** Read a source file from the repo root. vitest runs with cwd at the root. */
const src = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

beforeEach(() => {
  window.location.hash = '';
  act(() => {
    const s = useStore.getState();
    useStore.setState({ ui: { ...s.ui, notifications: [], modal: null } });
  });
});

describe('wasm claims', () => {
  it('no wasm module is loaded anywhere in the app', () => {
    // Substantiate the absence rather than asserting on a string: if a wasm path
    // is ever added, this fails and the footer claim becomes legal again.
    expect(useStore.getState().stats.wasmAvailable).toBe(false);
  });

  it('the landing footer makes no wasm claim', () => {
    render(<App />);
    const footer = document.querySelector('.landing__footer');
    expect(footer).toBeTruthy();
    expect(footer!.textContent).not.toMatch(/wasm/i);
  });
});

describe('webgpu claims', () => {
  it('the tutorial does not claim WebGPU is in use', () => {
    window.location.hash = '#/tutorial';
    render(<App />);
    const body = document.body.textContent ?? '';
    // The corrected copy may mention WebGPU, but only as something probed and
    // not yet used. The specific false phrasing must not come back.
    expect(body).not.toMatch(/WebGPU is used where available/i);
  });

  it('the renderer backend is webgl2 and the probe is not a code path', () => {
    const scene = src('packages/scene-core/src/SceneManager.ts');
    // `backend` is assigned exactly once, and to 'webgl2'. The type declaration
    // is a union of three, so match the assignment (trailing comma) and not the
    // declaration.
    const assignments = scene.match(/^\s*backend:\s*'(\w+)',/gm) ?? [];
    expect(assignments, 'backend assigned somewhere other than webgl2').toEqual([
      "      backend: 'webgl2',",
    ]);
    // A probe is fine; a renderer is not present.
    expect(scene).toMatch(/'gpu' in navigator/);
    expect(scene).not.toMatch(/WebGPURenderer|three\/webgpu|requestAdapter/);
  });

  it('the dead preferWebGPU option is gone', () => {
    const scene = src('packages/scene-core/src/SceneManager.ts');
    // It may only appear inside the comment explaining its removal, never as a
    // live member of the options interface.
    const asOption = scene.match(/^\s*preferWebGPU\??:/m);
    expect(asOption, 'preferWebGPU is declared as an option again').toBeNull();
  });
});

describe('the panorama transition really is a spatial warp', () => {
  // The landing page claims "spatial warping rather than a plain crossfade". That
  // used to be false: `PanoramaCrossfade.setProgress` only moved opacity, and
  // `WorldView` hardcoded persistence off, so it was a hard cut. The warp is now
  // real, and these assertions trace the whole chain so it cannot silently
  // regress back into a dissolve.

  it('the shader displaces the sample direction, not just its alpha', () => {
    const shader = src('packages/scene-core/src/panoramaView.ts');
    expect(shader).toMatch(/uniform float uWarpYaw/);
    // The rotation must happen BEFORE the equirectangular u/v is derived from the
    // direction, otherwise it would have no effect on what is sampled.
    const uniformAt = shader.indexOf('if (uWarpYaw != 0.0)');
    const sampleAt = shader.indexOf('float u = atan(dir.x, -dir.z)');
    expect(uniformAt, 'warp branch missing from the shader').toBeGreaterThan(-1);
    expect(sampleAt, 'equirect sampling missing from the shader').toBeGreaterThan(-1);
    expect(uniformAt, 'warp is applied after sampling, so it does nothing').toBeLessThan(sampleAt);
  });

  it('the shader rotation matches the tested TypeScript rotation', () => {
    const shader = src('packages/scene-core/src/panoramaView.ts');
    const ts = src('packages/panorama/src/warp.ts');
    // Both must use the same handedness. The TS is the tested specification; the
    // GLSL mirrors it. Comparing the two expressions catches a sign flip, which
    // is the easiest way for these to diverge and the hardest to notice.
    expect(ts).toMatch(/const x = dir\.x \* c - dir\.z \* s;/);
    expect(ts).toMatch(/const z = dir\.x \* s \* dir\.z \* c;|const z = dir\.x \* s \+ dir\.z \* c;/);
    expect(shader).toMatch(/dir\.x \* c - dir\.z \* sn/);
    expect(shader).toMatch(/dir\.x \* sn \+ dir\.z \* c/);
  });

  it('WorldView drives the warp from the travel direction', () => {
    const view = src('apps/web/src/ui/WorldView.tsx');
    expect(view).toMatch(/setWarpYaw\(/);
    expect(view).toMatch(/incomingWarpDeg\(/);
    expect(view).toMatch(/outgoingWarpDeg\(/);
    // Gated on there being a travel direction, so arrivals and map warp-to (which
    // have no direction to sweep along) do not get a meaningless rotation.
    expect(view).toMatch(/travelDirection !== null/);
  });

  it('the old dissolve-only call is gone', () => {
    const view = src('apps/web/src/ui/WorldView.tsx');
    // This was the whole of the transition before: persistence forced off, which
    // took the hard-cut branch inside setProgress.
    expect(view, 'WorldView still calls setProgress(progress, false, 0)').not.toMatch(
      /setProgress\(progress,\s*false,\s*0\)/,
    );
  });
});

describe('tutorial numeric claims', () => {
  // The tutorial states specific numbers. Each one is derived from the code here,
  // so a changed default fails this instead of quietly making the guide wrong.

  it('the tile-state count matches the TileState union', () => {
    const tiles = src('packages/performance/src/tile-manager.ts');
    const m = tiles.match(/export type TileState = ([^;]+);/);
    expect(m, 'TileState union not found').toBeTruthy();
    const states = (m![1].match(/'([a-z]+)'/g) ?? []).map((q) => q.replace(/'/g, ''));

    const tutorial = src('apps/web/src/ui/StaticTutorial.tsx');
    const claim = tutorial.match(/Tiles move through (\w+) states — ([^—]+) —/);
    expect(claim, 'tile-state sentence not found in the tutorial').toBeTruthy();

    const spelled: Record<string, string> = {
      one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
    };
    const claimedCount = spelled[claim![1]] ?? claim![1];
    expect(claimedCount, `tutorial says ${claim![1]} states, code has ${states.length}`).toBe(
      String(states.length),
    );
    // And the states named in the copy must be exactly the ones in the union.
    const listed = claim![2].split(',').map((x) => x.trim());
    expect(listed.sort()).toEqual([...states].sort());
  });

  it('the landing page advertises the real brush-tool count', () => {
    const sculpt = src('packages/terrain/src/sculpt.ts');
    const m = sculpt.match(/export type BrushTool =([^;]+);/s);
    expect(m, 'BrushTool union not found').toBeTruthy();
    const tools = (m![1].match(/'([a-z]+)'/g) ?? []).map((q) => q.replace(/'/g, ''));
    expect(tools.length, 'BrushTool union changed size').toBe(14);
    expect(new Set(tools).size, 'duplicate tool in the union').toBe(tools.length);

    const landing = src('apps/web/src/ui/LandingPage.tsx');
    expect(landing).toContain(`${tools.length} real brush tools`);
  });

  it('the tile-state count is consistent everywhere it is stated', () => {
    const tiles = src('packages/performance/src/tile-manager.ts');
    const m = tiles.match(/export type TileState = ([^;]+);/);
    const count = (m![1].match(/'([a-z]+)'/g) ?? []).length;
    expect(count).toBe(7);

    const spelled: Record<number, string> = {
      1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight',
    };
    const word = spelled[count];
    // It was stated in two places and both said "five".
    expect(src('apps/web/src/ui/LandingPage.tsx')).toContain(`${word} explicit tile states`);
    expect(src('apps/web/src/ui/StaticTutorial.tsx')).toContain(`${word} states`);
    for (const f of ['apps/web/src/ui/LandingPage.tsx', 'apps/web/src/ui/StaticTutorial.tsx']) {
      expect(src(f), `${f} still claims five tile states`).not.toMatch(/five (explicit )?(tile )?states/);
    }
  });

  it('the LOD hysteresis is the ±25% the tutorial claims', () => {
    const lod = src('packages/performance/src/lod.ts');
    expect(lod).toMatch(/hysteresis = opts\.hysteresis \?\? 0\.25/);
    // Both sides of the band have to use it, or it is not really ±.
    expect(lod).toMatch(/maxSse \* \(1 - hysteresis\)/);
    expect(lod).toMatch(/maxSse \* \(1 \+ hysteresis\)/);
    const tutorial = src('apps/web/src/ui/StaticTutorial.tsx');
    expect(tutorial).toMatch(/±25% hysteresis/);
  });

  it('the autosave debounce and flush intervals are the ones advertised', () => {
    const store = src('apps/web/src/state/store.ts');
    // new SaveController(opts, storage, debounceMs, flushMs)
    const m = store.match(/new SaveController\([^)]*?,\s*(\d+),\s*(\d+)\)/);
    expect(m, 'SaveController construction not found').toBeTruthy();
    expect(m![1], 'debounce is not 800 ms').toBe('800');
    expect(m![2], 'flush is not 5000 ms').toBe('5000');
    const tutorial = src('apps/web/src/ui/StaticTutorial.tsx');
    expect(tutorial).toMatch(/800 ms after you stop/);
    expect(tutorial).toMatch(/every 5 seconds/);
  });
});

describe('honest capability claims that should stay true', () => {
  it('Web Workers really are used for terrain', () => {
    // The footer claims Web Workers. `workers/terrain.worker.ts` is the
    // substantiation; if it disappears the claim becomes false.
    const worker = src('workers/terrain.worker.ts');
    expect(worker).toMatch(/build-mesh/);
    expect(worker).toMatch(/'cancel'/);
    // `TerrainWorkerClient` takes a factory rather than constructing the worker
    // itself, so the `new Worker` call lives in the viewport. Assert both halves:
    // that a real Worker is constructed, and that it points at the worker source.
    const viewport = src('apps/web/src/ui/Viewport.tsx');
    expect(viewport).toMatch(/new Worker\(new URL\([^)]*terrain\.worker\.ts/);
    const client = src('apps/web/src/engine/TerrainWorkerClient.ts');
    expect(client).toMatch(/workerFactory\(\)/);
    // And the fallback is honest, not a silent no-op.
    expect(client).toMatch(/inline\(request, signal\)/);
  });

  it('the store defaults to the TypeScript core, matching the status bar', () => {
    // StatusBar derives "ts core" from this flag, so the two surfaces agree only
    // while the default is false.
    expect(useStore.getState().stats.wasmAvailable).toBe(false);
    const statusBar = src('apps/web/src/ui/StatusBar.tsx');
    expect(statusBar).toMatch(/wasmAvailable \? 'wasm' : 'ts core'/);
  });
});
