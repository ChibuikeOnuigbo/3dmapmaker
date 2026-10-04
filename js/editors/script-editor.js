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
  const summary = { added: 0, removed: 0, moved: 0, renamed: 0, connected: 0, disconnected: 0 };

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
    this.btnPrev = b('button', 'sg-mini', '▶'); this.btnPrev.title = 'Preview this panorama (fullscreen)';
    this.btnImg = b('button', 'sg-mini', '🖼'); this.btnImg.title = 'Assign / replace day image';
    this.btnChild = b('button', 'sg-mini', '✚'); this.btnChild.title = 'Add child node in the heading direction';
    this.btnDel = b('button', 'sg-mini danger', '×'); this.btnDel.title = 'Delete node';
    this.footRow.append(this.btnPrev, this.btnImg, this.btnChild, this.btnDel);

    this.el.append(this.head, this.thumbWrap, this.sockRow, this.footRow);
    this._bind();
  }

  _bind() {
    const n = this.node;
    this.head.addEventListener('pointerdown', (e) => this.owner.startCardDrag(this, e));
    this.el.addEventListener('click', (e) => { e.stopPropagation(); this.owner.studio.select(n.id); });
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
  }

  _thumb(state) {
    THUMB_STATE.set(`${this.node.id}:${this.owner.studio.variant}`, state);
    this.thumbStateEl.textContent = state === 'ok' ? '' : (state === 'missing' ? 'no image' : '…');
    this.el.classList.toggle('missing', state === 'missing');
    this.owner.studio.onThumbState();
  }

  /** Refresh dynamic content from the graph (name/links/thumb position). */
  sync() {
    const g = this.owner.studio.app.graph;
    const n = this.node;
    this.head.firstChild.textContent = n.name;
    this.el.style.left = `${n.x}px`;
    this.el.style.top = `${n.y}px`;
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
    this.el.classList.toggle('selected', this.owner.studio.selectedId === n.id);
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
    this.svg.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const e of g.edges.values()) {
      const a = g.getNode(e.a), b = g.getNode(e.b);
      if (!a || !b) continue;
      const p = this._path(a, b);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', p);
      path.setAttribute('class', 'sg-wire' + (e.blocked ? ' blocked' : ''));
      path.dataset.a = e.a; path.dataset.b = e.b;
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${e.a} — ${e.b} · ${e.distM.toFixed(1)} m · click to unlink`;
      path.append(title);
      path.addEventListener('click', (ev) => {
        ev.stopPropagation();
        g.disconnect(e.a, e.b);
        this.studio.mutated(`Unlinked ${a.name} — ${b.name}`);
      });
      frag.append(path);
    }
    if (this.drag) frag.append(this.drag.path);
    this.svg.append(frag);
  }

  _path(a, b) {
    // bezier with horizontal tangents (blueprint-style easing)
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }

  startDrag(card, sockKey, ev) {
    ev.preventDefault();
    const from = card.node;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'sg-wire pending');
    this.drag = { fromId: from.id, sockKey, path, start: { x: from.x, y: from.y } };
    this.refresh();
    const move = (e2) => {
      const w = this.canvas.toWorld(e2.clientX, e2.clientY);
      this.drag.path.setAttribute('d', this._path(this.drag.start, w));
    };
    const up = (e2) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const el = document.elementFromPoint(e2.clientX, e2.clientY);
      const cardEl = el?.closest?.('.sg-card');
      const drag = this.drag; this.drag = null;
      if (cardEl && cardEl.dataset.id !== drag.fromId) {
        const g = this.studio.app.graph;
        const existed = g.connect(drag.fromId, cardEl.dataset.id);
        this.studio.mutated(`Linked ${g.getNode(drag.fromId).name} → ${g.getNode(cardEl.dataset.id).name} (${existed.distM.toFixed(1)} m, auto)`);
      }
      this.refresh();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
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
    this._dragging = false;
    this.mini = hostEl.querySelector('.sg-minimap');
    this.zoomPct = hostEl.querySelector('[data-zoompct]');
    this._bind();
    this._bindMini();
    this.rebuild();
    requestAnimationFrame(() => this.fit());
  }

  rebuild() {
    for (const c of this.cards.values()) c.el.remove();
    this.cards.clear();
    for (const n of this.studio.app.graph.nodes.values()) {
      const c = new NodeCardView(this, n);
      this.cards.set(n.id, c);
      this.world.append(c.el);
    }
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
      if (e.target.closest('.sg-card') || e.target.closest('.sg-sock') || e.target.closest('.sg-zoom') || e.target.closest('.sg-minimap')) return;
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
    this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    this.world.style.setProperty('--s', this.scale);
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
      const move = (e2) => goto(e2);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
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

  startCardDrag(card, e) {
    e.preventDefault(); e.stopPropagation();
    const g = this.studio.app.graph;
    const start = this.toWorld(e.clientX, e.clientY);
    const orig = { x: card.node.x, y: card.node.y };
    const move = (e2) => {
      const w = this.toWorld(e2.clientX, e2.clientY);
      g.moveNode(card.node.id, orig.x + (w.x - start.x), orig.y + (w.y - start.y));
      card.el.style.left = `${card.node.x}px`; card.el.style.top = `${card.node.y}px`;
      this.wires.refresh();
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      this.studio.mutated(`Moved ${card.node.name}`);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
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
    if (!window.confirm(`Delete node "${n.name}" and its links?`)) return;
    g.removeNode(id);
    this.rebuild();
    this.studio.mutated(`Deleted ${n.name}`);
    if (this.studio.selectedId === id) this.studio.select(null);
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
      <div class="sg-dhead"><h4>${escTxt(n.name)}</h4><button class="iconbtn" data-x><svg><use href="#i-close"/></svg></button></div>
      <label class="sg-field"><span>Name</span><input data-name value="${escTxt(n.name)}"></label>
      <label class="sg-field"><span>Heading (auto from map, editable)</span><input data-head type="number" step="5" value="${Math.round(n.headingDeg ?? 0)}"></label>
      <div class="sg-kv"><span>Map position</span><b>${(n.x / ppm).toFixed(1)} m E · ${(n.y / ppm).toFixed(1)} m N</b><small>auto from map px</small></div>
      <div class="sg-kv"><span>Image (${this.studio.variant})</span><b class="${THUMB_STATE.get(`${n.id}:${this.studio.variant}`) === 'missing' ? 'bad' : ''}">${url ? (THUMB_STATE.get(`${n.id}:${this.studio.variant}`) === 'missing' ? 'missing file' : escTxt(shortUrl(url))) : (n.pano?.kind === 'asset' ? 'project asset ✓' : 'generated on demand')}</b></div>
      <button class="btn ghost block" data-img>Set / replace day image…</button>
      <div class="sg-sub">Links (W/A/S/D sockets)</div>
      ${links}
      <div class="sg-sube">Unslotted neighbours: ${slots.unslotted.length ? slots.unslotted.map(e => escTxt(oldName(g, e, n.id))).join(', ') : '—'}</div>
      <button class="btn block" data-prev>Open preview ▶</button>`;
  }
}

function escTxt(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function shortUrl(u) { return u.length > 30 ? '…' + u.slice(-28) : u; }

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
      this.studio.mutated(`Applied: +${sum.added} −${sum.removed} nodes, ${sum.moved} moved, +${sum.connected} −${sum.disconnected} links`);
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
        <button class="sg-mini" data-fs title="Fullscreen">⛶</button>
        <button class="sg-mini" data-x title="Close preview (Esc)">×</button></div>
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
    this.dockHidden = false;
    this.socketArm = null;
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
        <span class="sg-stat" data-stat="nodes"></span>
        <span class="sg-stat" data-stat="edges"></span>
        <span class="sg-stat warn" data-stat="missing"></span>
        <span class="grow"></span>
        <div class="sg-acts">
          <button class="btn ghost" data-dock aria-pressed="true" title="Show / hide the details panel (clear space)">Panel</button>
          <button class="btn ghost" data-add>＋ Node</button>
          <button class="btn ghost" data-fit>Fit</button>
          <button class="btn ghost" data-list>Nodes ▾</button>
          <button class="iconbtn" data-close title="Close studio (Esc)" aria-label="Close studio"><svg><use href="#i-close"/></svg></button>
        </div>
      </header>
      <div class="sg-middle">
        <div class="sg-surface" data-surface>
          <div class="sg-zoom" role="toolbar" aria-label="Graph zoom">
            <button data-zi title="Zoom in" aria-label="Zoom in">＋</button>
            <span class="sg-zoompct" data-zoompct>50%</span>
            <button data-zo title="Zoom out" aria-label="Zoom out">−</button>
            <button data-zf title="Fit the whole graph" aria-label="Fit the whole graph">Fit</button>
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
    q('[data-fit]').addEventListener('click', () => this.canvas.fit());
    q('[data-dock]').addEventListener('click', (e) => this.toggleDock(e.currentTarget));
    const zoom = this.el.querySelector('.sg-zoom');
    zoom.querySelector('[data-zi]').addEventListener('click', () => this.canvas.zoomBy(1.3));
    zoom.querySelector('[data-zo]').addEventListener('click', () => this.canvas.zoomBy(1 / 1.3));
    zoom.querySelector('[data-zf]').addEventListener('click', () => this.canvas.fit());
    q('[data-add]').addEventListener('click', () => {
      this.canvas.addArmed = !this.canvas.addArmed;
      this.surfaceHost.classList.toggle('armed', this.canvas.addArmed);
      this.toast(this.canvas.addArmed ? 'Click empty graph space to drop the node' : 'Add-node cancelled');
    });
    const pop = this.el.querySelector('.sg-listpop');
    q('[data-list]').addEventListener('click', () => { pop.hidden = !pop.hidden; if (!pop.hidden) this._fillList(); });
    pop.querySelector('input').addEventListener('input', () => this._fillList(pop.querySelector('input').value));
    document.addEventListener('keydown', (e) => {
      if (!this._open || e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      // Esc peels the topmost layer first: preview modal, then the studio.
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
    this.setMode(this.mode);
    this.onThumbState();
    // GraphCanvas must lay out AFTER the studio is visible (hidden element
    // has zero layout). Fit once per world-load — later opens keep the view.
    if (!this._didFit) {
      this._didFit = true;
      requestAnimationFrame(() => setTimeout(() => this.canvas.fit(), 0));
    }
  }

  close() { this._open = false; if (this.el) this.el.hidden = true; }

  select(id) {
    this.selectedId = id;
    if (id && this.dockHidden) {   // a deliberate selection reopens the dock
      this.dockHidden = false;
      this.el?.querySelector('[data-dock]')?.setAttribute('aria-pressed', 'true');
    }
    if (this.mode === 'visual') this.details.render(id);
    this.canvas.sync();
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
    this.onThumbState();
  }

  onThumbState() {
    if (!this._built) return;
    const g = this.app.graph;
    let missing = 0;
    for (const n of g.nodes.values()) if (variantUrlOf(n, this.variant) && THUMB_STATE.get(`${n.id}:${this.variant}`) === 'missing') missing++;
    this.el.querySelector('[data-stat="nodes"]').textContent = `${g.nodes.size} nodes`;
    this.el.querySelector('[data-stat="edges"]').textContent = `${g.edges.size} links`;
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
