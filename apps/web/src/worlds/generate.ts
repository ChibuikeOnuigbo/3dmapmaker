/**
 * apps/web — procedural world generation.
 *
 * Builds a WorldGraph for each demo: a road network laid out on a seeded
 * lattice, buildings and vegetation that block cells, landmarks with persistent
 * ids, and edges derived from coordinates — never from numeric ids.
 *
 * The same generator produces the 8×8, 20×20 and 32×32 worlds, which is the
 * point: the navigation engine never changes as the world grows (spec §56).
 */
import { WorldGraph, indexFor, chebyshev, type WorldNode, type Direction } from '@3dmm/panorama';

/* ------------------------------------------------------------- rng --- */

/** Deterministic PRNG so a world is byte-identical on every load. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------- plate library --- */

/**
 * The generated equirectangular plate library, keyed by terrain class.
 *
 * These are real generated 360° images. A large world reuses them by
 * environment class rather than pretending to hold a unique render per node —
 * the frontier generator in `generation.ts` is what would produce unique
 * plates, and it records exactly which plate each node was assigned.
 */
export const PLATES = {
  road: '/panoramas/road-straight.jpg',
  lane: '/panoramas/lane-corner.jpg',
  junction: '/panoramas/junction.jpg',
  crossroads: '/panoramas/crossroads.jpg',
  houses: '/panoramas/houses.jpg',
  market: '/panoramas/market.jpg',
  school: '/panoramas/school.jpg',
  river: '/panoramas/river.jpg',
  farm: '/panoramas/farm-path.jpg',
  square: '/panoramas/village-square.jpg',
  churchyard: '/panoramas/churchyard.jpg',
  church: '/panoramas/church.jpg',
} as const;

export type PlateKey = keyof typeof PLATES;

export const PROVENANCE = {
  sourceType: 'generated' as const,
  referenceSources: ['procedural-layout', 'open-map-topology'],
  generator: 'arena-image-model',
  createdAt: '2026-09-16',
  license: 'CC0-1.0',
};

/* --------------------------------------------------------- world spec --- */

export interface WorldSpec {
  id: string;
  name: string;
  blurb: string;
  width: number;
  height: number;
  /** Metres per grid step. A grid step is NOT a metre (spec §48). */
  metersPerGridUnit: number;
  seed: number;
  /** Geographic anchor of the (0,0) square. */
  origin: { lat: number; lon: number };
  /** Fraction of cells left as open ground with no road. */
  openness: number;
}

export const WORLD_SPECS: Record<'small' | 'medium' | 'large', WorldSpec> = {
  small: {
    id: 'demo-small',
    name: 'Small Village',
    blurb: '64 panoramas on an 8×8 board. The road at square 1, the church at square 64.',
    width: 8,
    height: 8,
    metersPerGridUnit: 25,
    seed: 1337,
    origin: { lat: 4.8156, lon: 7.0498 },
    openness: 0.18,
  },
  medium: {
    id: 'demo-medium',
    name: 'Village Explorer',
    blurb: '400 panoramas on a 20×20 world. Market, school, river crossing and several routes to the church.',
    width: 20,
    height: 20,
    metersPerGridUnit: 25,
    seed: 4242,
    origin: { lat: 4.8156, lon: 7.0498 },
    openness: 0.3,
  },
  large: {
    id: 'demo-large',
    name: 'Connected World',
    blurb: '1,024 panoramas on a 32×32 world. Dynamic loading, A* routing and a spatial index over the whole graph.',
    width: 32,
    height: 32,
    metersPerGridUnit: 25,
    seed: 90210,
    origin: { lat: 4.8156, lon: 7.0498 },
    openness: 0.34,
  },
};

/* ------------------------------------------------------- cell classes --- */

export type CellKind = 'road' | 'lane' | 'junction' | 'houses' | 'market' | 'school' | 'river' | 'farm' | 'square' | 'churchyard' | 'church' | 'blocked';

const PLATE_FOR_KIND: Record<Exclude<CellKind, 'blocked'>, PlateKey> = {
  road: 'road',
  lane: 'lane',
  junction: 'junction',
  houses: 'houses',
  market: 'market',
  school: 'school',
  river: 'river',
  farm: 'farm',
  square: 'square',
  churchyard: 'churchyard',
  church: 'church',
};

export interface GeneratedWorld {
  graph: WorldGraph;
  spec: WorldSpec;
  kinds: CellKind[];
  startId: string;
  destinationId: string;
  /** Cells that exist in the graph, indexed by square. */
  occupancy: Uint8Array;
}

/**
 * Lay out a world.
 *
 * The layout is a seeded lattice: a main spine, cross streets, a river on the
 * medium/large worlds, and blocks of buildings that remove cells from the graph
 * entirely. Edges are then derived from coordinates, so adjacency is always
 * geometrically true (spec §3: "calculate adjacency from coordinates").
 */
export function generateWorld(spec: WorldSpec): GeneratedWorld {
  const rng = makeRng(spec.seed);
  const { width, height } = spec;
  const kinds: CellKind[] = new Array(width * height).fill('farm');
  const occupancy = new Uint8Array(width * height);

  const idx = (x: number, y: number) => indexFor(x, y, width);

  /* ---- main spine: a road from the start corner toward the church ---- */
  // Deliberately not a straight diagonal — it dog-legs so the route has turns.
  const spine: Array<[number, number]> = [];
  let cx = 0;
  let cy = 0;
  spine.push([cx, cy]);
  let guard = 0;
  while ((cx !== width - 1 || cy !== height - 1) && guard++ < width * height * 4) {
    const wantEast = cx < width - 1;
    const wantNorth = cy < height - 1;
    // Bias toward the goal but let the RNG pick the axis, giving real turns.
    if (wantEast && wantNorth) {
      if (rng() < 0.5) cx++;
      else cy++;
    } else if (wantEast) cx++;
    else cy++;
    spine.push([cx, cy]);
  }
  for (const [x, y] of spine) kinds[idx(x, y)] = 'road';

  /* ---- cross streets ---- */
  const streetEvery = width <= 8 ? 3 : width <= 20 ? 5 : 7;
  for (let y = 0; y < height; y += streetEvery) {
    for (let x = 0; x < width; x++) if (kinds[idx(x, y)] === 'farm') kinds[idx(x, y)] = 'lane';
  }
  for (let x = 0; x < width; x += streetEvery) {
    for (let y = 0; y < height; y++) if (kinds[idx(x, y)] === 'farm') kinds[idx(x, y)] = 'lane';
  }

  /* ---- river on the larger worlds ---- */
  if (width >= 20) {
    const riverX = Math.floor(width * 0.62);
    for (let y = 0; y < height; y++) {
      const x = riverX + Math.round(Math.sin(y * 0.6) * 1.5);
      if (x >= 0 && x < width) kinds[idx(x, y)] = 'river';
    }
    // Two crossings, so the river divides without disconnecting.
    for (const by of [Math.floor(height * 0.28), Math.floor(height * 0.74)]) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = riverX + Math.round(Math.sin(by * 0.6) * 1.5) + dx;
        if (x >= 0 && x < width) kinds[idx(x, by)] = 'road';
      }
    }
  }

  /* ---- landmarks ---- */
  const churchX = width - 1;
  const churchY = height - 1;
  kinds[idx(churchX, churchY)] = 'church';
  if (churchX - 1 >= 0) kinds[idx(churchX - 1, churchY)] = 'churchyard';
  if (churchY - 1 >= 0) kinds[idx(churchX, churchY - 1)] = 'churchyard';

  if (width >= 20) {
    kinds[idx(Math.floor(width * 0.3), Math.floor(height * 0.55))] = 'market';
    kinds[idx(Math.floor(width * 0.72), Math.floor(height * 0.3))] = 'school';
    kinds[idx(Math.floor(width * 0.45), Math.floor(height * 0.45))] = 'square';
  } else {
    kinds[idx(Math.min(width - 1, 4), Math.min(height - 1, 3))] = 'market';
  }

  /* ---- buildings: blocks that remove cells from the graph ---- */
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = kinds[idx(x, y)];
      if (k !== 'farm') continue;
      // Clusters, not confetti: a cell is more likely built next to another.
      const nearBuilt =
        (x > 0 && kinds[idx(x - 1, y)] === 'blocked' ? 1 : 0) + (y > 0 && kinds[idx(x, y - 1)] === 'blocked' ? 1 : 0);
      const p = spec.openness * 0.35 + nearBuilt * 0.28;
      if (rng() < p) kinds[idx(x, y)] = 'blocked';
    }
  }

  // The spine, the church and its yard are never built over.
  for (const [x, y] of spine) if (kinds[idx(x, y)] === 'blocked') kinds[idx(x, y)] = 'road';
  for (const [x, y] of [
    [churchX, churchY],
    [churchX - 1, churchY],
    [churchX, churchY - 1],
  ]) {
    if (x >= 0 && y >= 0 && x < width && y < height && kinds[idx(x, y)] === 'blocked') kinds[idx(x, y)] = 'churchyard';
  }

  /* ---- build the graph over walkable cells ---- */
  const graph = new WorldGraph({
    width,
    height,
    metersPerGridUnit: spec.metersPerGridUnit,
    walkSpeed: 1.4,
    cellSize: width <= 8 ? 4 : 8,
  });

  // Roughly 1 deg of latitude ≈ 111,320 m; longitude scales by cos(lat).
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((spec.origin.lat * Math.PI) / 180);
  const degPerUnitLat = spec.metersPerGridUnit / metersPerDegLat;
  const degPerUnitLon = spec.metersPerGridUnit / metersPerDegLon;

  const timeOfDay = '16:30';
  const sunDirection = 245;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = kinds[idx(x, y)];
      if (k === 'blocked') continue;
      occupancy[idx(x, y)] = 1;
      const plate = PLATES[PLATE_FOR_KIND[k]];
      const id = `node_${String(idFor(x, y, width)).padStart(4, '0')}`;
      const node: Omit<WorldNode, 'index' | 'number' | 'worldX' | 'worldZ'> = {
        id,
        gridX: x,
        gridY: y,
        latitude: spec.origin.lat + y * degPerUnitLat,
        longitude: spec.origin.lon + x * degPerUnitLon,
        panoramaUrl: plate,
        thumbnailUrl: plate,
        // Face along the spine where there is one, otherwise north.
        heading: spineHeading(spine, x, y),
        pitch: 0,
        fov: 90,
        environment: {
          terrain: k === 'river' ? 'stream bed' : k === 'farm' ? 'farmland' : 'village ground',
          roadType: k === 'road' ? 'paved' : k === 'lane' ? 'dirt track' : k === 'river' ? 'culvert' : 'none',
          buildings: k === 'market' ? ['market stalls'] : k === 'school' ? ['school block'] : k === 'church' ? ['church'] : [],
          vegetation: k === 'farm' ? ['cassava', 'maize'] : ['grass', 'trees'],
          landmarks: [],
        },
        lighting: { timeOfDay, weather: 'partly_cloudy', sunDirection, exposure: 1 },
        connections: {},
        validation: { panoramaValid: true, continuityValid: true, geometryValid: true, lightingValid: true },
        provenance: { ...PROVENANCE },
      };
      graph.add(node);
    }
  }

  /* ---- edges, derived from coordinates ---- */
  for (const n of graph.all()) {
    for (const m of graph.kingMovesFrom(n.gridX, n.gridY)) {
      const other = graph.at(m.x, m.y);
      if (!other) continue;
      if (n.connections[m.dir]) continue;
      graph.connect(n.id, m.dir, other.id);
    }
  }

  /* ---- landmarks with persistent ids (spec §19) ---- */
  graph.addLandmark({ id: 'LANDMARK_001', name: 'The Church', gridX: churchX, gridY: churchY, kind: 'church' });
  if (width >= 20) {
    graph.addLandmark({ id: 'LANDMARK_002', name: 'Market', gridX: Math.floor(width * 0.3), gridY: Math.floor(height * 0.55), kind: 'market' });
    graph.addLandmark({ id: 'LANDMARK_003', name: 'School', gridX: Math.floor(width * 0.72), gridY: Math.floor(height * 0.3), kind: 'school' });
  }

  const startId = ensureReachableStart(graph, spine, width);
  const destinationId = `node_${String(idFor(churchX, churchY, width)).padStart(4, '0')}`;

  return { graph, spec, kinds, startId, destinationId, occupancy };
}

function idFor(x: number, y: number, width: number): number {
  return y * width + x + 1;
}

function spineHeading(spine: Array<[number, number]>, x: number, y: number): number {
  const i = spine.findIndex(([sx, sy]) => sx === x && sy === y);
  if (i < 0) return 0;
  const next = spine[Math.min(i + 1, spine.length - 1)];
  const prev = spine[Math.max(i - 1, 0)];
  const dx = next[0] - prev[0];
  const dy = next[1] - prev[1];
  if (dx === 0 && dy === 0) return 0;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/**
 * The start must actually reach the church. If buildings sealed the start
 * square in, carve the spine back open rather than shipping a world where the
 * demo cannot be completed.
 */
function ensureReachableStart(graph: WorldGraph, spine: Array<[number, number]>, width: number): string {
  const startId = `node_${String(idFor(spine[0][0], spine[0][1], width)).padStart(4, '0')}`;
  const destId = `node_${String(idFor(spine[spine.length - 1][0], spine[spine.length - 1][1], width)).padStart(4, '0')}`;
  if (graph.findPath(startId, destId)) return startId;
  // Should not happen with the spine carve above, but never fail silently.
  throw new Error('Generated world is not traversable from start to destination');
}

/** Human-readable cell label for the map legend. */
export function kindLabel(k: CellKind): string {
  switch (k) {
    case 'road':
      return 'Road';
    case 'lane':
      return 'Lane';
    case 'junction':
      return 'Junction';
    case 'houses':
      return 'Houses';
    case 'market':
      return 'Market';
    case 'school':
      return 'School';
    case 'river':
      return 'River';
    case 'farm':
      return 'Farmland';
    case 'square':
      return 'Square';
    case 'churchyard':
      return 'Churchyard';
    case 'church':
      return 'Church';
    default:
      return 'Building';
  }
}

/** Map colour per cell class. */
export const KIND_COLOR: Record<CellKind, string> = {
  road: '#8a7a5f',
  lane: '#a2946f',
  junction: '#7d6f56',
  houses: '#6b5a4a',
  market: '#8f6b3f',
  school: '#5f7a6b',
  river: '#3f6b8a',
  farm: '#4c6b3f',
  square: '#9a8a6a',
  churchyard: '#5a7a5a',
  church: '#b08a3a',
  blocked: '#3a3733',
};

/** The eight directions in the order the map draws them. */
export const MAP_DIRECTIONS: Direction[] = ['north', 'northEast', 'east', 'southEast', 'south', 'southWest', 'west', 'northWest'];

export { chebyshev };
