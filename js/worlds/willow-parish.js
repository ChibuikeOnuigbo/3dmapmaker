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

export function buildWillowParish() {
  const scale = new MapScale({ pixelsPerMeter: 2, movement: { stepPixels: 12, stepMinPixels: 10, stepMaxPixels: 15 } });
  const g = new WorldGraph(scale, { id: 'demo_willow_parish', name: 'Willow Parish' });
  g.environment = {
    ...g.environment,
    timeOfDay: 'day', weather: 'clear', sunAzimuthDeg: 118, sunElevationDeg: 34,
    groundBase: '#7d9b68',
    description: 'A photoreal village: the 700 m willow lane ending at St. Hilda’s church, with ten spurs around the green, forge, school and orchard. AI-generated panoramas, three scene modes.',
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

  const byImg = new Map();
  for (const [img, suffix, xM, yM, name] of NODES) {
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
  for (const [a, b] of EDGES) g.connect(byImg.get(a), byImg.get(b));

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
