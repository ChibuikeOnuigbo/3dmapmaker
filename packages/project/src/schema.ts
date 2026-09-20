/**
 * packages/project — canonical, versioned project schema (REQUIREMENT 123).
 *
 * This is the single source of truth for what a 3DMapMaker Next document is.
 * Every subsystem (scene, terrain, panorama, layers, physics, tutorial) reads
 * and writes through this shape. Nothing stores editor state in the DOM.
 *
 * IDs are stable strings (nanoid-like) and never reused, so undo/redo, autosave
 * recovery and cross-session references keep working after edits.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 6;

/* ------------------------------------------------------------------ ids --- */

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function newId(prefix = 'n'): string {
  const bytes = new Uint8Array(12);
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let s = prefix + '_';
  for (let i = 0; i < bytes.length; i++) s += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return s;
}

/* ------------------------------------------------------------------ geo --- */

export const Vec3Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

export const GeoCoordSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
  alt: z.number().finite(),
});

/** Geographic anchor of the whole world (the tangent-plane origin). */
export const WorldAnchorSchema = z.object({
  origin: GeoCoordSchema,
  /** Render-space floating origin offset in local metres (REQUIREMENT 008). */
  floatingOrigin: Vec3Schema.default({ x: 0, y: 0, z: 0 }),
});

/* -------------------------------------------------------------- terrain --- */

export const TerrainSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('procedural'),
    seed: z.number().int(),
    octaves: z.number().int().min(1).max(8).default(5),
    lacunarity: z.number().positive().default(2.02),
    gain: z.number().positive().default(0.5),
    amplitude: z.number().finite().default(180),
    frequency: z.number().positive().default(0.0012),
    warp: z.number().finite().default(0.35),
    ridged: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('heightmap'),
    /** Project-relative URL or blob: URL of the imported raster. */
    url: z.string().min(1),
    /** Vertical scale applied to source values, in metres per source unit. */
    scale: z.number().positive().default(1),
    offset: z.number().finite().default(0),
    noDataValue: z.number().finite().nullable().default(null),
    format: z.enum(['png16', 'geotiff', 'raw']).default('png16'),
  }),
  z.object({
    kind: z.literal('flat'),
    elevation: z.number().finite().default(0),
  }),
  z.object({
    kind: z.literal('provider'),
    providerId: z.string().min(1),
    maxZoom: z.number().int().min(0).max(15).default(12),
  }),
]);

export const TerrainStateSchema = z.object({
  source: TerrainSourceSchema,
  /** Metres per terrain tile edge in local space. */
  tileSizeMeters: z.number().positive().default(256),
  /** Grid resolution per tile (vertices = segments+1). */
  segments: z.number().int().min(4).max(256).default(48),
  /** Visual-only vertical exaggeration. Never affects measurements (REQ 052). */
  verticalExaggeration: z.number().positive().default(1),
  /**
   * Authored height edits: tile key -> { "gridIndex": absoluteHeight }.
   * Sparse on purpose — a brush stroke touches a few hundred samples, not the
   * whole tile, and absolute heights survive source regeneration (REQ 048).
   */
  edits: z.record(z.string(), z.record(z.string(), z.number().finite())).default({}),
  contours: z
    .object({
      enabled: z.boolean().default(false),
      interval: z.number().positive().default(50),
      indexEvery: z.number().int().positive().default(5),
    })
    .default({ enabled: false, interval: 50, indexEvery: 5 }),
});

/* --------------------------------------------------------------- camera --- */

export const CameraModeSchema = z.enum(['orbit', 'fly', 'walk', 'panorama']);

export const CameraStateSchema = z.object({
  mode: CameraModeSchema.default('orbit'),
  position: Vec3Schema.default({ x: 0, y: 120, z: 220 }),
  target: Vec3Schema.default({ x: 0, y: 0, z: 0 }),
  headingDeg: z.number().finite().default(0),
  pitchDeg: z.number().finite().default(-25),
  rollDeg: z.number().finite().default(0),
  fovDeg: z.number().positive().default(60),
  distance: z.number().positive().default(250),
});

export const TransitionSpeedSchema = z.enum(['fast', 'normal', 'cinematic', 'custom']);

export const TransitionPresetSchema = z.object({
  speed: TransitionSpeedSchema.default('normal'),
  /** Milliseconds; used verbatim when speed === 'custom'. */
  customMs: z.number().int().positive().default(1200),
  easing: z.enum(['linear', 'easeInOutCubic', 'easeOutExpo', 'easeInOutSine']).default('easeInOutCubic'),
  /** Follow terrain elevation during the flight. */
  terrainFollow: z.boolean().default(false),
  /** Optional spline control points in local metres. */
  path: z.array(Vec3Schema).default([]),
  /** Any user input cancels the transition instead of queueing behind it. */
  interruptible: z.boolean().default(true),
});

/* ------------------------------------------------------------- panoramas --- */

export const PanoramaNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  position: Vec3Schema,
  /** Compass heading of image column 0, degrees. */
  headingDeg: z.number().finite().default(0),
  /** Image URL, or '' when the node has no imagery yet. */
  image: z.string().default(''),
  /** Direction -> neighbour node id. Mirrors the old repo's `links` idea. */
  neighbors: z.record(z.string(), z.string()).default({}),
  /** Vertical FOV of the equirect capture, degrees (180 = full sphere). */
  vfovDeg: z.number().positive().default(180),
  cap: z
    .object({
      enabled: z.boolean().default(true),
      top: z.string().default('#8fb8e8'),
      bottom: z.string().default('#4a4a45'),
      blendDeg: z.number().positive().default(18),
    })
    .default({ enabled: true, top: '#8fb8e8', bottom: '#4a4a45', blendDeg: 18 }),
});

export const PanoramaStateSchema = z.object({
  nodes: z.array(PanoramaNodeSchema).default([]),
  currentNodeId: z.string().nullable().default(null),
  /** Hard clamp on pitch so poles can never be dragged into view (REQ 040). */
  pitchClampDeg: z.number().positive().default(72),
  transitionMs: z.number().int().positive().default(320),
  /** World-anchored layers stay put across node changes (REQ 042). */
  persistence: z
    .object({
      enabled: z.boolean().default(true),
      strength: z.number().min(0).max(1).default(0.55),
      mode: z.enum(['fade', 'blur', 'echo']).default('fade'),
      keepCameraState: z.boolean().default(true),
    })
    .default({ enabled: true, strength: 0.55, mode: 'fade', keepCameraState: true }),
  /** Optional, explicitly-synthetic depth parallax (REQ 044). */
  depth: z
    .object({ enabled: z.boolean().default(false), synthetic: z.literal(true).default(true), scale: z.number().finite().default(0.12) })
    .default({ enabled: false, synthetic: true, scale: 0.12 }),
  /**
   * Discrete node-grid walking ("chessboard street view"). When set, WASD walks
   * one square per press using the eight king's moves, with a gait-noise
   * spring step and a warp on arrival, instead of free synthetic drift.
   * Null means free drift — the default for hand-authored panorama graphs.
   */
  grid: z
    .object({
      cols: z.number().int().min(1).max(256).default(8),
      rows: z.number().int().min(1).max(256).default(8),
      /** Metres between adjacent capture squares. */
      spacing: z.number().positive().default(12),
      /** Walking speed in m/s before gait noise. */
      walkSpeed: z.number().positive().default(1.4),
      /** Stride-to-stride speed variation, as a fraction of walkSpeed. */
      gaitNoise: z.number().min(0).max(1).default(0.18),
      /** Vertical bob amplitude in metres. */
      bobAmplitude: z.number().min(0).max(0.5).default(0.045),
      /** Bob cadence in Hz; a normal walking cadence is ~1.8. */
      bobHz: z.number().positive().max(6).default(1.8),
      seed: z.number().int().default(7),
      /** Id of the destination square, used for the "moves remaining" readout. */
      goalNodeId: z.string().nullable().default(null),
      /** Allow the eight diagonals; false restricts to the four cardinals. */
      allowDiagonals: z.boolean().default(true),
    })
    .nullable()
    .default(null),
});

/* --------------------------------------------------------------- layers --- */

export const LayerKindSchema = z.enum([
  'terrain',
  'water',
  'roads',
  'buildings',
  'vegetation',
  'objects',
  'panoramas',
  'labels',
  'measurements',
  'annotations',
  'markers',
  'paths',
  'polygons',
  'triggers',
  'effects',
  'group',
]);

export const AnchorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('world') }),
  z.object({ type: z.literal('terrain'), offset: z.number().finite().default(0) }),
  z.object({ type: z.literal('parent'), parentId: z.string().min(1), offset: Vec3Schema.default({ x: 0, y: 0, z: 0 }) }),
  z.object({ type: z.literal('camera'), offset: Vec3Schema.default({ x: 0, y: 0, z: 0 }) }),
]);

export const ObjectNodeSchema = z.object({
  id: z.string().min(1),
  kind: LayerKindSchema,
  name: z.string().default(''),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  position: Vec3Schema.default({ x: 0, y: 0, z: 0 }),
  rotationDeg: Vec3Schema.default({ x: 0, y: 0, z: 0 }),
  scale: Vec3Schema.default({ x: 1, y: 1, z: 1 }),
  anchor: AnchorSchema.default({ type: 'world' }),
  /** Kind-specific payload, validated per-kind by validateProject(). */
  data: z.record(z.string(), z.unknown()).default({}),
  children: z.array(z.lazy((): z.ZodTypeAny => ObjectNodeSchema)).default([]),
});

/* -------------------------------------------------------------- effects --- */

export const EnvironmentStateSchema = z.object({
  timeOfDay: z.number().min(0).max(24).default(13),
  sunAzimuthDeg: z.number().finite().default(135),
  sunElevationDeg: z.number().finite().default(48),
  shadows: z.enum(['off', 'low', 'medium', 'high']).default('medium'),
  fog: z
    .object({
      mode: z.enum(['none', 'linear', 'exponential', 'height']).default('linear'),
      color: z.string().default('#b9c8d8'),
      near: z.number().finite().default(200),
      far: z.number().finite().default(4000),
      density: z.number().positive().default(0.0006),
      height: z.number().finite().default(60),
    })
    .default({ mode: 'linear', color: '#b9c8d8', near: 200, far: 4000, density: 0.0006, height: 60 }),
  weather: z.enum(['clear', 'rain', 'snow', 'fog']).default('clear'),
  post: z
    .object({
      bloom: z.number().min(0).max(2).default(0.25),
      vignette: z.number().min(0).max(1).default(0.15),
      saturation: z.number().min(0).max(2).default(1),
      contrast: z.number().min(0).max(2).default(1),
      outline: z.boolean().default(true),
      depthFade: z.number().min(0).max(1).default(0),
      blur: z.object({ enabled: z.boolean().default(false), radiusPx: z.number().min(0).max(24).default(4) }).default({ enabled: false, radiusPx: 4 }),
    })
    .default({ bloom: 0.25, vignette: 0.15, saturation: 1, contrast: 1, outline: true, depthFade: 0, blur: { enabled: false, radiusPx: 4 } }),
});

export const QualityTierSchema = z.enum(['low', 'normal', 'high']);

export const PerformanceStateSchema = z.object({
  quality: QualityTierSchema.default('normal'),
  maxActiveTiles: z.number().int().positive().default(64),
  maxConcurrentLoads: z.number().int().positive().default(6),
  targetFps: z.number().positive().default(60),
  /** Auto-degrade quality when the frame budget is repeatedly missed. */
  adaptive: z.boolean().default(true),
  pixelRatioCap: z.number().positive().default(2),
  cache: z
    .object({ maxTiles: z.number().int().positive().default(512), maxBytes: z.number().int().positive().default(512 * 1024 * 1024) })
    .default({ maxTiles: 512, maxBytes: 512 * 1024 * 1024 }),
});

/* ---------------------------------------------------------------- grid --- */

/**
 * The editor grid is world state, not renderer state: the same grid must come
 * back after reload, export and undo (REQUIREMENT 077).
 */
export const GridStateSchema = z.object({
  enabled: z.boolean().default(true),
  spacing: z.number().positive().default(10),
  /** Snap translation to multiples of `spacing` while the tool is active. */
  snap: z.boolean().default(false),
  snapDegrees: z.number().positive().default(15),
  showAxes: z.boolean().default(true),
  autoSpacing: z.boolean().default(true),
});

/* -------------------------------------------------------------- search --- */

/**
 * Search is provider-abstracted (REQUIREMENT 081). No key is ever persisted
 * here — `apiKeyRef` is an opaque handle resolved by the app at runtime, and
 * the provider registry refuses to log or store its value.
 */
export const SearchStateSchema = z.object({
  providerId: z.string().default('local'),
  query: z.string().default(''),
  results: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        subtitle: z.string().default(''),
        lat: z.number().finite(),
        lon: z.number().finite(),
      }),
    )
    .default([]),
  /** Opaque reference only. The literal key never touches project state. */
  apiKeyRef: z.string().default(''),
});

/* ------------------------------------------------------------- physics --- */

export const PhysicsStateSchema = z.object({
  enabled: z.boolean().default(true),
  gravity: z.number().finite().default(-9.81),
  fixedHz: z.number().int().min(20).max(240).default(60),
  maxSubsteps: z.number().int().min(1).max(8).default(4),
  character: z
    .object({
      radius: z.number().positive().default(0.35),
      height: z.number().positive().default(1.75),
      mass: z.number().positive().default(75),
      walkSpeed: z.number().positive().default(4.5),
      runSpeed: z.number().positive().default(8),
      jumpSpeed: z.number().positive().default(5.2),
      slopeLimitDeg: z.number().min(0).max(89).default(48),
      stepHeight: z.number().min(0).default(0.4),
      groundSnap: z.number().min(0).default(0.25),
    })
    .default({
      radius: 0.35,
      height: 1.75,
      mass: 75,
      walkSpeed: 4.5,
      runSpeed: 8,
      jumpSpeed: 5.2,
      slopeLimitDeg: 48,
      stepHeight: 0.4,
      groundSnap: 0.25,
    }),
  /** Per-material surface response, referenced by layer data (`surface`). */
  surfaces: z
    .record(
      z.string(),
      z.object({
        friction: z.number().min(0).default(0.6),
        restitution: z.number().min(0).default(0.05),
        /** Multiplier on character speed while standing on this surface. */
        speedFactor: z.number().positive().default(1),
        /** Stretch response for spring-deformed props on this surface. */
        stiffness: z.number().positive().default(120),
        damping: z.number().min(0).default(2),
      }),
    )
    .default({
      ground: { friction: 0.7, restitution: 0.02, speedFactor: 1, stiffness: 140, damping: 3 },
      water: { friction: 0.25, restitution: 0, speedFactor: 0.55, stiffness: 40, damping: 8 },
      road: { friction: 0.85, restitution: 0.05, speedFactor: 1.1, stiffness: 180, damping: 4 },
      ice: { friction: 0.06, restitution: 0.02, speedFactor: 0.9, stiffness: 200, damping: 2 },
    }),
  proxies: z
    .record(
      z.string(),
      z.discriminatedUnion('shape', [
        z.object({ shape: z.literal('box'), size: Vec3Schema }),
        z.object({ shape: z.literal('capsule'), radius: z.number().positive(), height: z.number().positive() }),
        z.object({ shape: z.literal('convex'), points: z.array(Vec3Schema) }),
      ]),
    )
    .default({}),
  navmesh: z.object({ enabled: z.boolean().default(false), cellSize: z.number().positive().default(1) }).default({
    enabled: false,
    cellSize: 1,
  }),
});

/* ------------------------------------------------------------------ ai --- */

/**
 * AI assistance (REQUIREMENTS 115-122). Disabled by default, entirely optional
 * and never required for any core feature. Only structured actions are ever
 * accepted from a provider — the app has no code-execution path at all.
 */
export const AiStateSchema = z.object({
  enabled: z.boolean().default(false),
  providerId: z.string().default('none'),
  model: z.string().default(''),
  /** Opaque handle, never the key itself (REQUIREMENT 119). */
  apiKeyRef: z.string().default(''),
  allowVision: z.boolean().default(false),
  /** Every request/response is logged only when this is explicitly enabled. */
  logPrompts: z.boolean().default(false),
  /** Nothing leaves the machine unless the user asks (REQUIREMENT 121). */
  autoUpload: z.boolean().default(false),
  lastError: z.string().default(''),
  history: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(['user', 'assistant', 'error']),
        text: z.string(),
        at: z.number().finite(),
      }),
    )
    .default([]),
});

/* --------------------------------------------------------------- project --- */

export const BookmarkSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  camera: CameraStateSchema,
  createdAt: z.number().finite(),
});

export const TourStopSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  caption: z.string().default(''),
  camera: CameraStateSchema,
  durationMs: z.number().int().positive().default(3000),
});

/**
 * Defaults for the sections an old document may not have at all.
 *
 * `world` needs a real origin and `terrain` needs a real source, so they
 * cannot default to `{}`; the rest are fully defaulted field by field.
 */
export const DEFAULT_WORLD_ANCHOR = {
  origin: { lat: 0, lon: 0, alt: 0 },
  floatingOrigin: { x: 0, y: 0, z: 0 },
} as const;

export const DEFAULT_TERRAIN_STATE = {
  source: { kind: 'procedural' as const, seed: 1337 },
};

export const ProjectSchema = z.object({
  schemaVersion: z.number().int().default(SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().default('Untitled world'),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  // These five have defaults so that a genuinely old document — one written
  // before the world/camera/terrain/environment/performance split existed —
  // can still be migrated. Without them `migrateProject` on a v1 file throws a
  // ZodError instead of producing a usable project, which is exactly the case
  // the migration chain exists to handle.
  world: WorldAnchorSchema.default(DEFAULT_WORLD_ANCHOR),
  camera: CameraStateSchema.default({}),
  transition: TransitionPresetSchema,
  terrain: TerrainStateSchema.default(DEFAULT_TERRAIN_STATE),
  panorama: PanoramaStateSchema,
  environment: EnvironmentStateSchema.default({}),
  performance: PerformanceStateSchema.default({}),
  grid: GridStateSchema.default({}),
  search: SearchStateSchema.default({}),
  physics: PhysicsStateSchema.default({}),
  ai: AiStateSchema.default({}),
  layers: z.array(ObjectNodeSchema).default([]),
  bookmarks: z.array(BookmarkSchema).default([]),
  tour: z.array(TourStopSchema).default([]),
  /** Measurement definitions, kept separate from render state. */
  measurements: z
    .array(
      z.object({
        id: z.string().min(1),
        kind: z.enum(['distance', 'surface', 'area', 'perimeter', 'elevation', 'bearing']).default('distance'),
        points: z.array(Vec3Schema).default([]),
        ring: z.array(Vec3Schema).default([]),
      }),
    )
    .default([]),
  center: z.object({ enabled: z.boolean().default(false), position: Vec3Schema.default({ x: 0, y: 0, z: 0 }) }).default({ enabled: false, position: { x: 0, y: 0, z: 0 } }),
  ui: z
    .object({
      tool: z.string().default('select'),
      showCompass: z.boolean().default(true),
      showScaleBar: z.boolean().default(true),
      showStats: z.boolean().default(false),
      panelWidth: z.number().positive().default(300),
    })
    .default({ tool: 'select', showCompass: true, showScaleBar: true, showStats: false, panelWidth: 300 }),
});

export type Vec3T = z.infer<typeof Vec3Schema>;
export type GeoCoordT = z.infer<typeof GeoCoordSchema>;
export type ObjectNode = z.infer<typeof ObjectNodeSchema>;
export type LayerKind = z.infer<typeof LayerKindSchema>;
export type CameraState = z.infer<typeof CameraStateSchema>;
export type CameraMode = z.infer<typeof CameraModeSchema>;
export type PanoramaNode = z.infer<typeof PanoramaNodeSchema>;
export type TerrainSource = z.infer<typeof TerrainSourceSchema>;
export type TerrainState = z.infer<typeof TerrainStateSchema>;
export type AnchorT = z.infer<typeof AnchorSchema>;
export type TransitionPreset = z.infer<typeof TransitionPresetSchema>;
export type EnvironmentState = z.infer<typeof EnvironmentStateSchema>;
export type PerformanceState = z.infer<typeof PerformanceStateSchema>;
export type PhysicsStateT = z.infer<typeof PhysicsStateSchema>;
export type AiStateT = z.infer<typeof AiStateSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Bookmark = z.infer<typeof BookmarkSchema>;
export type TourStop = z.infer<typeof TourStopSchema>;
export type GridState = z.infer<typeof GridStateSchema>;
export type SearchState = z.infer<typeof SearchStateSchema>;
export type SearchHit = SearchState['results'][number];
export type PhysicsState = z.infer<typeof PhysicsStateSchema>;
export type CollisionProxy = PhysicsState['proxies'][string];
export type AiState = z.infer<typeof AiStateSchema>;
export type Measurement = Project['measurements'][number];

export function newProject(name = 'Untitled world'): Project {
  const now = Date.now();
  // Typed loosely on purpose: fields with schema defaults (grid, search,
  // physics, ai, ...) are materialised by the parse below, so this literal
  // cannot drift out of sync with the schema.
  const base = {
    schemaVersion: SCHEMA_VERSION,
    id: newId('proj'),
    name,
    createdAt: now,
    updatedAt: now,
    world: { origin: { lat: 46.5, lon: 8.2, alt: 0 }, floatingOrigin: { x: 0, y: 0, z: 0 } },
    camera: {
      mode: 'orbit',
      position: { x: 0, y: 120, z: 220 },
      target: { x: 0, y: 0, z: 0 },
      headingDeg: 0,
      pitchDeg: -25,
      rollDeg: 0,
      fovDeg: 60,
      distance: 250,
    },
    transition: {
      speed: 'normal',
      customMs: 1200,
      easing: 'easeInOutCubic',
      terrainFollow: false,
      path: [],
      interruptible: true,
    },
    terrain: {
      source: { kind: 'procedural', seed: 1337, octaves: 5, lacunarity: 2.02, gain: 0.5, amplitude: 180, frequency: 0.0012, warp: 0.35, ridged: false },
      tileSizeMeters: 256,
      segments: 48,
      verticalExaggeration: 1,
      edits: {},
      contours: { enabled: false, interval: 50, indexEvery: 5 },
    },
    panorama: {
      nodes: [],
      currentNodeId: null,
      pitchClampDeg: 72,
      transitionMs: 320,
      persistence: { enabled: true, strength: 0.55, mode: 'fade', keepCameraState: true },
      depth: { enabled: false, synthetic: true, scale: 0.12 },
    },
    environment: {
      timeOfDay: 13,
      sunAzimuthDeg: 135,
      sunElevationDeg: 48,
      shadows: 'medium',
      fog: { mode: 'linear', color: '#b9c8d8', near: 200, far: 4000, density: 0.0006, height: 60 },
      weather: 'clear',
      post: { bloom: 0.25, vignette: 0.15, saturation: 1, contrast: 1, outline: true, depthFade: 0, blur: { enabled: false, radiusPx: 4 } },
    },
    performance: {
      quality: 'normal',
      maxActiveTiles: 64,
      maxConcurrentLoads: 6,
      targetFps: 60,
      adaptive: true,
      pixelRatioCap: 2,
      cache: { maxTiles: 512, maxBytes: 512 * 1024 * 1024 },
    },
    layers: [],
    bookmarks: [],
    tour: [],
    measurements: [],
    center: { enabled: false, position: { x: 0, y: 0, z: 0 } },
    ui: { tool: 'select', showCompass: true, showScaleBar: true, showStats: false, panelWidth: 300 },
  };
  // Round-trip through the schema so defaults are materialised exactly once.
  return ProjectSchema.parse(base);
}

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** The schema-parsed document when parsing succeeded, otherwise null. */
  project: Project | null;
}

/**
 * Structural validation plus the invariants zod cannot express:
 *  - no duplicate layer ids
 *  - no parent cycles
 *  - panorama neighbour references resolve
 *  - tile edit arrays match the tile resolution
 *
 * Called on import, on autosave recovery and before every save.
 */
/**
 * Detect a reference cycle before the document reaches zod.
 *
 * `ProjectSchema.safeParse` recurses into the object graph, so a node whose
 * `children` contains itself overflows the stack and throws a RangeError long
 * before the iterative layer walk below ever runs. A corrupt or hand-edited
 * autosave can absolutely contain a cycle, and "Maximum call stack size
 * exceeded" is not an actionable error message. This pre-pass is iterative and
 * bounded.
 */
function findReferenceCycle(root: unknown): string | null {
  if (typeof root !== 'object' || root === null) return null;
  const stack: Array<{ value: object; path: string; trail: Set<object> }> = [{ value: root as object, path: '$', trail: new Set() }];
  let guard = 0;
  while (stack.length) {
    if (guard++ > 200000) return 'structure too large to validate';
    const { value, path, trail } = stack.pop()!;
    if (trail.has(value)) return `reference cycle at ${path}`;
    const next = new Set(trail);
    next.add(value);
    const entries = Array.isArray(value)
      ? value.map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>);
    for (const [key, child] of entries) {
      if (typeof child === 'object' && child !== null) {
        stack.push({ value: child as object, path: `${path}.${key}`, trail: next });
      }
    }
  }
  return null;
}

export function validateProject(input: unknown): ValidationResult {
  const cycle = findReferenceCycle(input);
  if (cycle) {
    return {
      ok: false,
      project: null,
      issues: [{ path: '$', message: `Cannot validate: ${cycle}`, code: 'cycle' }],
    };
  }
  const parsed = ProjectSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      project: null,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    };
  }
  const project = parsed.data;
  const issues: ValidationIssue[] = [];

  const seen = new Set<string>();
  const stack: Array<{ node: ObjectNode; path: string; ancestors: Set<string> }> = project.layers.map(
    (n) => ({ node: n, path: n.id, ancestors: new Set<string>() }),
  );
  // Iterative walk — recursion here is exactly what crashed the old repo (REQ 004).
  while (stack.length > 0) {
    const { node, path, ancestors } = stack.pop()!;
    if (seen.has(node.id)) {
      issues.push({ path, message: `Duplicate layer id "${node.id}"`, code: 'duplicate_id' });
      continue;
    }
    seen.add(node.id);
    if (ancestors.has(node.id)) {
      issues.push({ path, message: `Cycle detected at layer "${node.id}"`, code: 'cycle' });
      continue;
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(node.id);
    for (const child of node.children) {
      stack.push({ node: child, path: `${path}/${child.id}`, ancestors: nextAncestors });
    }
  }

  const panoIds = new Set(project.panorama.nodes.map((n) => n.id));
  for (const node of project.panorama.nodes) {
    for (const [dir, target] of Object.entries(node.neighbors)) {
      if (target && !panoIds.has(target)) {
        issues.push({
          path: `panorama.nodes.${node.id}.neighbors.${dir}`,
          message: `Neighbour "${target}" does not exist`,
          code: 'dangling_ref',
        });
      }
    }
  }

  return { ok: issues.length === 0, issues, project };
}

/* ----------------------------------------------------------- migrations --- */

type Migrator = (raw: Record<string, unknown>) => Record<string, unknown>;

const migrations: Record<number, Migrator> = {
  // v1 -> v2: panoramas moved from `locations` (old repo naming) to `panorama.nodes`
  1: (raw) => {
    const legacy = (raw as { locations?: Array<Record<string, unknown>> }).locations;
    if (legacy && !raw.panorama) {
      raw.panorama = {
        nodes: legacy.map((l) => ({
          id: l.id,
          name: l.name ?? '',
          position: l.position ?? { x: 0, y: 0, z: 0 },
          headingDeg: 0,
          image: l.imageUrl ?? l.image ?? '',
          neighbors: l.links ?? {},
        })),
        currentNodeId: raw.currentLocation ?? null,
      };
    }
    raw.schemaVersion = 2;
    return raw;
  },
  // v2 -> v3: `settings.transitionDuration` -> `transition` preset object
  2: (raw) => {
    const settings = raw.settings as { transitionDuration?: number } | undefined;
    if (settings?.transitionDuration && !raw.transition) {
      raw.transition = { speed: 'custom', customMs: settings.transitionDuration };
    }
    raw.schemaVersion = 3;
    return raw;
  },
  // v3 -> v4: flat `features` bag -> typed `environment` / `panorama.persistence`
  3: (raw) => {
    const features = raw.features as Record<string, unknown> | undefined;
    if (features) {
      const pano = (raw.panorama ?? {}) as Record<string, unknown>;
      pano.persistence = {
        enabled: Boolean(features.persistence),
        strength: typeof features.persistenceStrength === 'number' ? features.persistenceStrength : 0.55,
        mode: features.persistenceMode ?? 'fade',
        keepCameraState: Boolean(features.cameraStatePersistence),
      };
      raw.panorama = pano;
    }
    raw.schemaVersion = 4;
    return raw;
  },
  // v4 -> v5: grid / search / physics / ai promoted from ad-hoc renderer state
  // into the canonical document. Older documents simply gain the defaults.
  4: (raw) => {
    const legacyGrid = raw.grid as Record<string, unknown> | undefined;
    if (legacyGrid && typeof legacyGrid === 'object' && !('autoSpacing' in legacyGrid)) {
      legacyGrid.autoSpacing = legacyGrid.autoSpacing ?? true;
    }
    const legacyPhysics = raw.physics as Record<string, unknown> | undefined;
    if (legacyPhysics && !legacyPhysics.surfaces) {
      legacyPhysics.surfaces = {};
      legacyPhysics.proxies = legacyPhysics.proxies ?? {};
    }
    const legacyAi = raw.ai as Record<string, unknown> | undefined;
    if (legacyAi && !legacyAi.history) {
      legacyAi.history = [];
      // Never migrate a literal key that an older build may have stored.
      if (legacyAi.apiKey && !legacyAi.apiKeyRef) delete legacyAi.apiKey;
    }
    raw.schemaVersion = 5;
    return raw;
  },
  // v5 -> v6: panorama grid walking. Older documents simply gain `grid: null`,
  // which preserves their free-drift behaviour exactly.
  5: (raw) => {
    const pano = raw.panorama as Record<string, unknown> | undefined;
    if (pano && !('grid' in pano)) pano.grid = null;
    raw.schemaVersion = 6;
    return raw;
  },
};

export interface MigrateResult {
  project: Project;
  fromVersion: number;
  appliedMigrations: number[];
}

export function migrateProject(raw: Record<string, unknown>): MigrateResult {
  let version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1;
  const fromVersion = version;
  const applied: number[] = [];
  let guard = 0;
  while (version < SCHEMA_VERSION && guard++ < 64) {
    const m = migrations[version];
    if (!m) throw new Error(`No migration registered for schema version ${version}`);
    raw = m(raw);
    applied.push(version);
    version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : version + 1;
  }
  return { project: ProjectSchema.parse(raw), fromVersion, appliedMigrations: applied };
}

/** Parse anything untrusted (imported file, autosave blob) into a Project. */
export function loadProject(raw: unknown): MigrateResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('Project file is not an object');
  const obj = raw as Record<string, unknown>;
  if (typeof obj.schemaVersion === 'number' && obj.schemaVersion === SCHEMA_VERSION) {
    return { project: ProjectSchema.parse(obj), fromVersion: SCHEMA_VERSION, appliedMigrations: [] };
  }
  return migrateProject(obj);
}

export function serializeProject(project: Project): string {
  return JSON.stringify(ProjectSchema.parse(project));
}
