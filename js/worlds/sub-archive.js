/**
 * Panorama Maps — worlds/sub-archive.js
 *
 * Subterranean Bio-Archive — Indoor World 3:
 * A deep underground scientific research and genetic preservation bunker:
 *   - Pressurized Airlock Entry Vestibule
 *   - Central Cryogenic Specimen Silo with chilled fog
 *   - Quantum Data Stack Array & Server Corridors
 *   - Elevated Mezzanine Catwalk Bridge
 *   - Cleanroom Decontamination Chamber
 *
 * Dense metric grid with OpenCV 3D object anchoring and continuous WASD room navigation.
 */
import { MapScale } from '../core/scale.js';
import { WorldGraph, angleDelta } from '../core/world-graph.js';

export function buildSubArchive() {
  const PXM = 4; // 4 pixels per meter
  const scale = new MapScale({
    pixelsPerMeter: PXM,
    movement: { stepPixels: 4, stepMinPixels: 2, stepMaxPixels: 6 },
  });

  const g = new WorldGraph(scale, { id: 'demo_sub_archive', name: 'Subterranean Bio-Archive' });

  // 3D Physical World Anchors
  const WORLD_OBJECTS = [
    { id: 'cryo_silo', name: 'Cryogenic Specimen Silo', x: 0, y: 0, z: 2.5, w: 3.6, d: 3.6, h: 5.5, zone: 'cryo' },
    { id: 'server_stack_l', name: 'Quantum Data Bank Alpha', x: -4.5, y: -3.5, z: 1.8, w: 1.4, d: 4.0, h: 3.6, zone: 'servers' },
    { id: 'server_stack_r', name: 'Quantum Data Bank Beta', x: -4.5, y: 3.5, z: 1.8, w: 1.4, d: 4.0, h: 3.6, zone: 'servers' },
    { id: 'catwalk_bridge', name: 'Steel Catwalk Bridge', x: 3.8, y: 0, z: 2.8, w: 1.8, d: 6.5, h: 2.8, zone: 'catwalk' },
    { id: 'airlock_door', name: 'Hydraulic Pressure Airlock', x: 0, y: -7.0, z: 1.4, w: 2.4, d: 0.5, h: 2.6, zone: 'airlock' },
    { id: 'decon_shower', name: 'UV Decontamination Portal', x: 0, y: 7.0, z: 1.4, w: 2.0, d: 1.8, h: 2.8, zone: 'decon' },
  ];

  g.environment = {
    kind: 'indoor',
    theme: 'lab',
    timeOfDay: 'night',
    weather: 'clear',
    defaultHeading: 0,
    worldObjects: WORLD_OBJECTS,
    features: [
      // Perforated industrial deck with warning chevrons
      { type: 'region', shape: 'rect', x: -7 * PXM, y: -8 * PXM, w: 14 * PXM, h: 16 * PXM, kind: 'stone', color: '#1c2229', name: 'Bio-Deck' },
      // Perimeter blast bulkheads
      { type: 'wall', x1: -6.5 * PXM, y1: -7.5 * PXM, x2: 6.5 * PXM, y2: -7.5 * PXM },
      { type: 'wall', x1: 6.5 * PXM, y1: -7.5 * PXM, x2: 6.5 * PXM, y2: 7.5 * PXM },
      { type: 'wall', x1: 6.5 * PXM, y1: 7.5 * PXM, x2: -6.5 * PXM, y2: 7.5 * PXM },
      { type: 'wall', x1: -6.5 * PXM, y1: 7.5 * PXM, x2: -6.5 * PXM, y2: -7.5 * PXM },
    ],
  };

  g.zones.add({ id: 'zone_airlock', name: 'Airlock Vestibule', bounds: [-5 * PXM, -8 * PXM, 5 * PXM, -5 * PXM] });
  g.zones.add({ id: 'zone_cryo', name: 'Cryogenic Containment Core', bounds: [-3 * PXM, -5 * PXM, 3 * PXM, 5 * PXM] });
  g.zones.add({ id: 'zone_servers', name: 'Quantum Data Bank Corridor', bounds: [-6.5 * PXM, -5 * PXM, -3 * PXM, 5 * PXM] });
  g.zones.add({ id: 'zone_catwalk', name: 'High Catwalk Observation', bounds: [3 * PXM, -5 * PXM, 6.5 * PXM, 5 * PXM] });
  g.zones.add({ id: 'zone_decon', name: 'Decontamination Chamber', bounds: [-5 * PXM, 5 * PXM, 5 * PXM, 8 * PXM] });

  g.addLandmark({ id: 'lm_silo', type: 'sculpture', name: 'Cryo-Silo', x: 0, y: 0, importance: 1.0 });
  g.addLandmark({ id: 'lm_servers', type: 'interior', name: 'Data Banks', x: -4 * PXM, y: 0, importance: 0.8 });
  g.addLandmark({ id: 'lm_decon', type: 'transit', name: 'Decon Chamber', x: 0, y: 6.5 * PXM, importance: 0.9 });

  const STATIONS = [
    // Airlock
    { id: 'airlock_outer', x: 0, y: -6.8, head: 0, zone: 'zone_airlock', name: 'Outer Hydraulic Airlock' },
    { id: 'airlock_chamber', x: 0, y: -5.5, head: 0, zone: 'zone_airlock', name: 'Pressurization Staging' },

    // Cryo Containment
    { id: 'cryo_approach', x: 0, y: -3.0, head: 0, zone: 'zone_cryo', name: 'Cryo Core North Gate' },
    { id: 'cryo_west', x: -1.8, y: 0, head: 90, zone: 'zone_cryo', name: 'Specimen Column West' },
    { id: 'cryo_east', x: 1.8, y: 0, head: 270, zone: 'zone_cryo', name: 'Specimen Column East' },
    { id: 'cryo_south', x: 0, y: 3.0, head: 180, zone: 'zone_cryo', name: 'Cryo Core South Gate' },

    // Quantum Server Corridor
    { id: 'server_north', x: -4.5, y: -2.5, head: 0, zone: 'zone_servers', name: 'Data Stack A1 Terminal' },
    { id: 'server_mid', x: -4.5, y: 0, head: 90, zone: 'zone_servers', name: 'Mainframe Console' },
    { id: 'server_south', x: -4.5, y: 2.5, head: 180, zone: 'zone_servers', name: 'Data Stack B2 Terminal' },

    // Catwalk Bridge
    { id: 'catwalk_stairs', x: 3.5, y: -3.0, head: 180, zone: 'zone_catwalk', name: 'Catwalk Access Stairs' },
    { id: 'catwalk_mid', x: 4.2, y: 0, head: 270, zone: 'zone_catwalk', name: 'Observation Catwalk' },
    { id: 'catwalk_south', x: 3.5, y: 3.0, head: 180, zone: 'zone_catwalk', name: 'Catwalk Descent' },

    // Decontamination
    { id: 'decon_threshold', x: 0, y: 5.2, head: 0, zone: 'zone_decon', name: 'Decon Air Shower Threshold' },
    { id: 'cleanroom_portal', x: 0, y: 6.8, head: 0, zone: 'zone_decon', name: 'Cleanroom Quarantine Portal' },
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
      cameraPose: { x: s.x, y: s.y, z: s.id.startsWith('catwalk') ? 2.8 : 1.7, yaw: s.head },
      description: `Subterranean Bio-Archive station at ${s.x}m, ${s.y}m in cryogenic research zone.`,
    };
  }

  const CORRIDORS = [
    ['airlock_outer', 'airlock_chamber', 2],
    ['airlock_chamber', 'cryo_approach', 2],
    ['cryo_approach', 'cryo_west', 2],
    ['cryo_approach', 'cryo_east', 2],
    ['cryo_west', 'server_north', 2],
    ['server_north', 'server_mid', 2],
    ['server_mid', 'server_south', 2],
    ['server_south', 'cryo_south', 2],
    ['cryo_east', 'catwalk_stairs', 2],
    ['catwalk_stairs', 'catwalk_mid', 2],
    ['catwalk_mid', 'catwalk_south', 2],
    ['catwalk_south', 'cryo_south', 2],
    ['cryo_south', 'decon_threshold', 2],
    ['decon_threshold', 'cleanroom_portal', 2],
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
    startNodeId: 'airlock_outer',
    blurb: `Subterranean Bio-Archive — ${g.nodes.size} stations inside a deep scientific bunker with cryogenic containment, server arrays, high catwalks, and airlock decontamination.`,
  };
}
