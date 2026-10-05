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

    this.immersion = { sway: false, swayIntensity: 0.4, breeze: false, rain: false, birds: false, clouds: false, transitionMs: 420 };
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
    this._t0 = performance.now();

    this._bindInput();
  }

  /* ---------------- input ---------------- */
  _bindInput() {
    const el = this.canvas;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
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
      const f = Math.exp((e.deltaY > 0 ? 1 : -1) * 0.09);
      this.view.fovDeg = Math.min(this.view.maxFov, Math.max(this.view.minFov, this.view.fovDeg * f));
      this._emitView();
    }, { passive: false });
  }

  /** External look control (keyboard arrows / nudge buttons). */
  look(deltaYawDeg, deltaPitchDeg) {
    this.view.yawDeg = ((this.view.yawDeg + deltaYawDeg) % 360 + 360) % 360;
    this._rawPitch += deltaPitchDeg;
    this._emitView();
  }

  setFov(fovDeg) {
    this.view.fovDeg = Math.min(this.view.maxFov, Math.max(this.view.minFov, fovDeg));
    this._emitView();
  }

  setPitchLimits(limits) {
    // never allow pole-viewing even with AutoComplete OFF (safety clamp)
    this.pitchLimits = { min: Math.max(-88, limits.min), max: Math.min(88, limits.max) };
    if (!limits.tight) { this.pitchLimits.min = Math.min(this.pitchLimits.min, -80); this.pitchLimits.max = Math.max(this.pitchLimits.max, 80); }
  }

  /** Immediate (no transition) image swap — used for the very first frame. */
  setImageNow(source, headingDeg) {
    this.renderer.setImageA(source, headingDeg);
    this.view.mix = 0; this.view.hasB = false;
  }

  /**
   * Transition to a new panorama. Keeps the old image visible while fading —
   * never blanks to a spinner (Spec §58).
   * @param {object} opts {direction:'forward'|'backward'|'left'|'right'|null, durationMs}
   */
  transitionTo(source, headingDeg, opts = {}) {
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
    this._renderClouds(now, dt, cvs);
    this._renderBirds(now, dt, cvs);
    this._renderActors(now, dt, cvs);
    this._renderRain(now, dt, cvs);
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

  /** Animated villagers walking coded routes (environment.actors): ping-pong
      loops between two world points, projected every frame — body, head,
      bobbing gait, swinging legs and a contact shadow. Within ~70 m they are
      crisp silhouettes, then they fade like everything else does. */
  _renderActors(now, dt, cvs) {
    if (!this.fx || !this.anchors?.actors?.length) return;
    const ctx = this.fx, W = cvs.width, H = cvs.height;
    const aspect = W / Math.max(1, H);
    const t = (now - this._t0) / 1000;
    for (const act of this.anchors.actors) {
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

  _renderRain(now, dt, cvs) {
    if (!this.immersion.rain) { this._rainDrops.length = 0; return; }
    if (this._rainDrops.length === 0) {
      for (let i = 0; i < 90; i++) this._rainDrops.push({ x: Math.random() * cvs.width, y: Math.random() * cvs.height, v: 480 + Math.random() * 360, l: 8 + Math.random() * 14 });
    }
    this.fx.strokeStyle = 'rgba(174,194,224,0.45)';
    this.fx.lineWidth = 1;
    this.fx.beginPath();
    for (const d of this._rainDrops) {
      d.y += d.v * dt / 1000;
      if (d.y > cvs.height) { d.y = -d.l; d.x = Math.random() * cvs.width; }
      this.fx.moveTo(d.x, d.y); this.fx.lineTo(d.x - 1.5, d.y + d.l);
    }
    this.fx.stroke();
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
