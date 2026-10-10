/**
 * Panorama Maps — worlds/hotel-suite.js
 *
 * The Grand Hotel Suite — Indoor world:
 * A boutique hotel suite featuring:
 *   - Entryway and private hall
 *   - Main bedroom with king-size bed, nightstands, executive desk, and window view
 *   - Mezzanine stairs leading up to private balcony
 *   - Adjoining luxury marble bathroom with soaking tub and walk-in shower
 *
 * Dense indoor grid (step size ~1.0m to 1.5m) designed for smooth WASD exploration
 * inside a room, with floorplan mapping in 2D and indoor procedural 3D panorama rendering.
 */
import { MapScale } from '../core/scale.js';
import { WorldGraph } from '../core/world-graph.js';

export function buildHotelSuite() {
  const PXM = 4; // 4 pixels per meter
  const scale = new MapScale({
    pixelsPerMeter: PXM,
    movement: { stepPixels: 4, stepMinPixels: 3, stepMaxPixels: 6 },
  });

  const g = new WorldGraph(scale, { id: 'demo_hotel_suite', name: 'The Grand Hotel Suite' });

  g.environment = {
    kind: 'indoor',
    theme: 'hotel',
    timeOfDay: 'dusk',
    weather: 'clear',
    defaultHeading: 0,
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
      // Bath walls
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

  // Node definitions with coordinates in meters
  const nodes = [
    // Entryway
    { id: 'entry_door', x: 0, y: 0, name: 'Suite Entryway Door', head: 0, zone: 'zone_bedroom' },
    { id: 'entry_hall', x: 0, y: 1.5, name: 'Suite Entrance Hall', head: 0, zone: 'zone_bedroom' },
    { id: 'luggage_rack', x: 1.0, y: 0.8, name: 'Luggage Bench', head: 90, zone: 'zone_bedroom' },

    // Stairs to Mezzanine
    { id: 'stairs_foot', x: -2.0, y: 2.5, name: 'Stairs Foot — Step 1', head: 270, zone: 'zone_stairs' },
    { id: 'stairs_mid', x: -2.8, y: 4.0, name: 'Stairs Flight — Step 6', head: 0, zone: 'zone_stairs' },
    { id: 'stairs_landing', x: -3.5, y: 5.8, name: 'Mezzanine Upper Landing', head: 0, zone: 'zone_stairs' },
    { id: 'stairs_overlook', x: -2.2, y: 6.8, name: 'Balcony Overlook Railing', head: 90, zone: 'zone_stairs' },

    // Main Bedroom
    { id: 'bedroom_foyer', x: 0, y: 3.5, name: 'Bedroom Entrance Foyer', head: 45, zone: 'zone_bedroom' },
    { id: 'lounge_chair', x: 2.2, y: 2.6, name: 'Velvet Lounge Armchair', head: 45, zone: 'zone_bedroom' },
    { id: 'coffee_table', x: 3.4, y: 2.6, name: 'Marble Coffee Table', head: 0, zone: 'zone_bedroom' },

    { id: 'bed_approach', x: 2.0, y: 4.5, name: 'King Bed Approach', head: 90, zone: 'zone_bedroom' },
    { id: 'bed_foot', x: 3.6, y: 4.5, name: 'Foot of King Bed', head: 90, zone: 'zone_bedroom' },
    { id: 'bed_side_l', x: 5.2, y: 3.2, name: 'Nightstand Left & Reading Lamp', head: 0, zone: 'zone_bedroom' },
    { id: 'bed_side_r', x: 5.2, y: 5.8, name: 'Nightstand Right & Room Phone', head: 180, zone: 'zone_bedroom' },
    { id: 'bed_pillows', x: 6.0, y: 4.5, name: 'King Bed Pillows & Headboard', head: 270, zone: 'zone_bedroom' },

    { id: 'work_desk', x: 1.8, y: 6.5, name: 'Executive Work Desk', head: 0, zone: 'zone_bedroom' },
    { id: 'desk_chair', x: 2.8, y: 6.5, name: 'Workstation Chair', head: 0, zone: 'zone_bedroom' },
    { id: 'panoramic_window', x: 4.8, y: 7.5, name: 'Skyline Panoramic Window', head: 0, zone: 'zone_bedroom' },
    { id: 'window_lounge', x: 6.2, y: 7.2, name: 'Corner Window Daybed', head: 315, zone: 'zone_bedroom' },

    // Adjoining Room: En-suite Luxury Bathroom
    { id: 'bath_door', x: -1.2, y: -0.4, name: 'Bathroom Sliding Door', head: 270, zone: 'zone_bath' },
    { id: 'bath_foyer', x: -2.5, y: -1.0, name: 'Marble Bath Foyer', head: 225, zone: 'zone_bath' },
    { id: 'double_vanity', x: -3.8, y: -1.0, name: 'Double Vanity & Backlit Mirror', head: 0, zone: 'zone_bath' },
    { id: 'soaking_tub', x: -4.2, y: -2.8, name: 'Deep Oval Soaking Tub', head: 90, zone: 'zone_bath' },
    { id: 'walk_in_shower', x: -2.2, y: -3.0, name: 'Glass Walk-in Rain Shower', head: 180, zone: 'zone_bath' },
    { id: 'dressing_mirror', x: -1.2, y: -2.2, name: 'Dressing Area & Robes', head: 270, zone: 'zone_bath' },
  ];

  for (const n of nodes) {
    g.addNode({
      id: n.id,
      x: n.x * PXM,
      y: n.y * PXM,
      name: n.name,
      headingDeg: n.head,
      zoneId: n.zone,
      pano: { kind: 'generated' },
    });
  }

  // Connect adjacent walkable positions
  const links = [
    // Entryway
    ['entry_door', 'entry_hall'],
    ['entry_door', 'luggage_rack'],
    ['entry_hall', 'luggage_rack'],
    ['entry_hall', 'bedroom_foyer'],
    ['entry_hall', 'bath_door'],

    // Hall to Stairs & Bedroom
    ['bedroom_foyer', 'stairs_foot'],
    ['bedroom_foyer', 'bed_approach'],
    ['bedroom_foyer', 'lounge_chair'],
    ['bedroom_foyer', 'work_desk'],

    // Stairs path
    ['stairs_foot', 'stairs_mid'],
    ['stairs_mid', 'stairs_landing'],
    ['stairs_landing', 'stairs_overlook'],

    // Bedroom lounge & bed
    ['lounge_chair', 'coffee_table'],
    ['lounge_chair', 'bed_approach'],
    ['coffee_table', 'bed_foot'],
    ['bed_approach', 'bed_foot'],
    ['bed_foot', 'bed_side_l'],
    ['bed_foot', 'bed_side_r'],
    ['bed_foot', 'bed_pillows'],
    ['bed_side_l', 'bed_pillows'],
    ['bed_side_r', 'bed_pillows'],

    // Desk & Window
    ['bed_approach', 'work_desk'],
    ['work_desk', 'desk_chair'],
    ['desk_chair', 'panoramic_window'],
    ['bed_side_r', 'panoramic_window'],
    ['panoramic_window', 'window_lounge'],
    ['bed_pillows', 'window_lounge'],

    // Bathroom navigation
    ['bath_door', 'bath_foyer'],
    ['bath_foyer', 'double_vanity'],
    ['bath_foyer', 'dressing_mirror'],
    ['double_vanity', 'soaking_tub'],
    ['soaking_tub', 'walk_in_shower'],
    ['walk_in_shower', 'dressing_mirror'],
    ['bath_foyer', 'walk_in_shower'],
  ];

  for (const [a, b] of links) {
    g.connect(a, b);
  }

  return {
    graph: g,
    startNodeId: 'entry_door',
    blurb: 'The Grand Hotel Suite — luxury indoor boutique suite with king-size bed, mezzanine stairs, executive workstation, and an adjoining luxury marble bathroom. Complete with high-density WASD room navigation.',
  };
}
