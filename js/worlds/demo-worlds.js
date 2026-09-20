/**
 * Panorama Maps — worlds/demo-worlds.js
 *
 * Three demo worlds (Spec §13):
 *   1. Chapel Lane   — small; basic navigation + panorama continuity + the
 *      mandatory 500 m church-zone test, plus the 8×8 king-move plaza grid.
 *   2. Millbrook     — medium town; branches, market, church, riverside.
 *   3. Great Vale    — large world, 1,000+ panorama nodes; lazy loading +
 *      spatial indexing stress case.
 *
 * Every node is created with REAL coordinates; every panorama is generated
 * from the world model (never an unrelated image).
 */
import { WorldGraph, bearingDeg } from '../core/world-graph.js';
import { MapScale } from '../core/scale.js';
import { rngFor } from '../gen/util.js';
import { buildWillowParish } from './willow-parish.js';

let uid = 0;
const nid = (p) => `${p}_${(uid++).toString(36)}`;

/* ---------- helpers ---------- */

/** Create or reuse a node near (x, y) — intersections merge. */
function nodeAt(graph, x, y, name, dedupePx = 6) {
  const hit = graph.nearestNode(x, y, dedupePx);
  if (hit) return hit;
  return graph.addNode({ id: nid('n'), x, y, name, pano: { kind: 'generated' } });
}

/**
 * Drop nodes every `spacingPx` along a polyline and connect them.
 * The FIRST point merges into an existing street node within
 * `spacingPx * 0.75` (a branch must START on the street it leaves —
 * never dangle a parallel duplicate node a few metres away, Spec §12).
 */
function roadChain(graph, pts, spacingPx, nameFn) {
  const ids = [];
  for (let s = 0; s < pts.length - 1; s++) {
    const [x1, y1] = pts[s], [x2, y2] = pts[s + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.round(len / spacingPx));
    for (let t = (s === 0 ? 0 : 1); t <= steps; t++) {
      const x = x1 + (x2 - x1) * t / steps, y = y1 + (y2 - y1) * t / steps;
      const mergePx = (s === 0 && t === 0) ? spacingPx * 0.75 : 6;
      const n = nodeAt(graph, x, y, nameFn(ids.length, x, y), mergePx);
      if (ids.length && ids[ids.length - 1] !== n.id) graph.connect(ids[ids.length - 1], n.id);
      ids.push(n.id);
    }
  }
  return ids;
}

/**
 * Junction pass: any two nodes within radiusPx of each other get an edge.
 * Replaces fragile index-based stitches — if two routes geometrically cross
 * or meet, the graph must say so (Spec §12 "roads must connect logically").
 */
function autoJunctions(graph, radiusPx) {
  const seen = new Set();
  for (const n of [...graph.nodes.values()]) {
    // queryRadius is a coarse bucket lookup — filter by exact distance here
    for (const id of graph.index.queryRadius(n.x, n.y, radiusPx)) {
      if (id === n.id) continue;
      const m = graph.getNode(id);
      if (!m || Math.hypot(m.x - n.x, m.y - n.y) > radiusPx) continue;
      const key = n.id < id ? n.id + '|' + id : id + '|' + n.id;
      if (seen.has(key)) continue;
      seen.add(key);
      graph.connect(n.id, id);   // connect() returns the existing edge if present
    }
  }
}

function addZoneAssignments(graph) {
  for (const n of graph.nodes.values()) {
    const z = graph.zones.zonesAt(n.x, n.y);
    n.zoneId = z[0] || null;
    if (!n.headingDeg && n.headingDeg !== 0) n.headingDeg = 0;
  }
}

function feature(graph, f) {
  (graph.environment.features = graph.environment.features || []).push(f);
  return f;
}
const road = (g, name, pts, widthM = 5, surface = 'asphalt') =>
  feature(g, { id: 'road_' + name.replace(/\W+/g, '_'), type: 'road', name, points: pts, widthM, surface });
const building = (g, kind, x, y, wM, dM, h, name, color) =>
  feature(g, { id: 'bld_' + name.replace(/\W+/g, '_'), type: 'building', kind, x, y, w: wM * g.scale.pixelsPerMeter, d: dM * g.scale.pixelsPerMeter, h, name, color });
const region = (g, kind, shape) => feature(g, { id: 'rgn_' + kind + '_' + (uid++), type: 'region', kind, ...shape });

/* ==================================================================== */
/* DEMO 1 — Chapel Lane                                                 */
/* ==================================================================== */
export function buildChapelLane() {
  uid = 0;
  const scale = new MapScale({ pixelsPerMeter: 2, movement: { stepPixels: 20, stepMinPixels: 10, stepMaxPixels: 30 } });
  const g = new WorldGraph(scale, { id: 'demo_chapel_lane', name: 'Chapel Lane' });
  g.environment = {
    ...g.environment,
    timeOfDay: 'day', weather: 'clear', sunAzimuthDeg: 105, sunElevationDeg: 38,
    groundBase: '#7fa069', groundBaseNote: 'meadow',
    description: 'A rural parish: a stone church at the north end of a 520 m processional way, an 8×8 plaza grid (king-move demo), and a side lane of cottages.',
    features: [],
  };
  g.settings.nodeSpacingPx = 20;

  const PXM = scale.pixelsPerMeter;         // 2 px == 1 m
  const streetX = 0, churchY = 0;

  // --- the 500 m continuity test setup (Spec §8) -----------------------
  // Church centre at (0,0); zone radius 1000 px == 500 m. Street nodes run
  // south every 10 m from 20 m to 520 m: the boundary rule says ≥ 490 m and
  // ≤ 500 m are still inside, > 500 m is outside.
  g.zones.add({
    id: 'zone_church_vicinity', name: 'Church Vicinity (500 m)', shape: 'circle',
    cx: churchY ? streetX : streetX, cy: churchY, radiusPx: 500 * PXM,
    color: 'rgba(214,158,64,0.10)',
    meta: { kind: 'church_vicinity', boundaryMeters: 500 },
  });

  // processional way nodes: 20 m … 520 m at 10 m steps (51 nodes)
  road(g, 'Processional Way', [[streetX, 20 * PXM], [streetX, 520 * PXM]], 6, 'asphalt');
  const streetIds = [];
  for (let m = 20; m <= 520; m += 10) {
    const n = g.addNode({
      id: `way_${String(m).padStart(3, '0')}m`, x: streetX, y: m * PXM,
      name: `Processional Way · ${m} m`,
      pano: { kind: 'generated' },
    });
    if (streetIds.length) g.connect(streetIds[streetIds.length - 1], n.id);
    streetIds.push(n.id);
  }

  // --- the 8×8 plaza grid (king-move engine demo, Spec §34) ------------
  const gx = 30 * PXM, gy = 280 * PXM, cell = 20 * PXM / 2;  // 10 m spacing, east of the street at 280 m
  road(g, 'Plaza Loop', [[gx, gy], [gx + 7 * cell, gy], [gx + 7 * cell, gy + 7 * cell], [gx, gy + 7 * cell], [gx, gy]], 4, 'stone');
  region(g, 'plaza', { shape: 'rect', x: gx - cell, y: gy - cell, w: 9 * cell, h: 9 * cell });
  const gridIds = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const n = g.addNode({ id: `plaza_${r}_${c}`, x: gx + c * cell, y: gy + r * cell, name: `Plaza ${r + 1}-${c + 1}`, pano: { kind: 'generated' } });
      gridIds.push(n.id);
    }
  }
  const at = (r, c) => gridIds[r * 8 + c];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    // king-style adjacency: all 8 neighbors (Spec §13)
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) g.connect(at(r, c), at(rr, cc));
    }
  }
  // deliberately blocked edge to demo movement rejection (Spec §13, §38)
  g.setEdgeBlocked(at(3, 3), at(3, 4), true);
  g.getNode(gridIds[3 * 8 + 3]).meta = { note: 'Fountain works — east passage blocked' };
  // connect plaza to street (via its west edge at 280 m row)
  for (let r = 0; r < 8; r++) {
    const y = gy + r * cell;
    const sn = g.nearestNode(streetX, y, 4 * PXM);
    if (sn) g.connect(at(r, 0), sn.id);
  }
  autoJunctions(g, 10);   // any remaining geometric near-misses

  // --- side lane with cottages ----------------------------------------
  const laneY = 300 * PXM, laneX2 = 90 * PXM;
  road(g, 'Chapel Lane', [[streetX, laneY], [laneX2, laneY + 20 * PXM]], 4.5, 'dirt');
  // chain START merges into way_300m (same coordinates) — the lane junction
  const laneIds = roadChain(g, [[streetX, laneY], [laneX2, laneY + 20 * PXM]], 20 * PXM, (i) => `Chapel Lane · #${i + 1}`);

  // --- world features: the same church from EVERY node ---------------
  building(g, 'church', streetX, churchY, 16, 26, 15, 'St. Ansgar Chapel', '#e7ddc6');
  feature(g, { id: 'tower_bell', type: 'tower', x: streetX + 9 * PXM, y: churchY - 3 * PXM, hM: 24 });
  g.addLandmark({ id: 'lm_church', type: 'church', name: 'St. Ansgar Chapel', x: streetX, y: churchY, importance: 1.0 });
  g.addLandmark({ id: 'lm_tower', type: 'tower', name: 'Bell Tower', x: streetX + 9 * PXM, y: churchY - 3 * PXM, importance: 0.95 });
  g.addLandmark({ id: 'lm_fountain', type: 'fountain', name: 'Plaza Fountain', x: gx + 3.5 * cell, y: gy + 3.5 * cell, importance: 0.8 });

  const houseSpots = [
    ['house', -14, 90, 'Linden House'], ['house', 16, 130, 'Meadow Cottage'], ['house', -16, 210, 'Sexton’s House'],
    ['house', 15, 240, 'Willow House'], ['house', -12, 340, 'Thatch Cottage'], ['house', 14, 380, 'Holly House'],
    ['house', 50, 312, 'Lane End House'], ['shop', 62, 310, 'Village Store'], ['shop', 74, 314, 'Bakery'],
    ['house', -15, 430, 'Brook House'], ['house', 12, 470, 'Far View House'],
  ];
  for (const [kind, xm, ym, name] of houseSpots) building(g, kind, xm * PXM, ym * PXM, kind === 'shop' ? 9 : 7, kind === 'shop' ? 7 : 6, kind === 'shop' ? 4.5 : 5.5, name);

  const treeRng = rngFor('chapel_trees');
  for (let i = 0; i < 26; i++) {
    const xm = (treeRng() < 0.5 ? -1 : 1) * (22 + treeRng() * 46);
    const ym = 30 + treeRng() * 480;
    feature(g, { id: 'tree_' + i, type: 'tree', x: xm * PXM, y: ym * PXM, hM: 5 + treeRng() * 5, rM: 1.6 + treeRng() * 1.6 });
  }
  g.addLandmark({ id: 'lm_tree', type: 'tree', name: 'Old Linden', x: 22 * PXM, y: 130 * PXM, importance: 0.7 });
  feature(g, { id: 'tree_linden', type: 'tree', x: 22 * PXM, y: 130 * PXM, hM: 11, rM: 3.4 });

  feature(g, { id: 'car_1', type: 'car', x: 6 * PXM, y: 306 * PXM, color: '#a8412f' });
  feature(g, { id: 'car_2', type: 'car', x: -5 * PXM, y: 88 * PXM, color: '#3c5c96' });
  feature(g, { id: 'sign_1', type: 'sign', x: 4 * PXM, y: 298 * PXM, text: 'Chapel Ln' });
  feature(g, { id: 'sign_2', type: 'sign', x: 4 * PXM, y: 24 * PXM, text: 'Processional Way' });

  region(g, 'field', { shape: 'rect', x: -120 * PXM, y: 60 * PXM, w: 90 * PXM, h: 180 * PXM });

  // two deliberately incomplete panoramas → AutoComplete Panorama showcase
  g.getNode('plaza_2_5').pano.incomplete = { top: 8, bottom: 0 };
  g.getNode('way_140m').pano.incomplete = { top: 6, bottom: 5 };

  addZoneAssignments(g);
  return {
    graph: g,
    startNodeId: 'way_020m',
    tests: {
      church: { zoneId: 'zone_church_vicinity', boundaryMeters: 500, streetPrefix: 'way_' },
    },
    blurb: 'Small parish world. Ten-metre steps along the 520 m processional way — the church grows as you approach and stays the same church. Plaza uses 8-direction movement.',
  };
}

/* ==================================================================== */
/* DEMO 2 — Millbrook                                                   */
/* ==================================================================== */
export function buildMillbrook() {
  uid = 0;
  const scale = new MapScale({ pixelsPerMeter: 2, movement: { stepPixels: 12, stepMinPixels: 10, stepMaxPixels: 15 } });
  const g = new WorldGraph(scale, { id: 'demo_millbrook', name: 'Millbrook' });
  g.environment = {
    ...g.environment,
    timeOfDay: 'golden', weather: 'clear', sunAzimuthDeg: 262, sunElevationDeg: 14,
    groundBase: '#8a9d6b',
    description: 'A riverside market town: Main Street, Church Avenue, Market Square, Mill Road and a residential loop.',
    features: [],
  };
  const PXM = 2;

  g.zones.add({ id: 'zone_market', name: 'Market Square', shape: 'rect', x: -60 * PXM, y: -40 * PXM, w: 150 * PXM, h: 90 * PXM, meta: { kind: 'market' } });
  g.zones.add({ id: 'zone_church_vicinity', name: 'Church Vicinity (300 m)', shape: 'circle', cx: 180 * PXM, cy: -140 * PXM, radiusPx: 300 * PXM, color: 'rgba(214,158,64,0.10)', meta: { kind: 'church_vicinity', boundaryMeters: 300 } });
  g.zones.add({ id: 'zone_riverside', name: 'Riverside', shape: 'rect', x: -260 * PXM, y: 180 * PXM, w: 560 * PXM, h: 120 * PXM, meta: { kind: 'riverside' } });

  road(g, 'Main Street', [[-220 * PXM, 0], [190 * PXM, 0]], 7);
  road(g, 'Church Avenue', [[120 * PXM, 0], [180 * PXM, -150 * PXM]], 5.5, 'stone');
  road(g, 'Mill Road', [[-60 * PXM, 0], [-140 * PXM, 200 * PXM]], 5);
  road(g, 'Riverside Walk', [[-220 * PXM, 200 * PXM], [220 * PXM, 200 * PXM]], 4, 'stone');
  road(g, 'Residential Loop', [[20 * PXM, 0], [40 * PXM, 110 * PXM], [150 * PXM, 120 * PXM], [150 * PXM, 200 * PXM]], 5);

  const spacing = 12 * PXM;
  // branches merge their FIRST point into Main Street / Riverside Walk —
  // junctions are geometric, not index guesses (Spec §12)
  const mainIds = roadChain(g, [[-220 * PXM, 0], [190 * PXM, 0]], spacing, (i) => `Main St · ${i}`);
  roadChain(g, [[120 * PXM, 0], [180 * PXM, -150 * PXM]], spacing, (i) => `Church Ave · ${i}`);
  roadChain(g, [[-60 * PXM, 0], [-140 * PXM, 200 * PXM]], spacing, (i) => `Mill Rd · ${i}`);
  const riverIds = roadChain(g, [[-220 * PXM, 200 * PXM], [220 * PXM, 200 * PXM]], spacing, (i) => `Riverside · ${i}`);
  const loopIds = roadChain(g, [[20 * PXM, 0], [40 * PXM, 110 * PXM], [150 * PXM, 120 * PXM], [150 * PXM, 200 * PXM]], spacing, (i) => `Loop · ${i}`);
  autoJunctions(g, 10);   // pick up remaining near-miss crossings (e.g. loop end)

  // Market square internal crossings
  for (let i = 1; i < 4; i++) {
    const a = g.nearestNode(-60 * PXM + i * 30 * PXM, 0, 20);
    const b = g.nearestNode(-60 * PXM + i * 30 * PXM, 44 * PXM, 30 * PXM);
    const mid = g.addNode({ id: nid('market'), x: -60 * PXM + i * 30 * PXM, y: 44 * PXM, name: `Market Row ${i}`, pano: { kind: 'generated' } });
    if (a) g.connect(a.id, mid.id);
    if (b && b.id !== mid.id) g.connect(mid.id, b.id);
  }

  building(g, 'church', 180 * PXM, -160 * PXM, 15, 24, 14, 'St. Mary’s', '#eee3ce');
  feature(g, { id: 'tower_mary', type: 'tower', x: 189 * PXM, y: -165 * PXM, hM: 26 });
  g.addLandmark({ id: 'stmary', type: 'church', name: 'St. Mary’s Church', x: 180 * PXM, y: -160 * PXM, importance: 1 });
  g.addLandmark({ id: 'clock', type: 'tower', name: 'Clock Tower', x: 189 * PXM, y: -165 * PXM, importance: 0.9 });

  const shopNames = ['Grocer', 'Bookseller', 'Tea Room', 'Pharmacy', 'Barber', 'Ironmonger', 'Florist', 'Post Office'];
  shopNames.forEach((name, i) => {
    const xm = -200 * PXM + i * 46 * PXM;
    building(g, 'shop', xm, name.startsWith('Tea') ? 11 * PXM : -11 * PXM, 9, 7, 5, name);
  });
  const houseNames = ['Rosemary', 'Chestnut', 'Mallow', 'Primrose', 'Sorrel', 'Juniper'];
  houseNames.forEach((name, i) => {
    building(g, 'house', (30 + i * 24) * PXM, (60 + (i % 2) * 30) * PXM, 7, 6, 5.5, name + ' Cottage');
  });
  building(g, 'house', 150 * PXM, -40 * PXM, 8, 7, 6, 'Vicarage');

  region(g, 'water', { shape: 'rect', x: -260 * PXM, y: 230 * PXM, w: 560 * PXM, h: 80 * PXM });
  region(g, 'plaza', { shape: 'rect', x: -60 * PXM, y: 6 * PXM, w: 122 * PXM, h: 44 * PXM });

  const tr = rngFor('mill_trees');
  for (let i = 0; i < 44; i++) {
    const xm = -230 * PXM + tr() * 470 * PXM;
    const ym = (-20 + tr() * 240) * PXM;
    if (Math.abs(ym) < 8 * PXM) continue;
    feature(g, { id: 'mtree_' + i, type: 'tree', x: xm, y: ym, hM: 5 + tr() * 6, rM: 1.5 + tr() * 2 });
  }
  for (let i = 0; i < 6; i++) feature(g, { id: 'mcar_' + i, type: 'car', x: (-160 + i * 55) * PXM, y: (i % 2 ? 6 : -6) * PXM, color: ['#a8412f', '#3c5c96', '#bbb', '#333'][i % 4] });
  feature(g, { id: 'sign_main', type: 'sign', x: -56 * PXM, y: 6 * PXM, text: 'Main St' });

  g.nearestNode(-200 * PXM, 200 * PXM, 40 * PXM).pano.incomplete = { top: 7, bottom: 0 };

  addZoneAssignments(g);
  const start = g.nearestNode(-40 * PXM, 0, 20 * PXM);
  return {
    graph: g,
    startNodeId: start.id,
    blurb: 'Medium town — market square, church approach, mill road and riverside loop with multiple branches to explore.',
  };
}

/* ==================================================================== */
/* DEMO 3 — Great Vale (1,000+ nodes)                                   */
/* ==================================================================== */
export function buildGreatVale() {
  uid = 0;
  const scale = new MapScale({ pixelsPerMeter: 2, movement: { stepPixels: 12, stepMinPixels: 10, stepMaxPixels: 15 } });
  const g = new WorldGraph(scale, { id: 'demo_great_vale', name: 'Great Vale' });
  g.environment = {
    ...g.environment,
    timeOfDay: 'day', weather: 'clear', sunAzimuthDeg: 130, sunElevationDeg: 45,
    groundBase: '#83a06d',
    description: 'A large vale town: an 8×6 block street grid with a perimeter boulevard and a diagonal avenue. 1,000+ panorama nodes with lazy loading and spatial indexing.',
    features: [],
  };
  const PXM = 2;
  const BX = 8, BY = 6, BLOCK = 100 * PXM;         // 50 m blocks
  const W = BX * BLOCK, H = BY * BLOCK;

  g.zones.add({ id: 'zone_parish', name: 'Parish Quarter (500 m)', shape: 'circle', cx: W * 0.5, cy: -60 * PXM, radiusPx: 500 * PXM, color: 'rgba(214,158,64,0.08)', meta: { kind: 'church_vicinity', boundaryMeters: 500 } });
  g.zones.add({ id: 'zone_lakeside', name: 'Lakeside', shape: 'rect', x: -40 * PXM, y: H + 40 * PXM, w: W * 0.45, h: 90 * PXM, meta: { kind: 'lakeside' } });
  g.zones.add({ id: 'zone_market', name: 'Vale Market', shape: 'rect', x: W * 0.36, y: H * 0.42, w: W * 0.28, h: H * 0.18, meta: { kind: 'market' } });

  // streets
  const spacing = 10 * PXM;
  const vertIds = [], horizIds = [];
  for (let c = 0; c <= BX; c++) {
    road(g, `Avenue ${c + 1}`, [[c * BLOCK, 0], [c * BLOCK, H]], c === 0 || c === BX ? 8 : 5);
    vertIds.push(roadChain(g, [[c * BLOCK, 0], [c * BLOCK, H]], spacing, (i) => `Ave ${c + 1} · ${i}`));
  }
  for (let r = 0; r <= BY; r++) {
    road(g, `Street ${r + 1}`, [[0, r * BLOCK], [W, r * BLOCK]], r === 0 || r === BY ? 8 : 5);
    horizIds.push(roadChain(g, [[0, r * BLOCK], [W, r * BLOCK]], spacing, (i) => `St ${r + 1} · ${i}`));
  }
  // diagonal avenue
  road(g, 'Cathedral Rise', [[0, H], [W * 0.5, -40 * PXM]], 6, 'stone');
  const diag = roadChain(g, [[0, H], [W * 0.5, -40 * PXM]], spacing, (i) => `Rise · ${i}`);
  if (horizIds[BY][0] !== diag[0]) g.connect(horizIds[BY][0], diag[0]);

  // junctions derive from GEOMETRY: any two nodes within 10 px connect —
  // exact grid crossings merge in roadChain, near-miss diagonal crossings
  // are picked up here (Spec §12: roads must connect logically)
  autoJunctions(g, 10);

  // church at the north apex
  building(g, 'church', W * 0.5, -55 * PXM, 18, 30, 17, 'Vale Cathedral', '#ece1c8');
  feature(g, { id: 'cath_tower', type: 'tower', x: W * 0.5 + 10 * PXM, y: -62 * PXM, hM: 34 });
  g.addLandmark({ id: 'cath', type: 'church', name: 'Vale Cathedral', x: W * 0.5, y: -55 * PXM, importance: 1 });
  const cathNode = g.nearestNode(W * 0.5, 0, 30 * PXM);
  if (cathNode && cathNode.id !== diag[diag.length - 1]) g.connect(diag[diag.length - 1], cathNode.id);

  // seeded town fill: houses, shops, trees
  const rng = rngFor('great_vale_fill');
  let bi = 0;
  for (let c = 0; c < BX; c++) for (let r = 0; r < BY; r++) {
    const bx = c * BLOCK, by = r * BLOCK;
    const nB = 1 + ((rng() * 3) | 0);
    for (let k = 0; k < nB; k++) {
      const x = bx + 15 * PXM + rng() * (BLOCK - 30 * PXM);
      const y = by + 15 * PXM + rng() * (BLOCK - 30 * PXM);
      const kind = rng() < 0.24 ? 'shop' : 'house';
      building(g, kind, x, y, 6 + rng() * 4, 5 + rng() * 3, 4.5 + rng() * 2, (kind === 'shop' ? 'Shop ' : 'House ') + (++bi));
    }
    const nT = 1 + ((rng() * 3) | 0);
    for (let k = 0; k < nT; k++) {
      feature(g, { id: 'vt_' + c + '_' + r + '_' + k, type: 'tree', x: bx + rng() * BLOCK, y: by + rng() * BLOCK, hM: 5 + rng() * 7, rM: 1.6 + rng() * 2 });
    }
  }
  region(g, 'water', { shape: 'rect', x: -40 * PXM, y: H + 60 * PXM, w: W * 0.4, h: 60 * PXM });
  region(g, 'field', { shape: 'rect', x: W + 30 * PXM, y: H * 0.2, w: 160 * PXM, h: 240 * PXM });
  g.addLandmark({ id: 'lake', type: 'water', name: 'Vale Lake', x: W * 0.18, y: H + 90 * PXM, importance: 0.7 });
  g.addLandmark({ id: 'market', type: 'market', name: 'Vale Market', x: W * 0.5, y: H * 0.5, importance: 0.8 });

  addZoneAssignments(g);
  return {
    graph: g,
    startNodeId: g.nearestNode(W * 0.5, H * 0.5, 30 * PXM).id,
    blurb: `Large world — ${g.nodes.size}+ panorama nodes over an 8×6 block town. Demonstrates lazy generation, LRU caching and spatial indexing.`,
  };
}

export const DEMO_WORLDS = [
  { id: 'demo_chapel_lane', name: 'Chapel Lane', tag: 'Small', build: buildChapelLane },
  { id: 'demo_millbrook', name: 'Millbrook', tag: 'Medium', build: buildMillbrook },
  { id: 'demo_great_vale', name: 'Great Vale', tag: 'Large · 1,000+ nodes', build: buildGreatVale },
  { id: 'demo_willow_parish', name: 'Willow Parish', tag: 'Real · AI photos', kind: 'real', modes: ['day', 'rain', 'night'], thumb: 'assets/willow/day/n3.jpg', build: buildWillowParish },
];
