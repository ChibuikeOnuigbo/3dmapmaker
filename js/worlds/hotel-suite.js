/**
 * Panorama Maps — worlds/hotel-suite.js
 *
 * The Grand Hotel Suite — Indoor world:
 * A luxury boutique hotel suite featuring:
 *   - Suite Entryway and private hall
 *   - Main Master Bedroom with king-size bed, nightstands, executive desk, and skyline window
 *   - Mezzanine Stairs leading up to private balcony overlook (step-by-step staircase)
 *   - Adjoining Luxury Marble Bathroom with deep soaking tub, double vanity, and glass shower
 *
 * Visual Continuity & OpenCV Feature Stability Model (Spec §27–§30, §60):
 *   - All furniture and architectural structures are anchored to fixed 3D coordinates (X, Y, Z).
 *   - Dense intermediate filler nodes (every ~0.5m) ensure smooth parallax and continuous
 *     perspective without object popping, mutation, or vanishing geometry.
 *   - Every node carries OpenCV-style camera extrinsics and feature tracking metadata:
 *     visible objects, depth ranges, epipolar baseline, and expected histogram similarity.
 */
import { MapScale } from '../core/scale.js';
import { WorldGraph, angleDelta } from '../core/world-graph.js';
import { expectedMinSimilarity } from '../gen/util.js';

export function buildHotelSuite() {
  const PXM = 4; // 4 pixels per meter
  const scale = new MapScale({
    pixelsPerMeter: PXM,
    movement: { stepPixels: 4, stepMinPixels: 2, stepMaxPixels: 6 },
  });

  const g = new WorldGraph(scale, { id: 'demo_hotel_suite', name: 'The Grand Hotel Suite' });

  // 3D Anchored World Objects (Immutable Physical Coordinates)
  const WORLD_OBJECTS = [
    { id: 'king_bed', name: 'King Bed & Duvet', x: 4.8, y: 4.5, z: 0.8, w: 2.2, d: 2.4, h: 1.1, zone: 'bedroom' },
    { id: 'headboard', name: 'Walnut Headboard', x: 6.4, y: 4.5, z: 1.3, w: 0.3, d: 2.6, h: 1.6, zone: 'bedroom' },
    { id: 'nightstand_l', name: 'Nightstand Left & Reading Lamp', x: 5.4, y: 3.1, z: 0.6, w: 0.7, d: 0.7, h: 0.75, zone: 'bedroom' },
    { id: 'nightstand_r', name: 'Nightstand Right & Telephone', x: 5.4, y: 5.9, z: 0.6, w: 0.7, d: 0.7, h: 0.75, zone: 'bedroom' },
    { id: 'work_desk', name: 'Executive Walnut Desk', x: 2.0, y: 7.2, z: 0.75, w: 1.8, d: 0.9, h: 0.85, zone: 'bedroom' },
    { id: 'desk_chair', name: 'Ergonomic Leather Chair', x: 2.8, y: 7.0, z: 0.6, w: 0.7, d: 0.7, h: 1.0, zone: 'bedroom' },
    { id: 'skyline_window', name: 'Floor-to-Ceiling Skyline Window', x: 5.0, y: 8.25, z: 1.5, w: 3.6, d: 0.2, h: 2.8, zone: 'bedroom' },
    { id: 'armchair', name: 'Velvet Lounge Armchair', x: 2.2, y: 2.6, z: 0.5, w: 1.1, d: 1.1, h: 0.9, zone: 'bedroom' },
    { id: 'coffee_table', name: 'Marble Coffee Table', x: 3.4, y: 2.6, z: 0.4, w: 0.9, d: 0.9, h: 0.45, zone: 'bedroom' },
    { id: 'mezzanine_stairs', name: 'Mezzanine Hardwood Stairs', x: -2.8, y: 4.0, z: 1.4, w: 1.8, d: 3.4, h: 2.8, zone: 'stairs' },
    { id: 'balcony_rail', name: 'Brushed Brass Balcony Railing', x: -2.2, y: 6.8, z: 2.9, w: 1.8, d: 0.2, h: 1.1, zone: 'stairs' },
    { id: 'soaking_tub', name: 'Freestanding Oval Soaking Tub', x: -4.2, y: -3.0, z: 0.6, w: 1.8, d: 1.0, h: 0.7, zone: 'bath' },
    { id: 'double_vanity', name: 'Italian Marble Double Vanity', x: -3.8, y: -0.8, z: 0.85, w: 2.2, d: 0.8, h: 0.9, zone: 'bath' },
    { id: 'walk_in_shower', name: 'Glass Walk-in Rain Shower', x: -2.2, y: -3.0, z: 1.4, w: 1.6, d: 1.6, h: 2.6, zone: 'bath' },
  ];

  g.environment = {
    kind: 'indoor',
    theme: 'hotel',
    timeOfDay: 'dusk',
    weather: 'clear',
    defaultHeading: 0,
    worldObjects: WORLD_OBJECTS,
    features: [
      // Floor regions
      { type: 'region', shape: 'rect', x: -1 * PXM, y: 1.5 * PXM, w: 8 * PXM, h: 6.8 * PXM, kind: 'carpet', color: '#d8cfc0', name: 'Bedroom Carpet' },
      { type: 'region', shape: 'rect', x: -5.5 * PXM, y: -4.2 * PXM, w: 4.8 * PXM, h: 4.5 * PXM, kind: 'marble', color: '#edf2f7', name: 'Marble Bath Floor' },
      { type: 'region', shape: 'rect', x: -4.5 * PXM, y: 1.5 * PXM, w: 3.2 * PXM, h: 5.8 * PXM, kind: 'wood', color: '#c4a686', name: 'Stairs Hardwood' },
      { type: 'region', shape: 'rect', x: -1 * PXM, y: -0.8 * PXM, w: 2.2 * PXM, h: 2.3 * PXM, kind: 'wood', color: '#c4a686', name: 'Entry Parquet' },

      // Perimeter & Room Partition Walls
      { type: 'wall', x1: -1 * PXM, y1: -0.8 * PXM, x2: -1 * PXM, y2: 1.5 * PXM },
      { type: 'wall', x1: 1.2 * PXM, y1: -0.8 * PXM, x2: 1.2 * PXM, y2: 1.5 * PXM },
      { type: 'wall', x1: 1.2 * PXM, y1: 1.5 * PXM, x2: 7 * PXM, y2: 1.5 * PXM },
      { type: 'wall', x1: 7 * PXM, y1: 1.5 * PXM, x2: 7 * PXM, y2: 8.3 * PXM },
      { type: 'wall', x1: 7 * PXM, y1: 8.3 * PXM, x2: -4.5 * PXM, y2: 8.3 * PXM },
      { type: 'wall', x1: -4.5 * PXM, y1: 8.3 * PXM, x2: -4.5 * PXM, y2: 1.5 * PXM },
      { type: 'wall', x1: -4.5 * PXM, y1: 1.5 * PXM, x2: -1 * PXM, y2: 1.5 * PXM },
      // Bathroom walls
      { type: 'wall', x1: -1 * PXM, y1: 0.2 * PXM, x2: -5.5 * PXM, y2: 0.2 * PXM },
      { type: 'wall', x1: -5.5 * PXM, y1: 0.2 * PXM, x2: -5.5 * PXM, y2: -4.2 * PXM },
      { type: 'wall', x1: -5.5 * PXM, y1: -4.2 * PXM, x2: -0.7 * PXM, y2: -4.2 * PXM },
      { type: 'wall', x1: -0.7 * PXM, y1: -4.2 * PXM, x2: -0.7 * PXM, y2: -0.8 * PXM },

      // Furniture pieces
      { type: 'furniture', kind: 'bed', x: 4.8 * PXM, y: 4.5 * PXM, w: 2.2 * PXM, d: 2.4 * PXM, name: 'King Bed' },
      { type: 'furniture', kind: 'stairs', x: -2.8 * PXM, y: 4.0 * PXM, w: 1.8 * PXM, d: 3.4 * PXM, name: 'Mezzanine Stairs' },
      { type: 'furniture', kind: 'desk', x: 2.0 * PXM, y: 7.2 * PXM, w: 1.8 * PXM, d: 0.9 * PXM, name: 'Executive Desk' },
      { type: 'furniture', kind: 'bath', x: -4.2 * PXM, y: -3.0 * PXM, w: 1.8 * PXM, d: 1.0 * PXM, name: 'Soaking Tub' },
      { type: 'furniture', kind: 'vanity', x: -3.8 * PXM, y: -0.8 * PXM, w: 2.2 * PXM, d: 0.8 * PXM, name: 'Double Vanity' },
      { type: 'furniture', kind: 'armchair', x: 2.2 * PXM, y: 2.6 * PXM, w: 1.1 * PXM, d: 1.1 * PXM, name: 'Lounge Armchair' },
      { type: 'furniture', kind: 'window', x: 5.0 * PXM, y: 8.2 * PXM, w: 3.2 * PXM, d: 0.3 * PXM, name: 'Skyline Window' },
    ],
    actors: [
      { id: 'room_bot', kind: 'cart', x0: 0, y0: 0, x1: 3.5, y1: 4.5, speedMps: 0.9, phase: 0, tint: '#7f8c8d', name: 'Room service robot' },
      { id: 'suite_cat', kind: 'cat', x0: 2.2, y0: 2.6, x1: 4.0, y1: 3.0, speedMps: 0.6, phase: 12, tint: '#d35400', name: 'Cozy suite cat' },
    ],
    zones: [
      { id: 'zone_bedroom', name: 'Master Bedroom', shape: 'rect', x: -1 * PXM, y: 1.5 * PXM, w: 8 * PXM, h: 6.8 * PXM, color: 'rgba(216, 207, 192, 0.2)' },
      { id: 'zone_stairs', name: 'Mezzanine Stairs', shape: 'rect', x: -4.5 * PXM, y: 1.5 * PXM, w: 3.2 * PXM, h: 5.8 * PXM, color: 'rgba(196, 166, 134, 0.2)' },
      { id: 'zone_bath', name: 'En-suite Luxury Bath', shape: 'rect', x: -5.5 * PXM, y: -4.2 * PXM, w: 4.8 * PXM, h: 4.5 * PXM, color: 'rgba(174, 201, 230, 0.2)' },
    ],
  };

  // Primary Station Landmarks (Key Functional Positions)
  const PRIMARY_STATIONS = [
    // Entryway
    { id: 'entry_door', x: 0, y: 0, name: 'Suite Entryway Door', head: 0, zone: 'zone_bedroom', desc: 'Standing at the heavy walnut suite door looking down the private entry corridor.' },
    { id: 'entry_hall', x: 0, y: 1.5, name: 'Suite Entrance Hall', head: 0, zone: 'zone_bedroom', desc: 'Private foyer corridor; luggage bench to the right, sliding bathroom door to the left.' },
    { id: 'luggage_rack', x: 1.0, y: 0.8, name: 'Luggage Bench', head: 90, zone: 'zone_bedroom', desc: 'Upholstered leather luggage bench beside the suite wardrobe.' },

    // Stairs to Mezzanine
    { id: 'stairs_foot', x: -2.0, y: 2.5, name: 'Stairs Foot — Step 1', head: 270, zone: 'zone_stairs', desc: 'Foot of the mezzanine hardwood staircase leading up toward the private upper balcony.' },
    { id: 'stairs_mid', x: -2.8, y: 4.0, name: 'Stairs Flight — Step 6', head: 0, zone: 'zone_stairs', desc: 'Halfway up the polished wooden stairs; elevated perspective of the master bedroom below.' },
    { id: 'stairs_landing', x: -3.5, y: 5.8, name: 'Mezzanine Upper Landing', head: 0, zone: 'zone_stairs', desc: 'Top landing of the mezzanine staircase under warm ceiling recessed lights.' },
    { id: 'stairs_overlook', x: -2.2, y: 6.8, name: 'Balcony Overlook Railing', head: 90, zone: 'zone_stairs', desc: 'Leaning on the brass balcony railing with a panoramic elevated view of the king bed and city window.' },

    // Main Bedroom
    { id: 'bedroom_foyer', x: 0, y: 3.5, name: 'Bedroom Entrance Foyer', head: 45, zone: 'zone_bedroom', desc: 'Opening into the spacious master bedroom suite; king bed visible ahead to the right.' },
    { id: 'lounge_chair', x: 2.2, y: 2.6, name: 'Velvet Lounge Armchair', head: 45, zone: 'zone_bedroom', desc: 'Plush velvet armchair positioned beside the marble coffee table.' },
    { id: 'coffee_table', x: 3.4, y: 2.6, name: 'Marble Coffee Table', head: 0, zone: 'zone_bedroom', desc: 'Low circular Italian marble coffee table with fresh flowers.' },

    { id: 'bed_approach', x: 2.0, y: 4.5, name: 'King Bed Approach', head: 90, zone: 'zone_bedroom', desc: 'Walkway between the lounge area and the foot of the king-size bed.' },
    { id: 'bed_foot', x: 3.6, y: 4.5, name: 'Foot of King Bed', head: 90, zone: 'zone_bedroom', desc: 'Standing directly at the foot of the neatly made king bed with white linen duvet.' },
    { id: 'bed_side_l', x: 5.2, y: 3.2, name: 'Nightstand Left & Reading Lamp', head: 0, zone: 'zone_bedroom', desc: 'Beside the left nightstand; warm ambient glow from the brass designer lamp.' },
    { id: 'bed_side_r', x: 5.2, y: 5.8, name: 'Nightstand Right & Room Phone', head: 180, zone: 'zone_bedroom', desc: 'Beside the right nightstand; touch controls for room lighting and suite climate.' },
    { id: 'bed_pillows', x: 6.0, y: 4.5, name: 'King Bed Pillows & Headboard', head: 270, zone: 'zone_bedroom', desc: 'Relaxing by the plush pillows against the tall fluted walnut headboard.' },

    { id: 'work_desk', x: 1.8, y: 6.5, name: 'Executive Work Desk', head: 0, zone: 'zone_bedroom', desc: 'Executive walnut writing desk with high-speed ports and warm desk lamp.' },
    { id: 'desk_chair', x: 2.8, y: 6.5, name: 'Workstation Chair', head: 0, zone: 'zone_bedroom', desc: 'Seated at the desk looking toward the floor-to-ceiling skyline window.' },
    { id: 'panoramic_window', x: 4.8, y: 7.5, name: 'Skyline Panoramic Window', head: 0, zone: 'zone_bedroom', desc: 'Standing at the vast glass window with dusk city lights stretching to the horizon.' },
    { id: 'window_lounge', x: 6.2, y: 7.2, name: 'Corner Window Daybed', head: 315, zone: 'zone_bedroom', desc: 'Corner cushioned daybed beside the glass with an expansive view of both the suite and city.' },

    // Adjoining Room: En-suite Luxury Bathroom
    { id: 'bath_door', x: -1.2, y: -0.4, name: 'Bathroom Sliding Door', head: 270, zone: 'zone_bath', desc: 'Threshold between the carpeted entryway and the cool white marble bathroom floor.' },
    { id: 'bath_foyer', x: -2.5, y: -1.0, name: 'Marble Bath Foyer', head: 225, zone: 'zone_bath', desc: 'Central marble foyer of the master bathroom; vanity to the right, deep tub ahead.' },
    { id: 'double_vanity', x: -3.8, y: -1.0, name: 'Double Vanity & Backlit Mirror', head: 0, zone: 'zone_bath', desc: 'Facing the twin vessel sinks and wide illuminated vanity mirror.' },
    { id: 'soaking_tub', x: -4.2, y: -2.8, name: 'Deep Oval Soaking Tub', head: 90, zone: 'zone_bath', desc: 'Beside the freestanding oval stone soaking tub with polished chrome fixtures.' },
    { id: 'walk_in_shower', x: -2.2, y: -3.0, name: 'Glass Walk-in Rain Shower', head: 180, zone: 'zone_bath', desc: 'Inside the frameless glass shower enclosure with ceiling rainfall showerhead.' },
    { id: 'dressing_mirror', x: -1.2, y: -2.2, name: 'Dressing Area & Robes', head: 270, zone: 'zone_bath', desc: 'Full-length dressing mirror and plush hotel bathrobes hung on cedar pegs.' },
  ];

  // Helper to compute OpenCV-style tracking features for a given camera point
  function computeCVFeatures(xM, yM, headDeg) {
    const visible = [];
    for (const obj of WORLD_OBJECTS) {
      const dx = obj.x - xM, dy = obj.y - yM;
      const dist = Math.hypot(dx, dy);
      if (dist < 12) {
        const bearing = (((Math.atan2(dx, dy) * 180 / Math.PI) % 360) + 360) % 360;
        const delta = Math.abs(angleDelta(headDeg, bearing));
        // objects within 140° forward/peripheral cone or close proximity
        if (delta < 120 || dist < 2.5) {
          visible.push({
            id: obj.id,
            name: obj.name,
            distM: Math.round(dist * 100) / 100,
            bearingDeg: Math.round(bearing),
            relativeAngle: Math.round(delta),
          });
        }
      }
    }
    visible.sort((a, b) => a.distM - b.distM);
    return visible;
  }

  // Register primary stations
  const nodeMap = new Map();
  for (const p of PRIMARY_STATIONS) {
    const cvFeats = computeCVFeatures(p.x, p.y, p.head);
    const n = g.addNode({
      id: p.id,
      x: p.x * PXM,
      y: p.y * PXM,
      name: p.name,
      headingDeg: p.head,
      zoneId: p.zone,
      pano: { kind: 'generated' },
    });
    n.cv = {
      description: p.desc,
      cameraPose: { x: p.x, y: p.y, z: p.id.startsWith('stairs_landing') || p.id.startsWith('stairs_overlook') ? 3.0 : 1.7, yaw: p.head },
      visibleObjects: cvFeats.map(f => f.id),
      visibleDetails: cvFeats,
      homographyStability: 0.96,
      depthRangeM: [0.5, Math.max(2.0, cvFeats[cvFeats.length - 1]?.distM || 5.0)],
    };
    nodeMap.set(p.id, n);
  }

  // Core Walkway Segments for Intermediate Filler Generation
  const WALKWAY_CORRIDORS = [
    // Entry to Hall & Bedroom
    { from: 'entry_door', to: 'entry_hall', steps: 2 },
    { from: 'entry_hall', to: 'luggage_rack', steps: 1 },
    { from: 'entry_hall', to: 'bedroom_foyer', steps: 3 },
    { from: 'entry_hall', to: 'bath_door', steps: 2 },

    // Stairs step-by-step flight
    { from: 'bedroom_foyer', to: 'stairs_foot', steps: 2 },
    { from: 'stairs_foot', to: 'stairs_mid', steps: 3 },
    { from: 'stairs_mid', to: 'stairs_landing', steps: 3 },
    { from: 'stairs_landing', to: 'stairs_overlook', steps: 2 },

    // Bedroom Floor Navigation
    { from: 'bedroom_foyer', to: 'lounge_chair', steps: 2 },
    { from: 'lounge_chair', to: 'coffee_table', steps: 1 },
    { from: 'bedroom_foyer', to: 'bed_approach', steps: 2 },
    { from: 'bed_approach', to: 'bed_foot', steps: 2 },
    { from: 'bed_foot', to: 'bed_side_l', steps: 2 },
    { from: 'bed_foot', to: 'bed_side_r', steps: 2 },
    { from: 'bed_side_l', to: 'bed_pillows', steps: 2 },
    { from: 'bed_side_r', to: 'bed_pillows', steps: 2 },

    // Desk & Skyline Window Walkways
    { from: 'bed_approach', to: 'work_desk', steps: 3 },
    { from: 'work_desk', to: 'desk_chair', steps: 1 },
    { from: 'desk_chair', to: 'panoramic_window', steps: 2 },
    { from: 'bed_side_r', to: 'panoramic_window', steps: 2 },
    { from: 'panoramic_window', to: 'window_lounge', steps: 2 },
    { from: 'bed_pillows', to: 'window_lounge', steps: 2 },

    // Adjoining Bathroom Walkways
    { from: 'bath_door', to: 'bath_foyer', steps: 2 },
    { from: 'bath_foyer', to: 'double_vanity', steps: 2 },
    { from: 'bath_foyer', to: 'dressing_mirror', steps: 2 },
    { from: 'double_vanity', to: 'soaking_tub', steps: 2 },
    { from: 'soaking_tub', to: 'walk_in_shower', steps: 2 },
    { from: 'walk_in_shower', to: 'dressing_mirror', steps: 2 },
    { from: 'bath_foyer', to: 'walk_in_shower', steps: 2 },
  ];

  // Generate intermediate filler nodes along every corridor
  for (const corr of WALKWAY_CORRIDORS) {
    const nA = g.getNode(corr.from);
    const nB = g.getNode(corr.to);
    if (!nA || !nB) continue;

    const xA = nA.x / PXM, yA = nA.y / PXM;
    const xB = nB.x / PXM, yB = nB.y / PXM;
    const hA = nA.headingDeg ?? 0, hB = nB.headingDeg ?? 0;
    const distTotal = Math.hypot(xB - xA, yB - yA);
    const steps = corr.steps || Math.max(1, Math.round(distTotal / 0.7));

    let prevId = corr.from;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const xInterp = xA + (xB - xA) * t;
      const yInterp = yA + (yB - yA) * t;

      // Angular shortest-path slerp
      const dHead = angleDelta(hA, hB);
      const headInterp = (((hA + dHead * t) % 360) + 360) % 360;

      const fillerId = `${corr.from}_to_${corr.to}_step${s}`;
      const cvFeats = computeCVFeatures(xInterp, yInterp, headInterp);
      const stepDistM = distTotal / steps;

      const fillerNode = g.addNode({
        id: fillerId,
        x: xInterp * PXM,
        y: yInterp * PXM,
        name: `${nA.name} ➔ ${nB.name} (${Math.round(t * 100)}%)`,
        headingDeg: Math.round(headInterp),
        zoneId: nA.zoneId,
        pano: { kind: 'generated' },
      });

      fillerNode.cv = {
        description: `Continuous walkway frame at ${xInterp.toFixed(2)}m, ${yInterp.toFixed(2)}m. ${nA.name} behind (${(t * distTotal).toFixed(1)}m), ${nB.name} ahead (${((1 - t) * distTotal).toFixed(1)}m).`,
        cameraPose: { x: xInterp, y: yInterp, z: 1.7, yaw: Math.round(headInterp) },
        visibleObjects: cvFeats.map(f => f.id),
        visibleDetails: cvFeats,
        stepDistM: Math.round(stepDistM * 100) / 100,
        expectedMinSimilarity: expectedMinSimilarity(stepDistM),
        homographyStability: 0.98,
        depthRangeM: [0.5, Math.max(2.0, cvFeats[cvFeats.length - 1]?.distM || 4.5)],
      };

      g.connect(prevId, fillerId);
      prevId = fillerId;
    }
    g.connect(prevId, corr.to);
  }

  // Cross-link nearby walkway nodes for multi-directional WASD strafing
  const allNodes = [...g.nodes.values()];
  for (let i = 0; i < allNodes.length; i++) {
    for (let j = i + 1; j < allNodes.length; j++) {
      const n1 = allNodes[i], n2 = allNodes[j];
      const dM = Math.hypot(n1.x - n2.x, n1.y - n2.y) / PXM;
      // Connect nearby nodes within comfortable room stride (0.35m to 1.15m) that aren't across walls
      if (dM >= 0.35 && dM <= 1.15) {
        // Avoid connecting across the bath/bedroom partition wall
        const acrossWall = (n1.x < -0.8 * PXM && n2.x > -0.5 * PXM) || (n1.y < 0.5 * PXM && n2.y > 1.8 * PXM && n1.x < 0);
        if (!acrossWall) {
          g.connect(n1.id, n2.id);
        }
      }
    }
  }

  return {
    graph: g,
    startNodeId: 'entry_door',
    blurb: `The Grand Hotel Suite — ${g.nodes.size} continuous indoor stations spanning the private foyer, mezzanine stairs, master bedroom with king-size bed, executive workstation, and adjoining luxury marble bath. Formatted with OpenCV object anchoring and dense WASD room navigation.`,
  };
}
