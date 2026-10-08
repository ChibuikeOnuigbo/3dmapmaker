/**
 * Panorama Maps — io/pworld.js
 *
 * THE `.pworld` FILE — one portable, self-contained world file.
 *
 *   "Everything that world is, inside one file."
 *
 * A `.pworld` holds ALL data of a world, not a reference to it:
 *
 *   pworld.json                 header: format, world card, stats, asset table
 *   world/world.json            the complete WorldGraph (nodes, edges, zones,
 *                               landmarks, scale, environment, settings)
 *   world/session.json          how the visitor left it (position, mode, view)
 *   world/cache.json            per-node identity metadata (validation reports)
 *   assets/panoramas/<id>.<ext> EVERY uploaded / bundled panorama image —
 *                               the original bytes, embedded in the file
 *   previews/panoramas/<id>.webp    display-sized derivative
 *   thumbnails/panoramas/<id>.webp  library thumbnail
 *   cover.jpg                   a picture of the world for the worlds library
 *
 * Because the pixels live INSIDE the file, a world keeps working when the
 * images are deleted from the device they were uploaded on, when the original
 * website is gone, and when the machine is offline. Nothing is fetched on
 * open: the file is the world.
 *
 * Container: a standard ZIP (stored entries — universally readable, no
 * compression step, no library) with the `.pworld` extension.
 *
 * SAFETY: every asset is verified by SHA-256 on import; path traversal is
 * rejected; entry counts and total size are capped; the world JSON is
 * schema-checked with the same validator `.pmap` uses.
 */
import { writeZip, readZip, safeZipPath } from './zipex.js';
import { sha256Hex } from '../gen/util.js';
import { validateWorldJson } from './storage.js';

export const PWORLD_FORMAT = 'PanoramaMapsWorld';
export const PWORLD_VERSION = 1;
export const PWORLD_EXT = '.pworld';
export const PWORLD_MIME = 'application/x-panorama-world';
/**
 * A world file can be wrong in a handful of ways, and each one has a different
 * answer for the person holding it. Say which one it is in words they can act
 * on — the technical reason stays in the sentence, because a bug report needs
 * it, but it is no longer the whole message.
 */
export function worldFileProblem(err) {
  const said = String(err?.message || err || 'unknown problem');
  if (/not a zip archive/i.test(said)) {
    return 'this is not a world file (not a zip archive) — “Save world file” writes the ones that open here';
  }
  if (/pworld\.json missing|not a Panorama World file/i.test(said)) {
    return 'this file has no Panorama World data inside it';
  }
  if (/checksum mismatch/i.test(said)) {
    const which = /:\s*([^\s:]+\.(?:jpe?g|png|webp|gif|bmp|avif|json))$/i.exec(said)?.[1];
    return which
      ? `the file is damaged — “${which}” no longer matches the checksum written when it was saved`
      : 'the file is damaged — its contents no longer match the checksum written when it was saved (checksum mismatch)';
  }
  if (/needs a newer app/i.test(said)) return `${said} — update the app to open it`;
  if (/world data missing/i.test(said)) return 'the file is incomplete — the world itself is not inside it';
  return said;
}

export const PWORLD_LIMITS = {
  maxEntries: 40000,
  maxFileBytes: 4 * 1024 * 1024 * 1024,     // 4 GB — refuse to load beyond this
  warnFileBytes: 400 * 1024 * 1024,         // warn the user above 400 MB
  maxCacheBytes: 24 * 1024 * 1024,          // identity metadata cap
};

const te = new TextEncoder();
const td = new TextDecoder();

export const IMAGE_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/bmp': '.bmp', 'image/avif': '.avif',
};

export function extForMime(mime = '') { return IMAGE_EXT[mime] || extOfName('') || '.img'; }
function extOfName(name = '') {
  const m = /\.(jpe?g|png|webp|gif|bmp|avif)$/i.exec(name || '');
  return m ? '.' + m[1].toLowerCase().replace('jpeg', 'jpg') : '';
}

/** A safe, human file name for a world: "Willow Parish" → "Willow-Parish.pworld" */
export function pworldFilename(name) {
  const base = String(name || 'panorama-world').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'panorama-world';
  return base + PWORLD_EXT;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

const toBytes = async (v) => {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new Error('asset payload is not binary data');
};

/* ==================================================================== */
/* EXPORT                                                                */
/* ==================================================================== */

/**
 * Assemble ONE `.pworld` from already-collected assets.
 *
 * @param {object} opts
 * @param {{id?:string,name?:string,author?:string,description?:string,tags?:string[]}} opts.world   world card
 * @param {object} opts.worldJson          full WorldGraph JSON (references asset ids)
 * @param {Array}  opts.assets             [{id, role, mode, mime, name, sha256, width, height, original, display?, thumbnail?}]
 * @param {object} [opts.session]          where the visitor stands + view preferences
 * @param {object} [opts.cacheMeta]        per-node identity metadata (optional)
 * @param {Uint8Array|Blob} [opts.cover]   cover picture
 * @param {Array}  [opts.missing]          assets that could not be embedded
 * @param {(p:object)=>void} [opts.onProgress]
 * @returns {Promise<{bytes:Uint8Array, manifest:object}>}
 */
export async function exportPworld({
  world = {}, worldJson, assets = [], session = null, cacheMeta = null,
  cover = null, missing = [], onProgress = () => {}, appVersion = '1.0.0',
} = {}) {
  if (!worldJson || typeof worldJson !== 'object') throw new Error('no world to save');
  const entries = [];
  const assetTable = [];
  const total = assets.length;
  let done = 0;

  for (const a of assets) {
    const original = await toBytes(a.original);
    if (!original || !original.length) { missing.push({ id: a.id, reason: 'empty image data' }); continue; }
    const sha = a.sha256 || await sha256Hex(original);
    const id = a.id || ('asset_' + sha.slice(0, 12));
    const ext = extForMime(a.mime) || extOfName(a.name) || '.img';
    const path = `assets/panoramas/${id}${ext}`;
    entries.push({ path, data: original });

    const rec = {
      id, path, role: a.role || 'panorama', mode: a.mode ?? null,
      mime: a.mime || 'image/jpeg', name: a.name || null,
      source: a.source || null, bytes: original.length, sha256: sha,
      width: a.width ?? null, height: a.height ?? null,
      embedded: true,
    };
    const display = await toBytes(a.display);
    if (display?.length) {
      const dpath = `previews/panoramas/${id}.webp`;
      entries.push({ path: dpath, data: display });
      rec.display = { path: dpath, bytes: display.length };
    }
    const thumb = await toBytes(a.thumbnail);
    if (thumb?.length) {
      const tpath = `thumbnails/panoramas/${id}.webp`;
      entries.push({ path: tpath, data: thumb });
      rec.thumbnail = { path: tpath, bytes: thumb.length };
    }
    assetTable.push(rec);
    onProgress({ phase: 'assets', done: ++done, total, label: a.name || id });
  }

  if (cover) {
    const cv = await toBytes(cover);
    if (cv?.length) entries.push({ path: 'cover.jpg', data: cv });
  }
  if (cacheMeta && typeof cacheMeta === 'object') {
    const cacheBytes = te.encode(JSON.stringify(cacheMeta));
    if (cacheBytes.length <= PWORLD_LIMITS.maxCacheBytes) entries.push({ path: 'world/cache.json', data: cacheBytes });
  }

  const worldBytes = te.encode(JSON.stringify(worldJson));
  entries.push({ path: 'world/world.json', data: worldBytes });
  if (session) entries.push({ path: 'world/session.json', data: te.encode(JSON.stringify(session)) });

  const imageBytes = assetTable.reduce((n, a) => n + a.bytes, 0);
  const manifest = {
    format: PWORLD_FORMAT,
    formatVersion: PWORLD_VERSION,
    generator: { app: 'Panorama Maps', version: appVersion },
    createdAt: new Date().toISOString(),
    world: {
      id: world.id ?? worldJson.id ?? null,
      name: world.name ?? worldJson.name ?? 'Untitled world',
      author: world.author || '',
      description: world.description || worldJson.description || '',
      tags: Array.isArray(world.tags) ? world.tags : [],
      source: world.source || null,
      createdAt: world.createdAt || null,
      updatedAt: new Date().toISOString(),
    },
    stats: {
      nodes: (worldJson.nodes || []).length,
      edges: (worldJson.edges || []).length,
      zones: (worldJson.zones || []).length,
      landmarks: (worldJson.landmarks || []).length,
      images: assetTable.length,
      imageBytes,
    },
    scene: { modes: world.modes || [], displayMode: session?.displayMode || null },
    assets: assetTable,
    missing,
    integrity: { algorithm: 'sha256', worldSha256: await sha256Hex(worldBytes) },
    note: 'Every image is embedded in this file. Deleting the originals from the device does not affect it.',
  };
  entries.unshift({ path: 'pworld.json', data: te.encode(JSON.stringify(manifest, null, 1)) });

  onProgress({ phase: 'archive', done: 0, total: 1, label: 'assembling file' });
  const bytes = writeZip(entries);
  manifest.stats.fileBytes = bytes.length;
  onProgress({ phase: 'archive', done: 1, total: 1, label: 'done' });
  return { bytes, manifest };
}

/**
 * Walk a WorldGraph and collect EVERY image it needs, as binary data.
 *
 * Sources, in order:
 *   1. `resolveAsset(assetId)` — the app's own store (IndexedDB or the
 *      desktop database) → uploaded panoramas, 2D map image, embedded sets.
 *   2. `fetchBytes(url)` — bundled world art (e.g. assets/willow/day/n3.jpg)
 *      is downloaded and EMBEDDED, so the file never depends on the website.
 *
 * The returned `worldJson` is a copy that references the embedded assets:
 *   kind 'urlset'    → kind 'embedded'  (one asset id per scene mode)
 *   kind 'asset'     → unchanged ids (their bytes ride along in the file)
 *
 * @returns {Promise<{assets:Array, worldJson:object, missing:Array, modes:string[], bytes:number, nodes:number}>}
 */
export async function collectWorldAssets(graph, {
  json = null, projectId = null, modes = null, resolveAsset = null, fetchBytes = null,
  onProgress = () => {}, includePreviews = true, fetchLimit = 8,
} = {}) {
  const src = json || graph.toJSON();
  const out = JSON.parse(JSON.stringify(src));
  const assets = new Map();          // id → record (deduped by sha where known)
  const bySha = new Map();
  const missing = [];
  const missingIndex = new Map();
  const noteMissing = (entry, nodeId = null) => {
    const key = `${entry.assetId || ''}|${entry.url || ''}|${entry.mode || ''}|${entry.reason}`;
    const hit = missingIndex.get(key);
    if (hit) { if (nodeId && !hit.nodes.includes(nodeId)) hit.nodes.push(nodeId); return; }
    const rec = { ...entry, nodes: nodeId ? [nodeId] : [] };
    missingIndex.set(key, rec);
    missing.push(rec);
  };
  const modesSeen = new Set();
  let fetched = 0, fetchTotal = 0;

  const fetchFn = fetchBytes || (async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: res.headers?.get?.('content-type') || blob.type || mimeFromUrl(url) || '' };
  });

  /** Add bytes as an asset (deduped by sha256). Returns the asset id. */
  const addBytes = async (bytes, meta = {}) => {
    const sha = await sha256Hex(bytes);
    if (bySha.has(sha)) return bySha.get(sha);
    const id = meta.id && !assets.has(meta.id) ? meta.id : 'asset_' + sha.slice(0, 12);
    const rec = {
      id, role: meta.role || 'panorama', mode: meta.mode ?? null,
      mime: meta.mime || 'image/jpeg', name: meta.name || null, source: meta.source || null,
      sha256: sha, width: meta.width ?? null, height: meta.height ?? null,
      original: bytes, display: meta.display || null, thumbnail: meta.thumbnail || null,
    };
    assets.set(id, rec); bySha.set(sha, id);
    return id;
  };

  /** Pull an asset out of the app store by id. */
  const pullStored = async (assetId, meta = {}) => {
    if (!assetId) return null;
    const hit = [...assets.values()].find(a => a.id === assetId && a.original);
    if (hit) return hit.id;
    if (!resolveAsset) return null;
    const found = await resolveAsset(assetId);
    if (!found?.original) return null;
    const bytes = await toBytes(found.original);
    return addBytes(bytes, {
      id: assetId, role: found.role || meta.role || 'panorama', mode: found.mode ?? meta.mode ?? null,
      mime: found.mime || meta.mime, name: found.name || found.meta?.originalName || meta.name,
      width: found.width ?? found.meta?.width, height: found.height ?? found.meta?.height,
      source: meta.source, display: includePreviews ? await toBytes(found.display) : null,
      thumbnail: includePreviews ? await toBytes(found.thumbnail) : null,
    });
  };

  /* ---- pass 1: what needs fetching (bundled photo sets) ---- */
  const jobs = [];
  for (const n of out.nodes || []) {
    const p = n.pano;
    if (!p) continue;
    if (p.kind === 'urlset' && p.variants) {
      for (const [mode, url] of Object.entries(p.variants)) {
        modesSeen.add(mode);
        if (modes && !modes.includes(mode)) continue;
        if (typeof url === 'string' && url) jobs.push({ nodeId: n.id, mode, url });
      }
    } else if (p.kind === 'embedded' && p.variants) {
      for (const mode of Object.keys(p.variants)) modesSeen.add(mode);
    }
  }

  /* ---- pass 2: fetch bundled images (bounded parallelism) ---- */
  fetchTotal = jobs.length;
  const fetchedByKey = new Map();
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      try {
        const res = await fetchFn(job.url, job);
        const bytes = await toBytes(res.bytes ?? res);
        if (!bytes?.length) throw new Error('empty response');
        fetchedByKey.set(`${job.nodeId}|${job.mode}`, {
          bytes, mime: res.mime || mimeFromUrl(job.url) || 'image/jpeg', url: job.url,
        });
      } catch (err) {
        noteMissing({ mode: job.mode, url: job.url, reason: String(err?.message || err) }, job.nodeId);
      }
      fetched++;
      onProgress({ phase: 'fetch', done: fetched, total: fetchTotal, label: job.url });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(fetchLimit, jobs.length)) }, worker));

  /* ---- pass 3: rewrite nodes to point at embedded bytes ---- */
  for (const n of out.nodes || []) {
    const p = n.pano;
    if (!p) continue;

    if (p.kind === 'urlset' && p.variants) {
      const embedded = {};
      const origins = {};
      for (const [mode, url] of Object.entries(p.variants)) {
        const got = fetchedByKey.get(`${n.id}|${mode}`);
        if (!got) { origins[mode] = url; continue; }         // not asked for / failed → keep the URL
        const id = await addBytes(got.bytes, {
          role: 'panorama', mode, mime: got.mime, name: nameFromUrl(url), source: url,
        });
        embedded[mode] = id;
        origins[mode] = url;
      }
      if (Object.keys(embedded).length) {
        // any mode that stayed URL-only (not selected, or the fetch failed)
        // remains as a fallback so a partly embedded world still walks
        const leftovers = Object.fromEntries(Object.entries(origins).filter(([m]) => !(m in embedded)));
        n.pano = {
          kind: 'embedded',
          variants: embedded,
          origins,
          source: p.source || origins.day || origins[Object.keys(origins)[0]] || null,
        };
        if (Object.keys(leftovers).length) n.pano.fallbackVariants = leftovers;
      }
    } else if (p.kind === 'embedded' && p.variants) {
      const variants = {};
      for (const [mode, assetId] of Object.entries(p.variants)) {
        const id = await pullStored(assetId, { role: 'panorama', mode, source: p.origins?.[mode] || p.source });
        if (id) variants[mode] = id;
        else noteMissing({ mode, assetId, reason: 'image not found in the local store' }, n.id);
      }
      n.pano = { ...p, variants, origins: p.origins || null };
    } else if (p.kind === 'asset' && p.assetId) {
      const id = await pullStored(p.assetId, { role: 'panorama', source: p.source });
      if (id) n.pano = { ...p, assetId: id };
      else noteMissing({ assetId: p.assetId, reason: 'uploaded panorama not found in the local store' }, n.id);
    }
    onProgress({ phase: 'nodes', done: 0, total: 0, label: n.name || n.id });
  }

  /* ---- pass 4: the 2D map image (map underlay) ---- */
  const env = out.environment || {};
  if (env.mapUnderlay?.assetId) {
    const id = await pullStored(env.mapUnderlay.assetId, { role: 'map', source: '2D map image' });
    if (id) out.environment = { ...env, mapUnderlay: { ...env.mapUnderlay, assetId: id } };
    else noteMissing({ assetId: env.mapUnderlay.assetId, reason: '2D map image not found in the local store' });
  }

  const list = [...assets.values()];
  return {
    assets: list,
    worldJson: out,
    missing,
    modes: [...modesSeen],
    images: list.length,
    bytes: list.reduce((n, a) => n + (a.original?.length || 0), 0),
    nodes: (out.nodes || []).length,
  };
}

function mimeFromUrl(url = '') {
  const m = /\.(jpe?g|png|webp|gif|bmp|avif)(?:$|\?)/i.exec(url);
  return m ? `image/${m[1].toLowerCase().replace('jpg', 'jpeg')}` : null;
}
function nameFromUrl(url = '') {
  try { const u = String(url).split(/[?#]/)[0]; return decodeURIComponent(u.split('/').pop() || u); }
  catch { return url; }
}

/* ==================================================================== */
/* IMPORT / VERIFY                                                       */
/* ==================================================================== */

/**
 * Read the header of a `.pworld` WITHOUT importing it — used by the worlds
 * library to show name, size, counts before the user commits.
 */
export async function inspectPworld(input) {
  const bytes = await toBytes(input);
  const entries = await readZip(bytes);
  const raw = entries.get('pworld.json');
  if (!raw) throw new Error('pworld.json missing — not a Panorama World file');
  const manifest = JSON.parse(td.decode(raw));
  if (manifest.format !== PWORLD_FORMAT) throw new Error('this file is not a Panorama World file');
  return { manifest, fileBytes: bytes.length, entryCount: entries.size };
}

/** Verify header + every embedded asset hash. Throws on structural damage. */
export async function verifyPworld(input) {
  const bytes = await toBytes(input);
  if (bytes.length > PWORLD_LIMITS.maxFileBytes) throw new Error('world file is too large to open safely');
  const entries = await readZip(bytes);
  if (entries.size > PWORLD_LIMITS.maxEntries) throw new Error('world file has too many entries');
  const raw = entries.get('pworld.json');
  if (!raw) throw new Error('pworld.json missing — not a Panorama World file');
  const manifest = JSON.parse(td.decode(raw));
  if (manifest.format !== PWORLD_FORMAT) throw new Error('this file is not a Panorama World file');
  if ((manifest.formatVersion || 0) > PWORLD_VERSION) throw new Error(`world file v${manifest.formatVersion} needs a newer app`);
  const worldRaw = entries.get('world/world.json');
  if (!worldRaw) throw new Error('world data missing');
  if (manifest.integrity?.worldSha256) {
    const sha = await sha256Hex(worldRaw);
    if (sha !== manifest.integrity.worldSha256) throw new Error('world data is damaged (checksum mismatch)');
  }
  for (const a of manifest.assets || []) {
    const data = entries.get(safeZipPath(a.path));
    if (!data?.length) throw new Error(`image missing from the file: ${a.path}`);
    if (a.sha256 && await sha256Hex(data) !== a.sha256) throw new Error(`image is damaged (checksum mismatch): ${a.path}`);
  }
  return { manifest, entries, bytes };
}

/**
 * Full import: verify → parse the world → hand back the embedded images as
 * binary payloads the caller stages into its own store (IndexedDB / database).
 *
 * @returns {Promise<{manifest, world, session, cacheMeta, assets:Array, warnings:string[], fileBytes:number}>}
 */
export async function importPworld(input, { verify = true } = {}) {
  const { manifest, entries, bytes } = verify
    ? await verifyPworld(input)
    : await (async () => {
        const b = await toBytes(input);
        const e = await readZip(b);
        return { manifest: JSON.parse(td.decode(e.get('pworld.json'))), entries: e, bytes: b };
      })();

  const worldRaw = entries.get('world/world.json');
  const world = JSON.parse(td.decode(worldRaw));
  validateWorldJson(world);                                  // untrusted input
  const session = entries.get('world/session.json') ? JSON.parse(td.decode(entries.get('world/session.json'))) : null;
  const cacheMeta = entries.get('world/cache.json') ? JSON.parse(td.decode(entries.get('world/cache.json'))) : null;

  const assets = [];
  const warnings = [];
  for (const a of manifest.assets || []) {
    const data = entries.get(safeZipPath(a.path));
    if (!data) { warnings.push(`image missing: ${a.name || a.id}`); continue; }
    const preview = a.display?.path ? entries.get(a.display.path) : null;
    const thumb = a.thumbnail?.path ? entries.get(a.thumbnail.path) : null;
    assets.push({
      id: a.id, role: a.role || 'panorama', mode: a.mode ?? null, mime: a.mime || 'image/jpeg',
      name: a.name || null, source: a.source || null, sha256: a.sha256 || null,
      width: a.width ?? null, height: a.height ?? null,
      bytes: data.length,
      original: new Blob([data], { type: a.mime || 'image/jpeg' }),
      display: preview ? new Blob([preview], { type: 'image/webp' }) : null,
      thumbnail: thumb ? new Blob([thumb], { type: 'image/webp' }) : null,
      _rawOriginal: data,
    });
  }
  if (!assets.length && (manifest.stats?.images || 0) > 0) warnings.push('no images could be read from this file');
  if (manifest.missing?.length) {
    warnings.push(`${manifest.missing.length} image(s) were not embedded when this world was saved`);
  }
  // a node that points at an asset list entry which is absent → flag, never crash
  for (const n of world.nodes || []) {
    const p = n.pano;
    if (!p) continue;
    if (p.kind === 'asset' && p.assetId && !assets.some(a => a.id === p.assetId)) { n.pano = { ...p, missing: true }; }
    if (p.kind === 'embedded' && p.variants) {
      const keep = {};
      for (const [m, id] of Object.entries(p.variants)) {
        if (assets.some(a => a.id === id)) keep[m] = id;
        else warnings.push(`scene “${m}” has no image in this file`);
      }
      n.pano = { ...p, variants: keep, missing: Object.keys(keep).length === 0 };
    }
  }
  // the cover comes back with the import: readers do not have to unzip twice
  const coverRaw = entries.get('cover.jpg') || null;
  const cover = coverRaw ? new Blob([coverRaw], { type: 'image/jpeg' }) : null;
  return { manifest, world, session, cacheMeta, assets, warnings, cover, fileBytes: bytes.length };
}

/** The cover picture inside a file (or null). */
export async function readCover(input) {
  const bytes = await toBytes(input);
  const entries = await readZip(bytes);
  const c = entries.get('cover.jpg');
  return c ? new Blob([c], { type: 'image/jpeg' }) : null;
}

export { toBytes as pworldBytes };
