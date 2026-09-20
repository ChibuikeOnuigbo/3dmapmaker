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

    this.immersion = { sway: false, swayIntensity: 0.4, breeze: false, rain: false, transitionMs: 420 };
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
    const dur = opts.durationMs ?? this.immersion.transitionMs ?? 420;
    this.renderer.setImageB(source, headingDeg);
    this.view.hasB = true;
    const dirZoom = { forward: 1.14, backward: 0.9, left: 1.06, right: 1.06 }[opts.direction] ?? 1.08;
    this._transition = { t0: performance.now(), dur, dirZoom, fromZoom: this.view.zoom };
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
    if (this._transition) {
      const t = Math.min(1, (now - this._transition.t0) / this._transition.dur);
      const e = 1 - Math.pow(1 - t, 3);
      this.view.mix = e;
      const dirZoom = 1 + (this._transition.dirZoom - 1) * (1 - e);
      this.view.zoom = dirZoom;
      if (t >= 1) this._finishTransition();
    }

    // immersion offsets — visual only (never stored to world state)
    let yawOff = 0, pitchOff = 0;
    const time = (now - this._t0) / 1000;
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
    this._renderRain(now, dt);
    this.onFrameRendered?.();   // post-processing hook (sharpen pass schedules here)
  }

  _renderRain(now, dt) {
    if (!this.fx) return;
    const cvs = this.fx.canvas;
    this.fx.clearRect(0, 0, cvs.width, cvs.height);
    if (!this.immersion.rain) { this._rainDrops.length = 0; return; }
    if (cvs.width !== cvs.clientWidth || cvs.height !== cvs.clientHeight) { cvs.width = cvs.clientWidth; cvs.height = cvs.clientHeight; }
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

  _emitView() { this.bus.emit('view:changed', { yawDeg: this.view.yawDeg, pitchDeg: this.view.pitchDeg, fovDeg: this.view.fovDeg }); }
}
