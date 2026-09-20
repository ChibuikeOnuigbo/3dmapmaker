/**
 * Panorama Maps — ui/landing.js
 *
 * Start screen: pick a demo world, or create a world (simple/advanced),
 * or open a .pmap project. Canvas remains loaded behind it; choosing an
 * option simply closes the overlay.
 */
import { DEMO_WORLDS } from '../worlds/demo-worlds.js';

const CARD_ART = {
  demo_chapel_lane: { badge: ['animated', 'Animated · small'], icon: '#i-globe', d: 'A parish lane, a 500 m church zone, and the 8×8 king-move plaza. The continuity demo.' },
  demo_millbrook: { badge: ['animated', 'Animated · medium'], icon: '#i-map', d: 'Riverside market town: branches, shops, mill road, church avenue.' },
  demo_great_vale: { badge: ['big', 'Animated · 1,100+ nodes'], icon: '#i-max', d: 'A whole vale town generated on demand — lazy loading, LRU cache, spatial index.' },
};
const REAL_ART = { badge: ['real', 'AI real · modes'], icon: '#i-camera', d: 'Photorealistic AI panoramas. One parish street in three moods — day, rain, night — toggle live.' };

export class Landing {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('landing');
    this._render();
  }

  get isShown() { return this.el.classList.contains('show'); }

  show() { this._render(); this.el.classList.add('show'); }
  hide() { this.el.classList.remove('show'); }

  _render() {
    const worlds = DEMO_WORLDS.map((w) => {
      const art = w.kind === 'real' ? REAL_ART : CARD_ART[w.id] || CARD_ART.demo_chapel_lane;
      const thumb = w.kind === 'real' && w.thumb
        ? `<div class="thumb" style="background-image:url('${w.thumb}')"><span class="badge real">AI REAL</span></div>`
        : `<div class="thumb art"><svg><use href="${art.icon}"/></svg><span class="badge ${art.badge[0]}">${art.badge[1]}</span></div>`;
      return `<button class="land-card" data-w="${w.id}">
        ${thumb}
        <div class="body">
          <div class="n">${esc(w.name)} <span style="font-weight:500;color:#8a93a8;font-size:12px">· ${w.tag}</span></div>
          <div class="d">${esc(art.d)}</div>
        </div>
      </button>`;
    }).join('');

    this.el.innerHTML = `
      <div class="land-wrap">
        <div class="land-hero">
          <div class="mark"><svg><use href="#i-logo"/></svg></div>
          <div>
            <h1>Panorama Maps</h1>
            <p>Explore connected 360-degree locations on a real 2D map — or build your own world.</p>
          </div>
        </div>

        <div class="land-sec-t">Explore demo worlds</div>
        <div class="land-grid">${worlds}</div>

        <div class="land-sec-t">Create</div>
        <div class="land-row">
          <button class="land-btn primary" data-new="simple"><svg><use href="#i-edit"/></svg>New world — simple editor</button>
          <button class="land-btn" data-new="advanced"><svg><use href="#i-sliders"/></svg>New world — advanced editor</button>
          <button class="land-btn" data-act="open"><svg><use href="#i-open"/></svg>Open a .pmap project</button>
          <button class="land-btn" data-act="resume"><svg><use href="#i-play"/></svg>Continue exploring</button>
        </div>

        <label class="land-ck"><input type="checkbox" id="landHide"> Don't show this screen again</label>
        <div><button class="land-skip" data-act="resume">Skip → enter the current world</button></div>
      </div>`;

    this.el.querySelectorAll('[data-w]').forEach((b) => b.addEventListener('click', () => {
      this._prefs();
      const def = DEMO_WORLDS.find((w) => w.id === b.dataset.w);
      this.hide();
      this.app.loadDemoWorld(def);
    }));
    this.el.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => {
      this._prefs();
      this.hide();
      this.app.createEmptyWorld({ openEditor: b.dataset.new });
    }));
    this.el.querySelectorAll('[data-act="open"]').forEach((b) => b.addEventListener('click', () => {
      this._prefs();
      this.hide();
      this.app.openProject();
    }));
    this.el.querySelectorAll('[data-act="resume"]').forEach((b) => b.addEventListener('click', () => {
      this._prefs();
      this.hide();
    }));
  }

  _prefs() {
    if (this.el.querySelector('#landHide')?.checked) this.app.savePrefs({ hideLanding: true });
  }
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
