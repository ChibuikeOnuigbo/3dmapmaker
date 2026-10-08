#!/usr/bin/env node
/**
 * Panorama Maps — desktop/cli.mjs
 *
 * The worlds database from a terminal (no window, no server):
 *
 *   node desktop/cli.mjs list
 *   node desktop/cli.mjs info <worldId>
 *   node desktop/cli.mjs import path/to/World.pworld [--name "Renamed"]
 *   node desktop/cli.mjs export <worldId> [--out dir] [--modes day,night]
 *   node desktop/cli.mjs delete <worldId>
 *   node desktop/cli.mjs gc          unlink image files no world references
 *   node desktop/cli.mjs stats
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopApp, APP_ROOT } from './server.mjs';
import { defaultDataDir } from './db.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'stats';

const VALUED_FLAGS = new Set(['name', 'out', 'modes', 'data-dir']);
const flag = (name, dflt = null) => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith('--') ? next : true;
    }
    if (a.startsWith(`--${name}=`)) {
      return a.slice(name.length + 3);
    }
  }
  return dflt;
};

const rest = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (eq < 0 && VALUED_FLAGS.has(name) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      i++;
    }
    continue;
  }
  rest.push(a);
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

const dirArg = flag('data-dir');
const dataDir = dirArg ? path.resolve(String(dirArg)) : defaultDataDir();

const app = await createDesktopApp({ root: APP_ROOT, dataDir, quiet: true });
const db = app.db;

try {
  switch (cmd) {
    case 'stats': {
      const s = db.stats();
      console.log(`Panorama Maps — worlds database
  engine      : ${s.engine}
  database    : ${s.path}
  world(s)    : ${s.worlds}
  image(s)    : ${s.assets} (${mb(s.assetBytes)})
  revisions   : ${s.revisions}
  on disk     : ${mb(s.diskBytes)}`);
      break;
    }
    case 'list': {
      const worlds = db.listWorlds({});
      if (!worlds.length) { console.log('no worlds yet — import one: node desktop/cli.mjs import World.pworld'); break; }
      console.log(['', 'id', 'name', 'places', 'images', 'size', 'updated'].join('\t'));
      for (const w of worlds) {
        console.log(['', w.id, w.name, w.nodeCount, w.assetCount, mb(w.assetBytes), (w.updatedAt || '').slice(0, 19).replace('T', ' ')].join('\t'));
      }
      break;
    }
    case 'info': {
      const rec = db.getWorld(rest[0]);
      if (!rec) throw new Error(`no world with id ${rest[0]}`);
      console.log(JSON.stringify({ meta: rec.meta, assets: rec.assets.map(a => ({ id: a.id, name: a.name, bytes: a.bytes, mime: a.mime })), revisions: db.listRevisions(rec.meta.id) }, null, 2));
      break;
    }
    case 'import': {
      const file = rest[0];
      if (!file) throw new Error('usage: import <file.pworld>');
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) throw new Error(`no such file: ${abs}`);
      const out = await app.importPworldBuffer(fs.readFileSync(abs), { name: flag('name', null), sourcePath: abs });
      console.log(`imported “${out.meta.name}” (${out.meta.nodeCount} places, ${out.meta.assetCount} images) as ${out.meta.id}`);
      if (out.warnings.length) console.log(`  warnings: ${out.warnings.join('; ')}`);
      break;
    }
    case 'export': {
      const id = rest[0];
      if (!id) throw new Error('usage: export <worldId>');
      const rec = db.getWorld(id);
      if (!rec) throw new Error(`no world with id ${id}`);
      const modes = flag('modes', null);
      const { bytes, manifest } = await app.buildPworld(id, { modes: modes ? String(modes).split(',') : null });
      const dir = path.resolve(String(flag('out', db.exportsDir)));
      fs.mkdirSync(dir, { recursive: true });
      const name = (await import('../js/io/pworld.js')).pworldFilename(manifest.world.name);
      const out = path.join(dir, name);
      fs.writeFileSync(out, bytes);
      console.log(`exported “${manifest.world.name}” → ${out}`);
      console.log(`  ${manifest.stats.images} image(s) embedded · ${manifest.stats.nodes} places · ${mb(bytes.length)}${manifest.missing.length ? ` · ${manifest.missing.length} image(s) missing` : ''}`);
      break;
    }
    case 'delete': {
      const id = rest[0];
      if (!id) throw new Error('usage: delete <worldId>');
      const rec = db.getWorld(id);
      if (!rec) throw new Error(`no world with id ${id}`);
      db.deleteWorld(id);
      console.log(`deleted “${rec.meta.name}” (${id})`);
      break;
    }
    case 'gc': {
      const used = new Set();
      for (const w of db.listWorlds({})) for (const a of db.listAssets(w.id)) used.add(a.path);
      let freed = 0, removed = 0;
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) { walk(abs); continue; }
          const rel = path.relative(db.dir, abs);
          if (rel.startsWith('covers') || used.has(rel)) continue;
          freed += fs.statSync(abs).size; removed++;
          fs.unlinkSync(abs);
        }
      };
      walk(db.assetsDir);
      console.log(`removed ${removed} unreferenced image file(s), freed ${mb(freed)}`);
      break;
    }
    default:
      console.log(`Panorama Maps — worlds database CLI

  node desktop/cli.mjs list [--data-dir DIR]
  node desktop/cli.mjs info <worldId> [--data-dir DIR]
  node desktop/cli.mjs import <file.pworld> [--name "Renamed"] [--data-dir DIR]
  node desktop/cli.mjs export <worldId> [--out DIR] [--modes day,night] [--data-dir DIR]
  node desktop/cli.mjs delete <worldId> [--data-dir DIR]
  node desktop/cli.mjs gc [--data-dir DIR]
  node desktop/cli.mjs stats [--data-dir DIR]

  database: ${dataDir}`);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await app.close();
}
