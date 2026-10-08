/**
 * Panorama Maps — map/map-renderer.js
 *
 * Canvas 2D map (Spec §14, §84–§87). One canvas, viewport culling, rAF-
 * coalesced redraws, zoom-aware label density. Reads EVERYTHING from the
 * shared WorldGraph — the map never owns a private position (Spec §35).
 *
 * Styling follows familiar web-map conventions: light base, cased roads,
 * blue position dot with heading cone.
 */
const DPR = () => (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);
const RAF = (fn) => {
  if (typeof requestAnimationFrame !== 'undefined') return requestAnimationFrame(fn);
  const t = setTimeout(fn, 16);
  t.unref?.();
  return t;
};
const CAF = (id) => (typeof cancelAnimationFrame !== 'undefined' ? cancelAnimationFrame(id) : clearTimeout(id));

export class MapRenderer {
  constructor(canvas, bus) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bus = bus;
    this.graph = null;
    this.cam = { x: 0, y: 0, scale: 0.5 };      // world px at screen centre
    this.currentNodeId = null;
    this.currentYawDeg = 0;
    this.route = null;
    this.visited = new Set();
    this.debug = false;
    this.highlight = new Set();
    this.onCanvasClick = null;                   // editor hook
    this.onNodeClick = null;
    this._needsDraw = true;
    this._raf = 0;
    this._drag = null;
    this._walkPos = null;                        // interpolated walk position
    this.animated = true;                        // animated route, radar pulse, water ripple, actors
    this._t0 = Date.now();
    this._bind();
  }

  setGraph(graph) { this.graph = graph; this.visited.clear(); this.fit(); this.requestDraw(); }
  setAnimated(on) { this.animated = !!on; this.requestDraw(); }
  setCurrent(nodeId, yawDeg) {
    this.currentNodeId = nodeId;
    if (yawDeg !== undefined) this.currentYawDeg = yawDeg;
    if (nodeId) this.visited.add(nodeId);
    this.requestDraw();
  }
  setWalkProgress(pos) { this._walkPos = pos; this.requestDraw(); }
  setRoute(nodes) { this.route = nodes; this.requestDraw(); }
  setDebug(on) { this.debug = on; this.requestDraw(); }
  setHighlight(ids) { this.highlight = new Set(ids || []); this.requestDraw(); }
  markVisited(id) { this.visited.add(id); this.requestDraw(); }
  /** Underlay: user-uploaded 2D map image in world coordinates. */
  setUnderlay(img, bounds) { this.underlay = img ? { img, ...bounds } : null; this.requestDraw(); }
  previewRoad(points) { this._previewRoad = points; this.requestDraw(); }

  worldToScreen(x, y) {
    return { x: (x - this.cam.x) * this.cam.scale + this.canvas.width / 2, y: (y - this.cam.y) * this.cam.scale + this.canvas.height / 2 };
  }
  screenToWorld(x, y) {
    return { x: (x - this.canvas.width / 2) / this.cam.scale + this.cam.x, y: (y - this.canvas.height / 2) / this.cam.scale + this.cam.y };
  }

  fit() {
    if (!this.graph || this.graph.nodes.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.graph.nodes.values()) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
    const pad = 120;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    this.cam.x = (minX + maxX) / 2; this.cam.y = (minY + maxY) / 2;
    this.cam.scale = Math.min(this.canvas.width / (maxX - minX || 1), this.canvas.height / (maxY - minY || 1));
    this.requestDraw();
  }

  panToNode(nodeId, { reset = false } = {}) {
    const n = this.graph?.getNode(nodeId);
    if (!n) return;
    this.cam.x = n.x; this.cam.y = n.y;
    if (reset) this.cam.scale = Math.max(this.cam.scale, 0.8);
    this.requestDraw();
  }

  zoomBy(f, around) {
    const c = around ?? { x: this.canvas.width / 2, y: this.canvas.height / 2 };
    const before = this.screenToWorld(c.x, c.y);
    this.cam.scale = Math.min(6, Math.max(0.02, this.cam.scale * f));
    const after = this.screenToWorld(c.x, c.y);
    this.cam.x += before.x - after.x; this.cam.y += before.y - after.y;
    this.requestDraw();
  }

  resize() {
    const dpr = Math.min(DPR(), 2);
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (w !== this.canvas.width || h !== this.canvas.height) { this.canvas.width = w; this.canvas.height = h; }
    this.requestDraw();
  }

  requestDraw() {
    if (this._raf) return;
    this._raf = RAF(() => { this._raf = 0; this.draw(); });
  }

  _bind() {
    const el = this.canvas;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      this._drag = { x: e.clientX, y: e.clientY, camX: this.cam.x, camY: this.cam.y, moved: 0, id: e.pointerId };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this._drag || e.pointerId !== this._drag.id) return;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      this._drag.moved = Math.max(this._drag.moved, Math.abs(dx) + Math.abs(dy));
      if (this.onCanvasClick && this._drag.moved < 1) return;
      this.cam.x = this._drag.camX - dx / this.cam.scale;
      this.cam.y = this._drag.camY - dy / this.cam.scale;
      this.requestDraw();
    });
    el.addEventListener('pointercancel', () => { this._drag = null; });   // stolen touch: drop the stale anchor
    el.addEventListener('pointerup', (e) => {
      if (!this._drag) return;
      const wasClick = this._drag.moved < 6;
      this._drag = null;
      if (!wasClick) return;
      const rect = el.getBoundingClientRect();
      const dpr = this.canvas.width / rect.width;
      const sx = (e.clientX - rect.left) * dpr, sy = (e.clientY - rect.top) * dpr;
      const w = this.screenToWorld(sx, sy);
      if (this.onCanvasClick) { this.onCanvasClick(w, e); return; }
      // default: nearest node → teleport (Spec §35: map and viewer share state)
      const n = this.graph?.nearestNode(w.x, w.y, 18 / this.cam.scale);
      if (n) this.onNodeClick ? this.onNodeClick(n, e) : this.bus.emit('map:nodeSelected', { nodeId: n.id });
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const dpr = this.canvas.width / rect.width;
      this.zoomBy(Math.exp((e.deltaY > 0 ? -1 : 1) * 0.14), { x: (e.clientX - rect.left) * dpr, y: (e.clientY - rect.top) * dpr });
    }, { passive: false });
  }

  /* ================================ draw ================================ */
  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    if (W === 0 || H === 0) return;
    const t = (Date.now() - this._t0) / 1000;
    ctx.fillStyle = '#e9eee4';
    ctx.fillRect(0, 0, W, H);
    if (!this.graph) return;
    const g = this.graph;
    const s = this.cam.scale;
    const ppm2 = g.scale.pixelsPerMeter;

    // optional user-uploaded 2D map underlay (simple editor feature)
    if (this.underlay?.img) {
      const u = this.underlay;
      const a = this.worldToScreen(u.x, u.y);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(u.img, a.x, a.y, u.w * s, u.h * s);
      ctx.globalAlpha = 1;
    }
    // in-progress road drawn by the editor
    if (this._previewRoad?.length > 1) {
      ctx.strokeStyle = 'rgba(26,115,232,0.8)';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      this._previewRoad.forEach((p, i) => { const q = this.worldToScreen(p[0], p[1]); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const tl = this.screenToWorld(0, 0), br = this.screenToWorld(W, H);
    const inView = (x, y, pad = 40 / s) => x >= tl.x - pad && x <= br.x + pad && y >= tl.y - pad && y <= br.y + pad;

    const feats = g.environment.features || [];

    // regions
    for (const f of feats) {
      if (f.type !== 'region') continue;
      if (f.shape === 'rect') {
        if (f.x > br.x || f.x + f.w < tl.x || f.y > br.y || f.y + f.h < tl.y) continue;
        const a = this.worldToScreen(f.x, f.y);
        ctx.fillStyle = f.kind === 'water' ? '#aacdec' : f.kind === 'plaza' ? '#ddd8c9' : '#cfe0b4';
        ctx.fillRect(a.x, a.y, f.w * s, f.h * s);
        if (this.animated && f.kind === 'water') {
          const ripProg = (t * 0.45) % 1;
          const rw = f.w * s, rh = f.h * s;
          const cx = a.x + rw / 2, cy = a.y + rh / 2;
          const maxR = Math.min(rw, rh) * 0.42;
          if (maxR > 3) {
            ctx.strokeStyle = `rgba(255, 255, 255, ${(1 - ripProg) * 0.32})`;
            ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.arc(cx, cy, maxR * (0.25 + 0.7 * ripProg), 0, Math.PI * 2); ctx.stroke();
          }
        }
      } else if (f.shape === 'circle') {
        const a = this.worldToScreen(f.cx, f.cy);
        ctx.fillStyle = f.kind === 'water' ? '#aacdec' : '#cfe0b4';
        ctx.beginPath(); ctx.arc(a.x, a.y, f.radiusPx * s, 0, Math.PI * 2); ctx.fill();
        if (this.animated && f.kind === 'water') {
          const ripProg = (t * 0.45) % 1;
          const maxR = f.radiusPx * s;
          if (maxR > 3) {
            ctx.strokeStyle = `rgba(255, 255, 255, ${(1 - ripProg) * 0.32})`;
            ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.arc(a.x, a.y, maxR * (0.25 + 0.7 * ripProg), 0, Math.PI * 2); ctx.stroke();
          }
        }
      }
    }

    // roads (casing + fill, Google-Maps style)
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const f of feats) {
      if (f.type !== 'road') continue;
      const pts = f.points.map(p => this.worldToScreen(p[0], p[1]));
      const wpx = Math.max(2, f.widthM * ppm2 * s);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = wpx + 2.4;
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
      ctx.strokeStyle = f.surface === 'dirt' ? '#d9c8a6' : '#f5f2ea';
      ctx.lineWidth = wpx;
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
    }

    // building footprints
    for (const f of feats) {
      if (f.type !== 'building') continue;
      if (!inView(f.x, f.y, Math.max(f.w, f.d))) continue;
      const a = this.worldToScreen(f.x - f.w / 2, f.y - f.d / 2);
      ctx.fillStyle = f.kind === 'church' ? '#d9c5a0' : '#d5d0c4';
      ctx.strokeStyle = '#b8b2a4';
      ctx.lineWidth = 1;
      const rw = Math.max(3, f.w * s), rh = Math.max(3, f.d * s);
      ctx.fillRect(a.x, a.y, rw, rh); ctx.strokeRect(a.x, a.y, rw, rh);
    }

    // debug: zones
    if (this.debug) {
      for (const z of g.zones.zones.values()) {
        ctx.strokeStyle = 'rgba(214,158,64,0.75)';
        ctx.fillStyle = z.color || 'rgba(214,158,64,0.07)';
        ctx.lineWidth = 1.5;
        if (z.shape === 'circle') {
          const a = this.worldToScreen(z.cx, z.cy);
          ctx.beginPath(); ctx.arc(a.x, a.y, z.radiusPx * s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = 'rgba(160,110,30,0.9)';
          ctx.font = `${Math.max(11, 11 * DPR())}px system-ui`;
          ctx.fillText(`${z.name}${z.meta?.boundaryMeters ? ` · ${z.meta.boundaryMeters} m` : ''}`, a.x + 6, a.y - 6);
        } else if (z.shape === 'rect') {
          const a = this.worldToScreen(z.x, z.y);
          ctx.fillRect(a.x, a.y, z.w * s, z.h * s); ctx.strokeRect(a.x, a.y, z.w * s, z.h * s);
        }
      }
    }

    // edges
    const edgeAlpha = Math.min(1, s * 3);
    ctx.strokeStyle = `rgba(84,110,140,${0.28 * edgeAlpha})`;
    ctx.lineWidth = Math.max(1, 1.1 * s ** 0.4);
    ctx.beginPath();
    for (const e of g.edges.values()) {
      const a = g.getNode(e.a), b = g.getNode(e.b);
      if (!inView(a.x, a.y) && !inView(b.x, b.y)) continue;
      const pa = this.worldToScreen(a.x, a.y), pb = this.worldToScreen(b.x, b.y);
      ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();
    // blocked edges in red
    ctx.strokeStyle = 'rgba(200,60,50,0.55)';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    for (const e of g.edges.values()) {
      if (!e.blocked) continue;
      const a = g.getNode(e.a), b = g.getNode(e.b);
      const pa = this.worldToScreen(a.x, a.y), pb = this.worldToScreen(b.x, b.y);
      ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // route highlight (casing + animated flow dashes)
    if (this.route?.length > 1) {
      ctx.strokeStyle = 'rgba(51,116,230,0.30)';
      ctx.lineWidth = Math.max(5, w2s(8, s));
      ctx.beginPath();
      this.route.forEach((id, i) => {
        const n = g.getNode(id); if (!n) return;
        const p = this.worldToScreen(n.x, n.y);
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      });
      ctx.stroke();

      ctx.strokeStyle = 'rgba(51,116,230,0.92)';
      ctx.lineWidth = Math.max(2.8, w2s(4.5, s));
      if (this.animated) {
        ctx.setLineDash([9, 5]);
        ctx.lineDashOffset = -t * 22;
      }
      ctx.beginPath();
      this.route.forEach((id, i) => {
        const n = g.getNode(id); if (!n) return;
        const p = this.worldToScreen(n.x, n.y);
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      });
      ctx.stroke();
      if (this.animated) ctx.setLineDash([]);
    }

    // nodes — dense 8 m waypoints render as faint small dots (the ground
    // truth for stride movement); only named spots are full-size/labeled
    const nodeR = Math.max(2.2, Math.min(7, 3.4 * Math.sqrt(s)));
    const showLabels = s > 0.35;
    ctx.font = `${Math.max(10, 10 * DPR())}px system-ui`;
    for (const n of g.nodes.values()) {
      if (!inView(n.x, n.y)) continue;
      const p = this.worldToScreen(n.x, n.y);
      const isWaypoint = /(^|_)w\d+$/.test(n.id);
      if (this.highlight.has(n.id)) { ctx.fillStyle = '#e8a33d'; }
      else if (n.id === this.currentNodeId) { continue; }    // marker drawn later
      else if (this.visited.has(n.id)) ctx.fillStyle = '#4d7fc0';
      else ctx.fillStyle = n.zoneId?.includes('church') ? '#b99256' : (isWaypoint ? 'rgba(135,152,171,0.55)' : '#8798ab');
      ctx.beginPath(); ctx.arc(p.x, p.y, isWaypoint ? Math.max(1.3, nodeR * 0.45) : nodeR, 0, Math.PI * 2); ctx.fill();
      if (showLabels && n.id !== this.currentNodeId && s > 0.9 && !isWaypoint) {
        ctx.fillStyle = 'rgba(60,70,84,0.85)';
        ctx.fillText(n.name, p.x + nodeR + 3, p.y - nodeR - 2);
      }
    }

    // landmarks
    for (const lm of g.landmarks.values()) {
      if (!inView(lm.x, lm.y)) continue;
      const p = this.worldToScreen(lm.x, lm.y);
      this._landmarkGlyph(p.x, p.y, lm);
      if (s > 0.2) {
        ctx.fillStyle = 'rgba(52,60,72,0.9)';
        ctx.font = `600 ${Math.max(10, 10 * DPR())}px system-ui`;
        ctx.fillText(lm.name, p.x + 8, p.y - 8);
      }
    }

    // current position: blue dot + heading cone (walk interpolation applies)
    let cur = this.currentNodeId ? g.getNode(this.currentNodeId) : null;
    if (this._walkPos && cur) cur = { ...cur, x: this._walkPos.x, y: this._walkPos.y };
    if (cur) {
      const p = this.worldToScreen(cur.x, cur.y);
      const yawRad = (this.currentYawDeg - 90) * Math.PI / 180;
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(yawRad);
      const cone = ctx.createRadialGradient(0, 0, 2, 0, 0, 46 * Math.max(0.5, s));
      cone.addColorStop(0, 'rgba(66,133,244,0.30)');
      cone.addColorStop(1, 'rgba(66,133,244,0)');
      ctx.fillStyle = cone;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 46 * Math.max(0.5, s), -0.5, 0.5); ctx.closePath(); ctx.fill();
      ctx.restore();

      // animated radar pulse ring
      if (this.animated) {
        const pulse = (t % 1.8) / 1.8;
        const pulseR = Math.max(5, nodeR + 1.5) + pulse * 20 * Math.max(0.6, Math.min(1.8, s));
        const pulseAlpha = (1 - pulse) * 0.45;
        ctx.strokeStyle = `rgba(66, 133, 244, ${pulseAlpha})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(p.x, p.y, pulseR, 0, Math.PI * 2); ctx.stroke();
      }

      ctx.fillStyle = '#4285f4';
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(5, nodeR + 1.5), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    // animated actors (walkers, dogs, cats on coded routes)
    this._drawActors(t, s, ppm2, inView);

    // scale bar (meters — Spec §4 correctness on screen)
    this._scaleBar();

    if (this.debug) this._debugGrid();

    // keep animated layers moving when visible
    this._scheduleNextFrame();
  }

  _drawActors(t, s, ppm2, inView) {
    const actors = this.graph?.environment?.actors || [];
    if (!actors.length) return;
    const ctx = this.ctx;
    const showLabels = s > 0.45;
    ctx.save();
    for (const act of actors) {
      const ax = act.x1 - act.x0, ay = act.y1 - act.y0;
      const lenM = Math.max(0.5, Math.hypot(ax, ay));
      const P = lenM / Math.max(0.2, act.speedMps || 1);
      let k = 0, dir = 1;
      if (act.kind === 'dog' || act.kind === 'cat') {
        const d = act.kind === 'cat' ? 3.2 : 0;
        const period = 2 * (d + P);
        const st = (((t + (act.phase || 0)) % period) + period) % period;
        if (st < d) { k = 0; }
        else if (st < d + P) { k = (st - d) / P; }
        else if (st < 2 * d + P) { k = 1; dir = -1; }
        else { k = 1 - (st - 2 * d - P) / P; dir = -1; }
      } else {
        const period = 2 * P;
        const st = (((t + (act.phase || 0)) % period) + period) % period;
        k = st < P ? st / P : (2 * P - st) / P;
        dir = st < P ? 1 : -1;
      }
      const mx = act.x0 + ax * k;
      const my = act.y0 + ay * k;
      const wx = mx * ppm2;
      const wy = my * ppm2;
      if (!inView(wx, wy, 40 / s)) continue;

      const p = this.worldToScreen(wx, wy);
      const angle = Math.atan2(ay * dir, ax * dir);
      const r = Math.max(3.5, Math.min(8, 4.5 * Math.sqrt(s)));

      ctx.save();
      ctx.translate(p.x, p.y);

      if (act.kind === 'dog') {
        ctx.fillStyle = act.tint || '#5c4424';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.strokeStyle = act.tint || '#5c4424';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * r * 0.8, Math.sin(angle) * r * 0.8);
        ctx.lineTo(Math.cos(angle) * (r * 1.5), Math.sin(angle) * (r * 1.5));
        ctx.stroke();
      } else if (act.kind === 'cat') {
        ctx.fillStyle = act.tint || '#2c2c34';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        const cadence = 0.72;
        const bob = Math.sin(t * (2 * Math.PI / cadence) + (act.phase || 0) * 3) * 1.2;

        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.beginPath();
        ctx.ellipse(0, 2, r * 1.1, r * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = act.tint || '#5a4632';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, -bob * 0.3, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = act.tint || '#5a4632';
        ctx.beginPath();
        const tipX = Math.cos(angle) * (r + 3.5);
        const tipY = Math.sin(angle) * (r + 3.5);
        const lX = Math.cos(angle + 2.4) * (r * 0.7);
        const lY = Math.sin(angle + 2.4) * (r * 0.7);
        const rX = Math.cos(angle - 2.4) * (r * 0.7);
        const rY = Math.sin(angle - 2.4) * (r * 0.7);
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(lX, lY);
        ctx.lineTo(rX, rY);
        ctx.closePath();
        ctx.fill();
      }

      if (showLabels && act.name) {
        ctx.font = `500 ${Math.max(9, 9 * DPR())}px system-ui`;
        const tw = ctx.measureText(act.name).width;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
        ctx.fillRect(-tw / 2 - 4, -r - 16, tw + 8, 13);
        ctx.strokeStyle = 'rgba(0,0,0,0.12)';
        ctx.lineWidth = 0.8;
        ctx.strokeRect(-tw / 2 - 4, -r - 16, tw + 8, 13);
        ctx.fillStyle = '#2c3440';
        ctx.fillText(act.name, -tw / 2, -r - 6);
      }

      ctx.restore();
    }
    ctx.restore();
  }

  _scheduleNextFrame() {
    if (!this.animated) return;
    const canvas = this.canvas;
    if (!canvas || canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
    const hasActors = (this.graph?.environment?.actors?.length ?? 0) > 0;
    const hasRoute = (this.route?.length ?? 0) > 1;
    const hasWater = this.graph?.environment?.features?.some(f => f.type === 'region' && f.kind === 'water') ?? false;
    const hasWalk = !!this._walkPos;
    if (hasActors || hasRoute || hasWater || hasWalk) {
      if (this._raf) return;
      this._raf = RAF(() => {
        this._raf = 0;
        this.draw();
      });
    }
  }

  _landmarkGlyph(x, y, lm) {
    const ctx = this.ctx;
    const r = 5.5;
    ctx.save();
    ctx.translate(x, y);
    if (lm.type === 'church') {
      ctx.fillStyle = '#8a6d3b';
      ctx.fillRect(-1.4, -r, 2.8, r * 2);
      ctx.fillRect(-r * 0.66, -r * 0.45, r * 1.32, 2.4);
    } else if (lm.type === 'tower') {
      ctx.fillStyle = '#7a6248';
      ctx.fillRect(-2.2, -r, 4.4, r * 2);
    } else if (lm.type === 'tree') {
      ctx.fillStyle = '#5b8a4e';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2); ctx.fill();
    } else if (lm.type === 'water') {
      ctx.fillStyle = '#4d86c6';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = '#b35e3c';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  _scaleBar() {
    const { ctx, canvas } = this;
    const g = this.graph; if (!g) return;
    const metersPerScreenPx = 1 / (this.cam.scale * g.scale.pixelsPerMeter);
    const want = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
    let chosen = want[0];
    for (const w of want) { if (w / metersPerScreenPx <= 140 * DPR()) chosen = w; }
    const lenPx = chosen / metersPerScreenPx;
    const x = 14 * DPR(), y = canvas.height - 16 * DPR();
    ctx.fillStyle = 'rgba(40,48,58,0.85)';
    ctx.fillRect(x, y - 3, lenPx, 2.4);
    ctx.fillRect(x, y - 8, 2, 7); ctx.fillRect(x + lenPx - 2, y - 8, 2, 7);
    ctx.font = `${11 * DPR()}px system-ui`;
    ctx.fillText(chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`, x + 4, y - 10);
  }

  _debugGrid() {
    const { ctx, canvas } = this;
    ctx.strokeStyle = 'rgba(60,80,110,0.08)';
    ctx.lineWidth = 1;
    const step = 128 * this.cam.scale;
    if (step < 24) return;
    const off = this.worldToScreen(0, 0);
    for (let x = off.x % step; x < canvas.width; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
    for (let y = off.y % step; y < canvas.height; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
  }
}
function w2s(worldPx, s) { return worldPx * s; }
