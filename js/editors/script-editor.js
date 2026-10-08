/**
 * Panorama Maps — editors/script-editor.js
 *
 * Scripting studio: Unreal-Blueprint-style graph editing for panorama
 * worlds (Spec-adjacent, additive). Two modes in ONE shell:
 *
 *   VISUAL — every panorama node is a NodeCard on an infinite graph
 *     canvas. Cards have four WASD direction sockets (like typed pins);
 *     drag socket → card to connect an edge (a "wire"), click a wire to
 *     disconnect. Each card carries a collapsible panorama thumbnail, a
 *     ▶ fullscreen preview button, and an image-assign button. Positions,
 *     distances, bearings and socket mappings are AUTO-CALCULATED from the
 *     WorldGraph — the Details dock only exposes what makes sense to edit.
 *
 *   CODE — a plain-text view of the same graph (nodes/edges JSON). Apply
 *     runs structural validation, then DIFF-APPLIES changes onto the live
 *     graph (move / add / remove / connect / disconnect) — never a blind
 *     replace. Visual and Code views stay in sync: switching modes
 *     re-serializes; applying re-renders the graph.
 *
 * OOP map (single responsibility classes, the "structure" the user reads):
 *   ScriptStudio   – shell, mode switch, stats, toolbar                 [exported]
 *   GraphCanvas    – pan/zoom surface, culling, compact zoom, add-node
 *   NodeCardView   – DOM card for one WorldGraph node (thumb/sockets)
 *   WireLayer      – bezier wires, drag-to-connect, click-to-unlink
 *   DetailsPanel   – right dock: editable name/heading, auto readouts
 *   CodeView       – JSON text mode with validate + diff-apply
 *   PreviewModal   – fullscreen equirect preview (PanoRenderer, WASD chips)
 *
 * Pure helpers (DOM-free, unit-tested from tests/core.test.mjs):
 *   SOCKETS, dirSocket, socketWorldBearing, socketAssign,
 *   serializeGraphSubset, applyGraphSubset
 *
 * Module must stay DOM-FREE at top level — Node imports it in tests.
 */
import { angleDelta, generateId } from '../core/world-graph.js';
import { validateWorldJson } from '../io/storage.js';

/* Node-card size rules: every card lives between these bounds; the user can
   resize within them via the corner grip (world px, scaled by the view).
   Defaults match the long-standing 232-wide card; height defaults to the
   card's natural content height. */
export const CARD_W_DEF = 232;
export const CARD_MIN = { w: 220, h: 200 };
export const CARD_MAX = { w: 560, h: 600 };
export function clampCard(v, lo, hi) { return Math.min(hi, Math.max(lo, Math.round(v))); }
// PanoRenderer is dynamically imported by PreviewModal (browser-only),
// so this module stays importable from Node in the unit tests.

/* ================================================================== */
/* Pure helpers — the directional-socket model (W/A/S/D per point)     */
/* ================================================================== */

/** The four per-point direction sockets, like typed pins. */
export const SOCKETS = [
  { key: 'W', relDeg: 0,    label: 'forward' },
  { key: 'D', relDeg: 90,   label: 'right'   },
  { key: 'A', relDeg: -90,  label: 'left'    },
  { key: 'S', relDeg: 180,  label: 'back'    },
];

/**
 * Which socket does a relative bearing belong to?
 * rel = signed delta from the node's heading, in (-180, 180].
 * Each socket owns a 90° sector centered on its relDeg.
 */
export function dirSocket(relDeg) {
  let d = ((relDeg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  if (d <= -135 || d > 135) return 'S';
  if (d > 45) return 'D';
  if (d < -45) return 'A';
  return 'W';
}

/** World bearing a socket points at, given the node heading. */
export function socketWorldBearing(socketKey, headingDeg = 0) {
  const s = SOCKETS.find(x => x.key === socketKey);
  if (!s) throw new Error(`unknown socket ${socketKey}`);
  return ((headingDeg + s.relDeg) % 360 + 360) % 360;
}

/**
 * Map every edge of a node into its socket sectors.
 * @returns {{W:edge|null, A:edge|null, S:edge|null, D:edge|null, unslotted:edge[]}}
 */
export function socketAssign(graph, nodeId) {
  const node = graph.getNode(nodeId);
  const heading = node?.headingDeg ?? 0;
  const out = { W: null, A: null, S: null, D: null, unslotted: [] };
  for (const e of graph.edges.values()) {
    if (e.a !== nodeId && e.b !== nodeId) continue;
    if (e.blocked) { out.unslotted.push(e); continue; }
    const rel = angleDelta(heading, graph.edgeBearing(e, nodeId));
    const sock = dirSocket(rel);
    if (!out[sock]) out[sock] = e;
    else out.unslotted.push(e);          // two neighbours in one sector
  }
  return out;
}

/**
 * Serialize the graph subset the Code mode edits. Positions rounded to
 * 2dp px for stability; everything else (distances/bearings) is derived.
 */
export function serializeGraphSubset(graph) {
  const nodes = [...graph.nodes.values()]
    .map(n => ({
      id: n.id, x: Math.round(n.x * 100) / 100, y: Math.round(n.y * 100) / 100,
      name: n.name, ...(n.headingDeg ? { headingDeg: n.headingDeg } : {}),
      ...(n.card ? { card: { w: Math.round(n.card.w), h: Math.round(n.card.h) } } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const edges = [...graph.edges.values()]
    .map(e => ({ a: e.a, b: e.b }))
    .sort((x, y) => (x.a + x.b).localeCompare(y.a + y.b, undefined, { numeric: true }));
  return { nodes, edges };
}

/**
 * Diff-apply a code-edited subset onto the LIVE graph.
 * @returns {{added:number, removed:number, moved:number, renamed:number, connected:number, disconnected:number}}
 */
export function applyGraphSubset(graph, data) {
  validateWorldJson(data);                    // structural guard first
  const seen = new Set(data.nodes.map(n => n.id));
  const summary = { added: 0, removed: 0, moved: 0, renamed: 0, resized: 0, connected: 0, disconnected: 0 };

  // remove vanished nodes; their edges cascade — count those as disconnects
  for (const id of [...graph.nodes.keys()]) {
    if (seen.has(id)) continue;
    for (const e of graph.edges.values()) if (e.a === id || e.b === id) summary.disconnected++;
    graph.removeNode(id); summary.removed++;
  }
  // add / move / rename / re-head
  for (const nd of data.nodes) {
    const cur = graph.getNode(nd.id);
    if (!cur) {
      // code-added nodes always start as generated-on-demand — never borrow
      // another node's image paths (a borrowed urlset lies about files)
      graph.addNode({ id: nd.id, x: nd.x, y: nd.y, name: nd.name || nd.id, pano: { kind: 'generated' } });
      summary.added++;
      continue;
    }
    if (Math.abs(cur.x - nd.x) > 0.01 || Math.abs(cur.y - nd.y) > 0.01) {
      graph.moveNode(nd.id, nd.x, nd.y); summary.moved++;
    }
    if (nd.name && cur.name !== nd.name) { cur.name = nd.name; summary.renamed++; }
    if (typeof nd.headingDeg === 'number' && cur.headingDeg !== nd.headingDeg) cur.headingDeg = nd.headingDeg;
    // card display size: apply, clamp, or drop (reset to default)
    if (nd.card && Number.isFinite(nd.card.w) && Number.isFinite(nd.card.h)) {
      const w = clampCard(nd.card.w, CARD_MIN.w, CARD_MAX.w), h = clampCard(nd.card.h, CARD_MIN.h, CARD_MAX.h);
      if (!cur.card || cur.card.w !== w || cur.card.h !== h) { cur.card = { w, h }; summary.resized++; }
    } else if (cur.card) { delete cur.card; summary.resized++; }
  }
  // edges: connect missing, disconnect extras
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const want = new Map();
  for (const e of data.edges) want.set(pairKey(e.a, e.b), e);
  for (const e of [...graph.edges.values()]) {
    const key = pairKey(e.a, e.b);
    if (!want.has(key)) { graph.disconnect(e.a, e.b); summary.disconnected++; }
    else want.delete(key);
  }
  for (const e of want.values()) {
    if (!graph.connect(e.a, e.b)) continue;
    summary.connected++;
  }
  return summary;
}

/* ================================================================== */
/* Small shared bits (browser-side)                                    */
/* ================================================================== */

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
const THUMB_STATE = new Map();   // 'nodeId:variant' -> 'ok' | 'missing' | 'loading'

/** Image URL for a node in the chosen scene variant (day / rain / night). */
function variantUrlOf(node, variant = 'day') {
  const p = node.pano;
  if (!p || p.kind !== 'urlset' || !p.variants) return null;
  return p.variants[variant] || p.variants.day || null;
}

export const VARIANTS = [
  { key: 'day',   label: 'Day',   icon: '#i-sun'  },
  { key: 'rain',  label: 'Rain',  icon: '#i-rain' },
  { key: 'night', label: 'Night', icon: '#i-moon' },
];

/* ================================================================== */
/* NodeCardView — one WorldGraph node as a blueprint-style card        */
/* ================================================================== */

class NodeCardView {
  constructor(owner, node) {
    this.owner = owner;                 // GraphCanvas
    this.node = node;
    this.expanded = true;
    this.el = h('div', 'sg-card');
    this.el.dataset.id = node.id;
    this._build();
    this.sync();
  }

  _build() {
    const b = h;
    this.head = b('div', 'sg-card-head');
    this.head.append(b('span', 'sg-card-name', this.node.name));
    this.head.append(b('span', 'sg-card-id', this.node.id));
    this.head.title = 'Drag to move · click to select';

    // preview strip (toggleable per user request)
    this.thumbWrap = b('div', 'sg-thumb');
    this.img = document.createElement('img');
    this.img.alt = '';
    this.img.loading = 'lazy';
    this.thumbStateEl = b('span', 'sg-thumb-state');
    this.thumbWrap.append(this.img, this.thumbStateEl);
    this.thumbWrap.title = 'Double-click: collapse / expand preview';

    // WASD sockets (typed pins)
    this.socks = {};
    this.sockRow = b('div', 'sg-sockets');
    for (const s of SOCKETS) {
      const sp = b('button', 'sg-sock', s.key);
      sp.dataset.sock = s.key;
      sp.title = `${s.label.toUpperCase()} — drag onto another card to connect`;
      const lab = b('span', 'sg-sock-to', '—');
      sp.append(lab);
      this.socks[s.key] = { el: sp, toLabel: lab };
      this.sockRow.append(sp);
    }

    this.footRow = b('div', 'sg-card-foot');
    this.btnPrev = b('button', 'sg-mini'); this.btnPrev.innerHTML = '<svg><use href="#i-play"/></svg>'; this.btnPrev.title = 'Preview this panorama (fullscreen)'; this.btnPrev.setAttribute('aria-label', 'Preview panorama');
    this.btnImg = b('button', 'sg-mini'); this.btnImg.innerHTML = '<svg><use href="#i-image"/></svg>'; this.btnImg.title = 'Assign / replace day image'; this.btnImg.setAttribute('aria-label', 'Assign image');
    this.btnChild = b('button', 'sg-mini'); this.btnChild.innerHTML = '<svg><use href="#i-plus"/></svg>'; this.btnChild.title = 'Add child node in the heading direction'; this.btnChild.setAttribute('aria-label', 'Add child node');
    this.btnDel = b('button', 'sg-mini danger'); this.btnDel.innerHTML = '<svg><use href="#i-trash"/></svg>'; this.btnDel.title = 'Delete node'; this.btnDel.setAttribute('aria-label', 'Delete node');
    this.footRow.append(this.btnPrev, this.btnImg, this.btnChild, this.btnDel);

    // resize grip — user-controlled card size within the min/max rule
    this.grip = b('div', 'sg-resize');
    this.grip.title = `Drag: resize card (${CARD_MIN.w}×${CARD_MIN.h} … ${CARD_MAX.w}×${CARD_MAX.h}) · double-click: reset size`;
    this.grip.setAttribute('aria-label', 'Resize card');

    this.el.append(this.head, this.thumbWrap, this.sockRow, this.footRow, this.grip);
    this._bind();
  }

  /** Current display size of this card (custom within bounds, else defaults). */
  sizeOf() {
    const c = this.node.card;
    if (c && Number.isFinite(c.w) && Number.isFinite(c.h)) {
      return { w: clampCard(c.w, CARD_MIN.w, CARD_MAX.w), h: clampCard(c.h, CARD_MIN.h, CARD_MAX.h) };
    }
    return { w: CARD_W_DEF, h: this.el.offsetHeight || 250 };
  }

  /** Apply a size to the element immediately (during drag, before commit). */
  applySize(w, h, persist = false) {
    w = clampCard(w, CARD_MIN.w, CARD_MAX.w); h = clampCard(h, CARD_MIN.h, CARD_MAX.h);
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    this.el.classList.add('sized');
    if (persist) this.node.card = { w, h };
  }

  clearSize() {
    delete this.node.card;
    this.el.classList.remove('sized');
    this.el.style.width = '';
    this.el.style.height = '';
  }

  _bind() {
    const n = this.node;
    this.head.addEventListener('pointerdown', (e) => this.owner.startCardDrag(this, e));
    this.el.addEventListener('click', (e) => { e.stopPropagation(); this.owner.studio.select(n.id, { additive: e.shiftKey }); });
    this.thumbWrap.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.expanded = !this.expanded;
      this.el.classList.toggle('mini', !this.expanded);
    });
    for (const [key, s] of Object.entries(this.socks)) {
      s.el.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.owner.studio.wires.startDrag(this, key, e); });
      s.el.addEventListener('click', (e) => e.stopPropagation());
    }
    this.btnPrev.addEventListener('click', (e) => { e.stopPropagation(); this.owner.studio.previewNode(n.id); });
    this.btnImg.addEventListener('click', (e) => { e.stopPropagation(); this.owner.studio.assignImage(n.id); });
    this.btnChild.addEventListener('click', (e) => { e.stopPropagation(); this.owner.addChildNode(n.id); });
    this.btnDel.addEventListener('click', (e) => { e.stopPropagation(); this.owner.deleteNode(n.id); });
    this.img.addEventListener('error', () => this._thumb('missing'));
    this.img.addEventListener('load', () => this._thumb(this.img.naturalWidth > 2 ? 'ok' : 'missing'));
    this.grip.addEventListener('pointerdown', (e) => this.owner.startCardResize(this, e));
    this.grip.addEventListener('dblclick', (e) => { e.stopPropagation(); this.owner.resetCardSize(this); });
    this.grip.addEventListener('click', (e) => e.stopPropagation());
    // focus-hover: unrelated wires dim, link partners ring
    this.el.addEventListener('pointerenter', () => this.owner.wires.applyFocus(n.id));
    this.el.addEventListener('pointerleave', () => this.owner.wires.applyFocus(null));
  }

  _thumb(state) {
    THUMB_STATE.set(`${this.node.id}:${this.owner.studio.variant}`, state);
    this.thumbStateEl.textContent = state === 'ok' ? '' : (state === 'missing' ? 'no image' : '…');
    this.el.classList.toggle('missing', state === 'missing');
    this.el.classList.toggle('loading', state === 'loading');   // drives the shimmer
    this.owner.studio.onThumbState();
  }

  /** Refresh dynamic content from the graph (name/links/thumb position). */
  sync() {
    const g = this.owner.studio.app.graph;
    const n = this.node;
    this.head.firstChild.textContent = n.name;
    this.el.style.left = `${n.x}px`;
    this.el.style.top = `${n.y}px`;
    if (n.card && Number.isFinite(n.card.w) && Number.isFinite(n.card.h)) this.applySize(n.card.w, n.card.h);
    else { this.el.classList.remove('sized'); this.el.style.width = ''; this.el.style.height = ''; }
    const selIds = this.owner.studio.selectedIds;
    this.el.classList.toggle('selected', selIds?.size ? selIds.has(n.id) : this.owner.studio.selectedId === n.id);
    const url = variantUrlOf(n, this.owner.studio.variant);
    const prev = this.img.dataset.src || '';
    if (url && url !== prev) { this.img.dataset.src = url; this._thumb('loading'); this.img.src = url; }
    else if (!url) { this.img.removeAttribute('src'); this.img.dataset.src = ''; this._thumb(n.pano?.kind === 'asset' ? 'ok' : 'missing'); if (n.pano?.kind === 'asset') this.thumbStateEl.textContent = 'asset ✓'; }
    const slots = socketAssign(g, n.id);
    for (const s of SOCKETS) {
      const edge = slots[s.key];
      const sock = this.socks[s.key];
      sock.toLabel.textContent = edge ? oldName(g, edge, n.id) : '—';
      sock.el.classList.toggle('linked', !!edge);
      sock.el.dataset.edge = edge ? edge.id : '';
    }
    const deg = g.edges.values();
    let count = 0; for (const e of deg) if (e.a === n.id || e.b === n.id) count++;
    this.el.classList.toggle('isolated', count === 0);   // isolation rule visual
    this.el.querySelector('.sg-card-id').textContent = `${n.id} · ${count} link${count === 1 ? '' : 's'}`;
  }
}

function oldName(g, edge, fromId) {
  const other = g.getNode(g.otherEnd(edge, fromId));
  return other ? other.name.replace(/\s+/g, ' ').slice(0, 14) : '?';
}

/* ================================================================== */
/* WireLayer — bezier wires between cards                              */
/* ================================================================== */

class WireLayer {
  constructor(canvas) {
    this.canvas = canvas;                 // GraphCanvas
    this.studio = canvas.studio;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'sg-wires');
    this.drag = null;                     // {card, sockKey, path}
  }

  mount() { this.canvas.world.append(this.svg); }

  refresh() {
    const g = this.studio.app.graph;
    this._rectCache = new Map();          // one layout read per card per pass, not per edge
    this.svg.innerHTML = '';
    const frag = document.createDocumentFragment();
    // constant ~12 px of SCREEN space as the click target, whatever the zoom —
    // the 2.6 px visual stroke is decor, not a control
    const hitW = 12 / Math.max(0.18, this.canvas.scale);
    for (const e of g.edges.values()) {
      const a = g.getNode(e.a), b = g.getNode(e.b);
      if (!a || !b) continue;
      const p = this._path(a, b);
      const cls = 'sg-wire' + (e.blocked ? ' blocked' : '') + (e.distM > 20 ? ' long' : '');
      const vis = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      vis.setAttribute('d', p);
      vis.setAttribute('class', cls);
      vis.dataset.a = e.a; vis.dataset.b = e.b;
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('d', p);
      hit.setAttribute('class', 'sg-wire-hit');
      hit.setAttribute('stroke-width', hitW);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${e.a} — ${e.b} · ${e.distM.toFixed(1)} m · click to unlink`;
      hit.append(title);
      hit.addEventListener('click', (ev) => {
        ev.stopPropagation();
        g.disconnect(e.a, e.b);
        this.studio.mutated(`Unlinked ${a.name} — ${b.name}`);
      });
      frag.append(hit, vis);   // adjacent: .sg-wire-hit:hover + .sg-wire drives the glow
    }
    if (this.drag) frag.append(this.drag.path);
    this.svg.append(frag);
  }

  /** Card half-extents (world px) for endpoint clipping; unknown cards fall
      back to the default card size so wires always land on a border. */
  _rectOf(id) {
    const card = this.canvas.cards?.get(id);
    if (card) { const s = card.sizeOf(); return { hw: s.w / 2 + 5, hh: s.h / 2 + 5 }; }
    return { hw: CARD_W_DEF / 2 + 5, hh: 128 };
  }

  _path(a, b, rectA = null, rectB = null) {
    // clip the center→center segment at each card border so the wire visibly
    // connects to the card EDGE (never tunnels underneath it)
    const cache = this._rectCache ?? (this._rectCache = new Map());
    const rectOf = (id) => {
      if (!cache.has(id)) cache.set(id, this._rectOf(id));
      return cache.get(id);
    };
    const ra = rectA ?? rectOf(a.id), rb = rectB ?? rectOf(b.id);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let ax = a.x, ay = a.y, bx = b.x, by = b.y;
    if (len > 1e-6) {
      const tA = Math.min(dx ? ra.hw / Math.abs(dx) : Infinity, dy ? ra.hh / Math.abs(dy) : Infinity, 0.45);
      const tB = Math.min(dx ? rb.hw / Math.abs(dx) : Infinity, dy ? rb.hh / Math.abs(dy) : Infinity, 0.45);
      ax = a.x + dx * tA; ay = a.y + dy * tA;
      bx = b.x - dx * tB; by = b.y - dy * tB;
    }
    // bezier with horizontal tangents (blueprint-style easing)
    const tang = Math.max(40, Math.abs(bx - ax) * 0.5);
    return `M ${ax} ${ay} C ${ax + tang} ${ay}, ${bx - tang} ${by}, ${bx} ${by}`;
  }

  startDrag(card, sockKey, ev) {
    ev.preventDefault();
    if (this.drag) this.cancelDrag();          // one live wire-drag, ever
    const from = card.node;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'sg-wire pending');
    this.drag = { fromId: from.id, sockKey, path, start: { x: from.x, y: from.y }, pointerId: ev.pointerId };
    this.refresh();
    const move = (e2) => {
      // foreign pointer (2nd touch) or a post-cancel leak: never move the wire
      if (!this.drag || e2.pointerId !== this.drag.pointerId) return;
      const w = this.canvas.toWorld(e2.clientX, e2.clientY);
      // pending wire also clips at the source card's border
      this.drag.path.setAttribute('d', this._path(this.drag.start, w, this._rectOf(this.drag.fromId), { hw: 4, hh: 4 }));
      // drop-target ring: the card under the pointer lights up while wiring
      if (!this._dropScan) {
        this._dropScan = requestAnimationFrame(() => {
          this._dropScan = 0;
          const els = (document.elementsFromPoint ? document.elementsFromPoint(e2.clientX, e2.clientY) : []) || [];
          let el = els.map((x) => x?.closest?.('.sg-card')).find(Boolean) || null;
          if (el && this.drag && el.dataset.id === this.drag.fromId) el = null;
          if (this._prevDrop) this._prevDrop.classList.remove('dropok');
          this._prevDrop = el;
          if (this._prevDrop) this._prevDrop.classList.add('dropok');
        });
      }
    };
    const detach = () => {                    // the Esc path can reach this via drag.hDetach
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    const clearDropFx = () => {
      if (this._dropScan) { cancelAnimationFrame(this._dropScan); this._dropScan = 0; }
      if (this._prevDrop) { this._prevDrop.classList.remove('dropok'); this._prevDrop = null; }
    };
    const up = (e2) => {
      // released pointer is not the wiring one — keep wiring
      if (!this.drag || (e2.pointerId !== undefined && e2.pointerId !== this.drag.pointerId)) return;
      detach();
      clearDropFx();
      const els = (document.elementsFromPoint ? document.elementsFromPoint(e2.clientX, e2.clientY)
        : [document.elementFromPoint(e2.clientX, e2.clientY)]) || [];
      // drop onto the topmost CARD under the pointer — a wire crossing in
      // front of the destination card must not eat the connection
      const cardEl = els.map((el) => el?.closest?.('.sg-card')).find(Boolean);
      const drag = this.drag; this.drag = null;
      if (cardEl && cardEl.dataset.id !== drag.fromId) {
        const g = this.studio.app.graph;
        const a = drag.fromId, b = cardEl.dataset.id;
        const na = g.getNode(a), nb = g.getNode(b);
        if (!na || !nb) { /* endpoint vanished mid-drag (undo/reset) — drop quietly */ }
        else {
          // duplicate-link rule: the pair may exist — connecting again is a no-op
          let exists = false;
          for (const e of g.edges.values()) if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) { exists = true; break; }
          if (exists) this.studio.toast(`${na.name} and ${nb.name} are already linked`, 'err');
          else {
            const edge = g.connect(a, b);
            this.studio.mutated(`Linked ${na.name} → ${nb.name} (${edge.distM.toFixed(1)} m, auto)`);
            // link flash on the destination card — the connect is acknowledged
            cardEl.classList.add('linked-flash');
            setTimeout(() => cardEl.classList.remove('linked-flash'), 650);
          }
        }
      }
      this.refresh();
    };
    const cancel = (e2) => {
      // pointercancel (touch stolen by the OS etc.): abort, NEVER connect
      if (!this.drag) return;
      if (e2 && e2.pointerId !== undefined && e2.pointerId !== this.drag.pointerId) return;
      detach();
      clearDropFx();
      this.drag = null;
      this.refresh();
    };
    this.drag.hDetach = detach;               // cancelDrag() detaches too (Esc)
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  /** Cancel a pending socket-wire (Esc etc.) — leaving zero traces. */
  cancelDrag() {
    if (!this.drag) return false;
    this.drag.hDetach?.();
    this.drag = null;
    if (this._dropScan) { cancelAnimationFrame(this._dropScan); this._dropScan = 0; }
    if (this._prevDrop) { this._prevDrop.classList.remove('dropok'); this._prevDrop = null; }
    this.refresh();
    return true;
  }

  /* ---------------- focus-hover ---------------- */
  /** Hovering a card fades the wires that don't touch it and rings the
      link partners — instant neighbourhood readability on dense graphs. */
  applyFocus(id) {
    // pointer sweeps across many cards fire enter/leave per card; coalesce
    // whole-graph passes into at most one per animation frame
    if (this._focusWanted === id) return;
    this._focusWanted = id;
    if (this._focusRaf) return;
    this._focusRaf = requestAnimationFrame(() => { this._focusRaf = 0; this._applyFocusNow(this._focusWanted); });
  }

  _applyFocusNow(id) {
    if (this._focusId === id) return;
    this._focusId = id;
    if (this._focusMates) { for (const el of this._focusMates) el.classList.remove('focusmate'); }
    this._focusMates = [];
    const g = this.studio.app.graph;
    for (const p of this.svg.querySelectorAll('.sg-wire')) {
      const hit = !id || p.dataset.a === id || p.dataset.b === id;
      p.classList.toggle('faded', !hit);
      if (hit && id) {
        const otherId = p.dataset.a === id ? p.dataset.b : p.dataset.a;
        const el = this.canvas.cards?.get(otherId)?.el;
        if (el) { el.classList.add('focusmate'); this._focusMates.push(el); }
      }
    }
  }
}

/* ================================================================== */
/* GraphCanvas — pan/zoom surface hosting cards + wires                */
/* ================================================================== */

class GraphCanvas {
  constructor(studio, hostEl) {
    this.studio = studio;
    this.host = hostEl;
    this.tx = 60; this.ty = 60; this.scale = 0.5;
    this.world = h('div', 'sg-world');
    this.gridLayer = h('div', 'sg-griddots');
    this.world.append(this.gridLayer);
    hostEl.append(this.world);
    this.wires = new WireLayer(this);
    this.wires.mount();
    this.cards = new Map();               // id -> NodeCardView
    this.addArmed = false;
    this.selectArmed = false;
    this._dragging = false;
    this.mini = hostEl.querySelector('.sg-minimap');
    this.zoomPct = hostEl.querySelector('[data-zoompct]');
    this._bind();
    this._bindMini();
    // window/responsive resize re-runs the containment clamp
    new ResizeObserver(() => this._apply()).observe(hostEl);
    this.rebuild();
    requestAnimationFrame(() => this.fit());
  }

  rebuild() {
    for (const c of this.cards.values()) c.el.remove();
    this.cards.clear();
    // entrance waterfall — runs only on structural rebuilds (open/add/undo),
    // and is skipped on huge worlds where 2k concurrent anims would jank
    const nodes = [...this.studio.app.graph.nodes.values()];
    const pop = nodes.length <= 600;
    nodes.forEach((n, i) => {
      const c = new NodeCardView(this, n);
      if (pop) {
        c.el.classList.add('spawn');
        c.el.style.animationDelay = `${Math.min(i, 48) * 10}ms`;
        c.el.addEventListener('animationend', () => { c.el.classList.remove('spawn'); c.el.style.animationDelay = ''; }, { once: true });
      }
      this.cards.set(n.id, c);
      this.world.append(c.el);
    });
    this.sync();
  }

  sync() {
    for (const c of this.cards.values()) c.sync();
    this.wires.refresh();
    this._cull();
  }

  toWorld(cx, cy) {
    const r = this.host.getBoundingClientRect();
    return { x: (cx - r.left - this.tx) / this.scale, y: (cy - r.top - this.ty) / this.scale };
  }

  _bind() {
    const host = this.host;
    // multi-pointer gestures: 1 finger = pan, 2 fingers = pinch-to-zoom
    // (mobile graph navigation — the wheel is desktop-only)
    const pts = new Map();               // pointerId -> {x, y}
    let pan = null, pinch = null;
    const setFromPitch = () => {
      const [p1, p2] = [...pts.values()];
      const r = host.getBoundingClientRect();
      const mx = (p1.x + p2.x) / 2 - r.left, my = (p1.y + p2.y) / 2 - r.top;
      pinch = { d0: Math.max(20, Math.hypot(p2.x - p1.x, p2.y - p1.y)), scale0: this.scale,
                wx: (mx - this.tx) / this.scale, wy: (my - this.ty) / this.scale };
    };
    host.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.sg-card') || e.target.closest('.sg-sock') || e.target.closest('.sg-zoom') || e.target.closest('.sg-minimap') || e.target.closest('.sg-wire') || e.target.closest('.sg-wire-hit')) return;
      if (this.selectArmed && pts.size === 0) { this._startMarquee(e); return; }
      if (this.addArmed) {
        const w = this.toWorld(e.clientX, e.clientY);
        this.studio.placeNode(w);
        this.addArmed = false; host.classList.remove('armed');
        return;
      }
      host.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) { pan = null; setFromPitch(); }
      else if (pts.size === 1) pan = { sx: e.clientX, sy: e.clientY, tx: this.tx, ty: this.ty };
    });
    host.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch) {
        const [p1, p2] = [...pts.values()];
        const r = host.getBoundingClientRect();
        const mx = (p1.x + p2.x) / 2 - r.left, my = (p1.y + p2.y) / 2 - r.top;
        const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        this.scale = Math.min(2.2, Math.max(0.08, pinch.scale0 * (d / pinch.d0)));
        this.tx = mx - pinch.wx * this.scale;
        this.ty = my - pinch.wy * this.scale;
        this._apply();
      } else if (pts.size === 1 && pan) {
        this.tx = pan.tx + (e.clientX - pan.sx);
        this.ty = pan.ty + (e.clientY - pan.sy);
        this._apply();
      }
    });
    const end = (e) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size === 1) {   // pinch ended: resume a jump-free pan on the remaining finger
        const p = [...pts.values()][0];
        pan = { sx: p.x, sy: p.y, tx: this.tx, ty: this.ty };
        pinch = null;
      } else if (pts.size === 0) { pan = null; pinch = null; }
    };
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
    host.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const r = host.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const wx = (mx - this.tx) / this.scale, wy = (my - this.ty) / this.scale;
      this.scale = Math.min(2.2, Math.max(0.08, this.scale * k));
      this.tx = mx - wx * this.scale;
      this.ty = my - wy * this.scale;
      this._apply();
    }, { passive: false });
  }

  _apply() {
    // VIEW CONTAINMENT RULE: the graph can never fully leave the screen.
    // Scale floor ties to the graph's fit-scale, then pan is clamped so the
    // graph bounding box always overlaps the viewport by a safe margin.
    const r = this.host.getBoundingClientRect();
    if (r.width > 10 && r.height > 10) {
      const b = this._worldBounds();
      const fit = Math.min(r.width / (b.x1 - b.x0), r.height / (b.y1 - b.y0));
      const sMin = Math.min(0.5, Math.max(0.02, (isFinite(fit) ? fit : 0.5) * 0.5));
      this.scale = Math.min(2.2, Math.max(Math.min(sMin, 2.2), this.scale));
      const mx = Math.min(140, r.width * 0.15), my = Math.min(140, r.height * 0.15);
      const x0 = this.tx + b.x0 * this.scale, x1 = this.tx + b.x1 * this.scale;
      const y0 = this.ty + b.y0 * this.scale, y1 = this.ty + b.y1 * this.scale;
      if (x1 < mx) this.tx += mx - x1;
      else if (x0 > r.width - mx) this.tx -= x0 - (r.width - mx);
      if (y1 < my) this.ty += my - y1;
      else if (y0 > r.height - my) this.ty -= y0 - (r.height - my);
    }
    this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    this.world.style.setProperty('--s', this.scale);
    // wire hit-targets track the zoom (~constant screen px) — refresh lazily
    if (Math.abs(this.scale - (this._scaleAtWires ?? -1)) > 0.03) { this._scaleAtWires = this.scale; this.scheduleWires(); }
    this.gridLayer.style.backgroundSize = `${80 * this.scale}px ${80 * this.scale}px`;
    this.host.classList.toggle('compact', this.scale < 0.34);   // far out: dots, near: cards
    if (this.zoomPct) this.zoomPct.textContent = `${Math.round(this.scale * 100)}%`;
    this._cull();
    this._miniDraw();
  }

  _worldBounds() {
    const g = this.studio.app.graph;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of g.nodes.values()) {
      if (n.x < x0) x0 = n.x; if (n.x > x1) x1 = n.x;
      if (n.y < y0) y0 = n.y; if (n.y > y1) y1 = n.y;
    }
    if (!isFinite(x0)) return { x0: 0, y0: 0, x1: 1, y1: 1 };
    const pad = 140;
    return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  }

  _bindMini() {
    if (!this.mini) return;
    const goto = (e) => {
      const b = this._worldBounds();
      const r = this.mini.getBoundingClientRect();
      const kx = (b.x1 - b.x0) / r.width, ky = (b.y1 - b.y0) / r.height;
      const k = Math.max(kx, ky);
      const ox = (r.width - (b.x1 - b.x0) / k) / 2, oy = (r.height - (b.y1 - b.y0) / k) / 2;
      const wx = b.x0 + (e.clientX - r.left - ox) * k;
      const wy = b.y0 + (e.clientY - r.top - oy) * k;
      const hr = this.host.getBoundingClientRect();
      this.tx = hr.width / 2 - wx * this.scale;
      this.ty = hr.height / 2 - wy * this.scale;
      this._apply();
    };
    this.mini.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      this.mini.setPointerCapture?.(e.pointerId);
      goto(e);
      const pid = e.pointerId;
      const move = (e2) => { if (e2.pointerId === pid) goto(e2); };
      const end = (e2) => {
        if (e2 && e2.pointerId !== undefined && e2.pointerId !== pid) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
  }

  /** Whole-graph overview in the corner: edges as hairlines, nodes as
      dots, the live viewport as a rectangle (graph-UX navigation aid). */
  _miniDraw() {
    if (!this.mini || this._miniQueued) return;
    this._miniQueued = true;
    requestAnimationFrame(() => {
      this._miniQueued = false;
      const mm = this.mini;
      if (!mm.clientWidth || !mm.clientHeight) return;      // hidden
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = mm.clientWidth, H = mm.clientHeight;
      if (mm.width !== Math.round(W * dpr)) { mm.width = Math.round(W * dpr); mm.height = Math.round(H * dpr); }
      const ctx = mm.getContext('2d');
      const g = this.studio.app.graph;
      const b = this._worldBounds();
      const k = Math.max((b.x1 - b.x0) / W, (b.y1 - b.y0) / H);
      const ox = (W - (b.x1 - b.x0) / k) / 2, oy = (H - (b.y1 - b.y0) / k) / 2;
      const px = (n) => [ox + (n.x - b.x0) / k, oy + (n.y - b.y0) / k];
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = '#3a4a63'; ctx.lineWidth = 0.7;
      ctx.beginPath();
      for (const e of g.edges.values()) {
        const a = g.getNode(e.a), c = g.getNode(e.b);
        if (!a || !c) continue;
        const [ax, ay] = px(a), [cx, cy] = px(c);
        ctx.moveTo(ax, ay); ctx.lineTo(cx, cy);
      }
      ctx.stroke();
      ctx.fillStyle = '#59b0ff';
      for (const n of g.nodes.values()) { const [x, y] = px(n); ctx.fillRect(x - 1.1, y - 1.1, 2.2, 2.2); }
      const sel = g.getNode(this.studio.selectedId);
      if (sel) { const [x, y] = px(sel); ctx.fillStyle = '#ffb469'; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill(); }
      // live viewport rectangle
      const hr = this.host.getBoundingClientRect();
      const vx0 = (-this.tx) / this.scale, vy0 = (-this.ty) / this.scale;
      const vx1 = (hr.width - this.tx) / this.scale, vy1 = (hr.height - this.ty) / this.scale;
      const rx = ox + (vx0 - b.x0) / k, ry = oy + (vy0 - b.y0) / k;
      const rw = (vx1 - vx0) / k, rh = (vy1 - vy0) / k;
      ctx.fillStyle = 'rgba(79,141,255,.10)';
      ctx.strokeStyle = 'rgba(79,141,255,.85)'; ctx.lineWidth = 1.2;
      ctx.fillRect(rx, ry, rw, rh); ctx.strokeRect(rx, ry, rw, rh);
    });
  }

  /** Viewport culling — 637 nodes stay smooth ("all panoramas visible no matter how much"). */
  _cull() {
    const r = this.host.getBoundingClientRect();
    const inv = 1 / this.scale, pad = 240 * inv;
    const x0 = (-this.tx) * inv - pad, y0 = (-this.ty) * inv - pad;
    const x1 = (r.width - this.tx) * inv + pad, y1 = (r.height - this.ty) * inv + pad;
    for (const c of this.cards.values()) {
      const n = c.node;
      c.el.style.display = (n.x < x0 || n.x > x1 || n.y < y0 || n.y > y1) ? 'none' : '';
    }
    this.wires.svg.style.display = this.scale < 0.14 ? 'none' : '';
  }

  fit() {
    const g = this.studio.app.graph;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of g.nodes.values()) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
    if (!isFinite(minX)) return;
    const r = this.host.getBoundingClientRect();
    const w = Math.max(60, maxX - minX + 320), hh = Math.max(60, maxY - minY + 240);
    this.scale = Math.min(1.2, Math.max(0.08, Math.min(r.width / w, r.height / hh)));
    this.tx = r.width / 2 - (minX - 160 + (w) / 2) * this.scale;
    this.ty = r.height / 2 - (minY - 120 + (hh) / 2) * this.scale;
    this._apply();
  }

  /** Button-zoom: same math as the wheel, but anchored to the viewport
      center (used by the on-surface ＋/− controls — visible zoom controls). */
  zoomBy(k) {
    const r = this.host.getBoundingClientRect();
    const mx = r.width / 2, my = r.height / 2;
    const wx = (mx - this.tx) / this.scale, wy = (my - this.ty) / this.scale;
    this.scale = Math.min(2.2, Math.max(0.08, this.scale * k));
    this.tx = mx - wx * this.scale;
    this.ty = my - wy * this.scale;
    this._apply();
  }

  centerOn(id) {
    const n = this.studio.app.graph.getNode(id);
    if (!n) return;
    const r = this.host.getBoundingClientRect();
    const s = Math.max(this.scale, 0.55);
    this.scale = s;
    this.tx = r.width / 2 - n.x * s;
    this.ty = r.height / 2 - n.y * s;
    this._apply();
  }

  /** Rubber-band multi-select (Select mode): drag a rectangle over empty
      space — enclosed cards join the selection with live highlight. */
  _startMarquee(e) {
    e.preventDefault(); e.stopPropagation();
    const host = this.host, hr = host.getBoundingClientRect();
    const ax = e.clientX - hr.left, ay = e.clientY - hr.top;
    if (this._marqueeActive) return;                 // single rubber band at a time
    this._marqueeActive = true;
    const rect = h('div', 'sg-marquee');
    host.append(rect);
    let moved = 0, hits = [];
    const apply = (bx, by) => {
      const x0 = Math.min(ax, bx), y0 = Math.min(ay, by), x1 = Math.max(ax, bx), y1 = Math.max(ay, by);
      rect.style.cssText = `left:${x0}px; top:${y0}px; width:${x1 - x0}px; height:${y1 - y0}px;`;
      moved = Math.max(moved, (x1 - x0) + (y1 - y0));
      const w0 = this.toWorld(hr.left + x0, hr.top + y0), w1 = this.toWorld(hr.left + x1, hr.top + y1);
      hits = [];
      for (const [id, c] of this.cards) {
        const inside = c.node.x >= w0.x && c.node.x <= w1.x && c.node.y >= w0.y && c.node.y <= w1.y;
        c.el.classList.toggle('willselect', inside);
        if (inside) hits.push(id);
      }
    };
    const pid = e.pointerId;                 // only THIS pointer steers the band
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      this._marqueeActive = false;           // cancel must also release the guard
      rect.remove();
      for (const c of this.cards.values()) c.el.classList.remove('willselect');
    };
    const move = (e2) => { if (e2.pointerId === pid) apply(e2.clientX - hr.left, e2.clientY - hr.top); };
    const up = (e2) => {
      if (e2.pointerId !== pid) return;      // other fingers lifting: not ours
      const final = hits.slice();
      cleanup();
      if (moved < 6) { this.studio.select(null); this.studio.setSelectArmed(false); return; }   // tap = clear selection
      this.studio.selectMany(final);
      if (final.length) this.studio.toast(`${final.length} node${final.length === 1 ? '' : 's'} selected`, 'ok', 1500);
      else this.studio.toast('Nothing inside the selection box', 'err', 1400);
      // one-shot like add-node: the tool switches back to pan after use
      this.studio.setSelectArmed(false);
    };
    // pointercancel (touch stolen mid-band): abort cleanly — no selection,
    // and the single-band guard is released so Select keeps working
    const cancel = (e2) => {
      if (e2 && e2.pointerId !== undefined && e2.pointerId !== pid) return;
      cleanup();
      this.studio.setSelectArmed(false);
    };
    apply(ax, ay);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  /** rAF-coalesced wire refresh — full SVG rebuilds are expensive on dense
      graphs, so drag/zoom loops schedule at most one rebuild per frame. */
  scheduleWires() {
    if (this._wiresRaf) return;
    this._wiresRaf = requestAnimationFrame(() => { this._wiresRaf = 0; this.wires.refresh(); });
  }

  startCardDrag(card, e) {
    e.preventDefault(); e.stopPropagation();
    const g = this.studio.app.graph;
    card.el.classList.add('dragging');         // hover-lift would desync the wires
    const start = this.toWorld(e.clientX, e.clientY);
    const orig = { x: card.node.x, y: card.node.y };
    const clampW = (v) => Math.min(20000, Math.max(-20000, v));   // work-area rule
    // magnetic alignment: candidate axes of every OTHER node, snap within
    // ~6 screen px, and show a guide line through the aligned pair(s)
    const others = [...g.nodes.values()].filter((n) => n.id !== card.node.id);
    // group drag: a selected card dragged inside a multi-selection moves the
    // WHOLE group by the same world delta (one history entry on release)
    const group = (this.studio.selectedIds?.size > 1 && this.studio.selectedIds.has(card.node.id))
      ? [...this.studio.selectedIds].filter((id) => id !== card.node.id)
          .map((id) => ({ id, ox: g.getNode(id)?.x, oy: g.getNode(id)?.y }))
          .filter((it) => it.ox !== undefined)
      : [];
    // magnetic axes exclude OTHER group members (they travel together)
    const nonGroup = others.filter((o) => !this.studio.selectedIds?.has(o.id));
    const xAxes = [...new Set(nonGroup.map((n) => n.x))];
    const yAxes = [...new Set(nonGroup.map((n) => n.y))];
    // guide spans precomputed once per drag — the move loop must not refilter
    // the whole node set per pointer frame (hot on 2k-node graphs)
    const spanX = new Map(), spanY = new Map();
    for (const o of nonGroup) {
      (spanX.get(o.x) ?? spanX.set(o.x, []).get(o.x)).push(o.y);
      (spanY.get(o.y) ?? spanY.set(o.y, []).get(o.y)).push(o.x);
    }
    this._guides = this._guides || h('div', 'sg-guides');
    if (!this._guides.isConnected) this.world.append(this._guides);
    const nearest = (axes, v, tol) => {
      let best = null, bd = tol;
      for (const a of axes) { const d = Math.abs(a - v); if (d <= bd) { bd = d; best = a; } }
      return best;
    };
    const pid = e.pointerId;
    const move = (e2) => {
      if (e2.pointerId !== pid) return;      // other fingers don't steer the drag
      const w = this.toWorld(e2.clientX, e2.clientY);
      let nx = clampW(orig.x + (w.x - start.x)), ny = clampW(orig.y + (w.y - start.y));
      const tol = 6 / Math.max(0.08, this.scale);
      const gx = nearest(xAxes, nx, tol), gy = nearest(yAxes, ny, tol);
      if (gx !== null) nx = gx;
      if (gy !== null) ny = gy;
      g.moveNode(card.node.id, nx, ny);
      card.el.style.left = `${card.node.x}px`; card.el.style.top = `${card.node.y}px`;
      if (group.length) {
        const dx = nx - orig.x, dy = ny - orig.y;
        for (const it of group) {
          g.moveNode(it.id, clampW(it.ox + dx), clampW(it.oy + dy));
          const c = this.cards.get(it.id);
          if (c) { c.el.style.left = `${clampW(it.ox + dx)}px`; c.el.style.top = `${clampW(it.oy + dy)}px`; }
        }
      }
      const sx = gx !== null ? spanX.get(gx) : null, sy = gy !== null ? spanY.get(gy) : null;
      this._showGuides([
        gx !== null ? { axis: 'v', at: gx, from: Math.min(ny, ...sx), to: Math.max(ny, ...sx) } : null,
        gy !== null ? { axis: 'h', at: gy, from: Math.min(nx, ...sy), to: Math.max(nx, ...sy) } : null,
      ].filter(Boolean));
      this.scheduleWires();
    };
    const detach = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    const up = (e2) => {
      if (e2 && e2.pointerId !== pid) return;
      detach();
      this._showGuides(null);
      // tidy rule: drop lands on a 5 px grid (positions stay arrangeable)
      g.moveNode(card.node.id, Math.round(card.node.x / 5) * 5, Math.round(card.node.y / 5) * 5);
      for (const it of group) {
        const n = g.getNode(it.id);
        if (n) g.moveNode(it.id, Math.round(n.x / 5) * 5, Math.round(n.y / 5) * 5);
      }
      this.studio.mutated(group.length ? `Moved ${group.length + 1} nodes` : `Moved ${card.node.name}`);
      card.el.classList.remove('dragging');
    };
    // pointercancel (touch stolen mid-drag): restore pre-drag positions EXACTLY,
    // no history entry — an aborted gesture must leave the graph untouched
    const cancel = (e2) => {
      if (e2 && e2.pointerId !== undefined && e2.pointerId !== pid) return;
      detach();
      g.moveNode(card.node.id, orig.x, orig.y);
      card.el.style.left = `${orig.x}px`; card.el.style.top = `${orig.y}px`;
      for (const it of group) {
        g.moveNode(it.id, it.ox, it.oy);
        const c = this.cards.get(it.id);
        if (c) { c.el.style.left = `${it.ox}px`; c.el.style.top = `${it.oy}px`; }
      }
      this._showGuides(null);
      this.wires.refresh();
      card.el.classList.remove('dragging');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  /** Alignment guide lines while card-dragging (world coords, zoom-safe width). */
  _showGuides(list) {
    const gl = this._guides;
    if (!gl) return;
    gl.innerHTML = '';
    if (!list || !list.length) return;
    const thick = Math.max(1, 1.6 / Math.max(0.08, this.scale));
    const pad = 320 / Math.max(0.08, this.scale);
    for (const g of list) {
      const d = h('div', 'sg-guide');
      if (g.axis === 'v') {
        d.style.cssText = `left:${g.at - thick / 2}px; top:${g.from - pad}px; width:${thick}px; height:${(g.to - g.from) + 2 * pad}px;`;
      } else {
        d.style.cssText = `left:${g.from - pad}px; top:${g.at - thick / 2}px; height:${thick}px; width:${(g.to - g.from) + 2 * pad}px;`;
      }
      gl.append(d);
    }
  }

  /** Corner-grip resize of a node card, clamped to the min/max size rule.
      Preview applies live (wires follow), commit happens on release with a
      5 px snap — one history entry per resize gesture. */
  startCardResize(card, e) {
    e.preventDefault(); e.stopPropagation();
    const start = this.toWorld(e.clientX, e.clientY);
    const orig = card.sizeOf();
    let dw = 0, dh = 0;
    const pid = e.pointerId;
    const move = (e2) => {
      if (e2.pointerId !== pid) return;
      const w = this.toWorld(e2.clientX, e2.clientY);
      dw = w.x - start.x; dh = w.y - start.y;
      card.applySize(orig.w + dw, orig.h + dh);
      this.scheduleWires();
    };
    const detach = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    const up = (e2) => {
      if (e2 && e2.pointerId !== pid) return;
      detach();
      const w = Math.round((orig.w + dw) / 5) * 5, h = Math.round((orig.h + dh) / 5) * 5;
      card.applySize(w, h, true);
      this.wires.refresh();
      this.studio.mutated(`Resized ${card.node.name} to ${clampCard(w, CARD_MIN.w, CARD_MAX.w)}×${clampCard(h, CARD_MIN.h, CARD_MAX.h)}`);
    };
    // cancelled resize snaps the card back to its original size, no history
    const cancel = (e2) => {
      if (e2 && e2.pointerId !== undefined && e2.pointerId !== pid) return;
      detach();
      card.applySize(orig.w, orig.h);
      this.wires.refresh();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  /** Double-click on the grip: back to the default card size (rule-consistent). */
  resetCardSize(card) {
    card.clearSize();
    this.wires.refresh();
    this.studio.mutated(`Reset ${card.node.name} size`);
  }

  addChildNode(fromId) {
    const g = this.studio.app.graph;
    const from = g.getNode(fromId);
    const heading = from.headingDeg ?? 0;
    const rad = heading * Math.PI / 180;
    const step = 10 * g.scale.pixelsPerMeter;
    const id = generateId('pt');
    const n = g.addNode({ id, x: from.x + Math.sin(rad) * step, y: from.y - Math.cos(rad) * step, name: `${from.name} +10 m`, pano: { kind: 'generated' } });
    g.connect(fromId, id);
    this.rebuild(); this.centerOn(id);
    this.studio.select(id);
    this.studio.mutated(`Added ${n.name} and linked to ${from.name}`);
  }

  deleteNode(id) {
    const g = this.studio.app.graph;
    const n = g.getNode(id); if (!n) return;
    if (g.nodes.size <= 1) { this.studio.toast('Rule: the world needs at least one node — not deleting the last one', 'err', 4000); return; }
    if (!window.confirm(`Delete node "${n.name}" and its links?`)) return;
    g.removeNode(id);
    this.rebuild();
    this.studio.mutated(`Deleted ${n.name}`);
    if (this.studio.selectedId === id) this.studio.select(null);
  }

  /** Delete the whole multi-selection as ONE history step; the last-node
      rule blocks wiping the world entirely (selection is cleared instead). */
  deleteGroup() {
    const g = this.studio.app.graph;
    const ids = [...(this.studio.selectedIds || [])].filter((id) => g.getNode(id));
    if (!ids.length) return;
    if (ids.length >= g.nodes.size) { this.studio.toast('Rule: the world needs at least one node — clearing the selection instead', 'err', 4000); this.studio.select(null); return; }
    if (!window.confirm(`Delete ${ids.length} nodes and their links?`)) return;
    for (const id of ids) g.removeNode(id);
    this.studio.selectedIds?.clear(); this.studio.selectedId = null; this.studio._selChip?.();
    this.rebuild();
    this.studio.mutated(`Deleted ${ids.length} nodes`);
  }
}

/* ================================================================== */
/* DetailsPanel — right dock: the node's auto-calculated details       */
/* ================================================================== */

class DetailsPanel {
  constructor(studio) {
    this.studio = studio;
    this.el = h('aside', 'sg-details');
    this.el.hidden = true;
    this._nodeId = null;
    // ONE delegated listener pair (re-render swaps innerHTML only)
    this.el.addEventListener('change', (e) => {
      const g = this.studio.app.graph;
      const n = g.getNode(this._nodeId);
      if (!n) return;
      if (e.target.matches('[data-name]')) { n.name = e.target.value; this.studio.mutated('Renamed', { keepDetails: true }); }
      if (e.target.matches('[data-head]')) { n.headingDeg = ((Number(e.target.value) || 0) % 360 + 360) % 360; this.studio.mutated('Heading set', { keepDetails: true }); }
      // cheap live feedback that survives keepDetails (no full re-render):
      if (e.target.matches('[data-head]')) { const c = this.el.querySelector('[data-comp]'); if (c) c.textContent = compassOf(n.headingDeg); }
    });
    this.el.addEventListener('click', (e) => {
      const g = this.studio.app.graph;
      const n = g.getNode(this._nodeId);
      if (e.target.closest('[data-x]')) { this.studio.select(null); return; }
      if (!n) return;
      if (e.target.closest('[data-img]')) this.studio.assignImage(n.id);
      else if (e.target.closest('[data-prev]')) this.studio.previewNode(n.id);
      else if (e.target.closest('[data-unlink]')) {
        const sock = e.target.closest('.sg-linkrow').dataset.sock;
        const edge = socketAssign(g, n.id)[sock];
        if (edge) { g.disconnect(edge.a, edge.b); this.studio.mutated('Socket unlinked'); }
      }
      else if (e.target.closest('[data-arm]')) {
        const sock = e.target.closest('.sg-linkrow').dataset.sock;
        this.studio.socketArm = { nodeId: n.id, sock };
        this.studio.toast(`Armed socket ${sock} of ${n.name} — click a card to link`, 'ok');
      }
    });
  }

  render(nodeId) {
    this._nodeId = nodeId;
    const g = this.studio.app.graph;
    const n = g.getNode(nodeId);
    this.el.hidden = !n || !!this.studio.dockHidden;
    if (!n) return;
    const ppm = g.scale.pixelsPerMeter;
    const slots = socketAssign(g, nodeId);
    const links = SOCKETS.map(s => {
      const e = slots[s.key];
      const to = e ? g.getNode(g.otherEnd(e, nodeId)) : null;
      const bearing = e ? g.edgeBearing(e, nodeId) : socketWorldBearing(s.key, n.headingDeg ?? 0);
      return `<div class="sg-linkrow" data-sock="${s.key}">
        <span class="sg-key">${s.key}</span>
        <span class="grow">${to ? escTxt(to.name) : '<em>empty socket</em>'}</span>
        <span class="sg-dim">${Math.round(bearing)}°${e ? ` · ${e.distM.toFixed(0)} m` : ' · auto'}</span>
        ${to ? '<button class="sg-x" data-unlink title="Unlink in this direction">×</button>' : '<button class="sg-p" data-arm title="Arm: click a card to link here">＋</button>'}
      </div>`;
    }).join('');
    const url = variantUrlOf(n, this.studio.variant);
    this.el.innerHTML = `
      <div class="sg-dhead"><h4>${escTxt(n.name)}</h4><button class="iconbtn" data-x aria-label="Close details"><svg><use href="#i-close"/></svg></button></div>
      <label class="sg-field"><span>Name</span><input data-name value="${escTxt(n.name)}"></label>
      <label class="sg-field"><span>Heading ° <b class="sg-comp" data-comp>${compassOf(n.headingDeg ?? 0)}</b></span><input data-head type="number" step="5" value="${Math.round(n.headingDeg ?? 0)}"></label>
      <div class="sg-sub">Position &amp; image</div>
      <div class="sg-kv"><span>Map position</span><b>${(n.x / ppm).toFixed(1)} m E · ${(n.y / ppm).toFixed(1)} m N</b><small>auto from map px</small></div>
      <div class="sg-kv"><span>Image (${this.studio.variant})</span><b class="${THUMB_STATE.get(`${n.id}:${this.studio.variant}`) === 'missing' ? 'bad' : ''}">${url ? (THUMB_STATE.get(`${n.id}:${this.studio.variant}`) === 'missing' ? 'missing file' : escTxt(shortUrl(url))) : (n.pano?.kind === 'asset' ? 'project asset ✓' : 'generated on demand')}</b></div>
      <button class="btn ghost block" data-img><svg class="ic"><use href="#i-image"/></svg>Set / replace day image…</button>
      <div class="sg-sub">Links (W/A/S/D sockets)</div>
      ${links}
      <div class="sg-sube">Unslotted neighbours: ${slots.unslotted.length ? slots.unslotted.map(e => escTxt(oldName(g, e, n.id))).join(', ') : '—'}</div>
      <button class="btn block" data-prev><svg class="ic"><use href="#i-play"/></svg>Open preview</button>`;
  }
}

function escTxt(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function shortUrl(u) { return u.length > 30 ? '…' + u.slice(-28) : u; }
/** 0° → N, 90° → E … — human-readable heading next to the number. */
function compassOf(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/* ================================================================== */
/* CodeView — plain-text graph editing (nodes/edges JSON)              */
/* ================================================================== */

class CodeView {
  constructor(studio, host) {
    this.studio = studio;
    this.el = h('div', 'sg-code'); host.append(this.el);
    this.el.innerHTML = `
      <div class="sg-code-bar">
        <span class="sg-note">World graph as data — full OOP structure = nodes + edges + heading. Distances and bearings are auto-calculated on Apply.</span>
        <button class="btn ghost" data-format>Format</button>
        <button class="btn ghost" data-copy>Copy</button>
        <button class="btn ghost" data-reload>Reload from graph</button>
        <button class="btn" data-apply>Apply changes</button>
      </div>
      <textarea spellcheck="false" aria-label="World graph JSON"></textarea>`;
    this.ta = this.el.querySelector('textarea');
    this.el.querySelector('[data-reload]').addEventListener('click', () => this.reload());
    this.el.querySelector('[data-apply]').addEventListener('click', () => this.apply());
    this.el.querySelector('[data-format]').addEventListener('click', () => {
      try { this.ta.value = JSON.stringify(JSON.parse(this.ta.value), null, 2); this.studio.toast('Formatted'); }
      catch (err) { this.studio.toast(`JSON error: ${err.message}`, 'err', 4000); }
    });
    this.el.querySelector('[data-copy]').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(this.ta.value); }
      catch { this.ta.select(); document.execCommand('copy'); }
      this.studio.toast('Copied to clipboard');
    });
    this.reload();
  }
  reload() { this.ta.value = JSON.stringify(serializeGraphSubset(this.studio.app.graph), null, 2); }
  apply() {
    let data;
    try { data = JSON.parse(this.ta.value); }
    catch (err) { this.studio.toast(`JSON error: ${err.message}`, 'err', 5000); return; }
    try {
      const sum = applyGraphSubset(this.studio.app.graph, data);
      this.studio.mutated(`Applied: +${sum.added} −${sum.removed} nodes, ${sum.moved} moved, ${sum.resized || 0} resized, +${sum.connected} −${sum.disconnected} links`);
      this.reload();
    } catch (err) { this.studio.toast(`Invalid graph: ${err.message}`, 'err', 6000); }
  }
}

/* ================================================================== */
/* PreviewModal — fullscreen preview of one panorama node              */
/* ================================================================== */

class PreviewModal {
  constructor(studio) { this.studio = studio; this.renderer = null; this.view = { yawDeg: 0, pitchDeg: 0, fovDeg: 80 }; }

  async open(nodeId) {
    this.nodeId = nodeId;
    if (!this.el) await this._build();
    this.el.hidden = false;
    await this._load(nodeId);
  }

  async _build() {
    const { PanoRenderer } = await import('../viewer/pano-renderer.js');
    this.el = h('div', 'sg-preview');
    this.el.innerHTML = `
      <canvas class="sg-pv-canvas"></canvas>
      <div class="sg-pv-top"><b class="sg-pv-name"></b><span class="sg-pv-id"></span><span class="grow"></span>
        <button class="sg-mini" data-fs title="Fullscreen" aria-label="Fullscreen"><svg><use href="#i-max"/></svg></button>
        <button class="sg-mini" data-x title="Close preview (Esc)" aria-label="Close preview"><svg><use href="#i-close"/></svg></button></div>
      <div class="sg-pv-chips"></div>
      <div class="sg-pv-msg" hidden></div>`;
    document.body.append(this.el);
    const cv = this.el.querySelector('canvas');
    this.renderer = new PanoRenderer(cv);
    this.canvas = cv;
    const look = (dx, dy) => {
      this.view.yawDeg = ((this.view.yawDeg + dx) % 360 + 360) % 360;
      this.view.pitchDeg = Math.max(-60, Math.min(60, this.view.pitchDeg + dy));
      this._draw();
    };
    let drag = null;
    cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => { if (drag) { look((drag.x - e.clientX) * 0.22, (e.clientY - drag.y) * 0.18); drag = { x: e.clientX, y: e.clientY }; } });
    cv.addEventListener('pointerup', () => { drag = null; });
    cv.addEventListener('pointercancel', () => { drag = null; });   // no stale look-delta after a stolen touch
    this.el.querySelector('[data-x]').addEventListener('click', () => { this.el.hidden = true; });
    this.el.querySelector('[data-fs]').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else this.el.requestFullscreen?.();
    });
    document.addEventListener('keydown', (e) => {
      if (this.el.hidden) return;
      if (e.key === 'Escape') { e.stopImmediatePropagation(); this.el.hidden = true; }
    }, true);
    new ResizeObserver(() => { if (!this.el.hidden) { this.renderer.resize(); this._draw(); } }).observe(this.el);
  }

  _draw() { this.renderer.resize(); this.renderer.render({ ...this.view, mix: 0, hasB: false, zoom: 1, blurUv: 0 }); }

  async _load(nodeId) {
    const g = this.studio.app.graph;
    const n = g.getNode(nodeId);
    this.el.querySelector('.sg-pv-name').textContent = n?.name ?? nodeId;
    this.el.querySelector('.sg-pv-id').textContent = `${nodeId} · ${this.studio.variant}`;
    this.view = { yawDeg: n?.headingDeg ?? 0, pitchDeg: 0, fovDeg: 80 };
    this._chips(nodeId);
    const msg = this.el.querySelector('.sg-pv-msg'); msg.hidden = true;
    const url = variantUrlOf(n, this.studio.variant);
    if (!url) {
      msg.hidden = false; msg.textContent = n?.pano?.kind === 'asset' ? 'Project asset — open the walk view to render it.' : 'No image file yet — assign one with the 🖼 button on the card.';
      this._draw();
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { this.renderer.setImageA(img, 0); this._draw(); };
    img.onerror = () => { msg.hidden = false; msg.textContent = `Missing file: ${url}`; this._draw(); };
    img.src = url;
  }

  /** WASD jump chips from the live graph (auto-derived, like the walk view). */
  _chips(nodeId) {
    const g = this.studio.app.graph;
    const n = g.getNode(nodeId);
    const slots = socketAssign(g, nodeId);
    const host = this.el.querySelector('.sg-pv-chips');
    host.innerHTML = '';
    for (const s of SOCKETS) {
      const e = slots[s.key]; if (!e) continue;
      const to = g.getNode(g.otherEnd(e, nodeId));
      const b = h('button', 'sg-pv-chip', `${s.key} · ${to.name}`);
      b.title = `Jump ${s.label} (${e.distM.toFixed(1)} m)`;
      b.addEventListener('click', () => this._load(to.id));
      host.append(b);
    }
  }
}

/* ================================================================== */
/* ScriptStudio — shell: header with Visual/Code switch + stats        */
/* ================================================================== */

export class ScriptStudio {
  constructor(app) {
    this.app = app;
    this.mode = 'visual';
    this.variant = 'day';
    this.selectedId = null;
    this.selectedIds = new Set();
    this.dockHidden = false;
    this.socketArm = null;
    this._histLast = null;                    // serialized snapshot after the last mutation
    this._undo = []; this._redo = [];         // structural undo/redo stacks (cap 30)
    this._open = false;
    this._built = false;
  }

  get isOpen() { return this._open; }
  toast(msg, kind = 'ok', ms = 2600) { this.app.toast(msg, kind, ms); }

  _build() {
    this.el = h('div', 'sg-studio'); this.el.hidden = true;
    this.el.innerHTML = `
      <header class="sg-top">
        <b>Scripting</b>
        <div class="sg-switch" role="tablist" aria-label="Studio mode">
          <button class="on" data-mode="visual" role="tab">Visual scripting</button>
          <button data-mode="code" role="tab">Code editor</button>
        </div>
        <div class="sg-switch sg-variant" role="tablist" aria-label="Scene variant — properties toggle">
          ${VARIANTS.map((v, i) => `<button class="${i === 0 ? 'on' : ''}" data-var="${v.key}" role="tab" title="Switch images & previews to the ${v.label} variant"><svg class="ic"><use href="${v.icon}"/></svg>${v.label}</button>`).join('')}
        </div>
        <span class="grow"></span>
        <span class="sg-stat" data-stat="nodes" title="Nodes in the world graph"></span>
        <span class="sg-stat" data-stat="edges" title="Links between nodes"></span>
        <span class="sg-stat sel" data-stat="sel" title="Multi-selection — drag a rubber band (Select mode), Shift-click cards, Ctrl+A selects all"></span>
        <span class="sg-stat warn" data-stat="missing" title="Panorama image status for the active variant"></span>
        <span class="sg-sep"></span>
        <div class="sg-acts">
          <button class="iconbtn" data-undo title="Undo (Ctrl+Z)" aria-label="Undo"><svg><use href="#i-back"/></svg></button>
          <button class="iconbtn" data-redo title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><svg><use href="#i-right"/></svg></button>
          <button class="btn" data-saveworld title="Write this whole world to one file — every place and every image inside it (Ctrl+S)"><svg class="ic"><use href="#i-db"/></svg>Save world</button>
          <button class="btn ghost" data-dock aria-pressed="true" title="Show / hide the details panel (clear space)"><svg class="ic"><use href="#i-panels"/></svg>Details</button>
          <button class="btn ghost" data-add title="Add a node — then click empty graph space"><svg class="ic"><use href="#i-plus"/></svg>Node</button>
          <button class="btn ghost" data-select title="Multi-select mode — drag a rubber band over empty space · then drag any selected card to move the group · Del deletes the group"><svg class="ic"><use href="#i-select"/></svg>Select</button>
          <button class="btn ghost" data-list title="Find a node by name or id"><svg class="ic"><use href="#i-search"/></svg>Find</button>
          <button class="btn ghost" data-fit title="Fit the whole graph"><svg class="ic"><use href="#i-fit"/></svg>Fit</button>
          <button class="iconbtn" data-close title="Close studio (Esc)" aria-label="Close studio"><svg><use href="#i-close"/></svg></button>
        </div>
      </header>
      <div class="sg-middle">
        <div class="sg-surface" data-surface>
          <div class="sg-zoom" role="toolbar" aria-label="Graph zoom">
            <button data-zi title="Zoom in" aria-label="Zoom in"><svg><use href="#i-zoomin"/></svg></button>
            <span class="sg-zoompct" data-zoompct>50%</span>
            <button data-zo title="Zoom out" aria-label="Zoom out"><svg><use href="#i-zoomout"/></svg></button>
            <button data-zf title="Fit the whole graph" aria-label="Fit the whole graph"><svg><use href="#i-fit"/></svg></button>
          </div>
          <canvas class="sg-minimap" width="220" height="140" title="Mini-map — click or drag to move the view"></canvas>
        </div>
        <div class="sg-dock"></div>
      </div>
      <div class="sg-listpop" hidden><input type="search" placeholder="Find node…"><div class="sg-list"></div></div>`;
    document.body.append(this.el);

    this.surfaceHost = this.el.querySelector('[data-surface]');
    this.canvas = new GraphCanvas(this, this.surfaceHost);
    this.details = new DetailsPanel(this);
    this.el.querySelector('.sg-dock').append(this.details.el);
    this.code = new CodeView(this, this.el.querySelector('.sg-middle'));
    this.code.el.hidden = true;
    this.preview = new PreviewModal(this);
    this.wires = this.canvas.wires;

    const q = (sel) => this.el.querySelector(sel);
    this.el.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => this.setMode(b.dataset.mode)));
    this.el.querySelectorAll('[data-var]').forEach(b => b.addEventListener('click', () => this.setVariant(b.dataset.var)));
    q('[data-close]').addEventListener('click', () => this.app.closePanels());
    // the studio covers the app toolbar, so the world file button lives here too
    q('[data-saveworld]').addEventListener('click', () => this.app.saveWorldFile());
    q('[data-fit]').addEventListener('click', () => this.canvas.fit());
    q('[data-dock]').addEventListener('click', (e) => this.toggleDock(e.currentTarget));
    q('[data-undo]').addEventListener('click', () => this.undo());
    q('[data-redo]').addEventListener('click', () => this.redo());
    const zoom = this.el.querySelector('.sg-zoom');
    zoom.querySelector('[data-zi]').addEventListener('click', () => this.canvas.zoomBy(1.3));
    zoom.querySelector('[data-zo]').addEventListener('click', () => this.canvas.zoomBy(1 / 1.3));
    zoom.querySelector('[data-zf]').addEventListener('click', () => this.canvas.fit());
    q('[data-add]').addEventListener('click', () => {
      this.canvas.addArmed = !this.canvas.addArmed;
      this.surfaceHost.classList.toggle('armed', this.canvas.addArmed);
      if (this.canvas.addArmed) this.setSelectArmed(false);   // one armed tool at a time
      this.toast(this.canvas.addArmed ? 'Click empty graph space to drop the node' : 'Add-node cancelled');
    });
    q('[data-select]').addEventListener('click', () => this.setSelectArmed(!(this.canvas.selectArmed)));
    const pop = this.el.querySelector('.sg-listpop');
    q('[data-list]').addEventListener('click', () => { pop.hidden = !pop.hidden; if (!pop.hidden) this._fillList(); });
    pop.querySelector('input').addEventListener('input', () => this._fillList(pop.querySelector('input').value));
    document.addEventListener('keydown', (e) => {
      if (!this._open) return;
      // structural undo/redo — but never steal native text undo from inputs
      if ((e.ctrlKey || e.metaKey) && !e.target.closest?.('input, textarea')) {
        const k = e.key.toLowerCase();
        if (k === 'z' && e.shiftKey) { e.preventDefault(); this.redo(); return; }
        if (k === 'z') { e.preventDefault(); this.undo(); return; }
        if (k === 'y') { e.preventDefault(); this.redo(); return; }
        if (k === 'a') { e.preventDefault(); this.selectMany([...this.app.graph.nodes.keys()]); this.toast(`Selected all ${this.app.graph.nodes.size} nodes`, 'ok', 1400); return; }
      }
      if (!e.target.closest?.('input, textarea') && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (this.selectedIds?.size > 1) { e.preventDefault(); this.canvas.deleteGroup(); return; }
        if (this.selectedId) { e.preventDefault(); this.canvas.deleteNode(this.selectedId); return; }
      }
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      // Esc peels the topmost layer first: in-flight wire, armed tools,
      // multi-selection, preview modal — only then the studio itself.
      if (this.canvas.wires.cancelDrag()) { this.toast('Connection cancelled'); return; }
      if (this.socketArm) { this.socketArm = null; this.toast('Connect cancelled'); return; }
      if (this.canvas.selectArmed) { this.setSelectArmed(false); this.toast('Select-mode off'); return; }
      if (this.canvas.addArmed) { this.canvas.addArmed = false; this.surfaceHost.classList.remove('armed'); this.toast('Add-node cancelled'); return; }
      if (this.selectedIds?.size > 1) { this.select(null); this.toast('Selection cleared'); return; }
      if (this.preview?.el && !this.preview.el.hidden) { this.preview.el.hidden = true; return; }
      this.app.closePanels();
    }, true);
    // armed socket: click on a card completes the link
    this.surfaceHost.addEventListener('click', (e) => {
      if (!this.socketArm) return;
      const cardEl = e.target.closest('.sg-card');
      if (!cardEl || cardEl.dataset.id === this.socketArm.nodeId) { if (cardEl) this.toast('Pick a different card'); return; }
      const { nodeId } = this.socketArm;
      this.app.graph.connect(nodeId, cardEl.dataset.id);
      this.socketArm = null;
      this.mutated('Socket linked');
    }, true);
    this._built = true;
    this.onThumbState();
  }

  setMode(m) {
    this.canvas.wires.cancelDrag();          // no stranded wire while hopping to the code view
    this.mode = m;
    this.el.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    const visual = m === 'visual';
    this.surfaceHost.hidden = !visual;
    this.details.el.hidden = !visual || !this.selectedId || this.dockHidden;
    this.code.el.hidden = visual;
    if (visual) this.canvas.sync();
    else this.code.reload();
  }

  /** Panel toggle: clear the dock away when the user wants pure graph
      space; selecting any card brings it back automatically. */
  toggleDock(btn) {
    this.dockHidden = !this.dockHidden;
    if (!this.dockHidden && !this.selectedId) this.dockHidden = true;  // nothing to show
    btn?.setAttribute('aria-pressed', String(!this.dockHidden));
    this.details.render(this.selectedId);
    this.toast(this.dockHidden ? 'Details panel hidden — click a card to reopen' : 'Details panel shown');
  }

  /** Scene-variant properties toggle (Day / Rain / Night) — drives every
      thumbnail, the missing-image counter, details and the preview. */
  setVariant(v) {
    if (!VARIANTS.some(x => x.key === v)) v = 'day';
    if (this.variant === v) return;
    this.wires.cancelDrag();                 // card geometry changes per variant — don't strand a wire
    this.variant = v;
    this.el.querySelectorAll('[data-var]').forEach(b => b.classList.toggle('on', b.dataset.var === v));
    // force thumbnails to re-probe the new variant files
    for (const c of this.canvas.cards.values()) { c.img.dataset.src = ''; }
    this.canvas.sync();
    this.onThumbState();
    if (this.selectedId) this.details.render(this.selectedId);
    if (this.preview?.el && !this.preview.el.hidden) this.preview._load(this.preview.nodeId);
  }

  open() {
    if (!this._built) this._build();
    this._open = true;
    this.el.hidden = false;
    this.canvas.rebuild();
    this._reconcileSelection();          // another world may imply another node set
    this.setMode(this.mode);
    this.onThumbState();
    // fresh editing session: reset the undo history to this graph state
    this._histLast = this._snapshot();
    this._undo = []; this._redo = [];
    this._histSync();
    // GraphCanvas must lay out AFTER the studio is visible (hidden element
    // has zero layout). Fit once per world-load — later opens keep the view.
    if (!this._didFit) {
      this._didFit = true;
      requestAnimationFrame(() => setTimeout(() => this.canvas.fit(), 0));
    }
  }

  close() {
    this._open = false;
    this.canvas?.wires?.cancelDrag();        // never strand a pending wire + listeners
    if (this.el) this.el.hidden = true;
  }

  /** Select-mode (rubber band) toggle — mutually exclusive with add-node. */
  setSelectArmed(on) {
    this.canvas.selectArmed = !!on;
    this.surfaceHost.classList.toggle('selecting', !!on);
    this.el?.querySelector('[data-select]')?.setAttribute('aria-pressed', String(!!on));
    if (on && this.canvas.addArmed) { this.canvas.addArmed = false; this.surfaceHost.classList.remove('armed'); }
    this.toast(on ? 'Drag a rubber band over empty graph space — cards inside join the selection' : 'Select-mode off', 'ok', 1800);
  }

  select(id, { additive = false } = {}) {
    this.selectedIds = this.selectedIds || new Set();
    if (id == null) {
      this.selectedIds.clear();
      this.selectedId = null;
    } else if (additive) {
      // Shift-click toggles membership in the multi-selection
      if (this.selectedIds.has(id)) this.selectedIds.delete(id);
      else this.selectedIds.add(id);
      this.selectedId = id;
    } else {
      this.selectedIds = new Set([id]);
      this.selectedId = id;
    }
    this._afterSelect();
  }

  /** Marquee / Ctrl+A entry point: replace the whole selection. */
  selectMany(ids) {
    this.selectedIds = new Set(ids);
    this.selectedId = this.selectedIds.size ? [...this.selectedIds][0] : null;
    this._afterSelect();
  }

  _afterSelect() {
    const total = this.selectedIds?.size ?? 0;
    if (this.selectedId != null && total === 1 && this.dockHidden) {   // a deliberate selection reopens the dock
      this.dockHidden = false;
      this.el?.querySelector('[data-dock]')?.setAttribute('aria-pressed', 'true');
    }
    // details dock mirrors exactly one node — anything else (zero or many)
    // clears it, or a deleted/deselected node would linger on screen
    if (this.mode === 'visual') this.details.render(total === 1 ? this.selectedId : null);
    this.canvas.sync();
    this._selChip();
  }

  _selChip() {
    const el = this.el?.querySelector('[data-stat="sel"]');
    if (!el) return;
    const n = this.selectedIds?.size ?? 0;
    el.textContent = n > 1 ? `${n} selected` : '';
    if (n > 1) el.animate(                       // enrolment feedback: chip pops
      [{ transform: 'scale(1)' }, { transform: 'scale(1.16)' }, { transform: 'scale(1)' }],
      { duration: 210, easing: 'cubic-bezier(.34, 1.56, .64, 1)' });
  }

  previewNode(id) { this.preview.open(id); }

  async assignImage(id) {
    await this.app.uploadPanoramaForNode(id);
    this.canvas.sync();
    if (this.selectedId === id) this.details.render(id);
    this.onThumbState();
  }

  placeNode(w) {
    const g = this.app.graph;
    const id = generateId('pt');
    const n = g.addNode({ id, x: Math.round(w.x), y: Math.round(w.y), name: `Location ${g.nodes.size}`, pano: { kind: 'generated' } });
    const near = g.nearestNode(w.x, w.y, 25 * g.scale.pixelsPerMeter);
    if (near && near.id !== id) g.connect(id, near.id);
    this.canvas.rebuild();
    this.select(id);
    this.mutated(`Added ${n.name}${near && near.id !== id ? ` + linked to ${near.name}` : ''}`);
  }

  /** Any graph mutation: persist (autosave via app) + refresh everything.
      keepDetails: skip the details re-render (avoids stealing focus from an
      input the user is typing in — cards still refresh via canvas.sync). */
  mutated(msg, { keepDetails = false } = {}) {
    this.app.notifyMapChanged?.();
    this.app.dirty = true;
    this.canvas.sync();
    if (this.selectedId && !keepDetails) this.details.render(this.selectedId);
    if (this.mode === 'code') this.code.reload();
    if (msg) this.toast(msg, 'ok');
    this._histPush();
    this.onThumbState();
  }

  /* ---------- structural undo / redo ---------- */
  _snapshot() { return JSON.parse(JSON.stringify(serializeGraphSubset(this.app.graph))); }
  _histPush() {
    if (!this._histLast) { this._histLast = this._snapshot(); return; }   // first mutation after open
    this._undo.push(this._histLast);
    if (this._undo.length > 30) this._undo.shift();
    this._redo.length = 0;
    this._histLast = this._snapshot();
    this._histSync();
  }
  _histSync() {
    const u = this.el?.querySelector('[data-undo]'), r = this.el?.querySelector('[data-redo]');
    u?.toggleAttribute('disabled', !this._undo.length);
    r?.toggleAttribute('disabled', !this._redo.length);
    u?.classList.toggle('off', !this._undo.length);
    r?.classList.toggle('off', !this._redo.length);
  }
  /** Drop selection entries whose nodes no longer exist (undo, world swap).
      Never invents a selection — only reconciles what is still real. */
  _reconcileSelection() {
    if (this.selectedIds?.size) {
      for (const id of [...this.selectedIds]) if (!this.app.graph.getNode(id)) this.selectedIds.delete(id);
      if (!this.selectedIds.size) this.selectedId = null;
      else if (!this.selectedIds.has(this.selectedId)) this.selectedId = [...this.selectedIds][0];
    } else if (this.selectedId && !this.app.graph.getNode(this.selectedId)) this.selectedId = null;
    this._selChip?.();
  }

  _histRestore(snap, label) {
    applyGraphSubset(this.app.graph, JSON.parse(JSON.stringify(snap)));   // diff-apply keeps live objects
    this.canvas.rebuild();
    this._reconcileSelection();
    if (this.mode === 'visual') this.details.render(this.selectedIds?.size === 1 ? this.selectedId : null);
    if (this.mode === 'code') this.code.reload();
    this.app.notifyMapChanged?.();
    this.app.dirty = true;
    this.onThumbState();
    this.toast(label);
    this._histSync();
  }
  undo() {
    if (!this._undo.length) { this.toast('Nothing to undo'); return; }
    this._redo.push(this._histLast);
    this._histLast = this._undo.pop();
    this._histRestore(this._histLast, 'Undone');
  }
  redo() {
    if (!this._redo.length) { this.toast('Nothing to redo'); return; }
    this._undo.push(this._histLast);
    this._histLast = this._redo.pop();
    this._histRestore(this._histLast, 'Redone');
  }

  onThumbState() {
    if (!this._built) return;
    const g = this.app.graph;
    let missing = 0;
    for (const n of g.nodes.values()) if (variantUrlOf(n, this.variant) && THUMB_STATE.get(`${n.id}:${this.variant}`) === 'missing') missing++;
    // isolation rule readout: degree-0 nodes are unreachable in the walk view
    let isolated = 0;
    for (const n of g.nodes.values()) {
      let deg = 0;
      for (const e of g.edges.values()) if (e.a === n.id || e.b === n.id) { deg = 1; break; }
      if (!deg) isolated++;
    }
    this.el.querySelector('[data-stat="nodes"]').textContent = `${g.nodes.size} nodes`;
    this.el.querySelector('[data-stat="edges"]').textContent = `${g.edges.size} links${isolated ? ` · ${isolated} isolated` : ''}`;
    this.el.querySelector('[data-stat="missing"]').textContent = missing ? `${missing} missing ${this.variant} img` : `${this.variant} images ok`;
  }

  _fillList(q = '') {
    const list = this.el.querySelector('.sg-list'); list.innerHTML = '';
    const needle = q.trim().toLowerCase();
    let shown = 0;
    for (const n of this.app.graph.nodes.values()) {
      if (needle && !n.name.toLowerCase().includes(needle) && !n.id.toLowerCase().includes(needle)) continue;
      const b = h('button', 'sg-li', `${n.name} — ${n.id}`);
      b.addEventListener('click', () => { this.canvas.centerOn(n.id); this.select(n.id); });
      list.append(b);
      if (++shown >= 60) break;
    }
    if (!shown) list.append(h('div', 'sg-li none', 'no match'));
  }
}
