/**
 * Panorama Maps — core/movement.js
 *
 * MovementController + MovementValidator (Spec §5, §6, §36, §37, §38).
 *
 * WASD is NOT "switch image". The pipeline is:
 *   key → camera-relative direction → world bearing → candidate edge →
 *   boundary/blocked check → valid? → walk along the edge with a distance-
 *   paced transition → new node → panorama load → map update.
 *
 * The pure planners in this file are DOM-free and unit-tested in Node.
 */
import { angleDelta, snapToDir } from './world-graph.js';

export const KEY_DIRS = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'backward', ArrowDown: 'backward',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

/** Camera-relative movement direction → world bearing in degrees. */
export function desiredBearing(relativeDir, yawDeg) {
  switch (relativeDir) {
    case 'forward': return ((yawDeg % 360) + 360) % 360;
    case 'backward': return ((yawDeg + 180) % 360 + 360) % 360;
    case 'left': return ((yawDeg - 90) % 360 + 360) % 360;
    case 'right': return ((yawDeg + 90) % 360 + 360) % 360;
    default: throw new Error(`unknown direction ${relativeDir}`);
  }
}

/**
 * Plan a single movement step against the world graph (Spec §23:
 * boundary validation BEFORE generation).
 * @returns {{ok:true, edge, targetId, targetBearing, snap} | {ok:false, reason:string}}
 */
export function planMove(graph, fromNodeId, relativeDir, yawDeg, opts = {}) {
  const from = graph.getNode(fromNodeId);
  if (!from) return { ok: false, reason: 'no-current-node' };
  const bearing = desiredBearing(relativeDir, yawDeg);
  const snap = snapToDir(bearing);
  const edge = graph.resolveEdge(fromNodeId, bearing, opts);
  if (!edge) return { ok: false, reason: 'blocked', snap, bearing };
  return {
    ok: true,
    edge,
    targetId: graph.otherEnd(edge, fromNodeId),
    targetBearing: graph.edgeBearing(edge, fromNodeId),
    bearing, snap,
    distanceM: edge.distM,
  };
}

/** Candidate position after a movement step — for pre-generation checks. */
export function candidatePosition(graph, nodeId, bearingDeg, stepMeters) {
  const n = graph.getNode(nodeId);
  const dpx = graph.scale.mToPx(stepMeters);
  const rad = bearingDeg * Math.PI / 180;
  return { x: n.x + Math.sin(rad) * dpx, y: n.y - Math.cos(rad) * dpx };
}

/**
 * Interpolated map position while walking edge `edge` from `fromId`,
 * progress t in [0,1]. The map marker uses this — one canonical position.
 */
export function positionAlongEdge(graph, edge, fromId, t) {
  const a = graph.getNode(edge.a), b = graph.getNode(edge.b);
  const from = fromId === edge.a ? a : b;
  const to = fromId === edge.a ? b : a;
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    metersTravelled: edge.distM * t,
  };
}

/**
 * Animated walking controller. Browser-agnostic: caller drives `tick(nowMs)`
 * from requestAnimationFrame, or with a fake clock in tests.
 */
export class MovementController {
  /**
   * @param {WorldGraph} graph
   * @param {(nodeId:string)=>string[]} zoneLookup  returns zone ids at a node
   */
  constructor(graph, bus) {
    this.graph = graph;
    this.bus = bus;
    this.state = 'idle';           // idle | walking
    this.currentNodeId = null;
    this.distanceTravelledM = 0;   // cumulative, for the distance readout
    this._walk = null;             // active walk animation
    this.history = [];             // node visit history (reverse-travel audit)
  }

  setPosition(nodeId, { silent = false } = {}) {
    this.currentNodeId = nodeId;
    if (!this.history.length || this.history[this.history.length - 1] !== nodeId) this.history.push(nodeId);
    if (!silent) this.bus.emit('position:changed', { nodeId, teleport: true });
  }

  get currentNode() { return this.graph.getNode(this.currentNodeId); }

  /**
   * Attempt one step. Returns the plan (ok flag mirrors Spec §38 blocked handling).
   * If ok, the walk animation begins and 'walk:progress' events carry the
   * interpolated position until 'position:changed' fires at arrival.
   */
  tryMove(relativeDir, yawDeg, { nowFn = () => performance.now() } = {}) {
    if (this.state !== 'idle' || !this.currentNodeId) return { ok: false, reason: 'busy' };
    const plan = planMove(this.graph, this.currentNodeId, relativeDir, yawDeg);
    if (!plan.ok) {
      this.bus.emit('move:blocked', { nodeId: this.currentNodeId, relativeDir, yawDeg, reason: plan.reason });
      return plan;
    }
    // responsiveness contract: a key press must land within ~0.8s no matter
    // how long the street is; short lanes complete faster and floor at 220ms
    // so taps never strobe
    const walkMs = Math.floor(Math.min(780, Math.max(220, (plan.distanceM / this.graph.settings.walkSpeedMps) * 1000)));
    this._walk = {
      plan, fromId: this.currentNodeId,
      t0: nowFn(), durationMs: walkMs,
    };
    this.state = 'walking';
    this.bus.emit('walk:started', { from: this._walk.fromId, to: plan.targetId, edge: plan.edge });
    return plan;
  }

  /** Drive from rAF. Returns true while a walk is active. */
  tick(nowMs) {
    if (this.state !== 'walking' || !this._walk) return false;
    const { plan, fromId, t0, durationMs } = this._walk;
    const t = Math.min(1, (nowMs - t0) / durationMs);
    const pos = positionAlongEdge(this.graph, plan.edge, fromId, t);
    this.bus.emit('walk:progress', { ...pos, edge: plan.edge, fromId, toId: plan.targetId, t });
    if (t >= 1) {
      this.distanceTravelledM += plan.distanceM;
      this.currentNodeId = plan.targetId;
      this.history.push(plan.targetId);
      this._walk = null;
      this.state = 'idle';
      this.bus.emit('position:changed', { nodeId: plan.targetId, edge: plan.edge, fromId });
    }
    return true;
  }

  cancelWalk() { this._walk = null; this.state = 'idle'; }
}
