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
import { sharpenCanvas } from './viewer/sharpen.js';
import { smoothCanvas, seamBlendCanvas } from './viewer/smooth.js';
import { ProceduralWorldProvider } from './gen/provider.js';
import { GenerationContextBuilder } from './gen/context.js';
import { PanoramaCache, prefetchPlan } from './gen/cache.js';
import { rgbHist, histIntersect, expectedMinSimilarity } from './gen/util.js';
import { MapRenderer } from './map/map-renderer.js';
import { SimpleEditor } from './editors/simple-editor.js';
import { AdvancedEditor } from './editors/advanced-editor.js';
import { ScriptStudio } from './editors/script-editor.js';
import { Landing } from './ui/landing.js';
import { ProjectStorage, AssetManager, ProjectArchive, fsAccess, prefs as prefsSvc } from './io/storage.js';
import { Desktop } from './io/desktop.js';
import {
  exportPworld, importPworld, collectWorldAssets, inspectPworld,
  pworldFilename, formatBytes, worldFileProblem,
} from './io/pworld.js';
import { WorldLibrary } from './ui/world-library.js';

/* Living-world accessories: every animated layer can follow the world
   ('auto'), or be forced ON/OFF by the user (persisted in prefs).       */
const ACCESSORY_DEFS = [
  { key: 'birds',       label: 'Birds',               hint: 'seeded flocks drifting the sky' },
  { key: 'clouds',      label: 'Clouds',              hint: 'lazy cumulus on fair days' },
  { key: 'actors',      label: 'Villagers & pets',    hint: 'walkers, dogs and cats on coded routes' },
  { key: 'rabbits',     label: 'Rabbits',             hint: 'hopping through nearby meadows' },
  { key: 'butterflies', label: 'Butterflies',         hint: 'fluttering over the flowers' },
  { key: 'fireflies',   label: 'Fireflies',           hint: 'glowing drift on clear nights' },
  { key: 'night',       label: 'Stars & meteors',     hint: 'night sky + the odd shooting star' },
  { key: 'sunrays',     label: 'Sun rays',            hint: 'breathing shafts around the sun' },
  { key: 'balloon',     label: 'Hot-air balloons',    hint: 'stately drifters on fair days' },
  { key: 'owl',         label: 'Night owl',           hint: 'a silent glide every so often' },
  { key: 'mist',        label: 'Mist banks',          hint: 'low ground fog at dawn & dusk' },
  { key: 'ripples',     label: 'Water ripples',       hint: 'rings on ponds, rivers and lakes' },
  { key: 'rain',        label: 'Rain',                hint: 'drizzle overlay (Rain / Storm modes)' },
  { key: 'snow',        label: 'Snow',                hint: 'falling snow (Snow mode)' },
  { key: 'storm',       label: 'Storm force',         hint: 'driving rain + lightning flashes' },
  { key: 'sway',        label: 'Camera sway',         hint: 'gentle head-bob while walking' },
  { key: 'breeze',      label: 'Idle breeze',         hint: 'soft view drift when standing still' },
];

/* Scene (time-of-day & weather) selector: the six-mode row that used to be
   six wide buttons in the topbar is now ONE compact button + popup. This
   table is the single source of truth — availability comes from the world
   (urlset variants or coded-world presets), everything else from here. */
const SCENE_MODES = {
  day:   { icon: 'i-sun',   label: 'Day',   tip: 'Clear daylight' },
  dawn:  { icon: 'i-dawn',  label: 'Dawn',  tip: 'Golden hour — low sun, long rays' },
  rain:  { icon: 'i-rain',  label: 'Rain',  tip: 'Overcast drizzle, wet panoramas' },
  storm: { icon: 'i-storm', label: 'Storm', tip: 'Driving rain, gusts, lightning' },
  night: { icon: 'i-moon',  label: 'Night', tip: 'Stars, fireflies, window glow' },
  snow:  { icon: 'i-snow',  label: 'Snow',  tip: 'Falling snow, bright drifts' },
};

/* panorama kinds that carry one photo per scene mode (day / rain / night) */
const MODE_KINDS = new Set(['urlset', 'embedded']);

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
    this.accessory = { ...(this.prefs.accessory || {}) };   // key → true | false | undefined(auto)
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
    // desktop build? (a local database serving this app — probed at boot)
    this.desktop = Desktop;
    // images that arrived inside an opened `.pworld` file, before they are
    // staged anywhere: assetId → {blob, mime, meta}. This is what makes a file
    // walkable the moment it is opened, even on a machine that never saw it.
    this._sessionAssets = new Map();
    this._assetUrls = new Map();          // assetId → object URL (capped)
    this._pworldBusy = false;
    this._searchIndex = [];
    this.displayMode = 'day';             // scene mode for worlds with variants
    this.viewPrefs = { movePad: true, map: true, locCard: true, compass: true, sharpen: { on: false, amt: 0.55 }, smooth: { on: false, amt: 0.5 }, speed: 65, speedV: 2, ...(this.prefs.view || {}) };
    // default 'walk': stride-by-stride dolly — same panorama 5 m closer,
    // repeated — so hops read as walking, never a jump (user directive)
    this.motion = { style: 'walk', amount: 80, dur: 0, ...(this.prefs.motion || {}) };
    // migrate the v1 speed scale (1.4 m/s was its middle — felt like walking
    // in mud): reset everyone to the v2 default once
    if ((this.viewPrefs.speedV ?? 1) < 2) { this.viewPrefs.speed = 65; this.viewPrefs.speedV = 2; }
    // phones: start with a clean canvas; widgets come back from the FAB/menu
    if (!this.prefs.view && window.matchMedia?.('(max-width: 700px)').matches) {
      this.viewPrefs.map = false; this.viewPrefs.locCard = false;
    }

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
    this.mapRenderer.onNodeClick = (n, e) => this._openNodeMenu(n, e);

    this.simpleEditor = new SimpleEditor(this);
    this.advancedEditor = new AdvancedEditor(this);
    this.scriptStudio = new ScriptStudio(this);

    this._bindChrome();
    this._bindKeyboard();
    this._bindFileDrop();
    this._bindBus();
    await this._restoreLastWorld();

    this.viewer.renderer.resize();
    this.mapRenderer.resize();
    this._wireNodeMenu();
    this._startDebugOverlay();
    this._registerServiceWorker();
    this._applyViewPrefs();

    // desktop build: a real database behind this same app. Probe once; when it
    // answers, the Worlds surface grows its library / versions / activity tabs.
    await Desktop.probe();
    if (Desktop.online) {
      document.body.classList.add('desktop-build');
      console.info(`[desktop] worlds database: ${Desktop.dbEngine} · ${Desktop.dbPath}`);
    }
    this.worldLibrary = new WorldLibrary(this);

    // start screen — pick a demo, a create-mode, or open a project
    this.landing = new Landing(this);
    if (!this.prefs.hideLanding) this.landing.show();
    this._handleDeepLink();
    // ... and again whenever the address changes, so a link or the desktop
    // window's menu works whether or not the app was already open
    window.addEventListener('hashchange', () => this._handleDeepLink());

    $('#panoLoading').classList.remove('show');
  }

  savePrefs(patch = {}) { prefsSvc.save(patch); }

  /** Deep links, used by the desktop window's File menu and by anyone who
      likes URLs: `#worlds`, `#save-world`, `#open-world`. */
  _handleDeepLink() {
    const link = (location.hash || '').replace(/^#/, '').toLowerCase();
    if (!link) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* file:// */ }
    if (link === 'worlds') { this.landing?.hide(); this.worldLibrary?.open('library'); }
    else if (link === 'save-world') { this.landing?.hide(); this.worldLibrary?.open('save'); }
    else if (link === 'open-world') { this.landing?.hide(); this.openAnyFile(); }
  }

  _setWorldName(n) {
    document.title = `Panorama Maps · ${n}`;
    const host = document.getElementById('locName');
    if (host?.dataset) host.dataset.world = n;
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
    this._setWorldName(def.name);
    await this._adoptWorld(built.graph, {
      projectId: built.graph.id, name: def.name, blurb: def.blurb,
      startNodeId: built.startNodeId,
    });
  }

  async loadWorldJson(json, { project = null, name = null, sessionAssets = null } = {}) {
    // images that came inside an opened file live for this session; anything
    // else means a fresh world, so nothing stale may leak in
    this._sessionAssets = new Map(sessionAssets || []);
    const graph = WorldGraph.fromJSON(json);
    this._setWorldName(name || graph.name);
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
    this.project.author ??= '';
    this.project.description ??= (blurb || '');
    this.project.tags ??= [];
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
    this._syncModeGroup();
    this._applySpeed();
    this._applyMotion();
    prefsSvc.save({ lastProjectId: projectId });
    this.project.updatedAt = new Date().toISOString();
    // every way a world becomes current ends here, so the Worlds panel always
    // describes the world you are actually in
    this.worldLibrary?.worldChanged();
    await this.storage.saveProjectMeta({ ...this.project, world: graph.toJSON() }).catch(() => {});
  }

  panoramaWarmHint(blurb) {
    if (blurb) this.toast(blurb, 'ok', 5200);
  }

  /* ================= panorama pipeline =================
     Cache check, then full context generation with light continuity checks,
     AutoComplete analysis, a transition that never goes blank, prefetch (Spec §70). */
  async _ensurePanorama(nodeId, { fromId = null, relativeDir = null } = {}) {
    const node = this.graph.getNode(nodeId);
    const distanceM = fromId ? this._edgeDist(fromId, nodeId) : null;
    const context = this.ctxBuilder.build({
      targetNodeId: nodeId, fromNodeId: fromId && fromId !== nodeId ? fromId : null,
      movement: distanceM ? { direction: relativeDir, distanceM } : null,
      camera: { yawDeg: this.viewer.view.yawDeg, pitchDeg: this.viewer.view.pitchDeg, fovDeg: this.viewer.view.fovDeg, height: node.camera?.height ?? 1.7 },
    });

    const cacheKey = MODE_KINDS.has(node.pano?.kind) ? `${nodeId}@${this.displayMode}` : nodeId;
    const entry = await this.cache.get(cacheKey, async (priorMeta) => {
      let produced;
      if (node.pano?.kind === 'urlset') {
        produced = await this._renderUrlPanorama(node, priorMeta);
      } else if (node.pano?.kind === 'embedded' && node.pano.variants) {
        produced = await this._renderEmbeddedPanorama(node, priorMeta);
      } else if (node.pano?.kind === 'asset' && node.pano.assetId) {
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

  /** Photographic world asset: bundled panorama URL per display mode. */
  async _renderUrlPanorama(node, priorMeta) {
    const variants = node.pano?.variants || {};
    const url = variants[this.displayMode] ?? Object.values(variants)[0];
    if (!url) return { canvas: placeholderCanvas('No panorama variant', 'This location has no image for the current mode'), meta: { nodeId: node.id, provider: 'none', missing: true } };
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width; canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0, bmp.width, bmp.height);
      bmp.close?.();
      return {
        canvas,
        meta: {
          nodeId: node.id, provider: 'photo-ai', mode: this.displayMode, url,
          seed: hashStrLocal(url), promptVersion: 1,
          generationAttempt: (priorMeta?.generationAttempt ?? 0) + 1,
        },
      };
    } catch (err) {
      return { canvas: placeholderCanvas('Photo panorama unavailable', url), meta: { nodeId: node.id, provider: 'photo-ai', missing: true, error: String(err) } };
    }
  }

  /* ---------- display modes (day / rain / night) ----------
     Asset-pack worlds ship fixed photo variants (urlset) — modes swap files.
     Coded (procedural) worlds render from the shared world model, so the same
     three modes become ENVIRONMENT presets: rain flips weather → the drizzle
     overlay, fog and wet light all come along for free (Spec §17, one switch). */
  _syncModeGroup() {
    const group = $('#modeGroup');
    let photo = null, generated = false;
    this._photoModes = null;
    if (this.graph) {
      for (const n of this.graph.nodes.values()) {
        if (!photo && MODE_KINDS.has(n.pano?.kind) && n.pano.variants) photo = Object.keys(n.pano.variants);
        if (n.pano?.kind === 'generated') generated = true;
      }
    }
    // photographed worlds (bundled urlset or embedded photo sets) swap frames;
    // coded worlds turn the same names into environment presets
    this._photoModes = photo;
    const modes = photo || (generated ? ['day', 'rain', 'night', 'dawn', 'snow', 'storm'] : null);
    this._urlsetModes = photo;
    if (!modes?.length) {
      group.hidden = true; this._sceneModesList = [];
      const pop0 = $('#scenePop'); if (pop0) { pop0.classList.remove('open'); pop0.textContent = ''; }
      return;
    }
    if (!modes.includes(this.displayMode)) this.displayMode = modes[0];
    group.hidden = false;
    this._sceneModesList = modes;
    this._syncSceneFace();
    this._paintScenePop();
  }

  _syncSceneFace() {
    const def = SCENE_MODES[this.displayMode] || SCENE_MODES.day;
    $('#sceneUse')?.setAttribute('href', `#${def.icon}`);
    const t = $('#sceneTxt'); if (t) t.textContent = def.label;
  }

  _paintScenePop() {
    const pop = $('#scenePop'); if (!pop) return;
    pop.textContent = '';
    const lab = document.createElement('div');
    lab.className = 'lab'; lab.textContent = 'Scene';
    pop.appendChild(lab);
    for (const key of this._sceneModesList || []) {
      const def = SCENE_MODES[key]; if (!def) continue;
      const on = key === this.displayMode;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'mi'; b.dataset.mode = key; b.title = def.tip;
      b.innerHTML = `<svg class="ic"><use href="#${def.icon}"/></svg><span class="grow">${def.label}<small>${def.tip}</small></span>` +
        `<span class="chk">${on ? '<svg><use href="#i-check"/></svg>' : ''}</span>`;
      b.classList.toggle('on', on);
      b.addEventListener('click', () => { this.setDisplayMode(key); pop.classList.remove('open'); });
      pop.appendChild(b);
    }
  }

  setDisplayMode(mode) {
    if (mode === this.displayMode) return;
    this.displayMode = mode;
    this._syncSceneFace?.();
    const id = this.movement?.currentNodeId;
    if (!this._photoModes && id && this.graph?.environment) {
      /* Coded world: mode ⇒ environment patch, then ONE regeneration pass.
         Sun rez raised at night so the crescent reads crisp in a dark sky. */
      const ENV = {
        day:   { timeOfDay: 'day', weather: 'clear' },
        rain:  { timeOfDay: 'overcast', weather: 'rain' },
        night: { timeOfDay: 'night', weather: 'clear', sunElevationDeg: 38 },
        dawn:  { timeOfDay: 'golden', weather: 'clear' },
        snow:  { timeOfDay: 'overcast', weather: 'snow' },
        storm: { timeOfDay: 'overcast', weather: 'storm' },
      };
      this.setEnvironment(ENV[mode] ?? ENV.day);
      this._syncModeGroup();
      this.toast(`Environment: ${mode}`, 'ok', 1600);
      return;
    }
    if (!id) return;
    // mode keys are part of the cache key (`node@mode`), so every variant stays
    // cached independently — flipping modes is free, nothing to drop, and the
    // node identity invariant (same node = same imagery) still holds per mode.
    this._enterNode(id, { teleport: true });
    this._syncModeGroup();
    this.toast(`Display mode: ${mode}`, 'ok', 1600);
  }

  /** Live environment apply: weather/time-of-day regenerate panoramas AND
      drive the on-screen effects (rain weather ⇒ drizzle on). Spec §17 —
      one switch, not two conflicting toggles. */
  setEnvironment(patch) {
    Object.assign(this.graph.environment, patch);
    const env = this.graph.environment;
    this.viewer.immersion.rain = env.weather === 'rain' || env.weather === 'storm';
    this.viewer.immersion.storm = env.weather === 'storm';
    this.viewer.immersion.snow = env.weather === 'snow';
    this._applyAccessory();
    this.cache.clearDecoded();
    const id = this.movement?.currentNodeId;
    if (id) this._enterNode(id, { teleport: true });
    this.notifyMapChanged();
  }

  async _renderAssetPanorama(node, priorMeta) {
    const img = await this._imageFromAsset(node.pano.assetId);
    if (!img) {
      node.pano.missing = true;
      const canvas = placeholderCanvas('Panorama image missing', 'Replace it in the advanced editor with Upload panorama');
      return { canvas, meta: { nodeId: node.id, provider: 'asset', assetId: node.pano.assetId, missing: true, seed: priorMeta?.seed ?? null, generationAttempt: (priorMeta?.generationAttempt ?? 0) + 1 } };
    }
    return {
      canvas: img.canvas,
      meta: {
        nodeId: node.id, provider: 'asset', assetId: node.pano.assetId,
        seed: priorMeta?.seed ?? null, promptVersion: 1,
        generationAttempt: (priorMeta?.generationAttempt ?? 0) + 1,
      },
    };
  }

  /**
   * A photo set that came INSIDE a `.pworld` file: one embedded image per
   * scene mode. Reads the pixels from the file's assets (session store, the
   * local mirror, or the desktop database) — never from the original website.
   * A mode that could not be embedded while saving keeps its link as a
   * fallback, so a partly embedded world still walks.
   */
  async _renderEmbeddedPanorama(node, priorMeta) {
    const variants = node.pano?.variants || {};
    const fallbacks = node.pano?.fallbackVariants || {};
    let assetId = null, mode = null;
    for (const m of [this.displayMode, ...Object.keys(variants)]) {
      if (variants[m]) { assetId = variants[m]; mode = m; break; }
    }
    if (assetId) {
      const img = await this._imageFromAsset(assetId);
      if (img) {
        return {
          canvas: img.canvas,
          meta: {
            nodeId: node.id, provider: 'embedded', mode, assetId,
            source: node.pano.origins?.[mode] || node.pano.source || null,
            embedded: true, seed: priorMeta?.seed ?? null,
            generationAttempt: (priorMeta?.generationAttempt ?? 0) + 1,
          },
        };
      }
    }
    for (const m of [this.displayMode, ...Object.keys(fallbacks)]) {
      if (fallbacks[m]) {
        return this._renderUrlPanorama({ ...node, pano: { kind: 'urlset', variants: { [m]: fallbacks[m] } } }, priorMeta);
      }
    }
    const canvas = placeholderCanvas('Panorama image missing', 'This world file has no image for this scene mode');
    return { canvas, meta: { nodeId: node.id, provider: 'embedded', missing: true, seed: priorMeta?.seed ?? null, generationAttempt: (priorMeta?.generationAttempt ?? 0) + 1 } };
  }

  /**
   * The one place images come from, in order of freshness:
   *   1. images that arrived inside an opened `.pworld` file (session)
   *   2. the browser's local mirror of the project (IndexedDB)
   *   3. the desktop database (any world it holds, worldId/assetId over HTTP)
   * Returns null when the image genuinely is not on this machine any more.
   */
  async assetBlob(assetId, worldId = null) {
    if (!assetId) return null;
    const pid = worldId || this.project?.id;
    for (const key of [`${assetId}:display`, assetId]) {
      const inSession = this._sessionAssets.get(key);
      if (inSession?.blob) return inSession.blob;
      const rec = await this.storage.getAsset(pid, key).catch(() => null);
      if (rec?.blob) return rec.blob;
    }
    if (this.desktop?.online && pid) {
      for (const kind of ['display', null]) {
        try {
          const res = await fetch(this.desktop.assetUrl(pid, assetId, kind), { cache: 'force-cache' });
          if (res.ok) return await res.blob();
        } catch { /* database unreachable — treat as missing */ }
      }
    }
    return null;
  }

  /** Decode any stored image straight to a canvas (pixel-exact, no scaling). */
  async _imageFromAsset(assetId) {
    const blob = await this.assetBlob(assetId);
    if (!blob) return null;
    try {
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width; canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0, bmp.width, bmp.height);
      bmp.close?.();
      return { canvas, blob };
    } catch { return null; }
  }

  /** Apply AutoComplete presentation choice + pitch limits + Sharpen for the CURRENT node. */
  async _present(entry) {
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
    // wrap seam care: always soften the equirect cut line once per source
    // (the generated village frames blur poorly at the rectangle ends)
    if (display?.width && display.width > 64) {
      if (entry._seam?.src === display) display = entry._seam.canvas;
      else {
        const soft = seamBlendCanvas((() => { const c = document.createElement('canvas'); c.width = display.width; c.height = display.height; c.getContext('2d').drawImage(display, 0, 0); return c; })());
        entry._seam = { src: display, canvas: soft };
        display = soft;
      }
    }
    const sm = this.viewPrefs.smooth;
    if (sm?.on && (sm.amt ?? 0) > 0.02 && display?.width) {
      if (entry._smooth?.amt === sm.amt && entry._smooth.src === display) display = entry._smooth.canvas;
      const canvas = await smoothCanvas(display, sm.amt ?? 0.55).catch(() => null);
      if (canvas) { entry._smooth = { canvas, amt: sm.amt, src: display }; display = canvas; }
    }
    const sh = this.viewPrefs.sharpen;
    if (sh?.on && (sh.amt ?? 0) > 0.02 && display?.width) {
      if (entry._sharp?.amt === sh.amt && entry._sharp.src === display) return entry._sharp.canvas;
      const canvas = await sharpenCanvas(display, sh.amt ?? 0.55).catch(() => null);
      if (canvas) { entry._sharp = { canvas, amt: sh.amt, src: display }; display = canvas; }
    }
    return display;
  }

  /* ================= movement / arrival ================= */
  /** Accessory overrides: undefined = follow the world; true/false = forced. */
  _applyAccessory() {
    if (!this.viewer) return;
    for (const d of ACCESSORY_DEFS) {
      const o = this.accessory?.[d.key];
      if (o === true) this.viewer.immersion[d.key] = true;
      else if (o === false) this.viewer.immersion[d.key] = false;
    }
  }

  /** Paint the Accessory popup rows: switch shows the EFFECTIVE state,
      the 'auto' pill shows whether the world is still in charge. */
  _paintAccessoryPop() {
    const host = $('#acRows');
    if (!host) return;
    const esc1 = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    host.innerHTML = ACCESSORY_DEFS.map(d => {
      const forced = this.accessory?.[d.key];
      const effective = forced ?? !!this.viewer?.immersion[d.key];
      return `<label class="switch ac-row${forced === undefined ? ' auto' : ''}">
        <span><span class="lab">${esc1(d.label)}</span><span class="sub">${esc1(d.hint)}</span></span>
        <span class="ac-auto" title="This effect follows the world">${forced === undefined ? 'auto' : 'forced'}</span>
        <span class="tswitch"><input type="checkbox" data-ac="${d.key}" ${effective ? 'checked' : ''} aria-label="${esc1(d.label)}"><span class="track"></span></span>
      </label>`;
    }).join('');
  }

  _bindBus() {
    this.bus.on('move:blocked', ({ relativeDir }) => {
      const btn = document.querySelector(`#movePad .mbtn[data-dir="${relativeDir}"]`);
      if (btn) { btn.classList.remove('blockshake'); void btn.offsetWidth; btn.classList.add('blockshake'); }
      const cv = document.getElementById('panoCanvas');             // red edge pulse: the world itself says "no"
      if (cv) { cv.classList.remove('pathdeny'); void cv.offsetWidth; cv.classList.add('pathdeny'); }
      this.toast('No path that way', null, 1400);
    });
    this.bus.on('walk:started', ({ to, from }) => {
      // start warming the destination while we glide, so the transition at
      // arrival is a cache hit (Spec: never blank, never waiting)
      this._ensurePanorama(to, { fromId: from }).catch(() => {});
      const mc = document.getElementById('mapCanvas');              // cyan pulse on the map
      if (mc) { mc.classList.remove('walkpulse'); void mc.offsetWidth; mc.classList.add('walkpulse'); }
    });
    this.bus.on('walk:progress', (pos) => { this.mapRenderer.setWalkProgress(pos); });
    this.bus.on('position:changed', async ({ nodeId, edge, fromId, teleport }) => {
      this.mapRenderer.setWalkProgress(null);
      this._lastDistM = edge?.distM ?? this._lastDistM ?? 0;
      await this._enterNode(nodeId, { fromId, teleport, relativeDir: this._lastMove?.relativeDir ?? null, distM: this._lastDistM });
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

  async _enterNode(nodeId, { fromId = null, teleport = false, relativeDir = null, initial = false, distM = 0 } = {}) {
    const node = this.graph.getNode(nodeId);
    if (!node) return;
    // coded worlds declare ambient life in the model (`environment.animals`) —
    // the viewer's seeded flock follows the world, not the screen (§17)
    const envW = this.graph.environment || {};
    const animals = envW.animals || [];
    const clearSky = (envW.weather ?? 'clear') === 'clear';
    const tod = envW.timeOfDay ?? 'day';
    this.viewer.immersion.birds = animals.includes('birds');
    this.viewer.immersion.clouds = clearSky && tod !== 'night';
    // the living-world layer cake: stars & fireflies own the night, butterflies
    // and sun shafts own fair daylight, snow falls when the world says so
    this.viewer.immersion.night = tod === 'night';
    this.viewer.immersion.fireflies = tod === 'night' && clearSky;
    this.viewer.immersion.butterflies = animals.includes('butterflies') && clearSky && (tod === 'day' || tod === 'golden');
    this.viewer.immersion.sunrays = clearSky && (tod === 'day' || tod === 'golden');
    this.viewer.immersion.snow = envW.weather === 'snow';
    // wave 2: storm, balloons, the night watch, dawn mist, meadow rabbits,
    // and ripples on every patch of water the world coded in
    this.viewer.immersion.rain = envW.weather === 'rain' || envW.weather === 'storm';
    this.viewer.immersion.storm = envW.weather === 'storm';
    this.viewer.immersion.balloon = clearSky && (tod === 'day' || tod === 'golden');
    this.viewer.immersion.owl = tod === 'night' && clearSky;
    this.viewer.immersion.mist = tod === 'golden' || tod === 'dusk';
    this.viewer.immersion.rabbits = clearSky && tod === 'day';
    const ppmW = this.graph.scale?.pixelsPerMeter ?? 2;
    this._envWater = (envW.features || [])
      .filter(f => f.type === 'region' && f.kind === 'water')
      .slice(0, 4)
      .map(f => f.shape === 'circle'
        ? { xM: (f.cx ?? 0) / ppmW, yM: (f.cy ?? 0) / ppmW, spreadM: ((f.radiusPx ?? 8) / ppmW) * 1.4 }
        : { xM: ((f.x ?? 0) + (f.w ?? 0) / 2) / ppmW, yM: ((f.y ?? 0) + (f.h ?? 0) / 2) / ppmW, spreadM: Math.min(f.w ?? 0, f.h ?? 0) / ppmW * 0.8 });
    // animated actors: hand the viewer this node's position (meters) so it can
    // project the coded walkers of environment.actors into the live view
    const ppmA = this.graph.scale?.pixelsPerMeter ?? 2;
    this.viewer.anchors = {
      xM: node.x / ppmA, yM: node.y / ppmA,
      headingDeg: node.headingDeg ?? 0,
      actors: envW.actors ?? [],
      timeOfDay: tod,
      sun: { azDeg: envW.sunAzimuthDeg ?? 118, elDeg: envW.sunElevationDeg ?? 34 },
      water: this._envWater ?? [],
    };
    this._applyAccessory();   // user overrides ride on top of the world's defaults
    this.bus.emit('debug:node', nodeId);
    this.mapRenderer.setCurrent(nodeId, this.viewer.view.yawDeg);

    const entry = await this._ensurePanorama(nodeId, { fromId, relativeDir });
    if (this.movement.currentNodeId !== nodeId && !initial) return; // superseded by a newer arrival

    const display = await this._present(entry);
    const heading = node.headingDeg ?? 0;
    if (initial) {
      this.viewer.setImageNow(display, heading);
    } else {
      await this.viewer.transitionTo(display, heading, {
        direction: relativeDir,
        distM, teleport,
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
    this._closeNodeMenu?.();
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
    on('#homeBtn', 'click', () => { this.landing?.show(); this.closePanels(); });
    on('#backBtn', 'click', () => { this.landing?.show(); this.closePanels(); });
    on('#studioBtn', 'click', () => this._studioClicked());
    $('#worldsBtn')?.addEventListener('click', () => this.worldLibrary?.toggle());
    this._syncWorldsBtn?.();
    this._syncStudioBtn();
    on('#compass', 'click', () => { this.viewer.view.yawDeg = 0; });

    // overflow menu (…)
    const mm = $('#mainMenu');
    on('#menuBtn', 'click', () => {
      if (mm.classList.contains('open')) { mm.classList.remove('open'); return; }
      this._buildMainMenu();
      this._placePop(mm, '#menuBtn');
      mm.classList.add('open');
    });
    document.addEventListener('click', (e) => {
      if (!mm.contains(e.target) && !$('#menuBtn').contains(e.target)) mm.classList.remove('open');
      const sp = $('#studioPop');
      if (sp && !sp.contains(e.target) && !$('#studioBtn').contains(e.target)) sp.classList.remove('open');
    });

    // scene selector: one compact topbar button opens the mode popup
    const sceneBtn = $('#sceneBtn'), scenePop = $('#scenePop');
    sceneBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (scenePop.classList.contains('open')) { scenePop.classList.remove('open'); sceneBtn.setAttribute('aria-expanded', 'false'); return; }
      this._paintScenePop();
      this._placePop(scenePop, '#sceneBtn');
      scenePop.classList.add('open');
      sceneBtn.setAttribute('aria-expanded', 'true');
    });
    document.addEventListener('click', (e) => {
      if (!scenePop.contains(e.target) && !sceneBtn.contains(e.target)) scenePop.classList.remove('open');
    });

    // move pad
    document.querySelectorAll('#movePad .mbtn').forEach(b => {
      b.addEventListener('click', () => this.tryMove(b.dataset.dir));
    });

    // double click (or double tap) on the panorama: turn toward the
    // clicked point and walk that way — same graph pipeline as W
    $('#panoCanvas').addEventListener('dblclick', (ev) => {
      const r = $('#panoCanvas').getBoundingClientRect();
      const dx = ((ev.clientX - r.left) / Math.max(1, r.width)) - 0.5;
      this.viewer.view.yawDeg = ((this.viewer.view.yawDeg + dx * this.viewer.view.fovDeg) % 360 + 360) % 360;
      this.tryMove('forward');
    });

    // walk speed slider (bottom left, persisted, live)
    const sp = $('#speedRange');
    if (sp && !sp.dataset.bound) {
      sp.dataset.bound = '1';
      const paint = () => sp.style?.setProperty?.('--fill', `${sp.value}%`);
      sp.addEventListener('input', () => {
        paint();
        this.viewPrefs.speed = +sp.value;
        this._applySpeed();
        prefsSvc.save({ view: this.viewPrefs });
      });
      paint();
    }
    if (sp) { sp.value = String(this.viewPrefs.speed ?? 65); sp.style?.setProperty?.('--fill', `${sp.value}%`); }

    // Motion settings popup (blur / morph / fade "fake walking" feel)
    const mp = $('#motionPop');
    if (mp && !mp.dataset.bound) {
      mp.dataset.bound = '1';
      on('#motionBtn', 'click', () => {
        if (mp.classList.contains('open')) { mp.classList.remove('open'); return; }
        this._paintMotionPop();
        this._placePop(mp, '#motionBtn');
        mp.classList.add('open');
      });
      document.addEventListener('click', (e) => {
        if (mp.classList.contains('open') && !mp.contains(e.target) && !$('#motionBtn').contains(e.target)) mp.classList.remove('open');
      });
      mp.addEventListener('keydown', (e) => { if (e.key === 'Escape') mp.classList.remove('open'); });
      $('#mStyle').addEventListener('click', (e) => {
        const b = e.target.closest('[data-ms]');
        if (!b) return;
        this.motion.style = b.dataset.ms;
        prefsSvc.save({ motion: this.motion });
        this._applyMotion();
        this._paintMotionPop();
      });
      $('#mAmt').addEventListener('input', () => {
        this.motion.amount = +$('#mAmt').value;
        prefsSvc.save({ motion: this.motion });
        this._applyMotion();
        $('#mAmtVal').textContent = `${this.motion.amount}%`;
      });
      $('#mDur').addEventListener('input', () => {
        this.motion.dur = +$('#mDur').value;
        prefsSvc.save({ motion: this.motion });
        this._applyMotion();
        this._paintMotionDur();
      });
    }

    // Accessory popup — every living-world effect gets a user toggle
    const ap = $('#accessoryPop');
    if (ap && !ap.dataset.bound) {
      ap.dataset.bound = '1';
      on('#accessoryBtn', 'click', () => {
        if (ap.classList.contains('open')) { ap.classList.remove('open'); return; }
        this._paintAccessoryPop();
        this._placePop(ap, '#accessoryBtn');
        ap.classList.add('open');
      });
      document.addEventListener('click', (e) => {
        if (ap.classList.contains('open') && !ap.contains(e.target) && !$('#accessoryBtn').contains(e.target)) ap.classList.remove('open');
      });
      ap.addEventListener('keydown', (e) => { if (e.key === 'Escape') ap.classList.remove('open'); });
      $('#acRows').addEventListener('change', (e) => {
        const input = e.target.closest('input[data-ac]');
        if (!input) return;
        this.accessory[input.dataset.ac] = input.checked;          // explicit force
        prefsSvc.save({ accessory: this.accessory });
        this._applyAccessory();
        this._paintAccessoryPop();
        const def = ACCESSORY_DEFS.find(d => d.key === input.dataset.ac);
        this.toast(`${def?.label ?? input.dataset.ac}: ${input.checked ? 'on' : 'off'}`, 'ok', 1100);
      });
      $('#acReset').addEventListener('click', () => {
        this.accessory = {};
        prefsSvc.save({ accessory: this.accessory });
        this._applyAccessory();
        this._paintAccessoryPop();
        this.toast('Effects follow the world again', 'ok', 1500);
      });
    }

    // map widget controls (+ hide → FAB)
    on('#mapZoomIn', 'click', () => this.mapRenderer.zoomBy(1.3));
    on('#mapZoomOut', 'click', () => this.mapRenderer.zoomBy(1 / 1.3));
    on('#mapFit', 'click', () => this.mapRenderer.fit());
    on('#mapExpand', 'click', () => {
      const w = $('#mapWidget');
      w.classList.toggle('full');
      setTimeout(() => this.mapRenderer.resize(), 260);
    });
    on('#mapHide', 'click', () => { this.viewPrefs.map = false; this._applyViewPrefs(); prefsSvc.save({ view: this.viewPrefs }); });
    on('#lcHide', 'click', () => { this.viewPrefs.locCard = false; this._applyViewPrefs(); prefsSvc.save({ view: this.viewPrefs }); });

    // Sharpen applies to the panorama SOURCE once per node/amount and is
    // cached alongside the entry (see _present) — the viewer loop stays free.

    // search
    const si = $('#searchInput');
    si.addEventListener('input', () => this._renderSearch(si.value.trim()));
    si.addEventListener('keydown', (e) => { if (e.key === 'Escape') { si.value = ''; this._renderSearch(''); si.blur(); } });

    window.addEventListener('beforeunload', (e) => { if (this.dirty) { e.preventDefault(); e.returnValue = ''; } });

    // resizing between phone/tablet/desktop layouts must re-anchor any popup
    // that is open right now (old screens: desktop offsets slid off-screen)
    window.addEventListener('resize', () => {
      for (const [popSel, btnSel] of [['#mainMenu', '#menuBtn'], ['#motionPop', '#motionBtn'], ['#accessoryPop', '#accessoryBtn'], ['#scenePop', '#sceneBtn']]) {
        const pop = $(popSel);
        if (pop && pop.classList.contains('open')) this._placePop(pop, btnSel);
      }
      this._applyViewPrefs();
    });
  }

  _placePop(pop, sel) {
    const btn = $(sel);
    const r = btn.getBoundingClientRect?.() ?? { left: 0, right: 0, bottom: 60, top: 60 };
    const vw = document.documentElement.clientWidth || innerWidth || 1280;
    const vh = document.documentElement.clientHeight || innerHeight || 800;
    // reset first: inline styles from a previous (larger) placement must not
    // leak into a smaller layout after resize
    pop.style.left = ''; pop.style.right = ''; pop.style.top = ''; pop.style.bottom = '';
    if (vw <= 700) {
      // mobile: toolbar is a dock at the bottom; CSS pins the pop full width,
      // we only decide up/down here (mostly up, since the dock is at the bottom)
      const opensUp = r.top > vh / 2;
      if (opensUp) { pop.style.bottom = `${Math.max(8, vh - r.top + 6)}px`; pop.style.top = 'auto'; }
      else { pop.style.top = `${Math.min(vh - 120, r.bottom + 6)}px`; pop.style.bottom = 'auto'; }
      pop.style.left = '6px'; pop.style.right = '6px';
      return;
    }
    // desktop: anchor under the button, right edge aligned with it, clamped
    // so the popup can never slide outside the viewport
    const popW = Math.min(320, vw - 16);
    pop.style.top = `${Math.min(vh - 120, Math.max(56, r.bottom + 6))}px`;
    pop.style.bottom = 'auto';
    pop.style.left = 'auto';
    pop.style.right = `${Math.min(Math.max(8, vw - r.right), Math.max(8, vw - popW - 8))}px`;
  }

  /* ---------- studio (simple / advanced / script) ---------- */
  get studio() {
    const v = this.prefs.studio;
    return v === 'advanced' || v === 'script' ? v : 'simple';
  }
  setStudio(kind, { open = true } = {}) {
    if (!['simple', 'advanced', 'script'].includes(kind)) kind = 'simple';
    this.prefs.studio = kind;
    prefsSvc.save({ studio: kind });
    this._syncStudioBtn();
    if (open) this.togglePanel(kind === 'simple' ? 'simple' : kind);
  }
  _studioIsOpen(kind) {
    return kind === 'advanced' ? this.advancedEditor.isOpen
      : kind === 'script' ? this.scriptStudio.isOpen
      : this.simpleEditor.isOpen;
  }
  /** Blank custom worlds open ONLY in the scripting studios until set up. */
  _isCustomWorld() {
    const g = this.graph;
    return !!g && (g.description === 'Custom world' || /^world_/.test(g.id || ''));
  }
  /** Studio chooser popup: descriptive mode rows (drag/move/edit/add etc). */
  _buildStudioChooser() {
    const pop = $('#studioPop');
    if (!pop) return;
    const custom = this._isCustomWorld();
    const opt = (kind, icon, title, desc) =>
      `<button class="mi" role="menuitem" data-studio-kind="${kind}"><svg class="ic"><use href="${icon}"/></svg><span class="grow">${title}<small>${desc}</small></span></button>`;
    let rows = '';
    if (!custom) {
      rows += opt('simple', '#i-edit', 'Simple map studio', 'Drag, move, edit and add locations on the 2D map — tap two points to connect them.');
      rows += opt('advanced', '#i-sliders', 'Advanced map studio', 'The full 2D map toolkit with snapping and precision tools.');
      rows += `<div class="lab">Scripting</div>`;
    } else {
      rows += `<div class="lab">Set up this new world with scripting</div>`;
    }
    rows += opt('script-visual', '#i-link', 'Visual scripting', 'Node cards with W A S D sockets — drag wires between points to connect them; thumbnails, previews, details.');
    rows += opt('script-code', '#i-panels', 'Code editor', 'The whole world as JSON nodes + edges — Apply validates and diffs changes onto the live graph.');
    if (custom) rows += `<div class="lab" style="opacity:.6">Map studios unlock once the world is set up.</div>`;
    pop.innerHTML = rows;
    pop.querySelectorAll('[data-studio-kind]').forEach((b) => b.addEventListener('click', () => {
      pop.classList.remove('open');
      const k = b.dataset.studioKind;
      if (k && k.startsWith('script')) {
        this.scriptStudio.mode = k.endsWith('code') ? 'code' : 'visual';
        this.setStudio('script', { open: true });
      } else if (k) {
        this.setStudio(k, { open: true });
      }
    }));
  }
  _studioClicked() {
    const pop = $('#studioPop');
    if (!pop) return;
    if (pop.classList.contains('open')) { pop.classList.remove('open'); return; }
    this._buildStudioChooser();
    this._placePop(pop, '#studioBtn');
    pop.classList.add('open');
  }
  _syncStudioBtn() {
    const b = $('#studioBtn');
    if (!b) return;
    const meta = { simple: ['#i-edit', 'Simple'], advanced: ['#i-sliders', 'Advanced'], script: ['#i-link', 'Scripting'] }[this.studio];
    b.querySelector('use')?.setAttribute('href', meta[0]);
    const t = b.querySelector('.tb-txt'); if (t) t.textContent = meta[1];
    b.title = `Studio: ${meta[1]} · tap to choose a mode`;
    b.classList.toggle('active', this.simpleEditor?.isOpen || this.advancedEditor?.isOpen || this.scriptStudio?.isOpen);
  }

  /* ---------- AutoComplete ---------- */
  async toggleAutoComplete() {
    this.acEnabled = !this.acEnabled;
    prefsSvc.save({ acEnabled: this.acEnabled });
    const id = this.movement?.currentNodeId;
    if (id) {
      const entry = await this._ensurePanorama(id, {});
      const display = await this._present(entry);
      this.viewer.setImageNow(display, this.graph.getNode(id).headingDeg ?? 0);
    }
    this.toast(`AutoComplete ${this.acEnabled ? 'on, missing regions repaired and view range limited' : 'off, original pixels shown'}`, 'ok', 2400);
  }

  /* ---------- unified panels and options menu ---------- */
  _buildMainMenu() {
    const mm = $('#mainMenu');
    const vp = this.viewPrefs;
    const dbg = $('#debugOverlay');
    const sh = vp.sharpen || { on: false, amt: 0.55 };
    const sm = vp.smooth || { on: false, amt: 0.5 };
    const sw = (key, label, icon, hint = '') =>
      `<button class="mi sw ${vp[key] ? 'on' : ''}" data-sw="${key}" role="menuitemcheckbox" aria-checked="${!!vp[key]}">
        <svg class="ic"><use href="${icon}"/></svg>
        <span class="grow">${label}${hint ? `<small>${hint}</small>` : ''}</span>
        <span class="track"><span class="knob"></span></span>
      </button>`;
    const act = (icon, label, hint = '', id = '') =>
      `<button class="mi" ${id ? `id="${id}" ` : ''}role="menuitem"><svg class="ic"><use href="${icon}"/></svg><span class="grow">${label}${hint ? `<small>${hint}</small>` : ''}</span></button>`;
    mm.innerHTML = `
      <div class="lab">Image</div>
      <button class="mi sw ${sh.on ? 'on' : ''}" data-sharpen role="menuitemcheckbox" aria-checked="${!!sh.on}">
        <svg class="ic"><use href="#i-sharpen"/></svg>
        <span class="grow">Sharpen<small>more clarity and crisp edges</small></span>
        <span class="track"><span class="knob"></span></span>
      </button>
      <div class="row-of-field" data-sharpen-row ${sh.on ? '' : 'hidden'}>
        <input id="shRange" type="range" min="10" max="100" value="${Math.round((sh.amt ?? 0.55) * 100)}" aria-label="Sharpen strength">
        <span class="pct">${Math.round((sh.amt ?? 0.55) * 100)}%</span>
      </div>
      <button class="mi sw ${sm.on ? 'on' : ''}" data-smooth role="menuitemcheckbox" aria-checked="${!!sm.on}">
        <svg class="ic"><use href="#i-wind"/></svg>
        <span class="grow">Smoothen<small>clean jagged edges and line joins</small></span>
        <span class="track"><span class="knob"></span></span>
      </button>
      <div class="row-of-field" data-smooth-row ${sm.on ? '' : 'hidden'}>
        <input id="smRange" type="range" min="10" max="100" value="${Math.round((sm.amt ?? 0.5) * 100)}" aria-label="Smoothen strength">
        <span class="pct">${Math.round((sm.amt ?? 0.5) * 100)}%</span>
      </div>
      <button class="mi sw ${this.acEnabled ? 'on' : ''}" data-ac role="menuitemcheckbox" aria-checked="${!!this.acEnabled}">
        <svg class="ic"><use href="#i-magic"/></svg>
        <span class="grow">AutoComplete<small>repair incomplete panorama edges</small></span>
        <span class="track"><span class="knob"></span></span>
      </button>
      <div class="sep"></div><div class="lab">Panels</div>
      ${sw('locCard', 'Location card', '#i-pin')}
      ${sw('movePad', 'Movement pad', '#i-up', 'also W A S D keys')}
      ${sw('map', 'Map', '#i-map')}
      ${sw('compass', 'Compass', '#i-globe')}
      <button class="mi sw ${!dbg.hidden ? 'on' : ''}" data-dbg role="menuitemcheckbox" aria-checked="${!dbg.hidden}">
        <svg class="ic"><use href="#i-bug"/></svg>
        <span class="grow">Developer overlay<small>coordinates, nodes, scores</small></span>
        <span class="track"><span class="knob"></span></span>
      </button>
      <div class="sep"></div><div class="lab">World</div>
      ${act('#i-save', 'Save world file…', 'name it · every image inside one .pworld', 'miSaveWorld')}
      ${act('#i-open', 'Open world file', '.pworld opens anywhere', 'miOpenWorld')}
      ${act('#i-db', Desktop.online ? 'Worlds database' : 'Worlds', Desktop.online ? 'library · versions · activity' : 'web build: files, no database', 'miWorlds')}
      <div class="sep"></div>
      ${act('#i-save', 'Save project (.pmap)', 'legacy archive, images linked', 'miSavePmap')}
      ${act('#i-open', 'Open project (.pmap)', '', 'miOpenPmap')}
      ${act('#i-route', 'Route to landmark', '', 'miRoute')}
      ${act('#i-home', 'Start screen', 'demos and create', 'miHome')}`;
    const rebuild = () => { const was = mm.classList.contains('open'); this._buildMainMenu(); if (was) mm.classList.add('open'); };
    mm.querySelectorAll('[data-sw]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.sw;
      this.viewPrefs[k] = !this.viewPrefs[k];
      prefsSvc.save({ view: this.viewPrefs });
      this._applyViewPrefs();
      rebuild();
    }));
    mm.querySelector('[data-dbg]').addEventListener('click', () => {
      dbg.hidden = !dbg.hidden;
      this.mapRenderer.setDebug(!dbg.hidden);
      rebuild();
    });
    mm.querySelector('[data-ac]').addEventListener('click', async () => { await this.toggleAutoComplete(); rebuild(); });
    mm.querySelector('[data-sharpen]').addEventListener('click', () => {
      this.viewPrefs.sharpen = { ...sh, on: !sh.on };
      prefsSvc.save({ view: this.viewPrefs });
      this.reloadCurrentPanorama().catch(() => {});   // source re rendered with/without clarity pass
      this.toast(`Sharpen ${this.viewPrefs.sharpen.on ? 'on, clearer panorama' : 'off'}`, 'ok', 1600);
      rebuild();
    });
    const range = mm.querySelector('#shRange');
    range?.addEventListener('input', () => {
      const amt = +range.value / 100;
      this.viewPrefs.sharpen = { on: true, amt };
      prefsSvc.save({ view: this.viewPrefs });
      mm.querySelector('[data-sharpen-row] .pct').textContent = `${range.value}%`;
      clearTimeout(this._shT);
      this._shT = setTimeout(() => this.reloadCurrentPanorama().catch(() => {}), 240);
    });
    mm.querySelector('[data-smooth]').addEventListener('click', () => {
      this.viewPrefs.smooth = { ...sm, on: !sm.on };
      prefsSvc.save({ view: this.viewPrefs });
      this.reloadCurrentPanorama().catch(() => {});
      this.toast(`Smoothen ${this.viewPrefs.smooth.on ? 'on, edges cleaned' : 'off'}`, 'ok', 1600);
      rebuild();
    });
    const srange = mm.querySelector('#smRange');
    srange?.addEventListener('input', () => {
      const amt = +srange.value / 100;
      this.viewPrefs.smooth = { on: true, amt };
      prefsSvc.save({ view: this.viewPrefs });
      mm.querySelector('[data-smooth-row] .pct').textContent = `${srange.value}%`;
      clearTimeout(this._smT);
      this._smT = setTimeout(() => this.reloadCurrentPanorama().catch(() => {}), 240);
    });
    /* named bindings, never positional: menu rows can be added freely */
    const wire = (id, fn) => {
      const el = mm.querySelector(`#${id}`);
      el?.addEventListener('click', () => { mm.classList.remove('open'); fn(); });
    };
    wire('miSaveWorld', () => { this.landing?.hide(); this.worldLibrary?.open('save'); });
    wire('miOpenWorld', () => this.openWorldFile());
    wire('miWorlds', () => { this.closePanels(); this.worldLibrary?.open('library'); });
    wire('miSavePmap', () => this.saveProject(true));
    wire('miOpenPmap', () => this.openProject());
    wire('miRoute', () => this.routeToNearestLandmark());
    wire('miHome', () => { this.closePanels(); this.landing?.show(); });
  }

  /** Map slider 0..100 into 0.5..14 m/s (exponential, fine control at low end).
      Default 65 ≈ 4 m/s: lively walk, no more seconds of waiting per step. */
  _applySpeed() {
    const v = Math.max(0, Math.min(100, +this.viewPrefs.speed || 65));
    const mps = +(0.5 * Math.pow(28, v / 100)).toFixed(2);
    if (this.graph) this.graph.settings.walkSpeedMps = mps;
    const lbl = $('#speedTxt');
    if (lbl) lbl.textContent = `${mps >= 10 ? mps.toFixed(0) : mps.toFixed(1)} m/s`;
    this._applyMotion();
  }

  /** Apply motion prefs to the live viewer + re-time the transition so a
      faster walk NEVER means a longer morph (spec: keys respond < 0.8s). */
  _applyMotion() {
    if (!this.viewer) return;
    this.viewer.motion.style = this.motion.style;
    this.viewer.motion.amount = (this.motion.amount ?? 80) / 100;
    // transition duration: explicit override? or auto = hop time × 0.5,
    // clamped 120..520 so blends never outpace the step itself
    if ((this.motion.dur ?? 0) > 0) {
      const ms = Math.floor(120 + (this.motion.dur / 100) * 780);
      this.viewer.motion.durMs = ms;
    } else {
      this.viewer.motion.durMs = null;
      this.viewer.immersion.transitionMs = Math.floor(Math.min(520, Math.max(120, (this.graph?.settings.walkSpeedMps ?? 4) * 65)));
    }
  }

  _paintMotionPop() {
    document.querySelectorAll('#mStyle [data-ms]').forEach(b => {
      const onB = b.dataset.ms === this.motion.style;
      b.classList.toggle('on', onB);
      b.setAttribute('aria-checked', String(onB));
    });
    $('#mAmt').value = String(this.motion.amount ?? 80);
    $('#mAmtVal').textContent = `${this.motion.amount ?? 80}%`;
    $('#mDur').value = String(this.motion.dur ?? 0);
    this._paintMotionDur();
    const row = document.querySelector('[data-mrow="morph"]');
    if (row) row.hidden = this.motion.style !== 'morph' && this.motion.style !== 'blur';
  }

  _paintMotionDur() {
    const v = this.motion.dur ?? 0;
    $('#mDurVal').textContent = v === 0 ? 'Auto' : `${Math.floor(120 + (v / 100) * 780)} ms`;
  }

  /* ---------- view preferences (optional UI) ---------- */
  _applyViewPrefs() {
    document.body.classList.toggle('noLocCard', !this.viewPrefs.locCard);
    const stack = () => {
      const lc = $('#locCard');
      const desktop = typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 701px)').matches;
      const visible = this.viewPrefs.locCard && lc && !lc.classList.contains('hidden') && desktop;
      if (visible && lc.offsetHeight) document.body.style?.setProperty?.('--speedctl-bottom', `${lc.offsetHeight + 18}px`);
      else document.body.style?.removeProperty?.('--speedctl-bottom');
    };
    requestAnimationFrame(stack);
    $('#movePad').style.display = this.viewPrefs.movePad ? '' : 'none';
    $('#mapWidget').classList.toggle('hidden', !this.viewPrefs.map);
    $('#locCard').classList.toggle('hidden', !this.viewPrefs.locCard);
    $('#mapWidget').classList.toggle('force', !!this.viewPrefs.map);
    $('#locCard').classList.toggle('force', !!this.viewPrefs.locCard);
    $('#compass').style.display = this.viewPrefs.compass ? '' : 'none';
    if (!this.viewPrefs.map) $('#mapWidget').classList.remove('full');
    this._updateFab();
    this.mapRenderer.resize();
  }

  _updateFab() {
    const fab = $('#mapFab');
    if (!fab) return;
    if (!fab.dataset.bound) {
      fab.dataset.bound = '1';
      fab.addEventListener('click', () => { this.viewPrefs.map = true; prefsSvc.save({ view: this.viewPrefs }); this._applyViewPrefs(); });
    }
    fab.classList.toggle('show', !this.viewPrefs.map);
  }

  togglePanel(which) {
    const simple = which === 'simple' ? !this.simpleEditor.isOpen : false;
    const adv = (which === 'adv' || which === 'advanced') ? !this.advancedEditor.isOpen : false;
    const script = which === 'script' ? !this.scriptStudio.isOpen : false;
    this.closePanels();
    if (simple) this.simpleEditor.open();
    if (adv) this.advancedEditor.open();
    if (script) this.scriptStudio.open();
    this._syncStudioBtn();
  }

  closePanels() {
    this.simpleEditor.close();
    this.advancedEditor.close();
    this.scriptStudio.close();
    this.worldLibrary?.close();
    this._syncStudioBtn();
  }

  createEmptyWorld({ openEditor = null } = {}) {
    const name = prompt('Name your world:', 'My World');
    if (!name) return;
    const graph = new WorldGraph(new MapScale({ pixelsPerMeter: 2 }), { id: 'world_' + Date.now().toString(36), name });
    graph.environment.features = [];
    graph.description = 'Custom world';
    const center = graph.addNode({ id: 'node_start', x: 0, y: 0, name: 'Start', pano: { kind: 'generated' } });
    this.loadWorldJson({ ...graph.toJSON(), startNodeId: center.id }, { name });
    if (openEditor === 'simple') setTimeout(() => { if (!this.simpleEditor.isOpen) this.togglePanel('simple'); }, 60);
    if (openEditor === 'advanced') setTimeout(() => { if (!this.advancedEditor.isOpen) this.togglePanel('adv'); }, 60);
    if (openEditor === 'script') setTimeout(() => { if (!this.scriptStudio.isOpen) this.togglePanel('script'); }, 60);
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
    this.toast(`Route to ${near.landmark.name}: ${path.distanceM.toFixed(0)} m, follow the blue line (W to walk)`, 'ok', 4200);
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
      this.toast(deduped ? 'Image already in project, reused existing asset' : 'Panorama assigned to location', 'ok');
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
      if (res.ok) this.toast(`Saved ${name}, verified portable project`, 'ok');
      else if (!res.aborted) this.toast('Save failed', 'err');
    } catch (err) {
      console.error(err);
      this.toast('Export failed: ' + err.message, 'err', 5000);
    }
  }

  /** One entry point for both file flavours: `.pworld` (self-contained) and
      the older `.pmap` project archive. The extension decides, never a guess.
      The file can come from a dialog or from a drop on the window. */
  async openAnyFile(picked = null) {
    const file = picked || await fsAccess.openFile('.pworld,.pmap');
    if (!file) return null;
    this.landing?.hide();                      // a dropped file must not land behind the start screen
    const name = (file.name || '').toLowerCase();
    return name.endsWith('.pmap') ? this.openProject(file) : this.openWorldFile(file);
  }

  /**
   * DROP A WORLD FILE ON THE WINDOW. A file type you can save should be a file
   * type you can drop back in — the whole point of a self-contained world.
   */
  _bindFileDrop() {
    const zone = document.getElementById('dropZone');
    if (!zone) return;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    let depth = 0;
    const show = (on) => { zone.hidden = !on; document.body.classList.toggle('dropping', on); };

    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      show(true);
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) show(false);
    });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      show(false);
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      if (files.length > 1) this.toast(`Opening “${files[0].name}” — one world at a time`);
      await this.openAnyFile(files[0]);
    });
  }

  /** Look inside a world file before opening it (used by the Worlds panel). */
  async inspectWorldFileFlow(picked = null) {
    try {
      const file = picked || await fsAccess.openFile('.pworld');
      if (!file) return null;
      const info = await this.inspectWorldFile(file);
      this.worldLibrary?.showInspect(info, file);
      return info;
    } catch (err) {
      console.error(err);
      this.worldLibrary?.showInspect(null, null, worldFileProblem(err));
      return null;
    }
  }

  async openProject(picked = null) {
    const file = picked || await fsAccess.openFile('.pmap');
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
      this.toast(`Opened “${manifest.name}”${missing.length ? `, ${missing.length} panorama asset(s) missing, replaceable in the editor` : ''}`, missing.length ? 'err' : 'ok', 5000);
    } catch (err) {
      console.error(err);
      this.toast('Could not open project: ' + worldFileProblem(err), 'err', 6000);
    }
  }

  /* ================= world files (.pworld) & the worlds database =================
     ONE world, three homes, the same data everywhere:
       .pworld file   portable — every image embedded inside the file
       IndexedDB      the browser's local mirror (web build)
       database       the desktop app's worlds library (SQLite, versioned)
     All three are written from the SAME collected set, so a world saved one
     way and opened another stays the world it was. */

  /** The world card: name, maker, notes, tags — plus the modes to embed. */
  _worldCard(overrides = {}) {
    const p = this.project || {};
    let tags = overrides.tags ?? p.tags ?? [];
    if (typeof tags === 'string') tags = tags.split(',').map(t => t.trim()).filter(Boolean);
    return {
      id: overrides.id ?? p.id ?? this.graph?.id ?? ('world_' + Date.now().toString(36)),
      name: String(overrides.name || this.graph?.name || p.name || 'Untitled world').trim(),
      author: overrides.author ?? p.author ?? '',
      description: overrides.description ?? p.description ?? '',
      tags: Array.isArray(tags) ? tags : [],
      modes: Array.isArray(overrides.modes) && overrides.modes.length ? overrides.modes : null,
    };
  }

  /**
   * Make the world's own data say what the card says, so an export made right
   * after carries the name the user just typed (not the one it had before).
   */
  _adoptWorldCard(card) {
    if (this.graph && card.name && this.graph.name !== card.name) this.graph.name = card.name;
    if (this.graph) this.graph.updatedAt = new Date().toISOString();
    this._applyWorldCard(card);
  }

  _applyWorldCard(card) {
    if (!this.project) return;
    this.project.author = card.author;
    this.project.description = card.description;
    this.project.tags = card.tags;
    this.project.name = card.name;
    prefsSvc.save({ lastProjectId: this.project.id });
  }

  /** Where the visitor stood, and how they like to look around. */
  _sessionState() {
    const v = this.viewer?.view || {};
    return {
      startNodeId: this.movement?.currentNodeId || this.movement?.startNodeId || null,
      displayMode: this.displayMode,
      yawDeg: v.yawDeg ?? 0, pitchDeg: v.pitchDeg ?? 0, fovDeg: v.fovDeg ?? 75,
      walkSpeedMps: this.graph?.settings?.walkSpeedMps ?? 4,
      distanceTravelledM: this.movement?.distanceTravelledM ?? 0,
      view: { ...this.viewPrefs }, motion: { ...this.motion }, accessory: { ...this.accessory },
      acEnabled: this.acEnabled,
      savedAt: new Date().toISOString(),
    };
  }

  _restoreSession(session) {
    if (!session) return;
    if (session.displayMode && (this._sceneModesList || []).includes(session.displayMode)) {
      this.displayMode = session.displayMode;
      this._syncSceneFace?.();
    }
    if (session.view && typeof session.view === 'object') Object.assign(this.viewPrefs, session.view);
    if (session.motion) Object.assign(this.motion, session.motion);
    if (session.accessory) Object.assign(this.accessory, session.accessory);
    if (typeof session.acEnabled === 'boolean') this.acEnabled = session.acEnabled;
    this._applyViewPrefs?.();
    this._applyMotion?.();
    this._applyAccessory?.();
  }

  /** Identity metadata (validation + completeness reports) for every node seen. */
  _cacheMetaExport() {
    const out = {};
    for (const [id, meta] of this.cache.meta.entries()) {
      out[id] = {
        provider: meta.provider ?? null, mode: meta.mode ?? null,
        generationAttempt: meta.generationAttempt ?? null,
        seed: meta.seed ?? null, phash: meta.phash ?? null,
        validation: meta.validation ?? null,
        autoComplete: meta.autoComplete
          ? { complete: !!meta.autoComplete.complete, topMissingPct: meta.autoComplete.topMissingPct, bottomMissingPct: meta.autoComplete.bottomMissingPct }
          : null,
      };
    }
    return out;
  }

  _restoreCacheMeta(cacheMeta) {
    if (!cacheMeta) return;
    for (const [id, meta] of Object.entries(cacheMeta)) {
      if (!this.cache.meta.has(id)) this.cache.meta.set(id, { nodeId: id, ...meta });
    }
  }

  /** How every stored image is read for an export (uploaded or embedded). */
  _assetResolver() {
    return async (assetId) => {
      const record = await this.storage.getAsset(this.project?.id, assetId).catch(() => null);
      const blob = await this.assetBlob(assetId).catch(() => null);
      if (!blob) return null;
      const meta = record?.meta || {};
      const out = {
        original: blob,
        mime: blob.type || meta.mime || 'image/jpeg',
        name: meta.originalName || meta.name || null,
        width: meta.width ?? this._sessionAssets.get(assetId)?.meta?.width ?? null,
        height: meta.height ?? this._sessionAssets.get(assetId)?.meta?.height ?? null,
        role: meta.role || 'panorama',
      };
      const disp = await this.storage.getAsset(this.project?.id, `${assetId}:display`).catch(() => null);
      const thumb = await this.storage.getAsset(this.project?.id, `${assetId}:thumb`).catch(() => null);
      if (disp?.blob) out.display = disp.blob;
      else if (this._sessionAssets.get(`${assetId}:display`)?.blob) out.display = this._sessionAssets.get(`${assetId}:display`).blob;
      if (thumb?.blob) out.thumbnail = thumb.blob;
      else if (this._sessionAssets.get(`${assetId}:thumb`)?.blob) out.thumbnail = this._sessionAssets.get(`${assetId}:thumb`).blob;
      return out;
    };
  }

  /** A picture of the world for the library (the view you are standing in). */
  async _coverJpeg() {
    const id = this.movement?.currentNodeId;
    if (!id) return null;
    try {
      const entry = await this._ensurePanorama(id, {});
      const source = entry?.canvas || entry?.completedCanvas;
      if (!source) return null;
      const c = document.createElement('canvas');
      c.width = 640; c.height = 320;
      c.getContext('2d').drawImage(source, 0, 0, 640, 320);
      return await new Promise((r) => c.toBlob((b) => r(b), 'image/jpeg', 0.72));
    } catch { return null; }
  }

  _progressText(p) {
    if (p.phase === 'fetch') return `Embedding images from the world folder ${p.done}/${p.total}`;
    if (p.phase === 'assets') return `Packing images ${p.done}/${p.total}`;
    if (p.phase === 'archive') return 'Assembling the world file…';
    return 'Collecting the world…';
  }

  /**
   * SAVE THE WORLD AS ONE FILE — all of it: places, connections, zones,
   * landmarks, scale, environment, session, and every image embedded inside.
   */
  async saveWorldFile(cardIn = {}) {
    if (this._pworldBusy) { this.toast('A world file is already being written…'); return false; }
    if (!this.graph) return false;
    const card = this._worldCard(cardIn);
    // the card is the world's identity from here on: the file, the graph and
    // the project all carry the same name / maker / notes
    this._adoptWorldCard(card);
    this._pworldBusy = true;
    this.worldLibrary?.setProgress({ label: 'Collecting the world…', done: 0, total: 0 });
    try {
      const collected = await collectWorldAssets(this.graph, {
        resolveAsset: this._assetResolver(),
        modes: card.modes,
        onProgress: (p) => this.worldLibrary?.setProgress({ label: this._progressText(p), done: p.done, total: p.total }),
      });
      const cover = await this._coverJpeg();
      this.worldLibrary?.setProgress({ label: 'Assembling the world file…', done: 0, total: 0 });
      const { bytes } = await exportPworld({
        world: { ...card, modes: collected.modes },
        worldJson: collected.worldJson,
        assets: collected.assets,
        session: this._sessionState(),
        cacheMeta: this._cacheMetaExport(),
        cover,
        missing: collected.missing,
      });
      const filename = pworldFilename(card.name);
      let savedPath = null;
      if (this.desktop?.online) {
        // desktop: a real file in the app's exports folder, no download needed
        const out = await this.desktop.saveFileToDisk(filename, bytes);
        savedPath = out?.saved || null;
      }
      if (!savedPath) {
        const res = await fsAccess.saveBlob(new Blob([bytes], { type: 'application/zip' }), filename, this._saveHandle, 'pworld');
        if (res?.handle) this._saveHandle = res.handle;
        if (res?.aborted) { this.toast('Save cancelled'); return false; }
        if (!res?.ok) throw new Error('the file could not be written');
      }
      this._setWorldName(card.name);
      this.dirty = false;
      const images = collected.images;
      const missing = collected.missing.length;
      this.toast(
        `Saved ${filename} · ${formatBytes(bytes.length)} · ${images} image${images === 1 ? '' : 's'} inside the file`
        + (missing ? ` · ${missing} image(s) could not be embedded` : '')
        + (savedPath ? ` · ${savedPath}` : ''),
        missing ? 'err' : 'ok', 7000);
      return true;
    } catch (err) {
      console.error(err);
      this.toast(`Could not save the world file: ${err.message}`, 'err', 6000);
      return false;
    } finally {
      this._pworldBusy = false;
      this.worldLibrary?.setProgress(null);
    }
  }

  /** OPEN A WORLD FROM A FILE — images come out of the file itself. */
  async openWorldFile(picked = null) {
    try {
      const file = picked || await fsAccess.openFile('.pworld,.pmap');
      if (!file) return false;
      // the picker also accepts the older project archive: hand it over rather
      // than failing to read a manifest it never had
      if ((file.name || '').toLowerCase().endsWith('.pmap')) return this.openProject(file);
      this.toast('Opening world file…');
      const imported = await importPworld(file);
      const name = imported.manifest.world.name || 'Imported world';

      // 1. the embedded images become the working set for this session, so the
      //    world is walkable immediately — even on a machine that has never
      //    seen these pictures before
      const sessionAssets = new Map();
      for (const a of imported.assets) {
        if (a.original) sessionAssets.set(a.id, { blob: a.original, mime: a.mime, meta: a });
        if (a.display) sessionAssets.set(`${a.id}:display`, { blob: a.display, mime: 'image/webp' });
        if (a.thumbnail) sessionAssets.set(`${a.id}:thumb`, { blob: a.thumbnail, mime: 'image/webp' });
      }

      // 2. mirror them into the local store so the world survives a reload
      const projectId = imported.manifest.world.id || imported.world.id || ('world_' + Date.now().toString(36));
      imported.world.id = projectId;
      const project = {
        id: projectId, name, author: imported.manifest.world.author || '',
        description: imported.manifest.world.description || '', tags: imported.manifest.world.tags || [],
        createdAt: imported.manifest.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      await this.storage.saveProjectMeta({ ...project, world: imported.world }).catch(() => {});
      for (const a of imported.assets) {
        await this.storage.putAsset(projectId, a.id, a.original, {
          id: a.id, mime: a.mime, originalName: a.name, sha256: a.sha256,
          width: a.width, height: a.height, role: a.role, mode: a.mode, fromFile: file.name || 'world file',
        }).catch(() => {});
        if (a.display) await this.storage.putAsset(projectId, `${a.id}:display`, a.display, { of: a.id }).catch(() => {});
        if (a.thumbnail) await this.storage.putAsset(projectId, `${a.id}:thumb`, a.thumbnail, { of: a.id }).catch(() => {});
      }

      // 3. desktop build: put it in the worlds database too, so the library
      //    lists it and the images stop depending on this browser at all
      let inDatabase = false;
      if (this.desktop?.online) {
        try {
          const bytes = file.arrayBuffer ? new Uint8Array(await file.arrayBuffer()) : null;
          if (bytes) {
            await this.desktop.importPworldBytes(bytes, { name, source: file.name || null });
            inDatabase = true;
          }
        } catch (err) { console.warn('desktop database import skipped', err); }
      }

      // 4. adopt the world, then put the visitor back where the file left them
      await this.loadWorldJson(imported.world, { project, name, sessionAssets });
      this._restoreSession(imported.session);
      this._restoreCacheMeta(imported.cacheMeta);
      const cover = imported.cover || null;
      if (cover && inDatabase) {
        const buf = new Uint8Array(await cover.arrayBuffer());
        this.desktop.saveWorld({ id: projectId, name, author: project.author, description: project.description, tags: project.tags, worldJson: imported.world, coverBytes: [...buf], revision: false }).catch(() => {});
      }
      const warn = imported.warnings.length ? ` · ${imported.warnings[0]}` : '';
      this.toast(`Opened “${name}” · ${imported.assets.length} image(s) came inside the file${inDatabase ? ' · added to the worlds database' : ''}${warn}`, imported.warnings.length ? 'err' : 'ok', 6500);
      return true;
    } catch (err) {
      console.error(err);
      this.toast(`Could not open the world file: ${worldFileProblem(err)}`, 'err', 6500);
      return false;
    }
  }

  /** Quick look inside a file without opening it (size, counts, missing art). */
  async inspectWorldFile(file) {
    const info = await inspectPworld(file);
    const m = info.manifest;
    return {
      name: m.world.name, author: m.world.author, nodes: m.stats.nodes, images: m.stats.images,
      size: info.fileBytes, modes: m.scene?.modes || [], missing: m.missing?.length || 0,
      version: m.formatVersion, createdAt: m.createdAt,
    };
  }

  /** SAVE INTO THE DESKTOP DATABASE — worlds library, versions, activity. */
  async saveWorldToDatabase(cardIn = {}) {
    if (!this.desktop?.online) {
      this.toast('The web build has no database by design — save a .pworld file instead', 'err', 5200);
      return false;
    }
    if (this._pworldBusy) { this.toast('A save is already running…'); return false; }
    const card = this._worldCard(cardIn);
    this._adoptWorldCard(card);
    this._pworldBusy = true;
    this.worldLibrary?.setProgress({ label: 'Collecting the world…', done: 0, total: 0 });
    try {
      const collected = await collectWorldAssets(this.graph, {
        resolveAsset: this._assetResolver(),
        modes: card.modes,
        onProgress: (p) => this.worldLibrary?.setProgress({ label: this._progressText(p), done: p.done, total: p.total }),
      });
      const cover = await this._coverJpeg();
      const coverBytes = cover ? [...new Uint8Array(await cover.arrayBuffer())] : null;
      await this.desktop.saveWorld({
        id: card.id, name: card.name, author: card.author, description: card.description, tags: card.tags,
        source: this.worldDef?.id || 'app', createdAt: this.project?.createdAt,
        worldJson: collected.worldJson, session: this._sessionState(),
        coverBytes, cacheMeta: this._cacheMetaExport(),
        revisionLabel: 'saved', note: `${collected.images} image(s)`,
      });
      let done = 0;
      for (const a of collected.assets) {
        this.worldLibrary?.setProgress({ label: `Storing images ${++done}/${collected.assets.length}`, done, total: collected.assets.length });
        const bytes = a.original instanceof Blob ? new Uint8Array(await a.original.arrayBuffer()) : a.original;
        await this.desktop.putAsset(card.id, a.id, bytes, {
          mime: a.mime, role: a.role, mode: a.mode, name: a.name,
          sha256: a.sha256, width: a.width, height: a.height,
        });
        for (const [kind, blob] of [['display', a.display], ['thumb', a.thumbnail]]) {
          if (!blob) continue;
          const buf = new Uint8Array(await blob.arrayBuffer());
          await this.desktop.putAsset(card.id, a.id, buf, { mime: 'image/webp', role: a.role, mode: a.mode, name: a.name }, kind);
        }
      }
      // the world in memory now points at the stored images: adopt it, so the
      // walk continues without needing the original URLs
      await this.loadWorldJson(collected.worldJson, { project: { ...this.project, ...card, id: card.id, updatedAt: new Date().toISOString() }, name: card.name });
      this._setWorldName(card.name);
      this.dirty = false;
      this.toast(`Saved “${card.name}” to the worlds database · ${collected.images} image(s)`, 'ok', 5200);
      await this.worldLibrary?.refresh();
      return true;
    } catch (err) {
      console.error(err);
      this.toast(`Database save failed: ${err.message}`, 'err', 6000);
      return false;
    } finally {
      this._pworldBusy = false;
      this.worldLibrary?.setProgress(null);
    }
  }

  /** Open a world stored in the desktop database (images stream from it). */
  async loadWorldFromDatabase(id) {
    if (!this.desktop?.online) return false;
    try {
      this.toast('Opening from the worlds database…');
      const rec = await this.desktop.getWorld(id);
      if (!rec?.world) throw new Error('the database has no such world');
      const project = {
        id, name: rec.meta.name, author: rec.meta.author, description: rec.meta.description,
        tags: rec.meta.tags, createdAt: rec.meta.createdAt, updatedAt: new Date().toISOString(),
      };
      await this.storage.saveProjectMeta({ ...project, world: rec.world }).catch(() => {});
      await this.loadWorldJson(rec.world, { project, name: rec.meta.name });
      this._restoreSession(rec.session);
      const cacheMeta = await this.desktop.api(`api/settings`).catch(() => null);
      void cacheMeta;
      this.toast(`Opened “${rec.meta.name}” · ${rec.assets.length} image(s) from the database`, 'ok', 4600);
      return true;
    } catch (err) {
      this.toast(`Could not open from the database: ${err.message}`, 'err', 6000);
      return false;
    }
  }

  /** Snapshot the open world's current state as a restorable version. */
  async snapshotWorldVersion(cardIn = {}) {
    if (!this.desktop?.online) { this.toast('Versions live in the desktop database', 'err'); return false; }
    const card = this._worldCard(cardIn);
    try {
      const label = prompt('Label for this version:', `snapshot ${new Date().toLocaleString()}`);
      if (label === null) return false;
      await this.desktop.addRevision(card.id, { label: label || null, note: 'manual snapshot', worldJson: this.graph.toJSON() });
      this.toast('Version saved', 'ok');
      await this.worldLibrary?.refresh();
      return true;
    } catch (err) {
      this.toast(`Version failed: ${err.message}`, 'err', 5000);
      return false;
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
        + kv('step', `${g.scale.movement.stepPixels}px per step, ${g.scale.stepMeters().toFixed(1)}m real (ppm ${g.scale.pixelsPerMeter})`)
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
    if (!host) return;
    this._toasts ??= new Set();
    // spam protection: the exact same message already showing? refresh it
    // instead of stacking copies (key held/blocked spam)
    for (const t of this._toasts) {
      if (t._msg === msg && t._kind === kind) {
        clearTimeout(t._t1); clearTimeout(t._t2);
        t._arm(ms);
        return;
      }
    }
    // hard cap: keep at most 2 pending so a new one always fits (max 3 total)
    while (this._toasts.size >= 3) {
      const oldest = this._toasts.values().next().value;
      oldest._close();
    }
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    el._msg = msg; el._kind = kind;
    el._close = () => {
      if (!el.isConnected) { this._toasts.delete(el); return; }
      clearTimeout(el._t1); clearTimeout(el._t2);
      el.classList.add('leaving');                        // CSS owns the exit motion now
      setTimeout(() => { el.remove(); this._toasts.delete(el); }, 380);
    };
    el._arm = (t0) => { el._t1 = setTimeout(() => el._close(), t0); };
    this._toasts.add(el);
    host.appendChild(el);
    el._arm(ms);
  }

  /** Map node click → Preview first; studio shortcuts only while editing. */
  _wireNodeMenu() {
    const pop = $('#nodeMenu');
    if (!pop) return;
    const close = () => { pop.classList.remove('open'); this._nmNodeId = null; };
    this._closeNodeMenu = close;
    document.addEventListener('click', (e) => {
      if (pop.classList.contains('open') && !pop.contains(e.target) && !$('#mapCanvas')?.contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    $('#nmPreview').addEventListener('click', () => {
      const id = this._nmNodeId; close();
      if (id) this.teleport(id);
    });
    $('#nmEdit').addEventListener('click', () => {
      const id = this._nmNodeId; close();
      if (id) this.selectNode(id);
    });
  }

  _openNodeMenu(node, e) {
    const pop = $('#nodeMenu');
    if (!pop || !node) return;
    this._nmNodeId = node.id;
    $('#nmTitle').textContent = node.name || node.id;
    const studioOpen = this.simpleEditor?.isOpen || this.advancedEditor?.isOpen;
    $('#nmEdit').hidden = !studioOpen;
    pop.classList.add('open');
    // anchor at the click point, clamped into the viewport
    const cw = pop.offsetWidth || 232, ch = pop.offsetHeight || 96;
    const x = Math.min(Math.max(8, (e?.clientX ?? innerWidth / 2) + 6), innerWidth - cw - 8);
    const y = Math.min(Math.max(8, (e?.clientY ?? innerHeight / 2) + 6), innerHeight - ch - 8);
    pop.style.left = `${x}px`; pop.style.right = 'auto';
    pop.style.top = `${y}px`; pop.style.bottom = 'auto';
  }

  /* ================= keyboard ================= */
  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {   // save the world
        e.preventDefault();
        if (this.worldLibrary?.isOpen) this.worldLibrary._cardNow && this.saveWorldFile(this.worldLibrary._cardNow());
        else this.saveWorldFile();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {   // open a world
        e.preventDefault();
        this.openAnyFile();
        return;
      }
      if (e.key === 'Escape') { this.closePanels(); document.querySelectorAll('.pop.open').forEach(el => el.classList.remove('open')); return; }
      if (e.key === 'Enter' && this.simpleEditor.isOpen) { this.simpleEditor.onEnterKey(); return; }
      // Scripting studio is a full-screen work surface: walking keys stay off
      if (this.scriptStudio?.isOpen) return;

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

function hashStrLocal(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/* ---------------- boot ---------------- */
const app = new App();
app.boot().catch(err => {
  console.error('boot failed', err);
  document.querySelector('#panoLoading').innerHTML = `<div style="text-align:center"><strong>Something went wrong.</strong><br><span style="font-size:12px">${escapeHtml(err.message)}</span></div>`;
});
window.app = app;   // deliberate: debugging + tests hook
