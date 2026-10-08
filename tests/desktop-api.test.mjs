/**
 * Panorama Maps — tests/desktop-api.test.mjs
 *
 * The desktop build, end to end: real HTTP server, real database, real files.
 * Exercises the whole chain the desktop app uses —
 *
 *   create world → upload images → save to the database → list the library →
 *   export a .pworld (server side) → import that file back → delete → restore
 *   a revision → verify the database tells the truth about sizes.
 *
 *   node tests/desktop-api.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDesktopApp } from '../desktop/server.mjs';
import { WorldDatabase, defaultDataDir } from '../desktop/db.mjs';
import { exportPworld } from '../js/io/pworld.js';

let passed = 0, failed = 0;
const tests = [];
const test = (n, f) => tests.push([n, f]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-desktop-'));
const dataDir = path.join(tmp, 'data');

function fakeImage(seed, size = 2048) {
  const b = new Uint8Array(size);
  b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF;
  let x = seed * 2654435761 % 4294967296;
  for (let i = 3; i < size; i++) { x = (x * 1103515245 + 12345) % 2147483648; b[i] = x & 255; }
  return b;
}

const smallWorld = (name) => ({
  id: 'w_' + name.toLowerCase().replace(/\W+/g, '_'),
  name,
  scale: { pixelsPerMeter: 2, movement: { stepPixels: 12 } },
  environment: { timeOfDay: 'day', weather: 'clear', features: [] },
  settings: { walkSpeedMps: 4 },
  zones: [], landmarks: [{ id: 'lm1', type: 'water', name: 'Pond', x: 10, y: 10, importance: 0.5 }],
  nodes: [
    { id: 'n1', x: 0, y: 0, name: 'Green', pano: { kind: 'asset', assetId: 'asset_testimg0001' } },
    { id: 'n2', x: 20, y: 0, name: 'Mill', pano: { kind: 'generated' } },
  ],
  edges: [{ id: 'e1', a: 'n1', b: 'n2', distPx: 20, distM: 10, blocked: false }],
});

let app, base;
const api = (p, opts) => fetch(base + p, opts);
const jget = async (p, opts) => (await api(p, opts)).json();

/* ---------------- boot ---------------- */
test('desktop: server boots and reports a real database', async () => {
  app = await createDesktopApp({ dataDir, quiet: true });
  const info = await app.listen({ port: 0 });
  base = info.url;
  const health = await jget('/api/health');
  assert.equal(health.mode, 'desktop');
  assert.ok(['sqlite', 'json'].includes(health.db.engine));
  assert.ok(health.db.path.startsWith(dataDir), 'the database lives in the app data directory');
  const idx = await api('/index.html');
  assert.equal(idx.status, 200);
  assert.ok((await idx.text()).includes('Panorama Maps'), 'the app itself is served');
  const missing = await api('/../etc/passwd');
  assert.ok([404, 403].includes(missing.status), 'path traversal is refused');
});

test('desktop: create a world → it appears in the library with columns', async () => {
  const world = smallWorld('Hollow');
  const put = await api(`/api/worlds/${world.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ worldJson: world, name: 'Hollow', author: 'Ada', description: 'test world', tags: ['demo'], session: { startNodeId: 'n1', displayMode: 'day' } }),
  });
  assert.equal(put.status, 200);
  const lib = await jget('/api/worlds');
  assert.equal(lib.count, 1);
  const w = lib.worlds[0];
  assert.equal(w.name, 'Hollow');
  assert.equal(w.author, 'Ada');
  assert.equal(w.nodeCount, 2);
  assert.equal(w.edgeCount, 1);
  assert.equal(w.landmarkCount, 1);
  assert.deepEqual(w.tags, ['demo']);
  assert.ok(w.createdAt && w.updatedAt, 'timestamps for the library column');
});

test('desktop: images upload into the database and stream back byte-identical', async () => {
  const bytes = fakeImage(3, 3000);
  const res = await api('/api/worlds/w_hollow/assets/asset_testimg0001', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream', 'x-pm-mime': 'image/jpeg',
      'x-pm-name': 'IMG_0001.jpg', 'x-pm-role': 'panorama', 'x-pm-width': '4096', 'x-pm-height': '2048',
    },
    body: bytes,
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.asset.bytes, 3000);
  assert.equal(out.asset.sha256.length, 64);
  const back = new Uint8Array(await (await api(out.asset.url)).arrayBuffer());
  assert.deepEqual([...back], [...bytes], 'the database returns exactly what it stored');
  const rec = await jget('/api/worlds/w_hollow');
  assert.equal(rec.assets.length, 1);
  assert.equal(rec.assets[0].name, 'IMG_0001.jpg');
  assert.equal(rec.meta.assetBytes, 3000, 'the size column is real, not estimated');
});

test('desktop: the same image is stored once (content addressed)', async () => {
  const bytes = fakeImage(3, 3000);   // same content as the previous test
  await api('/api/worlds/w_hollow/assets/asset_dup_check', {
    method: 'POST', headers: { 'x-pm-mime': 'image/jpeg' }, body: bytes,
  });
  let files = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files++; };
  walk(path.join(dataDir, 'assets'));
  assert.equal(files, 1, 'two rows, one file on disk');
  const rec = await jget('/api/worlds/w_hollow');
  assert.equal(rec.assets.length, 2, 'both rows exist for the app');
});

test('desktop: exporting a world to .pworld embeds its images and writes a file', async () => {
  const res = await jget('/api/worlds/w_hollow/pworld');
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(res.saved), `exported file exists: ${res.saved}`);
  assert.ok(res.saved.endsWith('.pworld'));
  assert.equal(res.manifest.images, 1, 'the world is embedded — including only the images it actually uses');
  assert.ok(res.manifest.fileBytes > 3000, 'the image plus the world data are in the file');

  // exporting also materialises the world: the database keeps what was fetched
  const rec = await jget('/api/worlds/w_hollow');
  assert.ok(rec.meta.assetCount >= 1, 'the database now holds the images the world uses');
  assert.ok(rec.meta.assetBytes > 0);

  // the file must be importable by the WEB build too (same format, one spec)
  const { importPworld } = await import('../js/io/pworld.js');
  const imported = await importPworld(fs.readFileSync(res.saved));
  assert.equal(imported.world.name, 'Hollow');
  assert.equal(imported.assets.length, 1);
  const real = imported.assets.find(a => a.id === 'asset_testimg0001');
  assert.deepEqual([...new Uint8Array(await real.original.arrayBuffer())], [...fakeImage(3, 3000)]);
  const node = imported.world.nodes.find(n => n.id === 'n1');
  assert.equal(node.pano.kind, 'asset');
  assert.equal(node.pano.assetId, 'asset_testimg0001');
});

test('desktop: importing a .pworld file stores world + pixels in the database', async () => {
  const file = fs.readdirSync(path.join(dataDir, 'exports')).find(f => f.endsWith('.pworld'));
  const abs = path.join(dataDir, 'exports', file);
  const res = await api('/api/import?name=Hollow%20Copy', { method: 'POST', body: fs.readFileSync(abs) });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.meta.name, 'Hollow Copy');
  assert.equal(out.meta.assetCount, 1);
  const lib = await jget('/api/worlds?q=hollow');
  assert.equal(lib.count, 2, 'a copy is a separate world in the library');
  const copy = await jget('/api/worlds/' + out.meta.id);
  assert.equal(copy.assets.length, 1);
  assert.ok(copy.revisions.length >= 1, 'an import leaves a version entry');
  const url = copy.assets[0].url;
  assert.equal((await api(url)).status, 200, 'the imported image is served from the copy too');
});

test('desktop: the versions list is readable over HTTP (the tab reads it)', async () => {
  const list = await jget('/api/worlds/w_hollow/revisions');
  assert.ok(Array.isArray(list.revisions), 'a list, never a 404');
  assert.ok(list.revisions.length >= 1, `the world has versions to show: ${list.revisions.length}`);
  const one = list.revisions[0];
  for (const field of ['id', 'label', 'created_at']) assert.ok(field in one, `revision carries ${field}`);
  assert.equal((await api('/api/worlds/no_such_world/revisions')).status, 404, 'a missing world says so');
});

test('desktop: revision history snapshots and restores a world', async () => {
  const rec = await jget('/api/worlds/w_hollow');
  assert.ok(rec.revisions.length >= 1);
  const before = rec.revisions.length;
  const moved = JSON.parse(JSON.stringify(rec.world));
  moved.name = 'Hollow Renamed';
  moved.nodes[0].name = 'Moved Green';
  const saved = await jget(`/api/worlds/w_hollow`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ worldJson: moved, name: 'Hollow Renamed', revisionLabel: 'renamed' }),
  });
  assert.equal(saved.world.name, 'Hollow Renamed');
  const after = await jget('/api/worlds/w_hollow');
  assert.equal(after.revisions.length, before + 1);
  const restore = await jget(`/api/revisions/${rec.revisions[0].id}/restore`, { method: 'POST' });
  assert.equal(restore.ok, true);
  const back = await jget('/api/worlds/w_hollow');
  assert.equal(back.world.name, 'Hollow', 'the older version came back');
  assert.equal(back.world.nodes[0].name, 'Green');
});

test('desktop: cover picture + activity column', async () => {
  const cover = fakeImage(42, 1500);
  await api('/api/worlds/w_hollow', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      worldJson: (await jget('/api/worlds/w_hollow')).world, name: 'Hollow',
      coverBytes: [...cover], revision: false,
    }),
  });
  const cv = await api('/api/worlds/w_hollow/cover');
  assert.equal(cv.status, 200);
  assert.deepEqual([...new Uint8Array(await cv.arrayBuffer())], [...cover]);
  const events = await jget('/api/events');
  assert.ok(events.events.length >= 3, 'the activity column has entries');
  assert.ok(events.events.some(e => e.kind === 'export'), 'the export is logged');
  const meta = (await jget('/api/worlds')).worlds.find(w => w.id === 'w_hollow');
  assert.equal(meta.cover, '/api/worlds/w_hollow/cover');
});

test('desktop: storage report is honest about what is on disk', async () => {
  const s = await jget('/api/storage');
  assert.equal(s.worlds, 2);
  assert.ok(s.assets >= 3);
  assert.ok(s.assetBytes > 0);
  assert.ok(s.diskBytes > 0, 'the images are really on disk');
  assert.ok(s.diskBytes <= s.assetBytes, 'identical images are stored once, so the folder is never larger than the sum of its rows');
  assert.equal(s.dir, dataDir);
});

test('desktop: deleting a world removes its rows and reclaims unreferenced files', async () => {
  const lib = await jget('/api/worlds');
  const copy = lib.worlds.find(w => w.name === 'Hollow Copy');
  const del = await jget(`/api/worlds/${copy.id}`, { method: 'DELETE' });
  assert.equal(del.ok, true);
  assert.equal((await api(`/api/worlds/${copy.id}`)).status, 404);
  const lib2 = await jget('/api/worlds');
  assert.equal(lib2.count, 1);
  let files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'covers') walk(path.join(d, e.name)); continue; }
      files++;
    }
  };
  walk(path.join(dataDir, 'assets'));
  assert.equal(files, 1, 'the shared image file survives because the other world still uses it');
});

test('desktop: 404s and bad input are errors, never silent corruption', async () => {
  assert.equal((await api('/api/worlds/nope')).status, 404);
  assert.equal((await api('/api/worlds/nope/assets/x')).status, 404);
  const bad = await api('/api/worlds/w_hollow', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"nope":1}' });
  assert.equal(bad.status, 400);
  const junk = await api('/api/import', { method: 'POST', body: Buffer.from('this is not a world file') });
  assert.equal(junk.status, 500);
  assert.match((await junk.json()).error, /not a world|EOCD|pworld/i);
});

/* ---------------- database layer directly ---------------- */
test('desktop: saving bytes to disk (the save dialog stand in) creates the folder it needs', async () => {
  const freshDir = path.join(tmp, 'fresh-save');
  const fresh = await createDesktopApp({ dataDir: freshDir, quiet: true });
  const info = await fresh.listen({ port: 0, host: '127.0.0.1' });
  const freshBase = info.url;
  try {
    // the app lays out its folders up front, so the very first save cannot fail
    assert.ok(fs.existsSync(path.join(freshDir, 'exports')), 'a fresh data directory already has the exports folder');
    assert.ok(fs.existsSync(path.join(freshDir, 'assets')), 'and the folder images are content addressed into');

    const payload = Buffer.from('world file bytes, honestly not a zip — just bytes');
    const res = await fetch(`${freshBase}/api/save-file?name=${encodeURIComponent('My World 2.pworld')}`, {
      method: 'POST', body: payload, headers: { 'content-type': 'application/octet-stream' },
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.bytes, payload.length);
    assert.ok(fs.existsSync(body.saved), `the file is on disk: ${body.saved}`);
    assert.deepEqual(fs.readFileSync(body.saved), payload);
    assert.ok(body.saved.startsWith(path.join(freshDir, 'exports')), 'it lands in the exports folder');

    // a name that tries to escape is neutered, never honoured
    const nasty = await fetch(`${freshBase}/api/save-file?name=${encodeURIComponent('../../escape.pworld')}`, {
      method: 'POST', body: payload,
    }).then((r) => r.json());
    assert.ok(nasty.saved.startsWith(path.join(freshDir, 'exports')), `still inside: ${nasty.saved}`);
    assert.ok(!fs.existsSync(path.join(freshDir, '..', 'escape.pworld')), 'nothing was written outside the data directory');

    const empty = await fetch(`${freshBase}/api/save-file?name=nothing.pworld`, { method: 'POST', body: '' });
    assert.equal(empty.status, 400, 'an empty save is refused');

    const events = await fetch(`${freshBase}/api/events`).then((r) => r.json());
    assert.ok(events.events.some((e) => e.kind === 'save-file'), 'the save is in the activity column');
  } finally {
    await fresh.close();
  }
});

test('desktop: an imported file brings its cover picture into the library', async () => {
  const raw = smallWorld('Cover');
  const cover = fakeImage(9, 4096);
  await api(`/api/worlds/${raw.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ worldJson: raw, name: 'Cover World', coverBytes: [...cover] }),
  });
  const exported = await jget(`/api/worlds/${raw.id}/pworld`);
  assert.ok(fs.existsSync(exported.saved));
  const { readZip } = await import('../js/io/zipex.js');
  assert.ok((await readZip(fs.readFileSync(exported.saved))).has('cover.jpg'), 'the cover travelled inside the file');

  // delete it, then bring the file back: the cover must come back with it
  await api(`/api/worlds/${raw.id}`, { method: 'DELETE' });
  assert.equal((await jget(`/api/worlds/${raw.id}`)).error || null, 'world not found');
  const imported = await api('/api/import?name=Cover%20Restored', { method: 'POST', body: fs.readFileSync(exported.saved) });
  const out = await imported.json();
  assert.ok(out.meta?.id, 'imported');
  const coverRes = await api(`/api/worlds/${out.meta.id}/cover`);
  assert.equal(coverRes.status, 200, 'the library has a cover picture for the imported world');
  assert.deepEqual(Buffer.from(await coverRes.arrayBuffer()), Buffer.from(cover));
});

test('db: the database refuses nothing it can survive (json path works too)', async () => {
  const dir = path.join(tmp, 'jsonstore');
  const db = await WorldDatabase.open({ dir, engine: 'json' });
  assert.equal(db.engine, 'json');
  db.saveWorld({ id: 'w1', name: 'Plain', worldJson: smallWorld('Plain') });
  db.putAsset('w1', { id: 'a1', bytes: Buffer.from(fakeImage(9, 900)), mime: 'image/png', role: 'panorama' });
  db.addRevision('w1', { label: 'first', worldJson: smallWorld('Plain') });
  db.logEvent('test', 'json engine');
  const rec = db.getWorld('w1');
  assert.equal(rec.meta.name, 'Plain');
  assert.equal(rec.assets.length, 1);
  assert.equal(rec.assets[0].bytes, 900);
  assert.equal(db.getAsset('w1', 'a1').bytes.length, 900);
  assert.equal(db.listRevisions('w1').length, 1);
  assert.ok(db.stats().bytes !== undefined || db.stats().diskBytes > 0);
  const reopened = await WorldDatabase.open({ dir, engine: 'json' });
  assert.equal(reopened.listWorlds().length, 1, 'the plain database survives a restart');
  reopened.close();
  db.close();
});

test('desktop: CLI commands work end-to-end (stats, list, import, info, export, gc, delete)', async () => {
  const cliDir = path.join(tmp, 'cli-test-dir');
  const cli = (cmd, ...args) => execFileSync('node', ['desktop/cli.mjs', cmd, '--data-dir', cliDir, ...args], { encoding: 'utf8' });

  // 1. stats on fresh dir
  const statsOut = cli('stats');
  assert.ok(statsOut.includes('Panorama Maps — worlds database'));
  assert.ok(statsOut.includes(cliDir));

  // 2. list empty
  const listEmpty = cli('list');
  assert.ok(listEmpty.includes('no worlds yet'));

  // 3. create a sample .pworld file
  const sample = smallWorld('CLI Town');
  const pworldFile = path.join(tmp, 'cli-town.pworld');
  const img = fakeImage(77, 2048);
  const { bytes } = await exportPworld({
    world: { name: 'CLI Town' },
    worldJson: sample,
    assets: [{ id: 'asset_testimg0001', original: img, mime: 'image/jpeg' }],
  });
  fs.writeFileSync(pworldFile, bytes);

  // 4. import with name override
  const importOut = cli('import', pworldFile, '--name', 'Renamed CLI Town');
  assert.ok(importOut.includes('imported “Renamed CLI Town”'));

  // 5. list now displays the imported world
  const listOut = cli('list');
  assert.ok(listOut.includes('Renamed CLI Town'));
  const line = listOut.split('\n').find((l) => l.includes('Renamed CLI Town'));
  assert.ok(line, 'world appears in table');
  const worldId = line.split('\t')[1];
  assert.ok(worldId, 'has valid world id');

  // 6. info outputs valid JSON metadata
  const infoOut = cli('info', worldId);
  const parsed = JSON.parse(infoOut);
  assert.equal(parsed.meta.name, 'Renamed CLI Town');
  assert.equal(parsed.assets.length, 1);

  // 7. export writes a valid .pworld file to the requested out directory
  const exportDir = path.join(tmp, 'cli-exported');
  const exportOut = cli('export', worldId, '--out', exportDir);
  assert.ok(exportOut.includes('exported “Renamed CLI Town”'));
  const exportedFiles = fs.readdirSync(exportDir);
  assert.equal(exportedFiles.length, 1);
  assert.ok(exportedFiles[0].endsWith('.pworld'));

  // 8. gc removes unreferenced files
  const gcOut = cli('gc');
  assert.ok(gcOut.includes('unreferenced image file(s)'));

  // 9. delete cleans up the world
  const delOut = cli('delete', worldId);
  assert.ok(delOut.includes('deleted “Renamed CLI Town”'));
  const listAfterDel = cli('list');
  assert.ok(listAfterDel.includes('no worlds yet'));
});

test('db: default data directory is a real per-OS location', () => {
  const dir = defaultDataDir();
  assert.ok(path.isAbsolute(dir));
  assert.ok(/PanoramaMaps|panorama-maps/.test(dir), `expected an app folder, got ${dir}`);
});

/* ---------------- runner ---------------- */
(async () => {
  console.log('Panorama Maps — desktop app test suite');
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}\n    ${(err.stack||"").split("\n").slice(1,4).join("\n    ")}`); }
  }
  if (app) await app.close().catch(() => {});
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
