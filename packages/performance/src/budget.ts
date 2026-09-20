/**
 * packages/performance — frame budget, adaptive quality and profiling
 * (REQUIREMENT 139, 142, HARDENING CHECK 007).
 */

export type QualityTier = 'low' | 'normal' | 'high';

export interface QualityProfile {
  tier: QualityTier;
  pixelRatioCap: number;
  shadowMapSize: number;
  shadowsEnabled: boolean;
  maxActiveTiles: number;
  maxConcurrentLoads: number;
  maxScreenSpaceError: number;
  vegetationDensity: number;
  postEnabled: boolean;
  anisotropy: number;
  antialias: boolean;
}

export const QUALITY_PROFILES: Record<QualityTier, QualityProfile> = {
  low: {
    tier: 'low',
    pixelRatioCap: 1,
    shadowMapSize: 512,
    shadowsEnabled: false,
    maxActiveTiles: 24,
    maxConcurrentLoads: 3,
    maxScreenSpaceError: 24,
    vegetationDensity: 0.25,
    postEnabled: false,
    anisotropy: 1,
    antialias: false,
  },
  normal: {
    tier: 'normal',
    pixelRatioCap: 1.5,
    shadowMapSize: 1024,
    shadowsEnabled: true,
    maxActiveTiles: 48,
    maxConcurrentLoads: 5,
    maxScreenSpaceError: 12,
    vegetationDensity: 0.6,
    postEnabled: true,
    anisotropy: 4,
    antialias: true,
  },
  high: {
    tier: 'high',
    pixelRatioCap: 2,
    shadowMapSize: 2048,
    shadowsEnabled: true,
    maxActiveTiles: 96,
    maxConcurrentLoads: 8,
    maxScreenSpaceError: 6,
    vegetationDensity: 1,
    postEnabled: true,
    anisotropy: 8,
    antialias: true,
  },
};

export function profileFor(tier: QualityTier, overrides: Partial<QualityProfile> = {}): QualityProfile {
  return { ...QUALITY_PROFILES[tier], ...overrides, tier };
}

/**
 * Adaptive quality controller. Watches the real frame time and steps the tier
 * down when the budget is repeatedly missed, back up when there is sustained
 * headroom. It never oscillates: a tier change requires a full window of
 * consecutive samples plus a cooldown.
 */
export class AdaptiveQuality {
  private readonly windowMs = 1000;
  private samples: number[] = [];
  private lastChange = 0;
  private tier: QualityTier;
  readonly enabled: boolean;

  constructor(initial: QualityTier = 'normal', enabled = true) {
    this.tier = initial;
    this.enabled = enabled;
  }

  get current(): QualityTier {
    return this.tier;
  }

  /** Feed one frame's delta in milliseconds. Returns a new tier when it changes. */
  pushFrame(dtMs: number, now = Date.now()): QualityTier | null {
    if (!this.enabled) return null;
    this.samples.push(dtMs);
    // keep ~2s of samples
    while (this.samples.length > 240) this.samples.shift();

    if (this.samples.length < 45) return null; // need a real window before judging
    if (now - this.lastChange < 2500) return null; // cooldown

    const sorted = [...this.samples].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const median = sorted[Math.floor(sorted.length / 2)];

    const order: QualityTier[] = ['low', 'normal', 'high'];
    const idx = order.indexOf(this.tier);

    if (p95 > 33 || median > 22) {
      if (idx > 0) {
        this.tier = order[idx - 1];
        this.lastChange = now;
        this.samples = [];
        return this.tier;
      }
    } else if (p95 < 14 && median < 11) {
      if (idx < order.length - 1) {
        this.tier = order[idx + 1];
        this.lastChange = now;
        this.samples = [];
        return this.tier;
      }
    }
    return null;
  }

  reset(tier?: QualityTier): void {
    this.samples = [];
    this.lastChange = 0;
    if (tier) this.tier = tier;
  }
}

/* ------------------------------------------------------------------ stats --- */

export interface FrameStats {
  fps: number;
  frameMs: number;
  cpuMs: number;
  gpuMsHint: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  tiles: { active: number; loading: number; queued: number; failed: number };
  cacheBytes: number;
}

export class Profiler {
  private frames: number[] = [];
  private cpu: number[] = [];
  private lastReport = 0;
  private latest: FrameStats | null = null;

  /** Call at the top of the frame with the raw rAF delta. */
  beginFrame(now: number): number {
    return now;
  }

  endFrame(now: number, start: number, info?: Partial<FrameStats>): void {
    const cpuMs = now - start;
    this.cpu.push(cpuMs);
    if (this.cpu.length > 240) this.cpu.shift();
    const frameMs = this.frames.length ? now - (this.frames[this.frames.length - 1] ?? now) : 16.7;
    this.frames.push(now);
    if (this.frames.length > 240) this.frames.shift();

    if (now - this.lastReport < 250) return;
    this.lastReport = now;

    const recent = this.frames.slice(-60);
    const span = recent.length > 1 ? recent[recent.length - 1] - recent[0] : 1;
    const fps = span > 0 ? ((recent.length - 1) * 1000) / span : 0;
    const avgCpu = this.cpu.reduce((a, b) => a + b, 0) / Math.max(1, this.cpu.length);

    this.latest = {
      fps,
      frameMs: span / Math.max(1, recent.length - 1),
      cpuMs: avgCpu,
      gpuMsHint: 0,
      drawCalls: info?.drawCalls ?? 0,
      triangles: info?.triangles ?? 0,
      geometries: info?.geometries ?? 0,
      textures: info?.textures ?? 0,
      programs: info?.programs ?? 0,
      tiles: info?.tiles ?? { active: 0, loading: 0, queued: 0, failed: 0 },
      cacheBytes: info?.cacheBytes ?? 0,
    };
  }

  get stats(): FrameStats | null {
    return this.latest;
  }

  snapshot(): FrameStats | null {
    return this.latest ? { ...this.latest } : null;
  }
}

/**
 * Named timers for the benchmark harness (REQUIREMENT 142). Each phase records
 * wall-clock milliseconds; `report()` returns them so `scripts/run-bench.mjs`
 * can assert on real numbers.
 */
export class Benchmark {
  private marks = new Map<string, { start: number; end?: number; ms?: number }>();

  mark(name: string): void {
    const existing = this.marks.get(name);
    if (existing && existing.end === undefined) {
      existing.end = performance.now();
      existing.ms = existing.end - existing.start;
    } else {
      this.marks.set(name, { start: performance.now() });
    }
  }

  measure<T>(name: string, fn: () => T): T {
    const start = performance.now();
    const out = fn();
    this.marks.set(name, { start, end: performance.now(), ms: performance.now() - start });
    return out;
  }

  async measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const out = await fn();
    this.marks.set(name, { start, end: performance.now(), ms: performance.now() - start });
    return out;
  }

  report(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.marks) if (v.ms !== undefined) out[k] = Number(v.ms.toFixed(3));
    return out;
  }
}
