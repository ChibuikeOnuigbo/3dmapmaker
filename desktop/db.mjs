/**
 * Panorama Maps — desktop/db.mjs
 *
 * THE DESKTOP DATABASE — where created worlds live.
 *
 * Two engines, one API:
 *
 *   sqlite  (default)  Node's built-in `node:sqlite` (Node ≥ 22.5). A real
 *                      relational database file — worlds, assets, revisions,
 *                      events, settings — with no npm install at all.
 *   json               a plain-file fallback for older Node versions, same
 *                      method surface, so the app never refuses to start.
 *
 * Images are BIG. They are content-addressed files on disk (sha256 name) with
 * a row in the database, which is what keeps a 200 MB photo world fast to list
 * and cheap to copy: the same image uploaded twice is stored once.
 *
 * The `.pworld` file is still the portable interchange format — the database
 * is the working home. Everything in it can be exported back out to a file.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DB_VERSION = 1;

/* ---------------------------------------------------------------- */
/* where the app keeps its things                                    */
/* ---------------------------------------------------------------- */
export function defaultDataDir() {
  if (process.env.PM_DATA_DIR) return path.resolve(process.env.PM_DATA_DIR);
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'PanoramaMaps');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'PanoramaMaps');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'panorama-maps');
}

const nowIso = () => new Date().toISOString();
const asJson = (v) => JSON.stringify(v ?? null);

export function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

const EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/bmp': '.bmp', 'image/avif': '.avif',
};
export const extForMime = (mime) => EXT[mime] || '.img';

/* ================================================================= */
/* SQLite engine                                                      */
/* ================================================================= */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  author TEXT DEFAULT '',
  description TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  source TEXT,
  created_at TEXT, updated_at TEXT, opened_at TEXT,
  node_count INTEGER DEFAULT 0, edge_count INTEGER DEFAULT 0,
  zone_count INTEGER DEFAULT 0, landmark_count INTEGER DEFAULT 0,
  asset_count INTEGER DEFAULT 0, asset_bytes INTEGER DEFAULT 0,
  cover_path TEXT,
  world_json TEXT NOT NULL,
  session_json TEXT,
  settings_json TEXT,
  pworld_path TEXT
);
CREATE TABLE IF NOT EXISTS assets (
  world_id TEXT NOT NULL,
  id TEXT NOT NULL,
  role TEXT, mode TEXT, name TEXT, mime TEXT,
  bytes INTEGER DEFAULT 0, sha256 TEXT, width INTEGER, height INTEGER,
  path TEXT NOT NULL, created_at TEXT,
  PRIMARY KEY (world_id, id)
);
CREATE INDEX IF NOT EXISTS idx_assets_world ON assets (world_id);
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id TEXT NOT NULL,
  label TEXT, note TEXT,
  node_count INTEGER DEFAULT 0, asset_count INTEGER DEFAULT 0,
  world_json TEXT NOT NULL,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rev_world ON revisions (world_id, id DESC);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT, kind TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

class SqliteEngine {
  constructor(dir, DatabaseSync) {
    this.kind = 'sqlite';
    this.dir = dir;
    this.file = path.join(dir, 'panorama-maps.db');
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }
  run(sql, ...p) { return this.db.prepare(sql).run(...p); }
  all(sql, ...p) { return this.db.prepare(sql).all(...p); }
  get(sql, ...p) { return this.db.prepare(sql).get(...p); }
  close() { try { this.db.close(); } catch { /* already closed */ } }
}

/* ================================================================= */
/* JSON engine (fallback, same API)                                   */
/* ================================================================= */
class JsonEngine {
  constructor(dir) {
    this.kind = 'json';
    this.dir = dir;
    this.file = path.join(dir, 'panorama-maps.json');
    this.data = { worlds: [], assets: [], revisions: [], events: [], settings: {}, seq: 1 };
    if (fs.existsSync(this.file)) {
      try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { /* start fresh */ }
    }
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
  close() { this.save(); }
}

/* ================================================================= */
/* WorldDatabase — one API over both engines                          */
/* ================================================================= */
export class WorldDatabase {
  static async open({ dir = defaultDataDir(), engine = null } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'exports'), { recursive: true });
    let impl = null;
    if (engine !== 'json') {
      try {
        const { DatabaseSync } = await import('node:sqlite');
        impl = new SqliteEngine(dir, DatabaseSync);
      } catch (err) {
        if (engine === 'sqlite') throw new Error('the sqlite engine was requested but this Node build has no node:sqlite: ' + err.message);
      }
    }
    if (!impl) impl = new JsonEngine(dir);
    return new WorldDatabase(impl);
  }

  constructor(impl) {
    this.impl = impl;
    this.dir = impl.dir;
    this.assetsDir = path.join(this.dir, 'assets');
    this.exportsDir = path.join(this.dir, 'exports');
  }

  get engine() { return this.impl.kind; }
  get path() { return this.impl.file; }

  /* ---------------- worlds ---------------- */

  listWorlds({ q = '', limit = 500 } = {}) {
    const query = String(q || '').trim().toLowerCase();
    if (this.engine === 'sqlite') {
      const rows = this.impl.all(
        `SELECT id,name,author,description,tags,source,created_at,updated_at,opened_at,
                node_count,edge_count,zone_count,landmark_count,asset_count,asset_bytes,cover_path
         FROM worlds ORDER BY datetime(updated_at) DESC LIMIT ?`, limit);
      return rows.filter(r => !query || r.name.toLowerCase().includes(query)).map(rowToMeta);
    }
    return this.impl.data.worlds
      .filter(w => !query || String(w.name).toLowerCase().includes(query))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, limit).map(rowToMeta);
  }

  getWorld(id) {
    const row = this.engine === 'sqlite'
      ? this.impl.get('SELECT * FROM worlds WHERE id = ?', id)
      : this.impl.data.worlds.find(w => w.id === id);
    if (!row) return null;
    return {
      meta: rowToMeta(row),
      world: safeJson(row.world_json),
      session: safeJson(row.session_json),
      settings: safeJson(row.settings_json),
      assets: this.listAssets(id),
    };
  }

  /** Insert or update a world row. `record.worldJson` is required. */
  saveWorld(record) {
    const world = record.worldJson || record.world || {};
    const stats = statsOf(world);
    const row = {
      id: record.id,
      name: record.name || world.name || 'Untitled world',
      author: record.author || '',
      description: record.description || world.description || '',
      tags: asJson(Array.isArray(record.tags) ? record.tags : []),
      source: record.source || null,
      created_at: record.createdAt || nowIso(),
      updated_at: nowIso(),
      opened_at: record.openedAt || nowIso(),
      node_count: stats.nodes, edge_count: stats.edges, zone_count: stats.zones, landmark_count: stats.landmarks,
      asset_count: record.assetCount ?? this.listAssets(record.id).length,
      asset_bytes: record.assetBytes ?? this.listAssets(record.id).reduce((n, a) => n + (a.bytes || 0), 0),
      cover_path: record.coverPath || this._existingCover(record.id),
      world_json: asJson(world),
      session_json: asJson(record.session ?? null),
      settings_json: asJson(record.settings ?? null),
      pworld_path: record.pworldPath || null,
    };
    if (this.engine === 'sqlite') {
      this.impl.run(
        `INSERT INTO worlds (id,name,author,description,tags,source,created_at,updated_at,opened_at,
           node_count,edge_count,zone_count,landmark_count,asset_count,asset_bytes,cover_path,world_json,session_json,settings_json,pworld_path)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, author=excluded.author, description=excluded.description, tags=excluded.tags,
           source=excluded.source, updated_at=excluded.updated_at, opened_at=excluded.opened_at,
           node_count=excluded.node_count, edge_count=excluded.edge_count, zone_count=excluded.zone_count,
           landmark_count=excluded.landmark_count, asset_count=excluded.asset_count, asset_bytes=excluded.asset_bytes,
           cover_path=COALESCE(excluded.cover_path, worlds.cover_path),
           world_json=excluded.world_json, session_json=excluded.session_json, settings_json=excluded.settings_json,
           pworld_path=COALESCE(excluded.pworld_path, worlds.pworld_path)`,
        row.id, row.name, row.author, row.description, row.tags, row.source, row.created_at, row.updated_at,
        row.opened_at, row.node_count, row.edge_count, row.zone_count, row.landmark_count, row.asset_count,
        row.asset_bytes, row.cover_path, row.world_json, row.session_json, row.settings_json, row.pworld_path);
    } else {
      const i = this.impl.data.worlds.findIndex(w => w.id === row.id);
      if (i >= 0) row.created_at = this.impl.data.worlds[i].created_at || row.created_at;
      if (i >= 0) this.impl.data.worlds[i] = row; else this.impl.data.worlds.push(row);
      this.impl.save();
    }
    return this.getWorld(row.id).meta;
  }

  _existingCover(id) {
    if (this.engine === 'sqlite') {
      const r = this.impl.get('SELECT cover_path FROM worlds WHERE id = ?', id);
      return r?.cover_path || null;
    }
    return this.impl.data.worlds.find(w => w.id === id)?.cover_path || null;
  }

  touchWorld(id, { opened = false } = {}) {
    if (this.engine === 'sqlite') {
      this.impl.run(`UPDATE worlds SET ${opened ? 'opened_at' : 'updated_at'} = ? WHERE id = ?`, nowIso(), id);
    } else {
      const w = this.impl.data.worlds.find(x => x.id === id);
      if (w) { (opened ? (w.opened_at = nowIso()) : (w.updated_at = nowIso())); this.impl.save(); }
    }
  }

  deleteWorld(id) {
    const assets = this.listAssets(id);
    if (this.engine === 'sqlite') {
      this.impl.run('DELETE FROM assets WHERE world_id = ?', id);
      this.impl.run('DELETE FROM revisions WHERE world_id = ?', id);
      this.impl.run('DELETE FROM worlds WHERE id = ?', id);
    } else {
      this.impl.data.assets = this.impl.data.assets.filter(a => a.world_id !== id);
      this.impl.data.revisions = this.impl.data.revisions.filter(r => r.world_id !== id);
      this.impl.data.worlds = this.impl.data.worlds.filter(w => w.id !== id);
      this.impl.save();
    }
    // content-addressed files are shared between worlds: only unlink the ones
    // no other world still references
    for (const a of assets) this._gcAssetFile(a);
    return true;
  }

  _gcAssetFile(asset) {
    if (!asset?.path) return;
    const stillUsed = this.engine === 'sqlite'
      ? this.impl.get('SELECT world_id FROM assets WHERE path = ? LIMIT 1', asset.path)
      : this.impl.data.assets.find(a => a.path === asset.path);
    if (stillUsed) return;
    try { fs.unlinkSync(path.join(this.dir, asset.path)); } catch { /* already gone */ }
  }

  /* ---------------- assets (images) ---------------- */

  listAssets(worldId) {
    const rows = this.engine === 'sqlite'
      ? this.impl.all('SELECT * FROM assets WHERE world_id = ? ORDER BY created_at', worldId)
      : this.impl.data.assets.filter(a => a.world_id === worldId);
    return rows.map(a => ({
      id: a.id, role: a.role, mode: a.mode, name: a.name, mime: a.mime,
      bytes: a.bytes, sha256: a.sha256, width: a.width, height: a.height, path: a.path,
      url: `/api/worlds/${encodeURIComponent(worldId)}/assets/${encodeURIComponent(a.id)}`,
    }));
  }

  /**
   * Store an image for a world. Bytes are written once, content addressed by
   * sha256 — the same photo in ten worlds costs one copy on disk.
   */
  putAsset(worldId, { id, bytes, mime = 'image/jpeg', role = 'panorama', mode = null,
                      name = null, width = null, height = null, sha256 = null, kind = 'original' }) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const hash = sha256 || sha256Hex(buf);
    const rel = path.join('assets', hash.slice(0, 2), hash + extForMime(mime));
    const abs = path.join(this.dir, rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = abs + '.tmp' + process.pid;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, abs);
    }
    const assetId = kind === 'original' ? id : `${id}:${kind}`;
    const row = {
      world_id: worldId, id: assetId, role, mode, name, mime,
      bytes: buf.length, sha256: hash, width, height, path: rel, created_at: nowIso(),
    };
    if (this.engine === 'sqlite') {
      this.impl.run(
        `INSERT INTO assets (world_id,id,role,mode,name,mime,bytes,sha256,width,height,path,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(world_id,id) DO UPDATE SET
           role=excluded.role, mode=excluded.mode, name=excluded.name, mime=excluded.mime,
           bytes=excluded.bytes, sha256=excluded.sha256, width=excluded.width, height=excluded.height,
           path=excluded.path`,
        row.world_id, row.id, row.role, row.mode, row.name, row.mime, row.bytes, row.sha256,
        row.width, row.height, row.path, row.created_at);
    } else {
      const i = this.impl.data.assets.findIndex(a => a.world_id === worldId && a.id === assetId);
      if (i >= 0) this.impl.data.assets[i] = row; else this.impl.data.assets.push(row);
      this.impl.save();
    }
    this._refreshAssetTotals(worldId);
    return { ...row, url: `/api/worlds/${encodeURIComponent(worldId)}/assets/${encodeURIComponent(assetId)}` };
  }

  getAsset(worldId, assetId) {
    const row = this.engine === 'sqlite'
      ? this.impl.get('SELECT * FROM assets WHERE world_id = ? AND id = ?', worldId, assetId)
      : this.impl.data.assets.find(a => a.world_id === worldId && a.id === assetId);
    if (!row) return null;
    const abs = path.join(this.dir, row.path);
    if (!fs.existsSync(abs)) return { row, bytes: null };
    return { row, bytes: fs.readFileSync(abs) };
  }

  _refreshAssetTotals(worldId) {
    const assets = this.listAssets(worldId);
    const count = assets.length, bytes = assets.reduce((n, a) => n + (a.bytes || 0), 0);
    if (this.engine === 'sqlite') this.impl.run('UPDATE worlds SET asset_count = ?, asset_bytes = ? WHERE id = ?', count, bytes, worldId);
    else {
      const w = this.impl.data.worlds.find(x => x.id === worldId);
      if (w) { w.asset_count = count; w.asset_bytes = bytes; this.impl.save(); }
    }
  }

  /** Store a cover picture for the worlds library. */
  putCover(worldId, bytes) {
    const rel = path.join('assets', 'covers', worldId + '.jpg');
    const abs = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(bytes));
    if (this.engine === 'sqlite') this.impl.run('UPDATE worlds SET cover_path = ? WHERE id = ?', rel, worldId);
    else { const w = this.impl.data.worlds.find(x => x.id === worldId); if (w) { w.cover_path = rel; this.impl.save(); } }
    return rel;
  }
  coverFile(worldId) {
    const rel = this.engine === 'sqlite'
      ? this.impl.get('SELECT cover_path FROM worlds WHERE id = ?', worldId)?.cover_path
      : this.impl.data.worlds.find(w => w.id === worldId)?.cover_path;
    if (!rel) return null;
    const abs = path.join(this.dir, rel);
    return fs.existsSync(abs) ? abs : null;
  }

  /* ---------------- revisions (version history) ---------------- */

  addRevision(worldId, { label = null, note = null, worldJson, assetCount = 0, keep = 30 } = {}) {
    if (!worldJson) return null;
    const stats = statsOf(worldJson);
    const at = nowIso();
    let id;
    if (this.engine === 'sqlite') {
      const res = this.impl.run(
        'INSERT INTO revisions (world_id,label,note,node_count,asset_count,world_json,created_at) VALUES (?,?,?,?,?,?,?)',
        worldId, label, note, stats.nodes, assetCount, asJson(worldJson), at);
      id = Number(res.lastInsertRowid);
      this.impl.run(
        `DELETE FROM revisions WHERE world_id = ? AND id NOT IN
           (SELECT id FROM revisions WHERE world_id = ? ORDER BY id DESC LIMIT ?)`, worldId, worldId, keep);
    } else {
      id = this.impl.data.seq++;
      this.impl.data.revisions.push({ id, world_id: worldId, label, note, node_count: stats.nodes, asset_count: assetCount, world_json: asJson(worldJson), created_at: at });
      const mine = this.impl.data.revisions.filter(r => r.world_id === worldId);
      if (mine.length > keep) {
        const drop = new Set(mine.slice(0, mine.length - keep).map(r => r.id));
        this.impl.data.revisions = this.impl.data.revisions.filter(r => !drop.has(r.id));
      }
      this.impl.save();
    }
    return { id, world_id: worldId, label, note, node_count: stats.nodes, asset_count: assetCount, created_at: at };
  }

  listRevisions(worldId, limit = 50) {
    const rows = this.engine === 'sqlite'
      ? this.impl.all('SELECT id,world_id,label,note,node_count,asset_count,created_at FROM revisions WHERE world_id = ? ORDER BY id DESC LIMIT ?', worldId, limit)
      : this.impl.data.revisions.filter(r => r.world_id === worldId).sort((a, b) => b.id - a.id).slice(0, limit);
    return rows;
  }

  getRevision(revId) {
    const row = this.engine === 'sqlite'
      ? this.impl.get('SELECT * FROM revisions WHERE id = ?', revId)
      : this.impl.data.revisions.find(r => r.id === Number(revId));
    if (!row) return null;
    return { ...row, world: safeJson(row.world_json) };
  }

  /* ---------------- events (activity column) ---------------- */

  logEvent(kind, detail = '') {
    const at = nowIso();
    if (this.engine === 'sqlite') {
      this.impl.run('INSERT INTO events (at,kind,detail) VALUES (?,?,?)', at, kind, String(detail));
      this.impl.run('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 400)');
    } else {
      this.impl.data.events.push({ id: this.impl.data.seq++, at, kind, detail: String(detail) });
      if (this.impl.data.events.length > 400) this.impl.data.events = this.impl.data.events.slice(-400);
      this.impl.save();
    }
    return { at, kind, detail };
  }

  recentEvents(limit = 40) {
    return this.engine === 'sqlite'
      ? this.impl.all('SELECT at,kind,detail FROM events ORDER BY id DESC LIMIT ?', limit)
      : this.impl.data.events.slice(-limit).reverse();
  }

  /* ---------------- settings ---------------- */

  getSetting(key, fallback = null) {
    const row = this.engine === 'sqlite'
      ? this.impl.get('SELECT value FROM settings WHERE key = ?', key)
      : (key in this.impl.data.settings ? { value: this.impl.data.settings[key] } : null);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }

  setSetting(key, value) {
    const v = asJson(value);
    if (this.engine === 'sqlite') {
      this.impl.run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, v);
    } else { this.impl.data.settings[key] = v; this.impl.save(); }
    return value;
  }

  /* ---------------- stats ---------------- */

  stats() {
    const worlds = this.listWorlds({ limit: 100000 });
    const assets = worlds.reduce((n, w) => n + (w.assetCount || 0), 0);
    const assetBytes = worlds.reduce((n, w) => n + (w.assetBytes || 0), 0);
    let dbBytes = 0;
    try { dbBytes = fs.statSync(this.path).size; } catch { /* not yet written */ }
    let diskBytes = 0;
    try {
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p); else diskBytes += fs.statSync(p).size;
        }
      };
      walk(this.assetsDir);
    } catch { /* empty store */ }
    return {
      engine: this.engine, path: this.path, dir: this.dir,
      worlds: worlds.length, assets, assetBytes, dbBytes, diskBytes,
      revisions: this.engine === 'sqlite'
        ? (this.impl.get('SELECT COUNT(*) AS n FROM revisions')?.n ?? 0)
        : this.impl.data.revisions.length,
    };
  }

  close() { this.impl.close(); }
}

/* ---------------- row helpers ---------------- */
function safeJson(v) { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } }
function statsOf(world) {
  return {
    nodes: (world?.nodes || []).length, edges: (world?.edges || []).length,
    zones: (world?.zones || []).length, landmarks: (world?.landmarks || []).length,
  };
}
function rowToMeta(r) {
  return {
    id: r.id, name: r.name, author: r.author || '', description: r.description || '',
    tags: safeJson(r.tags) || [], source: r.source || null,
    createdAt: r.created_at, updatedAt: r.updated_at, openedAt: r.opened_at,
    nodeCount: r.node_count || 0, edgeCount: r.edge_count || 0,
    zoneCount: r.zone_count || 0, landmarkCount: r.landmark_count || 0,
    assetCount: r.asset_count || 0, assetBytes: r.asset_bytes || 0,
    cover: r.cover_path ? `/api/worlds/${encodeURIComponent(r.id)}/cover` : null,
  };
}
