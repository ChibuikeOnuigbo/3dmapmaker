/**
 * packages/scene-core — labels and markers (REQUIREMENT 090, 091).
 *
 * Priority/distance aware placement with rectangle collision avoidance. Runs in
 * O(n log n) for the sort plus O(n·k) for placement against an occupancy grid,
 * which keeps it inside the frame budget at a few hundred labels.
 */

export interface LabelCandidate {
  id: string;
  text: string;
  /** Screen position in CSS pixels. */
  x: number;
  y: number;
  visible: boolean;
  /** Camera distance in metres — nearer wins. */
  distance: number;
  /** Higher priority wins ties (0..100). */
  priority: number;
  /** Pixel size of the rendered label. */
  width: number;
  height: number;
  /** Anchor offsets allowed, tried in order. */
  anchors?: Array<{ dx: number; dy: number }>;
}

export interface PlacedLabel extends LabelCandidate {
  placedX: number;
  placedY: number;
  anchorIndex: number;
}

const DEFAULT_ANCHORS = [
  { dx: 0, dy: -1.35 },
  { dx: 0, dy: 0.35 },
  { dx: 1.1, dy: -0.5 },
  { dx: -1.1, dy: -0.5 },
  { dx: 1.1, dy: 0 },
  { dx: -1.1, dy: 0 },
];

/** Uniform grid so overlap tests are O(1) amortised instead of O(n) per label. */
class OccupancyGrid {
  private cells = new Map<number, Array<{ x0: number; y0: number; x1: number; y1: number }>>();
  constructor(private cellSize = 64) {}

  private key(cx: number, cy: number): number {
    return cx * 100003 + cy;
  }

  insert(x0: number, y0: number, x1: number, y1: number): void {
    const cs = this.cellSize;
    const cx0 = Math.floor(x0 / cs);
    const cy0 = Math.floor(y0 / cs);
    const cx1 = Math.floor(x1 / cs);
    const cy1 = Math.floor(y1 / cs);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const k = this.key(cx, cy);
        let arr = this.cells.get(k);
        if (!arr) {
          arr = [];
          this.cells.set(k, arr);
        }
        arr.push({ x0, y0, x1, y1 });
      }
    }
  }

  overlaps(x0: number, y0: number, x1: number, y1: number, padding = 2): boolean {
    const cs = this.cellSize;
    const cx0 = Math.floor((x0 - padding) / cs);
    const cy0 = Math.floor((y0 - padding) / cs);
    const cx1 = Math.floor((x1 + padding) / cs);
    const cy1 = Math.floor((y1 + padding) / cs);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const arr = this.cells.get(this.key(cx, cy));
        if (!arr) continue;
        for (const r of arr) {
          if (x0 - padding < r.x1 && x1 + padding > r.x0 && y0 - padding < r.y1 && y1 + padding > r.y0) return true;
        }
      }
    }
    return false;
  }

  clear(): void {
    this.cells.clear();
  }
}

export interface LayoutResult {
  placed: PlacedLabel[];
  dropped: number;
  durationMs: number;
}

/**
 * Lay out labels for one frame.
 *
 * @param maxLabels hard cap so a pathological document cannot blow the budget
 */
export function layoutLabels(
  candidates: ReadonlyArray<LabelCandidate>,
  viewport: { width: number; height: number },
  maxLabels = 200,
): LayoutResult {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const sorted = [...candidates]
    .filter((c) => c.visible)
    .sort((a, b) => b.priority - a.priority || a.distance - b.distance);

  const grid = new OccupancyGrid(64);
  const placed: PlacedLabel[] = [];
  let dropped = 0;

  for (const c of sorted) {
    if (placed.length >= maxLabels) {
      dropped++;
      continue;
    }
    if (c.x < -200 || c.y < -200 || c.x > viewport.width + 200 || c.y > viewport.height + 200) {
      dropped++;
      continue;
    }
    const anchors = c.anchors ?? DEFAULT_ANCHORS;
    let ok = false;
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const cx = c.x + a.dx * c.width * 0.5;
      const cy = c.y + a.dy * c.height;
      const x0 = cx - c.width / 2;
      const y0 = cy - c.height / 2;
      const x1 = cx + c.width / 2;
      const y1 = cy + c.height / 2;
      if (x0 < 0 || y0 < 0 || x1 > viewport.width || y1 > viewport.height) continue;
      if (grid.overlaps(x0, y0, x1, y1)) continue;
      grid.insert(x0, y0, x1, y1);
      placed.push({ ...c, placedX: cx, placedY: cy, anchorIndex: i });
      ok = true;
      break;
    }
    if (!ok) dropped++;
  }

  const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { placed, dropped, durationMs: end - start };
}

/** Fade labels by distance so far labels disappear instead of cluttering. */
export function labelOpacityByDistance(distance: number, fadeStart: number, fadeEnd: number): number {
  if (distance <= fadeStart) return 1;
  if (distance >= fadeEnd) return 0;
  return 1 - (distance - fadeStart) / Math.max(1e-6, fadeEnd - fadeStart);
}

/**
 * Adaptive grid spacing for the world/local/geographic grid (REQUIREMENT 076).
 * Returns a spacing in metres whose projected size lands close to `targetPx`.
 */
export function adaptiveGridSpacing(metersPerPixel: number, targetPx = 96): number {
  const raw = metersPerPixel * targetPx;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, raw))));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return step * mag;
}

/** Human-readable scale bar value (REQUIREMENT 079). */
export function niceScaleBar(meters: number): { value: number; label: string } {
  const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
  let best = candidates[0];
  for (const c of candidates) {
    if (c <= meters) best = c;
    else break;
  }
  return {
    value: best,
    label: best >= 1000 ? `${best / 1000} km` : `${best} m`,
  };
}
