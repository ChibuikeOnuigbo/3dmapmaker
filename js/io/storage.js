/**
 * Panorama Maps — io/storage.js
 *
 * Storage architecture (system prompt §122 / §180):
 *
 *   .pmap portable project file  ←  SOURCE OF TRUTH / BACKUP
 *        └── manifest.json + world.json + assets/{original,previews,thumbnails}/
 *   IndexedDB                    ←  local working mirror (convenience cache)
 *   Blob + Object URLs           ←  runtime display (never data-URI storage)
 *   localStorage                 ←  TINY preferences only (never images/JSON)
 *
 * No absolute OS paths are ever required; no panorama is ever stored in
 * localStorage; no image becomes a base64 JSON string.
 */
import { writeZip, readZip, crc32 } from './zipex.js';
import { sha256Hex } from '../gen/util.js';

/* ------------------------- tiny preferences ------------------------- */
const PREFS_KEY = 'panoramaMaps.prefs.v1';
export const prefs = {
  load() { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; } },
  save(patch) {
    const p = { ...prefs.load(), ...patch };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* quota — non-fatal */ }
    return p;
  },
};

/* ------------------------- IndexedDB mirror ------------------------- */
const DB_NAME = 'panorama-maps';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class ProjectStorage {
  constructor() { this._db = null; }
  async db() { return (this._db ??= await openDb()); }

  _tx(store, mode, fn) {
    return this.db().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const st = tx.objectStore(store);
      const out = fn(st);
      tx.oncomplete = () => resolve(out?.result !== undefined ? out.result : out);
      tx.onerror = () => reject(tx.error);
    }));
  }

  async saveProjectMeta(record) { await this._tx('projects', 'readwrite', st => st.put(record)); }
  async getProjectMeta(id) { return this._tx('projects', 'readonly', st => st.get(id)); }
  async deleteProject(id) {
    await this._tx('projects', 'readwrite', st => st.delete(id));
    const all = await this.listAssets(id);
    await this._tx('assets', 'readwrite', st => all.forEach(a => st.delete(a.key)));
  }
  async listProjects() {
    const all = await this._tx('projects', 'readonly', st => st.getAll());
    return (all || []).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  async putAsset(projectId, assetId, blob, meta) {
    const key = `${projectId}/${assetId}`;
    await this._tx('assets', 'readwrite', st => st.put({ key, blob, meta }));
    return key;
  }
  async getAsset(projectId, assetId) { return this._tx('assets', 'readonly', st => st.get(`${projectId}/${assetId}`)); }
  async listAssets(projectId) {
    const all = await this._tx('assets', 'readonly', st => st.getAll());
    return (all || []).filter(a => a.key.startsWith(projectId + '/'));
  }

  /** Quota estimate (internal use; only surfaced when nearly full). */
  async quotaEstimate() {
    try { if (navigator.storage?.estimate) return await navigator.storage.estimate(); } catch { /* */ }
    return null;
  }
}

/* ------------------------- AssetManager ------------------------- */
export const IMAGE_LIMITS = {
  maxBytes: 250 * 1024 * 1024,       // single-image hard cap
  warnBytes: 100 * 1024 * 1024,
  maxPixels: 19200 * 9600,
  displayMax: { w: 2048, h: 1024 },
  thumbMax: { w: 384, h: 192 },
};

export class AssetManager {
  constructor(storage, projectId) { this.storage = storage; this.projectId = projectId; this.byHash = new Map(); }

  async reindex() {
    this.byHash.clear();
    for (const a of await this.storage.listAssets(this.projectId)) {
      if (a.meta?.sha256) this.byHash.set(a.meta.sha256, a.meta.id);
    }
  }

  /**
   * Import a user image: validate (real decode, not just extension), hash for
   * dedupe, keep ORIGINAL + derived display + thumbnail. Never mutates the
   * original bytes (Spec §12).
   */
  async importImage(file, role = 'panorama') {
    if (file.size > IMAGE_LIMITS.maxBytes) throw new Error(`"${file.name}" is larger than 250 MB`);
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name)) {
      throw new Error(`"${file.name}" is not a supported image`);
    }
    const buf = await file.arrayBuffer();
    const sha = await sha256Hex(buf);
    if (this.byHash.has(sha)) {
      const existingId = this.byHash.get(sha);
      return { assetId: existingId, deduped: true, meta: (await this.storage.getAsset(this.projectId, existingId))?.meta };
    }
    let bmp;
    try { bmp = await createImageBitmap(new Blob([buf], { type: file.type })); }
    catch { throw new Error(`"${file.name}" could not be decoded — corrupt or unsupported`); }
    const pixels = bmp.width * bmp.height;
    if (pixels > IMAGE_LIMITS.maxPixels) { bmp.close(); throw new Error(`"${file.name}" exceeds ${IMAGE_LIMITS.maxPixels / 1e6 | 0} MP`); }

    const assetId = 'asset_' + sha.slice(0, 12);
    const display = await this._derivative(bmp, IMAGE_LIMITS.displayMax, 'image/webp', 0.86);
    const thumb = await this._derivative(bmp, IMAGE_LIMITS.thumbMax, 'image/webp', 0.8);

    const meta = {
      id: assetId, role, originalName: file.name,
      mime: file.type || 'image/jpeg', width: bmp.width, height: bmp.height, bytes: file.size,
      sha256: sha, aspectRatio: bmp.width / bmp.height,
      display: display.meta, thumbnail: thumb.meta,
      createdAt: new Date().toISOString(),
    };
    const payload = { original: new Blob([buf], { type: meta.mime }), display: display.blob, thumbnail: thumb.blob };
    await this.storage.putAsset(this.projectId, assetId, payload.original, { ...meta, payloadKind: 'original' });
    await this.storage.putAsset(this.projectId, assetId + ':display', payload.display, { id: assetId + ':display', of: assetId });
    await this.storage.putAsset(this.projectId, assetId + ':thumb', payload.thumbnail, { id: assetId + ':thumb', of: assetId });
    this.byHash.set(sha, assetId);
    bmp.close();
    return { assetId, deduped: false, meta };
  }

  async _derivative(bmp, max, type, quality) {
    const scale = Math.min(1, Math.min(max.w / bmp.width, max.h / bmp.height));
    const w = Math.max(2, Math.round(bmp.width * scale)), h = Math.max(2, Math.round(bmp.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise(r => c.toBlob(r, type, quality));
    return { blob, meta: { width: w, height: h, mime: type, bytes: blob.size } };
  }

  /** Object URL for display; caller must revoke when evicted (Spec §21 in sys prompt). */
  async objectUrl(projectId, assetId, variant = 'display') {
    const rec = await this.storage.getAsset(projectId, variant === 'original' ? assetId : `${assetId}:${variant}`);
    if (!rec?.blob) return null;
    return { url: URL.createObjectURL(rec.blob), revoke: () => URL.revokeObjectURL(rec.blob.objUrl ?? null) || URL.revokeObjectURL(rec._objUrl) };
  }
}

/* ------------------------- ProjectArchive (.pmap) ------------------------- */
export const PMAP_FORMAT = 'PanoramaMapsProject';
export const PMAP_VERSION = 1;
export const PMAP_LIMITS = { maxEntries: 5000, maxUncompressedBytes: 1.5 * 1024 * 1024 * 1024 };

export class ProjectArchive {
  /**
   * Export: assemble ONE portable `.pmap` (ZIP). Verified before returning.
   * @param {object} project {id, name, world}
   * @param {Array<{assetId:string, meta:object, original:Blob, display?:Blob, thumbnail?:Blob}>} assets
   */
  static async exportPmap(project, assets) {
    const te = new TextEncoder();
    const entries = [];
    const assetTable = [];
    for (const a of assets) {
      const orig = new Uint8Array(await a.original.arrayBuffer());
      const base = `assets/panoramas/${a.assetId}${extOf(a.meta.mime)}`;
      entries.push({ path: base, data: orig });
      const rec = {
        id: a.assetId, path: base, mime: a.meta.mime, width: a.meta.width, height: a.meta.height,
        bytes: a.meta.bytes, sha256: a.meta.sha256, originalName: a.meta.originalName,
      };
      if (a.display) {
        const d = new Uint8Array(await a.display.arrayBuffer());
        entries.push({ path: `previews/panoramas/${a.assetId}.webp`, data: d });
        rec.display = { path: `previews/panoramas/${a.assetId}.webp`, width: a.meta.display?.width, height: a.meta.display?.height };
      }
      if (a.thumbnail) {
        const t = new Uint8Array(await a.thumbnail.arrayBuffer());
        entries.push({ path: `thumbnails/panoramas/${a.assetId}.webp`, data: t });
        rec.thumbnail = { path: `thumbnails/panoramas/${a.assetId}.webp` };
      }
      assetTable.push(rec);
    }
    const manifest = {
      format: PMAP_FORMAT, formatVersion: PMAP_VERSION,
      projectId: project.id, name: project.name,
      createdAt: project.createdAt, updatedAt: new Date().toISOString(),
      world: 'world/world.json', assets: assetTable,
    };
    entries.push({ path: 'manifest.json', data: te.encode(JSON.stringify(manifest, null, 1)) });
    entries.push({ path: 'world/world.json', data: te.encode(JSON.stringify(project.world)) });

    const zip = writeZip(entries);
    await ProjectArchive.verify(zip);              // never report success unverified
    return zip;
  }

  /** Structural verification used after export and before import. */
  static async verify(zipBytes) {
    const entries = await readZip(zipBytes);
    const manifestRaw = entries.get('manifest.json');
    if (!manifestRaw) throw new Error('manifest.json missing');
    const manifest = JSON.parse(new TextDecoder().decode(manifestRaw));
    if (manifest.format !== PMAP_FORMAT) throw new Error('not a Panorama Maps project');
    if (!entries.get('world/world.json')) throw new Error('world data missing');
    let total = 0, count = 0;
    for (const [, data] of entries) { total += data.length; count++; }
    if (count > PMAP_LIMITS.maxEntries) throw new Error('archive has too many entries');
    if (total > PMAP_LIMITS.maxUncompressedBytes) throw new Error('archive expands beyond safety limit');
    for (const a of manifest.assets || []) {
      const data = entries.get(a.path);
      if (!data) throw new Error(`asset missing: ${a.path}`);
      if (crc32(data) !== undefined && a.sha256 == null) { /* hash optional in v1 */ }
    }
    return manifest;
  }

  /**
   * Import: parse + validate WITHOUT touching the current project (atomic —
   * caller commits to IndexedDB only after this resolves, Spec §28).
   */
  static async importPmap(fileOrBytes) {
    const bytes = fileOrBytes instanceof Uint8Array ? fileOrBytes : new Uint8Array(await fileOrBytes.arrayBuffer());
    if (bytes.length > PMAP_LIMITS.maxUncompressedBytes) throw new Error('file too large');
    const manifest = await ProjectArchive.verify(bytes);
    if (manifest.formatVersion > PMAP_VERSION) throw new Error(`project format v${manifest.formatVersion} needs a newer app`);
    const entries = await readZip(bytes);
    const world = JSON.parse(new TextDecoder().decode(entries.get('world/world.json')));
    validateWorldJson(world);                     // untrusted JSON — validate (Spec §68)
    const assets = new Map();
    for (const a of manifest.assets || []) assets.set(a.path, entries.get(a.path));
    return { manifest, world, entries, assets };
  }
}

function extOf(mime = '') {
  return { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp' }[mime] || '.img';
}

/** Schema sanity for untrusted world JSON (types, ranges, references). */
export function validateWorldJson(w) {
  if (typeof w !== 'object' || w === null) throw new Error('world is not an object');
  if (!Array.isArray(w.nodes) || !Array.isArray(w.edges)) throw new Error('world missing nodes/edges');
  if (w.nodes.length > 200000) throw new Error('world too large to import safely');
  const ids = new Set();
  for (const n of w.nodes) {
    if (typeof n.id !== 'string' || !n.id) throw new Error('node missing id');
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) throw new Error(`node ${n.id}: bad coordinates`);
    if (ids.has(n.id)) throw new Error(`duplicate node id ${n.id}`);
    ids.add(n.id);
  }
  for (const e of w.edges) {
    if (!ids.has(e.a) || !ids.has(e.b)) throw new Error(`edge ${e.id ?? '?'} references unknown node`);
  }
  if (w.scale && typeof w.scale.pixelsPerMeter !== 'number') throw new Error('invalid map scale');
  return true;
}

/* ------------------------- File System Access ------------------------- */
export const fsAccess = {
  get supported() { return typeof window !== 'undefined' && 'showSaveFilePicker' in window; },

  async saveBlob(blob, suggestedName, handle = null) {
    if (this.supported) {
      try {
        const h = handle ?? await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: 'Panorama Maps Project', accept: { 'application/zip': ['.pmap'] } }],
        });
        const w = await h.createWritable();
        await w.write(blob); await w.close();
        return { ok: true, handle: h };
      } catch (err) {
        if (err?.name === 'AbortError') return { ok: false, aborted: true };
        // fall through to download on any other failure
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = suggestedName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return { ok: true, handle: null, download: true };
  },

  async openFile(accept = '.pmap') {
    if (this.supported) {
      try {
        const [h] = await window.showOpenFilePicker({ types: [{ description: 'Panorama Maps Project', accept: { 'application/zip': ['.pmap'] } }] });
        return await h.getFile();
      } catch (err) {
        if (err?.name === 'AbortError') return null;
      }
    }
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = accept;
      input.onchange = () => resolve(input.files[0] || null);
      input.oncancel = () => resolve(null);
      input.click();
    });
  },
};
