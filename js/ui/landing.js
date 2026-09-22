/**
 * Panorama Maps · ui/landing.js
 *
 * Two page start experience inside one overlay:
 *   page HERO   · brand, headline, three primary actions
 *   page DEMOS  · its own page (Explore demos moves the user here) with a
 *                 grid of demo cards carrying LIVE preview thumbnails and a
 *                 back control to the hero page
 * The back button in the topbar re opens the landing at any time, so
 * switching worlds always means: back to landing, pick a demo.
 */
import { DEMO_WORLDS } from '../worlds/demo-worlds.js';
import { GenerationContextBuilder } from '../gen/context.js';

export class Landing {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('landing');
    this._thumbs = new Map();   // demo id → object URL (session only)
    this._render();
  }

  get isShown() { return this.el.classList.contains('show'); }

  show(view = 'hero') {
    this._render();
    this.el.classList.add('show');
    document.body.classList.add('landing-open');
    this._view(view);
  }
  hide() { this.el.classList.remove('show'); document.body.classList.remove('landing-open'); }

  _view(name) {
    this.el.querySelectorAll('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== name; });
    if (name === 'demos') this._buildDemos();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    this.el.querySelector('[data-view="hero"]')?.scrollTo?.(0, 0);
    if (!reduced) this.el.querySelector(`[data-view="${name}"]`)?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
  }

  /* ---------------- hero page ---------------- */
  _render() {
    this.el.innerHTML = `
      <picture class="land-bg" aria-hidden="true"><img src="assets/landing-bg.jpg" alt=""></picture>
      <div class="land-scrim" aria-hidden="true"></div>

      <div class="land-view" data-view="hero">
        <div class="land-wrap">
          <header class="land-brand">
            <span class="mark"><svg><use href="#i-logo"/></svg></span>
            <span class="word">Panorama&nbsp;Maps</span>
          </header>

          <main class="land-center">
            <h1>Walk connected worlds<br><em>in full 360</em>.</h1>
            <p class="tag">Every place is a node on a real 2D map. Step forward with WASD, a double click, or the pad and the next panorama is predicted from where you stand, so one world stays one world.</p>

            <div class="land-cta">
              <button class="land-btn primary lg" data-act="demos"><svg><use href="#i-globe"/></svg>Explore demos<svg class="arr"><use href="#i-right"/></svg></button>
              <button class="land-btn lg" data-act="create"><svg><use href="#i-plus"/></svg>Create a world</button>
              <button class="land-btn lg" data-act="open"><svg><use href="#i-open"/></svg>Open project</button>
            </div>

            <button class="land-skip" data-act="resume">Continue where I left off<svg class="arrow"><use href="#i-right"/></svg></button>
          </main>
        </div>
      </div>

      <div class="land-view" data-view="demos" hidden>
        <div class="land-wrap">
          <header class="land-demobar">
            <button class="land-back" data-act="back" aria-label="Back" title="Back"><svg><use href="#i-left"/></svg></button>
            <div class="dl">
              <h2>Explore demos</h2>
              <p>Pick a world to walk. Every demo opens as a real, connected map.</p>
            </div>
          </header>
          <div class="land-grid" id="landDemos"></div>
        </div>
      </div>

      <div class="land-pop-host" id="landPopHost"></div>`;

    const on = (sel, fn) => this.el.querySelector(sel)?.addEventListener('click', fn);
    on('[data-act="demos"]', () => this._view('demos'));
    on('[data-act="back"]', () => this._view('hero'));
    on('[data-act="create"]', () => this._choice({ what: 'create' }));
    on('[data-act="open"]', () => { this.hide(); this.app.openProject(); });
    on('[data-act="resume"]', () => { this.hide(); });
  }

  /* ---------------- demos page: grid with live previews ---------------- */
  _buildDemos() {
    const host = this.el.querySelector('#landDemos');
    if (!host || host.dataset.built === '1') return;
    host.dataset.built = '1';
    host.innerHTML = DEMO_WORLDS.map((w) => `
      <button class="land-card" data-w="${w.id}" aria-label="Open ${esc(w.name)}">
        <div class="thumb" data-thumb="${w.id}">
          ${w.kind === 'real' && w.thumb
            ? `<img src="${w.thumb}" alt="" loading="lazy"><span class="badge real">AI REAL</span>`
            : `<div class="thumb-spin"><div class="spinner"></div></div><span class="badge">ANIM</span>`}
        </div>
        <div class="body"><div class="n">${esc(w.name)}</div><div class="d">${esc(shortDesc(w))}</div></div>
      </button>`).join('');
    host.querySelectorAll('[data-w]').forEach((b) => b.addEventListener('click', () => {
      this._choice({ what: 'demo', def: DEMO_WORLDS.find((w) => w.id === b.dataset.w) });
    }));
    // generate real previews for the animated demos (async, once per session)
    for (const w of DEMO_WORLDS) {
      if (w.kind === 'real') continue;
      const slot = host.querySelector(`[data-thumb="${w.id}"]`);
      this._thumb(w).then((url) => {
        if (!url || !slot || !this.el.contains(slot)) { if (slot) return; }
        const badge = slot.querySelector('.badge');
        slot.querySelector('.thumb-spin')?.replaceWith(Object.assign(document.createElement('img'), { src: url, alt: '' }));
        if (badge) slot.appendChild(badge);
      });
    }
  }

  /* Render a small live preview of a procedural demo world using the SAME
     renderer the app itself uses; the preview is always honest. */
  async _thumb(def) {
    if (this._thumbs.has(def.id)) return this._thumbs.get(def.id);
    this._thumbs.set(def.id, null);   // in flight
    try {
      const w = def.build();
      const nodeId = w.startNodeId ?? [...w.graph.nodes.keys()][0];
      const node = w.graph.getNode(nodeId);
      const builder = this.app.ctxBuilder ?? new GenerationContextBuilder(w.graph, this.app.cache);
      const context = builder.build({
        targetNodeId: nodeId,
        camera: { yawDeg: node.headingDeg ?? 0, pitchDeg: 0, fovDeg: 75, height: node.camera?.height ?? 1.7 },
      });
      const { canvas } = await this.app.provider.generate(node, context, {
        world: { id: w.graph.id, environment: w.graph.environment },
        scale: w.graph.scale,
        groundResolution: this.app._groundRes,
      });
      const thumbs = document.createElement('canvas');
      thumbs.width = 640; thumbs.height = 320;
      thumbs.getContext('2d').drawImage(canvas, 0, 0, 640, 320);
      const url = await new Promise((r) => thumbs.toBlob((b) => r(b ? URL.createObjectURL(b) : null), 'image/jpeg', 0.72));
      this._thumbs.set(def.id, url);
      return url;
    } catch { this._thumbs.delete(def.id); return null; }
  }

  /* ---------------- studio choice popup ---------------- */
  _choice({ what, def = null }) {
    const host = this.el.querySelector('#landPopHost');
    host.innerHTML = `
      <div class="land-pop-backdrop" data-x="1">
        <div class="land-pop" role="dialog" aria-modal="true" aria-label="Choose how to open">
          <div class="lp-head">
            <h3>${what === 'create' ? 'New blank world' : esc(def?.name || 'Demo world')}</h3>
            <p>${what === 'create' ? 'Pick a studio to start building in.' : 'Open it in the studio that fits the job.'}</p>
          </div>
          <div class="lp-stack">
            <button class="lp-opt" data-go="simple"><span class="li"><svg><use href="#i-edit"/></svg></span><span class="lt">Simple studio</span></button>
            <button class="lp-opt primary" data-go="advanced"><span class="li"><svg><use href="#i-sliders"/></svg></span><span class="lt">Advanced studio</span></button>
          </div>
          <div class="lp-foot"><button class="lp-cancel" data-go="cancel">Cancel</button></div>
        </div>
      </div>`;
    host.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', async () => {
      const go = b.dataset.go;
      host.innerHTML = '';
      if (go === 'cancel') return;
      this.hide();
      if (what === 'create') {
        this.app.setStudio(go, { open: false });
        this.app.createEmptyWorld({ openEditor: go });
      } else {
        this.app.setStudio(go, { open: false });
        await this.app.loadDemoWorld(def);
        this.app.togglePanel(go === 'advanced' ? 'adv' : 'simple');
      }
    }));
    host.querySelector('[data-x]')?.addEventListener('click', (e) => {
      if (e.target.dataset.x) host.innerHTML = '';
    });
    host.querySelector('.land-pop')?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); host.innerHTML = ''; }
    });
    host.querySelector('.lp-opt')?.focus({ preventScroll: true });
  }
}

function shortDesc(w) {
  switch (w.id) {
    case 'demo_chapel_lane': return 'Parish lane, 500 m church zone';
    case 'demo_millbrook': return 'Market town, bridges, branches';
    case 'demo_great_vale': return 'A full town, over one thousand places';
    default: return 'A whole AI village · green, forge, school, orchard';
  }
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
