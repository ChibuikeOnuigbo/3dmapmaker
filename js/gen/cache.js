/**
 * Panorama Maps — gen/cache.js
 *
 * PanoramaCache — the identity mechanism (Spec §30, §31, §64).
 *
 * - Same node → SAME image. Walking D→C→B→A returns the original A/B/C
 *   canvases; generation never re-runs for a visited node.
 * - Two-tier: decoded canvases live in a small LRU; metadata (phash, seed,
 *   validation, incomplete-region report) persists forever per node so the
 *   identity chain survives eviction.
 */
export class PanoramaCache {
  constructor({ capacity = 6 } = {}) {
    this.capacity = capacity;
    this.lru = new Map();     // nodeId -> {canvas, meta}; Map preserves insertion order
    this.meta = new Map();    // nodeId -> meta (never evicted)
    this._visitOrder = [];
  }

  has(nodeId) { return this.lru.has(nodeId); }
  metaOf(nodeId) { return this.meta.get(nodeId) || null; }

  recentMetas(k = 5) {
    const out = [];
    for (let i = this._visitOrder.length - 1; i >= 0 && out.length < k; i--) {
      const m = this.meta.get(this._visitOrder[i]);
      if (m && !out.some(o => o.nodeId === m.nodeId)) out.push(m);
    }
    return out;
  }

  /**
   * Get (or lazily create via factory) the panorama for a node.
   * @param {(meta:object)=>Promise<{canvas:HTMLCanvasElement, meta:object}>|null} factory
   *        factory receives any cached meta (for seed stability).
   */
  async get(nodeId, factory) {
    const hit = this.lru.get(nodeId);
    if (hit) {
      this.lru.delete(nodeId); this.lru.set(nodeId, hit);   // touch
      this._markVisit(nodeId);
      return hit;
    }
    if (!factory) return null;
    const priorMeta = this.meta.get(nodeId) || null;
    const produced = await factory(priorMeta);
    const entry = { canvas: produced.canvas, meta: { ...produced.meta, nodeId } };
    this.lru.set(nodeId, entry);
    this.meta.set(nodeId, entry.meta);
    this._markVisit(nodeId);
    this._evict();
    return entry;
  }

  _markVisit(nodeId) { this._visitOrder.push(nodeId); }

  _evict() {
    while (this.lru.size > this.capacity) {
      const oldest = this.lru.keys().next().value;
      this.lru.delete(oldest);
      this.busEmit?.('cache:evicted', { nodeId: oldest });
    }
  }

  /** Drop decoded canvases but keep metadata (world switch / memory pressure). */
  clearDecoded() { this.lru.clear(); }
  clearAll() { this.lru.clear(); this.meta.clear(); this._visitOrder.length = 0; }

  get decodedCount() { return this.lru.size; }
}

/**
 * Heading-aware prefetch plan (Spec §54, §55): forward neighbor first,
 * then side neighbors, capped by the performance profile.
 */
export function prefetchPlan(graph, nodeId, yawDeg, limit) {
  const edges = graph.edgesOf(nodeId).filter(e => !e.blocked);
  const ranked = edges
    .map(e => ({ id: graph.otherEnd(e, nodeId), delta: Math.abs(normDelta(graph.edgeBearing(e, nodeId), yawDeg)) }))
    .sort((a, b) => a.delta - b.delta);
  return ranked.slice(0, limit).map(r => r.id);
}
function normDelta(a, b) { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; }
