/**
 * Panorama Maps — worlds/neo-kyoto.js
 *
 * Neo-Kyoto Skyway — Outdoor Futuristic World 1:
 * An elevated futuristic pedestrian transit concourse set high above the city:
 *   - Suspended Mag-Lev Skybridge transit platform
 *   - Central Neon Concourse with holographic billboards & street kiosks
 *   - Observation Overlook peering over towering architectural spires
 *   - Cybernetic Ramen Bar & automated transit interchange
 *
 * Dense metric grid with OpenCV 3D object anchoring and continuous WASD traversal.
 */
import { MapScale } from '../core/scale.js';
import { WorldGraph, angleDelta } from '../core/world-graph.js';
import { expectedMinSimilarity } from '../gen/util.js';

export function buildNeoKyoto() {
  const PXM = 2; // 2 pixels per meter
  const scale = new MapScale({
    pixelsPerMeter: PXM,
    movement: { stepPixels: 6, stepMinPixels: 4, stepMaxPixels: 12 },
  });

  const g = new WorldGraph(scale, { id: 'demo_neo_kyoto', name: 'Neo-Kyoto Skyway' });

  // 3D Physical World Anchors
  const WORLD_OBJECTS = [
    { id: 'maglev_terminal', name: 'Mag-Lev Express Terminal', x: 0, y: -25, z: 2.0, w: 12, d: 24, h: 8, zone: 'transit' },
    { id: 'holo_billboard', name: 'Volumetric Holographic Billboard', x: 20, y: 0, z: 10.0, w: 16, d: 2, h: 14, zone: 'plaza' },
    { id: 'ramen_kiosk', name: 'Cyber-Ramen Noodle Pavilion', x: -14, y: 15, z: 1.5, w: 6, d: 5, h: 3.5, zone: 'market' },
    { id: 'overlook_rail', name: 'Acoustic Glass Canyon Overlook', x: 0, y: 35, z: 1.2, w: 22, d: 1, h: 1.4, zone: 'overlook' },
    { id: 'spire_tower_alpha', name: 'Neo-Kyoto Spire Alpha', x: 45, y: 40, z: 80.0, w: 18, d: 18, h: 220, zone: 'canyon' },
    { id: 'spire_tower_beta', name: 'Shin-Tora Quantum Spire', x: -50, y: 30, z: 90.0, w: 22, d: 22, h: 260, zone: 'canyon' },
  ];

  g.environment = {
    kind: 'outdoor',
    theme: 'cyberpunk',
    timeOfDay: 'dusk',
    weather: 'rain',
    defaultHeading: 0,
    worldObjects: WORLD_OBJECTS,
    features: [
      // Polished metal deck & permeable safety floor
      { type: 'region', shape: 'rect', x: -25 * PXM, y: -35 * PXM, w: 50 * PXM, h: 75 * PXM, kind: 'stone', color: '#1a1f2c', name: 'Skyway Deck' },
      // Acoustic glass windbreak parapets
      { type: 'wall', x1: -22 * PXM, y1: -32 * PXM, x2: -22 * PXM, y2: 36 * PXM },
      { type: 'wall', x1: 22 * PXM, y1: -32 * PXM, x2: 22 * PXM, y2: 36 * PXM },
      { type: 'wall', x1: -22 * PXM, y1: 36 * PXM, x2: 22 * PXM, y2: 36 * PXM },
    ],
    actors: [
      { id: 'nk_maglev_train', kind: 'tram', x0: -6, y0: -40, x1: -6, y1: 40, speedMps: 18.0, phase: 0, tint: '#00e5ff', name: 'Skyway MagLev Express' },
      { id: 'nk_drone_courier', kind: 'walker', x0: 12, y0: -20, x1: 12, y1: 30, speedMps: 3.5, phase: 5, tint: '#ff007f', name: 'Cyber-Drone Courier' },
      { id: 'nk_commuter', kind: 'walker', x0: -4, y0: 10, x1: 8, y1: 10, speedMps: 1.4, phase: 2, tint: '#a0aab8', name: 'Pedestrian Commuter' },
    ],
  };

  g.zones.add({ id: 'zone_transit', name: 'Mag-Lev Transit Hub', bounds: [-20 * PXM, -35 * PXM, 20 * PXM, -10 * PXM] });
  g.zones.add({ id: 'zone_plaza', name: 'Central Neon Concourse', bounds: [-20 * PXM, -10 * PXM, 20 * PXM, 15 * PXM] });
  g.zones.add({ id: 'zone_overlook', name: 'Skyline Overlook Plaza', bounds: [-20 * PXM, 15 * PXM, 20 * PXM, 38 * PXM] });

  g.addLandmark({ id: 'lm_maglev', type: 'transit', name: 'Mag-Lev Platform', x: 0, y: -25 * PXM, importance: 0.9 });
  g.addLandmark({ id: 'lm_holo', type: 'tower', name: 'Holographic Array', x: 18 * PXM, y: 0, importance: 0.8 });
  g.addLandmark({ id: 'lm_overlook', type: 'park', name: 'Skyline Overlook', x: 0, y: 34 * PXM, importance: 1.0 });

  // Stations definitions
  const STATIONS = [
    // Mag-Lev Terminal
    { id: 'maglev_gate_n', x: 0, y: -30, head: 180, zone: 'zone_transit', name: 'Mag-Lev Gate North' },
    { id: 'maglev_platform', x: 0, y: -24, head: 180, zone: 'zone_transit', name: 'Mag-Lev High Platform' },
    { id: 'turnstiles', x: 0, y: -16, head: 180, zone: 'zone_transit', name: 'Security Turnstiles' },

    // Central Concourse
    { id: 'plaza_north', x: 0, y: -8, head: 180, zone: 'zone_plaza', name: 'Concourse North Entrance' },
    { id: 'holo_west', x: -8, y: 0, head: 90, zone: 'zone_plaza', name: 'Holo-Plaza West' },
    { id: 'concourse_center', x: 0, y: 0, head: 180, zone: 'zone_plaza', name: 'Concourse Center Core' },
    { id: 'holo_east', x: 8, y: 0, head: 270, zone: 'zone_plaza', name: 'Holo-Array East Bench' },
    { id: 'ramen_walkway', x: -10, y: 12, head: 180, zone: 'zone_plaza', name: 'Ramen Street Walkway' },
    { id: 'kiosk_front', x: -14, y: 14, head: 90, zone: 'zone_plaza', name: 'Ramen Counter Stalls' },

    // Overlook Plaza
    { id: 'overlook_approach', x: 0, y: 18, head: 180, zone: 'zone_overlook', name: 'Skyline Plaza Approach' },
    { id: 'overlook_mid', x: 0, y: 26, head: 180, zone: 'zone_overlook', name: 'Acoustic Overlook Mid' },
    { id: 'overlook_edge_w', x: -10, y: 34, head: 180, zone: 'zone_overlook', name: 'West Tower Overlook' },
    { id: 'overlook_edge_c', x: 0, y: 34, head: 180, zone: 'zone_overlook', name: 'Grand Skyline Overlook Rail' },
    { id: 'overlook_edge_e', x: 10, y: 34, head: 180, zone: 'zone_overlook', name: 'East Spire Overlook' },
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
      description: `Neo-Kyoto Skyway station at ${s.x}m, ${s.y}m overlooking cybernetic concourse.`,
    };
  }

  // Intermediate Corridors & Filler Connections
  const CORRIDORS = [
    ['maglev_gate_n', 'maglev_platform', 2],
    ['maglev_platform', 'turnstiles', 2],
    ['turnstiles', 'plaza_north', 2],
    ['plaza_north', 'concourse_center', 2],
    ['concourse_center', 'holo_west', 2],
    ['concourse_center', 'holo_east', 2],
    ['concourse_center', 'ramen_walkway', 3],
    ['ramen_walkway', 'kiosk_front', 1],
    ['concourse_center', 'overlook_approach', 3],
    ['overlook_approach', 'overlook_mid', 2],
    ['overlook_mid', 'overlook_edge_c', 2],
    ['overlook_edge_c', 'overlook_edge_w', 2],
    ['overlook_edge_c', 'overlook_edge_e', 2],
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
      if (dM >= 1.5 && dM <= 5.5) {
        g.connect(n1.id, n2.id);
      }
    }
  }

  return {
    graph: g,
    startNodeId: 'concourse_center',
    blurb: `Neo-Kyoto Skyway — ${g.nodes.size} stations along a rain-slicked futuristic transit concourse with holographic billboards, Mag-Lev terminal, and megacity canyon overlooks.`,
  };
}
