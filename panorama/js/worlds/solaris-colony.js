/**
 * Panorama Maps — worlds/solaris-colony.js
 *
 * Solaris Orbital Colony — Outdoor Futuristic World 2:
 * An extraterrestrial geodesic biodome situated on an orbital habitat ring:
 *   - Geodesic Crystalline Atmosphere Canopy
 *   - Central Quantum Solar Harvester & Light Well
 *   - Terraformed Luminescent Botanical Promenade
 *   - Pressurized Airway Ring & Planetary Horizon Overlook
 *
 * Dense metric grid with OpenCV 3D object anchoring and continuous WASD traversal.
 */
import { MapScale } from '../core/scale.js';
import { WorldGraph, angleDelta } from '../core/world-graph.js';

export function buildSolarisColony() {
  const PXM = 2; // 2 pixels per meter
  const scale = new MapScale({
    pixelsPerMeter: PXM,
    movement: { stepPixels: 6, stepMinPixels: 4, stepMaxPixels: 12 },
  });

  const g = new WorldGraph(scale, { id: 'demo_solaris_colony', name: 'Solaris Orbital Colony' });

  // 3D Physical World Anchors
  const WORLD_OBJECTS = [
    { id: 'solar_harvester', name: 'Quantum Solar Harvester Core', x: 0, y: 0, z: 25.0, w: 10, d: 10, h: 50, zone: 'core' },
    { id: 'biodome_lattice', name: 'Geodesic Crystal Canopy Peak', x: 0, y: 0, z: 65.0, w: 120, d: 120, h: 4, zone: 'dome' },
    { id: 'biolum_grove', name: 'Bioluminescent Fern Grove', x: -18, y: -15, z: 1.2, w: 14, d: 14, h: 4.5, zone: 'gardens' },
    { id: 'hydroponic_tier', name: 'Terraced Hydroponic Cascades', x: 20, y: -15, z: 2.0, w: 16, d: 12, h: 6.0, zone: 'gardens' },
    { id: 'ring_terrace_rail', name: 'Orbital Ring Overlook Parapet', x: 0, y: 32, z: 1.4, w: 28, d: 1, h: 1.3, zone: 'overlook' },
  ];

  g.environment = {
    kind: 'outdoor',
    theme: 'orbital',
    timeOfDay: 'golden',
    weather: 'clear',
    defaultHeading: 0,
    worldObjects: WORLD_OBJECTS,
    features: [
      // Circular biodome plaza terrace
      { type: 'region', shape: 'circle', cx: 0, cy: 0, radiusPx: 38 * PXM, kind: 'stone', color: '#2a3342', name: 'Biodome Deck' },
      { type: 'region', shape: 'rect', x: -16 * PXM, y: -20 * PXM, w: 32 * PXM, h: 10 * PXM, kind: 'grass', color: '#104e3d', name: 'Bioluminescent Grove' },
      // Parapet boundary
      { type: 'wall', x1: -28 * PXM, y1: 34 * PXM, x2: 28 * PXM, y2: 34 * PXM },
    ],
    actors: [
      { id: 'sc_solar_drone', kind: 'walker', x0: -15, y0: 0, x1: 15, y1: 0, speedMps: 2.8, phase: 0, tint: '#f39c12', name: 'Atmosphere Inspection Drone' },
      { id: 'sc_botanist', kind: 'walker', x0: -12, y0: -14, x1: -4, y1: -14, speedMps: 1.3, phase: 10, tint: '#2ecc71', name: 'Colony Botanist' },
    ],
  };

  g.zones.add({ id: 'zone_gardens', name: 'Terraformed Botanical Terraces', bounds: [-35 * PXM, -35 * PXM, 35 * PXM, -8 * PXM] });
  g.zones.add({ id: 'zone_core', name: 'Solar Harvester Atrium', bounds: [-35 * PXM, -8 * PXM, 35 * PXM, 15 * PXM] });
  g.zones.add({ id: 'zone_overlook', name: 'Orbital Planetary Ring Terrace', bounds: [-35 * PXM, 15 * PXM, 35 * PXM, 40 * PXM] });

  g.addLandmark({ id: 'lm_core', type: 'tower', name: 'Solar Core', x: 0, y: 0, importance: 1.0 });
  g.addLandmark({ id: 'lm_gardens', type: 'park', name: 'Luminescent Grove', x: -16 * PXM, y: -16 * PXM, importance: 0.8 });
  g.addLandmark({ id: 'lm_rings', type: 'water', name: 'Planetary Rings Overlook', x: 0, y: 32 * PXM, importance: 0.9 });

  const STATIONS = [
    // Botanical Terraces
    { id: 'garden_north', x: 0, y: -24, head: 180, zone: 'zone_gardens', name: 'North Flora Gateway' },
    { id: 'grove_west', x: -14, y: -16, head: 90, zone: 'zone_gardens', name: 'Luminescent Fern Path' },
    { id: 'cascade_east', x: 14, y: -16, head: 270, zone: 'zone_gardens', name: 'Hydroponic Waterwall' },

    // Core Solar Atrium
    { id: 'atrium_nw', x: -8, y: -6, head: 135, zone: 'zone_core', name: 'Atrium Promenade NW' },
    { id: 'atrium_ne', x: 8, y: -6, head: 225, zone: 'zone_core', name: 'Atrium Promenade NE' },
    { id: 'solar_center', x: 0, y: 0, head: 180, zone: 'zone_core', name: 'Solar Harvester Light Well' },
    { id: 'atrium_sw', x: -8, y: 8, head: 45, zone: 'zone_core', name: 'Atrium Promenade SW' },
    { id: 'atrium_se', x: 8, y: 8, head: 315, zone: 'zone_core', name: 'Atrium Promenade SE' },

    // Planetary Ring Terrace
    { id: 'terrace_approach', x: 0, y: 18, head: 180, zone: 'zone_overlook', name: 'Ring Observation Approach' },
    { id: 'terrace_mid', x: 0, y: 26, head: 180, zone: 'zone_overlook', name: 'Geodesic Perimeter Walk' },
    { id: 'ring_lookout_w', x: -14, y: 32, head: 180, zone: 'zone_overlook', name: 'West Ring Horizon Point' },
    { id: 'ring_lookout_c', x: 0, y: 32, head: 180, zone: 'zone_overlook', name: 'Great Planetary Rings Overlook' },
    { id: 'ring_lookout_e', x: 14, y: 32, head: 180, zone: 'zone_overlook', name: 'East Solar Horizon Point' },
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
      cameraPose: { x: s.x, y: s.y, z: 1.7, yaw: s.head },
      description: `Solaris Orbital Colony station at ${s.x}m, ${s.y}m inside geodesic canopy.`,
    };
  }

  const CORRIDORS = [
    ['garden_north', 'grove_west', 2],
    ['garden_north', 'cascade_east', 2],
    ['grove_west', 'atrium_nw', 2],
    ['cascade_east', 'atrium_ne', 2],
    ['atrium_nw', 'solar_center', 2],
    ['atrium_ne', 'solar_center', 2],
    ['solar_center', 'atrium_sw', 2],
    ['solar_center', 'atrium_se', 2],
    ['solar_center', 'terrace_approach', 2],
    ['terrace_approach', 'terrace_mid', 2],
    ['terrace_mid', 'ring_lookout_c', 2],
    ['ring_lookout_c', 'ring_lookout_w', 2],
    ['ring_lookout_c', 'ring_lookout_e', 2],
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

  // Cross-link adjacent walkway nodes for WASD strafing
  const allNodes = [...g.nodes.values()];
  for (let i = 0; i < allNodes.length; i++) {
    for (let j = i + 1; j < allNodes.length; j++) {
      const n1 = allNodes[i], n2 = allNodes[j];
      const dM = Math.hypot(n1.x - n2.x, n1.y - n2.y) / PXM;
      if (dM >= 1.5 && dM <= 6.0) {
        g.connect(n1.id, n2.id);
      }
    }
  }

  return {
    graph: g,
    startNodeId: 'solar_center',
    blurb: `Solaris Orbital Colony — ${g.nodes.size} stations under a geodesic crystal biodome featuring a solar harvester spire, luminescent flora, and planetary ring vistas.`,
  };
}
