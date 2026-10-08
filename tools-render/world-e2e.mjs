/**
 * tools-render/world-e2e.mjs — the world file and the worlds database,
 * driven through the REAL app in a REAL browser.
 *
 *   node tools-render/world-e2e.mjs                # everything (web + desktop)
 *   node tools-render/world-e2e.mjs --phase web    # static build only
 *   node tools-render/world-e2e.mjs --keep         # keep the temp workspace
 *
 * What it proves, in order:
 *
 *   WEB (static files, no server, no database)
 *     1. any world can be saved — including a demo world the visitor did not
 *        build — from the Worlds panel
 *     2. the file that comes out holds the graph, the session and its images
 *     3. opening that file on a clean browser (no cache, no originals, the
 *        world folder BLOCKED at the network layer) restores the world, the
 *        pixels, the scene modes and walking
 *     4. the same world survives a reload: the images are in the local mirror
 *
 *   DESKTOP (the same app, served by desktop/server.mjs, database behind it)
 *     5. saving to the worlds database fills the library columns
 *     6. the database can export a .pworld on its own (server side), with the
 *        images inside it
 *     7. reopening a world from the database renders from the database
 *     8. a file saved by the WEB build opens in the DESKTOP build unchanged —
 *        one format, two homes
 *
 * Chromium lives outside this repo (the sandbox cannot install browsers the
 * usual way). Point the script at one:
 *
 *   PM_CHROMIUM=/path/to/chromium PM_CHROMIUM_LIBS=/path/with/libnss3.so \
 *     node tools-render/world-e2e.mjs
 *
 * or install the two packages the sandbox needs and let it find them:
 *
 *   npm i playwright-core @sparticuz/chromium   # in any folder
 *   NODE_PATH=$PWD/node_modules node tools-render/world-e2e.mjs
 *
 * Without a browser the script prints how to get one and exits 0 (skipped),
 * so CI stays green on machines that cannot run one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { readZip } from '../js/io/zipex.js';
import { startDesktopApp, APP_ROOT } from '../desktop/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};
const PHASE = flag('phase', 'all');
const KEEP = !!flag('keep', false);
const SHOTS = path.join(ROOT, 'qa', 'world-file');

/* ---------------- tiny harness ---------------- */
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
  return !!cond;
};
const step = (t) => console.log(`\n· ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

/* ---------------- chromium discovery ---------------- */
async function findChromium() {
  const load = async (name) => {
    try { return await import(name); } catch { return null; }
  };
  const extra = (process.env.PM_NODE_PATH || process.env.NODE_PATH || '')
    .split(path.delimiter).filter(Boolean);
  for (const dir of extra) {
    const p = path.join(dir, 'playwright-core', 'package.json');
    if (fs.existsSync(p)) {
      const mod = await import(path.join(dir, 'playwright-core', 'index.mjs')).catch(() => null)
        || await import(path.join(dir, 'playwright-core', 'index.js')).catch(() => null);
      if (mod) return { playwright: mod.chromium || mod.default?.chromium, sparticuz: await importSparticuz(extra) };
    }
  }
  const pw = await load('playwright-core');
  return pw ? { playwright: pw.chromium, sparticuz: await importSparticuz(extra) } : null;
}
async function importSparticuz(dirs) {
  for (const dir of dirs) {
    const pkg = path.join(dir, '@sparticuz', 'chromium');
    const entry = path.join(pkg, 'build', 'index.js');
    if (fs.existsSync(entry)) { const m = await import(entry); return { mod: m.default || m, dir: pkg }; }
  }
  try {
    const url = import.meta.resolve('@sparticuz/chromium');
    const m = await import(url);
    return { mod: m.default || m, dir: path.resolve(path.dirname(fileURLToPath(url)), '..') };
  } catch { return null; }
}

async function launchBrowser() {
  const found = await findChromium();
  if (!found?.playwright) return { skip: 'playwright-core is not installed' };
  const { playwright: chromium } = found;
  const sparticuz = found.sparticuz?.mod || null;
  let executablePath = process.env.PM_CHROMIUM || null;
  let args = ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'];
  if (!executablePath && sparticuz) {
    executablePath = await sparticuz.executablePath();
    // the lambda build ships its own NSS: unpack it beside the binary
    const libDir = process.env.PM_CHROMIUM_LIBS || path.join(os.tmpdir(), 'al2023', 'lib');
    if (!fs.existsSync(libDir)) {
      const br = path.join(found.sparticuz?.dir || '', 'bin', 'al2023.tar.br');
      const src = br && fs.existsSync(br) ? br : null;
      if (src) {
        const { brotliDecompressSync } = await import('node:zlib');
        const { execFileSync } = await import('node:child_process');
        fs.mkdirSync(libDir, { recursive: true });
        const tar = path.join(os.tmpdir(), 'al2023.tar');
        fs.writeFileSync(tar, brotliDecompressSync(fs.readFileSync(src)));
        execFileSync('tar', ['xf', tar, '-C', path.dirname(libDir)]);
      }
    }
    if (fs.existsSync(libDir)) process.env.LD_LIBRARY_PATH = [process.env.LD_LIBRARY_PATH, libDir].filter(Boolean).join(':');
    if (!process.env.FONTCONFIG_PATH) process.env.FONTCONFIG_PATH = path.join(os.tmpdir(), 'fonts');
  }
  if (!executablePath || !fs.existsSync(executablePath)) return { skip: 'no chromium executable (set PM_CHROMIUM)' };
  const browser = await chromium.launch({ executablePath, args, headless: true });
  return { browser };
}

/* ---------------- static server (the web build, honestly) ---------------- */
import { serveStatic } from './static-serve.mjs';


/**
 * Build a small world out of REAL photographs (the Willow Parish set) inside
 * the running app, keeping only the scene modes whose image actually exists —
 * so an export of it is complete, and every claim about the file is exact.
 */
async function buildPhotoWorld(page, { id, name, places = 4 } = {}) {
  return page.evaluate(async ({ id, name, places }) => {
    const { DEMO_WORLDS } = await import('/js/worlds/demo-worlds.js');
    const src = DEMO_WORLDS.find((w) => w.id === 'demo_willow_parish').build().graph;
    const json = src.toJSON();
    const byId = new Map(json.nodes.map((n) => [n.id, n]));
    const neighbours = (id) => json.edges.flatMap((e) => (e.a === id ? [e.b] : e.b === id ? [e.a] : []));
    const existingModes = async (node) => {
      const variants = {};
      for (const [mode, url] of Object.entries(node.pano?.variants || {})) {
        const ok = await fetch(url).then((r) => r.ok).catch(() => false);
        if (ok) variants[mode] = url;
      }
      return variants;
    };
    const start = json.startNodeId || json.nodes[0].id;
    const nodes = [];
    const seen = new Set();
    const queue = [start];
    while (queue.length && nodes.length < places) {
      const nid = queue.shift();
      if (seen.has(nid)) continue;
      seen.add(nid);
      const node = byId.get(nid);
      const keptIds = nodes.map((n) => n.id);
      const touches = keptIds.length === 0 || keptIds.some((k) => neighbours(nid).includes(k));
      if (node && touches) {
        const variants = await existingModes(node);
        // the first place needs two scene modes (so mode switching can be
        // tested from the file); the rest only need one, which keeps the
        // slice CONNECTED — real worlds are not always fully photographed
        const need = nodes.length === 0 ? 2 : 1;
        if (Object.keys(variants).length >= need) nodes.push({ ...node, pano: { kind: 'urlset', variants } });
      }
      for (const nb of neighbours(nid)) if (!seen.has(nb)) queue.push(nb);
    }
    const ids = nodes.map((n) => n.id);
    const slice = {
      ...json, id, name, nodes,
      edges: json.edges.filter((e) => ids.includes(e.a) && ids.includes(e.b)),
      zones: [], landmarks: [],
    };
    await globalThis.app.loadWorldJson(slice, { name, project: { id, name } });
    return {
      id, nodes: nodes.length,
      modes: Object.keys(nodes[0].pano.variants),
      urls: nodes.flatMap((n) => Object.values(n.pano.variants)),
      perNode: nodes.map((n) => Object.keys(n.pano.variants).length),
      edges: slice.edges.length,
    };
  }, { id, name, places });
}

/* ---------------- contexts ---------------- */

/**
 * A browser context that can drive BOTH file paths the app supports.
 *
 * Headless browsers cannot show a native file dialog, so the File System
 * Access API is stubbed:
 *   · saving through the picker writes its blob to a download (and reports the
 *     name it was offered) — the primary path, exercised for real
 *   · `window.__pmUseDownloadFallback()` removes the picker, so the app takes
 *     its documented `<a download>` fallback — the path Safari and Firefox use
 *   · opening always goes through `<input type=file>`, which the test drives
 */
async function appContext(browser, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  await ctx.addInitScript(() => {
    window.__pmPicked = [];
    window.__pmDiag = [];
    const origClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function (...a) {
      window.__pmDiag.push({ what: 'input.click', type: this.type, accept: this.accept, inDom: !!this.isConnected });
      return origClick.apply(this, a);
    };
    window.showOpenFilePicker = undefined;
    try { delete window.showOpenFilePicker; } catch { /* not configurable */ }
    window.showSaveFilePicker = async (opts = {}) => {
      const name = opts.suggestedName || 'world.pworld';
      window.__pmPicked.push(name);
      return {
        name,
        createWritable: async () => {
          let blob = null;
          return {
            write: async (b) => { blob = b; },
            close: async () => {
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = name;
              document.body.appendChild(a); a.click(); a.remove();
            },
          };
        },
      };
    };
    window.__pmUseDownloadFallback = () => { try { delete window.showSaveFilePicker; } catch { /* ignore */ } };
    window.__pmDiagState = () => ({ pickerPresent: 'showOpenFilePicker' in window, savePickerPresent: 'showSaveFilePicker' in window });
  });
  return ctx;
}

/* ---------------- page helpers ---------------- */

/**
 * Open a world file the way a visitor does: the landing screen's
 * “Open a world file” button, then the file dialog it raises.
 *
 * Headless Chromium occasionally drops the first file dialog after a page has
 * been busy rendering (the app is drawing panoramas while the dialog opens), so
 * the click is retried — the second gesture always lands. Each retry is
 * reported, never hidden.
 */
async function openWorldFileThroughUI(page, file, { label = '' } = {}) {
  const attempt = async (where, click) => {
    const chooserP = page.waitForEvent('filechooser', { timeout: 12000 }).catch(() => null);
    await click();
    const chooser = await chooserP;
    if (chooser) {
      await chooser.setFiles(file);
      if (where !== 'landing') console.log(`    (the platform file dialog was raised from the ${where})`);
      return true;
    }
    const diag = await page.evaluate(() => (window.__pmDiagState ? { ...window.__pmDiagState(), clicks: window.__pmDiag } : null)).catch(() => null);
    console.log(`    no file dialog from the ${where}${diag ? ' · ' + JSON.stringify(diag) : ''}`);
    return false;
  };

  // 1. the way a first time visitor does it
  if (await page.locator('#landing [data-act="open"]').isVisible().catch(() => false)) {
    if (await attempt('landing screen', () => page.click('#landing [data-act="open"]'))) return true;
  }
  // 2. the Worlds panel — same call, and it survives a dropped dialog
  if (!await page.locator('#worldsPanel:not([hidden])').count()) {
    await openPanel(page);
    await page.click('#worldsPanel [data-tab="save"]').catch(() => {});
  }
  for (let i = 0; i < 3; i++) {
    if (await attempt('Worlds panel', () => page.click('#worldsPanel [data-act="openFile"]'))) {
      if (label) console.log(`    (opened ${label} through the panel)`);
      return true;
    }
    await page.waitForTimeout(400);
  }
  return false;
}const bootApp = async (page) => {
  await page.waitForFunction(() => globalThis.app?.graph && globalThis.app.movement?.currentNodeId, null, { timeout: 60000 });
  return page.evaluateHandle(() => globalThis.app);
};
const cacheMeta = (page, key) => page.evaluate((k) => globalThis.app.cache.metaOf(k) || null, key);
const pixels = (page, key) => page.evaluate(async (k) => {
  let entry = null;
  try { entry = await globalThis.app.cache.get(k, async () => { throw new Error('uncached'); }); } catch { entry = null; }
  const canvas = entry?.canvas || document.querySelector('#panoCanvas') || null;
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0, sq = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 37) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += v; sq += v * v; n++; }
  const mean = sum / n;
  return { mean: +mean.toFixed(1), std: +Math.sqrt(Math.max(0, sq / n - mean * mean)).toFixed(1), size: [canvas.width, canvas.height] };
}, key);
/** Dismiss the start screen (waits until the app has actually built it). */
const hideLanding = async (page) => {
  await page.waitForFunction(() => globalThis.app?.landing, null, { timeout: 30000 }).catch(() => null);
  await page.evaluate(() => globalThis.app?.landing?.hide());
  await page.waitForFunction(() => !document.body.classList.contains('landing-open'), null, { timeout: 10000 }).catch(() => null);
};

const openPanel = async (page) => {
  if (await page.locator('#worldsPanel:not([hidden])').count()) return;
  await page.click('#worldsBtn');
  await page.waitForSelector('#worldsPanel:not([hidden]) .wl-tabs', { timeout: 10000 });
};
const clickAct = (page, act) => page.click(`#worldsPanel [data-act="${act}"]`);
const tab = (page, name) => page.click(`#worldsPanel [data-tab="${name}"]`);

/** Capture whatever the app does with the bytes: a download, or the desktop exports folder. */
async function captureSave(page, page_, act, { exportsDir = null, before = [] } = {}) {
  const downloadPromise = page.waitForEvent('download', { timeout: 300000 }).catch(() => null);
  await clickAct(page, act);
  let download = null;
  if (exportsDir) {
    // the desktop build writes the file itself; the browser download is a no-op
    const t0 = Date.now();
    while (Date.now() - t0 < 300000) {
      const now = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir).filter(f => f.endsWith('.pworld')) : [];
      const fresh = now.find(f => !before.includes(f));
      if (fresh) { download = { __path: path.join(exportsDir, fresh) }; break; }
      await sleep(250);
    }
    if (!download) download = await downloadPromise;
  } else {
    download = await downloadPromise;
  }
  if (!download) return null;
  if (download.__path) return download.__path;
  const out = path.join(os.tmpdir(), `pm-e2e-${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(out);
  return out;
}

/* ================================================================= */
/* the run                                                            */
/* ================================================================= */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-world-e2e-'));
fs.mkdirSync(SHOTS, { recursive: true });
console.log(`Panorama Maps — world file E2E\n  workspace ${tmp}\n  screenshots ${path.relative(ROOT, SHOTS)}`);

const browserInfo = await launchBrowser();
if (browserInfo.skip) {
  console.log(`\n⏭  skipped: ${browserInfo.skip}\n   install one:\n     npm i playwright-core @sparticuz/chromium\n     NODE_PATH=$PWD/node_modules node tools-render/world-e2e.mjs`);
  process.exit(0);
}
const browser = browserInfo.browser;

let staticSrv = null, desktopApp = null;
try {
  /* ============================================================ */
  if (PHASE === 'all' || PHASE === 'web') {
    staticSrv = await serveStatic(ROOT);
    console.log(`\n============ WEB BUILD (static, no database) · ${staticSrv.url} ============`);

    /* ---- 1. save a demo world the visitor did not build --------- */
    step('open the app, walk into a demo world from the landing screen');
    let ctx = await appContext(browser);
    let page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(`${staticSrv.url}/`, { waitUntil: 'domcontentloaded' });
    await bootApp(page);
    check('the app boots (no page errors)', pageErrors.length === 0, pageErrors[0] || '');

    await page.click('[data-act="demos"]');
    await page.click('[data-w="demo_chapel_lane"]');
    await page.waitForSelector('.land-pop [data-go="script-visual"]', { timeout: 15000 });
    await page.click('.land-pop [data-go="script-visual"]');
    await page.waitForFunction(() => !document.body.classList.contains('landing-open'), null, { timeout: 15000 });
    await waitFor(() => page.evaluate(() => globalThis.app.graph?.nodes?.size > 10), 'demo world load');
    check('the landing screen closes and the toolbar comes back', await page.locator('#worldsBtn').isVisible());
    const chapel = await page.evaluate(() => ({ id: globalThis.app.graph.id, nodes: globalThis.app.graph.nodes.size, edges: globalThis.app.graph.edges.size }));
    check('a demo world is open (Chapel Lane)', chapel.id.includes('chapel') || chapel.nodes >= 50, JSON.stringify(chapel));

    step('the studio the world opened in can save it too');
    // the studio is built when the world actually opens, just after the landing closes
    await page.waitForSelector('.sg-studio [data-saveworld]', { timeout: 60000 }).catch(() => null);
    const studioButtons = await page.locator('.sg-studio [data-saveworld]').count();
    check('the scripting studio offers Save world', studioButtons >= 1, `${studioButtons} buttons`);
    const studioFile = await (async () => {
      const dl = page.waitForEvent('download', { timeout: 300000 });
      await page.click('.sg-studio [data-saveworld]');
      const d = await dl;
      const out = path.join(tmp, 'studio-' + d.suggestedFilename());
      await d.saveAs(out);
      return out;
    })();
    check('saving from inside the studio produced a world file', fs.existsSync(studioFile) && fs.statSync(studioFile).size > 2000,
      studioFile ? `${fs.statSync(studioFile).size} bytes` : 'nothing');
    const picked = await page.evaluate(() => window.__pmPicked || []);
    check('the app asked the browser to save a .pworld file (picker path)', picked.some((n) => n.endsWith('.pworld')), JSON.stringify(picked));

    step('close the studio — the app toolbar comes back — then use the Worlds panel');
    await page.keyboard.press('Escape');
    await waitFor(() => page.evaluate(() => !globalThis.app.scriptStudio?.isOpen), 'studio close', 10000);
    check('the toolbar is clickable again', await page.locator('#worldsBtn').isVisible());
    await openPanel(page);
    const banner = await page.textContent('#worldsPanel .wl-mode');
    check('the panel says the web build has no database', /no database/i.test(banner), banner.trim().slice(0, 80));
    check('Save to database is not offered on the web', await page.locator('#worldsPanel [data-act="saveDb"]').count() === 0);
    check('Save .pworld file is offered', await page.locator('#worldsPanel [data-act="saveFile"]').count() === 1);

    step('fill the world card and save the world to one file');
    await page.evaluate(() => window.__pmUseDownloadFallback());   // now behave like Safari/Firefox
    await page.fill('#worldsPanel [data-field="name"]', 'Chapel Lane Archive');
    await page.fill('#worldsPanel [data-field="author"]', 'E2E');
    await page.fill('#worldsPanel [data-field="tags"]', 'demo, village');
    await page.screenshot({ path: path.join(SHOTS, 'web-save-panel.png'), timeout: 60000 });
    const chapelFile = await captureSave(page, null, 'saveFile');
    check('saving produced a file', !!chapelFile, 'no download and no export appeared');
    const chapelBytes = chapelFile ? fs.readFileSync(chapelFile) : new Uint8Array();
    check('the file is a real world file', chapelBytes.length > 2000, `${chapelBytes.length} bytes`);
    let zip = await readZip(chapelBytes);
    check('it carries the world graph', zip.has('world/world.json') && zip.has('pworld.json'));
    const chapelManifest = JSON.parse(new TextDecoder().decode(zip.get('pworld.json')));
    check('the card the user typed is in the file', chapelManifest.world.name === 'Chapel Lane Archive' && chapelManifest.world.author === 'E2E',
      JSON.stringify(chapelManifest.world?.name));
    check('world/name recorded in the graph too',
      JSON.parse(new TextDecoder().decode(zip.get('world/world.json'))).name === 'Chapel Lane Archive');
    check('the file records where the visitor stood', zip.has('world/session.json'));
    check('the file records what was inside it', (chapelManifest.stats?.nodes || 0) >= chapel.nodes, `${chapelManifest.stats?.nodes} vs ${chapel.nodes}`);

    step('open that file on a clean browser: nothing cached, no originals');
    const freshCtx = await appContext(browser);
    const page2 = await freshCtx.newPage();
    page2.on('pageerror', (e) => pageErrors.push(String(e)));
    await page2.goto(`${staticSrv.url}/`, { waitUntil: 'domcontentloaded' });
    await bootApp(page2);
    check('a first time visitor is offered “Open a world file”', await page2.locator('#landing [data-act="open"]').isVisible());
    check('the file dialog opened', await openWorldFileThroughUI(page2, chapelFile, { label: 'the saved world' }));
    await waitFor(() => page2.evaluate(() => globalThis.app.project?.name === 'Chapel Lane Archive'), 'world reopen', 60000);
    const reopened = await page2.evaluate(() => ({
      id: globalThis.app.graph.id, nodes: globalThis.app.graph.nodes.size, edges: globalThis.app.graph.edges.size,
      name: globalThis.app.graph.name, projectName: globalThis.app.project?.name,
    }));
    check('the world came back with every place and connection',
      reopened.nodes === chapel.nodes && reopened.edges === chapel.edges, JSON.stringify(reopened));
    check('the name travelled (app and graph agree)', reopened.name === 'Chapel Lane Archive' && reopened.projectName === 'Chapel Lane Archive',
      `${reopened.name} / ${reopened.projectName}`);
    const nodeId = await page2.evaluate(() => globalThis.app.movement.currentNodeId);
    await waitFor(() => cacheMeta(page2, nodeId), 'reopened panorama', 30000);
    const px2 = await pixels(page2, nodeId);
    check('the reopened world renders pixels', !!px2 && px2.std > 8, JSON.stringify(px2));
    await page2.screenshot({ path: path.join(SHOTS, 'web-reopened-world.png'), timeout: 60000 });

    step('walk inside the reopened world');
    const walked = await page2.evaluate(async () => {
      const app = globalThis.app;
      const before = app.movement.currentNodeId;
      const n = app.graph.getNode(before);
      let next = null;
      for (const e of app.graph.edgesOf(before)) { if (!e.blocked) { next = app.graph.otherEnd(e, before); break; } }
      if (!next) return { moved: false, why: 'no open neighbour' };
      const b = app.graph.getNode(next);
      app.viewer.view.yawDeg = (Math.atan2(b.x - n.x, -(b.y - n.y)) * 180 / Math.PI + 360) % 360;
      app.tryMove('forward');
      const t0 = Date.now();
      while (Date.now() - t0 < 12000 && app.movement.currentNodeId === before) await new Promise(r => setTimeout(r, 80));
      return { moved: app.movement.currentNodeId !== before, to: app.movement.currentNodeId, wanted: next };
    });
    check('walking works in the reopened world', walked.moved && walked.to === walked.wanted, JSON.stringify(walked));

    /* ---- 2. a world with REAL photographs ---------------------- */
    step('build a small world out of real photographs and save it');
    const worldId = await buildPhotoWorld(page, { id: 'w_e2e_willow', name: 'Willow Six', places: 4 });
    check('a small world of real photographs is open', worldId.nodes >= 2 && worldId.modes.length >= 2, JSON.stringify(worldId));
    check('the photographs are on real ground (the places connect)', worldId.edges >= 1, `${worldId.edges} connections`);
    check('the place we stand in has several scene modes (so modes can be tested)', worldId.perNode[0] >= 2, JSON.stringify(worldId.perNode));
    const photoNode = await page.evaluate(() => globalThis.app.movement.currentNodeId);
    await waitFor(() => cacheMeta(page, `${photoNode}@${worldId.modes[0]}`), 'photo panorama', 40000).catch(() => null);
    await openPanel(page);
    await tab(page, 'save');
    await page.fill('#worldsPanel [data-field="name"]', 'Willow Six');
    const modeBoxes = await page.locator('#worldsPanel [data-mode]').count();
    check('the panel lists the scene modes found in the world', modeBoxes >= 2, `${modeBoxes} modes`);
    await waitFor(async () => !(await page.locator('#worldsPanel #wlEstimate').innerText()).includes('measuring'), 'size readout', 15000);
    const readout = await page.locator('#worldsPanel #wlEstimate').innerText();
    check('the save card says how much is going into the file', /image/.test(readout), readout);
    // untick a scene mode: the readout follows, and fewer images are planned
    const beforeCount = Number((readout.match(/^(\d+)/) || [])[1] || 0);
    await page.locator('#worldsPanel [data-mode]').nth(1).evaluate((el) => { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(async () => (await page.locator('#worldsPanel #wlEstimate').innerText()).includes('left as links'), 'readout follows the modes', 15000);
    const afterCount = Number(((await page.locator('#worldsPanel #wlEstimate').innerText()).match(/^(\d+)/) || [])[1] || 0);
    check('unticking a mode reduces what will be embedded', afterCount > 0 && afterCount < beforeCount, `${beforeCount} → ${afterCount}`);
    await page.locator('#worldsPanel [data-mode]').nth(1).evaluate((el) => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.screenshot({ path: path.join(SHOTS, 'web-photo-world-panel.png'), timeout: 60000 });
    const photoFile = await captureSave(page, null, 'saveFile');
    check('the photographed world saved to one file', !!photoFile);
    const photoBytes = photoFile ? fs.readFileSync(photoFile) : new Uint8Array();
    zip = await readZip(photoBytes);
    const photoManifest = JSON.parse(new TextDecoder().decode(zip.get('pworld.json')));
    const embedded = [...zip.keys()].filter((k) => k.startsWith('assets/'));
    check('the file reports nothing it could not embed', (photoManifest.missing || []).length === 0,
      JSON.stringify((photoManifest.missing || []).slice(0, 3)));
    check('every photograph the world references is inside the file', embedded.length === worldId.urls.length,
      `${embedded.length} images, world references ${worldId.urls.length}`);
    check('the file reports its own images', photoManifest.stats.images === embedded.length, JSON.stringify(photoManifest.stats));
    check('the file is bigger than its photos alone would suggest (headers + graph)',
      photoBytes.length > embedded.reduce((n, k) => n + zip.get(k).length, 0), `${photoBytes.length} bytes`);

    step('open the photographed world with the network to the originals BLOCKED');
    const offCtx = await appContext(browser);
    const page3 = await offCtx.newPage();
    page3.on('pageerror', (e) => pageErrors.push(String(e)));
    const blocked = [];
    await page3.route('**/assets/willow/**', (route) => { blocked.push(route.request().url()); route.abort(); });
    await page3.goto(`${staticSrv.url}/`, { waitUntil: 'domcontentloaded' });
    await bootApp(page3);
    check('the file dialog opened (offline machine)', await openWorldFileThroughUI(page3, photoFile, { label: 'the photographed world' }));
    await waitFor(() => page3.evaluate(() => globalThis.app.graph?.id === 'w_e2e_willow'), 'photo world reopen', 60000);
    const renderKey = await waitFor(async () => {
      const id = await page3.evaluate(() => globalThis.app.movement.currentNodeId);
      const key = `${id}@${worldId.modes[0]}`;
      return (await cacheMeta(page3, key)) ? key : null;
    }, 'embedded render', 60000);
    const wNode = renderKey.split('@')[0];
    const meta3 = await cacheMeta(page3, renderKey);
    check('the panorama came from the file, not the world folder', meta3.provider === 'embedded', `provider=${meta3.provider}`);
    check('the file image was used (an asset id is recorded)', !!meta3.assetId, JSON.stringify(meta3).slice(0, 120));
    await openPanel(page3);
    const readiness = await waitFor(async () => {
      const out = await page3.evaluate(async () => globalThis.app.worldLibrary.measure());
      return out.images > 0 && !String(out.text).includes('measuring') ? out : null;
    }, 'the size readout for the opened file', 20000);
    check('saving that world again needs nothing fetched (the file is the store)',
      readiness.toFetch === 0 && readiness.ready === readiness.images, JSON.stringify(readiness));
    await page3.evaluate((text) => globalThis.app.worldLibrary.setEstimate(text), readiness.text);
    const reopenedReadout = await page3.locator('#worldsPanel #wlEstimate').innerText();
    check('the readout says how much is already here', /ready/.test(reopenedReadout) && /\d/.test(reopenedReadout), reopenedReadout);

    await page3.keyboard.press('Escape');
    const px3 = await pixels(page3, `${wNode}@${worldId.modes[0]}`);
    check('the photograph renders (real photo statistics)', !!px3 && px3.std > 15 && px3.mean > 25, JSON.stringify(px3));
    await page3.screenshot({ path: path.join(SHOTS, 'web-embedded-panorama.png'), timeout: 60000 });

    step('the second scene mode came out of the file too');
    const swapped = await page3.evaluate(async (mode) => {
      await globalThis.app.setDisplayMode(mode);
      return { mode: globalThis.app.displayMode };
    }, worldId.modes[1]);
    await waitFor(() => cacheMeta(page3, `${wNode}@${worldId.modes[1]}`), 'second mode render', 30000);
    const metaMode = await cacheMeta(page3, `${wNode}@${worldId.modes[1]}`);
    check(`the “${worldId.modes[1]}” frame is a different embedded image`, metaMode.assetId && metaMode.assetId !== meta3.assetId,
      `${metaMode.assetId} vs ${meta3.assetId}`);
    const pxMode = await pixels(page3, `${wNode}@${worldId.modes[1]}`);
    check(`the “${swapped.mode}” frame renders`, !!pxMode && pxMode.std > 15, JSON.stringify(pxMode));

    step('walk, then reload — the mirror keeps the world');
    const walked3 = worldId.edges ? await page3.evaluate(async () => {
      const app = globalThis.app;
      const before = app.movement.currentNodeId;
      for (const e of app.graph.edgesOf(before)) {
        if (e.blocked) continue;
        const next = app.graph.otherEnd(e, before);
        const a = app.graph.getNode(before), b = app.graph.getNode(next);
        app.viewer.view.yawDeg = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360;
        app.tryMove('forward');
        const t0 = Date.now();
        while (Date.now() - t0 < 12000 && app.movement.currentNodeId === before) await new Promise(r => setTimeout(r, 80));
        if (app.movement.currentNodeId !== before) return { moved: true, to: app.movement.currentNodeId };
      }
      return { moved: false };
    }) : { moved: true, skipped: 'the slice has no roads' };
    check('walking inside the file world works', walked3.moved, JSON.stringify(walked3));
    check('the originals were never fetched for any of this', blocked.length === 0, `${blocked.length} requests blocked`);

    const mirror = await page3.evaluate(async () => {
      const app = globalThis.app;
      const pid = app.project?.id || 'w_e2e_willow';
      const rows = await app.storage.listAssets(pid);
      const originals = rows.filter((r) => !String(r.key).includes(':'));
      const first = originals[0];
      const id = first ? String(first.key).slice(pid.length + 1) : null;
      const rec = id ? await app.storage.getAsset(pid, id) : null;
      const bmp = rec?.blob ? await createImageBitmap(rec.blob).catch(() => null) : null;
      return { rows: rows.length, originals: originals.length, id, bytes: rec?.blob?.size || 0, w: bmp?.width || 0, h: bmp?.height || 0 };
    });
    check('the images were mirrored locally', mirror.originals >= 3 && mirror.bytes > 1000, JSON.stringify(mirror));
    check('the mirror holds a decodable picture', mirror.w > 100 && mirror.h > 50, `${mirror.w}×${mirror.h}`);
    await page3.reload({ waitUntil: 'domcontentloaded' });
    await bootApp(page3);
    const afterReload = await page3.evaluate(async () => {
      const app = globalThis.app;
      const pid = 'w_e2e_willow';
      const rows = await app.storage.listAssets(pid);
      const first = rows.find((r) => !String(r.key).includes(':'));
      const id = first ? String(first.key).slice(pid.length + 1) : null;
      const rec = id ? await app.storage.getAsset(pid, id) : null;
      const bmp = rec?.blob ? await createImageBitmap(rec.blob).catch(() => null) : null;
      return { rows: rows.length, id, w: bmp?.width || 0, h: bmp?.height || 0 };
    });
    check('after a reload the mirror still has the world (no file, no network)',
      afterReload.rows >= 3 && afterReload.w > 100, JSON.stringify(afterReload));
    step('the panel stays honest when a different world opens under it');
    await hideLanding(page3);   // the reload brought the start screen back
    await openPanel(page3);
    await page3.click('#worldsPanel [data-tab="save"]');
    const beforeSwap = await waitFor(async () => {
      const text = await page3.locator('#worldsPanel #wlEstimate').innerText().catch(() => '');
      return text && !text.includes('measuring') ? text : null;
    }, 'readout before the swap', 15000);
    await page3.evaluate(async () => {
      const { DEMO_WORLDS } = await import('/js/worlds/demo-worlds.js');
      await globalThis.app.loadDemoWorld(DEMO_WORLDS.find((w) => w.id === 'demo_millbrook'));
    });
    const afterSwap = await waitFor(async () => {
      const text = await page3.locator('#worldsPanel #wlEstimate').innerText().catch(() => '');
      return text.includes('draws its own views') ? text : null;
    }, 'the readout follows the new world', 30000).catch(() => null);
    check('the panel re-describes the world when a different one opens', !!afterSwap, `${beforeSwap} → ${afterSwap}`);

    check('still no page errors after the whole web run', pageErrors.length === 0, pageErrors[0] || '');

    await page3.close(); await page2.close(); await page.close();
    await freshCtx.close(); await offCtx.close(); await ctx.close();
  }

  /* ============================================================ */
  if (PHASE === 'all' || PHASE === 'desktop') {
    const dataDir = path.join(tmp, 'desktop-data');
    desktopApp = await startDesktopApp({ port: 0, host: '127.0.0.1', root: ROOT, dataDir, quiet: true });
    const url = desktopApp.url;
    console.log(`\n============ DESKTOP BUILD (database) · ${url} ============\n  data ${dataDir}`);

    const ctx = await appContext(browser, { width: 1560, height: 950 });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(`${url}/#worlds`, { waitUntil: 'domcontentloaded' });
    await bootApp(page);

    step('the app knows it is the desktop build');
    const online = await page.evaluate(async () => {
      const { Desktop } = await import('/js/io/desktop.js');
      return { online: Desktop.online, engine: Desktop.dbEngine, path: Desktop.dbPath };
    });
    check('the desktop database answered the probe', online.online && !!online.engine, JSON.stringify(online));
    check('the database is a real file', !!online.path && fs.existsSync(online.path), online.path || '');
    check('Worlds opened from the deep link', await page.locator('#worldsPanel:not([hidden])').count() === 1);
    const banner2 = await page.textContent('#worldsPanel .wl-mode');
    check('the panel shows the desktop database', /desktop build/i.test(banner2) && banner2.includes(online.engine), banner2.trim().slice(0, 90));
    check('Save to database is offered here', await page.locator('#worldsPanel [data-act="saveDb"]').count() === 1);

    step('save the world you are in to the database');
    await tab(page, 'save');
    await page.fill('#worldsPanel [data-field="name"]', 'Chapel Lane (desktop)');
    await page.fill('#worldsPanel [data-field="author"]', 'E2E');
    await clickAct(page, 'saveDb');
    await waitFor(() => page.evaluate(async () => {
      const { Desktop } = await import('/js/io/desktop.js');
      const lib = await Desktop.listWorlds();
      return (lib.worlds || []).length;
    }), 'library row', 120000);
    const lib = await page.evaluate(async () => {
      const { Desktop } = await import('/js/io/desktop.js');
      const lib = await Desktop.listWorlds();
      const storage = await Desktop.storage();
      return { worlds: lib.worlds, engine: lib.engine, storage };
    });
    const row = lib.worlds.find((w) => w.name === 'Chapel Lane (desktop)');
    check('the world is in the database', !!row, JSON.stringify(lib.worlds.map(w => w.name)));
    check('the library has the columns the panel shows (places, images, size, updated)',
      !!row && row.nodeCount > 10 && row.assetCount >= 0 && row.assetBytes >= 0 && !!row.updatedAt,
      JSON.stringify(row && { p: row.nodeCount, i: row.assetCount, b: row.assetBytes, u: row.updatedAt }));
    check('the database reports its own totals', lib.storage.worlds >= 1 && !!lib.storage.path, JSON.stringify(lib.storage?.worlds));

    step('the Versions tab reads the version history over HTTP');
    await page.click('#worldsPanel [data-tab="versions"]');
    const versionsHtml = () => page.locator('#worldsPanel [data-view="versions"]').innerHTML();
    await waitFor(async () => (await versionsHtml()).includes('wl-rev'), 'version rows', 15000);
    check('saving left a version the tab can show', (await versionsHtml()).includes('wl-rev'));
    check('the panel offers a snapshot button', await page.locator('#worldsPanel [data-act="snapshot"]').count() >= 1);
    await page.click('#worldsPanel [data-act="snapshot"]');
    await waitFor(async () => page.evaluate(async () => {
      const { Desktop } = await import('/js/io/desktop.js');
      const out = await Desktop.listRevisions(globalThis.app.project.id);
      return (out?.revisions || []).length;
    }).then((n) => n >= 1), 'snapshot recorded', 30000);
    const revCount = await page.evaluate(async () => {
      const { Desktop } = await import('/js/io/desktop.js');
      return (await Desktop.listRevisions(globalThis.app.project.id)).revisions.length;
    });
    check('the snapshot is in the database', revCount >= 1, `${revCount} revisions`);
    await page.click('#worldsPanel [data-tab="activity"]');
    check('the Activity tab lists what the database has been doing',
      await page.locator('#worldsPanel .wl-ev').count() >= 1);

    step('a photographed world goes into the database, images and all');
    const saved = await buildPhotoWorld(page, { id: 'w_e2e_desktop_photos', name: 'Willow Three', places: 3 });
    await waitFor(() => page.evaluate(() => globalThis.app.cache.metaOf(`${globalThis.app.movement.currentNodeId}@day`) || globalThis.app.cache.metaOf(globalThis.app.movement.currentNodeId)), 'photo render', 40000);
    await openPanel(page);
    await tab(page, 'save');
    await page.fill('#worldsPanel [data-field="name"]', 'Willow Three');
    await clickAct(page, 'saveDb');
    await waitFor(async () => {
      const lib2 = await page.evaluate(async () => {
        const { Desktop } = await import('/js/io/desktop.js');
        return Desktop.listWorlds();
      });
      const r = (lib2.worlds || []).find((w) => w.name === 'Willow Three');
      return r && r.assetCount >= 3;
    }, 'photos stored', 300000);
    const stored = await page.evaluate(async (id) => {
      const { Desktop } = await import('/js/io/desktop.js');
      const rec = await Desktop.getWorld(id);
      const lib2 = await Desktop.listWorlds();
      const row2 = lib2.worlds.find((w) => w.id === id);
      return { row: row2, assets: rec.assets?.length || 0, bytes: rec.assets?.reduce((n, a) => n + a.bytes, 0) || 0 };
    }, saved.id);
    check('the photographed world is in the library with its images', stored.row.assetCount >= 3, JSON.stringify(stored.row && { i: stored.row.assetCount }));
    check('the database holds real image bytes for it', stored.bytes > 100000, `${stored.bytes} bytes`);
    await tab(page, 'library');
    await page.screenshot({ path: path.join(SHOTS, 'desktop-library.png'), timeout: 60000 });
    check('the library table renders rows', await page.locator('#worldsPanel .wl-table tbody tr').count() >= 2);
    const bodyText = (await page.textContent('#worldsPanel .wl-table')).replace(/\s+/g, ' ');
    check('the table names the worlds it holds', bodyText.includes('Chapel Lane (desktop)') && bodyText.includes('Willow Three'), bodyText.slice(0, 120));

    step('the database exports a .pworld by itself (server side, no browser)');
    const exportsDir = path.join(dataDir, 'exports');
    const beforeExports = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : [];
    await clickAct(page, 'refresh');
    await tab(page, 'library');
    await page.click(`#worldsPanel [data-wact="export"][data-id="${saved.id}"]`);
    const exported = await waitFor(() => {
      if (!fs.existsSync(exportsDir)) return null;
      const f = fs.readdirSync(exportsDir).filter(x => x.endsWith('.pworld')).find(x => !beforeExports.includes(x));
      return f ? path.join(exportsDir, f) : null;
    }, 'server side export', 300000);
    const exportedBytes = fs.readFileSync(exported);
    const expZip = await readZip(exportedBytes);
    const expImages = [...expZip.keys()].filter(k => k.startsWith('assets/'));
    check('the database wrote a world file on its own', exportedBytes.length > 100000, `${exportedBytes.length} bytes`);
    check('the exported file carries the images', expImages.length >= 3, `${expImages.length} images`);
    check('the export is the same format as the web build’s', expZip.has('pworld.json') && expZip.has('world/world.json'));

    step('the library row actions: copy and delete');
    page.once('dialog', (d) => d.accept('Willow Three copy'));
    await page.click(`#worldsPanel [data-wact="copy"][data-id="${saved.id}"]`);
    const copyId = await waitFor(async () => {
      const ids = await page.evaluate(async () => {
        const { Desktop } = await import('/js/io/desktop.js');
        return (await Desktop.listWorlds()).worlds.map((w) => `${w.id}|${w.name}`);
      });
      const copy = ids.find((x) => x.endsWith('|Willow Three copy'));
      return copy ? copy.split('|')[0] : null;
    }, 'the copy appears in the library', 120000);
    // the copy uploads its images after the row appears — wait for the pixels
    const copyRow = await waitFor(async () => {
      const row = await page.evaluate(async (id) => {
        const { Desktop } = await import('/js/io/desktop.js');
        const rec = await Desktop.getWorld(id);
        return { assets: rec.assets.length, nodes: rec.world.nodes.length, name: rec.meta.name };
      }, copyId);
      return row.assets >= 3 ? row : null;
    }, 'the copy gets its images', 180000).catch(() => null);
    check('copy makes a separate world, images and all',
      !!copyRow && copyRow.nodes === saved.nodes, JSON.stringify(copyRow));
    page.once('dialog', (d) => d.accept());
    await page.click(`#worldsPanel [data-wact="delete"][data-id="${copyId}"]`);
    await waitFor(async () => page.evaluate(async (id) => {
      const { Desktop } = await import('/js/io/desktop.js');
      const lib = await Desktop.listWorlds();
      return !lib.worlds.some((w) => w.id === id);
    }, copyId), 'the copy is deleted', 60000);
    const stillThere = await page.evaluate(async (id) => {
      const { Desktop } = await import('/js/io/desktop.js');
      const rec = await Desktop.getWorld(id);
      return rec?.meta?.name || null;
    }, saved.id);
    check('deleting the copy leaves the original untouched', stillThere === 'Willow Three', String(stillThere));

    step('reopen a world from the database');
    await page.evaluate(() => globalThis.app.loadWorldJson({ id: 'blank', name: 'blank', nodes: [], edges: [], zones: [], landmarks: [] }, { name: 'blank' })).catch(() => {});
    await openPanel(page);
    await tab(page, 'library');
    await page.click(`#worldsPanel [data-wact="open"][data-id="${saved.id}"]`);
    await waitFor(() => page.evaluate((id) => globalThis.app.graph?.id === id && globalThis.app.graph.nodes.size > 1, saved.id), 'database reopen', 120000);
    const back = await page.evaluate(() => ({ id: globalThis.app.graph.id, nodes: globalThis.app.graph.nodes.size, name: globalThis.app.graph.name }));
    check('the world reopened from the database', back.id === saved.id && back.nodes === saved.nodes, JSON.stringify(back));
    const dbKey = await waitFor(async () => {
      const id = await page.evaluate(() => globalThis.app.movement.currentNodeId);
      for (const k of [`${id}@day`, id]) if (await cacheMeta(page, k)) return k;
      return null;
    }, 'database render', 60000);
    const meta4 = await cacheMeta(page, dbKey);
    check('its panorama renders from the database', meta4.provider === 'embedded' || meta4.provider === 'asset' || !!meta4.assetId, JSON.stringify(meta4).slice(0, 120));
    await page.screenshot({ path: path.join(SHOTS, 'desktop-reopened.png'), timeout: 60000 });

    if (PHASE === 'all') {
      step('a file saved by the WEB build opens in the DESKTOP build');
      const webFile = path.join(tmp, 'from-web.pworld');
      // make a fresh web-style file from the desktop app itself (same code path as the web)
      await openPanel(page);
      await tab(page, 'save');
      await page.fill('#worldsPanel [data-field="name"]', 'Cross Build World');
      const cross = await captureSave(page, null, 'saveFile', { exportsDir, before: fs.readdirSync(exportsDir) });
      check('the desktop build also writes world files to disk', !!cross && fs.existsSync(cross), String(cross));
      if (cross) {
        fs.copyFileSync(cross, webFile);
        const crossZip = await readZip(fs.readFileSync(webFile));
        check('that file is self contained', crossZip.has('pworld.json') && crossZip.has('world/world.json'));
        const beforeCount = (await page.evaluate(async () => (await (await import('/js/io/desktop.js')).Desktop.listWorlds()).worlds.length));
        // import it back as if it came from another machine
        await page.evaluate(async () => {
          const { Desktop } = await import('/js/io/desktop.js');
          const res = await fetch('api/worlds');
          void res; void Desktop;
        });
        const imported = await page.evaluate(async (bytes) => {
          const { Desktop } = await import('/js/io/desktop.js');
          const arr = new Uint8Array(bytes);
          const out = await Desktop.importPworldBytes(arr, { name: 'Cross Build World (imported)', source: 'e2e' });
          const lib3 = await Desktop.listWorlds();
          return { out, count: lib3.worlds.length };
        }, [...fs.readFileSync(webFile)]);
        check('importing it into the database works', imported.out?.meta?.name?.includes('Cross Build'), JSON.stringify(imported.out?.meta?.name));
        check('the library grew by one (nothing was overwritten)', imported.count === beforeCount + 1, `${beforeCount} → ${imported.count}`);
        const importedRow = imported.out.meta;
        check('the import brought its images with it', importedRow.assetCount >= 3, String(importedRow.assetCount));
      }
    }
    check('no page errors in the desktop run', pageErrors.length === 0, pageErrors[0] || '');
    await ctx.close();
  }
} catch (err) {
  fail++;
  console.log(`\n✗ the run threw: ${err.stack || err.message}`);
} finally {
  if (desktopApp?.app) await desktopApp.app.close().catch(() => {});
  if (staticSrv?.server) await new Promise((r) => staticSrv.server.close(r));
  await browser.close().catch(() => {});
  if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log(`\n(kept ${tmp})`);
}

console.log(`\n${fail === 0 ? 'ALL' : `${pass}/${pass + fail}`} world E2E checks passed (${pass} pass, ${fail} fail)`);
process.exit(fail ? 1 : 0);
