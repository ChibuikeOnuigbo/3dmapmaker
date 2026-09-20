import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanoramaCache, rankPrefetch } from './preloader';

/**
 * The cache is the thing that stops a 1,024-node world from holding 1,024
 * decoded plates in memory. These tests drive the REAL PanoramaCache against a
 * stubbed fetch, so the LRU order, the byte budget, the dedupe and the abort
 * behaviour are all exercised rather than assumed.
 */

let served: string[] = [];
let failNext = false;
let delayMs = 0;

function fakeBlob(size: number): Blob {
  return new Blob([new Uint8Array(size)], { type: 'image/jpeg' });
}

beforeEach(() => {
  served = [];
  failNext = false;
  delayMs = 0;
  // A tiny 2×2 image: decoded RGBA is 16 bytes, so the file size dominates and
  // the byte budget stays easy to reason about.
  const fetchMock = vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
    served.push(url);
    if (delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    if (failNext) return { ok: false, status: 500 } as unknown as Response;
    return { ok: true, status: 200, blob: async () => fakeBlob(64) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  // jsdom has no createImageBitmap; the cache falls back to <img>, which also
  // has no decoder here, so stub the whole decode path deterministically.
  vi.stubGlobal('createImageBitmap', undefined);
  const RealImage = globalThis.Image;
  class FakeImage {
    naturalWidth = 2;
    naturalHeight = 2;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', FakeImage as unknown as typeof RealImage);
  // jsdom ships no blob-URL support; the real browser path has it.
  if (typeof URL.createObjectURL !== 'function') {
    let n = 0;
    const created: string[] = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
      const u = `blob:fake/${n++}`;
      created.push(u);
      void b;
      return u;
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PanoramaCache — LRU eviction (spec §13)', () => {
  it('stores what it loads and reports a hit on the second read', async () => {
    const c = new PanoramaCache({ maxEntries: 4 });
    await c.load('/a.jpg');
    expect(c.has('/a.jpg')).toBe(true);
    expect(c.get('/a.jpg')).not.toBeNull();
    expect(c.get('/a.jpg')).not.toBeNull();
    expect(c.stats.hits).toBeGreaterThanOrEqual(2);
  });

  it('evicts the least recently used entry when the count budget is exceeded', async () => {
    const c = new PanoramaCache({ maxEntries: 3 });
    await c.load('/a.jpg');
    await c.load('/b.jpg');
    await c.load('/c.jpg');
    expect(c.size).toBe(3);
    // Touch a so b becomes the least recently used.
    c.get('/a.jpg');
    await c.load('/d.jpg');
    expect(c.size).toBe(3);
    expect(c.has('/b.jpg')).toBe(false);
    expect(c.has('/a.jpg')).toBe(true);
    expect(c.has('/c.jpg')).toBe(true);
    expect(c.has('/d.jpg')).toBe(true);
  });

  it('evicts by BYTES, not just by count, so a big plate cannot blow the budget', async () => {
    // Each entry costs 64 bytes; a 200-byte budget must hold at most 3.
    const c = new PanoramaCache({ maxEntries: 100, maxBytes: 200 });
    await c.load('/a.jpg');
    await c.load('/b.jpg');
    await c.load('/c.jpg');
    await c.load('/d.jpg');
    expect(c.size).toBeLessThanOrEqual(3);
    expect(c.bytes).toBeLessThanOrEqual(200);
  });

  it('never evicts the pinned plate — the one the player is standing in', async () => {
    const c = new PanoramaCache({ maxEntries: 2 });
    await c.load('/current.jpg');
    c.pin('/current.jpg');
    await c.load('/n1.jpg');
    await c.load('/n2.jpg');
    await c.load('/n3.jpg');
    expect(c.has('/current.jpg')).toBe(true);
  });

  it('reports its real footprint', async () => {
    const c = new PanoramaCache({ maxEntries: 8 });
    await c.load('/a.jpg');
    await c.load('/b.jpg');
    const s = c.stats;
    expect(s.entries).toBe(2);
    expect(s.bytes).toBe(128);
    expect(s.failed).toEqual([]);
  });
});

describe('PanoramaCache — dedupe and errors', () => {
  it('collapses concurrent loads of the same url into one request', async () => {
    const c = new PanoramaCache();
    await Promise.all([c.load('/a.jpg'), c.load('/a.jpg'), c.load('/a.jpg')]);
    expect(served.filter((u) => u === '/a.jpg').length).toBe(1);
    expect(c.size).toBe(1);
  });

  it('records a failure without poisoning later loads', async () => {
    const c = new PanoramaCache();
    failNext = true;
    await expect(c.load('/bad.jpg')).rejects.toThrow(/500/);
    expect(c.has('/bad.jpg')).toBe(false);
    expect(c.stats.failed).toContain('/bad.jpg');
    failNext = false;
    await expect(c.load('/good.jpg')).resolves.toBeTruthy();
    expect(c.has('/good.jpg')).toBe(true);
  });

  it('does not list the same failing url twice', async () => {
    const c = new PanoramaCache();
    failNext = true;
    await c.load('/bad.jpg').catch(() => undefined);
    await c.load('/bad.jpg').catch(() => undefined);
    expect(c.stats.failed.filter((u) => u === '/bad.jpg').length).toBe(1);
  });
});

describe('PanoramaCache — cancellation (every async job must be discardable)', () => {
  it('aborts an in-flight load when its signal fires', async () => {
    delayMs = 200;
    const c = new PanoramaCache();
    const ctrl = new AbortController();
    const p = c.load('/slow.jpg', { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(c.has('/slow.jpg')).toBe(false);
    expect(c.stats.aborted).toBe(1);
  });

  it('abortAll cancels everything and leaves the cache usable', async () => {
    delayMs = 200;
    const c = new PanoramaCache();
    const p1 = c.load('/s1.jpg').catch((e: Error) => e.name);
    const p2 = c.load('/s2.jpg').catch((e: Error) => e.name);
    c.abortAll();
    expect(await p1).toBe('AbortError');
    expect(await p2).toBe('AbortError');
    delayMs = 0;
    await expect(c.load('/after.jpg')).resolves.toBeTruthy();
  });

  it('clear drops every plate', async () => {
    const c = new PanoramaCache();
    await c.load('/a.jpg');
    await c.load('/b.jpg');
    c.clear();
    expect(c.size).toBe(0);
    expect(c.bytes).toBe(0);
  });
});

describe('rankPrefetch — prioritisation (spec §40)', () => {
  const stubCache = { has: (url: string) => url === '/cached.jpg' } as unknown as PanoramaCache;
  const ring = [
    { direction: 'north', url: '/n.jpg' },
    { direction: 'east', url: '/e.jpg' },
    { direction: 'west', url: '/w.jpg' },
  ];

  it('puts the direction you are facing first', () => {
    const list = rankPrefetch({ currentUrl: '/here.jpg', facing: 'east', ring, route: [], cache: stubCache });
    expect(list[0].url).toBe('/e.jpg');
    expect(list[0].reason).toContain('facing');
  });

  it('then the rest of the ring, then the route', () => {
    const list = rankPrefetch({
      currentUrl: '/here.jpg',
      facing: 'north',
      ring,
      route: ['/r1.jpg', '/r2.jpg'],
      cache: stubCache,
    });
    const urls = list.map((c) => c.url);
    expect(urls[0]).toBe('/n.jpg');
    expect(urls.indexOf('/e.jpg')).toBeLessThan(urls.indexOf('/r1.jpg'));
    expect(urls.indexOf('/r1.jpg')).toBeLessThan(urls.indexOf('/r2.jpg'));
  });

  it('skips the plate you are already standing in', () => {
    const list = rankPrefetch({
      currentUrl: '/here.jpg',
      facing: null,
      ring: [...ring, { direction: 'south', url: '/here.jpg' }],
      route: [],
      cache: stubCache,
    });
    expect(list.some((c) => c.url === '/here.jpg')).toBe(false);
  });

  it('skips anything already cached', () => {
    const list = rankPrefetch({
      currentUrl: '/here.jpg',
      facing: null,
      ring: [...ring, { direction: 'south', url: '/cached.jpg' }],
      route: ['/cached.jpg', '/r1.jpg'],
      cache: stubCache,
    });
    expect(list.some((c) => c.url === '/cached.jpg')).toBe(false);
    expect(list.some((c) => c.url === '/r1.jpg')).toBe(true);
  });

  it('never lists a url twice even when the ring and the route overlap', () => {
    const list = rankPrefetch({
      currentUrl: '/here.jpg',
      facing: 'north',
      ring,
      route: ['/n.jpg', '/e.jpg', '/far.jpg'],
      cache: stubCache,
    });
    const urls = list.map((c) => c.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('returns nothing to do when everything is cached', () => {
    const all = { has: () => true } as unknown as PanoramaCache;
    const list = rankPrefetch({ currentUrl: '/here.jpg', facing: 'north', ring, route: ['/r.jpg'], cache: all });
    expect(list).toEqual([]);
  });

  it('priorities are strictly ordered so the queue is honest', () => {
    const list = rankPrefetch({ currentUrl: '/here.jpg', facing: 'east', ring, route: ['/r1.jpg'], cache: stubCache });
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].priority).toBeGreaterThanOrEqual(list[i].priority);
    }
  });
});
