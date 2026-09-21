/**
 * Panorama Maps — ui/landing.js
 *
 * Start hero. A real scene backdrop (a demo panorama, locally generated
 * asset), a brand row, a single clear headline, primary actions, and the
 * demo rail. Nothing decorative-only: every control does something.
 *
 *   Explore demos        → demo rail with LIVE preview thumbnails
 *   Create a world       → studio choice popup (Simple or Advanced)
 *   Open project         → import a .pmap
 *   Continue where I left off → straight back to the last world
 * Landing re appears from the back button in the toolbar at any time.
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

  show() { this._render(); this.el.classList.add('show'); document.body.classList.add('landing-open'); }
  hide() { this.el.classList.remove('show'); document.body.classList.remove('landing-open'); }

  /* ---------------- base screen ---------------- */
  _render() {
    this.el.innerHTML = `
      <picture class="land-bg" aria-hidden="true"><img src="assets/willow/day/n1.jpg" alt=""></picture>
      <div class="land-scrim" aria-hidden="true"></div>

      <div class="land-wrap">
        <header class="land-brand">
          <span class="mark"><svg><use href="#i-logo"/></svg></span>
          <span class="word">Panorama&nbsp;Maps</span>
          <span class="v">v0.3</span>
        </header>

        <main class="land-center">
          <h1>Walk connected worlds<br><em>in full 360</em>.</h1>
          <p class="tag">Every place is a node on a real 2D map. Step forward with WASD, a double click, or the pad and the next panorama is predicted from where you stand — one world stays one world.</p>

          <div class="land-cta">
            <button class="land-btn primary lg" data-act="demos"><svg><use href="#i-globe"/></svg>Explore demos</button>
            <button class="land-btn lg" data-act="create"><svg><use href="#i-plus"/></svg>Create a world</button>
            <button class="land-btn lg" data-act="open"><svg><use href="#i-open"/></svg>Open project</button>
          </div>

          <button class="land-skip" data-act="resume">Continue where I left off<span class="arrow">→</span></button>

          <div class="land-grid" id="landDemos" hidden></div>
        </main>

        <div class="land-pop-host" id="landPopHost"></div>
      </div>`;

    const on = (sel, fn) => this.el.querySelector(sel)?.addEventListener('click', fn);
    on('[data-act="demos"]', () => this._demos());
    on('[data-act="create"]', () => this._choice({ what: 'create' }));
    on('[data-act="open"]', () => { this._prefs(); this.hide(); this.app.openProject(); });
    on('[data-act="resume"]', () => { this._prefs(); this.hide(); });
  }

  _prefs() {
    if (this.el.querySelector('#landHide')?.checked) this.app.savePrefs({ hideLanding: true });
  }

  /* ---------------- demo rail with live previews ---------------- */
  _demos() {
    const host = this.el.querySelector('#landDemos');
    host.hidden = !host.hidden;
    if (host.hidden) { this.el.querySelector('.land-cta [data-act="demos"]')?.classList.remove('active'); return; }
    this.el.querySelector('.land-cta [data-act="demos"]')?.classList.add('active');
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
     renderer the app itself uses — the preview is always honest. */
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
        <div class="land-pop" role="dialog" aria-modal="true" aria-label="Choose how to open" onclick="event.stopPropagation()">
          <h3>${what === 'create' ? 'New blank world' : esc(def?.name || 'Demo world')}</h3>
          <p>${what === 'create' ? 'Pick a studio to start building in.' : 'Explore it as a viewer, or open it in a studio.'}</p>
          <div class="land-pop-row">
            ${what === 'demo' ? `<button class="land-btn" data-go="view"><svg><use href="#i-play"/></svg>Just explore</button>` : ''}
            <button class="land-btn" data-go="simple"><svg><use href="#i-edit"/></svg>Simple studio</button>
            <button class="land-btn primary" data-go="advanced"><svg><use href="#i-sliders"/></svg>Advanced studio</button>
          </div>
          <button class="land-skip" data-go="cancel">Cancel</button>
        </div>
      </div>`;
    host.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', async () => {
      const go = b.dataset.go;
      host.innerHTML = '';
      if (go === 'cancel') return;
      this._prefs();
      this.hide();
      if (what === 'create') {
        this.app.setStudio(go, { open: false });
        this.app.createEmptyWorld({ openEditor: go });
      } else {
        const g = go === 'simple' || go === 'advanced' ? go : null;
        if (g) this.app.setStudio(g, { open: false });
        await this.app.loadDemoWorld(def);
        if (g) this.app.togglePanel(g === 'advanced' ? 'adv' : 'simple');
      }
    }));
    host.querySelector('[data-x]')?.addEventListener('click', (e) => {
      if (e.target.dataset.x) host.innerHTML = '';
    });
  }
}

function shortDesc(w) {
  switch (w.id) {
    case 'demo_chapel_lane': return 'Parish lane, 500 m church zone';
    case 'demo_millbrook': return 'Market town, bridges, branches';
    case 'demo_great_vale': return 'A full town, over one thousand places';
    default: return 'One real street · day, rain, night';
  }
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
