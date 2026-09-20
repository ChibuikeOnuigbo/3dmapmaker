/**
 * packages/panorama — spatial transition warp.
 *
 * Moving between two panorama nodes is a *spatial* transition, not a dissolve.
 * The brief is explicit about this: a plain opacity crossfade superimposes two
 * unrelated streets and reads as a ghost, whereas a directional sweep carries the
 * eye from where you were towards where you are going.
 *
 * So the transition displaces the **sampling direction** on each sphere rather
 * than its alpha:
 *
 *   - the outgoing view rotates *away* from the direction of travel, sliding off
 *     the way you came;
 *   - the incoming view rotates *into* alignment from that same direction.
 *
 * Both are pure rotations about the vertical axis, which is seamless on an
 * equirectangular sphere because `u` wraps — there is no edge to reveal.
 *
 * ## Why this file exists separately from the shader
 *
 * The GLSL in `packages/scene-core/src/panoramaView.ts` implements this same
 * rotation, but GLSL cannot be unit-tested here: there is no WebGL context under
 * jsdom and no browser in this environment. So the maths lives here as pure
 * TypeScript, is tested exhaustively, and the shader mirrors it. If the two ever
 * disagree, this file is the specification.
 */

import type { Direction } from './world-graph';

/** Cardinal and diagonal headings in degrees, matching the viewer's yaw convention. */
const DIRECTION_YAW_DEG: Record<Direction, number> = {
  north: 0,
  northEast: 45,
  east: 90,
  southEast: 135,
  south: 180,
  southWest: 225,
  west: 270,
  northWest: 315,
};

/** How far the outgoing view sweeps, in degrees, over a full transition. */
export const MAX_SWEEP_DEG = 26;

/**
 * Smoothstep. Used rather than a linear ramp because a linear sweep has a visible
 * velocity discontinuity at both ends, which reads as a stutter on a 520 ms
 * transition.
 */
export function easeInOut(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The yaw, in degrees, associated with a travel direction.
 *
 * Returns `null` for a null direction: a warp with no direction would be
 * meaningless, and callers should fall back to a plain fade rather than invent an
 * axis.
 */
export function directionYawDeg(direction: Direction | null): number | null {
  if (!direction) return null;
  const yaw = DIRECTION_YAW_DEG[direction];
  return Number.isFinite(yaw) ? yaw : null;
}

/**
 * Rotate a unit view direction about the vertical (Y) axis by `degrees`.
 *
 * Positive degrees turn clockwise when seen from above, matching the viewer's yaw
 * convention. The result is renormalised so accumulated floating-point drift
 * cannot slowly shrink the vector and pull the sample towards a pole.
 */
export function rotateAboutY(dir: { x: number; y: number; z: number }, degrees: number): { x: number; y: number; z: number } {
  if (!Number.isFinite(degrees)) return { x: dir.x, y: dir.y, z: dir.z };
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  // Note the sign. A textbook right-handed rotation about Y is
  // (x*c + z*s, -x*s + z*c), but this viewer measures yaw as atan2(x, -z), which
  // runs the opposite way. Written as below, a positive `degrees` yields a
  // positive change in yaw, which is what callers and the doc comment expect.
  const x = dir.x * c - dir.z * s;
  const z = dir.x * s + dir.z * c;
  const len = Math.sqrt(x * x + dir.y * dir.y + z * z) || 1;
  return { x: x / len, y: dir.y / len, z: z / len };
}

/**
 * Yaw offset in degrees for the outgoing sphere at progress `t`: `0 -> +S`.
 *
 * This is the primitive the shader actually needs — a renderer warps by rotating
 * its sample direction, and the rotation is fully described by this one number.
 */
export function outgoingWarpDeg(t: number): number {
  return easeInOut(t) * MAX_SWEEP_DEG;
}

/**
 * Yaw offset in degrees for the incoming sphere at progress `t`: `+S -> 0`.
 *
 * Paired with [`outgoingWarpDeg`] the two schedules are equal at `t = 0.5`, which
 * is where the opacity swap happens, so both spheres sample the same direction at
 * the moment they trade places.
 */
export function incomingWarpDeg(t: number): number {
  return (1 - easeInOut(t)) * MAX_SWEEP_DEG;
}

/**
 * The outgoing sphere's sample direction at progress `t`.
 *
 * Rotates away from the travel direction, so the view you are leaving slides off
 * the way you came.
 *
 * **`travelYawDeg` gates the warp; it does not steer it.** A null direction means
 * there is no travel in flight (an arrival, or a map warp-to) and the caller
 * should not warp at all. When it is non-null the sweep magnitude and sense are
 * fixed, expressed camera-relative — which is correct for the normal case,
 * because `W` resolves through the camera yaw, so you are walking where you are
 * looking. For a diagonal move, or when the camera has been turned away from the
 * direction of travel, the sweep still runs along the screen-horizontal axis
 * rather than exactly along the travel bearing. That is an approximation, and it
 * is stated here rather than implied to be exact.
 */
export function warpOutgoing(
  dir: { x: number; y: number; z: number },
  travelYawDeg: number | null,
  t: number,
): { x: number; y: number; z: number } {
  if (travelYawDeg === null) return { x: dir.x, y: dir.y, z: dir.z };
  return rotateAboutY(dir, outgoingWarpDeg(t));
}

/**
 * The incoming sphere's sample direction at progress `t`.
 *
 * Runs from `+MAX_SWEEP_DEG` down to `0`, so the plate you are arriving at
 * swings into alignment and finishes looking straight at you.
 *
 * Paired with [`warpOutgoing`] this makes the two spheres sample the *same*
 * direction at `t = 0.5` — which is exactly where the opacity swap happens, so
 * the swap itself is invisible. An earlier version ran this from `-S` to `0`,
 * which left the two spheres a constant `MAX_SWEEP_DEG` apart for the whole
 * transition: they never met, so the crossfade always blended two views 26°
 * apart.
 */
export function warpIncoming(
  dir: { x: number; y: number; z: number },
  travelYawDeg: number | null,
  t: number,
): { x: number; y: number; z: number } {
  if (travelYawDeg === null) return { x: dir.x, y: dir.y, z: dir.z };
  return rotateAboutY(dir, incomingWarpDeg(t));
}

/**
 * How opaque each sphere should be at progress `t`.
 *
 * The warp is the primary transition, but the outgoing plate still has to leave.
 * It holds fully opaque for the first part of the sweep — so the motion is
 * readable rather than immediately dissolving — then falls away. The incoming
 * plate rises to meet it, and the two are kept from summing to zero so there is
 * never a black frame mid-transition.
 */
export function warpOpacities(
  t: number,
  opts: { holdUntil?: number } = {},
): { outgoing: number; incoming: number } {
  const p = clamp01(t);
  const hold = clamp01(opts.holdUntil ?? 0.45);
  const outgoing = p <= hold ? 1 : 1 - (p - hold) / (1 - hold);
  const incoming = clamp01(p * 1.35);
  return { outgoing: clamp01(outgoing), incoming };
}
