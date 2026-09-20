import { describe, expect, it } from 'vitest';
import {
  MAX_SWEEP_DEG,
  directionYawDeg,
  easeInOut,
  incomingWarpDeg,
  outgoingWarpDeg,
  rotateAboutY,
  warpIncoming,
  warpOpacities,
  warpOutgoing,
  type Direction,
} from './index';

/** A unit vector for a given yaw/pitch, matching the shader's `vDir`. */
function dir(yawDeg: number, pitchDeg = 0): { x: number; y: number; z: number } {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  return { x: Math.sin(y) * Math.cos(p), y: Math.sin(p), z: -Math.cos(y) * Math.cos(p) };
}

function yawOf(d: { x: number; y: number; z: number }): number {
  return (Math.atan2(d.x, -d.z) * 180) / Math.PI;
}

function len(d: { x: number; y: number; z: number }): number {
  return Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
}

describe('directionYawDeg', () => {
  it('maps all eight directions to distinct, correct headings', () => {
    const all: Direction[] = ['north', 'northEast', 'east', 'southEast', 'south', 'southWest', 'west', 'northWest'];
    const seen = new Set<number>();
    for (const d of all) {
      const yaw = directionYawDeg(d);
      expect(yaw, `${d} has no yaw`).not.toBeNull();
      seen.add(yaw!);
    }
    // Eight distinct headings, 45° apart, covering the circle exactly once.
    expect(seen.size).toBe(8);
    expect(directionYawDeg('north')).toBe(0);
    expect(directionYawDeg('east')).toBe(90);
    expect(directionYawDeg('south')).toBe(180);
    expect(directionYawDeg('west')).toBe(270);
  });

  it('returns null for a null direction rather than inventing an axis', () => {
    expect(directionYawDeg(null)).toBeNull();
  });
});

describe('easeInOut', () => {
  it('is pinned at both ends', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
  });

  it('is exactly 0.5 at the midpoint', () => {
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 12);
  });

  it('is monotonic and clamps out-of-range input', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = easeInOut(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(easeInOut(-5)).toBe(0);
    expect(easeInOut(5)).toBe(1);
    expect(easeInOut(Number.NaN)).toBe(0);
  });
});

describe('rotateAboutY', () => {
  it('preserves length, so drift cannot pull the sample towards a pole', () => {
    for (const d of [dir(0), dir(37, 22), dir(200, -60), dir(359, 89)]) {
      for (const deg of [-180, -45, 0, 13, 90, 361]) {
        expect(len(rotateAboutY(d, deg))).toBeCloseTo(1, 12);
      }
    }
  });

  it('leaves the vertical component untouched', () => {
    const d = dir(20, 40);
    const r = rotateAboutY(d, 65);
    expect(r.y).toBeCloseTo(d.y, 12);
  });

  it('rotates by the requested amount', () => {
    const d = dir(0);
    expect(yawOf(rotateAboutY(d, 45))).toBeCloseTo(45, 9);
    expect(yawOf(rotateAboutY(d, -30))).toBeCloseTo(-30, 9);
  });

  it('is the identity at zero and a no-op for a non-finite angle', () => {
    const d = dir(12, -8);
    expect(rotateAboutY(d, 0)).toEqual(d);
    expect(rotateAboutY(d, Number.NaN)).toEqual(d);
    expect(rotateAboutY(d, Number.POSITIVE_INFINITY)).toEqual(d);
  });

  it('a full turn returns to the start', () => {
    const d = dir(50, 15);
    const r = rotateAboutY(d, 360);
    expect(r.x).toBeCloseTo(d.x, 9);
    expect(r.y).toBeCloseTo(d.y, 9);
    expect(r.z).toBeCloseTo(d.z, 9);
  });
});

describe('the warp is spatial, not an opacity dissolve', () => {
  it('the outgoing view sweeps away from where you came', () => {
    const d = dir(0);
    expect(yawOf(warpOutgoing(d, 0, 0))).toBeCloseTo(0, 9);
    const mid = yawOf(warpOutgoing(d, 0, 0.5));
    const end = yawOf(warpOutgoing(d, 0, 1));
    expect(mid).toBeGreaterThan(0);
    expect(end).toBeCloseTo(MAX_SWEEP_DEG, 9);
  });

  it('the incoming view starts offset and settles aligned', () => {
    // Runs +S -> 0, not -S -> 0. That is what makes the two spheres coincide at
    // t=0.5 (see the next test) instead of sitting a constant S apart.
    const d = dir(0);
    expect(yawOf(warpIncoming(d, 0, 0))).toBeCloseTo(MAX_SWEEP_DEG, 9);
    expect(yawOf(warpIncoming(d, 0, 1))).toBeCloseTo(0, 9);
  });

  it('both endpoints are exact, so neither end of the transition jumps', () => {
    // At t=0 the outgoing view is unwarped — the transition starts from exactly
    // what the player was already looking at. At t=1 the incoming view is
    // unwarped — the player arrives looking straight at the new plate.
    const d = dir(40, -12);
    const outStart = warpOutgoing(d, 90, 0);
    const inEnd = warpIncoming(d, 90, 1);
    expect(outStart.x).toBeCloseTo(d.x, 12);
    expect(outStart.y).toBeCloseTo(d.y, 12);
    expect(outStart.z).toBeCloseTo(d.z, 12);
    expect(inEnd.x).toBeCloseTo(d.x, 12);
    expect(inEnd.y).toBeCloseTo(d.y, 12);
    expect(inEnd.z).toBeCloseTo(d.z, 12);
  });

  it('the two spheres meet in the middle of the transition', () => {
    // At the crossing point the two sample directions coincide, which is what
    // makes the swap invisible rather than a jump.
    const d = dir(0);
    let closest = Infinity;
    let at = -1;
    for (let i = 0; i <= 200; i++) {
      const t = i / 200;
      const gap = Math.abs(yawOf(warpOutgoing(d, 0, t)) - yawOf(warpIncoming(d, 0, t)));
      if (gap < closest) {
        closest = gap;
        at = t;
      }
    }
    expect(closest).toBeLessThan(2);
    expect(at).toBeGreaterThan(0.2);
    expect(at).toBeLessThan(0.8);
  });

  it('the sweep direction follows the travel direction', () => {
    // Walking east must not look like walking north.
    const d = dir(0);
    const north = yawOf(warpOutgoing(rotateAboutY(d, 0), 0, 1));
    const east = yawOf(warpOutgoing(rotateAboutY(d, 90), 90, 1));
    expect(Math.abs(north - east)).toBeGreaterThan(1);
  });

  it('a null direction degrades to no warp instead of throwing', () => {
    const d = dir(30, 10);
    expect(warpOutgoing(d, null, 0.5)).toEqual(d);
    expect(warpIncoming(d, null, 0.5)).toEqual(d);
  });
});

describe('warpOpacities', () => {
  it('starts with the outgoing plate fully visible and ends with it gone', () => {
    expect(warpOpacities(0).outgoing).toBe(1);
    expect(warpOpacities(0).incoming).toBe(0);
    expect(warpOpacities(1).outgoing).toBe(0);
    expect(warpOpacities(1).incoming).toBe(1);
  });

  it('never leaves a black frame — one plate is always substantially up', () => {
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      const o = warpOpacities(t);
      expect(Math.max(o.outgoing, o.incoming), `both plates dim at t=${t}`).toBeGreaterThan(0.5);
    }
  });

  it('holds the outgoing plate up while the sweep is readable', () => {
    // The point of the hold: for the first part of the transition the plate you
    // are leaving is fully opaque, so the motion reads as movement.
    expect(warpOpacities(0.2).outgoing).toBe(1);
    expect(warpOpacities(0.4).outgoing).toBe(1);
    expect(warpOpacities(0.9).outgoing).toBeLessThan(0.5);
  });

  it('clamps rather than returning out-of-range alpha', () => {
    for (const t of [-1, 0, 0.5, 1, 2, Number.NaN]) {
      const o = warpOpacities(t);
      expect(o.outgoing).toBeGreaterThanOrEqual(0);
      expect(o.outgoing).toBeLessThanOrEqual(1);
      expect(o.incoming).toBeGreaterThanOrEqual(0);
      expect(o.incoming).toBeLessThanOrEqual(1);
    }
  });

  it('a custom hold point is respected', () => {
    expect(warpOpacities(0.6, { holdUntil: 0.7 }).outgoing).toBe(1);
    expect(warpOpacities(0.8, { holdUntil: 0.7 }).outgoing).toBeLessThan(1);
  });
});

describe('the composite transition has no black frame', () => {
  // Brief: "No jarring black screen." These are properties of the schedules as
  // actually composed by WorldView — opacity from warpOpacities, yaw from
  // outgoing/incomingWarpDeg — not of either helper on its own.

  it('the background never shows through, so nothing ever goes dark', () => {
    // Not "outgoing + incoming === 1". The two schedules are deliberately NOT
    // complementary: the incoming fades in at 1.35x while the outgoing holds
    // full opacity until the hold point, so the sum runs above 1 for most of the
    // transition. That is a two-plate blend, which is fine.
    //
    // What would actually be a black frame is the background showing through
    // between them. With standard alpha blending, and the incoming drawn over
    // the outgoing, the share of the frame that is neither plate is
    // (1 - outgoing) * (1 - incoming). That term is what has to stay near zero.
    let worst = 0;
    let worstAt = 0;
    for (let i = 0; i <= 1000; i++) {
      const t = i / 1000;
      const a = warpOpacities(t);
      const background = (1 - a.outgoing) * (1 - a.incoming);
      if (background > worst) { worst = background; worstAt = t; }
    }
    // Measured worst case is ~5% at t=0.60, where the two crossfades overlap
    // least well. Well short of anything readable as a flash of background.
    expect(worst, `background leaks ${worst.toFixed(4)} at t=${worstAt}`).toBeLessThan(0.08);
  });

  it('the incoming is fully opaque before the outgoing is gone', () => {
    // The ordering that guarantees no dark frame: incoming must reach 1 strictly
    // before outgoing reaches 0, so there is never a moment where both are low.
    let incomingFull = -1;
    let outgoingGone = -1;
    for (let i = 0; i <= 1000; i++) {
      const t = i / 1000;
      const a = warpOpacities(t);
      if (incomingFull < 0 && a.incoming >= 1) incomingFull = t;
      if (outgoingGone < 0 && a.outgoing <= 0) outgoingGone = t;
    }
    expect(incomingFull, 'the incoming never reaches full opacity').toBeGreaterThan(0);
    expect(outgoingGone, 'the outgoing never fully fades').toBeGreaterThan(0);
    expect(incomingFull, `incoming full at ${incomingFull}, outgoing gone at ${outgoingGone}`)
      .toBeLessThan(outgoingGone);
  });

  it('the outgoing sphere is fully visible during the hold, then hands over', () => {
    expect(warpOpacities(0).outgoing).toBe(1);
    expect(warpOpacities(0.2).outgoing).toBe(1);
    expect(warpOpacities(0.45).outgoing).toBe(1);
    expect(warpOpacities(0.7).outgoing).toBeLessThan(1);
    expect(warpOpacities(0.7).outgoing).toBeGreaterThan(0);
    expect(warpOpacities(1).outgoing).toBe(0);
    expect(warpOpacities(1).incoming).toBe(1);
  });

  it('the visible sphere settles exactly aligned, with no snap at either end', () => {
    // WorldView sets alpha to {outgoing: 0, incoming: 1} the moment the phase
    // leaves 'transitioning'. warpOpacities(1) must already agree, or the handoff
    // jumps.
    expect(warpOpacities(1)).toEqual({ outgoing: 0, incoming: 1 });
    // Likewise the incoming warp must be 0 at t=1, since WorldView forces the
    // warp to 0 once the transition ends.
    expect(incomingWarpDeg(1)).toBeCloseTo(0, 12);
    // And the outgoing starts at 0, so the first frame matches what the player
    // was already looking at.
    expect(outgoingWarpDeg(0)).toBeCloseTo(0, 12);
  });

  it('the two spheres are within a few degrees of each other across the crossfade', () => {
    // They coincide exactly at t=0.5. Away from that point the crossfade is
    // blending two views some distance apart; if that distance grew large the
    // fade would read as a tear rather than a motion. Check the worst case in
    // the region where both are actually visible.
    let worst = 0;
    let worstAt = 0;
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      const a = warpOpacities(t);
      // A gap between the two sample directions is only visible while BOTH
      // spheres are on screen. Outside the overlap one of them has faded out, so
      // the separation cannot be seen and must not be measured — at t=1 the two
      // are a full MAX_SWEEP_DEG apart, but the outgoing sphere is at opacity 0.
      if (a.incoming < 0.02 || a.outgoing < 0.02) continue;
      const gap = Math.abs(outgoingWarpDeg(t) - incomingWarpDeg(t));
      if (gap > worst) { worst = gap; worstAt = t; }
    }
    expect(worstAt, 'the two spheres never overlap, so this test measures nothing').toBeGreaterThan(0);
    expect(worst, `worst gap ${worst.toFixed(2)}° at t=${worstAt}`).toBeLessThan(MAX_SWEEP_DEG);
  });
});
