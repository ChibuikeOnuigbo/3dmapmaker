/**
 * Panorama Maps — io/desktop.js
 *
 * The bridge between the app and the desktop build.
 *
 * The SAME app runs in two homes:
 *   web      static files, no database — worlds travel as `.pworld` files
 *   desktop  the same files served by desktop/server.mjs, with a real
 *            database (worlds · images · versions · activity) behind /api
 *
 * Nothing here is required for the web build: `probe()` simply reports that
 * no desktop backend answered, and every caller falls back to the file path.
 * The web build ships a static `api/health` marker ({"mode":"web"}), so that
 * answer arrives as a 200 instead of a 404 in every visitor's console; the
 * desktop server's own /api/health route answers first when it is the host.
 * All URLs are RELATIVE (`api/...`): whatever host serves the app also serves
 * its database, so the same code works in a browser tab, in a packaged window
 * and behind a proxy. No loopback address is ever hardcoded.
 */

const TIMEOUT_MS = 2500;

async function withTimeout(promise, ms = TIMEOUT_MS) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(t); }
}

export const Desktop = {
  online: false,
  info: null,
  error: null,

  /** Is a desktop backend serving this app? Called once at boot. */
  async probe() {
    try {
      const res = await withTimeout(fetch('api/health', { cache: 'no-store' }));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body?.mode !== 'desktop') throw new Error('not the desktop build');
      this.online = true;
      this.info = body;
      this.error = null;
      return body;
    } catch (err) {
      this.online = false;
      this.info = null;
      this.error = String(err?.message || err);
      return null;
    }
  },

  get dbPath() { return this.info?.db?.path || null; },
  get dbEngine() { return this.info?.db?.engine || null; },
  get dir() { return this.info?.db?.dir || null; },

  async api(path, { method = 'GET', json = null, binary = null, headers = {}, timeout = 60000 } = {}) {
    if (!this.online) throw new Error('the desktop database is not available in this build');
    const opts = { method, cache: 'no-store', headers: { ...headers } };
    if (json !== null) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(json); }
    if (binary) opts.body = binary;
    const res = await withTimeout(fetch(path.startsWith('/') ? path.slice(1) : path, opts), timeout);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    return body;
  },

  /* ---------------- worlds ---------------- */
  listWorlds(q = '') { return this.api(`api/worlds${q ? `?q=${encodeURIComponent(q)}` : ''}`); },
  getWorld(id) { return this.api(`api/worlds/${encodeURIComponent(id)}`); },
  deleteWorld(id) { return this.api(`api/worlds/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  storage() { return this.api('api/storage'); },
  events(limit = 30) { return this.api(`api/events?limit=${limit}`); },

  /** Write a world (graph + card) into the database, creating a version entry. */
  saveWorld({ id, name, author, description, tags, source, createdAt, worldJson, session, coverBytes, cacheMeta, revisionLabel, note }) {
    return this.api(`api/worlds/${encodeURIComponent(id)}`, {
      method: 'PUT',
      json: { name, author, description, tags, source, createdAt, worldJson, session, coverBytes, cacheMeta, revisionLabel, note },
      timeout: 180000,
    });
  },

  /** Upload one image into the database (raw bytes; metadata in headers). */
  putAsset(worldId, assetId, bytes, meta = {}, kind = null) {
    const h = {
      'x-pm-mime': meta.mime || 'image/jpeg',
      'x-pm-role': encodeURIComponent(meta.role || 'panorama'),
      'x-pm-name': encodeURIComponent(meta.name || ''),
      'x-pm-sha256': meta.sha256 || '',
    };
    if (meta.mode) h['x-pm-mode'] = encodeURIComponent(meta.mode);
    if (meta.width) h['x-pm-width'] = String(meta.width);
    if (meta.height) h['x-pm-height'] = String(meta.height);
    const path = `api/worlds/${encodeURIComponent(worldId)}/assets/${encodeURIComponent(assetId)}${kind ? '/' + kind : ''}`;
    return this.api(path, { method: 'POST', binary: bytes, headers: h, timeout: 600000 });
  },

  uploadAssetFromBlob(worldId, assetId, blob, meta = {}, kind = null) {
    return blob.arrayBuffer().then((buf) => this.putAsset(worldId, assetId, new Uint8Array(buf), meta, kind));
  },

  assetUrl(worldId, assetId, kind = null) {
    return `api/worlds/${encodeURIComponent(worldId)}/assets/${encodeURIComponent(assetId)}${kind ? '/' + kind : ''}`;
  },

  /** Import a `.pworld` file INTO the database (server unpacks it). */
  importPworldBytes(bytes, { name = null, source = null, overwrite = false } = {}) {
    const q = new URLSearchParams();
    if (name) q.set('name', name);
    if (source) q.set('source', source);
    if (overwrite) q.set('overwrite', '1');
    return this.api(`api/import${q.toString() ? '?' + q : ''}`, {
      method: 'POST', binary: bytes, headers: { 'content-type': 'application/x-panorama-world' }, timeout: 900000,
    });
  },

  /** Export a world from the database to a `.pworld` file written on disk. */
  exportPworld(id, { modes = null, save = true } = {}) {
    const q = new URLSearchParams();
    if (modes?.length) q.set('modes', modes.join(','));
    if (!save) q.set('save', '0');
    return this.api(`api/worlds/${encodeURIComponent(id)}/pworld?${q}`, { timeout: 900000 });
  },

  /** Blob download of the database's own export (used when the client wants the bytes). */
  async exportPworldBlob(id, modes = null) {
    const q = new URLSearchParams({ save: '0' });
    if (modes?.length) q.set('modes', modes.join(','));
    const res = await fetch(`api/worlds/${encodeURIComponent(id)}/pworld?${q}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  },

  /* ---------------- versions ---------------- */
  listRevisions(id) { return this.api(`api/worlds/${encodeURIComponent(id)}/revisions`).catch(() => null); },
  addRevision(id, { label = null, note = null, worldJson = null } = {}) {
    return this.api(`api/worlds/${encodeURIComponent(id)}/revisions`, { method: 'POST', json: { label, note, worldJson } });
  },
  restoreRevision(revId) { return this.api(`api/revisions/${revId}/restore`, { method: 'POST' }); },

  /** Save bytes to a real file on the desktop (`exports/`) — returns the path. */
  saveFileToDisk(name, bytes) {
    return this.api(`api/save-file?name=${encodeURIComponent(name)}`, {
      method: 'POST', binary: bytes, headers: { 'content-type': 'application/octet-stream' }, timeout: 900000,
    }).catch(() => null);
  },
};

export const isDesktop = () => Desktop.online;
