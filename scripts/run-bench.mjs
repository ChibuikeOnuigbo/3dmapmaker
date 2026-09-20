#!/usr/bin/env node
/**
 * scripts/run-bench.mjs — headless benchmark of the compute-heavy paths.
 *
 * This measures the real shipped modules through vitest, not a re-implementation.
 * Everything timed here is pure CPU work that runs identically in a worker and on
 * the main thread, so the numbers are meaningful without a browser.
 *
 * Deliberately NOT timed: rendering, panorama decode, or anything needing WebGL.
 * Those need a real browser, which this sandbox does not have — see
 * DEVELOPMENT_LOG.md §3. Reporting a frame time from jsdom would be fabrication.
 *
 * Usage:
 *   node scripts/run-bench.mjs              run everything, print a table
 *   node scripts/run-bench.mjs --json       machine-readable results only
 *   node scripts/run-bench.mjs --reps 25    more repetitions per measurement
 */
import { resolve } from 'node:path';
import { runGenerated, repoRoot } from './lib/vitest-run.mjs';

const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const repsArg = args.indexOf('--reps');
const reps = repsArg >= 0 ? Math.max(1, Number.parseInt(args[repsArg + 1] ?? '15', 10) || 15) : 15;

const relPath = 'apps/web/src/qa/.headless-bench.test.ts';

const generated = `import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { WORLD_SPECS, generateWorld } from '../worlds/generate';
import { runFrontier, buildContextPacket, landmarksOf } from '../worlds/frontier';
import { buildMapModel, EMPTY_MAP_STATE } from '../worlds/mapModel';
import { generateHeightfield, buildTerrainMesh, terrainMeshBytes, extractContours } from '@3dmm/terrain';
import { terrainRoots, selectTerrainTiles } from '@3dmm/performance';
import { chebyshev, idForIndex, indexForId, indexFor, coordFor } from '@3dmm/panorama';

const REPS = ${reps};

interface Measurement {
  id: string;
  label: string;
  medianMs: number;
  minMs: number;
  maxMs: number;
  reps: number;
  /** Human-readable work done per repetition, so a number is not naked. */
  workload: string;
}

const measurements: Measurement[] = [];

function measure(id: string, label: string, workload: string, fn: () => void): void {
  const times: number[] = [];
  fn(); // warm-up: JIT and cache behaviour differ wildly on the first call
  for (let i = 0; i < REPS; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[times.length >> 1];
  measurements.push({
    id,
    label,
    medianMs: Math.round(median * 1000) / 1000,
    minMs: Math.round(times[0] * 1000) / 1000,
    maxMs: Math.round(times[times.length - 1] * 1000) / 1000,
    reps: REPS,
    workload,
  });
}

describe('benchmark (headless)', () => {
  it('times the real compute paths', () => {
    /* ------------------------------------------------- world generation --- */
    const worlds: Record<string, ReturnType<typeof generateWorld>> = {};
    for (const key of ['small', 'medium', 'large'] as const) {
      const spec = WORLD_SPECS[key];
      let last!: ReturnType<typeof generateWorld>;
      measure(
        \`world-gen/\${key}\`,
        \`generateWorld \${spec.width}\u00d7\${spec.height}\`,
        \`\${spec.width * spec.height} cells\`,
        () => {
          last = generateWorld(spec);
        },
      );
      worlds[key] = last;
    }

    /* -------------------------------------------------- graph + routing --- */
    const large = worlds.large;
    const nodes = large.graph.all();
    const firstId = nodes[0].id;
    const lastId = nodes[nodes.length - 1].id;
    measure(
      'graph/astar-large',
      'A* corner-to-corner on 32\u00d732',
      \`\${large.graph.size} nodes, \${large.graph.allEdges().length} edges\`,
      () => {
        large.graph.findPath(firstId, lastId);
      },
    );

    let expanded = 0;
    let routeLength = 0;
    const route = large.graph.findPath(firstId, lastId);
    expanded = route.expanded;
    routeLength = route.nodes.length;

    measure(
      'graph/astar-all-32x32',
      'A* from every node to the corner',
      \`\${large.graph.size} queries\`,
      () => {
        for (const n of nodes) large.graph.findPath(n.id, lastId);
      },
    );

    measure(
      'graph/nearby-large',
      'spatial-hash nearby() queries',
      \`\${large.graph.size} queries @ radius 3\`,
      () => {
        for (const n of nodes) large.graph.nearby(n.gridX, n.gridY, 3);
      },
    );

    measure(
      'graph/id-math',
      'indexFor / coordFor / chebyshev',
      '100k round trips',
      () => {
        for (let i = 0; i < 100_000; i++) {
          // index = y*width + x, id = index + 1 — the mapping the whole world
          // rests on, so it is worth timing as well as testing.
          const idx = indexFor(i % 32, i % 32, 32);
          const c = coordFor(idx, 32);
          idForIndex(indexForId(i + 1));
          chebyshev(c, { x: 7, y: 11 });
        }
      },
    );

    /* ------------------------------------------------- frontier walking --- */
    measure(
      'frontier/large',
      'runFrontier over the whole 32\u00d732 board',
      \`\${large.graph.size} nodes validated\`,
      () => {
        runFrontier({ graph: large.graph, kinds: large.kinds, startId: large.startId });
      },
    );

    const frontierStats = runFrontier({
      graph: large.graph,
      kinds: large.kinds,
      startId: large.startId,
    });

    const landmarks = landmarksOf(large.graph);
    measure(
      'frontier/context-packet',
      'buildContextPacket for every node',
      \`\${large.graph.size} packets, \${landmarks.length} landmarks\`,
      () => {
        for (const n of nodes) {
          buildContextPacket(large.graph, n, large.kinds, (k) => k);
        }
      },
    );

    /* ------------------------------------------------------ 2D map model --- */
    measure(
      'map/build-large',
      'buildMapModel for 32\u00d732',
      \`\${large.graph.size} nodes + \${route.nodes.length}-node route\`,
      () => {
        buildMapModel({
          graph: large.graph,
          kinds: large.kinds,
          cell: 18,
          pad: 24,
          state: {
            ...EMPTY_MAP_STATE,
            currentId: firstId,
            destinationId: lastId,
            route: route.nodes.map((n) => n.id),
            visited: new Set(nodes.slice(0, 40).map((n) => n.id)),
          },
          viewport: null,
        });
      },
    );

    measure(
      'map/build-viewport',
      'buildMapModel with a zoomed viewport',
      'culled to a 600\u00d7400 window',
      () => {
        buildMapModel({
          graph: large.graph,
          kinds: large.kinds,
          cell: 18,
          pad: 24,
          state: { ...EMPTY_MAP_STATE, currentId: firstId },
          viewport: { x: 0, y: 0, w: 600, h: 400, margin: 60 },
        });
      },
    );

    /* ----------------------------------------------------------- terrain --- */
    const resolutions = [129, 257, 513];
    for (const resolution of resolutions) {
      const req = {
        resolution,
        size: 1024,
        originX: -512,
        originY: -512,
        source: {
          kind: 'procedural' as const,
          seed: 1337,
          octaves: 6,
          lacunarity: 2,
          gain: 0.5,
          amplitude: 240,
          frequency: 1.4,
          warp: 0.25,
          ridged: false,
        },
      };
      let hf!: ReturnType<typeof generateHeightfield>;
      measure(
        \`terrain/generate-\${resolution}\`,
        \`generateHeightfield \${resolution}\u00b2\`,
        \`\${resolution * resolution} samples, 6 octaves\`,
        () => {
          hf = generateHeightfield(req);
        },
      );

      let meshBytes = 0;
      measure(
        \`terrain/mesh-\${resolution}\`,
        \`buildTerrainMesh \${resolution}\u00b2\`,
        \`\${((resolution - 1) * (resolution - 1) * 2).toLocaleString('en-US')} triangles\`,
        () => {
          meshBytes = terrainMeshBytes(buildTerrainMesh(hf, { skirtMeters: 8 }));
        },
      );
      // Report what the last repetition actually produced, so each row carries
      // its own evidence rather than just a duration.
      measurements[measurements.length - 1].workload +=
        \`; \${(meshBytes / 1024).toFixed(0)} KiB of buffers\`;

      let contourSegments = 0;
      let contourLevels = 0;
      measure(
        \`terrain/contours-\${resolution}\`,
        \`extractContours \${resolution}\u00b2\`,
        '10 m interval',
        () => {
          const c = extractContours(hf, 10, 2, 6000);
          contourSegments = c.segments.length;
          contourLevels = c.levels.length;
        },
      );
      measurements[measurements.length - 1].workload =
        \`10 m interval \u2192 \${contourSegments} segments across \${contourLevels} levels\`;
    }

    /* --------------------------------------------------------------- LOD --- */
    // terrainRoots() yields TerrainLodTile (center/size); selectLod() takes a
    // LodNode (position/radius). selectTerrainTiles() is the real entry point
    // and does that conversion internally, so benchmark it rather than
    // hand-bridging the two types.
    const roots = terrainRoots(4096, 256);
    const camera = { position: { x: 0, y: 300, z: 0 }, fovDeg: 60, viewportHeightPx: 1080, near: 0.1 };
    let tileDrawn = 0;
    let tileLoad = 0;
    measure(
      'lod/select-terrain',
      'selectTerrainTiles over a 4096 m quadtree',
      \`\${roots.length} roots, SSE<=8\`,
      () => {
        const r = selectTerrainTiles(roots, camera, () => true, { maxScreenSpaceError: 8 }, 512);
        tileDrawn = r.toDraw.length;
        tileLoad = r.toLoad.length;
      },
    );
    const lodRow = measurements[measurements.length - 1];
    lodRow.workload = \`\${tileDrawn} drawn, \${tileLoad} to load (all ready)\`;

    // Same walk, nothing loaded yet — the storm case, where parents must stay
    // on screen instead of leaving holes.
    measure(
      'lod/select-cold',
      'selectTerrainTiles with nothing cached',
      'isReady() always false',
      () => {
        selectTerrainTiles(roots, camera, () => false, { maxScreenSpaceError: 8 }, 512);
      },
    );

    const memory =
      typeof process !== 'undefined' && (process as { memoryUsage?: () => { heapUsed: number } }).memoryUsage
        ? (process as { memoryUsage: () => { heapUsed: number } }).memoryUsage().heapUsed
        : 0;

    const summary = {
      reps: REPS,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      heapUsedMiB: Math.round((memory / 1024 / 1024) * 10) / 10,
      largeWorld: {
        board: \`\${WORLD_SPECS.large.width}\u00d7\${WORLD_SPECS.large.height}\`,
        nodes: large.graph.size,
        edges: large.graph.allEdges().length,
        routeNodes: routeLength,
        routeExpanded: expanded,
        frontierAccepted: frontierStats.accepted,
        frontierRejected: frontierStats.rejected,
        frontierMs: Math.round(frontierStats.elapsedMs * 1000) / 1000,
        landmarks: landmarks.length,
      },
      measurements,
    };
    // Written to a file, not just logged: vitest's reporter owns stdout, so a
    // parent-side interception of the marker line is unreliable.
    writeFileSync(process.env.BENCH_OUT!, JSON.stringify(summary), 'utf8');
    console.log('BENCH_RESULT ' + JSON.stringify(summary));
  }, 300_000);
});
`;

if (!jsonOnly) {
  console.log(`3DMapMaker Next — headless benchmark\n${reps} reps per measurement (median reported)\n`);
}

const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const outDir = mkdtempSync(join(tmpdir(), 'bench-'));
const outFile = join(outDir, 'result.json');
process.env.BENCH_OUT = outFile;

const code = await runGenerated(relPath, generated, { quiet: jsonOnly });

let raw = null;
try {
  raw = readFileSync(outFile, 'utf8');
} catch {
  raw = null;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (!raw) {
  console.error('\nNo BENCH_RESULT was produced — the benchmark did not run.');
  process.exit(code === 0 ? 2 : code);
}

const result = JSON.parse(raw);

if (jsonOnly) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(code);
}

const pad = (value, n) => String(value).padEnd(n);
const lpad = (value, n) => String(value).padStart(n);
console.log(
  `${pad('id', 26)}${lpad('median', 10)}${lpad('min', 9)}${lpad('max', 9)}   workload`,
);
console.log('-'.repeat(104));
for (const m of result.measurements) {
  console.log(
    `${pad(m.id, 26)}${lpad(m.medianMs.toFixed(3) + ' ms', 10)}${lpad(m.minMs.toFixed(3), 9)}${lpad(m.maxMs.toFixed(3), 9)}   ${m.workload}`,
  );
}
console.log('-'.repeat(104));
console.log(`\nlargest world under test: ${JSON.stringify(result.largeWorld)}`);
console.log(`environment: node ${result.node} · ${result.platform}/${result.arch} · heap ${result.heapUsedMiB} MiB`);
console.log(`repetitions: ${result.reps} (median of sorted samples; first call discarded as warm-up)`);
console.log('\nNot measured here: rendering, panorama decode, GPU upload, frame pacing.');
console.log('Those require a real browser; see DEVELOPMENT_LOG.md §3 for why that is absent.');
process.exit(code);
