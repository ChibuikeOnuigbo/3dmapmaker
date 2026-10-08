/**
 * Panorama Maps — desktop/server.mjs
 *
 * The desktop application: the SAME app (index.html + js/), served from disk,
 * with a real database and a real restful API behind it.
 *
 *   /api/health                     is this the desktop build, and which DB
 *   /api/worlds                     the worlds library (columns for the panel)
 *   /api/worlds/:id                 one world: graph + assets + versions
 *   /api/worlds/:id/assets/:assetId the image bytes (from the database)
 *   /api/worlds/:id/pworld          export this world to a .pworld file on disk
 *   /api/import                     import a .pworld file into the database
 *   /api/worlds/:id/revisions       version history + restore
 *   /api/events                     recent activity
 *   /api/storage                    database engine, path, sizes
 *
 * Zero npm dependencies: node:http + node:fs + node:sqlite.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorldDatabase, defaultDataDir, sha256Hex } from './db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, '..');
export const APP_VERSION = '1.1.0';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.mp4': 'video/mp4',
};
const STATIC_EXT = new Set(Object.keys(MIME));

const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
};
const text = (res, code, body) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(body); };

function readBody(req, limit = 8 * 1024 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
/** Send a file with Range support (large panoramas seek nicely). */
function sendFile(req, res, abs, { download = null, immutable = false } = {}) {
  let st;
  try { st = fs.statSync(abs); } catch { return text(res, 404, 'not found'); }
  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (download) headers['content-disposition'] = `attachment; filename="${download.replace(/"/g, '')}"`;
  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [s, e] = range.replace('bytes=', '').split('-');
    const start = s === '' ? Math.max(0, st.size - Number(e)) : Number(s);
    const end = s === '' || e === '' ? st.size - 1 : Math.min(Number(e), st.size - 1);
    if (start >= st.size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` });
      return res.end();
    }
    headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
    headers['content-length'] = end - start + 1;
    res.writeHead(206, headers);
    return fs.createReadStream(abs, { start, end }).pipe(res);
  }
  headers['content-length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(abs).pipe(res);
}

export function safeJoin(root, urlPath) {
  const clean = decodeURIComponent(String(urlPath).split('?')[0]);
  const rel = path.normalize(clean).replace(/^([/\\])+/, '');
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root)) return null;
  return abs;
}

/* ================================================================= */
/* server                                                             */
/* ================================================================= */
export async function createDesktopApp({
  root = APP_ROOT, dataDir = defaultDataDir(), engine = null, log = () => {},
} = {}) {
  const db = await WorldDatabase.open({ dir: dataDir, engine });
  log(`database: ${db.engine} → ${db.path}`);

  /* ---------- the world-file bridge (same format as the web build) ---------- */
  const pworld = await import('../js/io/pworld.js');

  /** resolver: pull any stored image straight out of the database */
  const resolverFor = (worldId) => async (assetId) => {
    const rec = db.getAsset(worldId, assetId);
    if (!rec?.bytes) return null;
    return {
      original: rec.bytes, mime: rec.row.mime, name: rec.row.name,
      width: rec.row.width, height: rec.row.height, role: rec.row.role, mode: rec.row.mode,
    };
  };
  /** fetch: bundled world art lives in the app folder — read it from disk */
  const fetchBytes = async (url) => {
    const u = String(url);
    if (/^https?:/i.test(u) || u.startsWith('data:')) {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') || '' };
    }
    const abs = safeJoin(root, u);
    if (!abs || !fs.existsSync(abs)) throw new Error('HTTP 404');
    return { bytes: new Uint8Array(fs.readFileSync(abs)), mime: MIME[path.extname(abs).toLowerCase()] || 'image/jpeg' };
  };

  /**
   * Assemble a `.pworld` for a world in the database.
   *
   * Building also MATERIALISES the world: every image that had to be fetched
   * from the world folder is written into the database, and the stored world
   * is updated to reference those embedded images. After the first export the
   * database copy is self-contained too — it no longer needs the website.
   */
  async function buildPworld(worldId, { modes = null, onProgress = () => {}, materialise = true } = {}) {
    const rec = db.getWorld(worldId);
    if (!rec) throw new Error('world not found');
    const collected = await pworld.collectWorldAssets(null, {
      json: rec.world, resolveAsset: resolverFor(worldId), fetchBytes, modes, onProgress,
    });
    if (materialise) {
      const known = new Set(rec.assets.map(a => a.id));
      let stored = 0;
      for (const a of collected.assets) {
        if (known.has(a.id)) continue;
        const bytes = a.original instanceof Uint8Array ? a.original : new Uint8Array(await a.original.arrayBuffer());
        db.putAsset(worldId, {
          id: a.id, bytes, mime: a.mime, role: a.role || 'panorama', mode: a.mode ?? null,
          name: a.name, width: a.width, height: a.height, sha256: a.sha256,
        });
        stored++;
      }
      if (stored) {
        db.saveWorld({
          ...rec.meta, id: worldId, worldJson: collected.worldJson, session: rec.session,
          assetCount: db.listAssets(worldId).length,
          assetBytes: db.listAssets(worldId).reduce((n, a) => n + (a.bytes || 0), 0),
        });
        db.logEvent('embed', `${collected.images} image(s) stored inside the database`);
      }
    }
    const cover = db.coverFile(worldId);
    const cacheMeta = db.getSetting(`cache:${worldId}`, null);
    const { bytes, manifest } = await pworld.exportPworld({
      world: { ...rec.meta, id: rec.meta.id, name: rec.meta.name, modes: collected.modes },
      worldJson: collected.worldJson,
      assets: collected.assets,
      session: rec.session,
      cacheMeta,
      cover: cover ? fs.readFileSync(cover) : null,
      missing: collected.missing,
      appVersion: APP_VERSION,
      onProgress,
    });
    return { bytes, manifest, collected, meta: rec.meta };
  }

  /** Store an imported `.pworld` into the database (assets included). */
  async function importPworldBuffer(buf, { name = null, sourcePath = null, label = 'imported', overwrite = false } = {}) {
    const imported = await pworld.importPworld(new Uint8Array(buf));
    let id = imported.manifest.world.id || ('world_' + Date.now().toString(36));
    // importing a world never silently overwrites one you already have:
    // it lands beside it as a copy unless overwrite was asked for
    if (!overwrite && db.getWorld(id)) {
      id = `${id}_${Date.now().toString(36)}`;
      imported.world.id = id;
      db.logEvent('import', `kept the existing world · imported a copy as ${id}`);
    }
    for (const a of imported.assets) {
      db.putAsset(id, {
        id: a.id, bytes: a._rawOriginal, mime: a.mime, role: a.role, mode: a.mode,
        name: a.name, width: a.width, height: a.height, sha256: a.sha256,
      });
      if (a.display) db.putAsset(id, { id: a.id, kind: 'display', bytes: Buffer.from(await a.display.arrayBuffer()), mime: 'image/webp', role: a.role, mode: a.mode, sha256: null, name: a.name });
      if (a.thumbnail) db.putAsset(id, { id: a.id, kind: 'thumb', bytes: Buffer.from(await a.thumbnail.arrayBuffer()), mime: 'image/webp', role: a.role, mode: a.mode, sha256: null, name: a.name });
    }
    const meta = db.saveWorld({
      id, name: name || imported.manifest.world.name, author: imported.manifest.world.author,
      description: imported.manifest.world.description, tags: imported.manifest.world.tags,
      source: sourcePath || imported.manifest.world.source,
      worldJson: imported.world, session: imported.session,
      assetCount: imported.assets.length,
      assetBytes: imported.assets.reduce((n, a) => n + a.bytes, 0),
    });
    // the file's own cover picture becomes the world's library thumbnail
    if (imported.cover) {
      const buf = Buffer.from(await imported.cover.arrayBuffer());
      if (buf.length) db.putCover(id, buf);
    }
    if (imported.cacheMeta) db.setSetting(`cache:${id}`, imported.cacheMeta);
    db.addRevision(id, { label, note: `imported from ${sourcePath || 'file'}`, worldJson: imported.world, assetCount: imported.assets.length });
    db.logEvent('import', `${meta.name} (${imported.assets.length} images)`);
    return { meta, warnings: imported.warnings, manifest: imported.manifest };
  }

  /* ---------- routes ---------- */
  const routes = {
    'GET /api/health': async () => ({
      ok: true, app: 'Panorama Maps', mode: 'desktop', version: APP_VERSION,
      db: { engine: db.engine, path: db.path, dir: db.dir },
      platform: process.platform, node: process.version,
    }),

    'GET /api/storage': async () => ({ ...db.stats(), events: db.recentEvents(20) }),

    'GET /api/worlds': async (req, res, params, { url }) => {
      const q = url.searchParams.get('q') || '';
      const worlds = db.listWorlds({ q });
      return { engine: db.engine, dir: db.dir, count: worlds.length, worlds };
    },

    'GET /api/worlds/:id': async (req, res, { id }) => {
      const rec = db.getWorld(id);
      if (!rec) return { status: 404, body: { error: 'world not found' } };
      db.touchWorld(id, { opened: true });
      return { ...rec, revisions: db.listRevisions(id, 20) };
    },

    'PUT /api/worlds/:id': async (req, res, { id }, { bodyJson }) => {
      const body = await bodyJson();
      if (!body.worldJson) return { status: 400, body: { error: 'worldJson is required' } };
      const meta = db.saveWorld({
        id, name: body.name, author: body.author, description: body.description, tags: body.tags,
        source: body.source, createdAt: body.createdAt, worldJson: body.worldJson,
        session: body.session ?? null, settings: body.settings ?? null,
      });
      if (body.coverBytes) db.putCover(id, Buffer.from(body.coverBytes));
      if (body.cacheMeta) db.setSetting(`cache:${id}`, body.cacheMeta);
      db.logEvent('save', `${meta.name} · ${meta.nodeCount} places`);
      if (body.revision !== false) {
        db.addRevision(id, { label: body.revisionLabel || null, note: body.note || 'saved from the app', worldJson: body.worldJson, assetCount: meta.assetCount });
      }
      return { ok: true, world: meta, stats: db.stats() };
    },

    'DELETE /api/worlds/:id': async (req, res, { id }) => {
      const rec = db.getWorld(id);
      if (!rec) return { status: 404, body: { error: 'world not found' } };
      db.deleteWorld(id);
      db.logEvent('delete', rec.meta.name);
      return { ok: true, deleted: id };
    },

    'POST /api/worlds/:id/assets/:assetId': async (req, res, { id, assetId }, { getBody }) => {
      const buffer = await getBody();
      if (!buffer?.length) return { status: 400, body: { error: 'no image bytes' } };
      const meta = headerMeta(req, buffer);
      const row = db.putAsset(id, {
        id: assetId, bytes: buffer, mime: meta.mime, role: meta.role, mode: meta.mode,
        name: meta.name, width: meta.width, height: meta.height, sha256: meta.sha256,
      });
      db.logEvent('asset', `${meta.name || assetId} · ${buffer.length} bytes`);
      return { ok: true, asset: { id: row.id, bytes: row.bytes, sha256: row.sha256, url: row.url } };
    },
    // a second representation of the same image (display / thumbnail)
    'POST /api/worlds/:id/assets/:assetId/:kind': async (req, res, { id, assetId, kind }, { getBody }) => {
      const buffer = await getBody();
      if (!buffer?.length) return { status: 400, body: { error: 'no image bytes' } };
      const meta = headerMeta(req, buffer);
      const row = db.putAsset(id, { id: assetId, kind, bytes: buffer, mime: meta.mime || 'image/webp', role: meta.role, mode: meta.mode, name: meta.name, sha256: null });
      return { ok: true, asset: { id: row.id, bytes: row.bytes, url: row.url } };
    },

    'GET /api/worlds/:id/assets/:assetId': async (req, res, { id, assetId }) => {
      const rec = db.getAsset(id, assetId);
      if (!rec?.bytes) return { status: 404, body: { error: 'asset not found' } };
      res.writeHead(200, {
        'content-type': rec.row.mime || 'application/octet-stream',
        'content-length': rec.bytes.length,
        'cache-control': 'public, max-age=31536000, immutable',
        'etag': `"${rec.row.sha256 || assetId}"`,
      });
      res.end(rec.bytes);
      return { handled: true };
    },

    /* a derived representation of the same image (display / thumb) */
    'GET /api/worlds/:id/assets/:assetId/:kind': async (req, res, { id, assetId, kind }) => {
      const rec = db.getAsset(id, `${assetId}:${kind}`);
      if (!rec?.bytes) return { status: 404, body: { error: 'asset variant not found' } };
      res.writeHead(200, {
        'content-type': rec.row.mime || 'image/webp',
        'content-length': rec.bytes.length,
        'cache-control': 'public, max-age=31536000, immutable',
      });
      res.end(rec.bytes);
      return { handled: true };
    },

    'GET /api/worlds/:id/cover': async (req, res, { id }) => {
      const abs = db.coverFile(id);
      if (!abs) return { status: 404, body: { error: 'no cover' } };
      sendFile(req, res, abs, { immutable: true });
      return { handled: true };
    },

    'GET /api/worlds/:id/pworld': async (req, res, { id }, { url }) => {
      const modes = url.searchParams.get('modes');
      const { bytes, manifest } = await buildPworld(id, { modes: modes ? modes.split(',') : null });
      const filename = pworld.pworldFilename(manifest.world.name);
      const save = url.searchParams.get('save') !== '0';
      if (save) {
        const out = path.join(db.exportsDir, filename);
        fs.writeFileSync(out, bytes);
        db.logEvent('export', `${manifest.world.name} → ${out}`);
        return { ok: true, saved: out, bytes: bytes.length, manifest: pworldSummary(manifest), filename };
      }
      res.writeHead(200, {
        'content-type': 'application/x-panorama-world',
        'content-length': bytes.length,
        'content-disposition': `attachment; filename="${filename}"`,
      });
      res.end(Buffer.from(bytes));
      return { handled: true };
    },

    // the Versions tab reads this; the same list also rides along with the world
    'GET /api/worlds/:id/revisions': async (req, res, { id }, { url }) => {
      if (!db.getWorld(id)) return { status: 404, body: { error: 'world not found' } };
      const limit = Number(url.searchParams.get('limit')) || 50;
      return { worldId: id, revisions: db.listRevisions(id, limit) };
    },

    'POST /api/worlds/:id/revisions': async (req, res, { id }, { bodyJson }) => {
      const body = await bodyJson();
      const rec = db.getWorld(id);
      if (!rec) return { status: 404, body: { error: 'world not found' } };
      const rev = db.addRevision(id, {
        label: body.label || null, note: body.note || null,
        worldJson: body.worldJson || rec.world, assetCount: rec.assets.length,
      });
      db.logEvent('revision', `${rec.meta.name} · ${rev.label || 'snapshot'}`);
      return { ok: true, revision: rev, revisions: db.listRevisions(id, 20) };
    },

    'POST /api/revisions/:revId/restore': async (req, res, { revId }) => {
      const rev = db.getRevision(revId);
      if (!rev) return { status: 404, body: { error: 'revision not found' } };
      const meta = db.saveWorld({ ...db.getWorld(rev.world_id).meta, id: rev.world_id, worldJson: rev.world, assetCount: undefined });
      db.addRevision(rev.world_id, { label: `restored #${revId}`, note: 'restored an earlier version', worldJson: rev.world });
      db.logEvent('restore', `${meta.name} · revision ${revId}`);
      return { ok: true, world: meta };
    },

    'GET /api/events': async (req, res, params, { url }) => ({ events: db.recentEvents(Number(url.searchParams.get('limit')) || 40) }),

    /* write bytes the app assembled (e.g. a `.pworld`) to a real file on this
       machine — the desktop equivalent of a save dialog, no download folder */
    'POST /api/save-file': async (req, res, params, { url, getBody }) => {
      const buffer = await getBody();
      const raw = url.searchParams.get('name') || `world-${Date.now()}.pworld`;
      const name = path.basename(raw).replace(/[^\w\-. ]+/g, '_');
      if (!buffer?.length) return { status: 400, body: { error: 'no bytes to save' } };
      const out = path.join(db.exportsDir, name);
      fs.writeFileSync(out, buffer);
      db.logEvent('save-file', `${name} · ${buffer.length} bytes`);
      return { ok: true, saved: out, bytes: buffer.length, name };
    },

    'PUT /api/settings': async (req, res, params, { bodyJson }) => {
      const body = await bodyJson();
      for (const [k, v] of Object.entries(body || {})) db.setSetting(k, v);
      return { ok: true };
    },
    'GET /api/settings': async () => ({ settings: { lastWorldId: db.getSetting('lastWorldId', null), theme: db.getSetting('theme', null) } }),
  };

  function headerMeta(req, buffer) {
    const dec = (v) => (v ? decodeURIComponent(String(v)) : null);
    const num = (v) => (v == null || v === '' ? null : Number(v));
    return {
      mime: req.headers['x-pm-mime'] || 'image/jpeg',
      role: dec(req.headers['x-pm-role']) || 'panorama',
      mode: dec(req.headers['x-pm-mode']) || null,
      name: dec(req.headers['x-pm-name']) || null,
      width: num(req.headers['x-pm-width']),
      height: num(req.headers['x-pm-height']),
      sha256: req.headers['x-pm-sha256'] || sha256Hex(buffer),
    };
  }

  function matchRoute(method, pathname) {
    for (const key of Object.keys(routes)) {
      const sp = key.indexOf(' ');
      const m = key.slice(0, sp), pattern = key.slice(sp + 1);
      if (m !== method) continue;
      const params = matchPath(pattern, pathname);
      if (params) return { handler: routes[key], params };
    }
    return null;
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`error ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
      else res.end();
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      /* import: raw .pworld bytes in the body */
      if (req.method === 'POST' && pathname === '/api/import') {
        const buffer = await readBody(req);
        if (!buffer.length) return json(res, 400, { error: 'no file bytes' });
        const name = url.searchParams.get('name');
        const out = await importPworldBuffer(buffer, {
          name, sourcePath: url.searchParams.get('source'),
          overwrite: url.searchParams.get('overwrite') === '1',
        });
        log(`imported ${out.meta.name} (${out.meta.assetCount} images)`);
        return json(res, 200, out);
      }
      const hit = matchRoute(req.method, pathname);
      if (!hit) return json(res, 404, { error: `no route for ${req.method} ${pathname}` });
      let buffer = null;
      const getBody = async (limit) => (buffer ??= await readBody(req, limit));
      const bodyJson = async () => {
        const buf = await getBody(64 * 1024 * 1024);
        if (!buf.length) return {};
        try { return JSON.parse(buf.toString('utf8')); } catch { throw new Error('invalid JSON body'); }
      };
      const out = await hit.handler(req, res, hit.params, { getBody, bodyJson, url });
      if (out?.handled) return undefined;
      if (out?.status) return json(res, out.status, out.body);
      return json(res, 200, out);
    }

    /* ---------- static app files ---------- */
    let target = pathname === '/' ? '/index.html' : pathname;
    if (!path.extname(target)) target += '/index.html';
    const abs = safeJoin(root, target);
    if (!abs) return text(res, 403, 'forbidden');
    const ext = path.extname(abs).toLowerCase();
    if (!STATIC_EXT.has(ext)) return text(res, 404, 'not found');
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return text(res, 404, 'not found');
    return sendFile(req, res, abs);
  }

  return {
    db, server, root, dataDir,
    listen({ port = 0, host = '127.0.0.1' } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
          resolve({ port: addr.port, host, url: `http://${shown.includes(':') ? `[${shown}]` : shown}:${addr.port}` });
        });
      });
    },
    close() { return new Promise((r) => { server.close(() => r()); db.close(); }); },
    buildPworld, importPworldBuffer,
  };
}

function pworldSummary(manifest) {
  return {
    name: manifest.world.name, nodes: manifest.stats.nodes, images: manifest.stats.images,
    imageBytes: manifest.stats.imageBytes, fileBytes: manifest.stats.fileBytes,
    missing: manifest.missing?.length || 0, formatVersion: manifest.formatVersion,
  };
}

/** '/api/worlds/:id/assets/:assetId' + '/api/worlds/:id' → params or null. */
export function matchPath(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean);
  const s = pathname.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

/* ================================================================= */
/* browser launch                                                     */
/* ================================================================= */
export async function openInBrowser(url) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'cmd'
      : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      child.on('spawn', () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}

/** Run the desktop server; used by main.mjs, the CLI and the Electron shell. */
export async function startDesktopApp({
  port = Number(process.env.PM_PORT) || 7654, host = process.env.PM_HOST || '127.0.0.1',
  root = APP_ROOT, dataDir = defaultDataDir(), quiet = false, tryPorts = 20, onReady = null,
} = {}) {
  const log = quiet ? () => {} : (m) => console.log(`  ${m}`);
  let app = null;
  let lastErr = null;
  for (let i = 0; i < tryPorts; i++) {
    try {
      app = await createDesktopApp({ root, dataDir, log });
      const info = await app.listen({ port: port + i, host });
      if (onReady) onReady(info, app);
      return { ...info, app };
    } catch (err) {
      lastErr = err;
      if (app) await app.close();
      app = null;
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`no free port near ${port}: ${lastErr?.message || ''}`);
}
