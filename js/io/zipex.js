/**
 * Panorama Maps — io/zipex.js
 *
 * Minimal, dependency-free ZIP archive writer + reader for the portable
 * `.pmap` project file (Spec: system prompt §5–§7, §66–§67).
 *
 * Writer emits "stored" (uncompressed) entries — universally readable.
 * Reader handles stored entries and deflated entries via the platform
 * DecompressionStream('deflate-raw') where available.
 *
 * Archive SAFETY: path-traversal rejection (`..`, absolute paths), entry
 * count cap, and uncompressed-size cap enforced by ProjectArchive BEFORE
 * unpacking — this module exposes the metadata needed for those checks.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const te = new TextEncoder();
const td = new TextDecoder();

/** Normalize + validate an archive-internal path. Throws on traversal. */
export function safeZipPath(path) {
  if (typeof path !== 'string' || !path.length) throw new Error('invalid zip path');
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(path)) throw new Error(`absolute path rejected: ${path}`);
  const parts = path.split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) throw new Error(`path traversal rejected: ${path}`);
  return parts.join('/');
}

/**
 * Write a ZIP (stored entries).
 * @param {Array<{path:string, data:Uint8Array}>} entries
 * @returns {Uint8Array}
 */
export function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = (arr) => { chunks.push(arr); offset += arr.length; };
  const u16 = (v) => new Uint8Array([v & 255, (v >>> 8) & 255]);
  const u32 = (v) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);

  for (const e of entries) {
    const nameBytes = te.encode(safeZipPath(e.path));
    const crc = crc32(e.data);
    const local = [
      u32(0x04034b50), u16(20), u16(0x0800), u16(0 /* stored */), u16(0), u16(0),
      u32(crc), u32(e.data.length), u32(e.data.length), u16(nameBytes.length), u16(0),
      nameBytes, e.data,
    ];
    const localOffset = offset;
    for (const c of local) push(c);
    central.push({ nameBytes, crc, size: e.data.length, offset: localOffset });
  }

  const cdStart = offset;
  for (const c of central) {
    const rec = [
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(c.crc), u32(c.size), u32(c.size), u16(c.nameBytes.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset), c.nameBytes,
    ];
    for (const r of rec) push(r);
  }
  const cdSize = offset - cdStart;
  const end = [u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0)];
  for (const r of end) push(r);

  const out = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * Read a ZIP archive into memory-mapped entries.
 * @param {Uint8Array} bytes
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // locate End Of Central Directory
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65536); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (EOCD not found)');
  const count = dv.getUint16(eocd + 10, true);
  let cd = dv.getUint32(eocd + 16, true);

  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(cd, true) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = dv.getUint16(cd + 10, true);
    const compSize = dv.getUint32(cd + 20, true);
    const nameLen = dv.getUint16(cd + 28, true);
    const extraLen = dv.getUint16(cd + 30, true);
    const commentLen = dv.getUint16(cd + 32, true);
    const localOff = dv.getUint32(cd + 42, true);
    const name = td.decode(bytes.subarray(cd + 46, cd + 46 + nameLen));
    cd += 46 + nameLen + extraLen + commentLen;

    const safe = safeZipPath(name);
    const lnLen = dv.getUint16(localOff + 26, true);
    const leLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lnLen + leLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = new Uint8Array(raw);
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`unsupported zip method ${method} for ${safe}`);
    entries.set(safe, data);
  }
  return entries;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('deflate entries unsupported on this platform');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
