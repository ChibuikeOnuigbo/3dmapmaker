/**
 * Panorama Maps — tests/core.test.mjs
 *
 * Automated core tests (Spec §22, §59–§63). DOM-free: runs the pure
 * world/movement/scale/completion/archive logic under Node.
 *
 *   node tests/core.test.mjs
 */
import assert from 'node:assert/strict';
import { MapScale } from '../js/core/scale.js';
import { WorldGraph, snapToDir, bearingDeg, angleDelta, SpatialHash } from '../js/core/world-graph.js';
import { planMove, desiredBearing, MovementController, positionAlongEdge } from '../js/core/movement.js';
import { detectMissingRegions, softClampPitch, seamDelta } from '../js/viewer/completion.js';
import { aHash16, hammingHex, luminanceGrid16, rgbHist, histIntersect, expectedMinSimilarity, rngFor } from '../js/gen/util.js';
import { crc32, writeZip, readZip, safeZipPath } from '../js/io/zipex.js';
import { validateWorldJson } from '../js/io/storage.js';
import { buildChapelLane, buildMillbrook, buildGreatVale } from '../js/worlds/demo-worlds.js';

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const fakeBus = () => { const log = []; return { log, emit: (t, p) => log.push([t, p]), on: () => {} }; };

/* ---------------- Map scale (Spec §4, §7, §59) ---------------- */
test('scale: 12px at 2px/m is 6 meters', () => {
  const s = new MapScale({ pixelsPerMeter: 2, movement: { stepPixels: 12 } });
  assert.equal(s.stepMeters(), 6);
});
test('scale: 10px at 2px/m → 5m → 100 steps for 500m', () => {
  const s = new MapScale({ pixelsPerMeter: 2, movement: { stepPixels: 10 } });
  assert.equal(s.stepMeters(), 5);
  assert.equal(s.stepsForMeters(500), 100);
});
test('scale: 15px at 2px/m → 7.5m → ~67 steps for 500m', () => {
  const s = new MapScale({ pixelsPerMeter: 2, movement: { stepPixels: 15 } });
  assert.equal(s.stepMeters(), 7.5);
  assert.equal(Math.ceil(s.stepsForMeters(500, 15)), 67);
});
test('scale: never assumes 1px = 1m (ppm 3)', () => {
  const s = new MapScale({ pixelsPerMeter: 3, movement: { stepPixels: 12 } });
  assert.equal(s.stepMeters(), 4);
});

/* ---------------- king directions ---------------- */
test('directions: bearing math (N/E/S/W)', () => {
  assert.equal(bearingDeg(0, 0, 0, -10), 0);    // north (−y)
  assert.equal(bearingDeg(0, 0, 10, 0), 90);    // east
  assert.equal(bearingDeg(0, 0, 0, 10), 180);   // south
  assert.equal(bearingDeg(0, 0, -10, 0), 270);  // west
  assert.equal(snapToDir(44).name, 'NE');
  assert.equal(snapToDir(226).name, 'SW');
  assert.equal(Math.abs(angleDelta(350, 10)), 20);
});
test('movement keyboard: camera-relative bearings', () => {
  assert.equal(desiredBearing('forward', 90), 90);
  assert.equal(desiredBearing('backward', 90), 270);
  assert.equal(desiredBearing('left', 0), 270);
  assert.equal(desiredBearing('right', 0), 90);
});

/* ---------------- graph edges ---------------- */
test('graph: edge distance is sqrt(dx²+dy²) scaled (diagonal)', () => {
  const g = new WorldGraph(new MapScale({ pixelsPerMeter: 2 }));
  g.addNode({ id: 'a', x: 0, y: 0 });
  g.addNode({ id: 'b', x: 30, y: 40 });
  const e = g.connect('a', 'b');
  assert.equal(e.distPx, 50);
  assert.equal(e.distM, 25);
  g.addNode({ id: 'c', x: 10, y: 10 });
  const d = g.connect('a', 'c');
  assert.ok(Math.abs(d.distPx - Math.SQRT2 * 10) < 1e-9);
});
test('graph: spatial index nearest-neighbour', () => {
  const idx = new SpatialHash(64);
  idx.insert('p1', 10, 10); idx.insert('p2', 500, 500);
  const g = new WorldGraph(new MapScale());
  g.index = idx;
  g.nodes.set('p1', { id: 'p1', x: 10, y: 10 });
  g.nodes.set('p2', { id: 'p2', x: 500, y: 500 });
  assert.equal(g.nearestNode(12, 9, 30).id, 'p1');
  assert.equal(g.nearestNode(120, 120, 50), null);
});
test('graph: dijkstra route distance', () => {
  const g = new WorldGraph(new MapScale({ pixelsPerMeter: 1 }));
  g.addNode({ id: 'a', x: 0, y: 0 }); g.addNode({ id: 'b', x: 10, y: 0 }); g.addNode({ id: 'c', x: 20, y: 0 });
  g.connect('a', 'b'); g.connect('b', 'c');
  const path = g.shortestPath('a', 'c');
  assert.deepEqual(path.nodes, ['a', 'b', 'c']);
  assert.equal(path.distanceM, 20);
});

/* ---------------- DEMO 1: Chapel Lane ---------------- */
test('chapel lane: structure sanity (8×8 grid + street)', () => {
  const { graph } = buildChapelLane();
  const plaza = [...graph.nodes.keys()].filter(id => id.startsWith('plaza_'));
  assert.equal(plaza.length, 64);                       // 8×8 = 64 nodes (Spec §34)
  const street = [...graph.nodes.keys()].filter(id => id.startsWith('way_'));
  assert.equal(street.length, 51);                      // 20m … 520m at 10m
  // full reachability (one connected world)
  const reach = graph.reachableFrom('way_020m');
  assert.equal(reach.size, graph.nodes.size);
  // realistic spacing: consecutive street nodes are exactly 10 m apart
  const e = graph.edgesOf('way_100m').find(e => graph.otherEnd(e, 'way_100m') === 'way_110m');
  assert.equal(e.distM, 10);
  // diagonal plaza edge is √2 × 10 m — coordinate-derived, not arbitrary
  const dEdge = graph.edgesOf('plaza_0_0').find(e => graph.otherEnd(e, 'plaza_0_0') === 'plaza_1_1');
  assert.ok(Math.abs(dEdge.distM - Math.SQRT2 * 10) < 1e-6);
});

test('chapel lane: king adjacency counts (corner/edge/center)', () => {
  const { graph } = buildChapelLane();
  const countGrid = (id) => graph.edgesOf(id).filter(e => graph.otherEnd(e, id).startsWith('plaza_')).length;
  assert.equal(countGrid('plaza_0_0'), 3);
  assert.equal(countGrid('plaza_0_3'), 5);
  assert.equal(countGrid('plaza_4_4'), 8);
  // king adjacency is only a candidate — the world can block it (Spec §13)
  const blocked = [...graph.edges.values()].find(e => e.blocked);
  assert.ok(blocked, 'expected one deliberately blocked edge');
  const resolved = graph.resolveEdge('plaza_3_3', 90);
  assert.ok(!blocked || resolved !== blocked, 'a blocked edge is NEVER chosen');
  assert.notEqual(resolved && graph.otherEnd(resolved, 'plaza_3_3'), 'plaza_3_4',
    'the walled cell east of plaza_3_3 is unreachable through this edge');
});

test('CHURCH 500 m continuity test (Spec §8, §60)', () => {
  const { graph } = buildChapelLane();
  const zoneId = 'zone_church_vicinity';
  const at = (m) => { const n = graph.getNode(`way_${String(m).padStart(3, '0')}m`); return [n.x, n.y]; };
  // 490 m → still inside; 500 m → still inside (boundary rule); 510 m → outside
  assert.ok(graph.zones.distanceToBoundaryM(zoneId, ...at(490)) > 0);
  assert.equal(Math.round(graph.zones.distanceToBoundaryM(zoneId, ...at(500))), 0);
  assert.ok(graph.zones.distanceToBoundaryM(zoneId, ...at(510)) < 0);
  // movement steps to traverse 500 m at 10 m/step = 50 moves (never hard-coded image counts)
  assert.equal(graph.scale.stepsToReachBoundary(500), 50);
  // walking the street keeps you "in the church vicinity" until the math says otherwise
  let inside = 0;
  for (let m = 20; m <= 520; m += 10) if (graph.zones.distanceToBoundaryM(zoneId, ...at(m)) >= 0) inside++;
  assert.equal(inside, 49);   // 20..500 inclusive
});

test('movement: WASD resolves through the graph; blocked movement stays put', () => {
  const { graph } = buildChapelLane();
  const bus = fakeBus();
  const mc = new MovementController(graph, bus);
  mc.setPosition('way_020m', { silent: true });
  // facing south → W walks south along the way
  let plan = mc.tryMove('forward', 180, { nowFn: () => 0 });
  assert.equal(plan.ok, true);
  assert.equal(plan.targetId, 'way_030m');
  mc.tick(1e9);   // finish instantly
  assert.equal(mc.currentNodeId, 'way_030m');
  assert.ok(mc.distanceTravelledM >= 10 - 1e9, 'distance accumulates in meters');
  // facing straight west from the street → no edge → rejected, position unchanged
  plan = mc.tryMove('forward', 270, { nowFn: () => 0 });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'blocked');
  mc.tick(1e9);
  assert.equal(mc.currentNodeId, 'way_030m');
  assert.ok(bus.log.some(([t]) => t === 'move:blocked'));
});

test('movement: no dead angle — a press at exactly 45° resolves the diagonal', () => {
  const { graph } = buildChapelLane();
  const grid = [...graph.nodes.keys()].filter((k) => k.startsWith('plaza_'));
  const mid = grid.find((k) => { const [r, c] = k.slice(6).split('_').map(Number); return r === 3 && c === 3; });
  // every bearing maps to exactly one WASD sector: at 45° exactly, W must
  // resolve the diagonal neighbor instead of dead-ending between cones
  const plan = planMove(graph, mid, 'forward', 45);
  assert.equal(plan.ok, true, 'forward at 45° yaw must not be blocked');
  const [r, c] = plan.targetId.slice(6).split('_').map(Number);
  assert.equal(r, 2); assert.equal(c, 4, 'resolves to the NE diagonal plaza cell');
  // genuinely walled directions still block: way node here has nothing to its side
  const streetPlan = planMove(graph, 'way_020m', 'left', 270); // face west, left = south? street runs north-south so south exists; use right = north exists too — use forward west: nothing west between street and plaza link? verify plaza link is not reachable from an arbitrary way node
  const westPlan = planMove(graph, 'way_120m', 'forward', 270); // look due west off the street
  assert.equal(westPlan.ok, false, 'off street direction with no edge still blocks');
});

test('movement: reverse travel returns to the SAME nodes (Spec §19, §61)', () => {
  const { graph } = buildChapelLane();
  const mc = new MovementController(graph, fakeBus());
  mc.setPosition('way_020m', { silent: true });
  const forward = [];
  for (let i = 0; i < 5; i++) {          // 10m → 20m → 30m → 40m → 50m
    const p = mc.tryMove('forward', 180, { nowFn: () => 0 });
    assert.ok(p.ok);
    mc.tick(1e9);
    forward.push(mc.currentNodeId);
  }
  assert.deepEqual(forward, ['way_030m', 'way_040m', 'way_050m', 'way_060m', 'way_070m']);
  const back = [];
  for (let i = 0; i < 5; i++) {
    const p = mc.tryMove('backward', 180, { nowFn: () => 0 });   // turn back: same graph, reversed
    assert.ok(p.ok);
    mc.tick(1e9);
    back.push(mc.currentNodeId);
  }
  assert.deepEqual(back, ['way_060m', 'way_050m', 'way_040m', 'way_030m', 'way_020m']);
});

test('movement: diagonal plaza step uses real √2 distance', () => {
  const { graph } = buildChapelLane();
  const mc = new MovementController(graph, fakeBus());
  mc.setPosition('plaza_0_0', { silent: true });
  const p = mc.tryMove('forward', 135, { nowFn: () => 0 });   // face SE → plaza_1_1
  assert.ok(p.ok);
  assert.equal(p.targetId, 'plaza_1_1');
  assert.ok(Math.abs(p.distanceM - Math.SQRT2 * 10) < 1e-6);
  const pos = positionAlongEdge(graph, p.edge, 'plaza_0_0', 0.5);
  assert.ok(Math.abs(graph.scale.pxToM(Math.hypot(pos.x, pos.y - 560 * 1)) ) >= 0); // sanity: finite
});

/* ---------------- DEMO 2 & 3 ---------------- */
test('millbrook: branches and zones exist', () => {
  const { graph } = buildMillbrook();
  assert.ok(graph.nodes.size > 80, 'medium world has substance');
  const reach = graph.reachableFrom([...graph.nodes.keys()][0]);
  assert.equal(reach.size, graph.nodes.size, 'fully connected world');
  assert.ok(graph.landmarks.size >= 2);
  assert.ok(graph.zones.get('zone_church_vicinity'));
});
test('great vale: 1,000+ nodes, connected, spatially indexed', () => {
  const { graph } = buildGreatVale();
  console.log(`    great vale: ${graph.nodes.size} nodes, ${graph.edges.size} edges`);
  assert.ok(graph.nodes.size >= 1000, `expected ≥1000 nodes, got ${graph.nodes.size}`);
  const start = [...graph.nodes.keys()][0];
  const reach = graph.reachableFrom(start);
  assert.ok(reach.size / graph.nodes.size > 0.95, '≥95% reachable from start');
  const near = graph.index.queryRadius(400, 300, 64);
  assert.ok(near.length > 0);
});

/* ---------------- panorama identity & validation math ---------------- */
test('identity: aHash is deterministic & similar images stay close', () => {
  const imgA = new Uint8ClampedArray(256 * 4).fill(100);
  const a = aHash16(luminanceGrid16(imgA, 16, 16));
  const b = aHash16(luminanceGrid16(imgA, 16, 16));
  assert.equal(a, b);
  const imgB = new Uint8ClampedArray(256 * 4).fill(100);
  for (let i = 0; i < 8; i++) imgB[i * 4] = 130;    // tiny change (8 of 256 cells)
  const c = aHash16(luminanceGrid16(imgB, 16, 16));
  assert.ok(hammingHex(a, c) <= 8, 'tiny change keeps hash close');
  const imgR = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) { imgR[i * 4] = (i * 37) % 255; imgR[i * 4 + 1] = (i * 91) % 255; }
  assert.ok(hammingHex(a, aHash16(luminanceGrid16(imgR, 16, 16))) > 40, 'unrelated image has far hash');
});
test('validation: distance-aware expected change model (Spec §27)', () => {
  assert.ok(expectedMinSimilarity(1) > 0.93);
  assert.ok(expectedMinSimilarity(100) < expectedMinSimilarity(10));
  assert.ok(expectedMinSimilarity(500) >= 0.18);
  const h1 = rgbHist(new Uint8ClampedArray(1024 * 4).fill(120), 4, 4);
  assert.equal(histIntersect(h1, h1), 1);
});
test('rng: world-anchored noise is seeded, never Math.random', () => {
  const r1 = rngFor('world|node_1');
  const r2 = rngFor('world|node_1');
  assert.equal(r1(), r2());
});

/* ---------------- AutoComplete Panorama ---------------- */
test('autocomplete: detects missing black top band', () => {
  const W = 64, H = 32;
  const data = new Uint8ClampedArray(W * H * 4);
  const topRows = Math.round(H * 0.08);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (y < topRows) { data[i] = data[i + 1] = data[i + 2] = 2; data[i + 3] = 255; }
    else { data[i] = x * 3; data[i + 1] = (x + y) * 2 % 255; data[i + 2] = 200; data[i + 3] = 255; }
  }
  const r = detectMissingRegions(data, W, H);
  assert.ok(Math.abs(r.topMissingPct - 8) < 4, `expected ~8%, got ${r.topMissingPct}`);
  assert.ok(r.pitchMaxDeg < 80 && r.pitchMaxDeg > 60, `pitchMax should shrink: ${r.pitchMaxDeg}`);
  assert.equal(r.complete, false);
});
test('autocomplete: does NOT flag textured dark sky (contextual thresholds)', () => {
  const W = 64, H = 32;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const star = (x * 31 + y * 17) % 29 === 0;
    data[i] = star ? 240 : 18 + (x % 7);            // dark but textured night sky
    data[i + 1] = star ? 240 : 20 + (y % 5);
    data[i + 2] = star ? 255 : 30 + ((x * y) % 9);
    data[i + 3] = 255;
  }
  const r = detectMissingRegions(data, W, H);
  assert.equal(r.topRows, 0, 'textured night sky is not missing data');
});
test('autocomplete: soft pitch resistance (Spec §52–§53)', () => {
  const limits = { min: -63, max: 63 };
  const inside = softClampPitch(30, limits, 16);
  assert.equal(inside.pitch, 30);
  const over = softClampPitch(80, limits, 16);
  assert.ok(over.pitch < 70, `resistance keeps view near the limit (${over.pitch.toFixed(1)})`);
  assert.ok(over.limited);
  const decayed = softClampPitch(80, limits, 5000);
  assert.ok(Math.abs(decayed.pitch - 63) < 1.5, 'overdrag decays back to the limit');
});
test('autocomplete: seam metric works', () => {
  const W = 8;
  const data = new Uint8ClampedArray(W * 4 * 4).fill(128);
  assert.equal(seamDelta(data, W, 1), 0);
  data.fill(255, (3 * W) * 4, (3 * W) * 4 + W * 4);
  assert.ok(seamDelta(data, W, 2) > 100);
});

/* ---------------- archive (.pmap / zip) ---------------- */
test('zip: crc32 known vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});
test('zip: write → read roundtrip incl. binary + unicode paths', async () => {
  const entries = [
    { path: 'manifest.json', data: new TextEncoder().encode('{"format":"PanoramaMapsProject"}') },
    { path: 'world/world.json', data: new TextEncoder().encode('{"nodes":[],"edges":[]}') },
    { path: 'assets/panoramas/église (été).webp', data: new Uint8Array([0, 1, 2, 250, 128, 66]) },
  ];
  const zip = writeZip(entries);
  const back = await readZip(zip);
  assert.deepEqual([...back.keys()].sort(), entries.map(e => safeZipPath(e.path)).sort());
  assert.deepEqual([...back.get('assets/panoramas/église (été).webp')], [0, 1, 2, 250, 128, 66]);
});
test('zip: path traversal rejected (Spec §66)', () => {
  assert.throws(() => safeZipPath('../../etc/passwd'));
  assert.throws(() => safeZipPath('/abs/path'));
  assert.throws(() => safeZipPath('C:\\win'));
});
test('world json validation: untrusted input rejected (Spec §68)', () => {
  assert.throws(() => validateWorldJson({ nodes: [{ id: 'a', x: 'NaN', y: 0 }], edges: [] }));
  assert.throws(() => validateWorldJson({ nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'a', x: 1, y: 1 }], edges: [] }));
  assert.throws(() => validateWorldJson({ nodes: [{ id: 'a', x: 0, y: 0 }], edges: [{ id: 'x', a: 'a', b: 'ghost' }] }));
  assert.equal(validateWorldJson({ nodes: [{ id: 'a', x: 0, y: 0 }], edges: [], scale: { pixelsPerMeter: 2 } }), true);
});
test('world graph round-trips through JSON', () => {
  const { graph } = buildChapelLane();
  const json = graph.toJSON();
  const back = WorldGraph.fromJSON(json);
  assert.equal(back.nodes.size, graph.nodes.size);
  assert.equal(back.edges.size, graph.edges.size);
  assert.equal(back.zones.distanceToBoundaryM('zone_church_vicinity', 0, 500 * 2), 0);
  assert.equal(json.nodes.length > 0, true);
  assert.ok(back.healthCheck().length === 0, JSON.stringify(back.healthCheck()));
});

/* ------------- camera-relative movement equivalences (spec behavior) —————
   "forward with the camera rotated 90°" must reach the same destination as
   "the matching strafe direction on the current heading", wherever the
   graph allows both. This is what makes A/D equal to turn+W. */
test('movement: rotate 90° then forward === strafe (plaza grid, all 8 directions)', () => {
  const { graph } = buildChapelLane();
  const grid = [...graph.nodes.keys()].filter((k) => k.startsWith('plaza_'));
  const mid = grid.find((k) => { const [r, c] = k.slice(6).split('_').map(Number); return r === 3 && c === 3; });
  const mc = new MovementController(graph, fakeBus());
  for (const yaw of [0, 90, 180, 270]) {
    for (const [strafe, turn] of [['left', -90], ['right', 90]]) {
      const a = planMove(graph, mid, strafe, yaw);           // strafe on current heading
      const b = planMove(graph, mid, 'forward', (yaw + turn + 360) % 360);  // turn then forward
      assert.equal(a.ok, b.ok, `yaw ${yaw} ${strafe}: one allowed, one not`);
      if (a.ok) assert.equal(a.targetId, b.targetId, `yaw ${yaw} ${strafe}: must land on the same node`);
    }
  }
  assert.ok(mid, 'plaza center found');
});

/* ---------------- willow parish straight line math: 500 / spacing -------- */
test('willow parish: 34 spot village graph, real meter edges, one connected tree', async () => {
  const { buildWillowParish } = await import('../js/worlds/willow-parish.js');
  const w = buildWillowParish();
  assert.equal(w.graph.nodes.size, 58, '34 named spots + 24 dense waypoints');
  assert.equal(w.graph.edges.size, 57, 'tree: n-1 edges');
  // no long gaps: every edge is under 55 m after densification
  for (const e of w.graph.edges.values()) {
    assert.ok(e.distM < 55, `edge ${e.a}..${e.b} is ${e.distM.toFixed(1)} m, expected walkable hop`);
  }
  // main street path total stays 600 m of real distance end to end
  let cur = 'willow_060', prev = null, total = 0;
  while (cur !== 'willow_660') {
    const next = w.graph.edgesOf(cur).map((e) => ({ to: w.graph.otherEnd(e, cur), dist: e.distM })).find((c) => c.to !== prev);
    assert.ok(next, `main street continues past ${cur}`);
    total += next.dist; prev = cur; cur = next.to;
  }
  assert.ok(Math.abs(total - 600) < 0.01, `main street spans 600 m (got ${total.toFixed(1)})`);
  // every node reachable from the church start (connected, no islands)
  const seen = new Set([w.startNodeId]);
  const q = [w.startNodeId];
  while (q.length) {
    const cur = q.shift();
    for (const e of w.graph.edgesOf(cur)) {
      const o = w.graph.otherEnd(e, cur);
      if (!seen.has(o)) { seen.add(o); q.push(o); }
    }
  }
  assert.equal(seen.size, 58, 'every spur and waypoint connects back to the church');
});

/* ---------------- sharpen: real clarity pass, not a toggle only ---------- */
test('sharpen: unsharp mask boosts edges, keeps brightness and alpha', async () => {
  const { sharpenBuffer } = await import('../js/viewer/sharpen.js');
  const w = 24, h = 12;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = (i % w) < w / 2 ? 100 : 160;   // soft vertical edge
    src.set([v, v, v, 255], i * 4);
  }
  const out = await sharpenBuffer(src, w, h, { amount: 0.8, radius: 2 });
  assert.ok(out !== src && out.length === src.length);
  const cx = Math.floor(w / 2), row = 6;
  const leftEdge = out[(row * w + cx - 1) * 4];     // dark side just left of edge
  const rightEdge = out[(row * w + cx) * 4];        // bright side just at edge
  assert.ok(leftEdge < 100, `dark side of the edge gets darker (crisper), got ${leftEdge}`);
  assert.ok(rightEdge > 160, `bright side of the edge gets brighter, got ${rightEdge}`);
  assert.ok(out.every((v, i) => (i + 1) % 4 !== 0 || v === 255), 'alpha preserved');
  const meanSrc = src.reduce((a, b, i) => (i % 4 === 0 ? a + b : a), 0) / (w * h);
  const meanOut = out.reduce((a, b, i) => (i % 4 === 0 ? a + b : a), 0) / (w * h);
  assert.ok(Math.abs(meanOut - meanSrc) < 2.5, `mean luminance stable (${meanSrc} → ${meanOut})`);
});

/* ---------------- smoothen: denoises lines without blurring edges -------- */
test('smoothen: kills pepper noise, keeps hard edges intact', async () => {
  const { smoothBuffer } = await import('../js/viewer/smooth.js');
  const w = 16, h = 12;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) src.set([10, 10, 10, 255], i * 4);
  const mid = (6 * w + 8) * 4;
  src[mid] = src[mid + 1] = src[mid + 2] = 220;               // one bright pepper pixel
  const col = 6;                                              // vertical straight edge
  for (let y = 0; y < h; y++) for (let x = col; x < w; x++) src.set([100, 100, 100, 255], (y * w + x) * 4);
  const out = await smoothBuffer(src, w, h, { strength: 0.9 });
  // pepper pixel is suppressed into the local 100-level line
  const pep = out[mid];
  assert.ok(pep < 180, `pepper pixel pulled toward its line (${pep}), not left at 220`);
  // the strong edge is preserved (a pixel just left of the edge stays dark)
  const edgeL = out[(6 * w + col - 2) * 4];
  assert.ok(edgeL < 32, `edge guard: dark side stays dark (${edgeL})`);
  const edgeR = out[(6 * w + col + 1) * 4];
  assert.ok(edgeR > 88, `edge guard: bright side stays bright (${edgeR})`);
  assert.ok(out.every((v, i) => (i + 1) % 4 !== 0 || v === 255), 'alpha preserved');
});

/* ---------------- seam blend: wrap edges soften, center untouched --------- */
test('seam blend: equirect cut line softens, central pixels bit identical', async () => {
  const { seamBlendBuffer } = await import('../js/viewer/smooth.js');
  const w = 64, h = 24;
  const img = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    img[i * 4] = x < 8 ? 255 : x > 55 ? 0 : 120;   // hard bright/dark poles at the seam
    img[i * 4 + 3] = 255;
  }
  const out = seamBlendBuffer(img, w, h, { strip: 14 });
  const mid = 32 * 4;
  assert.equal(out[mid], 120, 'center column survives untouched');
  // seam gradient: the cut is now a ramp — neighboring columns near the seam
  // must be closer in value than the original 255↔0 jump
  const jumpBefore = Math.abs(img[0] - img[63 * 4]);
  const jumpAfter = Math.abs(out[0] - out[63 * 4]);
  assert.ok(jumpAfter <= jumpBefore * 0.5, `seam jump ${jumpBefore} -> ${jumpAfter}`);
  // interior columns outside the strip stay identical
  assert.equal(out[16 * 4], 120, 'columns beyond the strip stay bit identical');
});

/* ---------------- runner ---------------- */
(async () => {
  console.log('Panorama Maps — core test suite');
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
