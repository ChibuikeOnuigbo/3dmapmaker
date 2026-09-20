/**
 * apps/web — panorama preloader and LRU cache (spec §13, §40).
 *
 * A 1,024-node world must never hold 1,024 decoded plates. This keeps a bounded
 * byte budget, prefetches by likelihood (current direction first, then the rest
 * of the ring, then route nodes), and aborts in-flight loads when the target
 * changes so a fast walk does not queue up work nobody will see.
 */

export interface PreloadCandidate {
  url: string;
  /** Higher loads first. */
  priority: number;
  /** Why this was queued — surfaced in the UI so loading is never a mystery. */
  reason: string;
}

export interface CacheEntry {
  url: string;
  bytes: number;
  loadedAt: number;
}

export interface PreloaderStats {
  hits: number;
  misses: number;
  bytes: number;
  entries: number;
  inflight: number;
  aborted: number;
  failed: string[];
}

/** Decode an image and report its real decoded byte cost, not the file size. */
async function decodeImage(url: string, signal: AbortSignal): Promise<{ bitmap: ImageBitmap | HTMLImageElement; bytes: number }> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const blob = await res.blob();
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  const bytes = blob.size;
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      if (signal.aborted) {
        bitmap.close();
        throw new DOMException('aborted', 'AbortError');
      }
      // A decoded RGBA bitmap is what actually costs memory, and it is far
      // larger than the compressed file. Budget on the real number.
      const decoded = bitmap.width * bitmap.height * 4;
      return { bitmap, bytes: Math.max(bytes, decoded) };
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      // Fall through to an <img> element on browsers without createImageBitmap.
    }
  }
  const img = new Image();
  const objectUrl = URL.createObjectURL(blob);
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Could not decode ${url}`));
    img.src = objectUrl;
  });
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  return { bitmap: img, bytes: Math.max(bytes, img.naturalWidth * img.naturalHeight * 4) };
}

export class PanoramaCache {
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly map = new Map<string, { value: ImageBitmap | HTMLImageElement; bytes: number }>();
  private readonly inflight = new Map<string, Promise<ImageBitmap | HTMLImageElement>>();
  private readonly controllers = new Map<string, AbortController>();
  private hits = 0;
  private misses = 0;
  private aborted = 0;
  private readonly failed: string[] = [];
  /** Urls that must never be evicted while they are the current view. */
  private pinned = new Set<string>();

  constructor(opts: { maxBytes?: number; maxEntries?: number } = {}) {
    // ~192 MB of decoded RGBA, or 24 entries, whichever comes first.
    this.maxBytes = opts.maxBytes ?? 192 * 1024 * 1024;
    this.maxEntries = opts.maxEntries ?? 24;
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    let total = 0;
    for (const e of this.map.values()) total += e.bytes;
    return total;
  }

  has(url: string): boolean {
    return this.map.has(url);
  }

  /** Touch-on-read LRU: a read moves the entry to the most-recently-used end. */
  get(url: string): ImageBitmap | HTMLImageElement | null {
    const e = this.map.get(url);
    if (!e) {
      this.misses++;
      return null;
    }
    this.hits++;
    this.map.delete(url);
    this.map.set(url, e);
    return e.value;
  }

  /** Peek without affecting LRU order. */
  peek(url: string): ImageBitmap | HTMLImageElement | null {
    return this.map.get(url)?.value ?? null;
  }

  pin(url: string): void {
    this.pinned = new Set([url]);
  }

  /** Load a plate, deduplicating concurrent requests for the same url. */
  async load(url: string, opts: { signal?: AbortSignal } = {}): Promise<ImageBitmap | HTMLImageElement> {
    const cached = this.peek(url);
    if (cached) {
      this.hits++;
      return cached;
    }
    const existing = this.inflight.get(url);
    if (existing) {
      // The plate is already being fetched for someone else. Do NOT hand back
      // their promise directly: if their signal aborts, the shared fetch
      // rejects, and this caller would be cancelled for a reason it never
      // gave. Race the shared load against this caller's own abort instead,
      // leaving the underlying fetch running for whoever still wants it.
      if (!opts.signal) return existing;
      if (opts.signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
      return new Promise<ImageBitmap | HTMLImageElement>((resolve, reject) => {
        const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
        opts.signal!.addEventListener('abort', onAbort, { once: true });
        existing.then(
          (v) => {
            opts.signal?.removeEventListener('abort', onAbort);
            resolve(v);
          },
          (err: Error) => {
            opts.signal?.removeEventListener('abort', onAbort);
            reject(err);
          },
        );
      });
    }

    const controller = new AbortController();
    this.controllers.set(url, controller);
    // Cancel this load if the caller's signal fires.
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort);

    const promise = decodeImage(url, controller.signal)
      .then(({ bitmap, bytes }) => {
        this.set(url, bitmap, bytes);
        return bitmap;
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') {
          this.aborted++;
        } else if (!this.failed.includes(url)) {
          this.failed.push(url);
        }
        throw err;
      })
      .finally(() => {
        this.inflight.delete(url);
        this.controllers.delete(url);
        opts.signal?.removeEventListener('abort', onAbort);
      });

    this.inflight.set(url, promise);
    return promise;
  }

  private set(url: string, value: ImageBitmap | HTMLImageElement, bytes: number): void {
    if (this.map.has(url)) this.map.delete(url);
    this.map.set(url, { value, bytes });
    this.evict();
  }

  /** Drop least-recently-used entries until both budgets are satisfied. */
  private evict(): void {
    while (this.bytes > this.maxBytes || this.map.size > this.maxEntries) {
      // Map iteration order is insertion order, which LRU-get keeps current.
      let evicted = false;
      for (const key of this.map.keys()) {
        if (this.pinned.has(key)) continue;
        const e = this.map.get(key)!;
        this.map.delete(key);
        if ('close' in e.value && typeof e.value.close === 'function') e.value.close();
        evicted = true;
        break;
      }
      if (!evicted) break; // everything left is pinned
    }
  }

  /** Cancel every in-flight load. Called when the world changes. */
  abortAll(): void {
    for (const c of this.controllers.values()) c.abort();
    this.controllers.clear();
    this.inflight.clear();
  }

  clear(): void {
    this.abortAll();
    for (const e of this.map.values()) {
      if ('close' in e.value && typeof e.value.close === 'function') e.value.close();
    }
    this.map.clear();
    this.pinned.clear();
  }

  get stats(): PreloaderStats {
    return {
      hits: this.hits,
      misses: this.misses,
      bytes: this.bytes,
      entries: this.map.size,
      inflight: this.inflight.size,
      aborted: this.aborted,
      failed: [...this.failed],
    };
  }
}

/**
 * Rank the plates worth prefetching from a node.
 *
 * Order follows spec §40: the direction you are facing first, then the rest of
 * the ring, then the rest of the route. Anything already cached is skipped.
 */
export function rankPrefetch(opts: {
  currentUrl: string;
  facing: string | null;
  ring: Array<{ direction: string; url: string }>;
  route: string[];
  cache: PanoramaCache;
}): PreloadCandidate[] {
  const out: PreloadCandidate[] = [];
  const seen = new Set<string>([opts.currentUrl]);

  const push = (url: string, priority: number, reason: string) => {
    if (!url || seen.has(url)) return;
    if (opts.cache.has(url)) return;
    seen.add(url);
    out.push({ url, priority, reason });
  };

  for (const n of opts.ring) {
    if (n.direction === opts.facing) push(n.url, 100, `facing ${n.direction}`);
  }
  for (const n of opts.ring) {
    if (n.direction !== opts.facing) push(n.url, 60, `adjacent ${n.direction}`);
  }
  opts.route.forEach((url, i) => push(url, Math.max(1, 40 - i * 4), `route +${i + 1}`));

  return out.sort((a, b) => b.priority - a.priority);
}
