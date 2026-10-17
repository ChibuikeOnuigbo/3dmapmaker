/**
 * Compass - Object-Oriented Compass & Heading model
 * Supports 8-wind & 16-wind cardinal directions (N, NE, E, SE, S, SW, W, NW, etc.),
 * customizable start heading, dial styling, canvas rendering, and DOM element binding.
 */
export class Compass {
  constructor(options = {}) {
    this.defaultStartHeading = Number(options.defaultStartHeading) || 0;
    this.headingDeg = Number(options.headingDeg) || this.defaultStartHeading;
    this.mode = options.mode || 'fixed-dial'; // 'fixed-dial' (needle rotates to North) or 'rotating-dial'
    this.theme = {
      needleNorth: options.theme?.needleNorth || '#eb5757',
      needleSouth: options.theme?.needleSouth || '#8798ab',
      textColor: options.theme?.textColor || '#2c3e50',
      font: options.theme?.font || 'system-ui',
      ...(options.theme || {}),
    };
    this.onChange = options.onChange || null;
    this._boundElements = new Set();
  }

  static CARDINALS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  static CARDINALS_16 = [
    'N', 'NNE', 'NE', 'ENE',
    'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW',
    'W', 'WNW', 'NW', 'NNW',
  ];

  /** Convert degrees (0-360) to 8-point cardinal string. */
  static cardinalOf(deg, points = 8) {
    const norm = (((deg % 360) + 360) % 360);
    if (points === 16) {
      const idx = Math.round(norm / 22.5) % 16;
      return Compass.CARDINALS_16[idx];
    }
    const idx = Math.round(norm / 45) % 8;
    return Compass.CARDINALS_8[idx];
  }

  get cardinal() {
    return Compass.cardinalOf(this.headingDeg, 8);
  }

  get cardinal16() {
    return Compass.cardinalOf(this.headingDeg, 16);
  }

  get normalizedDegrees() {
    return Math.round(((this.headingDeg % 360) + 360) % 360);
  }

  get formatted() {
    return `${this.normalizedDegrees}° ${this.cardinal}`;
  }

  /** Set heading angle (degrees, 0 = North, 90 = East, 180 = South, 270 = West). */
  setHeading(deg) {
    const norm = (((deg % 360) + 360) % 360);
    if (Math.abs(this.headingDeg - norm) < 0.05) return;
    this.headingDeg = norm;
    this._updateBoundElements();
    if (this.onChange) this.onChange(this);
  }

  /** Reset camera / compass to default starting North heading. */
  resetNorth() {
    this.setHeading(this.defaultStartHeading);
  }

  /** Bind to an on-screen HUD element (e.g. `#compass`). */
  bindElement(el, { onClickReset = true, showDegrees = false } = {}) {
    if (!el) return;
    const binding = { el, onClickReset, showDegrees };
    this._boundElements.add(binding);
    if (onClickReset) {
      el.addEventListener('click', () => {
        this.resetNorth();
      });
    }
    this._renderElement(binding);
  }

  _updateBoundElements() {
    for (const b of this._boundElements) {
      this._renderElement(b);
    }
  }

  _renderElement({ el, showDegrees }) {
    if (!el || !el.isConnected) return;
    // update text label with dynamic cardinal direction
    const label = el.querySelector('.n, [data-comp-label]');
    if (label) {
      label.textContent = showDegrees ? this.formatted : this.cardinal;
    }
    // update rotating needle
    const needle = el.querySelector('.needle, #compassNeedle, [data-comp-needle]');
    if (needle) {
      needle.style.transform = `rotate(${(-this.headingDeg)}deg)`;
    }
    el.title = `Compass: ${this.formatted} (tap to reset North)`;
    el.setAttribute('aria-label', `Compass: ${this.formatted}, tap to face North`);
  }

  /** High-DPI canvas rendering for map HUD and embedded viewports. */
  renderCanvas(ctx, cx, cy, radius = 12, { dpr = 1, showText = true, theme = null } = {}) {
    const t = theme || this.theme;
    const r = radius * dpr;
    const rad = (this.headingDeg * Math.PI) / 180;
    ctx.save();
    ctx.translate(cx, cy);

    // Subtle dial backdrop
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    ctx.arc(0, 0, r + 2 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(40, 60, 90, 0.2)';
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();

    // Cardinal tick marks
    ctx.strokeStyle = 'rgba(80, 95, 115, 0.5)';
    ctx.lineWidth = 1 * dpr;
    for (let a = 0; a < 4; a++) {
      const ta = a * (Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(Math.cos(ta) * (r - 2.5 * dpr), Math.sin(ta) * (r - 2.5 * dpr));
      ctx.lineTo(Math.cos(ta) * (r + 0.5 * dpr), Math.sin(ta) * (r + 0.5 * dpr));
      ctx.stroke();
    }

    // Rotating Needle (North red, South slate)
    ctx.save();
    ctx.rotate(-rad);

    // North pointer
    ctx.fillStyle = t.needleNorth || '#eb5757';
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.35, -1 * dpr);
    ctx.lineTo(0, -r * 0.25);
    ctx.closePath();
    ctx.fill();

    // South pointer
    ctx.fillStyle = t.needleSouth || '#8798ab';
    ctx.beginPath();
    ctx.moveTo(0, r);
    ctx.lineTo(r * 0.35, 1 * dpr);
    ctx.lineTo(0, r * 0.25);
    ctx.closePath();
    ctx.fill();

    // Center pivot
    ctx.fillStyle = '#2c3e50';
    ctx.beginPath();
    ctx.arc(0, 0, 1.8 * dpr, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    // Dynamic Cardinal label at top (N, NE, E, SE, S, SW, W, NW)
    if (showText) {
      ctx.fillStyle = t.textColor || '#2c3e50';
      ctx.font = `700 ${Math.max(9, Math.round(9 * dpr))}px ${t.font || 'system-ui'}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(this.cardinal, 0, -r - 2 * dpr);
    }

    ctx.restore();
  }

  toJSON() {
    return {
      defaultStartHeading: this.defaultStartHeading,
      headingDeg: this.headingDeg,
      cardinal: this.cardinal,
      formatted: this.formatted,
      mode: this.mode,
    };
  }

  fromJSON(data = {}) {
    if (data.defaultStartHeading != null) this.defaultStartHeading = Number(data.defaultStartHeading) || 0;
    if (data.headingDeg != null) this.setHeading(Number(data.headingDeg) || 0);
    if (data.mode != null) this.mode = data.mode;
    if (data.theme) Object.assign(this.theme, data.theme);
  }
}
