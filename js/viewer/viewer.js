/**
 * Panorama Maps — viewer/viewer.js
 *
 * PanoramaViewer: mouse/touch look (drag), wheel FOV zoom, soft-resistance
 * pitch limits driven by AutoComplete analysis, crossfade+drift transitions,
 * and optional immersion effects (sway / rain / breeze — visual only, they
 * never touch world coordinates, Spec §17, §58).
 */
import { PanoRenderer } from './pano-renderer.js';
import { softClampPitch } from './completion.js';
import { walkSchedule, strideEase, walkBobDeg } from './walk-steps.js';
import { rngFor } from '../gen/util.js';

export class PanoramaViewer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLCanvasElement} fxCanvas  overlay for rain etc.
   * @param {EventBus} bus
   */
  constructor(canvas, fxCanvas, bus) {
    this.canvas = canvas;
    this.bus = bus;
    this.renderer = new PanoRenderer(canvas);
    this.fx = fxCanvas ? fxCanvas.getContext('2d') : null;

    this.view = {
      yawDeg: 0, pitchDeg: 0, fovDeg: 75,
      minFov: 30, maxFov: 110,
      mix: 0, zoom: 1, hasB: false,
    };
    this.pitchLimits = { min: -80, max: 80 };
    this.pitchOverdrag = 0;
    this._rawPitch = 0;

    this.immersion = { sway: false, swayIntensity: 0.4, breeze: false, rain: false, birds: false, clouds: false, snow: false, night: false, fireflies: false, butterflies: false, sunrays: false, storm: false, balloon: false, owl: false, mist: false, rabbits: false, actors: true, ripples: true, transitionMs: 420 };
    // world anchors for animated actors — set by the app on every node entry:
    // { xM, yM (node position in meters), headingDeg, actors:[{kind:'walker',...}] }
    this.anchors = null;
    // movement feel: morph style + strength come from the Motion settings
    // popup (prefs) — style 'morph' | 'fade' | 'snap', amount 0..1 scales the
    // dolly zoom of the morph
    this.motion = { style: 'morph', amount: 0.8, durMs: null };
    this._drag = null;
    this._vel = { x: 0, y: 0 };
    this._running = false;
    this._rafId = 0;
    this._lastT = 0;
    this._transition = null;
    this._rainDrops = [];
    this._snow = [];                         // snowfall flakes (screen space, gusts)
    this._stars = null;                      // seeded night sky (world azimuth)
    this._flies = null;                      // seeded firefly swarm
    this._butter = null;                     // seeded butterflies (world meters)
    this._balloons = null;                   // drifting hot-air balloons
    this._wisps = null;                      // dawn low-mist banks
    this._rabbits = null;                    // meadow rabbits (world meters)
    this._t0 = performance.now();
    // paint-on-demand: a still scene must not be redrawn (and re-rasterised)
    // sixty times a second — on a laptop that is battery, and on a machine
    // with a software rasteriser it is the difference between a page that
    // holds still and one that grows until the tab is killed
    this._dirty = true;
    this._lastSig = '';
    this.paintCount = 0;                 // frames actually drawn (tests read this)
    this.skippedFrames = 0;              // frames where nothing had changed

    this._bindInput();
  }

  /** Something other than the view changed what a frame should look like
      (a new image, a resize, a mode switch): draw again, even if the yaw and
      pitch happen to be exactly where they were. */
  invalidate() { this._dirty = true; }

  /** True while the picture is changing on its own — a transition, inertia, a
      dragged view, or a weather/world layer that is actually on screen. */
  _animating() {
    if (this._transition || this._drag) return true;
    if (Math.abs(this._vel.x) > 0.001 || Math.abs(this._vel.y) > 0.001) return true;
    const i = this.immersion;
    const a = this.anchors;
    return !!(i.sway || i.breeze || i.rain || i.snow || i.clouds || i.night
      || i.sunrays || i.fireflies || i.balloon || i.owl || i.mist
      || (i.actors && a?.actors?.length) || (i.butterflies && a)
      || (i.rabbits && a) || (i.ripples && a?.water?.length)
      || (i.birds && !i.rain));
  }

  /* ---------------- input ---------------- */
  _bindInput() {
    const el = this.canvas;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      this.invalidate();
      el.setPointerCapture(e.pointerId);
      this._drag = { x: e.clientX, y: e.clientY, yaw: this.view.yawDeg, pitch: this._rawPitch, moved: 0, id: e.pointerId };
      this._vel.x = this._vel.y = 0;
    });
    el.addEventListener('pointermove', (e) => {
      if (!this._drag || e.pointerId !== this._drag.id) return;
      const dx = e.clientX - this._drag.x;
      const dy = e.clientY - this._drag.y;
      this._drag.moved = Math.max(this._drag.moved, Math.abs(dx) + Math.abs(dy));
      const k = this.view.fovDeg / el.clientHeight;   // deg per pixel ≈ matched to FOV
      const yaw = this._drag.yaw - dx * k;
      const pitch = this._drag.pitch + dy * k;
      this._vel.x = -(e.movementX || 0) * k;
      this._vel.y = (e.movementY || 0) * k;
      this.view.yawDeg = ((yaw % 360) + 360) % 360;
      this._rawPitch = pitch;
      this._emitView();
    });
    const endDrag = (e) => {
      if (this._drag && e.pointerId === this._drag.id) this._drag = null;
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.invalidate();
      const f = Math.exp((e.deltaY > 0 ? 1 : -1) * 0.09);
      this.view.fovDeg = Math.min(this.view.maxFov, Math.max(this.view.minFov, this.view.fovDeg * f));
      this._emitView();
    }, { passive: false });
  }

  /** External look control (keyboard arrows / nudge buttons). */
  look(deltaYawDeg, deltaPitchDeg) {
    this.invalidate();
    this.view.yawDeg = ((this.view.yawDeg + deltaYawDeg) % 360 + 360) % 360;
    this._rawPitch += deltaPitchDeg;
    this._emitView();
  }

  setFov(fovDeg) {
    this.invalidate();
    this.view.fovDeg = Math.min(this.view.maxFov, Math.max(this.view.minFov, fovDeg));
    this._emitView();
  }

  setPitchLimits(limits) {
    this.invalidate();
    // never allow pole-viewing even with AutoComplete OFF (safety clamp)
    this.pitchLimits = { min: Math.max(-88, limits.min), max: Math.min(88, limits.max) };
    if (!limits.tight) { this.pitchLimits.min = Math.min(this.pitchLimits.min, -80); this.pitchLimits.max = Math.max(this.pitchLimits.max, 80); }
  }

  /** Immediate (no transition) image swap — used for the very first frame. */
  setImageNow(source, headingDeg) {
    this.invalidate();
    this.renderer.setImageA(source, headingDeg);
    this.view.mix = 0; this.view.hasB = false;
  }

  /**
   * Transition to a new panorama. Keeps the old image visible while fading —
   * never blanks to a spinner (Spec §58).
   * @param {object} opts {direction:'forward'|'backward'|'left'|'right'|null, durationMs}
   */
  transitionTo(source, headingDeg, opts = {}) {
    this.invalidate();
    let dur = this.motion.durMs ?? opts.durationMs ?? this.immersion.transitionMs ?? 420;
    if (this.motion.style === 'snap') dur = Math.min(dur, 110);
    const amt = Math.max(0, Math.min(1, this.motion.amount ?? 0.8));
    const base = this.motion.style === 'fade'
      ? 1
      : ({ forward: 1.14, backward: 0.9, left: 1.06, right: 1.06 }[opts.direction] ?? 1.08);
    const dirZoom = 1 + (base - 1) * amt;
    this.renderer.setImageB(source, headingDeg);
    this.view.hasB = true;
    // 'walk' style: stride-by-stride dolly on the SOURCE panorama first — the
    // viewer sees the same scene from 5 m closer, again and again, and only
    // then the destination photo (shot from exactly that closer spot) blends
    // in. Reads as continuous walking; never a jump.
    const walk = this.motion.style === 'walk'
      && !opts.teleport
      && (opts.direction === 'forward' || opts.direction === 'backward')
      && (opts.distM ?? 0) > 0;
    const sched = walk ? walkSchedule(opts.distM, { amount: amt }) : { steps: 0, dollyMax: dirZoom };
    if (walk && (this.motion.durMs ?? 0) <= 0) dur = Math.max(dur, 950 + sched.steps * 200); // strides need room: SLOW motion, user directive
    this._transition = {
      t0: performance.now(), dur, dirZoom, fromZoom: this.view.zoom,
      style: this.motion.style,
      walk: walk && sched.steps > 0
        ? { steps: sched.steps, dollyMax: sched.dollyMax, bob: sched.bobCycles, amt, back: opts.direction === 'backward' }
        : null,
    };
    return new Promise((resolve) => { this._transition.resolve = resolve; });
  }

  _finishTransition() {
    this.renderer.promoteBtoA();
    this.view.mix = 0; this.view.zoom = 1; this.view.hasB = false;
    if (this._transition?.resolve) this._transition.resolve();
    this._transition = null;
  }

  /* ---------------- frame loop ---------------- */
  start() { if (!this._running) { this._running = true; this._lastT = performance.now(); const loop = (t) => { this._rafId = requestAnimationFrame(loop); this._frame(t); }; this._rafId = requestAnimationFrame(loop); } }
  stop() { this._running = false; cancelAnimationFrame(this._rafId); }

  _frame(now) {
    const dt = Math.min(100, now - this._lastT);
    this._lastT = now;
    this.onFrame?.(now);

    // inertia after release
    if (!this._drag && (Math.abs(this._vel.x) > 0.001 || Math.abs(this._vel.y) > 0.001)) {
      this.view.yawDeg = ((this.view.yawDeg + this._vel.x * dt * 0.12) % 360 + 360) % 360;
      this._rawPitch += this._vel.y * dt * 0.12;
      this._vel.x *= Math.exp(-dt / 160);
      this._vel.y *= Math.exp(-dt / 160);
      this._emitView();
    }

    // soft-resistance pitch clamp (AutoComplete limits)
    const sc = softClampPitch(this._rawPitch, this.pitchLimits, dt);
    this.view.pitchDeg = sc.pitch;
    if (!sc.limited) this._rawPitch = sc.pitch;
    else this._rawPitch = sc.pitch + sc.overdrag * 0.78; // spring back

    // transition progress
    this._walkBob = 0;
    if (this._transition) {
      const tr = this._transition;
      const t = Math.min(1, (now - tr.t0) / tr.dur);
      if (tr.walk) {
        // WALK: stride-by-stride dolly on the source (62% of the time), then
        // a short handover where the destination — photographed from exactly
        // that closer spot — blends in while the zoom relaxes back to 1.
        const DOLLY = 0.68;                       // most of the time is spent striding, only the tail hands over
        const w = tr.walk;
        if (t < DOLLY) {
          const p = strideEase(t / DOLLY, w.steps);
          const k = (w.dollyMax - 1) * p;
          this.view.mix = 0;
          this.view.zoom = w.back ? 1 - k * 0.42 : 1 + k;   // backward: gentle retreat
        } else {
          const p = (t - DOLLY) / (1 - DOLLY);
          const e = p * p * (3 - 2 * p);                    // smoothstep handover
          const k = (w.dollyMax - 1) * (1 - e);
          this.view.mix = e;
          this.view.zoom = w.back ? 1 - k * 0.42 : 1 + k;
        }
        this._walkBob = walkBobDeg(t, w.bob, w.amt) * (1 - t); // settle to zero by arrival
      } else {
        const e = 1 - Math.pow(1 - t, 3);
        this.view.mix = e;
        const dirZoom = 1 + (tr.dirZoom - 1) * (1 - e);
        this.view.zoom = dirZoom;
      }
      // blur-style morph: softness peaks at the midpoint and returns to zero
      this.view.blurUv = (tr.style === 'blur')
        ? Math.sin(Math.PI * t) * 0.006 * (this.motion.amount ?? 0.8)
        : 0;
      if (t >= 1) { this.view.blurUv = 0; this._finishTransition(); }
    }

    // immersion offsets — visual only (never stored to world state)
    let yawOff = 0, pitchOff = 0;
    const time = (now - this._t0) / 1000;
    pitchOff += this._walkBob;
    if (this.immersion.sway) {
      const i = this.immersion.swayIntensity;
      yawOff += Math.sin(time * 0.9) * 0.35 * i;
      pitchOff += Math.sin(time * 1.7 + 1.3) * 0.16 * i;
    }
    if (this.immersion.breeze) yawOff += Math.sin(time * 0.32 + 2.1) * 0.15;

    // Nothing is moving and nothing is new: leave the frame that is already on
    // screen alone. (The canvas resize is part of the signature, so a window
    // that changed size still repaints on the next frame.)
    const cv = this.canvas;
    // the weather/world layers are part of the picture too: switching rain off
    // has to wipe the rain that is still drawn on the overlay, so a change in
    // which layers are on counts as a change to the frame
    const i2 = this.immersion, a2 = this.anchors;
    let layers = 0, bit = 1;
    for (const k of ['sway', 'breeze', 'rain', 'snow', 'clouds', 'night', 'sunrays', 'fireflies',
      'balloon', 'owl', 'mist', 'butterflies', 'rabbits', 'birds']) { if (i2[k]) layers += bit; bit *= 2; }
    if (a2) layers += bit;                       // anchors in play (world actors / water)
    const sig = `${this.view.yawDeg.toFixed(4)}|${this.view.pitchDeg.toFixed(4)}|${this.view.fovDeg.toFixed(3)}`
      + `|${this.view.mix.toFixed(4)}|${this.view.zoom.toFixed(4)}|${this.view.hasB ? 1 : 0}`
      + `|${cv.clientWidth}x${cv.clientHeight}|${layers}`;
    if (!this._dirty && sig === this._lastSig && !this._animating()) { this.skippedFrames++; return; }
    this._dirty = false;
    this._lastSig = sig;
    this.paintCount++;

    this.renderer.render({
      yawDeg: this.view.yawDeg + yawOff,
      pitchDeg: this.view.pitchDeg + pitchOff,
      fovDeg: this.view.fovDeg,
      mix: this.view.mix,
      hasB: this.view.hasB,
      zoom: this.view.zoom,
    });
    this._renderFx(now, dt);
    this.onFrameRendered?.();   // post-processing hook (sharpen pass schedules here)
  }

  /** Overlay effects — cleared once per frame, then each enabled layer draws.
      Everything here is visual-only (Spec §17/§58): it never touches world
      coordinates, and it paces itself off the same clock as the walk. */
  _renderFx(now, dt) {
    if (!this.fx) return;
    const cvs = this.fx.canvas;
    this.fx.clearRect(0, 0, cvs.width, cvs.height);
    if (cvs.width !== cvs.clientWidth || cvs.height !== cvs.clientHeight) { cvs.width = cvs.clientWidth; cvs.height = cvs.clientHeight; }
    this._renderStars(now, dt, cvs);       // deepest: the night sky itself
    this._renderSunRays(now, dt, cvs);     // low sun shafts behind the clouds
    this._renderClouds(now, dt, cvs);
    this._renderBalloons(now, dt, cvs);    // fair-day drifters on the horizon
    this._renderMist(now, dt, cvs);        // dawn banks hugging the ground
    this._renderOwl(now, dt, cvs);         // the night watch glides through
    this._renderBirds(now, dt, cvs);
    this._renderActors(now, dt, cvs);
    this._renderRabbits(now, dt, cvs);     // meadow life at your feet
    this._renderRipples(now, dt, cvs);     // pond & lake rings (rain stirs more)
    this._renderButterflies(now, dt, cvs);
    this._renderFireflies(now, dt, cvs);
    this._renderRain(now, dt, cvs);        // storm mode lives inside here
    this._renderSnow(now, dt, cvs);        // precip sits closest to the lens
  }

  /* ---------------- animated world layers ---------------- */

  /** Exact inverse of the WebGL view-ray construction: a world direction
      (bearing+elevation from the camera) lands on NDC → canvas px. Using the
      same math as the shader keeps animated actors glued to the painted
      world through pan, pitch, FOV zoom and transition dolly (Spec §58). */
  _projectWorld(xM, yM, hM = 0, aspect = 1) {
    const a = this.anchors;
    if (!a) return null;
    const dx = xM - a.xM, dn = -(yM - a.yM);            // world +y is south; dn = northward
    const distH = Math.hypot(dx, dn);
    if (distH > 90) return null;
    const elev = Math.atan2(hM - 1.7, Math.max(0.2, distH));
    const brg = Math.atan2(dx, dn) - (a.headingDeg || 0) * Math.PI / 180;
    const cb = Math.cos(elev), sb = Math.sin(elev);
    const D = [Math.sin(brg) * cb, sb, -Math.cos(brg) * cb];  // X east, Y up, Z south
    const yaw = this.view.yawDeg * Math.PI / 180, pit = this.view.pitchDeg * Math.PI / 180;
    const cp = Math.cos(pit), sp = Math.sin(pit);
    const right = [Math.cos(yaw), 0, Math.sin(yaw)];
    const fwdH = [Math.sin(yaw), 0, -Math.cos(yaw)];
    const fwd = [fwdH[0] * cp, sp, fwdH[2] * cp];
    const upv = [-fwdH[0] * sp, cp, -fwdH[2] * sp];
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const df = dot(D, fwd);
    if (df < 0.02) return null;                          // behind the camera
    const t = Math.tan(this.view.fovDeg * Math.PI / 360) * (this.view.zoom || 1);
    const nx = dot(D, right) / (df * t * aspect);
    const ny = dot(D, upv) / (df * t);
    if (Math.abs(nx) > 1.25 || Math.abs(ny) > 1.25) return null;
    return { nx, ny, distM: distH };
  }

  /** Small quadruped silhouette drawn around (sx, syF): four trotting legs
      (diagonal pairs), a stretched body, head, and a tail — raised proud for
      cats, wagging for dogs. `phase` drives the gait; `moving` freezes it. */
  _drawQuadruped(ctx, sx, syF, bh, tint, phase, moving, { tailUp = false, flip = 1 } = {}) {
    const h = bh * 0.52;                       // shoulder height px
    const len = h * 1.85;                      // body length px
    ctx.save();
    ctx.translate(sx, syF);
    ctx.scale(flip, 1);
    const bob = moving ? Math.abs(Math.sin(phase)) * h * 0.06 : 0;
    const bodyY = -h * 0.66 - bob;
    // contact shadow
    ctx.fillStyle = 'rgba(22,26,22,0.33)';
    ctx.beginPath(); ctx.ellipse(0, 0, len * 0.56, Math.max(1.2, h * 0.09), 0, 0, Math.PI * 2); ctx.fill();
    // legs — diagonal pairs in anti-phase
    const sw = moving ? Math.sin(phase) * h * 0.30 : 0;
    ctx.strokeStyle = 'rgba(30,28,26,0.9)';
    ctx.lineWidth = Math.max(1, h * 0.13); ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-len * 0.32, bodyY + h * 0.28); ctx.lineTo(-len * 0.32 + sw, 0);
    ctx.moveTo(-len * 0.18, bodyY + h * 0.28); ctx.lineTo(-len * 0.18 - sw, 0);
    ctx.moveTo(len * 0.18, bodyY + h * 0.28); ctx.lineTo(len * 0.18 - sw, 0);
    ctx.moveTo(len * 0.32, bodyY + h * 0.28); ctx.lineTo(len * 0.32 + sw, 0);
    ctx.stroke();
    // body
    ctx.strokeStyle = tint;
    ctx.lineWidth = Math.max(2, h * 0.46);
    ctx.beginPath(); ctx.moveTo(-len * 0.34, bodyY); ctx.lineTo(len * 0.30, bodyY - h * 0.03); ctx.stroke();
    // head with a hint of ears
    ctx.fillStyle = tint;
    ctx.beginPath(); ctx.arc(len * 0.42, bodyY - h * 0.24, Math.max(1.4, h * 0.23), 0, Math.PI * 2); ctx.fill();
    // tail: cats carry a question-mark, dogs wag low
    ctx.strokeStyle = tint; ctx.lineWidth = Math.max(1, h * 0.11);
    ctx.beginPath();
    if (tailUp) {
      const curl = Math.sin(phase * 0.35) * h * 0.06;
      ctx.moveTo(-len * 0.36, bodyY - h * 0.02);
      ctx.quadraticCurveTo(-len * 0.56, bodyY - h * 0.52, -len * 0.46 + curl, bodyY - h * 0.78);
    } else {
      const wag = Math.sin(phase * 0.7) * h * 0.12;
      ctx.moveTo(-len * 0.36, bodyY - h * 0.04);
      ctx.lineTo(-len * 0.56, bodyY - h * 0.30 + wag);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Animated villagers walking coded routes (environment.actors): ping-pong
      loops between two world points, projected every frame — body, head,
      bobbing gait, swinging legs and a contact shadow. Within ~70 m they are
      crisp silhouettes, then they fade like everything else does. */
  _renderActors(now, dt, cvs) {
    if (!this.fx || !this.immersion.actors || !this.anchors?.actors?.length) return;
    const ctx = this.fx, W = cvs.width, H = cvs.height;
    const aspect = W / Math.max(1, H);
    const t = (now - this._t0) / 1000;
    for (const act of this.anchors.actors) {
      if (act.kind === 'dog' || act.kind === 'cat') {
        // quadrupeds share the walkers' route model; cats dwell at both ends
        const ax = act.x1 - act.x0, ay = act.y1 - act.y0;
        const lenM = Math.max(0.5, Math.hypot(ax, ay));
        const P = lenM / Math.max(0.2, act.speedMps || 1);   // one-way seconds
        const d = act.kind === 'cat' ? 3.2 : 0;              // dwell at each end
        const s = (((t + (act.phase || 0)) % (2 * (d + P))) + 2 * (d + P)) % (2 * (d + P));
        let k = 0, moving = false, dir = 1;
        if (s < d)          { k = 0; }                                  // rest @ A
        else if (s < d + P) { k = (s - d) / P; moving = true; }         // walk A→B
        else if (s < 2 * d + P) { k = 1; dir = -1; }                    // rest @ B
        else                { k = 1 - (s - 2 * d - P) / P; moving = true; dir = -1; }
        const feetX = act.x0 + ax * k, feetY = act.y0 + ay * k;
        const feet = this._projectWorld(feetX, feetY, 0, aspect);
        const head = this._projectWorld(feetX, feetY, 0.95, aspect);
        if (!feet || !head) continue;
        const sx = (feet.nx * 0.5 + 0.5) * W;
        const syF = (1 - (feet.ny * 0.5 + 0.5)) * H;
        const bh = Math.max(3, syF - (1 - (head.ny * 0.5 + 0.5)) * H);
        if (bh > H) continue;
        const cadence = act.kind === 'dog' ? 0.34 : 0.52;
        const stepPh = t * (2 * Math.PI / cadence) + (act.phase || 0) * 3;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(0.92, 1.25 - feet.distM / 60));
        if (ctx.globalAlpha <= 0.02) { ctx.restore(); continue; }
        this._drawQuadruped(ctx, sx, syF, bh, act.tint || '#4a3a28', stepPh, moving,
          { tailUp: act.kind === 'cat', flip: dir });
        ctx.restore();
        continue;
      }
      if (act.kind === 'cyclist' || act.kind === 'bike') {
        const ax = act.x1 - act.x0, ay = act.y1 - act.y0;
        const lenM = Math.max(0.5, Math.hypot(ax, ay));
        const P = lenM / Math.max(0.2, act.speedMps || 1);
        const s = (((t + (act.phase || 0)) / P) % 2 + 2) % 2;
        const k = s < 1 ? s : 2 - s;
        const dir = s < 1 ? 1 : -1;
        const feetX = act.x0 + ax * k, feetY = act.y0 + ay * k;
        const feet = this._projectWorld(feetX, feetY, 0, aspect);
        const head = this._projectWorld(feetX, feetY, 1.62, aspect);
        if (!feet || !head) continue;
        const sx = (feet.nx * 0.5 + 0.5) * W;
        const syF = (1 - (feet.ny * 0.5 + 0.5)) * H;
        const syH = (1 - (head.ny * 0.5 + 0.5)) * H;
        const bh = Math.max(3, syF - syH);
        if (bh > H) continue;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(0.92, 1.25 - feet.distM / 60));
        if (ctx.globalAlpha <= 0.02) { ctx.restore(); continue; }
        ctx.fillStyle = 'rgba(22,26,22,0.35)';
        ctx.beginPath(); ctx.ellipse(sx, syF, bh * 0.45, Math.max(1.2, bh * 0.06), 0, 0, Math.PI * 2); ctx.fill();
        const wheelR = Math.max(1.2, bh * 0.16);
        ctx.strokeStyle = '#222';
        ctx.lineWidth = Math.max(1, bh * 0.04);
        ctx.beginPath();
        ctx.arc(sx - bh * 0.28 * dir, syF - wheelR, wheelR, 0, Math.PI * 2);
        ctx.arc(sx + bh * 0.28 * dir, syF - wheelR, wheelR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = act.tint || '#c0392b';
        ctx.lineWidth = Math.max(1.2, bh * 0.05);
        ctx.beginPath();
        ctx.moveTo(sx - bh * 0.28 * dir, syF - wheelR);
        ctx.lineTo(sx - bh * 0.05 * dir, syF - wheelR * 1.5);
        ctx.lineTo(sx + bh * 0.28 * dir, syF - wheelR);
        ctx.lineTo(sx + bh * 0.12 * dir, syF - wheelR * 2.2);
        ctx.lineTo(sx - bh * 0.05 * dir, syF - wheelR * 1.5);
        ctx.stroke();
        ctx.strokeStyle = '#2c3e50';
        ctx.lineWidth = Math.max(1.5, bh * 0.12);
        ctx.beginPath();
        ctx.moveTo(sx - bh * 0.05 * dir, syF - wheelR * 1.6);
        ctx.lineTo(sx + bh * 0.08 * dir, syH + bh * 0.25);
        ctx.stroke();
        ctx.fillStyle = '#d9b48f';
        ctx.beginPath();
        ctx.arc(sx + bh * 0.12 * dir, syH + bh * 0.16, Math.max(1.5, bh * 0.09), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        continue;
      }
      if (act.kind === 'boat') {
        const ax = act.x1 - act.x0, ay = act.y1 - act.y0;
        const lenM = Math.max(0.5, Math.hypot(ax, ay));
        const P = lenM / Math.max(0.2, act.speedMps || 1);
        const s = (((t + (act.phase || 0)) / P) % 2 + 2) % 2;
        const k = s < 1 ? s : 2 - s;
        const feetX = act.x0 + ax * k, feetY = act.y0 + ay * k;
        const feet = this._projectWorld(feetX, feetY, 0, aspect);
        const top = this._projectWorld(feetX, feetY, 1.2, aspect);
        if (!feet || !top) continue;
        const sx = (feet.nx * 0.5 + 0.5) * W;
        const syF = (1 - (feet.ny * 0.5 + 0.5)) * H;
        const syT = (1 - (top.ny * 0.5 + 0.5)) * H;
        const bh = Math.max(3, syF - syT);
        if (bh > H) continue;
        const rock = Math.sin(t * 1.8 + (act.phase || 0)) * bh * 0.04;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(0.92, 1.25 - feet.distM / 60));
        if (ctx.globalAlpha <= 0.02) { ctx.restore(); continue; }
        ctx.fillStyle = act.tint || '#ffffff';
        ctx.strokeStyle = '#2c3e50';
        ctx.lineWidth = Math.max(1, bh * 0.04);
        ctx.beginPath();
        ctx.moveTo(sx - bh * 0.6, syF + rock);
        ctx.lineTo(sx + bh * 0.6, syF + rock);
        ctx.lineTo(sx + bh * 0.45, syF + bh * 0.2 + rock);
        ctx.lineTo(sx - bh * 0.45, syF + bh * 0.2 + rock);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = '#8b5a2b';
        ctx.lineWidth = Math.max(1, bh * 0.05);
        ctx.beginPath();
        ctx.moveTo(sx, syF + rock);
        ctx.lineTo(sx, syT + rock);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      if (act.kind !== 'walker') continue;
      const ax = act.x1 - act.x0, ay = act.y1 - act.y0;
      const lenM = Math.max(0.5, Math.hypot(ax, ay));
      const P = lenM / Math.max(0.2, act.speedMps || 1);          // one-way seconds
      const s = (((t + (act.phase || 0)) / P) % 2 + 2) % 2;
      const k = s < 1 ? s : 2 - s;                                 // ping-pong
      const feetX = act.x0 + ax * k, feetY = act.y0 + ay * k;
      const feet = this._projectWorld(feetX, feetY, 0, aspect);
      const head = this._projectWorld(feetX, feetY, 1.72, aspect);
      if (!feet || !head) continue;                                // behind / off-frame / too far
      const sx = (feet.nx * 0.5 + 0.5) * W;
      const syF = (1 - (feet.ny * 0.5 + 0.5)) * H;
      const syH = (1 - (head.ny * 0.5 + 0.5)) * H;
      const bh = Math.max(3, syF - syH);                           // body height in px
      if (bh > H) continue;                                        // standing on the camera
      const stepPh = t * (2 * Math.PI / 0.72) + (act.phase || 0) * 3;
      const bob = Math.abs(Math.sin(stepPh)) * bh * 0.03;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(0.92, 1.25 - feet.distM / 60));
      if (ctx.globalAlpha <= 0.02) { ctx.restore(); continue; }
      const bw = Math.max(1.6, bh * 0.30);
      // contact shadow
      ctx.fillStyle = 'rgba(22,26,22,0.35)';
      ctx.beginPath(); ctx.ellipse(sx, syF, bh * 0.26, Math.max(1.2, bh * 0.06), 0, 0, Math.PI * 2); ctx.fill();
      // swinging legs
      const legA = Math.sin(stepPh) * bw * 0.5;
      ctx.strokeStyle = 'rgba(32,30,28,0.9)';
      ctx.lineWidth = Math.max(1.2, bw * 0.30);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx, syF - bh * 0.34 - bob); ctx.lineTo(sx + legA, syF);
      ctx.moveTo(sx, syF - bh * 0.34 - bob); ctx.lineTo(sx - legA, syF);
      ctx.stroke();
      // coat
      ctx.strokeStyle = act.tint || '#5a4a3a';
      ctx.lineWidth = bw;
      ctx.beginPath();
      ctx.moveTo(sx, syF - bh * 0.36 - bob);
      ctx.lineTo(sx, syH + bh * 0.16 - bob);
      ctx.stroke();
      // head
      ctx.fillStyle = '#d9b48f';
      ctx.beginPath(); ctx.arc(sx, syH + bh * 0.06 - bob, Math.max(1.6, bh * 0.115), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  /** Drifting clouds — world-anchored like the birds: seeded, slow azimuth
      drift, hidden by rain & night. Puffs pan with the view instead of the
      screen, so the sky feels continuous as you turn. */
  _cloudLayer() {
    if (this._clouds) return this._clouds;
    const rng = rngFor('viewer_cloud_layer_v1');
    this._clouds = [];
    for (let i = 0; i < 6; i++) {
      this._clouds.push({
        az: rng() * 360,
        spd: (0.18 + rng() * 0.22) * (rng() < 0.5 ? 1 : -1),
        elev: 0.05 + rng() * 0.11,
        size: 90 + rng() * 120,
        a: 0.10 + rng() * 0.10,
        phase: rng() * Math.PI * 2,
      });
    }
    return this._clouds;
  }

  _renderClouds(now, dt, cvs) {
    if (!this.fx || !this.immersion.clouds || this.immersion.rain) return;
    const ctx = this.fx, W = cvs.width, H = cvs.height;
    const fov = this.view.fovDeg, yaw = this.view.yawDeg;
    const t = (now - this._t0) / 1000;
    for (const c of this._cloudLayer()) {
      c.az = ((c.az + c.spd * dt / 1000) % 360 + 360) % 360;
      const rel = ((c.az - yaw + 540) % 360) - 180;
      const half = fov / 2 + (c.size / fov) * 30;
      if (Math.abs(rel) > half) continue;
      const x = (rel + fov / 2) / fov * W;
      const y = (c.elev + Math.sin(t * 0.05 + c.phase) * 0.004) * H;
      const s = c.size / (this.view.fovDeg / 75);
      ctx.save();
      ctx.globalAlpha = c.a;
      ctx.fillStyle = '#ffffff';
      for (const [ox, oy, r] of [[0, 0, 1], [-0.55, 0.14, 0.62], [0.5, 0.1, 0.72]]) {
        ctx.beginPath(); ctx.ellipse(x + ox * s, y + oy * s * 0.5, s * 0.5 * r, s * 0.17 * r, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  /* ---------------- the living world: sky, shafts, little lives --------- */

  /** Twinkling starfield, world-azimuth anchored like the birds (§17): pan
      and the sky pans with you. Looking up slides stars down, as it should. */
  _starFieldLayer() {
    if (this._stars) return this._stars;
    const rng = rngFor('viewer_starfield_v1');
    this._stars = [];
    for (let i = 0; i < 140; i++) {
      this._stars.push({
        az: rng() * 360,
        el: 0.03 + rng() * 0.40,                  // fraction of canvas height
        r: 0.7 + rng() * 1.5,
        tw: 0.5 + rng() * 2.4,                    // twinkle rad/s
        ph: rng() * Math.PI * 2,
      });
    }
    return this._stars;
  }

  _renderStars(now, dt, cvs) {
    if (!this.immersion.night) return;
    const t = (now - this._t0) / 1000;
    const ctx = this.fx, w = cvs.width, h = cvs.height;
    const fov = this.view.fovDeg, yaw = this.view.yawDeg, pitch = this.view.pitchDeg;
    const pitchShift = (pitch / Math.max(40, fov)) * 0.9;
    ctx.fillStyle = '#dfe8ff';
    for (const s of this._starFieldLayer()) {
      const rel = ((s.az - yaw + 540) % 360) - 180;
      if (Math.abs(rel) > fov / 2 + 6) continue;
      const x = (rel + fov / 2) / fov * w;
      const y = (s.el + pitchShift) * h;
      if (y < -4 || y > h * 0.66) continue;       // the horizon band is ground fog
      ctx.globalAlpha = 0.28 + 0.62 * (0.5 + 0.5 * Math.sin(t * s.tw + s.ph));
      ctx.fillRect(x, y, s.r, s.r);
    }
    ctx.globalAlpha = 1;
    // a shooting star every ~13 s: 1.1 s of travel, travel lane seeded by the
    // cycle index so it never repeats in the same place while you watch
    const CYC = 13, SPAN = 1.1, tt = t % CYC;
    if (tt < SPAN) {
      const k = tt / SPAN, lane = Math.floor(t / CYC);
      const azA = ((lane * 97.318) % 360 + 360) % 360;
      const elA = 0.05 + ((lane * 37) % 16) / 100;
      const project = (kk) => {
        const az = azA + 26 * kk, el = elA + 0.09 * kk;
        const r = ((az - yaw + 540) % 360) - 180;
        if (Math.abs(r) > fov / 2 + 10) return null;
        return { x: (r + fov / 2) / fov * w, y: (el + pitchShift) * h };
      };
      const head = project(k), tail = project(Math.max(0, k - 0.16));
      if (head && tail) {
        const a = Math.sin(Math.PI * k);          // ease in, burn out
        const grad = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
        grad.addColorStop(0, 'rgba(223,232,255,0)');
        grad.addColorStop(1, `rgba(240,246,255,${0.85 * a})`);
        ctx.strokeStyle = grad; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(tail.x, tail.y); ctx.lineTo(head.x, head.y); ctx.stroke();
      }
    }
  }

  /** Forward-scatter sun shafts: soft beams fanning around the sun's WORLD
      azimuth/elevation — walk east at dawn and the rays swing with you. */
  _renderSunRays(now, dt, cvs) {
    if (!this.immersion.sunrays) return;
    const sun = this.anchors?.sun;
    if (!sun) return;
    const t = (now - this._t0) / 1000;
    const ctx = this.fx, w = cvs.width, h = cvs.height;
    const fov = this.view.fovDeg, yaw = this.view.yawDeg, pitch = this.view.pitchDeg;
    const rel = ((sun.azDeg - yaw + 540) % 360) - 180;
    if (Math.abs(rel) > fov / 2 + 30) return;
    const sx = (rel + fov / 2) / fov * w;
    const sy = h * (0.40 - (sun.elDeg / 90) * 0.5) + (pitch / Math.max(40, fov)) * h * 0.9;
    if (sy < -h * 0.2 || sy > h * 0.58) return;
    const dawn = (this.anchors?.timeOfDay === 'golden');
    const col = dawn ? '255,194,128' : '255,238,180';
    const len = Math.hypot(w, h) * 0.85;
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {                 // slow-breathing beams
      const a = (i / 6) * Math.PI * 2 + t * 0.05;
      const breathe = 0.5 + 0.5 * Math.sin(t * 0.55 + i * 1.7);
      ctx.strokeStyle = `rgba(${col},${0.024 + 0.030 * breathe})`;
      ctx.lineWidth = 30 + 26 * breathe;
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(a) * 46, sy + Math.sin(a) * 46);
      ctx.lineTo(sx + Math.cos(a) * len, sy + Math.sin(a) * len);
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(${col},0.10)`;          // halo core + outer bloom
    ctx.beginPath(); ctx.arc(sx, sy, 44, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(${col},0.045)`;
    ctx.beginPath(); ctx.arc(sx, sy, 96, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /** Fireflies — night-only, clear-sky life near the ground: world-anchored
      wander, layered glow, gentle pulse. 24 orbs ≈ nothing per frame. */
  _fireflySwarm() {
    if (this._flies) return this._flies;
    const rng = rngFor('viewer_fireflies_v1');
    this._flies = [];
    for (let i = 0; i < 24; i++) {
      this._flies.push({
        az0: rng() * 360,
        w: 0.06 + rng() * 0.14,                   // azimuth wander rate
        amp: 2.5 + rng() * 5.5,                   // wander amplitude (deg)
        el: 0.60 + rng() * 0.15,                  // hover band (lower half)
        sp: 0.5 + rng() * 1.6,                    // glow pulse rate
        ph: rng() * Math.PI * 2,
        s: 1.1 + rng() * 1.6,
      });
    }
    return this._flies;
  }

  _renderFireflies(now, dt, cvs) {
    if (!this.immersion.fireflies) return;
    const t = (now - this._t0) / 1000;
    const ctx = this.fx, w = cvs.width, h = cvs.height;
    const fov = this.view.fovDeg, yaw = this.view.yawDeg, pitch = this.view.pitchDeg;
    const pitchShift = (pitch / Math.max(40, fov)) * 0.9;
    for (const f of this._fireflySwarm()) {
      const az = f.az0 + Math.sin(t * f.w) * f.amp;
      const rel = ((az - yaw + 540) % 360) - 180;
      if (Math.abs(rel) > fov / 2 + 8) continue;
      const x = (rel + fov / 2) / fov * w;
      const y = (Math.min(0.88, f.el + pitchShift)) * h + Math.sin(t * 0.7 + f.ph * 3) * 6;
      const glow = 0.18 + 0.82 * (0.5 + 0.5 * Math.sin(t * f.sp + f.ph));
      ctx.fillStyle = `rgba(196,255,130,${0.16 * glow})`;
      ctx.beginPath(); ctx.arc(x, y, f.s * 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(222,255,168,${0.85 * glow})`;
      ctx.beginPath(); ctx.arc(x, y, f.s * 1.1, 0, Math.PI * 2); ctx.fill();
    }
  }

  /** Snowfall — drifting flakes with a slow gust cycle; larger flakes fall
      faster and read closer (cheap parallax). Rain hides it by mode design. */
  _renderSnow(now, dt, cvs) {
    if (!this.immersion.snow) { this._snow.length = 0; return; }
    const t = (now - this._t0) / 1000;
    if (this._snow.length === 0) {
      for (let i = 0; i < 130; i++) {
        this._snow.push({
          x: Math.random() * cvs.width, y: Math.random() * cvs.height,
          v: 30 + Math.random() * 66,             // fall speed px/s
          r: 0.9 + Math.random() * 2.1,           // size ⇄ depth
          ph: Math.random() * Math.PI * 2,
          sw: 8 + Math.random() * 24,             // personal sway
        });
      }
    }
    const gust = (Math.sin(t * 0.21) * 0.5 + 0.5) * 16;   // whole-scene wind
    const ctx = this.fx;
    for (const f of this._snow) {
      f.y += f.v * dt / 1000;
      f.x += (Math.sin(t * 0.9 + f.ph) * f.sw + gust) * dt / 1000;
      if (f.y > cvs.height + 3) { f.y = -3; f.x = Math.random() * cvs.width; }
      if (f.x > cvs.width + 3) f.x = -3; else if (f.x < -3) f.x = cvs.width + 3;
      ctx.fillStyle = `rgba(246,250,255,${0.42 + Math.min(0.45, f.r * 0.16)})`;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2); ctx.fill();
    }
  }

  /** Butterflies — hard world-anchored little lives (§17): a handful of
      seeded meadows around the current node, figure-8 loops ~1 m up, projected
      through the same camera math as the villagers so parallax sells them. */
  _butterflyMeadow() {
    if (this._butter) return this._butter;
    const rng = rngFor('viewer_butterflies_v1');
    const tints = ['#e8a4c8', '#a4d0ff', '#ffd98a', '#c8b0ff', '#a8e6b0'];
    this._butter = [];
    for (let i = 0; i < 5; i++) {
      this._butter.push({
        ox: rng() * 24 - 12, oy: rng() * 24 - 12, // meadow offset from node, m
        w: 0.4 + rng() * 0.45,                    // loop rate rad/s
        amp: 1.6 + rng() * 2.2,                   // loop radius m
        ph: rng() * Math.PI * 2,
        flap: 9 + rng() * 5,
        tint: tints[i % tints.length],
      });
    }
    return this._butter;
  }

  _renderButterflies(now, dt, cvs) {
    if (!this.immersion.butterflies || !this.anchors) return;
    const t = (now - this._t0) / 1000;
    const aspect = cvs.width / Math.max(1, cvs.height);
    const ctx = this.fx;
    for (const b of this._butterflyMeadow()) {
      const wx = this.anchors.xM + b.ox + Math.sin(t * b.w + b.ph) * b.amp;
      const wy = this.anchors.yM + b.oy + Math.sin(2 * t * b.w + b.ph) * b.amp * 0.6;
      const zz = 1.0 + 0.35 * Math.sin(t * b.w * 1.7 + b.ph * 2);
      const p = this._projectWorld(wx, wy, zz, aspect);
      if (!p || p.distM > 34) continue;
      const s = Math.max(2.4, 130 / Math.max(2, p.distM));   // wing px by range
      const x = (p.nx * 0.5 + 0.5) * cvs.width;
      const y = (1 - (p.ny * 0.5 + 0.5)) * cvs.height;
      const flap = Math.abs(Math.sin(t * b.flap + b.ph));    // wings close→open
      const spread = s * (0.35 + 0.75 * (1 - flap));
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(0.95, 1.3 - p.distM / 30));
      ctx.fillStyle = b.tint;
      ctx.beginPath();                                        // two wing lobes
      ctx.ellipse(x - spread * 0.45, y, spread * 0.5, s * 0.5, -0.5, 0, Math.PI * 2);
      ctx.ellipse(x + spread * 0.45, y, spread * 0.5, s * 0.5, 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(40,36,34,0.9)';                   // body
      ctx.fillRect(x - Math.max(0.8, s * 0.07) / 2, y - s * 0.42, Math.max(0.8, s * 0.07), s * 0.84);
      ctx.restore();
    }
  }

  /* ---------------- wave 2: weather gods, water, meadow ---------------- */

  /** Hot-air balloons drifting the fair-day sky — huge, slow, world-anchored;
      the kind of thing you chase with the camera because it feels real. */
  _balloonLayer() {
    if (this._balloons) return this._balloons;
    const rng = rngFor('viewer_balloons_v1');
    const tints = [['#d8604c', '#f2e4c8'], ['#4c7bd8', '#e8ecf5'], ['#d8a44c', '#f5ecd8']];
    this._balloons = [];
    for (let i = 0; i < 2; i++) {
      const [tint, band] = tints[i % tints.length];
      this._balloons.push({
        az0: rng() * 360,
        drift: (0.28 + rng() * 0.22) * (rng() < 0.5 ? 1 : -1),   // deg/sec — stately
        el: 0.09 + rng() * 0.12,
        size: 30 + rng() * 14,
        ph: rng() * Math.PI * 2,
        tint, band,
      });
    }
    return this._balloons;
  }

  _renderBalloons(now, dt, cvs) {
    if (!this.immersion.balloon) return;
    const t = (now - this._t0) / 1000;
    const ctx = this.fx, w = cvs.width, h = cvs.height;
    const fov = this.view.fovDeg, yaw = this.view.yawDeg, pitch = this.view.pitchDeg;
    const pitchShift = (pitch / Math.max(40, fov)) * 0.9;
    for (const b of this._balloonLayer()) {
      const az = ((b.az0 + t * b.drift) % 360 + 360) % 360;
      const rel = ((az - yaw + 540) % 360) - 180;
      if (Math.abs(rel) > fov / 2 + 20) continue;
      const x = (rel + fov / 2) / fov * w;
      const y = (b.el + pitchShift) * h + Math.sin(t * 0.22 + b.ph) * 5;
      const s = b.size;
      ctx.save();
      // envelope with a pale belly band
      ctx.fillStyle = b.tint;
      ctx.beginPath(); ctx.ellipse(x, y, s * 0.46, s * 0.56, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = b.band;
      ctx.beginPath(); ctx.ellipse(x, y, s * 0.20, s * 0.56, 0, 0, Math.PI * 2); ctx.fill();
      // rigging + basket
      ctx.strokeStyle = 'rgba(60,48,38,0.8)'; ctx.lineWidth = Math.max(1, s * 0.03);
      ctx.beginPath();
      ctx.moveTo(x - s * 0.18, y + s * 0.42); ctx.lineTo(x - s * 0.09, y + s * 0.74);
      ctx.moveTo(x + s * 0.18, y + s * 0.42); ctx.lineTo(x + s * 0.09, y + s * 0.74);
      ctx.stroke();
      ctx.fillStyle = '#5d4630';
      ctx.fillRect(x - s * 0.12, y + s * 0.72, s * 0.24, s * 0.18);
      ctx.restore();
    }
  }

  /** Night watch: an owl glides across the sky every ~17 s — a slow, wide,
      silent silhouette. Lane seeded per cycle like the shooting star. */
  _renderOwl(now, dt, cvs) {
    if (!this.immersion.owl) return;
    const t = (now - this._t0) / 1000;
    const CYC = 17, SPAN = 2.8, tt = t % CYC;
    if (tt > SPAN) return;
    const u = tt / SPAN, lane = Math.floor(t / CYC);
    const dir = lane % 2 ? 1 : -1;
    const azA = ((lane * 53.21) % 360 + 360) % 360;
    const az = azA + dir * (44 * u);
    const ctx = this.fx, w = cvs.width, h = cvs.height;
    const fov = this.view.fovDeg, yaw = this.view.yawDeg, pitch = this.view.pitchDeg;
    const rel = ((az - yaw + 540) % 360) - 180;
    if (Math.abs(rel) > fov / 2 + 16) return;
    const x = (rel + fov / 2) / fov * w;
    const y = (0.27 + (pitch / Math.max(40, fov)) * 0.9) * h + Math.sin(u * Math.PI) * -14;
    const flap = Math.sin(t * 5.2) * 0.5;             // slow powerful beats
    const s = 20;
    ctx.save();
    ctx.strokeStyle = `rgba(14,18,28,${0.75 * Math.sin(Math.PI * Math.min(1, u * 4, (1 - u) * 4 + 0.2))})`;
    ctx.lineWidth = Math.max(2.4, s * 0.16); ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - s * 1.4, y - flap * s * 0.5);
    ctx.quadraticCurveTo(x - s * 0.6, y + flap * s * 0.4, x, y);
    ctx.quadraticCurveTo(x + s * 0.6, y + flap * s * 0.4, x + s * 1.4, y - flap * s * 0.5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(14,18,28,0.85)';
    ctx.beginPath(); ctx.arc(x, y, s * 0.22, 0, Math.PI * 2); ctx.fill();   // head-body blob
    ctx.restore();
  }

  /** Dawn low-mist: wide soft banks hugging the ground, world-azimuth
      anchored, drifting sideways at a whisper. */
  _mistLayer() {
    if (this._wisps) return this._wisps;
    const rng = rngFor('viewer_mist_v1');
    this._wisps = [];
    for (let i = 0; i < 7; i++) {
      this._wisps.push({
        az0: rng() * 360,
        drift: (0.5 + rng() * 0.8) * (rng() < 0.5 ? 1 : -1),
        el: 0.66 + rng() * 0.16,
        wpx: 130 + rng() * 240,
        hpx: 10 + rng() * 16,
        ph: rng() * Math.PI * 2,
      });
    }
    return this._wisps;
  }

  _renderMist(now, dt, cvs) {
    if (!this.immersion.mist) return;
    const t = (now - this._t0) / 1000;
    const ctx = this.fx, w = cvs.width, h = cvs.height;
    const fov = this.view.fovDeg, yaw = this.view.yawDeg, pitch = this.view.pitchDeg;
    const pitchShift = (pitch / Math.max(40, fov)) * 0.9;
    for (const m of this._mistLayer()) {
      const az = ((m.az0 + t * m.drift * 0.05) % 360 + 360) % 360;
      const rel = ((az - yaw + 540) % 360) - 180;
      if (Math.abs(rel) > fov / 2 + 60) continue;
      const x = (rel + fov / 2) / fov * w;
      const y = (Math.min(0.94, m.el + pitchShift)) * h;
      const breathe = 0.6 + 0.4 * Math.sin(t * 0.3 + m.ph);
      ctx.fillStyle = `rgba(224,231,240,${0.05 + 0.05 * breathe})`;
      ctx.beginPath(); ctx.ellipse(x, y, m.wpx / 2, m.hpx * breathe, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(224,231,240,${0.03 + 0.03 * breathe})`;
      ctx.beginPath(); ctx.ellipse(x + m.wpx * 0.18, y - m.hpx * 0.7, m.wpx / 3, m.hpx * 0.8, 0, 0, Math.PI * 2); ctx.fill();
    }
  }

  /** Pond & lake ripples — expanding rings centred on seeded spots inside the
      world's water regions (handed over as anchors). Rain stirs double rings. */
  _renderRipples(now, dt, cvs) {
    if (!this.immersion.ripples) return;
    const water = this.anchors?.water;
    if (!water?.length) return;
    const t = (now - this._t0) / 1000;
    const aspect = cvs.width / Math.max(1, cvs.height);
    const ctx = this.fx;
    const ringsPer = this.immersion.rain ? 4 : 2;
    const speed = this.immersion.rain ? 1.6 : 3.2;           // seconds per ring
    for (let wi = 0; wi < water.length; wi++) {
      const reg = water[wi];
      const rng = rngFor('viewer_ripples_' + wi);
      for (let i = 0; i < ringsPer; i++) {
        const oxM = (rng() - 0.5) * reg.spreadM, oyM = (rng() - 0.5) * reg.spreadM;
        const p = this._projectWorld(reg.xM + oxM, reg.yM + oyM, 0.02, aspect);
        if (!p || p.distM > 80) continue;
        const x = (p.nx * 0.5 + 0.5) * cvs.width;
        const y = (1 - (p.ny * 0.5 + 0.5)) * cvs.height;
        const rMax = Math.max(6, 220 / Math.max(2, p.distM));  // px by range
        const k = ((t / speed) + i / ringsPer + (wi * 0.31)) % 1;
        ctx.strokeStyle = `rgba(214,228,240,${0.30 * (1 - k)})`;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.ellipse(x, y, rMax * k, rMax * k * 0.30, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  /** Rabbits in the meadow — rest, then three quick parabolic hops along a
      seeded heading, rest again. World-anchored around the current node. */
  _rabbitWarren() {
    if (this._rabbits) return this._rabbits;
    const rng = rngFor('viewer_rabbits_v1');
    this._rabbits = [];
    for (let i = 0; i < 3; i++) {
      this._rabbits.push({
        ox: rng() * 30 - 15, oy: rng() * 30 - 15,       // warren centre, m
        dir: rng() * Math.PI * 2,                        // initial hop bearing
        rest: 2.2 + rng() * 1.6,
        ph: rng() * 8,
        tint: ['#6b5a44', '#7a684e', '#5d4f3e'][i % 3],
      });
    }
    return this._rabbits;
  }

  _renderRabbits(now, dt, cvs) {
    if (!this.immersion.rabbits || !this.anchors) return;
    const t = (now - this._t0) / 1000;
    const aspect = cvs.width / Math.max(1, cvs.height);
    const ctx = this.fx;
    const HOP = 0.42, HOPS = 3, STRIDE = 0.85;         // hop seconds, count, metres
    for (const r of this._rabbitWarren()) {
      const cycle = r.rest + HOPS * HOP;
      const s = ((t + r.ph) % cycle);
      let hopI = -1, ku = 0;                             // resting…
      if (s >= r.rest) { hopI = Math.floor((s - r.rest) / HOP); ku = ((s - r.rest) / HOP) % 1; }
      const travelled = (hopI < 0 ? HOPS : hopI + ku) * STRIDE;
      const wx = this.anchors.xM + r.ox + Math.cos(r.dir) * travelled;
      const wy = this.anchors.yM + r.oy + Math.sin(r.dir) * travelled;
      const lift = hopI < 0 ? 0 : Math.sin(Math.PI * ku) * 0.16;      // parabola, m
      const feet = this._projectWorld(wx, wy, lift, aspect);
      const head = this._projectWorld(wx, wy, lift + 0.30, aspect);
      if (!feet || !head || feet.distM > 40) continue;
      const sx = (feet.nx * 0.5 + 0.5) * cvs.width;
      const syF = (1 - (feet.ny * 0.5 + 0.5)) * cvs.height;
      const bh = Math.max(2.2, syF - (1 - (head.ny * 0.5 + 0.5)) * cvs.height);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(0.9, 1.15 - feet.distM / 34));
      if (ctx.globalAlpha <= 0.02) { ctx.restore(); continue; }
      // shadow, crouched body, head, ears
      ctx.fillStyle = 'rgba(22,26,22,0.30)';
      ctx.beginPath(); ctx.ellipse(sx, syF, bh * 0.30, Math.max(0.9, bh * 0.07), 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = r.tint;
      ctx.beginPath(); ctx.ellipse(sx, syF - bh * 0.28, bh * 0.30, bh * 0.26, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(sx + bh * 0.24, syF - bh * 0.52, Math.max(1, bh * 0.15), 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = r.tint; ctx.lineWidth = Math.max(0.8, bh * 0.07); ctx.lineCap = 'round';
      const earTip = hopI < 0 ? bh * 0.34 : bh * 0.44;   // ears prick mid-hop
      ctx.beginPath();
      ctx.moveTo(sx + bh * 0.20, syF - bh * 0.60); ctx.lineTo(sx + bh * 0.16, syF - bh * 0.60 - earTip);
      ctx.moveTo(sx + bh * 0.28, syF - bh * 0.60); ctx.lineTo(sx + bh * 0.30, syF - bh * 0.62 - earTip);
      ctx.stroke();
      ctx.restore();
    }
  }

  _renderRain(now, dt, cvs) {
    if (!this.immersion.rain) { this._rainDrops.length = 0; return; }
    const storm = !!this.immersion.storm;
    const want = storm ? 170 : 90;
    // storm ⇄ rain toggles rebuild the drop pool so intensity snaps in
    if (this._rainDrops.length !== want) {
      this._rainDrops.length = 0;
      for (let i = 0; i < want; i++) {
        this._rainDrops.push({
          x: Math.random() * cvs.width, y: Math.random() * cvs.height,
          v: (storm ? 720 : 480) + Math.random() * (storm ? 520 : 360),
          l: (storm ? 12 : 8) + Math.random() * 14,
        });
      }
    }
    const t = (now - this._t0) / 1000;
    const gust = storm ? (Math.sin(t * 0.5) * 0.5 + 0.5) * 9 : 0;   // wind shove
    const slant = storm ? -(6 + gust) : -1.5;
    this.fx.strokeStyle = storm ? 'rgba(188,204,230,0.55)' : 'rgba(174,194,224,0.45)';
    this.fx.lineWidth = storm ? 1.3 : 1;
    this.fx.beginPath();
    for (const d of this._rainDrops) {
      d.y += d.v * dt / 1000;
      d.x += (slant * 14) * dt / 1000;
      if (d.y > cvs.height) { d.y = -d.l; d.x = Math.random() * (cvs.width + 80); }
      if (d.x < -80) d.x = cvs.width + Math.random() * 40;
      this.fx.moveTo(d.x, d.y); this.fx.lineTo(d.x + slant * 0.3, d.y + d.l);
    }
    this.fx.stroke();
    // lightning: a double-strike flash every ~8 s while the storm rages
    if (storm) {
      const CYC = 8, tt = t % CYC;
      const p1 = Math.exp(-Math.pow((tt - 0.05) / 0.045, 2));
      const p2 = 0.7 * Math.exp(-Math.pow((tt - 0.22) / 0.06, 2));
      const a = Math.min(0.42, (p1 + p2) * 0.42);
      if (a > 0.004) { this.fx.fillStyle = `rgba(226,236,255,${a})`; this.fx.fillRect(0, 0, cvs.width, cvs.height); }
    }
  }

  /** Animated birds — a fixed seeded flock drifting around WORLD azimuth, so
      panning the view sweeps past the flock exactly the way panning pans past
      a painted farm: continuous with the coded world, never screen-locked,
      and identical for every visitor (seeded, no Math.random). Birds roost in
      the rain, so rain mode hides them — one more weather cue. */
  _birdFlock() {
    if (this._flock) return this._flock;
    const rng = rngFor('viewer_bird_flock_v1');
    this._flock = [];
    for (let i = 0; i < 8; i++) {
      this._flock.push({
        az: rng() * 360,                                  // world azimuth it currently circles at
        speed: (0.55 + rng() * 0.5) * (rng() < 0.5 ? 1 : -1),  // deg/sec drift — slow like a lazy glide
        span: 9 + rng() * 8,                              // wingspan px at this "distance"
        elev: 0.10 + rng() * 0.20,                        // base height: fraction of viewport from top
        phase: rng() * Math.PI * 2,                       // flap offset
        flap: 4.5 + rng() * 3,                            // flap frequency rad/s
        bob: 5 + rng() * 5,                               // vertical bob amplitude px
      });
    }
    return this._flock;
  }

  _renderBirds(now, dt, cvs) {
    if (!this.immersion.birds || this.immersion.rain) return;
    const t = (now - this._t0) / 1000;
    const ctx = this.fx, w = cvs.width, h = cvs.height;
    const fov = this.view.fovDeg, yaw = this.view.yawDeg;
    ctx.strokeStyle = 'rgba(30,34,42,0.82)';
    ctx.lineCap = 'round';
    for (const b of this._birdFlock()) {
      b.az = ((b.az + b.speed * dt / 1000) % 360 + 360) % 360;
      const rel = ((b.az - yaw + 540) % 360) - 180;       // signed offset from view center
      const half = fov / 2 + 12;
      if (Math.abs(rel) > half) continue;
      const x = (rel + fov / 2) / fov * w;
      const y = b.elev * h + Math.sin(t * 0.9 + b.phase * 3) * b.bob;
      const wingAmp = b.span * 0.46 * Math.sin(t * b.flap + b.phase);
      const s = b.span;
      ctx.lineWidth = Math.max(1.2, s * 0.14);
      ctx.beginPath();
      ctx.moveTo(x - s, y - wingAmp * 0.4);
      ctx.quadraticCurveTo(x - s * 0.45, y - wingAmp, x, y);
      ctx.quadraticCurveTo(x + s * 0.45, y - wingAmp, x + s, y - wingAmp * 0.4);
      ctx.stroke();
    }
  }

  _emitView() { this.bus.emit('view:changed', { yawDeg: this.view.yawDeg, pitchDeg: this.view.pitchDeg, fovDeg: this.view.fovDeg }); }
}
