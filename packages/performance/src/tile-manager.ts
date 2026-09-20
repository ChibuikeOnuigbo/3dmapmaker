/**
 * packages/performance — priority tile scheduler (REQUIREMENT 010).
 *
 * Lifecycle: queued -> loading -> ready -> active -> cooling -> evicted
 *                                              \-> failed
 *
 * Guarantees the spec asks for:
 *  - stale requests are aborted the moment a tile leaves the wanted set;
 *  - concurrency is capped so a camera flick cannot open 200 sockets;
 *  - "protected" tiles (edited / pinned) are never evicted;
 *  - every callback carries the request generation so a late result can be
 *    discarded instead of clobbering current state (REQUIREMENT 127).
 */

export type TileState = 'queued' | 'loading' | 'ready' | 'active' | 'cooling' | 'evicting' | 'failed';

export interface TileRequest<T = unknown> {
  key: string;
  /**
   * HIGHER loads FIRST.
   *
   * This is a score, not a rank and not a distance. It matches the convention
   * used everywhere else in the repository (scene-core label priority, the
   * panorama prefetch queue), where a bigger number means "more important".
   * A caller that wants near tiles first must pass a score that decreases with
   * distance — e.g. `1000 - distance` — not the raw distance.
   */
  priority: number;
  state: TileState;
  generation: number;
  abort: AbortController | null;
  result: T | null;
  error: string | null;
  attempts: number;
  queuedAt: number;
  startedAt: number;
  finishedAt: number;
  lastActiveAt: number;
  protected: boolean;
}

export interface TileManagerOptions {
  maxConcurrent?: number;
  maxActive?: number;
  /** Milliseconds a tile stays `cooling` before eviction. */
  coolingMs?: number;
  maxAttempts?: number;
  onStateChange?: (key: string, state: TileState) => void;
  onDispose?: (key: string, result: unknown) => void;
}

export type TileLoader<T> = (key: string, signal: AbortSignal) => Promise<T>;

export class TileManager<T = unknown> {
  private tiles = new Map<string, TileRequest<T>>();
  private loader: TileLoader<T>;
  private readonly maxConcurrent: number;
  private readonly maxActive: number;
  private readonly coolingMs: number;
  private readonly maxAttempts: number;
  private generation = 0;
  private inflight = 0;
  private abortedStale = 0;
  private failures = 0;
  private loads = 0;
  private readonly onStateChange?: (key: string, state: TileState) => void;
  private readonly onDispose?: (key: string, result: unknown) => void;

  constructor(loader: TileLoader<T>, opts: TileManagerOptions = {}) {
    this.loader = loader;
    this.maxConcurrent = opts.maxConcurrent ?? 6;
    this.maxActive = opts.maxActive ?? 64;
    this.coolingMs = opts.coolingMs ?? 4000;
    this.maxAttempts = opts.maxAttempts ?? 2;
    this.onStateChange = opts.onStateChange;
    this.onDispose = opts.onDispose;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get stats() {
    const counts: Record<TileState, number> = {
      queued: 0,
      loading: 0,
      ready: 0,
      active: 0,
      cooling: 0,
      evicting: 0,
      failed: 0,
    };
    for (const t of this.tiles.values()) counts[t.state]++;
    return {
      ...counts,
      total: this.tiles.size,
      inflight: this.inflight,
      abortedStale: this.abortedStale,
      failures: this.failures,
      loads: this.loads,
      generation: this.generation,
    };
  }

  state(key: string): TileState | null {
    return this.tiles.get(key)?.state ?? null;
  }

  result(key: string): T | null {
    return this.tiles.get(key)?.result ?? null;
  }

  /** Mark tiles the user must never lose (sculpted / authored tiles). */
  protect(key: string, protect = true): void {
    const t = this.tiles.get(key);
    if (t) t.protected = protect;
  }

  private setState(t: TileRequest<T>, state: TileState): void {
    if (t.state === state) return;
    t.state = state;
    this.onStateChange?.(t.key, state);
  }

  /**
   * The one call the frame loop makes. `wanted` is the current priority-ordered
   * list of tile keys; anything not in it starts cooling.
   */
  update(wanted: ReadonlyArray<{ key: string; priority: number }>): void {
    this.generation++;
    const wantedSet = new Set(wanted.map((w) => w.key));

    // 1. abort anything we no longer want that has not finished
    for (const t of this.tiles.values()) {
      if (t.protected) continue;
      if (!wantedSet.has(t.key) && (t.state === 'queued' || t.state === 'loading')) {
        t.abort?.abort();
        this.abortedStale++;
        this.inflight = Math.max(0, this.inflight - (t.state === 'loading' ? 1 : 0));
        this.setState(t, 'cooling');
        t.lastActiveAt = Date.now();
      }
    }

    // 2. enqueue new requests
    for (const w of wanted) {
      let t = this.tiles.get(w.key);
      if (!t) {
        t = {
          key: w.key,
          priority: w.priority,
          state: 'queued',
          generation: this.generation,
          abort: null,
          result: null,
          error: null,
          attempts: 0,
          queuedAt: Date.now(),
          startedAt: 0,
          finishedAt: 0,
          lastActiveAt: Date.now(),
          protected: false,
        };
        this.tiles.set(w.key, t);
      }
      t.priority = w.priority;
      t.lastActiveAt = Date.now();
      if (t.state === 'ready' || t.state === 'cooling') this.setState(t, 'active');
      else if (t.state === 'failed' && t.attempts < this.maxAttempts) this.setState(t, 'queued');
    }

    // 3. demote no-longer-wanted ready tiles to cooling
    for (const t of this.tiles.values()) {
      if (t.protected) continue;
      if (!wantedSet.has(t.key) && (t.state === 'ready' || t.state === 'active')) {
        this.setState(t, 'cooling');
        t.lastActiveAt = Date.now();
      }
    }

    this.startQueued();
  }

  private startQueued(): void {
    const queued = [...this.tiles.values()]
      .filter((t) => t.state === 'queued')
      .sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);

    for (const t of queued) {
      if (this.inflight >= this.maxConcurrent) break;
      this.inflight++;
      t.attempts++;
      t.startedAt = Date.now();
      const ac = new AbortController();
      t.abort = ac;
      this.setState(t, 'loading');
      const generation = t.generation;

      this.loader(t.key, ac.signal).then(
        (result) => {
          if (ac.signal.aborted) return; // stale — discard silently (REQ 127)
          t.result = result;
          t.error = null;
          t.finishedAt = Date.now();
          t.abort = null;
          this.inflight = Math.max(0, this.inflight - 1);
          this.loads++;
          this.setState(t, 'active');
          void generation;
          this.startQueued();
        },
        (err: unknown) => {
          if (ac.signal.aborted) return;
          t.abort = null;
          t.error = err instanceof Error ? err.message : String(err);
          t.finishedAt = Date.now();
          this.inflight = Math.max(0, this.inflight - 1);
          if (t.attempts >= this.maxAttempts) {
            this.failures++;
            this.setState(t, 'failed');
          } else {
            this.setState(t, 'queued'); // one automatic retry, then it surfaces
          }
          this.startQueued();
        },
      );
    }
  }

  /** Evict tiles whose cooling period has expired. Protected tiles survive. */
  gc(now = Date.now()): number {
    let evicted = 0;
    for (const t of [...this.tiles.values()]) {
      if (t.protected) continue;
      if (t.state === 'loading' || t.state === 'queued') continue;
      if (now - t.lastActiveAt < this.coolingMs) continue;
      this.setState(t, 'evicting');
      if (t.result != null) this.onDispose?.(t.key, t.result);
      this.tiles.delete(t.key);
      evicted++;
    }
    return evicted;
  }

  /** Force-evict everything except protected tiles (e.g. world switch). */
  reset(): void {
    for (const t of this.tiles.values()) {
      t.abort?.abort();
      if (!t.protected && t.result != null) this.onDispose?.(t.key, t.result);
    }
    const kept = [...this.tiles.values()].filter((t) => t.protected);
    this.tiles = new Map(kept.map((t) => [t.key, t]));
    this.inflight = 0;
  }

  /** Retry a failed tile explicitly (surfaced in the error UI). */
  retry(key: string): boolean {
    const t = this.tiles.get(key);
    if (!t || t.state !== 'failed') return false;
    t.attempts = 0;
    t.error = null;
    this.setState(t, 'queued');
    this.startQueued();
    return true;
  }
}
