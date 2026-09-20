/**
 * Panorama Maps — worlds/willow-parish.js
 *
 * "Willow Parish (Real · AI)" — the photorealistic demo world.
 * Same one-street parish layout as Chapel Lane but bigger/longer
 * (700 m), with AI-generated photographic panoramas bundled as assets.
 *
 * Every node carries THREE scene modes (day / rain / night) — the entire
 * street was pre-generated in each mode, so the display-mode toggle never
 * regenerates anything: identity and continuity are fixed at build time.
 */
import { WorldGraph } from '../core/world-graph.js';
import { MapScale } from '../core/scale.js';

const VARIANT = (n, mode) => `assets/willow/${mode}/n${n}.jpg`;

export function buildWillowParish() {
  const scale = new MapScale({ pixelsPerMeter: 2, movement: { stepPixels: 12, stepMinPixels: 10, stepMaxPixels: 15 } });
  const g = new WorldGraph(scale, { id: 'demo_willow_parish', name: 'Willow Parish' });
  g.environment = {
    ...g.environment,
    timeOfDay: 'day', weather: 'clear', sunAzimuthDeg: 118, sunElevationDeg: 34,
    groundBase: '#7d9b68',
    description: 'A photoreal parish: 700 m of willow-lined lane ending at St. Hilda’s church. AI-generated panoramas, three scene modes.',
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
  g.environment.features.push(
    { id: 'road_willow', type: 'road', name: 'Willow Street', points: [[churchX, 60 * PXM], [churchX, 660 * PXM]], widthM: 5.5, surface: 'asphalt' },
  );

  // nodes every 100 m — the whole street, three moods each
  const meters = [60, 160, 260, 360, 460, 560, 660];
  const ids = [];
  meters.forEach((m, i) => {
    const n = g.addNode({
      id: `willow_${String(m).padStart(3, '0')}m`, x: churchX, y: m * PXM,
      name: `Willow Street · ${m} m`,
      pano: {
        kind: 'urlset',
        variants: {
          day: VARIANT(i + 1, 'day'),
          rain: VARIANT(i + 1, 'rain'),
          night: VARIANT(i + 1, 'night'),
        },
      },
    });
    if (ids.length) g.connect(ids[ids.length - 1], n.id);
    ids.push(n.id);
  });

  // landmarks + map dressing
  g.addLandmark({ id: 'lm_hilda', type: 'church', name: 'St. Hilda’s Church', x: churchX, y: churchYpx, importance: 1 });
  g.addLandmark({ id: 'lm_hilda_tower', type: 'tower', name: 'Church Tower', x: churchX + 8 * PXM, y: churchYpx - 4 * PXM, importance: 0.9 });
  g.environment.features.push(
    { id: 'bld_hilda', type: 'building', kind: 'church', x: churchX, y: churchYpx, w: 15 * PXM, d: 26 * PXM, h: 14, name: 'St. Hilda’s', color: '#d9cdb4' },
  );
  const cottages = [[-14, 150, 'Willow Cottage'], [15, 250, 'Pear Tree House'], [-15, 350, 'Old School'], [16, 440, 'Forge Cottage'], [-13, 545, 'Longbarn']];
  for (const [xm, ym, name] of cottages) {
    g.environment.features.push({ id: 'bld_' + name.replace(/\W+/g, '_'), type: 'building', kind: 'house', x: xm * PXM, y: ym * PXM, w: 8 * PXM, d: 7 * PXM, h: 5.5, name, color: '#e3d8c2' });
  }
  for (let i = 0; i < 10; i++) {
    const xm = (i % 2 ? -1 : 1) * (7.5 + (i % 3));
    g.environment.features.push({ id: 'willow_' + i, type: 'tree', x: xm * PXM, y: (70 + i * 62) * PXM, hM: 9, rM: 2.6 });
  }

  for (const n of g.nodes.values()) {
    const z = g.zones.zonesAt(n.x, n.y);
    n.zoneId = z[0] || null;
  }

  return {
    graph: g,
    startNodeId: 'willow_160m',
    modes: ['day', 'rain', 'night'],
    blurb: 'Photorealistic AI world — same street in day, rain and night. Use the segmented control above to switch the mood of the whole world.',
  };
}
