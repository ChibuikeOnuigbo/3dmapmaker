/**
 * Panorama Maps — tools-render/render-panoramas.mjs
 *
 * Renders REAL app panoramas in Node (via the software canvas) for:
 *   1. visual inspection of the procedural provider,
 *   2. feeding the OpenCV continuity pipeline end-to-end.
 *
 *   node tools-render/render-panoramas.mjs [outdir] [chainLength]
 */
import fs from 'node:fs';
import path from 'node:path';
import { FakeCanvas, bmpEncode } from './canvas2d.mjs';

// ---- browser shims for the provider (document.createElement('canvas')) ----
globalThis.document = {
  createElement(tag) { if (tag !== 'canvas') throw new Error('shim only supports canvas'); return new FakeCanvas(); },
};

const { buildChapelLane, buildMillbrook, buildGreatVale } = await import('../js/worlds/demo-worlds.js');
const { ProceduralWorldProvider } = await import('../js/gen/provider.js');

const outdir = process.argv[2] || '/tmp/panorender';
fs.mkdirSync(outdir, { recursive: true });

const provider = new ProceduralWorldProvider({ width: 1280, height: 640, cullRadiusM: 460 });

async function renderChain() {
  const { graph } = buildChapelLane();
  const world = { id: graph.id, environment: graph.environment };
  const files = [];
  // the street approach toward the church: every 10 m from 120 m down to 20 m
  const ids = [];
  for (let m = 120; m >= 20; m -= 10) ids.push(`way_${String(m).padStart(3, '0')}m`);
  for (const id of ids) {
    const node = graph.getNode(id);
    const t0 = Date.now();
    const { canvas, meta } = await provider.generate(node, { promptVersion: 1, movement: { distanceMeters: 10 }, zones: [] }, {
      world, scale: graph.scale, groundResolution: 0.75,
    });
    const file = path.join(outdir, `${id}.bmp`);
    fs.writeFileSync(file, bmpEncode(canvas));
    files.push(file);
    console.log(`  rendered ${id} phash=${meta.phash.slice(0, 12)}… in ${Date.now() - t0} ms`);
  }
  // one plaza node with a deliberately incomplete panorama (AutoComplete target)
  const plaza = graph.getNode('plaza_2_5');
  {
    const { canvas } = await provider.generate(plaza, { promptVersion: 1, zones: [] }, { world, scale: graph.scale, groundResolution: 0.75 });
    const file = path.join(outdir, 'plaza_2_5.bmp');
    fs.writeFileSync(file, bmpEncode(canvas));
    files.push(file);
    console.log('  rendered plaza_2_5 (intentionally incomplete top band)');
  }
  return files;
}

console.log(`rendering to ${outdir}`);
await renderChain();
console.log('done');
