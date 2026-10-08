/**
 * Panorama Maps — tests/pworld.test.mjs
 *
 * The `.pworld` self-contained world file: export, verify, import, integrity.
 *
 * The decisive property under test: A WORLD FILE CARRIES ITS OWN PIXELS.
 * The images are read back out of the file alone — no device file, no
 * network, no store — which is exactly the "I deleted the photos and the
 * world still walks" promise.
 *
 *   node tests/pworld.test.mjs
 */
import assert from 'node:assert/strict';
import { WorldGraph } from '../js/core/world-graph.js';
import { MapScale } from '../js/core/scale.js';
import {
  exportPworld, importPworld, verifyPworld, inspectPworld, collectWorldAssets,
  pworldFilename, PWORLD_FORMAT, extForMime, formatBytes, worldFileProblem,
} from '../js/io/pworld.js';

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---------------- fixtures ---------------- */
const sha = async (bytes) => {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
};
/** Deterministic fake JPEG-ish payload (binary, not text). */
function fakeImage(seed, size = 4096) {
  const b = new Uint8Array(size);
  b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF;
  let x = seed * 2654435761 % 4294967296;
  for (let i = 3; i < size; i++) { x = (x * 1103515245 + 12345) % 2147483648; b[i] = x & 255; }
  return b;
}
function makeGraph() {
  const g = new WorldGraph(new MapScale({ pixelsPerMeter: 2 }), { id: 'w_test', name: 'Test Hollow' });
  g.addNode({ id: 'a', x: 0, y: 0, name: 'Green', pano: { kind: 'asset', assetId: 'asset_uploaded_one' } });
  g.addNode({ id: 'b', x: 20, y: 0, name: 'Forge', pano: { kind: 'asset', assetId: 'asset_uploaded_one' } });
  g.addNode({ id: 'c', x: 40, y: 0, name: 'Mill', pano: { kind: 'generated' } });
  g.connect('a', 'b'); g.connect('b', 'c');
  g.addLandmark({ id: 'lm', type: 'water', name: 'Pond', x: 10, y: 10, importance: 0.5 });
  g.zones.add({ id: 'z1', name: 'Green', shape: 'circle', cx: 0, cy: 0, radiusPx: 40 });
  return g;
}
/** A store stub standing in for IndexedDB / the desktop database. */
function storeStub(map) {
  return async (assetId) => map.get(assetId) || null;
}

const uploaded = fakeImage(7, 6000);
const uploaded2 = fakeImage(9, 3000);

/* ---------------- the format itself ---------------- */
test('pworld: file name is safe and typed', () => {
  assert.equal(pworldFilename('Willow Parish'), 'Willow-Parish.pworld');
  assert.equal(pworldFilename('  st. hilda’s / church  '), 'st-hildas-church.pworld');
  assert.equal(pworldFilename(''), 'panorama-world.pworld');
  assert.equal(extForMime('image/jpeg'), '.jpg');
  assert.equal(extForMime('image/png'), '.png');
  assert.equal(formatBytes(1536), '2 KB');
  assert.equal(formatBytes(5 * 1048576), '5.0 MB');
});

test('pworld: export → verify → import keeps world AND pixels', async () => {
  const g = makeGraph();
  const store = new Map([['asset_uploaded_one', {
    original: uploaded, mime: 'image/jpeg', name: 'IMG_0001.jpg', width: 4096, height: 2048,
    meta: { sha256: await sha(uploaded) },
  }]]);
  const collected = await collectWorldAssets(g, { resolveAsset: storeStub(store) });
  assert.equal(collected.images, 1, 'two nodes sharing one upload embed ONE image');
  const { bytes, manifest } = await exportPworld({
    world: { id: 'w_test', name: 'Test Hollow', author: 'Ada', description: 'a hollow', tags: ['test'] },
    worldJson: collected.worldJson,
    assets: collected.assets,
    session: { startNodeId: 'a', displayMode: 'day', yawDeg: 12 },
    cacheMeta: { a: { provider: 'asset' } },
  });
  assert.equal(manifest.format, PWORLD_FORMAT);
  assert.equal(manifest.stats.images, 1);
  assert.equal(manifest.world.author, 'Ada');
  assert.ok(bytes.length > uploaded.length, 'archive contains the image bytes plus the world');

  const info = await inspectPworld(bytes);
  assert.equal(info.manifest.world.name, 'Test Hollow');
  assert.deepEqual(info.manifest.world.tags, ['test']);

  const imported = await importPworld(bytes);
  assert.equal(imported.world.name, 'Test Hollow');
  assert.equal(imported.world.nodes.length, 3);
  assert.equal(imported.world.edges.length, 2);
  assert.equal(imported.session.startNodeId, 'a');
  assert.deepEqual(imported.cacheMeta, { a: { provider: 'asset' } });
  assert.equal(imported.assets.length, 1);
  // the decisive check: the bytes come back out of the FILE, not the device
  const back = new Uint8Array(await imported.assets[0].original.arrayBuffer());
  assert.deepEqual([...back], [...uploaded], 'embedded pixels are byte identical');
  assert.equal(await sha(back), await sha(uploaded));
  assert.equal(imported.assets[0].mime, 'image/jpeg');
});

test('pworld: bundled photo worlds embed every scene mode (offline safe)', async () => {
  const g = new WorldGraph(new MapScale(), { id: 'w_willow', name: 'Willow' });
  g.addNode({ id: 'n1', x: 0, y: 0, name: 'Street', pano: { kind: 'urlset', variants: { day: 'assets/willow/day/n1.jpg', night: 'assets/willow/night/n1.jpg' } } });
  g.addNode({ id: 'n2', x: 20, y: 0, name: 'Porch', pano: { kind: 'urlset', variants: { day: 'assets/willow/day/n8.jpg', night: 'assets/willow/night/n8.jpg' } } });
  g.connect('n1', 'n2');
  const files = {
    'assets/willow/day/n1.jpg': fakeImage(1, 2048),
    'assets/willow/night/n1.jpg': fakeImage(2, 1024),
    'assets/willow/day/n8.jpg': fakeImage(3, 2048),
  };
  const asked = [];
  const collected = await collectWorldAssets(g, {
    fetchBytes: async (url) => {
      asked.push(url);
      if (!files[url]) throw new Error('HTTP 404');
      return { bytes: files[url], mime: 'image/jpeg' };
    },
  });
  assert.equal(collected.images, 3, 'three distinct images embedded');
  assert.deepEqual(collected.modes.sort(), ['day', 'night']);
  assert.equal(collected.missing.length, 1, 'the missing night frame is reported, not fatal');
  const nodes = Object.fromEntries(collected.worldJson.nodes.map(n => [n.id, n]));
  assert.equal(nodes.n1.pano.kind, 'embedded');
  assert.equal(Object.keys(nodes.n1.pano.variants).length, 2);
  assert.ok(nodes.n1.pano.variants.day.startsWith('asset_'));
  assert.equal(nodes.n1.pano.origins.day, 'assets/willow/day/n1.jpg', 'provenance kept');
  assert.equal(nodes.n2.pano.kind, 'embedded');
  assert.deepEqual(Object.keys(nodes.n2.pano.variants), ['day'], 'only what exists is embedded');
  assert.equal(nodes.n2.pano.fallbackVariants.night, 'assets/willow/night/n8.jpg', 'the un-embeddable mode keeps its URL');

  const { bytes } = await exportPworld({ world: { name: 'Willow' }, worldJson: collected.worldJson, assets: collected.assets, missing: collected.missing });
  const imported = await importPworld(bytes);
  const n1 = imported.world.nodes.find(n => n.id === 'n1');
  assert.equal(n1.pano.kind, 'embedded');
  const ids = new Set(imported.assets.map(a => a.id));
  assert.ok(Object.values(n1.pano.variants).every(id => ids.has(id)), 'every embedded variant survived the archive');
  const byId = new Map(imported.assets.map(a => [a.id, a]));
  assert.deepEqual([...new Uint8Array(await byId.get(n1.pano.variants.night).original.arrayBuffer())], [...files['assets/willow/night/n1.jpg']]);
  assert.equal(asked.length, 4, 'every declared variant was attempted exactly once');
});

test('pworld: mode selection embeds only the chosen scene modes', async () => {
  const g = new WorldGraph(new MapScale(), { id: 'w', name: 'W' });
  g.addNode({ id: 'n1', x: 0, y: 0, pano: { kind: 'urlset', variants: { day: 'd.jpg', night: 'n.jpg' } } });
  const collected = await collectWorldAssets(g, {
    modes: ['day'],
    fetchBytes: async () => ({ bytes: fakeImage(4, 512), mime: 'image/jpeg' }),
  });
  assert.equal(collected.images, 1);
  const pano = collected.worldJson.nodes[0].pano;
  assert.deepEqual(Object.keys(pano.variants), ['day']);
  assert.equal(pano.fallbackVariants.night, 'n.jpg');
});

test('pworld: uploaded uploads + 2D map image are both carried', async () => {
  const g = makeGraph();
  g.environment.mapUnderlay = { assetId: 'asset_map_img', bounds: { x: 0, y: 0, w: 100, h: 100 } };
  const store = new Map([
    ['asset_uploaded_one', { original: uploaded, mime: 'image/jpeg', meta: { sha256: await sha(uploaded) } }],
    ['asset_map_img', { original: uploaded2, mime: 'image/png', role: 'map', meta: { sha256: await sha(uploaded2) } }],
  ]);
  const collected = await collectWorldAssets(g, { resolveAsset: storeStub(store) });
  assert.equal(collected.images, 2);
  const { bytes } = await exportPworld({ world: { name: 'Test Hollow' }, worldJson: collected.worldJson, assets: collected.assets });
  const imported = await importPworld(bytes);
  assert.equal(imported.assets.length, 2);
  assert.equal(imported.world.environment.mapUnderlay.assetId, 'asset_map_img');
  const mapAsset = imported.assets.find(a => a.id === 'asset_map_img');
  assert.equal(mapAsset.mime, 'image/png');
  assert.deepEqual([...new Uint8Array(await mapAsset.original.arrayBuffer())], [...uploaded2]);
});

test('pworld: missing store entry is reported, never invented', async () => {
  const g = makeGraph();
  const collected = await collectWorldAssets(g, { resolveAsset: storeStub(new Map()) });
  assert.equal(collected.images, 0);
  assert.equal(collected.missing.length, 1);
  assert.equal(collected.missing[0].assetId, 'asset_uploaded_one');
  const { bytes, manifest } = await exportPworld({ world: { name: 'Gap' }, worldJson: collected.worldJson, assets: collected.assets, missing: collected.missing });
  assert.equal(manifest.missing.length, 1);
  const imported = await importPworld(bytes);
  assert.ok(imported.warnings.some(w => /not embedded/.test(w)));
  assert.equal(imported.assets.length, 0);
});

test('pworld: previews and thumbnails ride along', async () => {
  const g = makeGraph();
  const store = new Map([['asset_uploaded_one', {
    original: uploaded, mime: 'image/jpeg', display: fakeImage(11, 800), thumbnail: fakeImage(12, 200),
    width: 4096, height: 2048,
  }]]);
  const collected = await collectWorldAssets(g, { resolveAsset: storeStub(store) });
  assert.equal(collected.assets[0].display.length, 800);
  const { bytes } = await exportPworld({ world: { name: 'P' }, worldJson: collected.worldJson, assets: collected.assets });
  const imported = await importPworld(bytes);
  assert.equal(await imported.assets[0].display.arrayBuffer().then(b => b.byteLength), 800);
  assert.equal(await imported.assets[0].thumbnail.arrayBuffer().then(b => b.byteLength), 200);
});

test('pworld: cover picture is stored and readable', async () => {
  const g = makeGraph();
  const { bytes } = await exportPworld({
    world: { name: 'Covered' }, worldJson: g.toJSON(), assets: [], cover: fakeImage(21, 512),
  });
  const { readCover } = await import('../js/io/pworld.js');
  const cover = await readCover(bytes);
  assert.ok(cover, 'cover.jpg present');
  assert.equal(cover.type, 'image/jpeg');
  assert.equal(await cover.arrayBuffer().then(b => b.byteLength), 512);
});

/* ---------------- integrity ---------------- */
test('pworld: a damaged image is REFUSED with a checksum error', async () => {
  const g = makeGraph();
  const store = new Map([['asset_uploaded_one', { original: uploaded, mime: 'image/jpeg' }]]);
  const collected = await collectWorldAssets(g, { resolveAsset: storeStub(store) });
  const { bytes } = await exportPworld({ world: { name: 'Vault' }, worldJson: collected.worldJson, assets: collected.assets });

  // corrupt one byte inside the stored image payload
  const needle = [...uploaded.slice(0, 3)];
  let hit = -1;
  for (let i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] === needle[0] && bytes[i + 1] === needle[1] && bytes[i + 2] === needle[2] && bytes[i + 200] === uploaded[200]) { hit = i; break; }
  }
  assert.ok(hit > 0, 'image payload located inside the archive');
  const damaged = new Uint8Array(bytes);
  damaged[hit + 200] = (damaged[hit + 200] + 1) & 255;
  await assert.rejects(() => verifyPworld(damaged), /checksum mismatch/, 'damaged pixels never load silently');
  await assert.rejects(() => importPworld(damaged), /checksum mismatch/);
});

test('pworld: importing hands the cover back (readers never unzip twice)', async () => {
  const g = makeGraph();
  const { bytes } = await exportPworld({
    world: { name: 'Covered Twice' }, worldJson: g.toJSON(), assets: [], cover: fakeImage(22, 640),
  });
  const imported = await importPworld(bytes);
  assert.ok(imported.cover, 'the import carries the cover');
  assert.equal(imported.cover.type, 'image/jpeg');
  assert.equal(await imported.cover.arrayBuffer().then((b) => b.byteLength), 640);
  assert.deepEqual([...new Uint8Array(await imported.cover.arrayBuffer())], [...fakeImage(22, 640)],
    'byte for byte the picture that went in');
  const bare = await importPworld((await exportPworld({ world: { name: 'Bare' }, worldJson: makeGraph().toJSON(), assets: [] })).bytes);
  assert.equal(bare.cover, null, 'a file with no cover reports none');
});

test('pworld: a damaged world graph is REFUSED', async () => {
  const g = makeGraph();
  const { bytes } = await exportPworld({ world: { name: 'G' }, worldJson: g.toJSON(), assets: [] });
  const damaged = new Uint8Array(bytes);
  const pos = findBytes(damaged, new TextEncoder().encode('Test Hollow'));
  assert.ok(pos > 0);
  damaged[pos] = 'X'.charCodeAt(0);   // rename inside world/world.json → hash breaks
  await assert.rejects(() => verifyPworld(damaged), /damaged/);
});

test('pworld: a foreign zip is rejected, not guessed at', async () => {
  const { writeZip } = await import('../js/io/zipex.js');
  const te = new TextEncoder();
  const junk = writeZip([{ path: 'hello.txt', data: te.encode('not a world') }]);
  await assert.rejects(() => inspectPworld(junk), /not a Panorama World file|pworld\.json missing/);
  await assert.rejects(() => importPworld(junk), /not a Panorama World file/);
});

test('pworld: newer format versions ask for an app update instead of misreading', async () => {
  const g = makeGraph();
  const { bytes } = await exportPworld({ world: { name: 'Future' }, worldJson: g.toJSON(), assets: [] });
  const entries = await (await import('../js/io/zipex.js')).readZip(bytes);
  const manifest = JSON.parse(new TextDecoder().decode(entries.get('pworld.json')));
  manifest.formatVersion = 99;
  const te = new TextEncoder();
  const patched = (await import('../js/io/zipex.js')).writeZip(
    [...entries.entries()].map(([path, data]) => ({ path, data: path === 'pworld.json' ? te.encode(JSON.stringify(manifest)) : data })),
  );
  await assert.rejects(() => importPworld(patched), /newer app/);
});

/* ---------------- what the person holding the file is told ---------------- */

test('pworld: every refusal explains itself in words a person can act on', () => {
  const notAWorld = worldFileProblem(new Error('not a zip archive (EOCD not found)'));
  assert.match(notAWorld, /not a world file/, 'a text file dressed up as .pworld says what it is');
  assert.match(notAWorld, /Save world file/, 'and says how the real ones are made');

  const damaged = worldFileProblem(new Error('world data is damaged (checksum mismatch)'));
  assert.match(damaged, /damaged/);
  assert.match(damaged, /checksum/, 'the technical reason survives, for a bug report');

  const damagedImage = worldFileProblem(new Error('image is damaged (checksum mismatch): assets/day/a.jpg'));
  assert.match(damagedImage, /a\.jpg/, 'a damaged image names the image');

  const noData = worldFileProblem(new Error('pworld.json missing — not a Panorama World file'));
  assert.match(noData, /no Panorama World data/, 'a foreign zip is not blamed on the user');

  const tooNew = worldFileProblem(new Error('world file v99 needs a newer app'));
  assert.match(tooNew, /update the app/, 'a newer format points at the fix');

  const empty = worldFileProblem(new Error('world data missing'));
  assert.match(empty, /incomplete/);

  const unknown = worldFileProblem(new Error('HTTP 500'));
  assert.equal(unknown, 'HTTP 500', 'an unknown failure is passed through, never swallowed');
  assert.equal(worldFileProblem(null), 'unknown problem', 'and a missing error still says something');
});

/* ---------------- world JSON safety (untrusted input) ---------------- */
test('pworld: a world with dangling edges is rejected by the shared validator', async () => {
  const { bytes } = await exportPworld({
    world: { name: 'Broken' },
    worldJson: { id: 'x', name: 'Broken', nodes: [{ id: 'a', x: 0, y: 0 }], edges: [{ id: 'e', a: 'a', b: 'ghost' }] },
    assets: [],
  });
  await assert.rejects(() => importPworld(bytes), /unknown node/);
});

/* ---------------- helpers ---------------- */
function findBytes(hay, needle) {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/* ---------------- runner ---------------- */
(async () => {
  console.log('Panorama Maps — .pworld world-file test suite');
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
