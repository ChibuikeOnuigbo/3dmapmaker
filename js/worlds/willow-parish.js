/**
 * Panorama Maps — worlds/willow-parish.js
 *
 * "Willow Parish (Real · AI)" — the photorealistic demo world.
 * Expanded to a full village: the 700 m willow lane plus ten spurs,
 * the church complex, the village green with its pond, the school rise,
 * the forge lane, the orchard walk and the manor approach — 34 photo
 * spots in total, three scene modes each when generated.
 *
 * AI generation is grounded by identity chaining: every new panorama is
 * produced with the existing committed panoramas of this same village as
 * reference, so the AI cannot drift off-course (no external map imagery
 * is downloaded into the product).
 *
 * Every node carries THREE scene modes (day / rain / night) once their
 * files exist; nodes fall back to whatever variant exists, so the world
 * is walkable from the first generated frame.
 */
import { WorldGraph } from '../core/world-graph.js';
import { MapScale } from '../core/scale.js';

const VARIANT = (n, mode) => `assets/willow/${mode}/n${n}.jpg`;

/** [img no, id suffix, xM, yM, name] */
const NODES = [
  [1, '060', 0, 60, 'Willow Street · 60 m'],
  [2, '160', 0, 160, 'Willow Street · 160 m'],
  [3, '260', 0, 260, 'Willow Street · 260 m'],
  [4, '360', 0, 360, 'Willow Street · 360 m'],
  [5, '460', 0, 460, 'Willow Street · 460 m'],
  [6, '560', 0, 560, 'Willow Street · 560 m'],
  [7, '660', 0, 660, 'Willow Street · 660 m'],
  [8, 'porch', 0, 0, 'Church Porch'],
  [9, 'nave', 0, -8, 'St. Hilda’s Nave'],
  [10, 'churchyard', 16, 10, 'Churchyard Green'],
  [11, 'yew_walk', 70, 2, 'Yew Walk'],
  [12, 'yew_gate', 120, -4, 'Yew Gate'],
  [13, 'west_bend', -55, 60, 'West Bend'],
  [14, 'hall_view', 60, 260, 'Hall Lane View'],
  [15, 'hall_cottages', 120, 260, 'Hall Cottage Row'],
  [16, 'green_edge', -55, 160, 'Green Edge'],
  [17, 'village_green', -115, 160, 'Village Green'],
  [18, 'green_pond', -115, 215, 'Green Pond'],
  [19, 'pond_bridge', -115, 110, 'Pond Bridge'],
  [20, 'green_end', -170, 160, 'West Green End'],
  [21, 'school_corner', -55, 350, 'School Corner'],
  [22, 'school_rise', -115, 350, 'School Rise'],
  [23, 'old_school', -115, 400, 'Old Schoolhouse'],
  [24, 'forge_corner', -55, 460, 'Forge Corner'],
  [25, 'forge_lane', -115, 460, 'Forge Lane'],
  [26, 'smithy_gate', -115, 510, 'Smithy Gate'],
  [27, 'orchard_corner', 55, 660, 'Orchard Corner'],
  [28, 'orchard_row', 115, 660, 'Orchard Row'],
  [29, 'orchard_end', 165, 660, 'Orchard End'],
  [30, 'manor_mile', 0, 760, 'Manor Mile'],
  [31, 'manor_gate', 0, 860, 'Manor Gate'],
  [32, 'meadow_rise', 55, 560, 'Meadow Rise'],
  [33, 'meadow_far', 115, 560, 'Meadow Rise Far'],
  [34, 'pinfold_way', 170, -4, 'Pinfold Way'],
];

/** parent → child; the whole village is one connected tree */
const EDGES = [
  [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7],
  [7, 30], [30, 31],
  [1, 8], [8, 9], [8, 10], [10, 11], [11, 12], [12, 34],
  [1, 13],
  [3, 14], [14, 15],
  [2, 16], [16, 17], [17, 18], [17, 19], [17, 20],
  [4, 21], [21, 22], [22, 23],
  [5, 24], [24, 25], [25, 26],
  [7, 27], [27, 28], [28, 29],
  [6, 32], [32, 33],
];

export const DENSE_MIN_M = 35;
export const DENSE_FIRST_IMG = 35;

/**
 * Waypoint densification — RECURSIVE: passes keep splitting every edge of
 * DENSE_MIN_M or more at its midpoint until no edge remains that long.
 * Result: a photo frame every ~17.5–35 m, so a walk hop renders as a handful
 * of ~5 m dolly steps (see js/viewer/walk-steps.js) instead of a jump.
 *
 * Pure per call: never mutates the module table (the world can be built many
 * times in one session, e.g. app boot plus landing previews). Deterministic:
 * same pass order + stable EDGES order ⇒ stable img numbers.
 */
export function densify(minM = DENSE_MIN_M) {
  const xy = new Map(NODES.map(([img, , x, y]) => [img, [x, y]]));
  const nodes = NODES.map((n) => [...n]);
  let img = DENSE_FIRST_IMG;
  const split = (edges, threshold) => {
    const finer = [];
    for (const [a, b] of edges) {
      const [ax, ay] = xy.get(a), [bx, by] = xy.get(b);
      if (Math.hypot(bx - ax, by - ay) >= threshold) {
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        xy.set(img, [mx, my]);
        nodes.push([img, `w${img}`, mx, my, `Waypoint · ${img}`]);
        finer.push([a, img], [img, b]);
        img++;
      } else finer.push([a, b]);
    }
    return finer;
  };
  // seed pass replicates the original 55 m split so already-generated frames
  // n35..n58 keep their map positions forever; recursion then refines to minM
  let edges = split(EDGES.map((e) => [...e]), 55);
  for (let pass = 0; pass < 8; pass++) {
    if (edges.every(([a, b]) => { const [ax, ay] = xy.get(a), [bx, by] = xy.get(b); return Math.hypot(bx - ax, by - ay) < minM; })) break;
    edges = split(edges, minM);
  }
  return { nodes, edges };
}

export function buildWillowParish() {
  const scale = new MapScale({ pixelsPerMeter: 2, movement: { stepPixels: 12, stepMinPixels: 10, stepMaxPixels: 15 } });
  const g = new WorldGraph(scale, { id: 'demo_willow_parish', name: 'Willow Parish' });
  g.environment = {
    ...g.environment,
    timeOfDay: 'day', weather: 'clear', sunAzimuthDeg: 118, sunElevationDeg: 34,
    groundBase: '#7d9b68',
    description: 'A photoreal village: the willow lane ending at St. Hilda’s church, with ten spurs around the green, forge, school and orchard. 57 photo spots dense enough to walk frame by frame. AI-generated panoramas, three scene modes.',
    features: [],
  };
  g.settings.nodeSpacingPx = 200;

  const PXM = 2, churchX = 0, churchYpx = -20 * PXM;

  g.zones.add({
    id: 'zone_church_vicinity', name: 'Church Vicinity (500 m)', shape: 'circle',
    cx: churchX, cy: churchYpx, radiusPx: 500 * PXM,
    color: 'rgba(214,158,64,0.10)',
    meta: { kind: 'church_vicinity', boundaryMeters: 500 },
  });

  // 2D map surface features (the visible scene comes from the photo assets)
  const M = (v) => v * PXM;
  const road = (id, name, pts, widthM = 5.5) => g.environment.features.push({ id, type: 'road', name, points: pts.map(p => [p[0] * PXM, p[1] * PXM]), widthM, surface: 'asphalt' });
  road('road_willow', 'Willow Street', [[0, 40], [0, 880]]);
  road('road_porch', 'Church Path', [[0, 40], [0, 0], [16, 10], [70, 2], [120, -4], [170, -4]], 4.5);
  road('road_west_bend', 'West Bend Lane', [[0, 60], [-55, 60]], 4.5);
  road('road_hall', 'Hall Lane', [[0, 260], [120, 260]], 4.5);
  road('road_green', 'Green Road', [[0, 160], [-170, 160]], 4.5);
  road('road_green_n', 'Pond Walk', [[-115, 110], [-115, 215]], 4);
  road('road_school', 'School Rise', [[0, 360], [-55, 350], [-115, 350], [-115, 400]], 4.5);
  road('road_forge', 'Forge Lane', [[0, 460], [-55, 460], [-115, 460], [-115, 510]], 4.5);
  road('road_orchard', 'Orchard Walk', [[0, 660], [165, 660]], 4.5);
  road('road_meadow', 'Meadow Rise', [[0, 560], [115, 560]], 4.5);
  g.environment.features.push({ id: 'pond_green', type: 'plaza', kind: 'water', name: 'Village Pond', x: M(-115), y: M(215), w: M(30), d: M(22), color: '#aacdec' });

  // surroundings: the map should never sit in a featureless void
  g.environment.features.push(
    { id: 'field_w', type: 'region', shape: 'rect', kind: 'meadow', name: 'Merrick Field', x: M(-260), y: M(60), w: M(70), h: M(700), color: '#cfe0b4' },
    { id: 'field_e', type: 'region', shape: 'rect', kind: 'meadow', name: 'Chapel Field', x: M(190), y: M(-60), w: M(60), h: M(520), color: '#cfe0b4' },
    { id: 'field_n', type: 'region', shape: 'rect', kind: 'meadow', name: 'Manor Fields', x: M(-90), y: M(900), w: M(180), h: M(70), color: '#cfe0b4' },
    { id: 'field_s', type: 'region', shape: 'rect', kind: 'meadow', name: 'Glebe', x: M(-60), y: M(-120), w: M(220), h: M(60), color: '#cfe0b4' },
  );
  // hedge and track lines that read as boundaries, Google-Maps style
  const hedge = (id, name, pts) => g.environment.features.push({ id, type: 'road', name, points: pts.map(p => [p[0] * PXM, p[1] * PXM]), widthM: 1.6, surface: 'dirt' });
  hedge('hedge_green_n', 'Green Hedge North', [[-185, 105], [-185, 225]]);
  hedge('hedge_green_w', 'Green Hedge West', [[-185, 105], [-185, 225]]);
  hedge('hedge_field_e', 'Chapel Field Hedge', [[185, -50], [185, 420]]);
  hedge('track_pinfold', 'Pinfold Track', [[170, -4], [230, -4]]);
  // visible barriers at every dead end: walkers can see why a lane stops
  const wall = (id, name, xM, yM, vert) => g.environment.features.push({ id, type: 'building', kind: 'wall', name, x: M(xM), y: M(yM), w: M(vert ? 1.2 : 7), d: M(vert ? 7 : 1.2), h: 1.1, color: '#b9b0a0' });
  wall('bar_pinfold_east', 'Stone Wall', 176, -4, true);
  wall('bar_west_end', 'Farm Gate', -196, 160, true);
  wall('bar_smithy_end', 'Meadow Gate', -115, 516, false);
  wall('bar_manor_gate', 'Manor Gates', 0, 866, false);
  wall('bar_pond_bank', 'Pond Bank Fence', -115, 225, false);

  const { nodes: allNodes, edges: densifiedEdges } = densify();

  const byImg = new Map();
  for (const [img, suffix, xM, yM, name] of allNodes) {
    const node = g.addNode({
      id: `willow_${suffix}`, x: xM * PXM, y: yM * PXM,
      name,
      pano: {
        kind: 'urlset',
        variants: {
          day: VARIANT(img, 'day'),
          rain: VARIANT(img, 'rain'),
          night: VARIANT(img, 'night'),
        },
      },
    });
    byImg.set(img, node.id);
  }
  for (const [a, b] of densifiedEdges) g.connect(byImg.get(a), byImg.get(b));

  // landmarks + map dressing
  g.addLandmark({ id: 'lm_hilda', type: 'church', name: 'St. Hilda’s Church', x: churchX, y: churchYpx, importance: 1 });
  g.addLandmark({ id: 'lm_hilda_tower', type: 'tower', name: 'Church Tower', x: churchX + 8 * PXM, y: churchYpx - 4 * PXM, importance: 0.9 });
  g.addLandmark({ id: 'lm_pond', type: 'water', name: 'Village Pond', x: M(-115), y: M(215), importance: 0.6 });
  g.addLandmark({ id: 'lm_manor', type: 'building', name: 'Willow Manor', x: M(0), y: M(872), importance: 0.8 });
  g.environment.features.push(
    { id: 'bld_hilda', type: 'building', kind: 'church', x: churchX, y: churchYpx, w: 15 * PXM, d: 26 * PXM, h: 14, name: 'St. Hilda’s', color: '#d9cdb4' },
  );
  const cottages = [
    [-14, 150, 'Willow Cottage'], [15, 250, 'Pear Tree House'], [-15, 350, 'Old School'], [16, 440, 'Forge Cottage'], [-13, 545, 'Longbarn'],
    [66, 266, 'Village Hall'], [124, 252, 'Hall Cottages'],
    [-108, 343, 'Schoolhouse West'], [-108, 407, 'Old Schoolhouse'],
    [-108, 452, 'Smithy'], [-108, 517, 'Forge Row'],
    [-60, 153, 'Green Cottage'], [-163, 153, 'West End Farm'],
    [62, 655, 'Orchard House'], [151, 655, 'Cider Barn'],
    [6, 766, 'Manor Lodge'], [-6, 858, 'Gate House'],
    [76, -6, 'Yew Cottage'], [158, -8, 'Pinfold House'],
  ];
  for (const [xm, ym, name] of cottages) {
    g.environment.features.push({ id: 'bld_' + name.replace(/\W+/g, '_'), type: 'building', kind: 'house', x: xm * PXM, y: ym * PXM, w: 8 * PXM, d: 7 * PXM, h: 5.5, name, color: '#e3d8c2' });
  }
  for (let i = 0; i < 10; i++) {
    const xm = (i % 2 ? -1 : 1) * (7.5 + (i % 3));
    g.environment.features.push({ id: 'willow_' + i, type: 'tree', x: xm * PXM, y: (70 + i * 62) * PXM, hM: 9, rM: 2.6 });
  }
  for (let i = 0; i < 6; i++) {
    g.environment.features.push({ id: 'orchard_tree_' + i, type: 'tree', x: (60 + i * 19) * PXM, y: 654 * PXM, hM: 6, rM: 2.4 });
  }
  for (let i = 0; i < 5; i++) {
    g.environment.features.push({ id: 'green_tree_' + i, type: 'tree', x: (-60 - i * 26) * PXM, y: 170 * PXM, hM: 8, rM: 2.8 });
  }

  for (const n of g.nodes.values()) {
    const z = g.zones.zonesAt(n.x, n.y);
    n.zoneId = z[0] || null;
  }

  return { graph: g, startNodeId: byImg.get(8) };
}
