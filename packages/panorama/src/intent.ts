/**
 * packages/panorama — movement intent resolution (spec §30, §31, §32).
 *
 * This is the one place that turns a keypress into world movement, and it is
 * deliberately narrow:
 *
 *   keypress → camera-relative offset → world heading → quantised to the
 *   nearest of the 8 compass directions → graph edge → destination node id
 *
 * It returns a NODE ID. It never returns a position delta, so the camera can
 * never be translated through the texture by WASD. That is the guarantee in
 * §30: "W must never move the camera through the texture."
 *
 * If the quantised direction has no edge in the graph, the move FAILS with a
 * reason. It never silently drifts to a neighbouring direction (§31) and it
 * never fabricates a node.
 */
import type { Direction, WorldGraph } from './world-graph';

export type MovementIntent =
  | 'forward'
  | 'forwardRight'
  | 'right'
  | 'backRight'
  | 'back'
  | 'backLeft'
  | 'left'
  | 'forwardLeft';

/** Camera-relative offsets in degrees. Screen right is +, matching a CW yaw. */
export const INTENT_OFFSET_DEG: Record<MovementIntent, number> = {
  forward: 0,
  forwardRight: 45,
  right: 90,
  backRight: 135,
  back: 180,
  backLeft: -135,
  left: -90,
  forwardLeft: -45,
};

/** Stable order starting at north and sweeping clockwise. */
const DIRECTION_ORDER: Direction[] = [
  'north',
  'northEast',
  'east',
  'southEast',
  'south',
  'southWest',
  'west',
  'northWest',
];

/** Compass bearing for each direction, so we can quantise by angle. */
const DIRECTION_BEARING: Record<Direction, number> = {
  north: 0,
  northEast: 45,
  east: 90,
  southEast: 135,
  south: 180,
  southWest: 225,
  west: 270,
  northWest: 315,
};

/** Short label for the HUD. */
export const DIRECTION_ABBR: Record<Direction, string> = {
  north: 'N',
  northEast: 'NE',
  east: 'E',
  southEast: 'SE',
  south: 'S',
  southWest: 'SW',
  west: 'W',
  northWest: 'NW',
};

export function normaliseDegrees(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Snap a heading to the nearest of the 8 compass directions. */
export function quantiseToDirection(headingDeg: number): { dir: Direction; bearing: number; snapDelta: number } {
  const h = normaliseDegrees(headingDeg);
  let best: Direction = 'north';
  let bestDelta = Infinity;
  for (const dir of DIRECTION_ORDER) {
    const b = DIRECTION_BEARING[dir];
    let delta = Math.abs(h - b);
    if (delta > 180) delta = 360 - delta;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = dir;
    }
  }
  return { dir: best, bearing: DIRECTION_BEARING[best], snapDelta: bestDelta };
}

export interface IntentResult {
  /** True only when a real graph edge exists and the move is legal. */
  ok: boolean;
  /** The resolved compass direction, even on failure (so the UI can say why). */
  direction: Direction;
  /** Short compass label, e.g. 'NE'. */
  directionLabel: string;
  /** Destination node id, or null when the move is not allowed. */
  targetId: string | null;
  /** The world heading the player intended, before quantising. */
  worldHeadingDeg: number;
  /** How far the intent was snapped to reach a compass direction. */
  snapDeltaDeg: number;
  /** Camera yaw at the time of resolution — kept for diagnostics. */
  cameraYawDeg: number;
  /** Human-readable reason on failure; null on success. */
  reason: string | null;
  /** The 8 directions that DO have edges here, for the HUD. */
  available: Direction[];
}

const FAIL = (
  direction: Direction,
  worldHeadingDeg: number,
  snapDeltaDeg: number,
  cameraYawDeg: number,
  reason: string,
  available: Direction[],
): IntentResult => ({
  ok: false,
  direction,
  directionLabel: DIRECTION_ABBR[direction],
  targetId: null,
  worldHeadingDeg,
  snapDeltaDeg,
  cameraYawDeg,
  reason,
  available,
});

/**
 * Resolve one keypress against the graph.
 *
 * `cameraYawDeg` is the compass bearing the camera is currently facing
 * (0 = north, clockwise). It comes from the live camera; it is never derived
 * from the player's grid position.
 */
export function resolveMovementIntent(
  graph: WorldGraph,
  currentId: string,
  intent: MovementIntent,
  cameraYawDeg: number,
): IntentResult {
  const node = graph.get(currentId);
  if (!node) return FAIL('north', cameraYawDeg, 0, cameraYawDeg, 'Not standing on a graph node.', []);

  const available = graph
    .neighborsOf(currentId)
    .filter((n) => n.edge.walkable)
    .map((n) => n.edge.direction);

  const worldHeading = normaliseDegrees(cameraYawDeg + INTENT_OFFSET_DEG[intent]);
  const { dir, snapDelta } = quantiseToDirection(worldHeading);

  // Distinguish "no edge at all" from "an edge exists but is blocked" — the
  // player needs to know which, because only the second is ever going to open.
  const rawEdge = graph.edgeInDirection(currentId, dir);
  if (rawEdge && !rawEdge.walkable) {
    return FAIL(
      dir,
      worldHeading,
      snapDelta,
      cameraYawDeg,
      `The ${DIRECTION_ABBR[dir]} way from square ${node.number} is blocked. ${
        available.length ? `Open: ${available.map((d) => DIRECTION_ABBR[d]).join(', ')}.` : ''
      }`,
      available,
    );
  }

  const neighbor = graph.neighbor(currentId, dir);
  if (!neighbor) {
    return FAIL(
      dir,
      worldHeading,
      snapDelta,
      cameraYawDeg,
      `No ${DIRECTION_ABBR[dir]} edge from square ${node.number}. ${
        available.length ? `Open: ${available.map((d) => DIRECTION_ABBR[d]).join(', ')}.` : 'This square has no walkable edges.'
      }`,
      available,
    );
  }

  return {
    ok: true,
    direction: dir,
    directionLabel: DIRECTION_ABBR[dir],
    targetId: neighbor.id,
    worldHeadingDeg: worldHeading,
    snapDeltaDeg: snapDelta,
    cameraYawDeg,
    reason: null,
    available,
  };
}

/**
 * Map a keyboard event to a movement intent.
 *
 * WASD covers the 4 cardinals; QEZC (or the arrow-key equivalents used by many
 * panorama viewers) cover the diagonals. Returns null for keys this does not
 * own, so the caller can let them through to whatever else has focus.
 */
export function intentFromKey(key: string): MovementIntent | null {
  switch (key.toLowerCase()) {
    case 'w':
    case 'arrowup':
      return 'forward';
    case 's':
    case 'arrowdown':
      return 'back';
    case 'a':
    case 'arrowleft':
      return 'left';
    case 'd':
    case 'arrowright':
      return 'right';
    case 'q':
      return 'forwardLeft';
    case 'e':
      return 'forwardRight';
    case 'z':
      return 'backLeft';
    case 'c':
      return 'backRight';
    default:
      return null;
  }
}

/**
 * The bearing the camera should end up on after arriving at a node.
 *
 * §32: restore the original heading. If the player walked NE, they should still
 * be facing NE on arrival, not snapped to the edge axis — so we return the
 * intended world heading, quantised only enough to stay on a compass point when
 * the intent was already on one.
 */
export function headingOnArrival(intent: MovementIntent, cameraYawDeg: number): number {
  return normaliseDegrees(cameraYawDeg + INTENT_OFFSET_DEG[intent]);
}
