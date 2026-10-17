/**
 * Panorama Maps — worlds/obsidian-gallery.js
 *
 * The Obsidian Art Gallery — Indoor World 2:
 * A contemporary architectural museum of modern kinetic sculpture:
 *   - Grand Central Rotunda & Atrium with polished dark terrazzo
 *   - Floating Cantilevered Mezzanine Ramp & Sculpture Plinths
 *   - Kinetic Light Cascade centerpiece
 *   - Adjoining Private Vault Gallery & Collectors Lounge
 *
 * Dense metric grid with OpenCV 3D object anchoring and continuous WASD room navigation.
 */
import { MapScale } from '../core/scale.js';
import { WorldGraph, angleDelta } from '../core/world-graph.js';

export function buildObsidianGallery() {
  const PXM = 4; // 4 pixels per meter
  const scale = new MapScale({
    pixelsPerMeter: PXM,
    movement: { stepPixels: 4, stepMinPixels: 2, stepMaxPixels: 6 },
  });

  const g = new WorldGraph(scale, { id: 'demo_obsidian_gallery', name: 'The Obsidian Art Gallery' });

  // 3D Physical World Anchors
  const WORLD_OBJECTS = [
    { id: 'kinetic_helix', name: 'Titanium Kinetic Helix Sculpture', x: 0, y: 0, z: 3.5, w: 3.2, d: 3.2, h: 7.0, zone: 'rotunda' },
    { id: 'monolith_plinth', name: 'Obsidian Monolith Pedestal', x: -5.0, y: -4.0, z: 1.0, w: 1.8, d: 1.8, h: 2.2, zone: 'rotunda' },
    { id: 'floating_ramp', name: 'Cantilevered Terrazzo Ramp', x: 5.5, y: 1.0, z: 2.2, w: 2.4, d: 8.0, h: 3.2, zone: 'mezzanine' },
    { id: 'vault_door', name: 'Reinforced Vault Pivot Portal', x: -4.0, y: 5.5, z: 1.5, w: 2.2, d: 0.4, h: 2.8, zone: 'vault' },
    { id: 'lounge_bench', name: 'Minimalist Leather Bench', x: 0, y: -6.0, z: 0.4, w: 3.0, d: 1.0, h: 0.5, zone: 'rotunda' },
  ];

  g.environment = {
    kind: 'indoor',
    theme: 'gallery',
    timeOfDay: 'day',
    weather: 'clear',
    defaultHeading: 0,
    worldObjects: WORLD_OBJECTS,
    features: [
      // Polished dark terrazzo floor
      { type: 'region', shape: 'rect', x: -8 * PXM, y: -8 * PXM, w: 16 * PXM, h: 16 * PXM, kind: 'stone', color: '#16191f', name: 'Polished Terrazzo' },
      // Gallery perimeter walls
      { type: 'wall', x1: -7.5 * PXM, y1: -7.5 * PXM, x2: 7.5 * PXM, y2: -7.5 * PXM },
      { type: 'wall', x1: 7.5 * PXM, y1: -7.5 * PXM, x2: 7.5 * PXM, y2: 7.5 * PXM },
      { type: 'wall', x1: 7.5 * PXM, y1: 7.5 * PXM, x2: -7.5 * PXM, y2: 7.5 * PXM },
      { type: 'wall', x1: -7.5 * PXM, y1: 7.5 * PXM, x2: -7.5 * PXM, y2: -7.5 * PXM },
    ],
  };

  g.zones.add({ id: 'zone_rotunda', name: 'Grand Rotunda & Atrium', bounds: [-7 * PXM, -7 * PXM, 7 * PXM, 2 * PXM] });
  g.zones.add({ id: 'zone_mezzanine', name: 'Cantilevered Mezzanine Ramp', bounds: [2 * PXM, -5 * PXM, 7 * PXM, 7 * PXM] });
  g.zones.add({ id: 'zone_vault', name: 'Vault Gallery & Lounge', bounds: [-7 * PXM, 2 * PXM, 2 * PXM, 7 * PXM] });

  g.addLandmark({ id: 'lm_helix', type: 'sculpture', name: 'Kinetic Helix', x: 0, y: 0, importance: 1.0 });
  g.addLandmark({ id: 'lm_monolith', type: 'sculpture', name: 'Obsidian Monolith', x: -5 * PXM, y: -4 * PXM, importance: 0.8 });
  g.addLandmark({ id: 'lm_vault', type: 'interior', name: 'Private Vault', x: -4 * PXM, y: 5 * PXM, importance: 0.9 });

  const STATIONS = [
    // Rotunda Core
    { id: 'gallery_entrance', x: 0, y: -6.5, head: 0, zone: 'zone_rotunda', name: 'Gallery North Portico' },
    { id: 'bench_view', x: 0, y: -5.0, head: 0, zone: 'zone_rotunda', name: 'Rotunda Bench Overlook' },
    { id: 'monolith_approach', x: -3.5, y: -4.0, head: 270, zone: 'zone_rotunda', name: 'Monolith Pedestal View' },
    { id: 'helix_north', x: 0, y: -2.0, head: 0, zone: 'zone_rotunda', name: 'Kinetic Helix Approach' },
    { id: 'helix_west', x: -2.2, y: 0, head: 90, zone: 'zone_rotunda', name: 'Kinetic Helix West Walk' },
    { id: 'helix_east', x: 2.2, y: 0, head: 270, zone: 'zone_rotunda', name: 'Kinetic Helix East Walk' },
    { id: 'helix_south', x: 0, y: 2.0, head: 180, zone: 'zone_rotunda', name: 'Kinetic Helix South Base' },

    // Mezzanine Ramp
    { id: 'ramp_foot', x: 4.5, y: -3.0, head: 180, zone: 'zone_mezzanine', name: 'Mezzanine Ramp Foot' },
    { id: 'ramp_mid', x: 5.5, y: 0, head: 180, zone: 'zone_mezzanine', name: 'Cantilever Incline Mid' },
    { id: 'ramp_high', x: 5.5, y: 3.5, head: 180, zone: 'zone_mezzanine', name: 'Mezzanine Upper Balcony' },
    { id: 'balcony_overlook', x: 4.0, y: 5.0, head: 270, zone: 'zone_mezzanine', name: 'High Atrium Overlook' },

    // Vault & Lounge
    { id: 'vault_foyer', x: -2.0, y: 3.5, head: 225, zone: 'zone_vault', name: 'Vault Threshold Hall' },
    { id: 'vault_portal', x: -4.0, y: 4.5, head: 225, zone: 'zone_vault', name: 'Heavy Pivot Portal' },
    { id: 'vault_inner', x: -5.5, y: 5.5, head: 0, zone: 'zone_vault', name: 'Inner Reserve Showcase' },
  ];

  for (const s of STATIONS) {
    const n = g.addNode({
      id: s.id,
      x: s.x * PXM,
      y: s.y * PXM,
      name: s.name,
      headingDeg: s.head,
      zoneId: s.zone,
      pano: { kind: 'generated' },
    });
    n.cv = {
      cameraPose: { x: s.x, y: s.y, z: s.id.startsWith('ramp_high') || s.id.startsWith('balcony') ? 3.4 : 1.7, yaw: s.head },
      description: `Obsidian Gallery station at ${s.x}m, ${s.y}m displaying kinetic modern art.`,
    };
  }

  const CORRIDORS = [
    ['gallery_entrance', 'bench_view', 2],
    ['bench_view', 'helix_north', 2],
    ['bench_view', 'monolith_approach', 2],
    ['helix_north', 'helix_west', 2],
    ['helix_north', 'helix_east', 2],
    ['helix_west', 'helix_south', 2],
    ['helix_east', 'helix_south', 2],
    ['helix_east', 'ramp_foot', 2],
    ['ramp_foot', 'ramp_mid', 2],
    ['ramp_mid', 'ramp_high', 2],
    ['ramp_high', 'balcony_overlook', 2],
    ['helix_south', 'vault_foyer', 2],
    ['vault_foyer', 'vault_portal', 2],
    ['vault_portal', 'vault_inner', 2],
  ];

  for (const [aId, bId, steps] of CORRIDORS) {
    const nA = g.getNode(aId), nB = g.getNode(bId);
    if (!nA || !nB) continue;
    const xA = nA.x / PXM, yA = nA.y / PXM;
    const xB = nB.x / PXM, yB = nB.y / PXM;
    const hA = nA.headingDeg ?? 0, hB = nB.headingDeg ?? 0;
    const distTotal = Math.hypot(xB - xA, yB - yA);

    let prev = aId;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const xInterp = xA + (xB - xA) * t;
      const yInterp = yA + (yB - yA) * t;
      const dHead = angleDelta(hA, hB);
      const headInterp = (((hA + dHead * t) % 360) + 360) % 360;
      const fId = `${aId}_to_${bId}_step${s}`;

      g.addNode({
        id: fId,
        x: xInterp * PXM,
        y: yInterp * PXM,
        name: `${nA.name} ➔ ${nB.name} (${Math.round(t * 100)}%)`,
        headingDeg: Math.round(headInterp),
        zoneId: nA.zoneId,
        pano: { kind: 'generated' },
      });
      g.connect(prev, fId);
      prev = fId;
    }
    g.connect(prev, bId);
  }

  // Cross-link nearby room nodes for WASD strafing
  const allNodes = [...g.nodes.values()];
  for (let i = 0; i < allNodes.length; i++) {
    for (let j = i + 1; j < allNodes.length; j++) {
      const n1 = allNodes[i], n2 = allNodes[j];
      const dM = Math.hypot(n1.x - n2.x, n1.y - n2.y) / PXM;
      if (dM >= 0.4 && dM <= 1.4) {
        g.connect(n1.id, n2.id);
      }
    }
  }

  return {
    graph: g,
    startNodeId: 'gallery_entrance',
    blurb: `The Obsidian Art Gallery — ${g.nodes.size} stations across a contemporary rotunda, floating cantilevered ramp, kinetic helix sculpture, and secure private vault.`,
  };
}
