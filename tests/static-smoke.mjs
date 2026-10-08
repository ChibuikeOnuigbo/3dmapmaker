/**
 * Panorama Maps — tests/static-smoke.mjs
 *
 * Static integration smoke test: verifies the wiring that unit tests can't —
 * import graph resolution, HTML element IDs used by JS, referenced assets,
 * service-worker shell list, and product terminology rules (Spec §2).
 *
 *   node tests/static-smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let passed = 0, failed = 0;
const tests = [];
const test = (n, f) => tests.push([n, f]);

/* ---------------- import graph ---------------- */
test('all ES module imports resolve to files', () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = read(file);
    const re = /(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;             // bare specifiers: none expected
      const target = path.normalize(path.join(path.dirname(file), spec));
      assert.ok(exists(target), `${file} imports missing module ${spec}`);
      walk(target);
    }
    const sideRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = sideRe.exec(src))) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const target = path.normalize(path.join(path.dirname(file), spec));
      assert.ok(exists(target), `${file} dynamic-imports missing ${spec}`);
    }
  };
  walk('js/main.js');
  assert.ok(seen.size >= 15, `expected a real module graph, got ${seen.size}`);
  console.log(`    resolved ${seen.size} modules`);
});

/* ---------------- HTML <-> JS id wiring ---------------- */
test('every #id used by JS exists in index.html (or is created by JS)', () => {
  const html = read('index.html');
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  // JS-created ids (panels render their own markup)
  const jsText = ['js/main.js', 'js/editors/simple-editor.js', 'js/editors/advanced-editor.js'].map(read).join('\n');
  const createdIds = new Set([...jsText.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const usedIds = new Set();
  for (const m of jsText.matchAll(/\$\(['"]#([A-Za-z0-9_-]+)['"]\)/g)) usedIds.add(m[1]);
  for (const m of jsText.matchAll(/getElementById\(['"]([A-Za-z0-9_-]+)['"]\)/g)) usedIds.add(m[1]);
  for (const id of usedIds) {
    assert.ok(htmlIds.has(id) || createdIds.has(id), `JS uses #${id} but it never exists`);
  }
  console.log(`    checked ${usedIds.size} element ids`);
});

test('index.html references resolve (css/js/manifest)', () => {
  const html = read('index.html');
  for (const m of html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
    const ref = m[1];
    if (ref.startsWith('data:') || ref.startsWith('http')) continue;
    assert.ok(exists(ref), `index.html references missing file ${ref}`);
  }
});

test('service worker shell list only contains existing files', () => {
  const sw = read('sw.js');
  const shell = [...sw.matchAll(/'\.\/([^']+)'/g)].map(m => m[1]).filter(p => !p.includes('location'));
  for (const p of shell) assert.ok(exists(p), `sw.js caches missing file ${p}`);
});

test('icon sprite: every <use href="#i-..."> has a matching symbol', () => {
  const html = read('index.html');
  const symbols = new Set([...html.matchAll(/symbol id="(i-[^"]+)"/g)].map(m => m[1]));
  const jsText = ['js/main.js', 'js/editors/simple-editor.js', 'js/editors/advanced-editor.js'].map(read).join('\n');
  for (const m of [...html.matchAll(/use href="#(i-[^"]+)"/g), ...jsText.matchAll(/#(i-[a-z-]+)/g)]) {
    assert.ok(symbols.has(m[1]), `icon #${m[1]} used but not defined in sprite`);
  }
});

/* ---------------- terminology (Spec §2) ---------------- */
test('product terminology: no 3D-builder positioning in UI text', () => {
  const html = read('index.html').toLowerCase();
  const banned = ['3d builder', '3d world builder', '3d modeling', '3d terrain', 'game engine'];
  for (const b of banned) assert.ok(!html.includes(b), `UI contains banned term: ${b}`);
});
test('product name present', () => {
  assert.ok(read('index.html').includes('Panorama Maps'));
});

/* ---------------- css sanity ---------------- */
test('css braces balanced and no url() to missing assets', () => {
  const css = read('css/app.css');
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
  for (const m of css.matchAll(/url\(['"]?([^)'")]+)['"]?\)/g)) {
    assert.ok(!m[1].startsWith('http'), `external CSS dependency found: ${m[1]} (offline rule)`);
  }
});

test('studio interactions are pointer-cancel safe (no stranded gestures)', () => {
  const se = read('js/editors/script-editor.js');
  // every window-level drag (wire, marquee, card drag, resize, minimap)
  // must listen for pointercancel — a stolen touch must never strand a gesture
  const wins = (se.match(/window\.addEventListener\('pointermove',/g) || []).length;
  const cancels = (se.match(/window\.addEventListener\('pointercancel',/g) || []).length;
  assert.ok(wins >= 4 && cancels >= wins, `window drags=${wins} but cancels=${cancels}`);
  // the Esc-cancel path must detach the wire drag's listeners (hDetach)
  assert.ok(se.includes('this.drag.hDetach = detach'), 'wire drag must expose its detacher to cancelDrag()');
  assert.ok(se.includes('e2.pointerId !== this.drag.pointerId'), 'wire drag must ignore foreign pointers');
  // closing the studio mid-wiring must not strand a pending wire
  assert.ok(/close\(\)\s*{[^}]*cancelDrag\(\)/s.test(se), 'close() must cancel a pending wire drag');
  // marquee guard flag must be releasable on cancel (soft-lock regression)
  assert.ok(se.includes('this._marqueeActive = false;'), 'marquee cleanup must release the band guard');
});

test('living world: every mode button wired end-to-end (btn → ENV → immersion → layer)', () => {
  const html = read('index.html');
  const main = read('js/main.js');
  const viewer = read('js/viewer/viewer.js');
  const modes = ['day', 'rain', 'night', 'dawn', 'snow', 'storm'];
  // the six modes live in the one-button scene selector: SCENE_MODES (rows
  // painted with data-mode keys) + ENV patches, both in main.js
  assert.ok(html.includes('id="sceneBtn"'), 'scene selector button missing');
  assert.ok(html.includes('id="scenePop"'), 'scene popup missing');
  assert.ok(html.includes('id="sceneUse"') && html.includes('id="sceneTxt"'), 'scene button face (icon+label) missing');
  for (const m of modes) {
    assert.ok(new RegExp(`${m}:\\s*\\{ icon:\\s*'i-`).test(main), `SCENE_MODES entry missing: ${m}`);
    assert.ok(new RegExp(`${m}:\\s*\\{ timeOfDay:\\s*'`).test(main), `ENV patch missing: ${m}`);
  }
  assert.ok(main.includes('b.dataset.mode = key'), 'scene rows must carry data-mode for dispatch');
  assert.ok(main.includes('_paintScenePop') && main.includes('_syncSceneFace'), 'scene painters missing');
  assert.ok(main.includes(`this._placePop(scenePop, '#sceneBtn')`), 'scene popup must anchor to its button');
  for (const icon of ['i-sun', 'i-rain', 'i-moon', 'i-dawn', 'i-snow', 'i-storm']) {
    assert.ok(html.includes(`id="${icon}"`), `icon symbol missing: ${icon}`);
  }
  for (const flag of ['night', 'fireflies', 'butterflies', 'sunrays', 'snow', 'storm', 'balloon', 'owl', 'mist', 'rabbits']) {
    assert.ok(main.includes(`viewer.immersion.${flag} =`), `immersion flag not mapped: ${flag}`);
    assert.ok(viewer.includes(`immersion.${flag}`), `viewer never reads flag: ${flag}`);
  }
  for (const layer of ['_renderStars', '_renderSunRays', '_renderBalloons', '_renderMist', '_renderOwl', '_renderBirds', '_renderActors', '_renderRabbits', '_renderRipples', '_renderButterflies', '_renderFireflies', '_renderRain', '_renderSnow']) {
    assert.ok(viewer.includes(`this.${layer}(now, dt, cvs)`), `layer not in _renderFx: ${layer}`);
  }
  assert.ok(main.includes('water: this._envWater'), 'water regions must reach viewer anchors');
});

test('accessory popup: every listed effect is a real viewer flag, rows are painted & persisted', () => {
  const html = read('index.html');
  const main = read('js/main.js');
  const viewer = read('js/viewer/viewer.js');
  assert.ok(html.includes('id="accessoryBtn"') && html.includes('id="accessoryPop"') && html.includes('id="acRows"') && html.includes('id="acReset"'),
    'accessory UI (button/popup/rows/reset) must all exist');
  const defs = [...main.matchAll(/\{ key: '([a-z]+)',\s+label:/g)].map(m => m[1]);
  assert.ok(defs.length >= 15, `expected at least 15 accessory effects, got ${defs.length}`);
  const immersionHead = viewer.slice(viewer.indexOf('this.immersion ='), viewer.indexOf('transitionMs: 420'));
  for (const k of defs) assert.ok(immersionHead.includes(`${k}:`), `accessory "${k}" is not a viewer.immersion flag`);
  assert.ok(main.includes('_paintAccessoryPop') && main.includes('data-ac='), 'rows must be painted from ACCESSORY_DEFS');
  assert.ok(main.includes('prefsSvc.save({ accessory: this.accessory })'), 'toggles must persist via prefs');
  assert.ok(main.includes("['#accessoryPop', '#accessoryBtn']"), 'resize reposition loop must include the accessory popup');
});

test('painter realism: world-space decal noise paints cracks, stains and tyre polish', () => {
  const provider = read('js/gen/provider.js');
  assert.ok(provider.includes('function vnoise('), 'vnoise helper missing');
  for (const mark of ['401', '402', '403']) assert.ok(provider.includes(`seed + ${mark}`), `decal octave ${mark} missing`);
  assert.ok(provider.includes('tyre polish'), 'tyre-polish bands missing');
  assert.ok(provider.includes("weather === 'snow'"), 'decals must respect snowpack');
});

test('custom cursor set: black gamified family is complete and well-formed', () => {
  const css = read('css/app.css');
  for (const name of ['--cur-blade', '--cur-target', '--cur-cross', '--cur-move', '--cur-grab', '--cur-grabbing', '--cur-nwse', '--cur-text', '--cur-deny']) {
    assert.ok(css.includes(`${name}:`), `missing cursor ${name}`);
  }
  for (const m of css.matchAll(/(--cur-[\w-]+):\s*url\("data:image\/svg\+xml,([^"]*)"\)\s+(\d+)\s+(\d+),\s*([\w-]+);/g)) {
    const [, name, enc, hx, hy, kw] = m;
    const svg = decodeURIComponent(enc);
    assert.ok(svg.startsWith("<svg ") && svg.includes("width='32'") && svg.includes("height='32'"),
      `${name}: SVG cursor must declare fixed 32x32 size (Firefox requirement)`);
    assert.ok(svg.includes("fill='#") || svg.includes("stroke='#"), `${name}: cursor must carry the black/neon palette`);
    assert.ok(svg.endsWith('</svg>'), `${name}: malformed SVG cursor`);
    assert.ok(Number(hx) <= 32 && Number(hy) <= 32, `${name}: hotspot outside the 32px image`);
    assert.ok(/^(auto|pointer|move|text|grab|grabbing|crosshair|nwse-resize|not-allowed)$/.test(kw), `${name}: bad fallback keyword ${kw}`);
  }
});

/* ---------------- the world file + the worlds surface ---------------- */
test('world file: the .pworld modules exist, load and are in the offline shell', () => {
  for (const f of ['js/io/pworld.js', 'js/io/desktop.js', 'js/ui/world-library.js', 'desktop/db.mjs', 'desktop/server.mjs', 'desktop/main.mjs', 'desktop/cli.mjs']) {
    assert.ok(exists(f), `missing ${f}`);
  }
  const sw = read('sw.js');
  for (const f of ['./js/io/pworld.js', './js/io/desktop.js', './js/ui/world-library.js']) {
    assert.ok(sw.includes(`'${f}'`), `service worker shell must cache ${f}`);
  }
  assert.ok(/panorama-maps-shell-v25/.test(sw), 'shell cache must be updated to v25');
});

test('world file: every world can be saved — all surfaces offer the button', () => {
  const main = read('js/main.js');
  const simple = read('js/editors/simple-editor.js');
  const adv = read('js/editors/advanced-editor.js');
  assert.ok(main.includes('saveWorldFile'), 'App must own saveWorldFile');
  assert.ok(main.includes('async saveWorldFile'), 'saveWorldFile must be a real method');
  assert.ok(/async saveWorldFile[\s\S]*collectWorldAssets/.test(main), 'saving a world must collect its images');
  const script = read('js/editors/script-editor.js');
  assert.ok(/data-saveworld/.test(script), 'the scripting studio must offer Save world');
  assert.ok(/data-saveworld[\s\S]{0,400}saveWorldFile\(\)/.test(script), 'that button must call app.saveWorldFile');
  for (const [name, src] of [['simple editor', simple], ['advanced editor', adv]]) {
    assert.ok(/data-act="saveWorld"/.test(src), `${name} must offer Save world file`);
    assert.ok(/saveWorld'\s*\)\s*this\.app\.saveWorldFile/.test(src.replace(/\n/g, ' ')), `${name} action must call app.saveWorldFile`);
  }
  // the Panels menu binds the world rows by id, never by position
  assert.ok(main.includes("wire('miSaveWorld'"), 'menu must wire Save world file');
  assert.ok(/wire\('miSaveWorld', \(\) => \{ this\.landing\?\.hide\(\); this\.worldLibrary\?\.open\('save'\)/.test(main),
    'Save world file must open the save section of the worlds panel');
  assert.ok(/link === 'save-world'\) \{ this\.landing\?\.hide\(\); this\.worldLibrary\?\.open\('save'\)/.test(main),
    'the #save-world deep link (desktop menu) must open the save section');
  assert.ok(main.includes("wire('miOpenWorld'"), 'menu must wire Open world file');
  assert.ok(!/items\[items\.length - \d+\]/.test(main), 'menu rows must not be bound by position');
});

test('world file: opening a file makes its embedded images the working set', () => {
  const main = read('js/main.js');
  assert.ok(main.includes('_sessionAssets'), 'a session store for embedded images is required');
  assert.ok(/loadWorldJson\(imported\.world, \{ project, name, sessionAssets \}\)/.test(main),
    'opening a file must hand its images to the world before it is adopted');
  assert.ok(main.includes('_renderEmbeddedPanorama'), 'the viewer must render embedded photo sets');
  assert.ok(main.includes("kind === 'embedded'"), 'embedded panorama kind must be handled');
  // desktop mirroring: a file opened in the desktop build lands in the database
  assert.ok(/importPworldBytes/.test(main), 'the desktop build must mirror an opened file into the database');
});

test('world file: legacy .pmap still saves and opens, and the extensions are distinct', () => {
  const storage = read('js/io/storage.js');
  assert.ok(storage.includes("pworld: { description: 'Panorama World'"), 'fsAccess must know the .pworld flavour');
  assert.ok(storage.includes("'application/zip': ['.pmap']"), 'the .pmap archive must stay supported');
  const main = read('js/main.js');
  assert.ok(main.includes('async openAnyFile'), 'one entry point must route by extension');
  assert.ok(/\.endsWith\('\.pmap'\)\s*\?\s*this\.openProject\(file\)\s*:\s*this\.openWorldFile\(file\)/.test(main),
    'the extension must decide which opener runs');
});

test('worlds panel: the save surface and the library exist in the DOM', () => {
  const html = read('index.html');
  assert.ok(html.includes('id="worldsPanel"'), 'the worlds panel host is missing');
  assert.ok(html.includes('id="worldsBtn"'), 'the toolbar Worlds button is missing');
  assert.ok(html.includes('symbol id="i-db"'), 'the database icon is missing');
  const lib = read('js/ui/world-library.js');
  for (const piece of ['Save new world', 'Save to worlds database', 'Save .pworld file', 'Worlds', 'Versions', 'Activity']) {
    assert.ok(lib.includes(piece), `worlds panel must offer: ${piece}`);
  }
  assert.ok(lib.includes('no database by design'), 'the web build must say plainly that it has no database');
  // the save card is the section a new world is named and saved from
  for (const field of ['data-field="name"', 'data-field="author"', 'data-field="description"', 'data-field="tags"', 'data-mode=']) {
    assert.ok(lib.includes(field), `the save card must offer ${field}`);
  }
  for (const act of ['saveDb', 'saveFile', 'saveBoth', 'openFile', 'refresh']) {
    assert.ok(lib.includes(`data-act="${act}"`), `the worlds panel must offer ${act}`);
  }
  // the save card measures itself before writing (and follows the checkboxes)
  assert.ok(lib.includes('id="wlEstimate"'), 'the save card must show what the file will contain');
  assert.ok(/async measure\(/.test(lib), 'the panel must be able to measure a save');
  assert.ok(lib.includes("worldChanged()"), 'the panel must redraw when the open world changes');
  assert.ok(/addEventListener\('change', \(\) => \{[\s\S]{0,120}setEstimate\(/.test(lib),
    'unticking a scene mode must re-measure');
  const main = read('js/main.js');
  assert.ok(/worldLibrary\?\.worldChanged\(\)/.test(main),
    'every world that becomes current must tell the worlds panel');
});

test('the offline shell caches every module the shell itself needs', () => {
  const sw = read('sw.js');
  const i = sw.indexOf('const SHELL = [');
  const list = sw.slice(i, sw.indexOf('];', i));
  const shell = new Set([...list.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1] || 'index.html'));
  assert.ok(shell.size >= 20, `the shell list looks wrong (${shell.size} entries)`);
  for (const p of shell) assert.ok(exists(p), `the shell caches ${p}, which is not there`);
  // a shell file that imports a module the shell does not cache boots online
  // and dies offline — exactly the bug this test exists for
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = read(file);
    const specs = [
      ...[...src.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ...[...src.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ];
    for (const spec of specs) {
      let target = null;
      if (spec.startsWith('.')) target = path.normalize(path.join(path.dirname(file), spec));
      else if (spec.startsWith('/')) target = spec.slice(1);               // absolute: app root
      if (!target) continue;
      assert.ok(shell.has(target), `${target} is imported by ${file} but not cached by the offline shell`);
      walk(target);
    }
  };
  for (const p of shell) if (p.endsWith('.js')) walk(p);
});

test('the web build answers the desktop bridge instead of 404ing', () => {
  assert.ok(exists('api/health'), 'the web build ships a static api/health marker');
  const marker = JSON.parse(read('api/health'));
  assert.equal(marker.mode, 'web', 'the static marker must say this is the web build');
  assert.notEqual(marker.mode, 'desktop', 'the static marker must never claim the desktop build');
  assert.equal(marker.database, null, 'the web build has no database, by design');
  const server = read('desktop/server.mjs');
  assert.ok(server.includes("'GET /api/health'"), 'the desktop server answers /api/health itself');
  const bridge = read('js/io/desktop.js');
  assert.ok(/mode !== 'desktop'/.test(bridge), 'the bridge decides by the answer, never by a request failing');
});

test('desktop: the app is served by its own server and speaks relative URLs', () => {
  const server = read('desktop/server.mjs');
  for (const route of ['/api/health', '/api/worlds', '/api/import', '/api/save-file']) {
    assert.ok(server.includes(route), `desktop server missing route ${route}`);
  }
  assert.ok(server.includes('safeJoin'), 'static serving must be confined to the app folder');
  const db = read('desktop/db.mjs');
  for (const t of ['worlds', 'assets', 'revisions', 'events', 'settings']) {
    assert.ok(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`).test(db), `database table missing: ${t}`);
  }
  assert.ok(db.includes('content addressed') || db.includes('sha256'), 'images must be content addressed');
  const bridge = read('js/io/desktop.js');
  assert.ok(!/https?:\/\/(localhost|127\.0\.0\.1)/.test(bridge), 'the bridge must use relative URLs, never a hardcoded loopback host');
  assert.ok(bridge.includes("fetch('api/health'"), 'the bridge probes the desktop backend');
});

(async () => {
  console.log('Panorama Maps — static smoke');
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
