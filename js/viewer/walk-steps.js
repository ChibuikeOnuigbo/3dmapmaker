/**
 * Walk-feel schedule (pure, Node-testable — no DOM, no canvas).
 *
 * A map hop must read as *walking the same street*, not a crossfade jump:
 * the source panorama dollies forward in discrete ~5 m strides, ease-bobbed
 * like head motion, then hands over to the destination panorama (which was
 * photographed from that closer spot) while the zoom relaxes back to 1.
 *
 * The stride list is built RECURSIVELY by midpoint-splitting the hop until
 * every sub-step is at most `stepM` long — same rule the world graph uses to
 * densify its waypoints, so view and map use one mapping in arrays.
 */

export const WALK_STEP_M = 5;

/** Recursive split: hop `distM` → array of stride lengths, each ≤ stepM. */
export function walkStrides(distM, stepM = WALK_STEP_M) {
  const split = (d) => (d <= stepM ? [d] : [...split(d / 2), ...split(d / 2)]);
  return Number.isFinite(distM) && distM > 0 ? split(distM) : [];
}

/**
 * Schedule for a hop.
 * @returns {{steps:number, dollyMax:number, bobCycles:number}}
 *   steps     — stride count (teleports/snaps return 0 → plain fade),
 *   dollyMax  — peak zoom on the source before the handover (1.35 felt like
 *               a real advance at 75° fov; hops under ~8 m use proportionally
 *               less so the camera never lunges through a wall),
 *   bobCycles — head-bob cycles across the walk (one per stride pair).
 */
export function walkSchedule(distM, { stepM = WALK_STEP_M, amount = 0.8 } = {}) {
  const steps = walkStrides(distM, stepM).length;
  if (!steps) return { steps: 0, dollyMax: 1, bobCycles: 0 };
  const amt = Math.max(0, Math.min(1, amount));
  const closeness = Math.min(1, distM / 30);           // short hops: gentle push
  const dollyMax = 1 + 0.4 * amt * closeness;          // 1.00 .. 1.40
  return { steps, dollyMax, bobCycles: Math.max(1, Math.round(steps / 2)) };
}

/**
 * Per-frame progress of the dolly phase, quantized into strides: within each
 * stride the zoom eases out (a step), then holds (weight shift between steps)
 * — the exact "same panorama, but 5 m further" effect, repeated striding
 * toward the next photo spot.
 * @param {number} t  0..1 across the DOLLY phase only
 * @param {number} steps stride count from walkSchedule
 */
export function strideEase(t, steps) {
  if (steps <= 0) return t;
  const s = Math.min(steps - 1e-9, t * steps);         // which stride we're in
  const i = Math.floor(s), f = s - i;
  const e = 1 - Math.pow(1 - Math.min(1, f * 1.35), 3); // 1.35: ease fast into each step, hold the rest
  return (i + e) / steps;
}

/** Head-bob pitch offset (degrees) for walk progress t across the whole hop. */
export function walkBobDeg(t, cycles, amount = 0.8) {
  return Math.sin(t * cycles * 2 * Math.PI) * 1.1 * amount;
}
