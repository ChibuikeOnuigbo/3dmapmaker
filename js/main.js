/**
 * Panorama Maps — main.js
 *
 * Application orchestrator. Owns the ONE canonical world state:
 *   WorldGraph ← read by viewer, map, movement, editors, generation.
 * No subsystem keeps a private copy of the current position (Spec §35).
 */
import { EventBus } from './core/events.js';
import { MapScale } from './core/scale.js';
import { WorldGraph } from './core/world-graph.js';
import { MovementController, KEY_DIRS } from './core/movement.js';
import { PanoRenderer } from './viewer/pano-renderer.js';
import { PanoramaViewer } from './viewer/viewer.js';
import { detectMissingRegions, completePanorama } from './viewer/completion.js';
import { ProceduralWorldProvider } from './gen/provider.js';
import { GenerationContextBuilder } from './gen/context.js';
import { PanoramaCache, prefetchPlan } from './gen/cache.js';
import { rgbHist, histIntersect, expectedMinSimilarity } from './gen/util.js';
import { MapRenderer } from './map/map-renderer.js';
import { SimpleEditor } from './editors/simple-editor.js';
import { AdvancedEditor } from './editors/advanced-editor.js';
import { ProjectStorage, AssetManager, ProjectArchive, fsAccess, prefs as prefsSvc } from './io/storage.js';

const $ = (sel) => document.querySelector(sel);

const PERF_PROFILES = {
  high: { panoW: 2048, panoH: 1024, cacheCap: 10, prefetch: 3, groundRes: 1, cullRadiusM: 460 },
  balanced: { panoW: 2048, panoH: 1024, cacheCap: 6, prefetch: 2, groundRes: 0.75, cullRadiusM: 340 },
  low: { panoW: 1280, panoH: 640, cacheCap: 3, prefetch: 1, groundRes: 0.55, cullRadiusM: 220 },
};

class App {
  constructor() {
    this.bus = new EventBus();
    this.prefs = prefsSvc.load();
    this.storage = new ProjectStorage();
    this.assets = null;
    this.graph = null;
    this.worldDef = null;
    this.project = null;
    this.acEnabled = this.prefs.acEnabled ?? true;
    this.dirty = false;
    this._autosaveT = null;
    this._pendingDir = null;
    this._lastMove = null;
    this._lastSim = null;
    this.selectedNodeId = null;
    this._saveHandle = null;
    this._searchIndex = [];

    this.perf = this._detectPerf();
    const p = PERF_PROFILES[this.perf];
    this.provider = new ProceduralWorldProvider({ width: p.panoW, height: p.panoH, cullRadiusM: p.cullRadiusM });
    this.cache = new PanoramaCache({ capacity: p.cacheCap });
    this.ctxBuilder = null;   // bound after world load
    this._groundRes = p.groundRes;
    if (this.perf === 'low') document.body.classList.add('lowspec');
  }

  /* ================= boot ================= */
  async boot() {
    this.viewer = new PanoramaViewer($('#panoCanvas'), $('#fxCanvas'), this.bus);
    this.viewer.immersion.transitionMs = 420;
    this.viewer.onFrame = (now) => this.movement?.tick(now);
    this.viewer.start();
    window.addEventListener('resize', () => { this.viewer.renderer.resize(); this.editorResize(); });

    this.mapRenderer = new MapRenderer($('#mapCanvas'), this.bus);
    this.mapRenderer.onNodeClick = (n) => this.teleport(n.id);

    this.simpleEditor = new SimpleEditor(this);
    this.advancedEditor = new AdvancedEditor(this);

    this._bindChrome();
    this._bindKeyboard();
    this._bindBus();
    await this._restoreLastWorld();

    this.viewer.renderer.resize();
    this.mapRenderer.resize();
    this._startDebugOverlay();
    this._registerServiceWorker();
    $('#panoLoading').classList.remove('show');
  }

  editorResize() { this.mapRenderer.resize(); }

  _detectPerf() {
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    if (cores >= 8 && mem >= 8) return 'high';
    if (cores <= 2 || mem <= 2) return 'low';
    return 'balanced';
  }

  /* ================= world lifecycle ================= */
  async _restoreLastWorld() {
    const lastId = this.prefs.lastProjectId || 'demo_chapel_lane';
    const snap = await this.storage.getProjectMeta(lastId).catch(() => null);
    if (snap?.world) {
      try { return this.loadWorldJson(snap.world, { project: snap }); } catch (e) { console.warn('snapshot restore failed', e); }
    }
    const defModule = await import('./worlds/demo-worlds.js');
    this.DEMO_WORLDS = defModule.DEMO_WORLDS;
    const def = defModule.DEMO_WORLDS.find(w => w.id === lastId) || defModule.DEMO_WORLDS[0];
    this.loadDemoWorld(def);
  }

  async loadDemoWorld(def) {
    const built = def.build();
    this.worldDef = def;
    $('#worldName').textContent = def.name;
    await this._adoptWorld(built.graph, {
      projectId: built.graph.id, name: def.name, blurb: def.blurb,
      startNodeId: built.startNodeId,
    });
  }

  async loadWorldJson(json, { project = null, name = null } = {}) {
    const graph = WorldGraph.fromJSON(json);
    $('#worldName').textContent = name || graph.name;
    await this._adoptWorld(graph, {
      projectId: project?.id ?? graph.id, name: name || graph.name,
      startNodeId: json.startNodeId ?? [...graph.nodes.keys()][0],
      existingProject: project,
    });
  }

  async _adoptWorld(graph, { projectId, name, blurb = '', startNodeId, existingProject = null }) {
    // close previous project cleanly: release decoded views & listeners state
    this.cache.clearAll();
    this.mapRenderer.setRoute(null);
    this.mapRenderer.setWalkProgress(null);
    this.selectedNodeId = null;

    this.graph = graph;
    this.project = existingProject ?? { id: projectId, name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.project.id = projectId;
    this.assets = new AssetManager(this.storage, projectId);
    await this.assets.reindex().catch(() => {});
    this.ctxBuilder = new GenerationContextBuilder(graph, this.cache);
    this.movement = new MovementController(graph, this.bus);

    this.mapRenderer.setGraph(graph);
    this._buildSearchIndex();
    this._restoreUnderlay();

    const start = startNodeId && graph.getNode(startNodeId) ? startNodeId : [...graph.nodes.keys()][0];
    if (start) {
      this.movement.setPosition(start, { silent: true });
      await this._enterNode(start, { initial: true });
      this.panoramaWarmHint(blurb);
    }
    prefsSvc.save({ lastProjectId: projectId });
    this.project.updatedAt = new Date().toISOString();
    await this.storage.saveProjectMeta({ ...this.project, world: graph.toJSON() }).catch(() => {});
  }

  panoramaWarmHint(blurb) {
    if (blurb) this.toast(blurb, 'ok', 5200);
  }

  /* ================= panorama pipeline =================
     Cache check → (generate with FULL context → light continuity check) →
     AutoComplete analysis → transition (never blank) → prefetch (Spec §70). */
  async _ensurePanorama(nodeId, { fromId = null, relativeDir = null } = {}) {
    const node = this.graph.getNode(nodeId);
    const distanceM = fromId ? this._edgeDist(fromId, nodeId) : null;
    const context = this.ctxBuilder.build({
      targetNodeId: nodeId, fromNodeId: fromId && fromId !== nodeId ? fromId : null,
      movement: distanceM ? { direction: relativeDir, distanceM } : null,
      camera: { yawDeg: this.viewer.view.yawDeg, pitchDeg: this.viewer.view.pitchDeg, fovDeg: this.viewer.view.fovDeg, height: node.camera?.height ?? 1.7 },
    });

    const entry = await this.cache.get(nodeId, async (priorMeta) => {
      let produced;
      if (node.pano?.kind === 'asset' && node.pano.assetId) {
        produced = await this._renderAssetPanorama(node, priorMeta);
      } else {
        produced = await this.provider.generate(node, context, {
          world: { id: this.graph.id, environment: this.graph.environment },
          scale: this.graph.scale,
          groundResolution: this._groundRes,
          priorMeta,
        });
      }
      // sample histogram (small) for the JS continuity gate
      const sample = sampleCanvas(produced.canvas, 192, 96);
      const hist = rgbHist(sample.data, 2, 4);
      produced.meta.hist = Array.from(hist);
      produced.meta.validation = this._lightValidation(hist, nodeId, fromId, distanceM);
      // AutoComplete analysis runs ONCE per node (report persists in meta)
      if (!produced.meta.autoComplete) {
        const full = sampleCanvas(produced.canvas, 1024, 512);
        produced.meta.autoComplete = detectMissingRegions(full.data, full.width, full.height);
      }
      return { canvas: produced.canvas, meta: produced.meta };
    });

    if (entry && !entry.meta.hist) {
      const sample = sampleCanvas(entry.canvas, 192, 96);
      entry.meta.hist = Array.from(rgbHist(sample.data, 2, 4));
    }
    if (entry && !entry.meta.autoComplete) {
      const full = sampleCanvas(entry.canvas, 1024, 512);
      entry.meta.autoComplete = detectMissingRegions(full.data, full.width, full.height);
    }
    return { ...entry, context };
  }

  _edgeDist(aId, bId) {
    for (const e of this.graph.edgesOf(aId)) if (this.graph.otherEnd(e, aId) === bId) return e.distM;
    return null;
  }

  _lightValidation(hist, nodeId, fromId, distanceM) {
    const out = { score: null, vs: fromId, passed: true, expectedMin: null, sim: null, attempt: 1 };
    if (!fromId || fromId === nodeId) return out;
    const prev = this.cache.metaOf(fromId);
    if (!prev?.hist) return out;
    const sim = histIntersect(hist, Float64Array.from(prev.hist));
    const expectedMin = expectedMinSimilarity(distanceM ?? 10);
    out.sim = sim; out.expectedMin = expectedMin;
    // distance-aware gate (Spec §27–28): procedural same-world scenes pass;
    // an unrelated replacement (e.g. bad upload) fails loudly.
    out.passed = sim >= expectedMin * 0.55;
    out.score = Math.min(1, sim / Math.max(0.2, expectedMin));
    if (!out.passed) {
      console.warn(`[validation] node ${nodeId} FAILED continuity (sim ${sim.toFixed(2)} < ${expectedMin.toFixed(2)})`);
      this.toast(`Panorama at this location failed the continuity check (score ${out.score.toFixed(2)}). It stays visible but is flagged for review.`, 'err', 6000);
    }
    this._lastSim = sim;
    return out;
  }

  async _renderAssetPanorama(node, priorMeta) {
    const rec = await this.storage.getAsset(this.project.id, `${node.pano.assetId}:display`)
      ?? await this.storage.getAsset(this.project.id, node.pano.assetId);
    if (!rec?.blob) {
      node.pano.missing = true;
      const canvas = placeholderCanvas('Panorama image missing', 'Use the editor → Upload panorama to replace it');
      return { canvas, meta: { nodeId: node.id, provider: 'asset', missing: true, seed: priorMeta?.seed ?? null, generationAttempt: (priorMeta?.generationAttempt ?? 0) + 1 } };
    }
    const url = URL.createObjectURL(rec.blob);
    try {
      const bmp = await createImageBitmap(rec.blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width; canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      return { canvas, meta: { nodeId: node.id, provider: 'asset', assetId: node.pano.assetId, seed: priorMeta?.seed ?? null, promptVersion: 1, generationAttempt: (priorMeta?.generationAttempt ?? 0) + 1 } };
    } finally { URL.revokeObjectURL(url); }
  }

  /** Apply AutoComplete presentation choice + pitch limits for the CURRENT node. */
  _present(entry) {
    const report = entry.meta.autoComplete;
    let display = entry.canvas;
    if (this.acEnabled && report && !report.complete) {
      if (!entry.completedCanvas) entry.completedCanvas = completePanorama(entry.canvas, report);
      if (entry.completedCanvas) {
        display = entry.completedCanvas;
        this.viewer.setPitchLimits({ min: report.pitchMinDeg, max: report.pitchMaxDeg, tight: true });
      } else {
        this.viewer.setPitchLimits({ min: -80, max: 80, tight: true });
      }
    } else {
      this.viewer.setPitchLimits({ min: -80, max: 80, tight: !report?.complete });
    }
    return display;
  }

  /* ================= movement / arrival ================= */
  _bindBus() {
    this.bus.on('move:blocked', ({ relativeDir }) => {
      const btn = document.querySelector(`#movePad .mbtn[data-dir="${relativeDir}"]`);
      if (btn) { btn.classList.remove('blockshake'); void btn.offsetWidth; btn.classList.add('blockshake'); }
      this.toast('No path that way', null, 1400);
    });
    this.bus.on('walk:started', () => { /* keep panorama; transition fires on arrival */ });
    this.bus.on('walk:progress', (pos) => { this.mapRenderer.setWalkProgress(pos); });
    this.bus.on('position:changed', async ({ nodeId, edge, fromId, teleport }) => {
      this.mapRenderer.setWalkProgress(null);
      await this._enterNode(nodeId, { fromId, teleport, relativeDir: this._lastMove?.relativeDir ?? null });
      // chained walking (key held down)
      if (this._pendingDir) { const d = this._pendingDir; this._pendingDir = null; this.tryMove(d); }
    });
    this.bus.on('view:changed', () => this._viewDirty = true);
    this.bus.on('map:nodeSelected', ({ nodeId }) => this.teleport(nodeId));
  }

  tryMove(relativeDir) {
    if (!this.movement) return;
    this._lastMove = { relativeDir };
    this.movement.tryMove(relativeDir, this.viewer.view.yawDeg);
  }

  async _enterNode(nodeId, { fromId = null, teleport = false, relativeDir = null, initial = false } = {}) {
    const node = this.graph.getNode(nodeId);
    if (!node) return;
    this.bus.emit('debug:node', nodeId);
    this.mapRenderer.setCurrent(nodeId, this.viewer.view.yawDeg);

    const entry = await this._ensurePanorama(nodeId, { fromId, relativeDir });
    if (this.movement.currentNodeId !== nodeId && !initial) return; // superseded by a newer arrival

    const display = this._present(entry);
    const heading = node.headingDeg ?? 0;
    if (initial) {
      this.viewer.setImageNow(display, heading);
    } else {
      await this.viewer.transitionTo(display, heading, {
        direction: relativeDir,
        durationMs: (teleport ? 0.6 : 1) * this.viewer.immersion.transitionMs,
      });
    }
    // node camera metadata applies to the live view
    if (node.camera?.fov) this.viewer.setFov(node.camera.fov);

    this.refreshLocationUI();
    this.advancedEditor.refresh();
    this._prefetch(nodeId);
    this.notifyMapChanged();
  }

  _prefetch(nodeId) {
    const ids = prefetchPlan(this.graph, nodeId, this.viewer.view.yawDeg, PERF_PROFILES[this.perf].prefetch);
    // low-priority: generate/decode likely-next views when idle
    const run = () => ids.forEach((id, i) => setTimeout(() => this._ensurePanorama(id, { fromId: nodeId }).catch(() => {}), 120 * (i + 1)));
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1500 }); else setTimeout(run, 300);
  }

  teleport(nodeId) {
    if (!this.graph.getNode(nodeId)) return;
    this.movement.cancelWalk();
    const from = this.movement.currentNodeId;
    this._lastMove = null;
    this.movement.setPosition(nodeId);   // emits position:changed with teleport flag
    this.bus.emit('debug:teleport', { from, to: nodeId });
  }

  async reloadCurrentPanorama(regenerate = false) {
    const id = this.movement.currentNodeId;
    if (!id) return;
    if (regenerate) { this.cache.lru.delete(id); this.cache.meta.delete(id); }
    await this._enterNode(id, {});
  }

  /* ================= UI chrome ================= */
  _bindChrome() {
    const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);

    on('#fsBtn', 'click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    });
    on('#debugBtn', 'click', () => {
      const el = $('#debugOverlay');
      el.hidden = !el.hidden;
      $('#debugBtn').classList.toggle('active', !el.hidden);
      this.mapRenderer.setDebug(!el.hidden);
    });
    on('#editBtn', 'click', () => this.togglePanel('simple'));
    on('#advEditBtn', 'click', () => this.togglePanel('adv'));
    on('#compass', 'click', () => { this.viewer.view.yawDeg = 0; });

    // move pad
    document.querySelectorAll('#movePad .mbtn').forEach(b => {
      b.addEventListener('click', () => this.tryMove(b.dataset.dir));
    });

    // map widget controls
    on('#mapZoomIn', 'click', () => this.mapRenderer.zoomBy(1.3));
    on('#mapZoomOut', 'click', () => this.mapRenderer.zoomBy(1 / 1.3));
    on('#mapFit', 'click', () => this.mapRenderer.fit());
    on('#mapExpand', 'click', () => {
      const w = $('#mapWidget');
      w.classList.toggle('full');
      setTimeout(() => this.mapRenderer.resize(), 260);
    });

    // AutoComplete quick toggle — a REAL switch (Spec §45)
    const acBtn = $('#acToggle');
    const syncAc = () => {
      acBtn.classList.toggle('toggled', this.acEnabled);
      acBtn.setAttribute('aria-pressed', String(this.acEnabled));
      acBtn.querySelector('span').textContent = `AutoComplete ${this.acEnabled ? 'on' : 'off'}`;
    };
    syncAc();
    acBtn.addEventListener('click', async () => {
      this.acEnabled = !this.acEnabled;
      prefsSvc.save({ acEnabled: this.acEnabled });
      syncAc();
      const id = this.movement?.currentNodeId;
      if (id) {   // re-present current panorama immediately with the new mode
        const entry = await this._ensurePanorama(id, {});
        const display = this._present(entry);
        this.viewer.setImageNow(display, this.graph.getNode(id).headingDeg ?? 0);
      }
      this.toast(`AutoComplete Panorama ${this.acEnabled ? 'ON — missing regions repaired, view range limited' : 'OFF — original pixels shown'}`, 'ok', 2600);
    });

    on('#routeBtn', 'click', () => this.routeToNearestLandmark());

    on('#exportBtn', 'click', () => this.saveProject(true));
    on('#openBtn', 'click', () => this.openProject());

    // world menu
    const wm = $('#worldMenu');
    on('#worldBtn', 'click', async () => {
      wm.classList.toggle('open');
      if (wm.classList.contains('open')) await this._renderWorldMenu();
    });
    document.addEventListener('click', (e) => {
      if (!wm.contains(e.target) && !$('#worldBtn').contains(e.target)) wm.classList.remove('open');
    });

    // search
    const si = $('#searchInput');
    si.addEventListener('input', () => this._renderSearch(si.value.trim()));
    si.addEventListener('keydown', (e) => { if (e.key === 'Escape') { si.value = ''; this._renderSearch(''); si.blur(); } });

    window.addEventListener('beforeunload', (e) => { if (this.dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  togglePanel(which) {
    const simple = which === 'simple' ? !this.simpleEditor.isOpen : false;
    const adv = which === 'adv' ? !this.advancedEditor.isOpen : false;
    this.closePanels();
    if (simple) this.simpleEditor.open();
    if (adv) this.advancedEditor.open();
    $('#editBtn').classList.toggle('active', this.simpleEditor.isOpen);
    $('#advEditBtn').classList.toggle('active', this.advancedEditor.isOpen);
  }

  closePanels() {
    this.simpleEditor.close();
    this.advancedEditor.close();
    $('#editBtn').classList.remove('active');
    $('#advEditBtn').classList.remove('active');
  }

  async _renderWorldMenu() {
    const wm = $('#worldMenu');
    const { DEMO_WORLDS } = await import('./worlds/demo-worlds.js');
    const saved = await this.storage.listProjects().catch(() => []);
    const savedDemo = new Set(saved.map(p => p.id));
    wm.innerHTML = `
      ${DEMO_WORLDS.map(d => `
        <button class="wm-item ${d.id === this.project?.id ? 'active' : ''}" data-w="${d.id}">
          <span class="t">${d.name} <span style="color:var(--ink-3);font-weight:500">· ${d.tag}</span></span>
          <span class="d">${savedDemo.has(d.id) ? 'Resume your saved copy' : 'Demo world'}</span>
        </button>`).join('')}
      <button class="wm-item" data-new="1"><span class="t">＋ New empty world</span><span class="d">Start from a blank map</span></button>`;
    wm.querySelectorAll('[data-w]').forEach(b => b.addEventListener('click', async () => {
      wm.classList.remove('open');
      const def = DEMO_WORLDS.find(d => d.id === b.dataset.w);
      const snap = await this.storage.getProjectMeta(def.id).catch(() => null);
      if (snap?.world) this.loadWorldJson(snap.world, { project: snap });
      else this.loadDemoWorld(def);
    }));
    wm.querySelector('[data-new]').addEventListener('click', () => {
      wm.classList.remove('open');
      const name = prompt('Name your world:', 'My World');
      if (!name) return;
      const graph = new WorldGraph(new MapScale({ pixelsPerMeter: 2 }), { id: 'world_' + Date.now().toString(36), name });
      graph.environment.features = [];
      graph.description = 'Custom world';
      const center = graph.addNode({ id: 'node_start', x: 0, y: 0, name: 'Start', pano: { kind: 'generated' } });
      this.loadWorldJson({ ...graph.toJSON(), startNodeId: center.id }, { name });
    });
  }

  _buildSearchIndex() {
    this._searchIndex = [];
    for (const n of this.graph.nodes.values()) this._searchIndex.push({ kind: 'location', id: n.id, name: n.name, x: n.x, y: n.y });
    for (const lm of this.graph.landmarks.values()) this._searchIndex.push({ kind: 'landmark', id: lm.id, name: lm.name, x: lm.x, y: lm.y, type: lm.type });
  }

  _renderSearch(q) {
    const box = $('#searchResults');
    if (!q) { box.classList.remove('open'); box.innerHTML = ''; return; }
    const ql = q.toLowerCase();
    const hits = this._searchIndex.filter(i => i.name.toLowerCase().includes(ql)).slice(0, 8);
    box.innerHTML = hits.length ? hits.map(h =>
      `<button class="sr-item" data-k="${h.kind}" data-id="${h.id}"><span class="sr-dot"></span><span><span class="n">${escapeHtml(h.name)}</span><br><span class="k">${h.kind}${h.type ? ' · ' + h.type : ''}</span></span></button>`).join('')
      : '<div class="sr-item" style="cursor:default"><span class="k">No matches</span></div>';
    box.classList.add('open');
    box.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => {
      box.classList.remove('open');
      const kind = b.dataset.k, id = b.dataset.id;
      if (kind === 'location') this.teleport(id);
      else {
        const lm = this.graph.landmarks.get(id);
        if (lm) { const n = this.graph.nearestNode(lm.x, lm.y, 120 * this.graph.scale.pixelsPerMeter); if (n) this.teleport(n.id); }
        this.mapRenderer.panToNode(this.movement.currentNodeId);
      }
    }));
  }

  routeToNearestLandmark() {
    const cur = this.movement.currentNode;
    if (!cur) return;
    const near = this.graph.nearestLandmark(cur.x, cur.y);
    if (!near) return this.toast('No landmarks in this world');
    const targetNode = this.graph.nearestNode(near.landmark.x, near.landmark.y, 200 * this.graph.scale.pixelsPerMeter);
    if (!targetNode) return this.toast('No route to that landmark');
    const path = this.graph.shortestPath(cur.id, targetNode.id);
    if (!path) return this.toast(`No path to ${near.landmark.name}`);
    this.mapRenderer.setRoute(path.nodes);
    this.mapRenderer.panToNode(cur.id);
    this.toast(`Route to ${near.landmark.name}: ${path.distanceM.toFixed(0)} m — follow the blue line (W to walk)`, 'ok', 4200);
  }

  selectNode(id) {
    this.selectedNodeId = id;
    this.advancedEditor.refresh();
    this.simpleEditor._refreshSelection?.();
  }

  /* ================= editor actions ================= */
  notifyMapChanged(structural = false) {
    this.dirty = true;
    this.mapRenderer.requestDraw();
    clearTimeout(this._autosaveT);
    this._autosaveT = setTimeout(() => this.saveProject(false), 1400);
    if (structural) this._buildSearchIndex();
  }

  previewRoad(points) { this.mapRenderer.previewRoad(points); }

  async uploadPanoramaForNode(nodeId) {
    const n = nodeId ? this.graph.getNode(nodeId) : null;
    if (!n) return this.toast('Select a location first');
    const file = await pickFile('image/*');
    if (!file) return;
    try {
      const { assetId, deduped } = await this.assets.importImage(file, 'panorama');
      n.pano = { kind: 'asset', assetId };
      this.cache.lru.delete(n.id); this.cache.meta.delete(n.id);
      this.notifyMapChanged();
      if (this.movement.currentNodeId === n.id) await this.reloadCurrentPanorama(true);
      this.toast(deduped ? 'Image already in project — reused existing asset' : 'Panorama assigned to location', 'ok');
    } catch (err) { this.toast(err.message, 'err', 5000); }
  }

  async uploadMapUnderlay() {
    const file = await pickFile('image/*');
    if (!file) return;
    try {
      const { assetId } = await this.assets.importImage(file, 'map');
      // frame the underlay around the world's current bounds at real-world scale
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const nd of this.graph.nodes.values()) { minX = Math.min(minX, nd.x); maxX = Math.max(maxX, nd.x); minY = Math.min(minY, nd.y); maxY = Math.max(maxY, nd.y); }
      if (!isFinite(minX)) { minX = -500; maxX = 500; minY = -500; maxY = 500; }
      const bmp = await createImageBitmap((await this.storage.getAsset(this.project.id, assetId)).blob);
      const bounds = { x: minX - 100, y: minY - 100, w: (maxX - minX) + 200, h: ((maxX - minX) + 200) * (bmp.height / bmp.width) };
      this.mapRenderer.setUnderlay(bmp, bounds);
      this.graph.environment.mapUnderlay = { assetId, bounds };
      this.notifyMapChanged();
      this.toast('Map image placed under the world', 'ok');
    } catch (err) { this.toast(err.message, 'err', 5000); }
  }

  async _restoreUnderlay() {
    const u = this.graph.environment.mapUnderlay;
    if (!u?.assetId) { this.mapRenderer.setUnderlay(null); return; }
    const rec = await this.storage.getAsset(this.project.id, `${u.assetId}:display`).catch(() => null);
    if (rec?.blob) {
      const bmp = await createImageBitmap(rec.blob);
      this.mapRenderer.setUnderlay(bmp, u.bounds);
    }
  }

  async runContinuityCheck(nodeId) {
    const meta = this.cache.metaOf(nodeId);
    const report = meta?.autoComplete;
    return {
      integrity: !meta?.missing,
      missingText: report ? (report.complete ? 'none detected' : `top ${report.topMissingPct.toFixed(1)}% · bottom ${report.bottomMissingPct.toFixed(1)}%`) : 'not analysed',
      simToPrev: meta?.validation?.sim ?? this._lastSim,
      expectText: meta?.validation?.expectedMin != null ? `≥ ${meta.validation.expectedMin.toFixed(2)} for this step size` : 'n/a',
      score: meta?.validation?.score ?? null,
    };
  }

  /* ================= persistence ================= */
  async saveProject(exportFile) {
    if (!this.project || !this.graph) return;
    this.project.updatedAt = new Date().toISOString();
    this.project.name = this.graph.name;
    await this.storage.saveProjectMeta({ ...this.project, world: this.graph.toJSON() }).catch(() => {});
    this.dirty = false;
    if (!exportFile) return;

    try {
      // collect every asset referenced by nodes / underlay
      const wanted = new Set();
      for (const n of this.graph.nodes.values()) if (n.pano?.kind === 'asset' && n.pano.assetId) wanted.add(n.pano.assetId);
      if (this.graph.environment.mapUnderlay?.assetId) wanted.add(this.graph.environment.mapUnderlay.assetId);
      const assets = [];
      for (const id of wanted) {
        const orig = await this.storage.getAsset(this.project.id, id);
        const disp = await this.storage.getAsset(this.project.id, `${id}:display`);
        const th = await this.storage.getAsset(this.project.id, `${id}:thumb`);
        if (orig?.blob) assets.push({ assetId: id, meta: orig.meta || {}, original: orig.blob, display: disp?.blob, thumbnail: th?.blob });
      }
      this.toast('Building project file…');
      const zip = await ProjectArchive.exportPmap({ ...this.project, name: this.graph.name, world: this.graph.toJSON() }, assets);
      const blob = new Blob([zip], { type: 'application/zip' });
      const name = (this.graph.name || 'panorama-world').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.pmap';
      const res = await fsAccess.saveBlob(blob, name, this._saveHandle);
      if (res.handle) this._saveHandle = res.handle;
      if (res.ok) this.toast(`Saved ${name} — verified portable project`, 'ok');
      else if (!res.aborted) this.toast('Save failed', 'err');
    } catch (err) {
      console.error(err);
      this.toast('Export failed: ' + err.message, 'err', 5000);
    }
  }

  async openProject() {
    const file = await fsAccess.openFile('.pmap');
    if (!file) return;
    try {
      this.toast('Importing project…');
      const { manifest, world, entries } = await ProjectArchive.importPmap(file);
      // stage assets; only after full success do we switch worlds (atomic import)
      const stagedProject = { id: manifest.projectId, name: manifest.name, createdAt: manifest.createdAt, updatedAt: new Date().toISOString() };
      await this.storage.saveProjectMeta({ ...stagedProject, world });
      for (const a of manifest.assets || []) {
        const data = entries.get(a.path);
        if (data) await this.storage.putAsset(manifest.projectId, a.id, new Blob([data], { type: a.mime }), a);
        const prevPath = `previews/panoramas/${a.id}.webp`;
        if (entries.get(prevPath)) await this.storage.putAsset(manifest.projectId, `${a.id}:display`, new Blob([entries.get(prevPath)], { type: 'image/webp' }), { of: a.id });
        const thPath = `thumbnails/panoramas/${a.id}.webp`;
        if (entries.get(thPath)) await this.storage.putAsset(manifest.projectId, `${a.id}:thumb`, new Blob([entries.get(thPath)], { type: 'image/webp' }), { of: a.id });
      }
      const missing = [];
      for (const n of world.nodes || []) if (n.pano?.kind === 'asset' && n.pano.assetId && !manifest.assets?.some(a => a.id === n.pano.assetId)) { n.pano.missing = true; missing.push(n.id); }
      await this.loadWorldJson(world, { project: stagedProject, name: manifest.name });
      this.toast(`Opened “${manifest.name}”${missing.length ? ` — ${missing.length} panorama asset(s) missing (replaceable in the editor)` : ''}`, missing.length ? 'err' : 'ok', 5000);
    } catch (err) {
      console.error(err);
      this.toast('Could not open project: ' + err.message, 'err', 6000);
    }
  }

  persistPrefs() { prefsSvc.save({}); }

  /* ================= location card / debug ================= */
  refreshLocationUI() {
    const n = this.movement?.currentNode;
    if (!n) return;
    const g = this.graph;
    $('#locName').textContent = n.name;
    const zones = g.zones.zonesAt(n.x, n.y).map(id => g.zones.get(id)?.name).filter(Boolean);
    $('#locZone').textContent = zones[0] || g.name;
    $('#locPos').textContent = `${g.scale.pxToM(n.x).toFixed(1)} m, ${g.scale.pxToM(n.y).toFixed(1)} m`;
    $('#locDist').textContent = this.movement.distanceTravelledM >= 1000
      ? `${(this.movement.distanceTravelledM / 1000).toFixed(2)} km` : `${this.movement.distanceTravelledM.toFixed(1)} m`;
    const zid = zones.length ? g.zones.zonesAt(n.x, n.y)[0] : null;
    const d2 = zid ? g.zones.distanceToBoundaryM(zid, n.x, n.y) : null;
    $('#locBound').textContent = d2 != null ? `${d2.toFixed(1)} m ${d2 >= 0 ? 'inside' : 'outside'}` : '—';
    $('#locLinks').textContent = g.edgesOf(n.id).filter(e => !e.blocked).length + ' open';
    this.mapRenderer.setCurrent(n.id, this.viewer.view.yawDeg);
  }

  _startDebugOverlay() {
    setInterval(() => {
      const el = $('#debugOverlay');
      if (el.hidden || !this.graph) return;
      const g = this.graph;
      const n = this.movement?.currentNode;
      if (!n) return;
      const meta = this.cache.metaOf(n.id);
      const v = this.viewer.view;
      const zones = g.zones.zonesAt(n.x, n.y);
      const nearest = g.nearestLandmark(n.x, n.y);
      const report = meta?.autoComplete;
      const kv = (k, val) => `<div class="kv"><span class="k">${k}</span><span class="v">${val}</span></div>`;
      el.innerHTML = `<h4>Panorama Maps — debug</h4>`
        + kv('world', `${g.id} · perf:${this.perf}`)
        + kv('node', `${n.id}${n === this.selectedNodeId ? ' (sel)' : ''}`)
        + kv('x / y (px)', `${n.x.toFixed(1)} / ${n.y.toFixed(1)}`)
        + kv('x / y (m)', `${g.scale.pxToM(n.x).toFixed(1)} / ${g.scale.pxToM(n.y).toFixed(1)}`)
        + kv('zone', zones.join(', ') || '—')
        + kv('dist travelled', `${this.movement.distanceTravelledM.toFixed(1)} m`)
        + kv('step', `${g.scale.movement.stepPixels}px → ${g.scale.stepMeters().toFixed(1)}m (ppm ${g.scale.pixelsPerMeter})`)
        + kv('heading / pitch', `${v.yawDeg.toFixed(1)}° / ${v.pitchDeg.toFixed(1)}°`)
        + kv('pitch limits', `${this.viewer.pitchLimits.min.toFixed(0)}° … ${this.viewer.pitchLimits.max.toFixed(0)}°`)
        + kv('fov', `${v.fovDeg.toFixed(0)}°`)
        + kv('nearest landmark', nearest ? `${nearest.landmark.name} ${nearest.distanceM.toFixed(0)}m @ ${nearest.bearingDeg.toFixed(0)}°` : '—')
        + `<div class="sec"></div>`
        + kv('pano provider', meta?.provider ?? '—')
        + kv('phash', meta?.phash ? meta.phash.slice(0, 16) + '…' : '—')
        + kv('gen attempt', meta?.generationAttempt ?? '—')
        + kv('continuity sim', meta?.validation?.sim != null ? meta.validation.sim.toFixed(2) + ` (need ≥ ${meta.validation.expectedMin?.toFixed(2) ?? '—'})` : '—')
        + kv('cache', `${this.cache.decodedCount}/${this.cache.capacity} decoded`)
        + kv('AutoComplete', this.acEnabled ? (report?.complete === false ? `repaired T${report.topMissingPct.toFixed(1)}% B${report.bottomMissingPct.toFixed(1)}%` : 'on · complete') : 'OFF')
        + kv('render', `${meta?.renderMs ?? '—'} ms`);
      // heading cone follows the live view
      const needle = $('#compassNeedle');
      if (needle && this._viewDirty) { needle.style.transform = `rotate(${(-v.yawDeg)}deg)`; this._viewDirty = false; this.refreshLocationUI(); }
    }, 160);
  }

  toast(msg, kind = null, ms = 3000) {
    const host = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 420); }, ms);
  }

  /* ================= keyboard ================= */
  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === 'Escape') { this.closePanels(); $('#worldMenu').classList.remove('open'); return; }
      if (e.key === 'Enter' && this.simpleEditor.isOpen) { this.simpleEditor.onEnterKey(); return; }

      const dir = KEY_DIRS[e.code];
      if (dir) {
        e.preventDefault();
        if (this.movement?.state === 'walking' && (e.repeat || dir)) {
          // chain intent: the walk continues in the held direction on arrival
          this._pendingDir = dir;
          this._lastMove = { relativeDir: dir };
        } else this.tryMove(dir);
        return;
      }
      switch (e.code) {
        case 'KeyQ': this.viewer.look(-7, 0); break;
        case 'KeyE': this.viewer.look(7, 0); break;
        case 'KeyR': this.viewer.look(0, 5); break;
        case 'KeyF': this.viewer.look(0, -5); break;
        case 'Equal': case 'NumpadAdd': this.viewer.setFov(this.viewer.view.fovDeg - 4); break;
        case 'Minus': case 'NumpadSubtract': this.viewer.setFov(this.viewer.view.fovDeg + 4); break;
        case 'Digit0': this.viewer.view.yawDeg = 0; this.viewer.setFov(75); break;
      }
    });
    document.addEventListener('keyup', (e) => {
      const dir = KEY_DIRS[e.code];
      if (dir && this._pendingDir === dir) this._pendingDir = null;
    });
  }

  _registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return;
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/* ---------------- small helpers ---------------- */
function sampleCanvas(source, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function placeholderCanvas(title, sub) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#8b94a3'; ctx.font = '600 30px system-ui'; ctx.textAlign = 'center';
  ctx.fillText(title, c.width / 2, c.height / 2 - 8);
  ctx.font = '18px system-ui';
  ctx.fillText(sub, c.width / 2, c.height / 2 + 26);
  return c;
}

async function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/* ---------------- boot ---------------- */
const app = new App();
app.boot().catch(err => {
  console.error('boot failed', err);
  document.querySelector('#panoLoading').innerHTML = `<div style="text-align:center"><strong>Something went wrong.</strong><br><span style="font-size:12px">${escapeHtml(err.message)}</span></div>`;
});
window.app = app;   // deliberate: debugging + tests hook
