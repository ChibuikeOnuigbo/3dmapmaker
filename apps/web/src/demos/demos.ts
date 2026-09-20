/**
 * apps/web — the demo worlds (REQUIREMENT 137).
 *
 * Every demo is a real project document built from the same schema the editor
 * writes. Nothing is a screenshot or a baked scene. There are six, not the five
 * the brief asked for — this list used to omit the sixth, which is why the
 * landing page claimed "five" while shipping six:
 *
 *   1. Harbour City        — buildings, roads, water, vegetation, markers
 *   2. Ridgeline Traverse  — topographic: steep procedural terrain, contours, hillshade
 *   3. Linked Panoramas    — a connected panorama graph with real neighbour edges
 *   4. Object Studio       — imported-style primitives, instancing, gizmo work
 *   5. Road to Church      — the panorama walk: 64 linked squares, goal at sq_64
 *   6. Open Tile World     — large footprint that must stream tiles, not one mesh
 *
 * All assets are procedural/synthetic (REQUIREMENT 138).
 */
import { newProject, newId, type ObjectNode, type Project } from '@3dmm/project';

export interface DemoDefinition {
  id: string;
  name: string;
  blurb: string;
  tags: string[];
  build: () => Project;
}

function node(partial: Partial<ObjectNode> & { kind: ObjectNode['kind'] }): ObjectNode {
  return {
    id: newId(partial.kind),
    kind: partial.kind,
    name: partial.name ?? partial.kind,
    visible: partial.visible ?? true,
    locked: partial.locked ?? false,
    position: partial.position ?? { x: 0, y: 0, z: 0 },
    rotationDeg: partial.rotationDeg ?? { x: 0, y: 0, z: 0 },
    scale: partial.scale ?? { x: 1, y: 1, z: 1 },
    anchor: partial.anchor ?? { type: 'terrain', offset: 0 },
    data: partial.data ?? {},
    children: partial.children ?? [],
  };
}

function squareFootprint(w: number, d: number): Array<{ x: number; y: number }> {
  const hw = w / 2;
  const hd = d / 2;
  return [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ];
}

function circleFootprint(radius: number, segments = 24): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
  }
  return out;
}

/* ------------------------------------------- 6. chessboard road to church --- */

/**
 * The "road to church" board: an 8×8 grid of capture squares. Square 1 is the
 * dusty road at (0,0); square 64 is the church at (7,7). Rows run northward, so
 * walking north is walking toward the church.
 *
 * Movement is discrete: WASD takes one king's move per press, the step is a
 * gait-noise spring with camera bob, and the panorama warps on arrival. All six
 * panorama plates are real equirectangular images in `public/panoramas`.
 */
const BOARD_COLS = 8;
const BOARD_ROWS = 8;
const BOARD_SPACING = 12;

const PLATES = {
  road: '/panoramas/road-straight.jpg',
  corner: '/panoramas/lane-corner.jpg',
  cross: '/panoramas/crossroads.jpg',
  square: '/panoramas/village-square.jpg',
  yard: '/panoramas/churchyard.jpg',
  church: '/panoramas/church.jpg',
};

/** The route is the main diagonal: (0,0) → (7,7). */
function isRoute(col: number, row: number): boolean {
  return col === row;
}

function squareId(col: number, row: number): string {
  return `sq_${row * BOARD_COLS + col + 1}`;
}

function squareName(col: number, row: number): string {
  const n = row * BOARD_COLS + col + 1;
  if (n === 1) return '1 · The Road (start)';
  if (n === 64) return '64 · The Church';
  if (isRoute(col, row)) return `${n} · Lane`;
  return `${n} · Side square`;
}

function plateFor(col: number, row: number): string {
  if (col === BOARD_COLS - 1 && row === BOARD_ROWS - 1) return PLATES.church;
  if (!isRoute(col, row)) {
    // Off-route squares read as gardens and yards.
    return (col + row) % 2 === 0 ? PLATES.yard : PLATES.square;
  }
  if (col === 0 && row === 0) return PLATES.road;
  if (col === BOARD_COLS - 2) return PLATES.cross;
  return col % 2 === 0 ? PLATES.road : PLATES.corner;
}

const COMPASS: Array<{ dx: number; dy: number; dir: string }> = [
  { dx: 0, dy: 1, dir: 'north' },
  { dx: 1, dy: 1, dir: 'northeast' },
  { dx: 1, dy: 0, dir: 'east' },
  { dx: 1, dy: -1, dir: 'southeast' },
  { dx: 0, dy: -1, dir: 'south' },
  { dx: -1, dy: -1, dir: 'southwest' },
  { dx: -1, dy: 0, dir: 'west' },
  { dx: -1, dy: 1, dir: 'northwest' },
];

function buildChessboardChurch(): Project {
  const p = newProject('Road to Church');
  p.world.origin = { lat: 43.7696, lon: 11.2558, alt: 0 };
  p.terrain.source = { kind: 'flat', elevation: 0 };
  p.camera.mode = 'panorama';
  p.camera.fovDeg = 82;
  p.camera.pitchDeg = 0;
  p.camera.headingDeg = 0;
  p.camera.distance = 4;
  p.camera.position = { x: 0, y: 1.7, z: 0 };

  // ---- nodes -------------------------------------------------------------
  const nodes: Project['panorama']['nodes'] = [];
  for (let row = 0; row < BOARD_ROWS; row++) {
    for (let col = 0; col < BOARD_COLS; col++) {
      nodes.push({
        id: squareId(col, row),
        name: squareName(col, row),
        // Rows run northward: north is -Z, so row +1 means z decreases.
        position: { x: col * BOARD_SPACING, y: 1.7, z: -row * BOARD_SPACING },
        headingDeg: isRoute(col, row) ? 45 : 0,
        image: plateFor(col, row),
        neighbors: {} as Record<string, string>,
        vfovDeg: 180,
        cap: { enabled: true, top: '#8fb6e0', bottom: '#5a5248', blendDeg: 18 },
      });
    }
  }
  // ---- king-move edges ---------------------------------------------------
  for (let row = 0; row < BOARD_ROWS; row++) {
    for (let col = 0; col < BOARD_COLS; col++) {
      const here = nodes[row * BOARD_COLS + col];
      for (const m of COMPASS) {
        const nc = col + m.dx;
        const nr = row + m.dy;
        if (nc < 0 || nr < 0 || nc >= BOARD_COLS || nr >= BOARD_ROWS) continue;
        here.neighbors[m.dir] = squareId(nc, nr);
      }
    }
  }
  p.panorama.nodes = nodes;
  p.panorama.currentNodeId = squareId(0, 0);
  p.panorama.pitchClampDeg = 72;
  p.panorama.transitionMs = 340;
  p.panorama.persistence = { enabled: true, strength: 0.62, mode: 'fade', keepCameraState: true };
  p.panorama.grid = {
    cols: BOARD_COLS,
    rows: BOARD_ROWS,
    spacing: BOARD_SPACING,
    walkSpeed: 1.6,
    gaitNoise: 0.2,
    bobAmplitude: 0.05,
    bobHz: 1.85,
    seed: 21,
    goalNodeId: squareId(BOARD_COLS - 1, BOARD_ROWS - 1),
    allowDiagonals: true,
  };

  // ---- world-anchored overlay so the board reads in orbit mode too -------
  const markers = [];
  for (let row = 0; row < BOARD_ROWS; row++) {
    for (let col = 0; col < BOARD_COLS; col++) {
      if (!isRoute(col, row) && !(col === 7 && row === 7)) continue;
      markers.push(
        node({
          kind: col === 7 && row === 7 ? 'markers' : 'labels',
          name: squareName(col, row),
          position: { x: col * BOARD_SPACING, y: 0, z: -row * BOARD_SPACING },
          anchor: { type: 'world' },
          data: { color: col === 7 && row === 7 ? '#f6c453' : '#9fb4c7' },
        }),
      );
    }
  }

  // A road ribbon along the diagonal so orbit mode shows the route.
  const roadPoints = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    roadPoints.push({ x: t * (BOARD_COLS - 1) * BOARD_SPACING, y: -t * (BOARD_ROWS - 1) * BOARD_SPACING });
  }

  p.layers = [
    node({
      kind: 'group',
      name: 'Route',
      anchor: { type: 'world' },
      children: [
        node({
          kind: 'roads',
          name: 'The road to church',
          anchor: { type: 'world' },
          data: { points: roadPoints, width: 3.2, sidewalkWidth: 0, smoothing: 0.35, color: '#a08b6c' },
        }),
        ...markers,
      ],
    }),
  ];

  p.bookmarks = [
    { id: newId('bm'), name: 'Start of the road', camera: { ...p.camera, mode: 'orbit', position: { x: -14, y: 16, z: 22 }, target: { x: 0, y: 0, z: 0 }, headingDeg: 30, pitchDeg: -32, distance: 40 }, createdAt: Date.now() },
    { id: newId('bm'), name: 'The church', camera: { ...p.camera, mode: 'orbit', position: { x: 70, y: 22, z: -96 }, target: { x: 84, y: 0, z: -84 }, headingDeg: 135, pitchDeg: -28, distance: 44 }, createdAt: Date.now() },
  ];

  return p;
}

/* ------------------------------------------------------------- 1. city --- */

function buildHarbourCity(): Project {
  const p = newProject('Harbour City');
  p.world.origin = { lat: 41.3874, lon: 2.1686, alt: 0 };
  p.terrain.source = { kind: 'procedural', seed: 4211, octaves: 4, lacunarity: 2.05, gain: 0.45, amplitude: 26, frequency: 0.0009, warp: 0.2, ridged: false };
  p.terrain.tileSizeMeters = 256;
  p.terrain.segments = 56;
  p.camera = { ...p.camera, position: { x: 60, y: 130, z: 230 }, target: { x: 0, y: 0, z: 0 }, headingDeg: 12, pitchDeg: -26, distance: 265, fovDeg: 58, rollDeg: 0, mode: 'orbit' };

  const districts = node({ kind: 'group', name: 'Districts', anchor: { type: 'world' } });
  const blocks: ObjectNode[] = [];
  const rng = seedRng(9137);
  for (let i = 0; i < 26; i++) {
    const angle = rng() * Math.PI * 2;
    const radius = 30 + rng() * 190;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const w = 10 + rng() * 16;
    const d = 10 + rng() * 16;
    const floors = 2 + Math.floor(rng() * 9);
    blocks.push(
      node({
        kind: 'buildings',
        name: `Block ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26) + 1}`,
        position: { x, y: 0, z },
        rotationDeg: { x: 0, y: rng() * 90, z: 0 },
        data: {
          footprint: squareFootprint(w, d),
          floors,
          floorHeight: 3.3,
          roof: rng() > 0.55 ? 'gable' : 'flat',
          color: rng() > 0.5 ? '#b9b3a6' : '#a08f7c',
        },
      }),
    );
  }
  districts.children = blocks;

  const roads = node({ kind: 'group', name: 'Roads', anchor: { type: 'world' } });
  roads.children = [
    node({
      kind: 'roads',
      name: 'Main Avenue',
      data: {
        points: [
          { x: -320, y: -10 }, { x: -160, y: -4 }, { x: -40, y: 2 }, { x: 60, y: -6 }, { x: 180, y: 4 }, { x: 320, y: 12 },
        ],
        width: 12,
        sidewalkWidth: 2.2,
        smoothing: 0.6,
      },
    }),
    node({
      kind: 'roads',
      name: 'Harbour Road',
      data: {
        points: [
          { x: -60, y: -300 }, { x: -52, y: -160 }, { x: -46, y: -40 }, { x: -58, y: 90 }, { x: -70, y: 240 },
        ],
        width: 9,
        sidewalkWidth: 1.8,
        smoothing: 0.5,
      },
    }),
  ];

  const water = node({
    kind: 'water',
    name: 'Harbour',
    anchor: { type: 'world' },
    data: {
      ring: [
        { x: 210, y: -330 }, { x: 430, y: -330 }, { x: 430, y: -120 }, { x: 300, y: -90 }, { x: 210, y: -180 },
      ],
      level: 1.5,
      color: '#2f6f8f',
    },
  });

  const park = node({
    kind: 'polygons',
    name: 'Central Park',
    anchor: { type: 'world' },
    data: { ring: circleFootprint(70, 28).map((pt) => ({ x: pt.x - 120, y: pt.y + 110 })), color: '#4f7a3f' },
  });

  const trees = node({
    kind: 'vegetation',
    name: 'Park Trees',
    anchor: { type: 'world' },
    data: { count: 420, seed: 77, bounds: { minX: -190, minZ: 40, maxX: -50, maxZ: 180 }, maxSlopeDeg: 30, minScale: 0.7, maxScale: 1.6, color: '#3f7a3a' },
  });

  const markers = node({ kind: 'group', name: 'Points of interest', anchor: { type: 'world' } });
  markers.children = [
    node({ kind: 'markers', name: 'Ferry Terminal', position: { x: 250, y: 0, z: -190 }, data: { color: '#f6ad55' } }),
    node({ kind: 'markers', name: 'Old Market', position: { x: -40, y: 0, z: 40 }, data: { color: '#63b3ed' } }),
    node({ kind: 'labels', name: 'Harbour City', position: { x: 0, y: 0, z: -60 }, data: {} }),
  ];

  p.layers = [districts, roads, water, park, trees, markers];
  p.environment.timeOfDay = 16.5;
  p.environment.shadows = 'medium';
  p.environment.fog = { ...p.environment.fog, mode: 'linear', near: 400, far: 3600, color: '#a9bcd0' };
  p.bookmarks = [
    { id: newId('bm'), name: 'Harbour overview', camera: { ...p.camera }, createdAt: Date.now() },
    {
      id: newId('bm'),
      name: 'Market street',
      camera: { ...p.camera, position: { x: -20, y: 26, z: 90 }, target: { x: -40, y: 6, z: 40 }, headingDeg: -18, pitchDeg: -8, distance: 70 },
      createdAt: Date.now(),
    },
  ];
  return p;
}

/* -------------------------------------------------------- 2. mountain --- */

function buildRidgeline(): Project {
  const p = newProject('Ridgeline Traverse');
  p.world.origin = { lat: 46.5588, lon: 7.9644, alt: 0 };
  p.terrain.source = { kind: 'procedural', seed: 88213, octaves: 6, lacunarity: 2.12, gain: 0.52, amplitude: 620, frequency: 0.0016, warp: 0.55, ridged: true };
  p.terrain.tileSizeMeters = 256;
  p.terrain.segments = 64;
  p.terrain.contours = { enabled: true, interval: 60, indexEvery: 5 };
  p.terrain.verticalExaggeration = 1;
  p.camera = { ...p.camera, position: { x: 210, y: 520, z: 430 }, target: { x: 0, y: 120, z: 0 }, headingDeg: -22, pitchDeg: -22, distance: 700, fovDeg: 62, rollDeg: 0, mode: 'orbit' };
  p.environment.timeOfDay = 8.2;
  p.environment.shadows = 'high';
  p.environment.fog = { ...p.environment.fog, mode: 'height', density: 0.00045, color: '#c6d4e2', height: 220 };

  const traverse = node({
    kind: 'paths',
    name: 'Traverse Trail',
    anchor: { type: 'world' },
    data: {
      points: [
        { x: -360, y: 240 }, { x: -240, y: 150 }, { x: -140, y: 60 }, { x: -60, y: -20 }, { x: 40, y: -90 }, { x: 150, y: -140 }, { x: 280, y: -200 },
      ],
      width: 3,
      smoothing: 0.7,
    },
  });

  const huts = node({ kind: 'group', name: 'Huts', anchor: { type: 'world' } });
  huts.children = [
    node({ kind: 'buildings', name: 'Lower Hut', position: { x: -240, y: 0, z: 150 }, data: { footprint: squareFootprint(9, 7), floors: 1, floorHeight: 3.4, roof: 'gable', color: '#8c5a3c' } }),
    node({ kind: 'buildings', name: 'Ridge Hut', position: { x: 150, y: 0, z: -140 }, data: { footprint: squareFootprint(8, 6), floors: 1, floorHeight: 3.2, roof: 'gable', color: '#9c6b45' } }),
    node({ kind: 'markers', name: 'Summit', position: { x: 280, y: 0, z: -200 }, data: { color: '#f26d6d' } }),
  ];

  const lake = node({
    kind: 'water',
    name: 'Tarn',
    anchor: { type: 'world' },
    data: { ring: circleFootprint(55, 26).map((pt) => ({ x: pt.x - 300, y: pt.y + 300 })), level: 0.8, color: '#2b5a6e' },
  });

  const alpine = node({
    kind: 'vegetation',
    name: 'Alpine scrub',
    anchor: { type: 'world' },
    data: { count: 900, seed: 441, bounds: { minX: -420, minZ: -60, maxX: 120, maxZ: 420 }, maxSlopeDeg: 26, minScale: 0.45, maxScale: 1.0, color: '#365f36' },
  });

  p.layers = [traverse, huts, lake, alpine];
  p.measurements = [
    { id: newId('meas'), kind: 'surface', points: [{ x: -360, y: 0, z: 240 }, { x: -140, y: 0, z: 60 }, { x: 40, y: 0, z: -90 }, { x: 280, y: 0, z: -200 }], ring: [] },
  ];
  return p;
}

/* -------------------------------------------------------- 3. panoramas --- */

function buildPanoramaTour(): Project {
  const p = newProject('Linked Panoramas');
  p.world.origin = { lat: 35.6595, lon: 139.7005, alt: 0 };
  p.terrain.source = { kind: 'flat', elevation: 0 };
  p.camera.mode = 'panorama';
  p.camera.position = { x: 0, y: 1.7, z: 0 };
  p.camera.pitchDeg = 0;
  p.camera.headingDeg = 0;
  p.camera.fovDeg = 78;
  p.camera.distance = 5;

  const spacing = 22;
  const ids = ['pano_station', 'pano_crossing', 'pano_park', 'pano_bridge'];
  const names = ['Station Square', 'Crossing', 'Riverside Park', 'Bridge Approach'];
  p.panorama.nodes = ids.map((id, i) => ({
    id,
    name: names[i],
    position: { x: i * spacing, y: 1.7, z: i % 2 === 0 ? 0 : 12 },
    headingDeg: i * 35,
    // No bundled imagery: the panorama view falls back to its colour-matched
    // environment caps, and the UI says exactly that. That is honest and it
    // still exercises the whole node graph, transitions and persistence path.
    image: '',
    neighbors: {},
    vfovDeg: 180,
    cap: { enabled: true, top: i % 2 ? '#7fa8d8' : '#93b6dd', bottom: '#4c4a44', blendDeg: 20 },
  }));
  for (let i = 0; i < ids.length - 1; i++) {
    p.panorama.nodes[i].neighbors['forward'] = ids[i + 1];
    p.panorama.nodes[i + 1].neighbors['back'] = ids[i];
  }
  p.panorama.nodes[0].neighbors['north'] = ids[2];
  p.panorama.currentNodeId = ids[0];
  p.panorama.pitchClampDeg = 70;
  p.panorama.transitionMs = 300;
  p.panorama.persistence = { enabled: true, strength: 0.6, mode: 'fade', keepCameraState: true };

  // A world-anchored layer stays put across node changes (REQUIREMENT 042).
  p.layers = [
    node({ kind: 'group', name: 'World-anchored', anchor: { type: 'world' } , children: [
      node({ kind: 'markers', name: 'Waypoint A', position: { x: 6, y: 0, z: 4 }, anchor: { type: 'world' }, data: { color: '#4fd1c5' } }),
      node({ kind: 'labels', name: 'Station Square', position: { x: 0, y: 3, z: 0 }, anchor: { type: 'world' }, data: {} }),
    ]}),
  ];
  return p;
}

/* ------------------------------------------------------- 4. object world --- */

function buildObjectStudio(): Project {
  const p = newProject('Object Studio');
  p.world.origin = { lat: 51.5072, lon: -0.1276, alt: 0 };
  p.terrain.source = { kind: 'procedural', seed: 5150, octaves: 3, lacunarity: 2, gain: 0.4, amplitude: 12, frequency: 0.004, warp: 0.1, ridged: false };
  p.terrain.tileSizeMeters = 256;
  p.terrain.segments = 40;
  p.camera = { ...p.camera, position: { x: 26, y: 22, z: 40 }, target: { x: 0, y: 2, z: 0 }, headingDeg: 8, pitchDeg: -20, distance: 52, fovDeg: 55, rollDeg: 0, mode: 'orbit' };

  const rig = node({ kind: 'group', name: 'Studio rig', anchor: { type: 'world' } });
  rig.children = [
    node({ kind: 'objects', name: 'Hero crate', position: { x: 0, y: 2, z: 0 }, scale: { x: 1.6, y: 1.6, z: 1.6 }, data: { shape: 'box', color: '#c0663f' } }),
    node({ kind: 'objects', name: 'Beacon', position: { x: -9, y: 2.5, z: 4 }, scale: { x: 1.2, y: 1.2, z: 1.2 }, data: { shape: 'sphere', color: '#4fb3f5' } }),
    node({ kind: 'objects', name: 'Spire', position: { x: 8, y: 3, z: -5 }, scale: { x: 1, y: 2.4, z: 1 }, data: { shape: 'cylinder', color: '#f6c453' } }),
    node({ kind: 'objects', name: 'Ring', position: { x: 3, y: 3.4, z: 9 }, scale: { x: 1.3, y: 1.3, z: 1.3 }, rotationDeg: { x: 90, y: 0, z: 0 }, data: { shape: 'torus', color: '#7ee0b8' } }),
  ];

  const scatter = node({
    kind: 'vegetation',
    name: 'Instanced props',
    anchor: { type: 'world' },
    data: { count: 600, seed: 12, bounds: { minX: -60, minZ: -60, maxX: 60, maxZ: 60 }, maxSlopeDeg: 40, minScale: 0.4, maxScale: 1.2, color: '#5f7f4a' },
  });

  const plaza = node({
    kind: 'polygons',
    name: 'Plaza',
    anchor: { type: 'world' },
    data: { ring: circleFootprint(34, 32), color: '#6b7280' },
  });

  p.layers = [plaza, rig, scatter];
  p.tour = [
    { id: newId('tour'), name: 'Front', caption: 'The hero crate, straight on.', camera: { ...p.camera }, durationMs: 2600 },
    { id: newId('tour'), name: 'Orbit', caption: 'Swing around to the beacon.', camera: { ...p.camera, headingDeg: 90, position: { x: 40, y: 20, z: 6 } }, durationMs: 3200 },
    { id: newId('tour'), name: 'Top', caption: 'Look down on the plaza.', camera: { ...p.camera, pitchDeg: -62, position: { x: 0, y: 70, z: 14 } }, durationMs: 3000 },
  ];
  return p;
}

/* -------------------------------------------------- 5. large tiled world --- */

function buildOpenTileWorld(): Project {
  const p = newProject('Open Tile World');
  p.world.origin = { lat: -43.5321, lon: 172.6362, alt: 0 };
  // A big footprint with small tiles: the tile scheduler has real work to do.
  p.terrain.source = { kind: 'procedural', seed: 30071, octaves: 6, lacunarity: 2.08, gain: 0.5, amplitude: 340, frequency: 0.0006, warp: 0.45, ridged: false };
  p.terrain.tileSizeMeters = 128;
  p.terrain.segments = 40;
  p.performance.maxActiveTiles = 120;
  p.performance.quality = 'high';
  p.camera = { ...p.camera, position: { x: 420, y: 900, z: 780 }, target: { x: 0, y: 0, z: 0 }, headingDeg: 30, pitchDeg: -30, distance: 1400, fovDeg: 65, rollDeg: 0, mode: 'orbit' };
  p.environment.timeOfDay = 12;
  p.environment.fog = { ...p.environment.fog, mode: 'exponential', density: 0.00022, color: '#b9c8d8' };

  const corridor = node({
    kind: 'roads',
    name: 'Coastal Highway',
    anchor: { type: 'world' },
    data: {
      points: [
        { x: -700, y: -380 }, { x: -420, y: -260 }, { x: -180, y: -120 }, { x: 40, y: 20 }, { x: 260, y: 140 }, { x: 520, y: 240 }, { x: 720, y: 300 },
      ],
      width: 14,
      sidewalkWidth: 0,
      smoothing: 0.65,
    },
  });

  const river = node({
    kind: 'water',
    name: 'Braided River',
    anchor: { type: 'world' },
    data: {
      ring: [
        { x: -620, y: 420 }, { x: -300, y: 300 }, { x: 40, y: 260 }, { x: 380, y: 300 }, { x: 660, y: 420 },
        { x: 660, y: 520 }, { x: 380, y: 400 }, { x: 40, y: 360 }, { x: -300, y: 400 }, { x: -620, y: 520 },
      ],
      level: 2,
      color: '#2c5a6b',
    },
  });

  const forest = node({
    kind: 'vegetation',
    name: 'Native forest',
    anchor: { type: 'world' },
    data: { count: 3000, seed: 909, bounds: { minX: -700, minZ: -600, maxX: 700, maxZ: 200 }, maxSlopeDeg: 34, minScale: 0.6, maxScale: 1.8, color: '#2f5f33' },
  });

  const walls = node({
    kind: 'group',
    name: 'Barriers',
    anchor: { type: 'world' },
    children: [
      node({
        kind: 'paths',
        name: 'Fenceline',
        anchor: { type: 'world' },
        data: { points: [{ x: -500, y: -300 }, { x: -200, y: -320 }, { x: 120, y: -260 }], width: 0.4, smoothing: 0.3 },
      }),
    ],
  });

  p.layers = [corridor, river, forest, walls];
  p.bookmarks = [
    { id: newId('bm'), name: 'Wide', camera: { ...p.camera }, createdAt: Date.now() },
    { id: newId('bm'), name: 'Highway', camera: { ...p.camera, position: { x: -180, y: 60, z: -60 }, target: { x: -180, y: 0, z: -120 }, headingDeg: 40, pitchDeg: -10, distance: 120 }, createdAt: Date.now() },
  ];
  return p;
}

/* ----------------------------------------------------------------- index --- */

export const DEMOS: DemoDefinition[] = [
  {
    id: 'city',
    name: 'Harbour City',
    blurb: 'Buildings, roads, water and instanced vegetation on gentle coastal terrain.',
    tags: ['buildings', 'roads', 'water', 'instancing'],
    build: buildHarbourCity,
  },
  {
    id: 'mountain',
    name: 'Ridgeline Traverse',
    blurb: 'Steep ridged terrain with live contours, hillshade and a surface-distance measurement.',
    tags: ['terrain', 'contours', 'measurement'],
    build: buildRidgeline,
  },
  {
    id: 'panoramas',
    name: 'Linked Panoramas',
    blurb: 'A connected panorama graph with neighbour edges, pitch clamping and persistence.',
    tags: ['panorama', 'graph', 'transitions'],
    build: buildPanoramaTour,
  },
  {
    id: 'objects',
    name: 'Object Studio',
    blurb: 'Primitives, gizmo transforms, instanced props and a three-stop camera tour.',
    tags: ['objects', 'gizmo', 'tour'],
    build: buildObjectStudio,
  },
  {
    id: 'church',
    name: 'Road to Church',
    blurb:
      'An 8×8 chessboard of real 360° plates. WASD walks one king\'s move per press with a gait-noise step and camera bob, warping to the next panorama on arrival. Square 1 is the road, square 64 is the church.',
    tags: ['panorama', 'grid walk', 'king moves', 'warp'],
    build: buildChessboardChurch,
  },
  {
    id: 'openworld',
    name: 'Open Tile World',
    blurb: 'A large footprint on small tiles — exercises streaming, LOD and cache eviction.',
    tags: ['streaming', 'lod', 'performance'],
    build: buildOpenTileWorld,
  },
];

/** Deterministic RNG so demo worlds are identical every load. */
function seedRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A stress scene for benchmarking (REQUIREMENT 139). */
export function buildStressWorld(instanceCount = 6000): Project {
  const p = newProject('Stress Scene');
  p.terrain.source = { kind: 'procedural', seed: 99001, octaves: 6, lacunarity: 2.1, gain: 0.52, amplitude: 300, frequency: 0.0009, warp: 0.5, ridged: true };
  p.terrain.tileSizeMeters = 128;
  p.terrain.segments = 64;
  p.terrain.contours = { enabled: true, interval: 50, indexEvery: 5 };
  p.performance.quality = 'high';
  p.performance.maxActiveTiles = 160;
  p.camera = { ...p.camera, position: { x: 300, y: 620, z: 560 }, target: { x: 0, y: 0, z: 0 }, distance: 1100, pitchDeg: -30, headingDeg: 20, fovDeg: 65, rollDeg: 0, mode: 'orbit' };
  p.layers = [
    node({
      kind: 'vegetation',
      name: 'Stress instances',
      anchor: { type: 'world' },
      data: { count: instanceCount, seed: 5, bounds: { minX: -800, minZ: -800, maxX: 800, maxZ: 800 }, maxSlopeDeg: 60, minScale: 0.5, maxScale: 2 },
    }),
    node({
      kind: 'group',
      name: 'Stress buildings',
      anchor: { type: 'world' },
      children: Array.from({ length: 120 }, (_, i) => {
        const a = (i / 120) * Math.PI * 2;
        const r = 120 + (i % 9) * 55;
        return node({
          kind: 'buildings',
          name: `Tower ${i + 1}`,
          position: { x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r },
          data: { footprint: squareFootprint(12, 12), floors: 3 + (i % 14), floorHeight: 3.4, roof: i % 3 === 0 ? 'gable' : 'flat' },
        });
      }),
    }),
  ];
  return p;
}
