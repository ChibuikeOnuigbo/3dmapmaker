/**
 * packages/panorama — location graph and transitions
 * (REQUIREMENT 041, 042, 043, 044).
 *
 * A panorama world is a graph: nodes carry a local-space position, a heading
 * and an image; directed edges ("neighbors") carry a direction label. Movement
 * follows edges. This is the same conceptual model as the old repository's
 * `locations[].links`, but the traversal is bounded and the validation happens
 * on write, so it cannot recurse infinitely.
 */
import { clampPanoramaPitch } from './panorama';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PanoramaNode {
  id: string;
  name: string;
  position: Vec3;
  headingDeg: number;
  image: string;
  neighbors: Record<string, string>;
  vfovDeg?: number;
}

export interface PanoramaGraphIssue {
  code: 'duplicate_id' | 'self_link' | 'dangling' | 'unreachable' | 'missing_image' | 'cycle';
  nodeId: string;
  detail: string;
}

export class PanoramaGraph {
  private nodes = new Map<string, PanoramaNode>();
  /** Adjacency built once per mutation, not per query. */
  private adjacency = new Map<string, string[]>();

  constructor(nodes: ReadonlyArray<PanoramaNode> = []) {
    this.replaceAll(nodes);
  }

  replaceAll(nodes: ReadonlyArray<PanoramaNode>): void {
    this.nodes = new Map();
    for (const n of nodes) {
      if (this.nodes.has(n.id)) continue; // first wins; audit reports the dup
      this.nodes.set(n.id, { ...n, neighbors: { ...n.neighbors } });
    }
    this.rebuildAdjacency();
  }

  private rebuildAdjacency(): void {
    this.adjacency = new Map();
    for (const [id, node] of this.nodes) {
      const targets: string[] = [];
      for (const target of Object.values(node.neighbors)) {
        if (target && this.nodes.has(target)) targets.push(target);
      }
      this.adjacency.set(id, targets);
    }
  }

  get size(): number {
    return this.nodes.size;
  }

  get(id: string): PanoramaNode | null {
    return this.nodes.get(id) ?? null;
  }

  ids(): string[] {
    return [...this.nodes.keys()];
  }

  all(): PanoramaNode[] {
    return [...this.nodes.values()];
  }

  neighborsOf(id: string): PanoramaNode[] {
    return (this.adjacency.get(id) ?? []).map((n) => this.nodes.get(n)!).filter(Boolean);
  }

  /** Resolve a direction label from a node. */
  resolve(id: string, direction: string): PanoramaNode | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    const target = node.neighbors[direction];
    return target ? (this.nodes.get(target) ?? null) : null;
  }

  /** Direction labels available from a node, in a stable order. */
  directionsFrom(id: string): string[] {
    const node = this.nodes.get(id);
    if (!node) return [];
    return Object.entries(node.neighbors)
      .filter(([, v]) => Boolean(v) && this.nodes.has(v))
      .map(([k]) => k);
  }

  /**
   * The direction whose neighbour lies closest to a desired movement vector.
   * This powers "walk this way" from the arrow keys / joystick in panorama mode.
   */
  directionTowards(id: string, desired: { x: number; y: number }): string | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    let best: string | null = null;
    let bestDot = 0.15; // require a real alignment, not a perpendicular hop
    const len = Math.hypot(desired.x, desired.y) || 1;
    const dx = desired.x / len;
    const dy = desired.y / len;
    for (const [dir, targetId] of Object.entries(node.neighbors)) {
      const target = this.nodes.get(targetId);
      if (!target) continue;
      const tx = target.position.x - node.position.x;
      const ty = target.position.z - node.position.z;
      const tl = Math.hypot(tx, ty);
      if (tl < 1e-6) continue;
      const dot = (tx / tl) * dx + (ty / tl) * dy;
      if (dot > bestDot) {
        bestDot = dot;
        best = dir;
      }
    }
    return best;
  }

  /**
   * Shortest path between two nodes (BFS, bounded). Returns node ids or null
   * when they are in different components.
   */
  path(fromId: string, toId: string, maxNodes = 10000): string[] | null {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return null;
    if (fromId === toId) return [fromId];
    const prev = new Map<string, string>();
    const queue: string[] = [fromId];
    let visited = 0;
    while (queue.length && visited < maxNodes) {
      const cur = queue.shift()!;
      visited++;
      for (const next of this.adjacency.get(cur) ?? []) {
        if (prev.has(next) || next === fromId) continue;
        prev.set(next, cur);
        if (next === toId) {
          const path: string[] = [toId];
          let c = toId;
          while (c !== fromId) {
            c = prev.get(c)!;
            path.unshift(c);
          }
          return path;
        }
        queue.push(next);
      }
    }
    return null;
  }

  /** Nodes reachable from a start node — used to report disconnected content. */
  reachableFrom(startId: string, maxNodes = 10000): Set<string> {
    const seen = new Set<string>();
    if (!this.nodes.has(startId)) return seen;
    const stack = [startId];
    while (stack.length && seen.size < maxNodes) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const n of this.adjacency.get(cur) ?? []) stack.push(n);
    }
    return seen;
  }

  /**
   * Full structural audit. Iterative, so a cyclic graph cannot blow the stack —
   * the crash class from the old repository (REQUIREMENT 004).
   */
  audit(): PanoramaGraphIssue[] {
    const issues: PanoramaGraphIssue[] = [];
    const seenIds = new Set<string>();

    for (const node of this.nodes.values()) {
      if (seenIds.has(node.id)) {
        issues.push({ code: 'duplicate_id', nodeId: node.id, detail: 'Duplicate panorama node id' });
        continue;
      }
      seenIds.add(node.id);
      if (!node.image) {
        issues.push({ code: 'missing_image', nodeId: node.id, detail: `"${node.name || node.id}" has no image` });
      }
      for (const [dir, target] of Object.entries(node.neighbors)) {
        if (!target) continue;
        if (target === node.id) {
          issues.push({ code: 'self_link', nodeId: node.id, detail: `Direction "${dir}" links to itself` });
        } else if (!this.nodes.has(target)) {
          issues.push({ code: 'dangling', nodeId: node.id, detail: `Direction "${dir}" points at missing node "${target}"` });
        }
      }
    }

    const start = this.nodes.keys().next().value as string | undefined;
    if (start) {
      const reachable = this.reachableFrom(start);
      for (const id of this.nodes.keys()) {
        if (!reachable.has(id)) {
          issues.push({ code: 'unreachable', nodeId: id, detail: `"${id}" is not connected to the graph` });
        }
      }
    }
    return issues;
  }

  /** Add/replace a node and re-link. Returns the audit issues introduced. */
  upsert(node: PanoramaNode): PanoramaGraphIssue[] {
    this.nodes.set(node.id, { ...node, neighbors: { ...node.neighbors } });
    this.rebuildAdjacency();
    return this.audit();
  }

  remove(id: string): void {
    this.nodes.delete(id);
    for (const node of this.nodes.values()) {
      for (const [dir, target] of Object.entries(node.neighbors)) {
        if (target === id) delete node.neighbors[dir];
      }
    }
    this.rebuildAdjacency();
  }

  link(fromId: string, direction: string, toId: string, bidirectional = true): PanoramaGraphIssue[] {
    const from = this.nodes.get(fromId);
    const to = this.nodes.get(toId);
    if (!from || !to) {
      return [{ code: 'dangling', nodeId: fromId, detail: 'Cannot link nodes that do not exist' }];
    }
    if (fromId === toId) {
      return [{ code: 'self_link', nodeId: fromId, detail: 'A node cannot link to itself' }];
    }
    from.neighbors[direction] = toId;
    if (bidirectional) to.neighbors[oppositeDirection(direction)] = fromId;
    this.rebuildAdjacency();
    return this.audit();
  }

  unlink(fromId: string, direction: string): void {
    const from = this.nodes.get(fromId);
    if (!from) return;
    const target = from.neighbors[direction];
    delete from.neighbors[direction];
    if (target) {
      const t = this.nodes.get(target);
      if (t) {
        const back = oppositeDirection(direction);
        if (t.neighbors[back] === fromId) delete t.neighbors[back];
      }
    }
    this.rebuildAdjacency();
  }

  toJSON(): PanoramaNode[] {
    return this.all().map((n) => ({ ...n, neighbors: { ...n.neighbors } }));
  }
}

const OPPOSITES: Record<string, string> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
  up: 'down',
  down: 'up',
  northeast: 'southwest',
  southwest: 'northeast',
  northwest: 'southeast',
  southeast: 'northwest',
};

export function oppositeDirection(dir: string): string {
  return OPPOSITES[dir.toLowerCase()] ?? `${dir}-back`;
}

/* ------------------------------------------------------------- transitions --- */

export interface PanoramaTransitionState {
  phase: 'idle' | 'loading' | 'crossfading' | 'done';
  progress: number; // 0..1
  fromId: string | null;
  toId: string | null;
  /** True while the previous panorama is still on screen (persistence). */
  persistenceActive: boolean;
}

export interface PanoramaTransitionOptions {
  durationMs: number;
  persistence: { enabled: boolean; strength: number; mode: 'fade' | 'blur' | 'echo'; keepCameraState: boolean };
}

/**
 * A cancellable panorama transition.
 *
 * Unlike the old implementation there is no `setTimeout` chain and no
 * `toDataURL()`. The previous panorama stays on a second sphere whose opacity is
 * driven by `progress`, so interruption is exact and free.
 */
export class PanoramaTransition {
  private startedAt = 0;
  private durationMs: number;
  private opts: PanoramaTransitionOptions;
  private running = false;
  private fromId: string | null = null;
  private toId: string | null = null;
  private generation = 0;
  private interruptions = 0;

  constructor(opts: PanoramaTransitionOptions) {
    this.opts = opts;
    this.durationMs = Math.max(40, opts.durationMs);
  }

  setOptions(opts: PanoramaTransitionOptions): void {
    this.opts = opts;
    this.durationMs = Math.max(40, opts.durationMs);
  }

  get isRunning(): boolean {
    return this.running;
  }
  get currentGeneration(): number {
    return this.generation;
  }
  get stats() {
    return { interruptions: this.interruptions, generation: this.generation };
  }

  start(fromId: string | null, toId: string, now = Date.now()): number {
    this.generation++;
    this.fromId = fromId;
    this.toId = toId;
    this.startedAt = now;
    this.running = true;
    return this.generation;
  }

  /** Advance and return the state the renderer should draw. */
  update(now = Date.now()): PanoramaTransitionState {
    if (!this.running) {
      return { phase: 'idle', progress: 1, fromId: this.fromId, toId: this.toId, persistenceActive: false };
    }
    const t = Math.max(0, Math.min(1, (now - this.startedAt) / this.durationMs));
    if (t >= 1) {
      this.running = false;
      return { phase: 'done', progress: 1, fromId: this.fromId, toId: this.toId, persistenceActive: false };
    }
    return {
      phase: 'crossfading',
      progress: t,
      fromId: this.fromId,
      toId: this.toId,
      persistenceActive: this.opts.persistence.enabled,
    };
  }

  /** Opacity of the OUTGOING panorama at the current progress. */
  outgoingOpacity(state: PanoramaTransitionState): number {
    if (!this.opts.persistence.enabled) return state.progress < 0.5 ? 1 : 0;
    const s = this.opts.persistence.strength;
    // ease out so the old view lingers a little, then clears fully
    const eased = 1 - state.progress * state.progress;
    return Math.max(0, eased * s);
  }

  /** Interrupt (e.g. the user clicks another node mid-transition). */
  cancel(): boolean {
    if (!this.running) return false;
    this.running = false;
    this.interruptions++;
    return true;
  }

  reset(): void {
    this.running = false;
    this.fromId = null;
    this.toId = null;
  }
}

/* --------------------------------------------------- synthetic movement --- */

export interface SyntheticMoveRequest {
  /** Current node. */
  from: PanoramaNode;
  /** Node we are moving towards. */
  to: PanoramaNode;
  /** Desired travel direction in local XZ, unit length. */
  direction: { x: number; y: number };
  /** How far the user has dragged, 0..1 of the way to the next node. */
  t: number;
}

export interface SyntheticMovePlan {
  /** Camera position along the from->to segment. */
  position: Vec3;
  /** Spheres to draw, back to front, with their scale and opacity. */
  layers: Array<{ nodeId: string; center: Vec3; scale: number; opacity: number; zOrder: number }>;
  /** Fraction of the view that has no source imagery — the "revealed gap". */
  revealedGapFraction: number;
  /** Pitch clamp applied so the poles are not exposed during the move. */
  pitchClampDeg: number;
}

/**
 * REQUIREMENT 043: when we synthesise movement between two panoramas we must
 * compute how much of the view has been *revealed* and place the neighbouring
 * image spatially to cover it — not crossfade two unrelated images.
 *
 * Model: the camera slides along the segment from->to. The outgoing sphere is
 * centred on `from` and the incoming sphere is centred on `to`; both are drawn
 * at their true relative positions and scaled so their angular size stays
 * consistent with the baseline distance. The revealed gap is the solid angle
 * that lies behind the outgoing sphere's limb as the camera leaves its centre.
 */
export function planSyntheticMove(req: SyntheticMoveRequest, baselineDistance: number): SyntheticMovePlan {
  const t = Math.max(0, Math.min(1, req.t));
  const from = req.from.position;
  const to = req.to.position;
  const position = {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: from.z + (to.z - from.z) * t,
  };

  const base = Math.max(1, baselineDistance);
  const distFrom = Math.hypot(position.x - from.x, position.y - from.y, position.z - from.z);
  const distTo = Math.hypot(position.x - to.x, position.y - to.y, position.z - to.z);

  // A sphere seen from distance d at radius R keeps angular size if R scales
  // with d. We keep the panorama radius fixed and instead scale the sphere.
  const scaleFrom = Math.max(0.05, 1 + distFrom / base);
  const scaleTo = Math.max(0.05, 1 + distTo / base);

  // Revealed gap grows as the camera leaves the outgoing centre: the fraction
  // of the hemisphere that the outgoing image can no longer cover.
  const gap = Math.min(1, distFrom / (base * 2));

  const layers: SyntheticMovePlan['layers'] = [];
  layers.push({
    nodeId: req.from.id,
    center: { ...from },
    scale: scaleFrom,
    opacity: 1 - Math.pow(t, 1.6) * 0.85,
    zOrder: 1,
  });
  layers.push({
    nodeId: req.to.id,
    center: { ...to },
    scale: scaleTo,
    // the incoming image fades in only as fast as it actually covers new area
    opacity: Math.min(1, t * 1.4),
    zOrder: 0,
  });

  return {
    position,
    layers,
    revealedGapFraction: gap,
    // Tighten the pitch clamp while moving so the stretched poles stay hidden.
    pitchClampDeg: 60 - gap * 12,
  };
}

/**
 * Optional synthetic depth parallax (REQUIREMENT 044).
 *
 * Given a depth map (normalised 0..1, near=1), warp the equirect UV by a small
 * view-dependent offset. This is explicitly *synthetic* and is surfaced as such
 * in the UI.
 */
export function depthParallaxOffset(
  uv: { x: number; y: number },
  viewDir: { x: number; y: number },
  depth: number,
  scale: number,
): { x: number; y: number } {
  const d = Math.max(0, Math.min(1, depth));
  return {
    x: uv.x + viewDir.x * (1 - d) * scale * 0.01,
    y: uv.y + viewDir.y * (1 - d) * scale * 0.01,
  };
}

/** Apply the panorama pitch clamp, exported so the camera layer and UI agree. */
export function applyPanoramaPitchClamp(pitchDeg: number, limitDeg: number): number {
  return clampPanoramaPitch(pitchDeg, limitDeg);
}
