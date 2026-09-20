/**
 * apps/web — the panorama world session (spec §25, §26, §29, §30, §32, §40).
 *
 * One object owns the walk: the current node, the destination, the route, the
 * visited set, the preload queue and the transition state machine. The React
 * component and the 2D map both read from it, so the map can never disagree
 * with what the player is looking at.
 *
 * The transition is an explicit state machine, not a timer chain:
 *
 *   idle → preloading → transitioning → settling → idle
 *
 * §32 requires preload → fade/directional → swap → restore heading → settle,
 * with no jarring black screen. Every stage is visible in the HUD, and a new
 * keypress during a transition is queued rather than dropped.
 *
 * Note on "restore heading": this state machine owns the walk, not the camera. It
 * holds no yaw or heading field at all — that belongs to the renderer, which
 * keeps its yaw across the swap rather than resetting it, so the player's heading
 * is continuous through the plate change. What this file contributes to that step
 * is clearing `travelDirection` on arrival, which is what tells the renderer the
 * sweep is over and the warp should return to zero.
 */
import type { Direction, WorldGraph, WorldNode } from '@3dmm/panorama';
import { resolveMovementIntent, type IntentResult, type MovementIntent } from '@3dmm/panorama';
import { PanoramaCache, rankPrefetch } from './preloader';

export type Phase = 'idle' | 'preloading' | 'transitioning' | 'settling';

export interface SessionSnapshot {
  phase: Phase;
  currentId: string | null;
  fromId: string | null;
  toId: string | null;
  /** 0..1 through the current transition. */
  progress: number;
  /** The direction the player is walking, when a move is in flight. */
  travelDirection: Direction | null;
  /** Progress of the plate download that is gating the transition. */
  loadProgress: number;
  destinationId: string | null;
  route: string[];
  routeRemaining: number;
  visited: string[];
  visitedCount: number;
  steps: number;
  metresWalked: number;
  lastIntent: IntentResult | null;
  /** Why the last move was refused, when it was. */
  refusal: string | null;
  errors: string[];
}

export interface SessionCallbacks {
  /** Called with the plate the renderer must display for the incoming node. */
  onPlateReady: (node: WorldNode, bitmap: ImageBitmap | HTMLImageElement) => void;
  /** Called when the transition state changes so the UI can repaint. */
  onChange: () => void;
  /** Called when a plate fails to load. */
  onError: (url: string, message: string) => void;
}

/**
 * Camera bob and micro-sway (§28).
 *
 * Gaussian noise is confined to this struct and is only ever added to the
 * camera's yaw/pitch/height. It is never consulted for node selection,
 * coordinates, geometry or path correctness — the graph stays exact.
 */
export interface GaitState {
  /** Radians of accumulated sway. */
  sway: number;
  /** 0..1 through the current step. */
  stepPhase: number;
  /** Vertical bob offset in scene units. */
  bob: number;
  /** Micro yaw offset in degrees. */
  yawNoise: number;
  /** Micro pitch offset in degrees. */
  pitchNoise: number;
}

export const IDLE_GAIT: GaitState = { sway: 0, stepPhase: 0, bob: 0, yawNoise: 0, pitchNoise: 0 };

export class WorldSession {
  readonly graph: WorldGraph;
  readonly cache: PanoramaCache;

  private _currentId: string | null = null;
  private _fromId: string | null = null;
  private _toId: string | null = null;
  private _destinationId: string | null = null;
  private _route: string[] = [];
  private _visited = new Set<string>();
  private _phase: Phase = 'idle';
  private _progress = 0;
  private _loadProgress = 0;
  private _travelDirection: Direction | null = null;
  private _lastIntent: IntentResult | null = null;
  private _refusal: string | null = null;
  private _errors: string[] = [];
  private _steps = 0;
  private _metres = 0;
  /** Moves pressed while a transition was in flight, replayed on arrival. */
  private pending: MovementIntent[] = [];
  /** Aborts the walk currently in flight when a new one starts. */
  private walkController: AbortController | null = null;
  /** Aborts the background prefetch batch; only on dispose or world change. */
  private prefetchController: AbortController | null = null;
  private disposed = false;

  constructor(
    graph: WorldGraph,
    private readonly cb: SessionCallbacks,
    cacheOpts: { maxBytes?: number; maxEntries?: number } = {},
  ) {
    this.graph = graph;
    this.cache = new PanoramaCache(cacheOpts);
  }

  get currentId(): string | null {
    return this._currentId;
  }

  get currentNode(): WorldNode | null {
    return this._currentId ? this.graph.get(this._currentId) : null;
  }

  get phase(): Phase {
    return this._phase;
  }

  get isBusy(): boolean {
    return this._phase !== 'idle';
  }

  /** Place the player on a node with no transition (world entry, warp). */
  async arrive(node: WorldNode, opts: { markVisited?: boolean } = {}): Promise<void> {
    this.abortWalk();
    this.abortPrefetch();
    this._fromId = null;
    this._toId = null;
    this._travelDirection = null;
    this._progress = 0;
    this._currentId = node.id;
    if (opts.markVisited !== false) this._visited.add(node.id);
    this.cache.pin(node.panoramaUrl);
    this._phase = 'preloading';
    this._loadProgress = 0;
    this.emit();
    try {
      const bitmap = await this.cache.load(node.panoramaUrl);
      if (this.disposed || this._currentId !== node.id) return;
      this.cb.onPlateReady(node, bitmap);
      this._phase = 'idle';
      this._loadProgress = 1;
      this.emit();
      this.prefetchFrom(node, null);
      this.replayPending();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      this.fail(node.panoramaUrl, (err as Error).message);
    }
  }

  /**
   * Handle one movement keypress.
   *
   * The intent is resolved against the graph FIRST. Only when a real edge
   * exists do we start loading. A refused move never touches the renderer, so
   * WASD can never translate the camera through the texture.
   */
  async move(intent: MovementIntent, cameraYawDeg: number): Promise<IntentResult> {
    if (!this._currentId) {
      const r = resolveMovementIntent(this.graph, '', intent, cameraYawDeg);
      this._lastIntent = r;
      this._refusal = r.reason;
      this.emit();
      return r;
    }
    // Queue rather than drop: a player walking fast should not lose inputs.
    if (this.isBusy) {
      if (this.pending.length < 3) this.pending.push(intent);
      return this._lastIntent ?? resolveMovementIntent(this.graph, this._currentId, intent, cameraYawDeg);
    }

    const result = resolveMovementIntent(this.graph, this._currentId, intent, cameraYawDeg);
    this._lastIntent = result;
    if (!result.ok || !result.targetId) {
      this._refusal = result.reason;
      this.emit();
      return result;
    }
    this._refusal = null;
    await this.walkTo(result.targetId, result.direction);
    return result;
  }

  /** Walk to a specific neighbour along a known direction. */
  async walkTo(targetId: string, direction: Direction | null): Promise<void> {
    const from = this.currentNode;
    const to = this.graph.get(targetId);
    if (!from || !to) return;

    // Cancel only a PREVIOUS walk. The prefetch batch is deliberately left
    // running: it is already fetching this very plate, and aborting it here
    // would cancel the load we are about to await and freeze the session.
    this.abortWalk();
    this._fromId = from.id;
    this._toId = to.id;
    this._travelDirection = direction;
    this._phase = 'preloading';
    this._progress = 0;
    this._loadProgress = 0;
    this.emit();

    const controller = new AbortController();
    this.walkController = controller;
    try {
      const bitmap = await this.cache.load(to.panoramaUrl, { signal: controller.signal });
      if (this.disposed || this._toId !== to.id) return;
      this._loadProgress = 1;
      this.cb.onPlateReady(to, bitmap);
      this._phase = 'transitioning';
      this.emit();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // Cancelled mid-load. Reset the machine so the player is never left
        // staring at a "preloading" badge for a walk that will not happen.
        if (this._toId === to.id) {
          this._toId = null;
          this._fromId = null;
          this._phase = 'idle';
          this.emit();
        }
        return;
      }
      this.fail(to.panoramaUrl, (err as Error).message);
      return;
    }
  }

  /** Called by the renderer every frame while a transition is running. */
  tick(dt: number, durationMs = 520): { progress: number; phase: Phase } {
    if (this._phase === 'transitioning') {
      this._progress = Math.min(1, this._progress + (dt * 1000) / durationMs);
      if (this._progress >= 1) {
        this.commitArrival();
      }
      this.emit();
    }
    return { progress: this._progress, phase: this._phase };
  }

  /**
   * Finish the swap: promote the incoming node, clear the travel direction,
   * settle. Heading itself is not touched here — see the note at the top of the
   * file; the renderer preserves yaw across the swap.
   */
  private commitArrival(): void {
    const to = this._toId ? this.graph.get(this._toId) : null;
    if (!to) {
      this._phase = 'idle';
      return;
    }
    const from = this._fromId ? this.graph.get(this._fromId) : null;
    if (from) {
      const d = Math.hypot(to.worldX - from.worldX, to.worldZ - from.worldZ);
      this._metres += d;
    }
    this._currentId = to.id;
    this._visited.add(to.id);
    this._steps += 1;
    this.cache.pin(to.panoramaUrl);
    this._fromId = null;
    this._toId = null;
    this._progress = 0;
    this._travelDirection = null;
    this._phase = 'settling';
    // Trim the route as the player consumes it. route[0] is where the player
    // WAS, so the node just arrived at is route[1]; drop everything up to and
    // including it. Using indexOf rather than a fixed offset also survives a
    // warp that lands mid-route.
    if (this._route.length) {
      const at = this._route.indexOf(to.id);
      if (at >= 0) {
        this._route = this._route.slice(at + 1);
        // Put the player back at the head so the map can draw the tail.
        this._route.unshift(to.id);
      }
      if (this._route.length <= 1) {
        this._route = [];
        this._destinationId = null;
      }
    }
    this.emit();
    this.prefetchFrom(to, this._lastIntent?.direction ?? null);
    // "Settling" is a short beat the renderer uses to ease the bob out.
    this._phase = 'idle';
    this.emit();
    this.replayPending();
  }

  /**
   * Prefetch the plates around a node, prioritising the direction of travel
   * (§40). Cached plates are skipped, and the cache's LRU keeps the total
   * bounded no matter how big the world is.
   */
  prefetchFrom(node: WorldNode, facing: Direction | null): void {
    const ring = this.graph.neighborsOf(node.id).map((n) => ({ direction: n.edge.direction, url: n.node.panoramaUrl }));
    const routeUrls = this._route.slice(1, 6).map((id) => this.graph.get(id)?.panoramaUrl).filter((u): u is string => !!u);
    const candidates = rankPrefetch({
      currentUrl: node.panoramaUrl,
      facing,
      ring,
      route: routeUrls,
      cache: this.cache,
    });
    // Fire them in priority order without awaiting, so the UI is never blocked.
    this.abortPrefetch();
    const controller = new AbortController();
    this.prefetchController = controller;
    for (const c of candidates) {
      this.cache.load(c.url, { signal: controller.signal }).catch((err: Error) => {
        if (err.name !== 'AbortError') this.fail(c.url, err.message);
      });
    }
  }

  /** Set a destination and compute the recommended route with A*. */
  setDestination(id: string | null): { ok: boolean; route: string[]; distance: number; expanded: number; reason: string | null } {
    if (!id) {
      this._destinationId = null;
      this._route = [];
      this.emit();
      return { ok: true, route: [], distance: 0, expanded: 0, reason: null };
    }
    if (!this._currentId) return { ok: false, route: [], distance: 0, expanded: 0, reason: 'Not standing on a node yet.' };
    if (id === this._currentId) return { ok: false, route: [], distance: 0, expanded: 0, reason: 'You are already there.' };
    const result = this.graph.findPath(this._currentId, id);
    if (!result) {
      this._destinationId = null;
      this._route = [];
      this.emit();
      const target = this.graph.get(id);
      return {
        ok: false,
        route: [],
        distance: 0,
        expanded: 0,
        reason: `No walkable route to square ${target?.number ?? id}. The graph is split by walls or water.`,
      };
    }
    this._destinationId = id;
    this._route = result.nodes.map((n) => n.id);
    this.emit();
    // Prefetch the first few plates of the new route.
    const node = this.currentNode;
    if (node) this.prefetchFrom(node, null);
    return { ok: true, route: this._route, distance: result.distance, expanded: result.expanded, reason: null };
  }

  /** Walk one step along the current route, if there is one. */
  async stepAlongRoute(cameraYawDeg: number): Promise<IntentResult | null> {
    if (this._route.length < 2) return null;
    const next = this._route[1];
    const from = this.currentNode;
    if (!from) return null;
    const edge = this.graph.neighborsOf(from.id).find((n) => n.node.id === next)?.edge;
    if (!edge) return null;
    void cameraYawDeg;
    await this.walkTo(next, edge.direction);
    return this._lastIntent;
  }

  /** Warp straight to a node, bypassing the walk (map double-click). */
  async warpTo(id: string): Promise<boolean> {
    const node = this.graph.get(id);
    if (!node) return false;
    this.pending = [];
    await this.arrive(node);
    return true;
  }

  /** Distance from the current node to a landmark, for the HUD. */
  landmarkBearing(landmarkId: string): { dx: number; dy: number; meters: number; bearingDeg: number } | null {
    if (!this._currentId) return null;
    return this.graph.landmarkVector(this._currentId, landmarkId);
  }

  snapshot(): SessionSnapshot {
    return {
      phase: this._phase,
      currentId: this._currentId,
      fromId: this._fromId,
      toId: this._toId,
      progress: this._progress,
      travelDirection: this._travelDirection,
      loadProgress: this._loadProgress,
      destinationId: this._destinationId,
      route: [...this._route],
      routeRemaining: Math.max(0, this._route.length - 1),
      visited: [...this._visited],
      visitedCount: this._visited.size,
      steps: this._steps,
      metresWalked: this._metres,
      lastIntent: this._lastIntent,
      refusal: this._refusal,
      errors: [...this._errors],
    };
  }

  visitedSet(): ReadonlySet<string> {
    return this._visited;
  }

  private fail(url: string, message: string): void {
    const node = [...this.graph.all()].find((n) => n.panoramaUrl === url);
    const label = node ? `square ${node.number}` : url;
    const entry = `${label}: ${message}`;
    if (!this._errors.includes(entry)) this._errors.push(entry);
    this._phase = 'idle';
    this._fromId = null;
    this._toId = null;
    this.cb.onError(url, entry);
    this.emit();
  }

  private abortWalk(): void {
    this.walkController?.abort();
    this.walkController = null;
  }

  private abortPrefetch(): void {
    this.prefetchController?.abort();
    this.prefetchController = null;
  }

  private replayPending(): void {
    if (this.disposed || !this.pending.length) return;
    const next = this.pending.shift();
    if (!next || !this._lastIntent) return;
    // Re-resolve against the NEW camera yaw the caller will supply next frame;
    // here we reuse the last known yaw so queued input is not silently lost.
    void this.move(next, this._lastIntent.cameraYawDeg);
  }

  private emit(): void {
    if (!this.disposed) this.cb.onChange();
  }

  dispose(): void {
    this.disposed = true;
    this.abortWalk();
    this.abortPrefetch();
    this.cache.clear();
    this.pending = [];
  }
}
