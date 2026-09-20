/**
 * workers/terrain.worker.ts — off-main-thread terrain generation and meshing
 * (REQUIREMENT 007, 050).
 *
 * The worker owns the heavy numeric work: heightfield generation, mesh
 * construction, hillshade, slope/aspect/curvature rasters, contour extraction
 * and elevation profiles. Every message carries a `requestId` and a
 * `generation`; results whose generation no longer matches are dropped by the
 * client instead of being applied (REQUIREMENT 127).
 */
import {
  Heightfield,
  generateHeightfield,
  buildTerrainMesh,
  terrainMeshBytes,
  hillshade,
  slopeRaster,
  aspectRaster,
  extractContours,
  elevationProfile,
  defaultHillshade,
  type TerrainSource,
} from '@3dmm/terrain';

export interface WorkerRequestBase {
  requestId: number;
  generation: number;
}

export interface BuildMeshRequest extends WorkerRequestBase {
  type: 'build-mesh';
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
}

export interface SculptRequest extends WorkerRequestBase {
  type: 'sculpt';
  key: string;
  resolution: number;
  size: number;
  originX: number;
  originY: number;
  source: TerrainSource;
  edits: Record<string, number>;
  brush: {
    tool: string;
    radius: number;
    strength: number;
    falloff: number;
    hardness: number;
    noiseAmount: number;
    terraceStep: number;
    target: number;
    symmetry: 'none' | 'x' | 'y' | 'both';
    stampProfile: 'cone' | 'dome' | 'bell' | 'mesa' | 'trench';
    dt: number;
    seed: number;
  };
  points: Array<{ x: number; y: number }>;
  verticalExaggeration: number;
  borderStepMeters: number;
  skirtMeters: number;
}

export interface AnalysisRequest extends WorkerRequestBase {
  type: 'analysis';
  kind: 'hillshade' | 'slope' | 'aspect' | 'contours' | 'profile';
  resolution: number;
  size: number;
  originX: number;
  originY: number;
  source: TerrainSource;
  edits: Record<string, number>;
  options: Record<string, unknown>;
}

export interface CancelRequest {
  type: 'cancel';
  requestId: number;
}

export type WorkerRequest = BuildMeshRequest | SculptRequest | AnalysisRequest | CancelRequest;

const cancelled = new Set<number>();

function reply(message: unknown, transfers: Transferable[] = []): void {
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(message, transfers);
}

function makeHeightfield(
  resolution: number,
  size: number,
  originX: number,
  originY: number,
  source: TerrainSource,
  edits: Record<string, number>,
): Heightfield {
  return generateHeightfield({ source, resolution, size, originX, originY, edits });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  if (req.type === 'cancel') {
    cancelled.add(req.requestId);
    return;
  }

  const started = performance.now();
  try {
    if (cancelled.has(req.requestId)) {
      cancelled.delete(req.requestId);
      reply({ requestId: req.requestId, cancelled: true });
      return;
    }

    if (req.type === 'build-mesh') {
      const hf = makeHeightfield(req.resolution, req.size, req.originX, req.originY, req.source, req.edits);
      const mesh = buildTerrainMesh(hf, {
        verticalExaggeration: req.verticalExaggeration,
        borderStepMeters: req.borderStepMeters,
        skirtMeters: req.skirtMeters,
        withNormals: true,
        withSlope: true,
      });
      if (cancelled.has(req.requestId)) {
        cancelled.delete(req.requestId);
        reply({ requestId: req.requestId, cancelled: true });
        return;
      }
      const hfData = Array.from(hf.data);
      reply(
        {
          requestId: req.requestId,
          generation: req.generation,
          key: req.key,
          mesh,
          heightfield: { data: hfData, resolution: hf.resolution, size: hf.size, originX: hf.originX, originY: hf.originY },
          bytes: terrainMeshBytes(mesh),
          buildMs: performance.now() - started,
        },
        [mesh.positions.buffer, mesh.normals.buffer, mesh.uvs.buffer, mesh.slope.buffer, mesh.indices.buffer] as unknown as Transferable[],
      );
      return;
    }

    if (req.type === 'sculpt') {
      const hf = makeHeightfield(req.resolution, req.size, req.originX, req.originY, req.source, req.edits);
      // Dynamic import would be async; import the brush statically instead.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { applyStroke } = sculptModule;
      let touched = 0;
      let box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (let i = 1; i < req.points.length; i++) {
        const res = applyStroke(hf, req.points[i - 1], req.points[i], req.brush as never);
        if (res.changed) {
          touched += res.touched;
          box = {
            minX: Math.min(box.minX, res.minX),
            minY: Math.min(box.minY, res.minY),
            maxX: Math.max(box.maxX, res.maxX),
            maxY: Math.max(box.maxY, res.maxY),
          };
        }
      }
      if (!Number.isFinite(box.minX)) box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      const mesh = buildTerrainMesh(hf, {
        verticalExaggeration: req.verticalExaggeration,
        borderStepMeters: req.borderStepMeters,
        skirtMeters: req.skirtMeters,
        withNormals: true,
        withSlope: true,
      });
      reply(
        {
          requestId: req.requestId,
          generation: req.generation,
          key: req.key,
          mesh,
          heightfield: { data: Array.from(hf.data), resolution: hf.resolution, size: hf.size, originX: hf.originX, originY: hf.originY },
          box,
          touched,
          bytes: terrainMeshBytes(mesh),
          buildMs: performance.now() - started,
        },
        [mesh.positions.buffer, mesh.normals.buffer, mesh.uvs.buffer, mesh.slope.buffer, mesh.indices.buffer] as unknown as Transferable[],
      );
      return;
    }

    if (req.type === 'analysis') {
      const hf = makeHeightfield(req.resolution, req.size, req.originX, req.originY, req.source, req.edits);
      const o = req.options as Record<string, number>;
      if (req.kind === 'hillshade') {
        const data = hillshade(hf, { ...defaultHillshade(), ...(o ?? {}) });
        reply({ requestId: req.requestId, generation: req.generation, kind: req.kind, data: Array.from(data), width: hf.resolution, height: hf.resolution, ms: performance.now() - started });
        return;
      }
      if (req.kind === 'slope') {
        const data = slopeRaster(hf);
        reply({ requestId: req.requestId, generation: req.generation, kind: req.kind, data: Array.from(data), width: hf.resolution, height: hf.resolution, ms: performance.now() - started });
        return;
      }
      if (req.kind === 'aspect') {
        const data = aspectRaster(hf);
        reply({ requestId: req.requestId, generation: req.generation, kind: req.kind, data: Array.from(data), width: hf.resolution, height: hf.resolution, ms: performance.now() - started });
        return;
      }
      if (req.kind === 'contours') {
        const result = extractContours(hf, o.interval ?? 50, o.indexEvery ?? 5);
        reply({ requestId: req.requestId, generation: req.generation, kind: req.kind, result, ms: performance.now() - started });
        return;
      }
      if (req.kind === 'profile') {
        const route = (o.route as unknown as Array<{ x: number; y: number }>) ?? [];
        const profile = elevationProfile(hf, route);
        reply({ requestId: req.requestId, generation: req.generation, kind: req.kind, profile, ms: performance.now() - started });
        return;
      }
    }

    reply({ requestId: req.requestId, error: `Unknown request type "${(req as { type: string }).type}"` });
  } catch (err) {
    reply({
      requestId: req.requestId,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
};

// Static reference so the sculpt path stays synchronous inside the worker.
import * as sculptModuleNs from '@3dmm/terrain';
const sculptModule = sculptModuleNs;

reply({ type: 'ready' });
