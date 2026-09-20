/**
 * packages/terrain — TerrainEngine: tiles, LOD, sculpting and queries
 * (REQUIREMENT 009, 010, 011, 047, 096).
 *
 * The engine owns the set of loaded Heightfields, streams tiles on demand with
 * priority, keeps edited tiles protected, and answers height/normal/slope
 * queries for the whole world. Mesh building is pushed to the terrain worker;
 * the main thread only receives finished typed arrays.
 */
import { Heightfield } from './heightfield';
import { generateHeightfield, type TerrainSource } from './generator';
import { buildTerrainMesh, type TerrainMeshData, terrainMeshBytes } from './mesh';
import { applyStroke, type BrushParams, type BrushResult } from './sculpt';
import { LruCache, TileManager, selectTerrainTiles, terrainRoots, type TerrainLodTile } from '@3dmm/performance';

export interface TerrainEngineOptions {
  /** Total world footprint, metres. */
  worldSize: number;
  /** Tile edge in metres. */
  tileSize: number;
  /** Grid vertices per tile edge. */
  segments: number;
  source: TerrainSource;
  maxTiles?: number;
  maxConcurrentLoads?: number;
  /** Vertical exaggeration for mesh building only. */
  verticalExaggeration?: number;
  onTileReady?: (key: string, mesh: TerrainMeshData) => void;
  onTileEvicted?: (key: string) => void;
  onTileFailed?: (key: string, error: string) => void;
  /** Optional worker transport; when absent, generation runs inline. */
  worker?: TerrainWorkerTransport | null;
}

export interface TerrainWorkerTransport {
  /** Ask the worker to build a tile mesh. Must reject on abort. */
  buildMesh(request: TileMeshRequest, signal: AbortSignal): Promise<TileMeshResponse>;
}

export interface TileMeshRequest {
  key: string;
  z: number;
  x: number;
  y: number;
  resolution: number;
  size: number;
  originX: number;
  originY: number;
  source: TerrainSource;
  edits: Record<string, number>;
  verticalExaggeration: number;
  borderStepMeters: number;
  skirtMeters: number;
  generation: number;
}

export interface TileMeshResponse {
  key: string;
  generation: number;
  mesh: TerrainMeshData;
  heightfield: { data: number[]; resolution: number; size: number; originX: number; originY: number };
  buildMs: number;
}

export interface TerrainTile {
  key: string;
  z: number;
  x: number;
  y: number;
  heightfield: Heightfield;
  mesh: TerrainMeshData | null;
  dirty: boolean;
  protected: boolean;
  edited: boolean;
}

/** Which tiles are currently wanted, with priority for the frame scheduler. */
export interface TerrainWantedTile {
  key: string;
  priority: number;
}

export class TerrainEngine {
  private opts: Required<Omit<TerrainEngineOptions, 'onTileReady' | 'onTileEvicted' | 'onTileFailed' | 'worker'>> &
    Pick<TerrainEngineOptions, 'onTileReady' | 'onTileEvicted' | 'onTileFailed' | 'worker'>;
  private tiles = new Map<string, TerrainTile>();
  private cache: LruCache<TerrainMeshData>;
  private manager: TileManager<TerrainTile>;
  private edits = new Map<string, Record<string, number>>();
  private generation = 0;
  private heightQueries = 0;
  private sculpts = 0;
  private _verticalExaggeration: number;

  constructor(options: TerrainEngineOptions) {
    this.opts = {
      worldSize: options.worldSize,
      tileSize: options.tileSize,
      segments: options.segments,
      source: options.source,
      maxTiles: options.maxTiles ?? 96,
      maxConcurrentLoads: options.maxConcurrentLoads ?? 4,
      verticalExaggeration: options.verticalExaggeration ?? 1,
      onTileReady: options.onTileReady,
      onTileEvicted: options.onTileEvicted,
      onTileFailed: options.onTileFailed,
      worker: options.worker ?? null,
    };
    this._verticalExaggeration = options.verticalExaggeration ?? 1;

    this.cache = new LruCache<TerrainMeshData>({
      maxEntries: this.opts.maxTiles * 2,
      maxBytes: 384 * 1024 * 1024,
      onEvict: (e) => this.opts.onTileEvicted?.(e.key),
    });

    this.manager = new TileManager<TerrainTile>((key, signal) => this.loadTile(key, signal), {
      maxConcurrent: this.opts.maxConcurrentLoads,
      maxActive: this.opts.maxTiles,
      coolingMs: 6000,
      maxAttempts: 2,
      onDispose: (key) => {
        this.tiles.delete(key);
        this.opts.onTileEvicted?.(key);
      },
    });
  }

  get stats() {
    return {
      ...this.manager.stats,
      cache: this.cache.stats,
      tiles: this.tiles.size,
      heightQueries: this.heightQueries,
      sculpts: this.sculpts,
      generation: this.generation,
    };
  }

  get verticalExaggeration(): number {
    return this._verticalExaggeration;
  }

  /**
   * Vertical exaggeration is a *render* transform (REQUIREMENT 052): it rebuilds
   * meshes but never touches the stored heights, so measurements stay true.
   */
  setVerticalExaggeration(v: number): void {
    const next = Math.max(0.01, v);
    if (Math.abs(next - this._verticalExaggeration) < 1e-6) return;
    this._verticalExaggeration = next;
    for (const t of this.tiles.values()) {
      t.mesh = buildTerrainMesh(t.heightfield, this.meshOptions(t));
      t.dirty = false;
      this.cache.set(t.key, t.mesh, terrainMeshBytes(t.mesh), { pinned: t.protected });
      this.opts.onTileReady?.(t.key, t.mesh);
    }
  }

  setSource(source: TerrainSource): void {
    this.opts.source = source;
    // Existing authored edits survive a source change; the base does not.
    this.manager.reset();
    this.cache.clear();
    this.tiles.clear();
  }

  setQuality(maxTiles: number, maxConcurrent: number): void {
    this.opts.maxTiles = maxTiles;
    this.opts.maxConcurrentLoads = maxConcurrent;
  }

  private meshOptions(t: TerrainTile) {
    return {
      verticalExaggeration: this._verticalExaggeration,
      // stitch to the parent tile's grid so mixed LOD borders never crack
      borderStepMeters: t.z === 0 ? 0 : this.opts.tileSize / Math.pow(2, t.z) / (this.opts.segments - 1),
      skirtMeters: Math.max(2, this.opts.tileSize / 64),
      withNormals: true,
      withSlope: true,
    };
  }

  private tileGeometry(key: string): { z: number; x: number; y: number; originX: number; originY: number; size: number } | null {
    const m = /^(\d+)\/(-?\d+)\/(-?\d+)$/.exec(key);
    if (!m) return null;
    const z = +m[1];
    const x = +m[2];
    const y = +m[3];
    const size = this.opts.tileSize / Math.pow(2, z);
    const half = this.opts.worldSize / 2;
    return {
      z,
      x,
      y,
      size,
      originX: -half + x * size,
      originY: -half + y * size,
    };
  }

  private async loadTile(key: string, signal: AbortSignal): Promise<TerrainTile> {
    const geo = this.tileGeometry(key);
    if (!geo) throw new Error(`Invalid terrain tile key "${key}"`);
    const resolution = this.opts.segments;
    const edits = this.edits.get(key) ?? {};

    if (this.opts.worker) {
      const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const res = await this.opts.worker.buildMesh(
        {
          key,
          z: geo.z,
          x: geo.x,
          y: geo.y,
          resolution,
          size: geo.size,
          originX: geo.originX,
          originY: geo.originY,
          source: this.opts.source,
          edits,
          verticalExaggeration: this._verticalExaggeration,
          borderStepMeters: geo.z === 0 ? 0 : geo.size / (resolution - 1),
          skirtMeters: Math.max(2, geo.size / 64),
          generation: this.generation,
        },
        signal,
      );
      // A stale response must never overwrite current state (REQUIREMENT 127).
      if (res.generation !== this.generation) throw new DOMException('stale tile', 'AbortError');
      const hf = new Heightfield(
        res.heightfield.resolution,
        res.heightfield.size,
        res.heightfield.originX,
        res.heightfield.originY,
        Float32Array.from(res.heightfield.data),
      );
      const tile: TerrainTile = {
        key,
        z: geo.z,
        x: geo.x,
        y: geo.y,
        heightfield: hf,
        mesh: res.mesh,
        dirty: false,
        protected: Boolean(edits && Object.keys(edits).length),
        edited: Object.keys(edits).length > 0,
      };
      void started;
      this.tiles.set(key, tile);
      this.cache.set(key, res.mesh, terrainMeshBytes(res.mesh), { pinned: tile.protected });
      if (tile.protected) this.manager.protect(key, true);
      this.opts.onTileReady?.(key, res.mesh);
      return tile;
    }

    // Inline path (used by tests, workers and the first frame).
    const hf = generateHeightfield({
      source: this.opts.source,
      resolution,
      size: geo.size,
      originX: geo.originX,
      originY: geo.originY,
      edits,
    }, signal);
    const mesh = buildTerrainMesh(hf, this.meshOptions({ key, ...geo, heightfield: hf, mesh: null, dirty: false, protected: false, edited: false }));
    const tile: TerrainTile = {
      key,
      z: geo.z,
      x: geo.x,
      y: geo.y,
      heightfield: hf,
      mesh,
      dirty: false,
      protected: Object.keys(edits).length > 0,
      edited: Object.keys(edits).length > 0,
    };
    this.tiles.set(key, tile);
    this.cache.set(key, mesh, terrainMeshBytes(mesh), { pinned: tile.protected });
    if (tile.protected) this.manager.protect(key, true);
    this.opts.onTileReady?.(key, mesh);
    return tile;
  }

  /** Root tiles for the LOD walk. */
  roots(): TerrainLodTile[] {
    const n = Math.max(1, Math.round(this.opts.worldSize / this.opts.tileSize));
    const half = this.opts.worldSize / 2;
    const out: TerrainLodTile[] = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        out.push({
          key: `0/${x}/${y}`,
          z: 0,
          x,
          y,
          center: { x: -half + (x + 0.5) * this.opts.tileSize, y: 0, z: -half + (y + 0.5) * this.opts.tileSize },
          size: this.opts.tileSize,
          geometricError: this.opts.tileSize / 2,
        });
      }
    }
    return out;
  }

  /** Per-frame update. Pass the camera basis used for SSE. */
  update(camera: { position: { x: number; y: number; z: number }; fovDeg: number; viewportHeightPx: number }, maxSse = 12): void {
    this.generation++;
    const { toLoad, toDraw } = selectTerrainTiles(
      this.roots(),
      {
        position: camera.position,
        fovDeg: camera.fovDeg,
        viewportHeightPx: camera.viewportHeightPx,
        near: 0.2,
      },
      (key) => this.tiles.get(key)?.mesh != null,
      { maxScreenSpaceError: maxSse, hysteresis: 0.25, maxDistance: this.opts.worldSize * 2 },
      this.opts.maxTiles,
    );
    const wanted: TerrainWantedTile[] = toLoad.map((t, i) => ({ key: t.key, priority: toLoad.length - i }));
    for (const t of toDraw) if (!wanted.some((w) => w.key === t.key)) wanted.push({ key: t.key, priority: 0.5 });
    this.manager.update(wanted);
    this.manager.gc();
  }

  getTile(key: string): TerrainTile | null {
    return this.tiles.get(key) ?? null;
  }

  tileKeys(): string[] {
    return [...this.tiles.keys()];
  }

  /** Highest-resolution loaded height at a local position, or null. */
  heightAt(x: number, y: number): number | null {
    this.heightQueries++;
    let best: Heightfield | null = null;
    for (const t of this.tiles.values()) {
      if (!t.heightfield.contains(x, y)) continue;
      if (!best || t.heightfield.resolution > best.resolution) best = t.heightfield;
    }
    return best ? best.sample(x, y) : null;
  }

  normalAt(x: number, y: number, out = { x: 0, y: 1, z: 0 }): { x: number; y: number; z: number } {
    let best: Heightfield | null = null;
    for (const t of this.tiles.values()) {
      if (!t.heightfield.contains(x, y)) continue;
      if (!best || t.heightfield.resolution > best.resolution) best = t.heightfield;
    }
    if (!best) return out;
    const n = best.normalAt(x, y);
    // engine space is Y-up, heightfield space is Z-up
    out.x = n.x;
    out.y = n.z;
    out.z = n.y;
    return out;
  }

  slopeAt(x: number, y: number): number {
    let best: Heightfield | null = null;
    for (const t of this.tiles.values()) {
      if (!t.heightfield.contains(x, y)) continue;
      if (!best || t.heightfield.resolution > best.resolution) best = t.heightfield;
    }
    return best ? best.slopeAt(x, y) : 0;
  }

  /**
   * Sculpt at a local position (engine XZ == heightfield XY).
   * Marks the tile dirty, re-meshes it, and records absolute edits so the
   * sculpt survives regeneration and save/reload (HARDENING CHECK 004).
   */
  sculpt(x: number, y: number, from: { x: number; y: number } | null, params: BrushParams): BrushResult | null {
    let hit: TerrainTile | null = null;
    for (const t of this.tiles.values()) {
      if (!t.heightfield.contains(x, y)) continue;
      if (!hit || t.heightfield.resolution > hit.heightfield.resolution) hit = t;
    }
    if (!hit) return null;
    this.sculpts++;

    const hf = hit.heightfield;
    const res = from
      ? applyStroke(hf, { x: from.x, y: from.y }, { x, y }, params)
      : applyStroke(hf, { x, y }, { x, y }, params);
    if (!res.changed) return res;

    hit.edited = true;
    hit.protected = true;
    hit.dirty = true;
    this.manager.protect(hit.key, true);

    // Record absolute elevations for the touched band so the edit is durable.
    const existing = this.edits.get(hit.key) ?? {};
    const r = hf.resolution;
    for (let gy = res.minY; gy <= res.maxY; gy++) {
      for (let gx = res.minX; gx <= res.maxX; gx++) {
        existing[String(gy * r + gx)] = hf.data[gy * r + gx];
      }
    }
    this.edits.set(hit.key, existing);

    hit.mesh = buildTerrainMesh(hf, this.meshOptions(hit));
    hit.dirty = false;
    this.cache.set(hit.key, hit.mesh, terrainMeshBytes(hit.mesh), { pinned: true });
    this.opts.onTileReady?.(hit.key, hit.mesh);

    // Neighbours that share a border vertex need a re-mesh too, otherwise the
    // border quantisation drifts and a seam appears.
    for (const [key, t] of this.tiles) {
      if (key === hit.key) continue;
      if (!this.sharesBorder(hit, t)) continue;
      t.mesh = buildTerrainMesh(t.heightfield, this.meshOptions(t));
      this.cache.set(key, t.mesh, terrainMeshBytes(t.mesh), { pinned: t.protected });
      this.opts.onTileReady?.(key, t.mesh);
    }
    return res;
  }

  private sharesBorder(a: TerrainTile, b: TerrainTile): boolean {
    if (a.z !== b.z) return false;
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
  }

  /** All authored edits, in the shape stored in the project document. */
  exportEdits(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [k, v] of this.edits) if (Object.keys(v).length) out[k] = { ...v };
    return out;
  }

  importEdits(edits: Record<string, Record<string, number>> | Record<string, number[]>): void {
    this.edits = new Map();
    for (const [key, value] of Object.entries(edits)) {
      this.edits.set(key, Array.isArray(value) ? Object.fromEntries(value.map((v, i) => [String(i), v])) : { ...(value as Record<string, number>) });
    }
  }

  /** Regenerate every loaded tile from the current source + edits. */
  rebuildAll(): number {
    let n = 0;
    this.generation++;
    for (const [key, tile] of this.tiles) {
      const geo = this.tileGeometry(key)!;
      const hf = generateHeightfield({
        source: this.opts.source,
        resolution: this.opts.segments,
        size: geo.size,
        originX: geo.originX,
        originY: geo.originY,
        edits: this.edits.get(key),
      });
      tile.heightfield = hf;
      tile.mesh = buildTerrainMesh(hf, this.meshOptions(tile));
      tile.dirty = false;
      this.cache.set(key, tile.mesh, terrainMeshBytes(tile.mesh), { pinned: tile.protected });
      this.opts.onTileReady?.(key, tile.mesh);
      n++;
    }
    return n;
  }

  dispose(): void {
    this.manager.reset();
    this.cache.clear();
    this.tiles.clear();
    this.edits.clear();
  }
}

export { Heightfield, buildTerrainMesh, generateHeightfield, applyStroke };
export type { TerrainMeshData };
export { terrainMeshBytes };
