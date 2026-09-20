/**
 * packages/performance — screen-space-error LOD selection (REQUIREMENT 011).
 *
 * A node is refined when its projected geometric error in pixels exceeds the
 * target SSE. Hysteresis (`refineThreshold` vs `coarsenThreshold`) prevents the
 * classic pop-in/pop-out oscillation at a fixed camera distance.
 */

export interface LodCamera {
  /** Camera position in the same space as the node positions. */
  position: { x: number; y: number; z: number };
  /** Vertical field of view, degrees. */
  fovDeg: number;
  /** Viewport height in pixels. */
  viewportHeightPx: number;
  /** near plane */
  near: number;
}

export interface LodNode {
  key: string;
  position: { x: number; y: number; z: number };
  /** Bounding sphere radius in world metres. */
  radius: number;
  /** Geometric error of THIS level in metres (error if you render this node). */
  geometricError: number;
}

export interface LodOptions {
  /** Refine when SSE exceeds this. */
  maxScreenSpaceError?: number;
  /** Hysteresis band, as a fraction of maxScreenSpaceError. */
  hysteresis?: number;
  /** Never refine beyond this many metres of distance. */
  maxRefineDistance?: number;
  /** Never render beyond this distance. */
  maxDistance?: number;
}

/**
 * Projected geometric error in pixels for a node at `distance`.
 * This is the same formula Cesium / deck.gl TerrainLayer use.
 */
export function screenSpaceError(node: LodNode, camera: LodCamera, distance: number): number {
  const d = Math.max(camera.near, distance);
  const fovRad = (camera.fovDeg * Math.PI) / 180;
  const sseDenom = 2 * Math.tan(fovRad / 2);
  return (node.geometricError * camera.viewportHeightPx) / (d * sseDenom);
}

export type LodDecision = 'refine' | 'render' | 'cull';

/**
 * Decide what to do with a node. `currentlyRefined` is the previous frame's
 * decision for the same node — that is what makes hysteresis stateful and
 * therefore real rather than a comment.
 */
export function selectLod(
  node: LodNode,
  camera: LodCamera,
  opts: LodOptions = {},
  currentlyRefined = false,
): LodDecision {
  const maxSse = opts.maxScreenSpaceError ?? 8;
  const hysteresis = opts.hysteresis ?? 0.25;
  const maxDistance = opts.maxDistance ?? Infinity;
  const maxRefineDistance = opts.maxRefineDistance ?? Infinity;

  const dx = node.position.x - camera.position.x;
  const dy = node.position.y - camera.position.y;
  const dz = node.position.z - camera.position.z;
  const distance = Math.hypot(dx, dy, dz) - node.radius;

  if (distance > maxDistance) return 'cull';
  if (node.geometricError <= 0) return 'render'; // leaf

  const sse = screenSpaceError(node, camera, distance);
  // Wider band when we are already refined, so we do not oscillate.
  const threshold = currentlyRefined ? maxSse * (1 - hysteresis) : maxSse * (1 + hysteresis);

  if (sse > threshold && distance < maxRefineDistance) return 'refine';
  return 'render';
}

/* --------------------------------------------------- terrain LOD pyramid --- */

export interface TerrainLodTile {
  key: string;
  z: number;
  x: number;
  y: number;
  center: { x: number; y: number; z: number };
  size: number;
  geometricError: number;
}

/**
 * Build the terrain tile quadtree for a single frame, top-down, stopping when
 * SSE is acceptable. Returns the tile set to load plus the tiles to actually
 * draw (a parent stays drawn until its children are ready).
 *
 * `isReady` lets the caller keep coarse parents visible — that is what stops
 * holes appearing during a tile storm (HARDENING CHECK 007).
 */
export function selectTerrainTiles(
  rootTiles: ReadonlyArray<TerrainLodTile>,
  camera: LodCamera,
  isReady: (key: string) => boolean,
  opts: LodOptions = {},
  maxTiles = 512,
): { toLoad: TerrainLodTile[]; toDraw: TerrainLodTile[] } {
  const toLoad: TerrainLodTile[] = [];
  const toDraw: TerrainLodTile[] = [];
  const stack: TerrainLodTile[] = [...rootTiles];
  let guard = 0;

  while (stack.length && guard++ < 100000) {
    const tile = stack.pop()!;
    if (toDraw.length >= maxTiles) {
      toDraw.push(tile);
      continue;
    }
    const decision = selectLod(
      { key: tile.key, position: tile.center, radius: tile.size * 0.7071, geometricError: tile.geometricError },
      camera,
      opts,
      isReady(tile.key),
    );
    if (decision === 'cull') continue;
    if (decision === 'render') {
      toDraw.push(tile);
      if (!isReady(tile.key)) toLoad.push(tile);
      continue;
    }
    // refine
    const children = terrainChildren(tile);
    const allReady = children.every((c) => isReady(c.key));
    if (allReady) {
      for (const c of children) stack.push(c);
    } else {
      // Keep the parent on screen; request the children.
      toDraw.push(tile);
      for (const c of children) if (!isReady(c.key)) toLoad.push(c);
    }
  }

  return { toLoad, toDraw };
}

export function terrainChildren(t: TerrainLodTile): TerrainLodTile[] {
  const z = t.z + 1;
  const half = t.size / 2;
  const out: TerrainLodTile[] = [];
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const x = t.x * 2 + dx;
      const y = t.y * 2 + dy;
      out.push({
        key: `${z}/${x}/${y}`,
        z,
        x,
        y,
        center: {
          x: t.center.x - t.size / 2 + half * (dx + 0.5),
          y: t.center.y,
          z: t.center.z - t.size / 2 + half * (dy + 0.5),
        },
        size: half,
        geometricError: t.geometricError / 2,
      });
    }
  }
  return out;
}

/** Root tiles covering a square world footprint of `worldSize` metres. */
export function terrainRoots(worldSize: number, tileSize: number, elevation = 0): TerrainLodTile[] {
  const n = Math.max(1, Math.round(worldSize / tileSize));
  const rootSize = tileSize * n;
  const roots: TerrainLodTile[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      roots.push({
        key: `0/${x}/${y}`,
        z: 0,
        x,
        y,
        center: {
          x: -rootSize / 2 + tileSize * (x + 0.5),
          y: elevation,
          z: -rootSize / 2 + tileSize * (y + 0.5),
        },
        size: tileSize,
        geometricError: tileSize / 2,
      });
    }
  }
  return roots;
}
