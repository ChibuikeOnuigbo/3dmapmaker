/**
 * apps/web — terrain worker client.
 *
 * Wraps `workers/terrain.worker.ts` behind the TerrainWorkerTransport interface
 * the engine expects, with request ids, generation checks, cancellation and an
 * honest fallback to inline computation when Workers are unavailable.
 */
import type { TerrainMeshData, TerrainWorkerTransport, TileMeshRequest, TileMeshResponse } from '@3dmm/terrain';
import { generateHeightfield, buildTerrainMesh, Heightfield, type TerrainSource } from '@3dmm/terrain';

/** Everything the worker can post back. Discriminated on the outcome fields. */
interface WorkerEnvelope {
  requestId: number;
  type?: string;
  cancelled?: boolean;
  error?: string;
  generation?: number;
  key?: string;
  buildMs?: number;
  mesh?: TerrainMeshData;
  heightfield?: { data: number[]; resolution: number; size: number; originX: number; originY: number };
}

interface Pending {
  resolve: (v: TileMeshResponse) => void;
  reject: (e: unknown) => void;
  generation: number;
}

export class TerrainWorkerClient implements TerrainWorkerTransport {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private generation = 0;
  private queue: Array<{ req: TileMeshRequest; signal: AbortSignal; resolve: (v: TileMeshResponse) => void; reject: (e: unknown) => void }> = [];
  private inflight = 0;
  private maxConcurrent: number;
  private aborted = 0;
  private completed = 0;
  private errors = 0;
  private lastBuildMs = 0;
  private disposed = false;
  private available: boolean;

  constructor(workerFactory: () => Worker, maxConcurrent = 2) {
    this.maxConcurrent = maxConcurrent;
    try {
      this.worker = workerFactory();
      this.worker.onmessage = (e) => this.onMessage(e);
      this.worker.onerror = (e) => this.onError(e);
      this.available = true;
    } catch {
      this.worker = null;
      this.available = false;
    }
  }

  get isAvailable(): boolean {
    return this.available;
  }

  get stats() {
    return {
      available: this.available,
      inflight: this.inflight,
      queued: this.queue.length,
      completed: this.completed,
      aborted: this.aborted,
      errors: this.errors,
      lastBuildMs: this.lastBuildMs,
      generation: this.generation,
    };
  }

  bumpGeneration(): void {
    this.generation++;
  }

  private onMessage(e: MessageEvent): void {
    // The worker wraps every reply in an envelope; only successful builds carry
    // the full TileMeshResponse fields.
    const data = e.data as WorkerEnvelope;
    if (data.type === 'ready') return;
    const p = this.pending.get(data.requestId);
    if (!p) return;
    this.pending.delete(data.requestId);
    this.inflight = Math.max(0, this.inflight - 1);
    this.pump();
    if (data.cancelled) {
      this.aborted++;
      p.reject(new DOMException('cancelled', 'AbortError'));
      return;
    }
    if (data.error) {
      this.errors++;
      p.reject(new Error(data.error));
      return;
    }
    if (data.generation !== p.generation) {
      this.aborted++;
      p.reject(new DOMException('stale', 'AbortError'));
      return;
    }
    this.completed++;
    this.lastBuildMs = data.buildMs ?? 0;
    if (!data.mesh || !data.heightfield || data.key === undefined || data.generation === undefined) {
      this.errors++;
      p.reject(new Error('The worker returned an incomplete tile mesh response.'));
      return;
    }
    p.resolve({ key: data.key, generation: data.generation, mesh: data.mesh, heightfield: data.heightfield, buildMs: data.buildMs ?? 0 });
  }

  private onError(e: ErrorEvent): void {
    this.errors++;
    const message = e.message || 'Terrain worker crashed';
    for (const [id, p] of this.pending) {
      p.reject(new Error(message));
      this.pending.delete(id);
    }
    this.inflight = 0;
    this.pump();
  }

  buildMesh(request: TileMeshRequest, signal: AbortSignal): Promise<TileMeshResponse> {
    if (this.disposed) return Promise.reject(new DOMException('disposed', 'AbortError'));
    if (!this.worker) return this.inline(request, signal);
    return new Promise<TileMeshResponse>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      this.queue.push({ req: request, signal, resolve, reject });
      signal.addEventListener('abort', () => {
        this.queue = this.queue.filter((q) => q.req !== request);
        this.aborted++;
        reject(new DOMException('aborted', 'AbortError'));
        this.pump();
      }, { once: true });
      this.pump();
    });
  }

  private pump(): void {
    while (this.inflight < this.maxConcurrent && this.queue.length) {
      const item = this.queue.shift()!;
      if (item.signal.aborted) continue;
      const id = this.nextId++;
      const generation = this.generation;
      this.pending.set(id, { resolve: item.resolve, reject: item.reject, generation });
      this.inflight++;
      this.worker!.postMessage({ ...item.req, requestId: id, generation });
    }
  }

  cancel(requestId?: number): void {
    if (!this.worker) return;
    if (requestId !== undefined) {
      this.worker.postMessage({ type: 'cancel', requestId });
      return;
    }
    for (const id of this.pending.keys()) this.worker.postMessage({ type: 'cancel', requestId: id });
  }

  /** Fallback path: same code, same result, but on the main thread. */
  private async inline(request: TileMeshRequest, signal: AbortSignal): Promise<TileMeshResponse> {
    const started = performance.now();
    const hf: Heightfield = generateHeightfield({
      source: request.source as TerrainSource,
      resolution: request.resolution,
      size: request.size,
      originX: request.originX,
      originY: request.originY,
      edits: request.edits,
    }, signal);
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const mesh = buildTerrainMesh(hf, {
      verticalExaggeration: request.verticalExaggeration,
      borderStepMeters: request.borderStepMeters,
      skirtMeters: request.skirtMeters,
      withNormals: true,
      withSlope: true,
    });
    this.completed++;
    this.lastBuildMs = performance.now() - started;
    return {
      key: request.key,
      generation: request.generation,
      mesh,
      heightfield: { data: Array.from(hf.data), resolution: hf.resolution, size: hf.size, originX: hf.originX, originY: hf.originY },
      buildMs: this.lastBuildMs,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const [, p] of this.pending) p.reject(new DOMException('disposed', 'AbortError'));
    this.pending.clear();
    this.queue = [];
    this.worker?.terminate();
    this.worker = null;
  }
}
