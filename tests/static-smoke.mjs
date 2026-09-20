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

(async () => {
  console.log('Panorama Maps — static smoke');
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
