/**
 * packages/performance — byte-accounted LRU cache (REQUIREMENT 126).
 *
 * Used for terrain meshes, imagery tiles, textures, thumbnails and analysis
 * results. Entries report their own byte size so the cap is a real memory
 * budget rather than an entry count.
 */

export interface CacheEntry<V> {
  key: string;
  value: V;
  bytes: number;
  hits: number;
  createdAt: number;
  lastUsedAt: number;
  /** Never evicted (e.g. a tile the user is actively sculpting). */
  pinned: boolean;
  /** Optional disposal hook — used to release GPU resources. */
  dispose?: (value: V) => void;
}

export interface LruCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  onEvict?: (entry: CacheEntry<unknown>) => void;
}

export class LruCache<V> {
  private readonly map = new Map<string, CacheEntry<V>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;
  private evictions = 0;
  private hits = 0;
  private misses = 0;
  private readonly onEvict?: (entry: CacheEntry<unknown>) => void;

  constructor(opts: LruCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 512;
    this.maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
    this.onEvict = opts.onEvict;
  }

  get size(): number {
    return this.map.size;
  }
  get usedBytes(): number {
    return this.bytes;
  }
  get stats() {
    return {
      entries: this.map.size,
      bytes: this.bytes,
      evictions: this.evictions,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
    };
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) {
      this.misses++;
      return undefined;
    }
    // Re-insert to move to the most-recently-used end of the Map's iteration order.
    this.map.delete(key);
    e.lastUsedAt = Date.now();
    e.hits++;
    this.map.set(key, e);
    this.hits++;
    return e.value;
  }

  peek(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  set(key: string, value: V, bytes: number, opts: { pinned?: boolean; dispose?: (v: V) => void } = {}): void {
    const existing = this.map.get(key);
    if (existing) {
      this.bytes -= existing.bytes;
      this.map.delete(key);
    }
    const entry: CacheEntry<V> = {
      key,
      value,
      bytes,
      hits: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      pinned: opts.pinned ?? false,
      dispose: opts.dispose,
    };
    this.map.set(key, entry);
    this.bytes += bytes;
    this.evictIfNeeded();
  }

  pin(key: string, pinned = true): void {
    const e = this.map.get(key);
    if (e) e.pinned = pinned;
  }

  delete(key: string): boolean {
    const e = this.map.get(key);
    if (!e) return false;
    this.bytes -= e.bytes;
    this.map.delete(key);
    e.dispose?.(e.value);
    return true;
  }

  clear(): void {
    for (const e of this.map.values()) e.dispose?.(e.value);
    this.map.clear();
    this.bytes = 0;
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  private evictIfNeeded(): void {
    let guard = 0;
    while ((this.map.size > this.maxEntries || this.bytes > this.maxBytes) && guard++ < 10000) {
      // Map iterates in insertion order; the first non-pinned entry is the LRU.
      let victim: CacheEntry<V> | null = null;
      for (const e of this.map.values()) {
        if (!e.pinned) {
          victim = e;
          break;
        }
      }
      if (!victim) break; // everything pinned — refuse to break correctness
      this.map.delete(victim.key);
      this.bytes -= victim.bytes;
      this.evictions++;
      victim.dispose?.(victim.value);
      this.onEvict?.(victim as CacheEntry<unknown>);
    }
  }
}
