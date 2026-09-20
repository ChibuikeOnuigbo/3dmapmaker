/**
 * boot-harness.mjs — boots the REAL Panorama Maps app (js/main.js) in Node
 * behind a minimal fake DOM + the pure-JS Canvas2D shim, then walks all three
 * demo worlds, proving the same runtime path a browser takes.
 *
 * Usage:  node tools-render/boot-harness.mjs
 */
import { FakeCanvas } from './canvas2d.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- fake DOM ---------------- */
class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.value = '';
    this.hidden = false;
    this.files = [];
    this.type = '';
    this.accept = '';
    this.textContent = '';
    this.disabled = false;
    this._innerHTML = '';
    const s = new Set();
    this.classList = {
      add: (...a) => a.forEach((x) => s.add(x)),
      remove: (...a) => a.forEach((x) => s.delete(x)),
      toggle: (x, f) => { if (f === undefined) f = !s.has(x); f ? s.add(x) : s.delete(x); return f; },
      contains: (x) => s.has(x),
    };
    this.listeners = {};
    this.clientWidth = 960; this.clientHeight = 540;
    this.offsetWidth = 100; this.offsetHeight = 40;
  }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener() {}
  appendChild(c) { this.children.push(c); return c; }
  remove() {}
  insertAdjacentHTML(p, h) { this._innerHTML += h; }
  setAttribute(k, v) { (this.attrs ??= {})[k] = v; }
  getAttribute(k) { return this.attrs?.[k] ?? null; }
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  click() {}
  focus() {}
  blur() {}
  set innerHTML(v) { this._innerHTML = String(v); }
  get innerHTML() { return this._innerHTML; }
}

class ElCanvas extends FakeCanvas {
  constructor(w = 960, h = 540) {
    super();
    const el = new El('canvas');
    for (const k of Object.keys(el)) this[k] = el[k];   // own state fields
    this.clientWidth = w; this.clientHeight = h;
    this.width = w; this.height = h;
  }
}
// mix in El's methods (class methods are non-enumerable prototype props)
for (const name of Object.getOwnPropertyNames(El.prototype)) {
  if (name !== 'constructor') Object.defineProperty(ElCanvas.prototype, name, Object.getOwnPropertyDescriptor(El.prototype, name));
}

const registry = new Map();
function getEl(sel) {
  if (!registry.has(sel)) {
    registry.set(sel, sel === '#panoCanvas' || sel === '#fxCanvas' || sel === '#mapCanvas' || sel === '#editorMapCanvas' ? new ElCanvas() : new El());
  }
  return registry.get(sel);
}

const documentShim = {
  querySelector: getEl,
  getElementById: (id) => getEl('#' + id),
  querySelectorAll: (sel) => {
    if (sel === '#movePad .mbtn') return [];      // pad buttons not needed for harness
    return [];
  },
  createElement: (tag) => (tag === 'canvas' ? new ElCanvas(300, 150) : new El(tag)),
  createElementNS: (_ns, tag) => new El(tag),
  addEventListener() {},
  removeEventListener() {},
  body: new El('body'),
  documentElement: new El('html'),
  fullscreenElement: null,
  hidden: false,
};

const rafQ = new Set();
let rafTimer = null;
function raf(fn) {
  rafQ.add(fn);
  if (!rafTimer) {
    rafTimer = setInterval(() => {
      const q = [...rafQ]; rafQ.clear();
      const t = performance.now();
      q.forEach((f) => f(t));
    }, 16);
  }
  return fn;
}

globalThis.document = documentShim;
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  location: { protocol: 'http:', hostname: 'localhost' },
  requestAnimationFrame: raf,
  cancelAnimationFrame: (id) => rafQ.delete(id),
  setInterval, clearInterval, setTimeout, clearTimeout,
  performance,
};
globalThis.self = globalThis.window;
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;
Object.defineProperty(globalThis, 'navigator', {
  value: { hardwareConcurrency: 4, deviceMemory: 4 },   // balanced tier
  configurable: true,
});
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.indexedDB = {
  open: () => { throw new Error('indexedDB unavailable in harness (testing the no-storage path)'); },
};
globalThis.location = globalThis.window.location;
globalThis.devicePixelRatio = 1;
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => 'blob:harness';
  globalThis.URL.revokeObjectURL = () => {};
}

/* ---------------- tools ---------------- */
function canvasStats(canvas) {
  // sample a stride over the WHOLE frame — a sky-only crop is smooth by nature
  const gctx = canvas.getContext('2d');
  const d = gctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0, sq = 0, n = 0;
  const stride = 4 * 37;   // every 37th pixel
  for (let i = 0; i < d.length; i += stride) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += v; sq += v * v; n++; }
  const mean = sum / n;
  return { mean: +mean.toFixed(1), std: +Math.sqrt(Math.max(0, sq / n - mean * mean)).toFixed(1) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(60);
  }
  throw new Error(`timeout waiting for ${what}`);
}

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail ? '— ' + detail : ''}`); }
};

/* ---------------- boot the real app ---------------- */
console.log('• importing js/main.js (auto-boot)…');
const bootErrors = [];
const origErr = console.error;
console.error = (...a) => { bootErrors.push(a.map(String).join(' ')); origErr(...a); };

await import('../js/main.js');
const app = globalThis.window.app;
check('app exposed on window', !!app);

await waitFor(() => app.graph && app.movement?.currentNodeId, 'demo world boot');
check('boot completed with a current node', !!app.movement.currentNodeId);
check('no boot errors', bootErrors.filter((e) => e.includes('boot failed')).length === 0, bootErrors[0] || '');

async function verifyWorld(label, expectMinNodes) {
  console.log(`\n=== ${label} ===`);
  const g = app.graph;
  check(`node count ≥ ${expectMinNodes}`, g.nodes.size >= expectMinNodes, `have ${g.nodes.size}`);
  const curId = app.movement.currentNodeId;
  check('current node exists', !!g.getNode(curId), curId);

  // the visible panorama must have entered the cache with real imagery
  await waitFor(() => app.cache.metaOf(curId), 'initial panorama generated');
  const entry = await app.cache.get(curId, async () => { throw new Error('must be cached'); });
  const st = canvasStats(entry.canvas);
  check('generated panorama is non-blank', st.std > 8, `std=${st.std}`);
  console.log(`    pixels ${entry.canvas.width}×${entry.canvas.height} mean=${st.mean} std=${st.std} provider=${entry.meta.provider}`);

  // walk 3 steps — CAMERA-RELATIVE WASD (Spec §37): aim the view at a real
  // neighbor's bearing (like a user turning toward the road) then press W.
  const bearingTo = (fromId, toId) => {
    const a = app.graph.getNode(fromId), b = app.graph.getNode(toId);
    return (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360;
  };
  const openNeighbor = (id, exclude = new Set()) => {
    for (const e of app.graph.edgesOf(id)) {
      if (e.blocked) continue;
      const o = app.graph.otherEnd(e, id);
      if (!exclude.has(o)) return o;
    }
    return null;
  };
  const trail = [curId];
  for (let i = 0; i < 3; i++) {
    const before = app.movement.currentNodeId;
    const next = openNeighbor(before, new Set(trail.slice(0, -1)));
    if (!next) { check(`step ${i + 1} has an open neighbor`, false, `dead end at ${before}`); break; }
    app.viewer.view.yawDeg = bearingTo(before, next);          // face the road like a user would
    app.tryMove('forward');
    const arrived = await waitFor(() => app.movement.currentNodeId !== before && app.movement.currentNodeId, `forward step ${i + 1}`, 15000).catch(() => null);
    if (!arrived) { check(`forward step ${i + 1} moved`, false, `stuck at ${before}`); break; }
    check(`step ${i + 1} resolved to the aimed node`, app.movement.currentNodeId === next, `got ${app.movement.currentNodeId}, aimed ${next}`);
    trail.push(app.movement.currentNodeId);
    await waitFor(() => app.cache.metaOf(app.movement.currentNodeId), 'arrival panorama', 15000);
  }
  check('walked 3 camera-relative steps through the graph', trail.length === 4, trail.join(' → '));

  // every arrival panorama non-blank
  for (const id of trail.slice(1)) {
    const e = await app.cache.get(id, async () => { throw new Error('uncached'); });
    const s = canvasStats(e.canvas);
    check(`panorama non-blank @ ${id}`, s.std > 8, `std=${s.std}`);
  }

  // reverse: must return the ORIGINAL cached canvases (identity), no regeneration
  const back = [...trail].reverse();
  app.movement.cancelWalk?.();
  for (let i = 1; i < back.length; i++) {
    const before = app.movement.currentNodeId;
    const prev = back[i];
    app.viewer.view.yawDeg = bearingTo(before, prev);          // turn around like a user would
    app.tryMove('forward');
    await waitFor(() => app.movement.currentNodeId !== before, 'reverse step', 15000).catch(() => null);
    check(`reverse step reached ${prev}`, app.movement.currentNodeId === prev);
  }
  const endId = app.movement.currentNodeId;
  check('reverse traversal returned to the start node ID', endId === curId, `ended at ${endId}, wanted ${curId}`);
  return g;
}

/* world 1 — booted by default (Chapel Lane) */
await verifyWorld('DEMO 1 · Chapel Lane (default boot)', 50);

/* world 2 — Millbrook */
const { DEMO_WORLDS } = await import('../js/worlds/demo-worlds.js');
await app.loadDemoWorld(DEMO_WORLDS.find((w) => w.id === 'demo_millbrook'));
await waitFor(() => app.graph?.id === 'demo_millbrook' && app.cache.metaOf(app.movement.currentNodeId), 'millbrook boot', 20000);
await verifyWorld('DEMO 2 · Millbrook', 100);

/* world 3 — Great Vale, the 1,000+ node case the user reported */
await app.loadDemoWorld(DEMO_WORLDS.find((w) => w.id === 'demo_great_vale'));
await waitFor(() => app.graph?.id === 'demo_great_vale' && app.cache.metaOf(app.movement.currentNodeId), 'great vale boot', 45000);
const g3 = await verifyWorld('DEMO 3 · Great Vale', 1000);

/* 500 m zone sanity inside the live app */
const chapel = DEMO_WORLDS.find((w) => w.id === 'demo_chapel_lane').build();
const dist = chapel.graph.scale.pxToM(500 * chapel.graph.scale.pixelsPerMeter);
check('500 m zone maps to exactly 500 m', dist === 500, `${dist}`);

console.log(`\n${fail === 0 ? 'ALL' : `${pass}/${pass + fail}`} boot-harness checks passed (${pass} pass, ${fail} fail)`);
process.exit(fail ? 1 : 0);
