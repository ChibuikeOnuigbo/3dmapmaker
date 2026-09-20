/**
 * apps/web — EngineController: the bridge between canonical state and WebGL.
 *
 * The React tree owns state; this class owns the scene. It is constructed once
 * per viewport, reads from the store, and never stores editor state itself.
 */
import * as THREE from 'three';
import { SceneManager, MaterialLibrary, Picker, PanoramaCrossfade, PostFx, defaultPostFx, layoutLabels, adaptiveGridSpacing } from '@3dmm/scene-core';
import {
  OrbitMode,
  FlyMode,
  WalkMode,
  CameraTransitionController,
  rayFromScreen,
  worldToScreen,
  rayTerrainHit,
  screenToWorldOnPlane,
  type RigState,
  type AxisInput,
  emptyInput,
  durationMs,
} from '@3dmm/camera';
import {
  FocusManager,
  CommandBus,
  KeyboardLayer,
  WheelRouter,
  PointerLayer,
  PointerLockController,
  FullscreenController,
  defaultCommands,
  defaultBindings,
  AxisCommands,
  ActionCommands,
  type DragKind,
  type DragSession,
  type CommandHandler,
} from '@3dmm/input';
import { TerrainEngine, buildTerrainMesh, type TerrainMeshData, type TerrainSource, applyStroke, type BrushParams, defaultBrush } from '@3dmm/terrain';
import { AdaptiveQuality, profileFor, type QualityTier } from '@3dmm/performance';
import {
  PanoramaGraph,
  PanoramaTransition,
  planSyntheticMove,
  clampPanoramaPitch,
  GridWalker,
  headingToKingMove,
  type PanoramaNode,
} from '@3dmm/panorama';
import { buildPathRibbon, buildPolygonGeometry, buildBuilding, buildWall, createWaterMaterial, scatterVegetation, smoothPath, type Vec2 } from '@3dmm/world';
import { newId, type ObjectNode, type Project } from '@3dmm/project';
import type { TerrainWorkerClient } from './TerrainWorkerClient';
import { useStore, type ToolId } from '../state/store';
import { downloadProjectFile } from '../state/io';

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  workerClient: TerrainWorkerClient | null;
}

export interface DraftSnapshot {
  measurePoints: Array<{ x: number; y: number; z: number }>;
  pathPoints: Array<{ x: number; y: number; z: number }>;
  measureKind: 'distance' | 'surface' | 'area' | 'perimeter' | 'elevation' | 'bearing';
}

export interface EngineTelemetry {
  frames: number;
  cameraMoves: number;
  sculpts: number;
  picks: number;
  rebases: number;
  workerBuilds: number;
  inlineBuilds: number;
  tileLoads: number;
  tileFailures: number;
  adaptiveChanges: number;
  pointerLockAttempts: number;
  fullscreenToggles: number;
  transitionInterruptions: number;
  /** Completed king's moves in grid-walk panorama mode. */
  panoramaSteps: number;
}

const UP = new THREE.Vector3(0, 1, 0);

export class EngineController {
  readonly scene: SceneManager;
  private store = useStore;
  private rig: RigState;
  private orbit: OrbitMode;
  private fly: FlyMode;
  private walk: WalkMode;
  private transition: CameraTransitionController;
  private terrain: TerrainEngine | null = null;
  private tileGroup = new THREE.Group();
  private contentGroup = new THREE.Group();
  private helperGroup = new THREE.Group();
  private materials = new MaterialLibrary();
  private picker = new Picker();
  private input: {
    focus: FocusManager;
    bus: CommandBus;
    keys: KeyboardLayer;
    wheel: WheelRouter;
    pointer: PointerLayer;
    lock: PointerLockController;
    fullscreen: FullscreenController;
  };
  private axes: AxisInput = emptyInput();
  private heldAxes = new Map<string, number>();
  private adaptive: AdaptiveQuality;
  private panorama: PanoramaCrossfade | null = null;
  private panoramaTransition: PanoramaTransition | null = null;
  private panoramaGraph: PanoramaGraph = new PanoramaGraph();
  /** Set when the project defines a discrete capture grid (chessboard mode). */
  private gridWalker: GridWalker | null = null;
  private gridConfigSignature = '';
  /** Edge-detect so one key press is one square, not a continuous walk. */
  private gridMoveLatch = false;
  /** Squares visited this session, for the HUD breadcrumb. */
  readonly gridPath: string[] = [];
  private panoTextures = new Map<string, THREE.Texture>();
  private postfx: PostFx | null = null;
  private waterMaterials: THREE.ShaderMaterial[] = [];
  private instancedVegetation: THREE.InstancedMesh | null = null;
  private tileMeshes = new Map<string, THREE.Mesh>();
  private objectMeshes = new Map<string, THREE.Object3D>();
  private contourLines: THREE.LineSegments | null = null;
  private gridHelper: THREE.GridHelper | null = null;
  private sunHelper: THREE.DirectionalLightHelper | null = null;
  private selectionBox: THREE.BoxHelper | null = null;
  private hoverOutline: THREE.BoxHelper | null = null;
  private measurePoints: THREE.Vector3[] = [];
  private measureLine: THREE.Line | null = null;
  private measureSprites: THREE.Sprite[] = [];
  private pathDraft: THREE.Vector3[] = [];
  private pathLine: THREE.Line | null = null;
  private sculptCursor: THREE.Mesh | null = null;
  private sculptLastPoint: { x: number; y: number } | null = null;
  private brush: BrushParams = defaultBrush();
  private renderOffset = new THREE.Vector3(0, 0, 0);
  private lastProjectRevision = -1;
  private lastTerrainRevision = -1;
  private lastQuality: QualityTier = 'normal';
  private unsubscribe: Array<() => void> = [];
  private disposed = false;
  private clockStart = performance.now();
  telemetry: EngineTelemetry = {
    frames: 0,
    cameraMoves: 0,
    sculpts: 0,
    picks: 0,
    rebases: 0,
    workerBuilds: 0,
    inlineBuilds: 0,
    tileLoads: 0,
    tileFailures: 0,
    adaptiveChanges: 0,
    pointerLockAttempts: 0,
    fullscreenToggles: 0,
    transitionInterruptions: 0,
    panoramaSteps: 0,
  };
  labelLayout: ReturnType<typeof layoutLabels> = { placed: [], dropped: 0, durationMs: 0 };
  private lastLabelUpdate = 0;
  private groundQuery = {
    heightAt: (x: number, z: number) => this.terrain?.heightAt(x, z) ?? null,
    normalAt: (x: number, z: number) => {
      const n = this.terrain?.normalAt(x, z) ?? { x: 0, y: 1, z: 0 };
      return { x: n.x, y: n.y, z: n.z };
    },
  };

  constructor(opts: EngineOptions) {
    const state = this.store.getState();
    const quality = profileFor(state.project.performance.quality);

    this.scene = new SceneManager({ canvas: opts.canvas, quality });
    this.scene.root.add(this.tileGroup);
    this.scene.root.add(this.contentGroup);
    this.scene.root.add(this.helperGroup);

    this.rig = this.rigFromProject(state.project);
    this.orbit = new OrbitMode(this.rig);
    this.fly = new FlyMode();
    this.walk = new WalkMode();
    this.transition = new CameraTransitionController();
    this.adaptive = new AdaptiveQuality(state.project.performance.quality, state.project.performance.adaptive);

    /* ------------------------------------------------------------- input --- */
    const focus = new FocusManager();
    focus.setViewport(opts.canvas);
    const bus = new CommandBus();
    bus.registerAll(defaultCommands());

    this.input = {
      focus,
      bus,
      keys: new KeyboardLayer({ bus, focus, bindings: defaultBindings(), target: window }),
      wheel: new WheelRouter({ bus, focus, target: opts.canvas }),
      pointer: new PointerLayer(
        {
          element: opts.canvas,
          focus,
          resolveKind: (e) => this.resolveDragKind(e),
          onTap: (p) => this.onTap(p),
          onHover: (p) => this.onHover(p),
        },
        {
          onStart: (s) => this.onDragStart(s),
          onMove: (s) => this.onDragMove(s),
          onEnd: (s, cancelled) => this.onDragEnd(s, cancelled),
        },
      ),
      lock: new PointerLockController({
        element: opts.canvas,
        focus,
        onLockChange: (s) => this.store.getState().setUi({ pointerLock: s }),
        onError: (m) => this.store.getState().setErrors({ pointerLock: m }),
      }),
      fullscreen: new FullscreenController(opts.container, (active) => {
        this.telemetry.fullscreenToggles++;
        this.store.getState().setUi({ fullscreen: active });
        this.scene.resize();
      }),
    };

    this.wireCommands(bus);
    this.postfx = new PostFx(
      Math.max(1, opts.canvas.clientWidth),
      Math.max(1, opts.canvas.clientHeight),
      { ...defaultPostFx(), enabled: quality.postEnabled },
    );

    /* ------------------------------------------------- focus bookkeeping --- */
    const focusOff = focus.onChange((snap) => {
      this.store.getState().setUi({ viewportFocused: snap.viewportOwnsInput });
      if (snap.blockedByOverlay) {
        this.input.lock.releaseForOverlay();
        this.input.keys.releaseAll();
      }
    });
    this.unsubscribe.push(focusOff);

    this.rebuildTerrain(state.project, opts.workerClient);
    this.applyEnvironment(state.project);
    this.syncContent(state.project);

    this.scene.onFrame((dt) => this.frame(dt));
    this.scene.start();
  }

  /* ------------------------------------------------------------ lifecycle --- */

  dispose(): void {
    this.disposed = true;
    this.draftListeners.clear();
    for (const off of this.unsubscribe) off();
    this.input.keys.dispose();
    this.input.wheel.dispose();
    this.input.pointer.dispose();
    this.input.lock.dispose();
    this.input.fullscreen.dispose();
    this.input.focus.dispose();
    this.terrain?.dispose();
    this.panorama?.dispose();
    this.postfx?.dispose();
    this.materials.dispose();
    for (const tex of this.panoTextures.values()) tex.dispose();
    this.scene.dispose();
  }

  resize(): void {
    this.scene.resize();
    this.postfx?.resize(Math.max(1, this.scene.viewportSize.width), Math.max(1, this.scene.viewportSize.height));
  }

  /* ------------------------------------------------------------- commands --- */

  private wireCommands(bus: CommandBus): void {
    // Name the handler type explicitly: `bus.on` now accepts a union of
    // CommandHandler and CommandObserver (for the '*' wildcard), so inferring
    // from Parameters<> would widen `e` to any at every call site below.
    const on = (id: string, fn: CommandHandler) => this.unsubscribe.push(bus.on(id, fn));

    on(AxisCommands.moveForward, (e) => this.setAxis('forward', e.phase === 'up' ? 0 : e.value));
    on(AxisCommands.moveRight, (e) => this.setAxis('right', e.phase === 'up' ? 0 : e.value));
    on(AxisCommands.moveUp, (e) => this.setAxis('up', e.phase === 'up' ? 0 : e.value));
    on(AxisCommands.turnYaw, (e) => this.setAxis('yaw', e.phase === 'up' ? 0 : e.value));
    on(AxisCommands.turnPitch, (e) => this.setAxis('pitch', e.phase === 'up' ? 0 : e.value));
    on(AxisCommands.zoom, (e) => {
      this.axes.zoom += e.value;
      this.noteCameraMove();
      if (this.transition.isRunning) this.interruptTransition();
    });

    on(ActionCommands.boost, (e) => { this.axes.boost = e.phase !== 'up'; });
    on(ActionCommands.slow, (e) => { this.axes.slow = e.phase !== 'up'; });
    on(ActionCommands.jump, () => { this.axes.jump = true; });
    on(ActionCommands.crouch, (e) => { this.axes.crouch = e.phase !== 'up'; });

    on(ActionCommands.cameraZoomIn, () => { this.axes.zoom -= 0.35; this.noteCameraMove(); });
    on(ActionCommands.cameraZoomOut, () => { this.axes.zoom += 0.35; this.noteCameraMove(); });
    on(ActionCommands.cameraResetNorth, () => this.flyTo({ headingDeg: 0 }, 'Reset north'));
    on(ActionCommands.cameraResetPitch, () => this.flyTo({ pitchDeg: -30 }, 'Reset pitch'));
    on(ActionCommands.cameraToggleFullscreen, () => this.toggleFullscreen());

    on(ActionCommands.modeOrbit, () => this.setMode('orbit'));
    on(ActionCommands.modeFly, () => this.setMode('fly'));
    on(ActionCommands.modeWalk, () => this.setMode('walk'));
    on(ActionCommands.modePanorama, () => this.setMode('panorama'));

    const toolCmd: Record<string, ToolId> = {
      [ActionCommands.toolSelect]: 'select',
      [ActionCommands.toolMove]: 'move',
      [ActionCommands.toolRotate]: 'rotate',
      [ActionCommands.toolScale]: 'scale',
      [ActionCommands.toolSculpt]: 'sculpt',
      [ActionCommands.toolMeasure]: 'measure',
      [ActionCommands.toolPath]: 'path',
      [ActionCommands.toolPolygon]: 'polygon',
      [ActionCommands.toolPanorama]: 'panorama',
      [ActionCommands.toolWater]: 'water',
      [ActionCommands.toolVegetation]: 'vegetation',
    };
    for (const [cmd, tool] of Object.entries(toolCmd)) {
      on(cmd, () => this.setTool(tool));
    }

    on(ActionCommands.editUndo, () => this.store.getState().undo());
    on(ActionCommands.editRedo, () => this.store.getState().redo());
    on(ActionCommands.editDelete, () => this.store.getState().deleteSelection());
    on(ActionCommands.editDuplicate, () => this.store.getState().duplicateSelection());
    on(ActionCommands.paletteOpen, () => {
      const s = this.store.getState();
      s.setUi({ commandPaletteOpen: !s.ui.commandPaletteOpen });
      this.input.focus.setOverlayOpen('command-palette', !s.ui.commandPaletteOpen);
      this.input.keys.releaseAll();
    });
    on(ActionCommands.playToggle, () => {
      const s = this.store.getState();
      s.setUi({ mode: s.ui.mode === 'play' ? 'edit' : 'play' });
    });
    on(ActionCommands.panoramaNext, () => this.stepPanorama(1));
    on(ActionCommands.panoramaPrev, () => this.stepPanorama(-1));
    on(ActionCommands.frameSelection, () => this.frameSelection());

    /* Drafts: Enter finishes, Escape discards, Backspace removes a vertex.
       All three are viewport-scoped, so a panel with focus keeps its own
       Backspace and Enter behaviour (REQUIREMENTS 026, 133). */
    on(ActionCommands.draftConfirm, () => {
      const tool = this.store.getState().ui.tool;
      if (tool === 'measure') {
        if (this.commitMeasure()) this.store.getState().notify('ok', 'Measurement saved to the project.');
        else this.store.getState().notify('warn', 'Add at least two points first (three for area and perimeter).');
      } else if (tool === 'path') {
        if (this.commitDraftPath('roads', `Road ${Date.now() % 1000}`)) this.store.getState().notify('ok', 'Road added.');
        else this.store.getState().notify('warn', 'A road needs at least two points.');
      } else if (tool === 'polygon') {
        if (this.commitDraftPolygon(`Area ${Date.now() % 1000}`)) this.store.getState().notify('ok', 'Polygon added.');
        else this.store.getState().notify('warn', 'A polygon needs at least three points.');
      }
    });
    on(ActionCommands.draftCancel, () => {
      this.cancelMeasure();
      this.cancelDraftPath();
    });
    on(ActionCommands.draftUndoPoint, () => this.undoDraftPoint());

    /* Global-scope commands. These are dispatched even when a panel has
       focus, which is safe because none of them are movement. */
    on(ActionCommands.fileNew, () => this.store.getState().newWorld());
    on(ActionCommands.fileSave, () => this.store.getState().saveNow());
    on(ActionCommands.fileExport, () => downloadProjectFile());
    on(ActionCommands.fileImport, () => this.store.getState().setUi({ modal: 'import' }));
    on(ActionCommands.demoOpen, () => this.store.getState().setUi({ modal: 'demos' }));
    on(ActionCommands.shortcutsOpen, () => this.store.getState().setUi({ modal: 'shortcuts' }));
    on(ActionCommands.statsToggle, () => {
      const s = this.store.getState();
      s.setUi({ statsOpen: !s.ui.statsOpen });
    });
    on(ActionCommands.gridToggle, () => {
      const s = this.store.getState();
      s.setGrid({ enabled: !s.project.grid.enabled });
    });
    on(ActionCommands.contoursToggle, () => {
      const s = this.store.getState();
      const c = s.project.terrain.contours;
      s.setTerrain({ contours: { ...c, enabled: !c.enabled } });
      this.rebuildContours();
    });
  }

  private setAxis(key: 'forward' | 'right' | 'up' | 'yaw' | 'pitch', value: number): void {
    this.axes[key] = value;
    if (key === 'forward' || key === 'right' || key === 'up') this.noteCameraMove();
    if (this.transition.isRunning && (key === 'forward' || key === 'right')) this.interruptTransition();
  }

  private noteCameraMove(): void {
    this.telemetry.cameraMoves++;
  }

  /* ---------------------------------------------------------------- frame --- */

  private frame(dt: number): void {
    if (this.disposed) return;
    const state = this.store.getState();
    this.telemetry.frames++;

    this.syncFromStore(state);

    // camera transition owns the rig while running
    const ownsCamera = this.transition.update(this.rig, dt);
    if (!ownsCamera) this.applyInput(state, dt);

    this.rebaseIfNeeded();
    this.applyRigToCamera();
    this.updateTerrain(state);
    this.updateWater(dt);
    this.updatePanorama(state, dt);
    this.updateHelpers(state);
    this.updateLabels();

    // adaptive quality
    const newTier = this.adaptive.pushFrame(dt * 1000);
    if (newTier && newTier !== this.lastQuality) {
      this.lastQuality = newTier;
      this.telemetry.adaptiveChanges++;
      const profile = profileFor(newTier);
      this.scene.setQuality(profile);
      this.postfx?.setSettings({ enabled: profile.postEnabled });
      this.terrain?.setQuality(profile.maxActiveTiles, profile.maxConcurrentLoads);
      state.setPerformance({ quality: newTier });
      state.setStats({ quality: newTier, adaptiveChanges: this.telemetry.adaptiveChanges });
    }

    this.publishStats();
  }

  private publishStats(): void {
    const stats = this.scene.profiler.stats;
    if (!stats) return;
    const t = this.terrain?.stats;
    this.store.getState().setStats({
      fps: Math.round(stats.fps),
      frameMs: Number(stats.frameMs.toFixed(2)),
      cpuMs: Number(stats.cpuMs.toFixed(2)),
      drawCalls: stats.drawCalls,
      triangles: stats.triangles,
      geometries: stats.geometries,
      textures: stats.textures,
      cacheBytes: t?.cache.bytes ?? 0,
      tiles: {
        active: (t?.active ?? 0) + (t?.ready ?? 0),
        loading: t?.loading ?? 0,
        queued: t?.queued ?? 0,
        failed: t?.failed ?? 0,
      },
      workerAvailable: this.workerAvailable,
      wasmAvailable: this.wasmAvailable,
    });
  }

  private workerAvailable = false;
  private wasmAvailable = false;

  setCapabilities(worker: boolean, wasm: boolean): void {
    this.workerAvailable = worker;
    this.wasmAvailable = wasm;
  }

  private syncFromStore(state: ReturnType<typeof this.store.getState>): void {
    if (state.projectRevision !== this.lastProjectRevision) {
      this.lastProjectRevision = state.projectRevision;
      this.applyEnvironment(state.project);
      this.syncContent(state.project);
      this.syncPanorama(state.project);
    }
    if (state.terrainRevision !== this.lastTerrainRevision) {
      this.lastTerrainRevision = state.terrainRevision;
      this.rebuildTerrain(state.project, this.workerClient);
    }
    const q = state.project.performance.quality;
    if (q !== this.lastQuality) {
      this.lastQuality = q;
      this.adaptive.reset(q);
      this.scene.setQuality(profileFor(q));
      this.postfx?.setSettings({ enabled: profileFor(q).postEnabled });
      this.terrain?.setQuality(profileFor(q).maxActiveTiles, profileFor(q).maxConcurrentLoads);
    }
  }

  private workerClient: TerrainWorkerClient | null = null;

  /* -------------------------------------------------------------- terrain --- */

  rebuildTerrain(project: Project, workerClient: TerrainWorkerClient | null): void {
    this.workerClient = workerClient;
    const source = project.terrain.source as TerrainSource;
    const worldSize = this.worldSizeFor(project);
    if (this.terrain) {
      this.terrain.dispose();
      this.terrain = null;
    }
    for (const mesh of this.tileMeshes.values()) {
      this.tileGroup.remove(mesh);
      mesh.geometry.dispose();
    }
    this.tileMeshes.clear();

    this.terrain = new TerrainEngine({
      worldSize,
      tileSize: project.terrain.tileSizeMeters,
      segments: project.terrain.segments,
      source,
      maxTiles: profileFor(project.performance.quality).maxActiveTiles,
      maxConcurrentLoads: profileFor(project.performance.quality).maxConcurrentLoads,
      verticalExaggeration: project.terrain.verticalExaggeration,
      worker: workerClient,
      onTileReady: (key, mesh) => this.onTileReady(key, mesh),
      onTileEvicted: (key) => this.onTileEvicted(key),
      onTileFailed: (key, error) => {
        this.telemetry.tileFailures++;
        this.store.getState().setErrors({ terrain: `Terrain tile ${key} failed: ${error}` });
      },
    });
    // Re-apply authored edits so sculpting survives reload (HARDENING CHECK 004).
    const edits: Record<string, Record<string, number>> = project.terrain.edits ?? {};
    if (Object.keys(edits).length) this.terrain.importEdits(edits);
  }

  private worldSizeFor(project: Project): number {
    return Math.max(project.terrain.tileSizeMeters, project.terrain.tileSizeMeters * 4);
  }

  private onTileReady(key: string, mesh: TerrainMeshData): void {
    this.telemetry.tileLoads++;
    let existing = this.tileMeshes.get(key);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
    geo.setAttribute('aSlope', new THREE.BufferAttribute(mesh.slope, 1));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();

    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geo;
    } else {
      const material = this.terrainMaterial();
      const m = new THREE.Mesh(geo, material);
      m.name = `terrain:${key}`;
      m.receiveShadow = true;
      m.castShadow = false;
      m.userData.tileKey = key;
      this.tileGroup.add(m);
      this.tileMeshes.set(key, m);
      existing = m;
    }
    void existing;
    if (this.contourLines) {
      this.contourLines.visible = false;
      this.rebuildContours();
    }
  }

  private onTileEvicted(key: string): void {
    const m = this.tileMeshes.get(key);
    if (!m) return;
    this.tileGroup.remove(m);
    m.geometry.dispose();
    this.tileMeshes.delete(key);
  }

  private terrainMaterialCache: THREE.Material | null = null;
  private terrainMaterial(): THREE.Material {
    if (this.terrainMaterialCache) return this.terrainMaterialCache;
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: false,
      roughness: 0.95,
      metalness: 0.0,
      color: 0x6f7d55,
    });
    // Elevation + slope colouring without a texture download.
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uLowColor = { value: new THREE.Color('#3f5d3a') };
      shader.uniforms.uHighColor = { value: new THREE.Color('#c9c2ae') };
      shader.uniforms.uRockColor = { value: new THREE.Color('#7a7268') };
      shader.uniforms.uSnowColor = { value: new THREE.Color('#eef2f5') };
      shader.uniforms.uWaterColor = { value: new THREE.Color('#2c4a58') };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vElev;\nvarying float vSlope;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvElev = position.y;\nvSlope = 1.0 - normal.y;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vElev;
          varying float vSlope;
          uniform vec3 uLowColor; uniform vec3 uHighColor; uniform vec3 uRockColor; uniform vec3 uSnowColor; uniform vec3 uWaterColor;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float h = clamp((vElev + 40.0) / 420.0, 0.0, 1.0);
          vec3 land = mix(uLowColor, uHighColor, smoothstep(0.05, 0.85, h));
          land = mix(land, uRockColor, smoothstep(0.18, 0.55, vSlope));
          land = mix(land, uSnowColor, smoothstep(0.72, 0.95, h));
          land = mix(uWaterColor, land, smoothstep(-0.02, 0.06, vElev));
          diffuseColor.rgb *= land * 2.1;`);
    };
    this.terrainMaterialCache = mat;
    return mat;
  }

  private updateTerrain(state: ReturnType<typeof this.store.getState>): void {
    if (!this.terrain) return;
    const vp = this.scene.viewportSize;
    this.terrain.update(
      {
        position: { x: this.rig.position.x, y: this.rig.position.y, z: this.rig.position.z },
        fovDeg: this.rig.fovDeg,
        viewportHeightPx: vp.height,
      },
      profileFor(state.project.performance.quality).maxScreenSpaceError,
    );
  }

  /* --------------------------------------------------------------- camera --- */

  private rigFromProject(project: Project): RigState {
    return {
      position: { ...project.camera.position },
      target: { ...project.camera.target },
      headingDeg: project.camera.headingDeg,
      pitchDeg: project.camera.pitchDeg,
      rollDeg: project.camera.rollDeg,
      fovDeg: project.camera.fovDeg,
      distance: project.camera.distance,
    };
  }

  private applyInput(state: ReturnType<typeof this.store.getState>, dt: number): void {
    const mode = state.project.camera.mode;
    const owned = this.input.focus.viewportOwnsInput() && state.ui.mode !== 'presentation';

    // Pointer-lock look feeds the yaw/pitch axes.
    const lockDelta = this.input.lock.consumeDelta();
    if (lockDelta.x !== 0 || lockDelta.y !== 0) {
      if (mode === 'fly') this.fly.look(lockDelta.x, lockDelta.y, this.rig);
      else if (mode === 'walk' || mode === 'panorama') this.walk.look(lockDelta.x, lockDelta.y, this.rig);
      else this.orbit.rotate(lockDelta.x, lockDelta.y, this.scene.viewportSize.height);
      this.noteCameraMove();
    }

    if (!owned) {
      // Never leave a stale axis latched when another surface owns input.
      this.axes = emptyInput();
      return;
    }

    if (mode === 'orbit') this.orbit.update(this.rig, this.axes, dt);
    else if (mode === 'fly') this.fly.update(this.rig, this.axes, dt);
    else if (mode === 'walk') {
      this.walk.update(this.rig, this.axes, dt, this.groundQuery);
    } else if (mode === 'panorama') {
      this.updatePanoramaLook(dt);
    }

    if (this.axes.forward !== 0 || this.axes.right !== 0 || this.axes.up !== 0 || this.axes.yaw !== 0 || this.axes.pitch !== 0) {
      this.noteCameraMove();
    }
    this.axes.zoom = 0;
    this.axes.jump = false;
  }

  private applyRigToCamera(): void {
    const cam = this.scene.camera;
    cam.position.set(
      this.rig.position.x - this.renderOffset.x,
      this.rig.position.y - this.renderOffset.y,
      this.rig.position.z - this.renderOffset.z,
    );
    if (this.store.getState().project.camera.mode === 'orbit') {
      cam.lookAt(
        this.rig.target.x - this.renderOffset.x,
        this.rig.target.y - this.renderOffset.y,
        this.rig.target.z - this.renderOffset.z,
      );
    } else {
      const pRad = (this.rig.pitchDeg * Math.PI) / 180;
      const hRad = (this.rig.headingDeg * Math.PI) / 180;
      const look = new THREE.Vector3(
        cam.position.x + Math.sin(hRad) * Math.cos(pRad),
        cam.position.y + Math.sin(pRad),
        cam.position.z - Math.cos(hRad) * Math.cos(pRad),
      );
      cam.lookAt(look);
    }
    if (Math.abs(cam.fov - this.rig.fovDeg) > 0.01) {
      cam.fov = this.rig.fovDeg;
      cam.updateProjectionMatrix();
    }
    // keep the shadow frustum around the camera
    this.scene.setSunTarget(cam.position.x, cam.position.y - 50, cam.position.z);
  }

  /** Floating-origin rebasing (REQUIREMENT 008, HARDENING CHECK 005). */
  private rebaseIfNeeded(): void {
    const threshold = 5000;
    const dx = this.rig.position.x - this.renderOffset.x;
    const dz = this.rig.position.z - this.renderOffset.z;
    if (Math.hypot(dx, dz) < threshold) return;
    const newOffset = new THREE.Vector3(this.rig.position.x, 0, this.rig.position.z);
    const delta = newOffset.clone().sub(this.renderOffset);
    this.renderOffset.copy(newOffset);
    // Shift every scene child so the world does not move visually.
    this.scene.root.position.sub(delta);
    this.telemetry.rebases++;
    this.store.getState().notify('info', `Floating origin rebased by ${Math.round(delta.length()).toLocaleString()} m to keep precision.`);
  }

  setMode(mode: 'orbit' | 'fly' | 'walk' | 'panorama'): void {
    const s = this.store.getState();
    if (mode === 'walk') {
      this.walk.respawnOnGround(this.rig, this.groundQuery);
    }
    if (mode === 'panorama') this.enterPanoramaMode();
    if (mode === 'fly' || mode === 'walk') {
      // first-person modes want the pointer locked for mouse look
      this.telemetry.pointerLockAttempts++;
      this.input.lock.request();
    } else {
      this.input.lock.exit();
    }
    this.input.pointer.cancel('mode switch');
    this.orbit.syncFrom(this.rig);
    s.setCameraMode(mode);
  }

  setTool(tool: ToolId): void {
    this.store.getState().setUi({ tool });
    this.input.pointer.cancel('tool switch');
    this.measurePoints = [];
    this.pathDraft = [];
    this.updateMeasureVisuals();
    this.updatePathVisuals();
  }

  flyTo(patch: Partial<RigState>, label = 'Camera move'): void {
    const s = this.store.getState();
    const preset = s.project.transition;
    const target: Partial<RigState> = { ...patch };
    if (patch.target && !patch.position) {
      const d = this.rig.distance;
      const pRad = ((patch.pitchDeg ?? this.rig.pitchDeg) * Math.PI) / 180;
      const hRad = ((patch.headingDeg ?? this.rig.headingDeg) * Math.PI) / 180;
      target.position = {
        x: patch.target.x + d * Math.cos(pRad) * Math.sin(hRad),
        y: patch.target.y - d * Math.sin(pRad),
        z: patch.target.z + d * Math.cos(pRad) * Math.cos(hRad),
      };
    }
    this.transition.start(this.rig, {
      to: target,
      durationMs: durationMs(preset.speed, preset.customMs),
      easing: preset.easing,
      path: preset.path.length >= 2 ? preset.path : undefined,
      terrainFollow: preset.terrainFollow
        ? { clearance: 20, sample: (x, z) => this.terrain?.heightAt(x, z) ?? null }
        : undefined,
      interruptible: preset.interruptible,
    });
    this.noteCameraMove();
    void label;
  }

  private interruptTransition(): void {
    if (this.transition.cancel(this.rig)) {
      this.telemetry.transitionInterruptions++;
      this.orbit.syncFrom(this.rig);
    }
  }

  /* -------------------------------------------------------------- pointer --- */

  private resolveDragKind(e: PointerEvent): DragKind | null {
    const tool = this.store.getState().ui.tool;
    const mode = this.store.getState().project.camera.mode;
    if (mode === 'panorama') return 'panorama-look';
    if (e.button === 2 || e.shiftKey) return 'camera-pan';
    if (tool === 'sculpt') return 'sculpt';
    if (tool === 'measure') return 'measure';
    if (tool === 'move' || tool === 'rotate' || tool === 'scale') {
      return this.store.getState().ui.selectedIds.length ? 'gizmo' : 'camera-orbit';
    }
    return 'camera-orbit';
  }

  private onDragStart(s: DragSession): void {
    if (s.kind === 'sculpt') {
      const hit = this.pickTerrain(s.current.x, s.current.y);
      this.sculptLastPoint = hit ? { x: hit.point.x + this.renderOffset.x, y: hit.point.z + this.renderOffset.z } : null;
    }
    if (this.transition.isRunning) this.interruptTransition();
  }

  private onDragMove(s: DragSession): void {
    const vp = this.scene.viewportSize;
    switch (s.kind) {
      case 'camera-orbit': {
        if (this.store.getState().project.camera.mode === 'orbit') {
          this.orbit.rotate(s.current.dx, s.current.dy, vp.height);
        } else {
          this.fly.look(s.current.dx, s.current.dy, this.rig);
        }
        this.noteCameraMove();
        break;
      }
      case 'camera-pan': {
        this.orbit.panBy(s.current.dx, s.current.dy, vp.height, this.rig.fovDeg);
        this.noteCameraMove();
        break;
      }
      case 'panorama-look': {
        this.walk.look(s.current.dx, s.current.dy, this.rig, 0.09);
        this.noteCameraMove();
        break;
      }
      case 'sculpt': {
        this.doSculpt(s);
        break;
      }
      case 'gizmo': {
        this.doGizmo(s);
        break;
      }
      case 'measure': {
        // measurement points are placed on tap, drag just previews
        this.updateMeasureVisuals();
        break;
      }
      default:
        break;
    }
  }

  private onDragEnd(s: DragSession, cancelled: boolean): void {
    if (s.kind === 'sculpt' && !cancelled) {
      const edits = this.terrain?.exportEdits();
      if (edits) this.store.getState().commitTerrainEdits(edits);
      this.sculptLastPoint = null;
    }
    if (s.kind === 'gizmo' && !cancelled) {
      // end the coalescing group so the next drag is a separate undo step
      this.store.getState().notify('info', 'Transform applied.');
    }
  }

  private pickTerrain(sx: number, sy: number): THREE.Intersection | null {
    const vp = this.scene.viewportSize;
    const ray = rayFromScreen(sx, sy, this.cameraBasis(), vp);
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(ray.origin.x, ray.origin.y, ray.origin.z),
      new THREE.Vector3(ray.direction.x, ray.direction.y, ray.direction.z),
      0,
      50000,
    );
    const hits = raycaster.intersectObjects([...this.tileMeshes.values()], false);
    return hits[0] ?? null;
  }

  private cameraBasis() {
    return {
      position: {
        x: this.rig.position.x - this.renderOffset.x,
        y: this.rig.position.y - this.renderOffset.y,
        z: this.rig.position.z - this.renderOffset.z,
      },
      headingDeg: this.rig.headingDeg,
      pitchDeg: this.rig.pitchDeg,
      rollDeg: this.rig.rollDeg,
      fovDeg: this.rig.fovDeg,
      aspect: this.scene.camera.aspect,
      near: this.scene.camera.near,
      far: this.scene.camera.far,
    };
  }

  private doSculpt(s: DragSession): void {
    const hit = this.pickTerrain(s.current.x, s.current.y);
    if (!hit) return;
    const worldX = hit.point.x + this.renderOffset.x;
    const worldZ = hit.point.z + this.renderOffset.z;
    const res = this.terrain?.sculpt(worldX, worldZ, this.sculptLastPoint, { ...this.brush, dt: 1 / 60 });
    if (res?.changed) {
      this.telemetry.sculpts++;
      this.sculptLastPoint = { x: worldX, y: worldZ };
    }
  }

  private doGizmo(s: DragSession): void {
    const st = this.store.getState();
    const ids = st.ui.selectedIds;
    if (!ids.length) return;
    const tool = st.ui.tool;
    const scale = this.rig.distance * 0.0025;
    for (const id of ids) {
      const node = findNodeById(st.project.layers, id);
      if (!node || node.locked) continue;
      if (tool === 'move') {
        st.updateLayer(id, {
          position: {
            x: node.position.x + s.current.dx * scale,
            y: node.position.y,
            z: node.position.z + s.current.dy * scale,
          },
        });
      } else if (tool === 'rotate') {
        st.updateLayer(id, {
          rotationDeg: { ...node.rotationDeg, y: node.rotationDeg.y + s.current.dx * 0.4 },
        });
      } else if (tool === 'scale') {
        const f = 1 + s.current.dx * 0.004;
        st.updateLayer(id, {
          scale: {
            x: Math.max(0.01, node.scale.x * f),
            y: Math.max(0.01, node.scale.y * f),
            z: Math.max(0.01, node.scale.z * f),
          },
        });
      }
    }
  }

  private onTap(p: { x: number; y: number }): void {
    const st = this.store.getState();
    const tool = st.ui.tool;
    if (tool === 'measure') {
      const hit = this.pickTerrain(p.x, p.y);
      if (hit) {
        this.measurePoints.push(new THREE.Vector3(hit.point.x, hit.point.y + 0.5, hit.point.z));
        this.updateMeasureVisuals();
        this.notifyDraft();
      }
      return;
    }
    if (tool === 'path' || tool === 'polygon') {
      const hit = this.pickTerrain(p.x, p.y);
      if (hit) {
        this.pathDraft.push(new THREE.Vector3(hit.point.x, hit.point.y + 0.2, hit.point.z));
        this.updatePathVisuals();
        this.notifyDraft();
      }
      return;
    }
    // selection
    const picked = this.pickObject(p.x, p.y);
    if (picked) {
      st.select([picked]);
    } else {
      st.select([]);
    }
  }

  private onHover(p: { x: number; y: number }): void {
    const st = this.store.getState();
    if (st.ui.tool === 'sculpt') {
      this.updateSculptCursor(p.x, p.y);
      return;
    }
    this.telemetry.picks++;
    const id = this.pickObject(p.x, p.y);
    st.setHover(id);
  }

  private pickObject(sx: number, sy: number): string | null {
    if (!this.picker.shouldHoverPick()) return this.store.getState().ui.hoverId;
    const vp = this.scene.viewportSize;
    const ray = rayFromScreen(sx, sy, this.cameraBasis(), vp);
    const hit = this.picker.fromRay(ray);
    return hit?.id ?? null;
  }

  setBrush(patch: Partial<BrushParams>): void {
    this.brush = { ...this.brush, ...patch };
    if (this.sculptCursor) {
      const r = Math.max(0.5, this.brush.radius);
      this.sculptCursor.scale.set(r, r, r);
    }
  }

  getBrush(): BrushParams {
    return { ...this.brush };
  }

  private updateSculptCursor(sx: number, sy: number): void {
    if (!this.sculptCursor) {
      const geo = new THREE.RingGeometry(0.92, 1, 48);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffcc55, transparent: true, opacity: 0.85, depthTest: false });
      this.sculptCursor = new THREE.Mesh(geo, mat);
      this.sculptCursor.renderOrder = 900;
      this.helperGroup.add(this.sculptCursor);
    }
    const hit = this.pickTerrain(sx, sy);
    this.sculptCursor.visible = Boolean(hit);
    if (hit) {
      this.sculptCursor.position.copy(hit.point);
      this.sculptCursor.position.y += 0.6;
      const r = Math.max(0.5, this.brush.radius);
      this.sculptCursor.scale.set(r, r, r);
    }
  }

  /* ---------------------------------------------------------- measurements --- */

  private updateMeasureVisuals(): void {
    if (this.measureLine) {
      this.helperGroup.remove(this.measureLine);
      this.measureLine.geometry.dispose();
      this.measureLine = null;
    }
    for (const s of this.measureSprites) this.helperGroup.remove(s);
    this.measureSprites = [];
    if (this.measurePoints.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(this.measurePoints.map((p) => p.clone().sub(this.renderOffset)));
    const mat = new THREE.LineBasicMaterial({ color: 0x4fd1c5 });
    this.measureLine = new THREE.Line(geo, mat);
    this.measureLine.renderOrder = 800;
    this.helperGroup.add(this.measureLine);
  }

  private commitMeasurement(): void {
    const st = this.store.getState();
    const pts = this.measurePoints.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    st.addMeasurement({ id: newId('meas'), kind: 'distance', points: pts, ring: [] });
    this.measurePoints = [];
    this.updateMeasureVisuals();
  }

  clearMeasureVisuals(): void {
    this.measurePoints = [];
    this.updateMeasureVisuals();
    this.notifyDraft();
  }

  /* --------------------------------------------------------- draft state --- */

  /** Measurement flavour chosen in the draft bar. */
  measureKind: 'distance' | 'surface' | 'area' | 'perimeter' | 'elevation' | 'bearing' = 'distance';

  private draftListeners = new Set<(n: DraftSnapshot) => void>();

  private notifyDraft(): void {
    const snap = this.getDraftSnapshot();
    for (const fn of this.draftListeners) fn(snap);
  }

  onDraftChange(fn: (snap: DraftSnapshot) => void): () => void {
    this.draftListeners.add(fn);
    fn(this.getDraftSnapshot());
    return () => this.draftListeners.delete(fn);
  }

  getDraftSnapshot(): DraftSnapshot {
    return {
      measurePoints: this.measurePoints.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      pathPoints: this.pathDraft.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      measureKind: this.measureKind,
    };
  }

  setMeasureKind(kind: DraftSnapshot['measureKind']): void {
    this.measureKind = kind;
    this.notifyDraft();
  }

  /** Commit the drafted measurement into project state. */
  commitMeasure(kind = this.measureKind): boolean {
    const st = this.store.getState();
    const pts = this.measurePoints.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const needsRing = kind === 'area' || kind === 'perimeter';
    if (pts.length < (needsRing ? 3 : 2)) return false;
    st.addMeasurement({ id: newId('meas'), kind, points: needsRing ? [] : pts, ring: needsRing ? pts : [] });
    this.measurePoints = [];
    this.updateMeasureVisuals();
    this.notifyDraft();
    return true;
  }

  /** Drop the drafted measurement without saving. */
  cancelMeasure(): void {
    this.measurePoints = [];
    this.updateMeasureVisuals();
    this.notifyDraft();
  }

  /** Undo the last drafted vertex of the active draft. */
  undoDraftPoint(): void {
    if (this.measurePoints.length > 0) {
      this.measurePoints.pop();
      this.updateMeasureVisuals();
    } else if (this.pathDraft.length > 0) {
      this.pathDraft.pop();
      this.updatePathVisuals();
    }
    this.notifyDraft();
  }

  /** Drop the drafted path/polygon without saving. */
  cancelDraftPath(): void {
    this.pathDraft = [];
    this.updatePathVisuals();
    this.notifyDraft();
  }

  /** Close the drafted ring into an authored polygon layer. */
  commitDraftPolygon(name: string, color = '#6b7280'): boolean {
    if (this.pathDraft.length < 3) return false;
    const ring = this.pathDraft.map((p) => ({ x: p.x, y: p.z }));
    const node: ObjectNode = {
      id: newId('poly'),
      kind: 'polygons',
      name,
      visible: true,
      locked: false,
      position: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      anchor: { type: 'world' },
      data: { ring, color },
      children: [],
    };
    this.store.getState().addLayer(node);
    this.pathDraft = [];
    this.updatePathVisuals();
    this.notifyDraft();
    return true;
  }

  private updatePathVisuals(): void {
    if (this.pathLine) {
      this.helperGroup.remove(this.pathLine);
      this.pathLine.geometry.dispose();
      this.pathLine = null;
    }
    if (this.pathDraft.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(this.pathDraft.map((p) => p.clone().sub(this.renderOffset)));
    this.pathLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x63b3ed }));
    this.pathLine.renderOrder = 800;
    this.helperGroup.add(this.pathLine);
  }

  /** Turn the drafted points into an authored road/path layer. */
  commitDraftPath(kind: 'roads' | 'paths', name: string): boolean {
    if (this.pathDraft.length < 2) return false;
    const points = this.pathDraft.map((p) => ({ x: p.x, y: p.z }));
    const node: ObjectNode = {
      id: newId(kind === 'roads' ? 'road' : 'path'),
      kind: kind === 'roads' ? 'roads' : 'paths',
      name,
      visible: true,
      locked: false,
      position: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      anchor: { type: 'world' },
      data: { points, width: kind === 'roads' ? 8 : 2, sidewalkWidth: kind === 'roads' ? 1.5 : 0, smoothing: 0.5 },
      children: [],
    };
    this.store.getState().addLayer(node);
    this.pathDraft = [];
    this.updatePathVisuals();
    this.notifyDraft();
    return true;
  }

  /* -------------------------------------------------------------- content --- */

  syncContent(project: Project): void {
    // Remove meshes whose nodes disappeared.
    const alive = new Set<string>();
    const walkIds = (nodes: ObjectNode[]) => {
      for (const n of nodes) {
        alive.add(n.id);
        walkIds(n.children);
      }
    };
    walkIds(project.layers);
    for (const [id, obj] of [...this.objectMeshes]) {
      if (!alive.has(id)) {
        this.contentGroup.remove(obj);
        disposeObject(obj);
        this.objectMeshes.delete(id);
      }
    }

    const pickTargets: Array<{ id: string; object: THREE.Object3D }> = [];
    const heightAt = (x: number, y: number) => this.terrain?.heightAt(x, y) ?? 0;
    const slopeAt = (x: number, y: number) => this.terrain?.slopeAt(x, y);

    const isolated = this.store.getState().ui.isolated;
    const render = (nodes: ObjectNode[], visible: boolean) => {
      for (const node of nodes) {
        const isVisible = visible && node.visible;
        if (isolated && !isolated.includes(node.id) && node.children.length === 0) {
          continue;
        }
        let obj = this.objectMeshes.get(node.id);
        const signature = contentSignature(node);
        if (obj && obj.userData.signature !== signature) {
          this.contentGroup.remove(obj);
          disposeObject(obj);
          this.objectMeshes.delete(node.id);
          obj = undefined;
        }
        if (!obj) {
          const built = this.buildObject(node, heightAt, project);
          obj = built ?? undefined;
          if (built) {
            built.userData.signature = signature;
            built.userData.nodeId = node.id;
            this.contentGroup.add(built);
            this.objectMeshes.set(node.id, built);
          }
        }
        if (obj) {
          obj.visible = isVisible;
          obj.position.set(
            node.position.x - this.renderOffset.x,
            node.position.y - this.renderOffset.y,
            node.position.z - this.renderOffset.z,
          );
          if (node.anchor.type === 'terrain') {
            obj.position.y = heightAt(node.position.x, node.position.z) + node.anchor.offset;
          }
          obj.rotation.set(
            (node.rotationDeg.x * Math.PI) / 180,
            (node.rotationDeg.y * Math.PI) / 180,
            (node.rotationDeg.z * Math.PI) / 180,
          );
          obj.scale.set(node.scale.x, node.scale.y, node.scale.z);
          if (isVisible && node.kind === 'objects') pickTargets.push({ id: node.id, object: obj });
        }
        render(node.children, isVisible);
      }
    };
    render(project.layers, true);
    this.picker.setTargets(pickTargets);
    this.updateSelectionVisuals();
  }

  private buildObject(
    node: ObjectNode,
    heightAt: (x: number, y: number) => number,
    project: Project,
  ): THREE.Object3D | null {
    switch (node.kind) {
      case 'objects': {
        const shape = (node.data.shape as string) ?? 'box';
        let geo: THREE.BufferGeometry;
        if (shape === 'sphere') geo = new THREE.SphereGeometry(1, 24, 16);
        else if (shape === 'cylinder') geo = new THREE.ConeGeometry(1, 2, 20);
        else if (shape === 'torus') geo = new THREE.TorusGeometry(1, 0.35, 12, 28);
        else geo = new THREE.BoxGeometry(2, 2, 2);
        const mat = this.materials.get({ kind: 'standard', color: (node.data.color as string) ?? '#c0663f', roughness: 0.6, metalness: 0.1 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        return mesh;
      }
      case 'markers': {
        const geo = new THREE.ConeGeometry(0.6, 2, 14);
        geo.translate(0, 1, 0);
        const mat = this.materials.get({ kind: 'standard', color: (node.data.color as string) ?? '#f6ad55', roughness: 0.5, emissive: '#3a2200' });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        return mesh;
      }
      case 'buildings': {
        const footprint = ((node.data.footprint as Vec2[] | undefined) ?? defaultFootprint(6, 6)).map((p) => ({ x: p.x, y: p.y }));
        const { geometry } = buildBuilding({
          footprint,
          floors: (node.data.floors as number) ?? 3,
          floorHeight: (node.data.floorHeight as number) ?? 3.2,
          roof: ((node.data.roof as 'flat' | 'gable') ?? 'flat'),
          heightAt,
        });
        const mat = this.materials.get({ kind: 'building', color: (node.data.color as string) ?? '#b9b3a6', roughness: 0.85 });
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        return mesh;
      }
      case 'roads':
      case 'paths': {
        const points = (node.data.points as Vec2[] | undefined) ?? [];
        if (points.length < 2) return null;
        const geo = buildPathRibbon(points, {
          width: (node.data.width as number) ?? 8,
          smoothing: (node.data.smoothing as number) ?? 0.5,
          sidewalkWidth: (node.data.sidewalkWidth as number) ?? 0,
        }, heightAt, node.kind === 'roads' ? 0.12 : 0.06);
        const mat = this.materials.get({
          kind: 'road',
          color: node.kind === 'roads' ? '#3b3b3f' : '#7d6b4f',
          roughness: 0.95,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.receiveShadow = true;
        return mesh;
      }
      case 'water': {
        const ring = (node.data.ring as Vec2[] | undefined) ?? defaultFootprint(30, 30);
        const geo = buildPolygonGeometry(ring, heightAt, { yOffset: (node.data.level as number) ?? 0.4 });
        const mat = createWaterMaterial((node.data.color as string) ?? '#2f6f8f', project.performance.quality === 'low' ? 'low' : 'normal');
        (mat.uniforms.uTime as { value: number }).value = 0;
        this.waterMaterials.push(mat);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 5;
        return mesh;
      }
      case 'polygons': {
        const ring = (node.data.ring as Vec2[] | undefined) ?? defaultFootprint(20, 20);
        const geo = buildPolygonGeometry(ring, heightAt, { yOffset: 0.15 });
        const mat = this.materials.get({ kind: 'transparent', color: (node.data.color as string) ?? '#63b3ed', opacity: 0.4 });
        return new THREE.Mesh(geo, mat);
      }
      case 'vegetation': {
        const count = Math.min(4000, (node.data.count as number) ?? 400);
        const bounds = (node.data.bounds as { minX: number; minZ: number; maxX: number; maxZ: number }) ?? {
          minX: -60, minZ: -60, maxX: 60, maxZ: 60,
        };
        const instances = scatterVegetation({
          count,
          seed: (node.data.seed as number) ?? 7,
          bounds,
          heightAt,
          slopeAt: (x, z) => (this.terrain ? this.terrain.slopeAt(x, z) : 0),
          maxSlopeDeg: (node.data.maxSlopeDeg as number) ?? 38,
          scaleRange: [(node.data.minScale as number) ?? 0.7, (node.data.maxScale as number) ?? 1.5],
        });
        const trunk = new THREE.CylinderGeometry(0.18, 0.26, 1.6, 6);
        trunk.translate(0, 0.8, 0);
        const crown = new THREE.ConeGeometry(1.3, 3.2, 8);
        crown.translate(0, 3.0, 0);
        const merged = mergeGeometriesSimple(trunk, crown);
        const mat = this.materials.get({ kind: 'vegetation', color: (node.data.color as string) ?? '#3f7a3a', roughness: 1 });
        const mesh = new THREE.InstancedMesh(merged, mat, instances.length);
        const dummy = new THREE.Object3D();
        instances.forEach((inst, i) => {
          dummy.position.set(inst.x, inst.y, inst.z);
          dummy.rotation.set(0, (inst.rotYDeg * Math.PI) / 180, 0);
          dummy.scale.setScalar(inst.scale);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.frustumCulled = false;
        this.instancedVegetation = mesh;
        return mesh;
      }
      case 'labels':
      case 'annotations':
      case 'measurements':
      case 'effects':
      case 'group':
      case 'triggers':
      default:
        return null;
    }
  }

  /* ------------------------------------------------------------ selection --- */

  updateSelectionVisuals(): void {
    const st = this.store.getState();
    if (this.selectionBox) {
      this.helperGroup.remove(this.selectionBox);
      this.selectionBox.dispose();
      this.selectionBox = null;
    }
    if (this.hoverOutline) {
      this.helperGroup.remove(this.hoverOutline);
      this.hoverOutline.dispose();
      this.hoverOutline = null;
    }
    const ids = st.ui.selectedIds;
    if (ids.length === 1) {
      const obj = this.objectMeshes.get(ids[0]);
      if (obj) {
        this.selectionBox = new THREE.BoxHelper(obj, 0x63b3ed);
        this.selectionBox.renderOrder = 950;
        this.helperGroup.add(this.selectionBox);
      }
    } else if (ids.length > 1) {
      const box = new THREE.Box3();
      for (const id of ids) {
        const obj = this.objectMeshes.get(id);
        if (obj) box.expandByObject(obj);
      }
      if (!box.isEmpty()) {
        const helper = new THREE.Box3Helper(box, new THREE.Color(0x63b3ed));
        this.helperGroup.add(helper);
        this.selectionBox = helper as unknown as THREE.BoxHelper;
      }
    }
    if (st.ui.hoverId && !ids.includes(st.ui.hoverId)) {
      const obj = this.objectMeshes.get(st.ui.hoverId);
      if (obj) {
        this.hoverOutline = new THREE.BoxHelper(obj, 0xffd166);
        this.hoverOutline.renderOrder = 940;
        this.helperGroup.add(this.hoverOutline);
      }
    }
  }

  /* --------------------------------------------------------- environment --- */

  applyEnvironment(project: Project): void {
    const env = project.environment;
    // Sun position derived from azimuth/elevation (also drives time-of-day).
    const azimuth = env.timeOfDay !== undefined ? sunAzimuthForTime(env.timeOfDay) : env.sunAzimuthDeg;
    const elevation = env.timeOfDay !== undefined ? sunElevationForTime(env.timeOfDay) : env.sunElevationDeg;
    this.scene.setSun(azimuth, elevation, elevation > 0 ? 2.4 : 0.15);
    const dayFactor = Math.max(0, Math.min(1, (elevation + 6) / 30));
    const sky = new THREE.Color().setHSL(0.58, 0.35, 0.12 + 0.5 * dayFactor);
    const ground = new THREE.Color().setHSL(0.1, 0.2, 0.08 + 0.18 * dayFactor);
    this.scene.setAmbient(sky.getHex(), ground.getHex(), 0.35 + 0.5 * dayFactor);
    this.scene.scene.background = sky.clone();
    this.scene.setFog(env.fog.mode, env.fog.color, env.fog.near, env.fog.far, env.fog.density);

    const quality = profileFor(project.performance.quality);
    const shadowsOn = env.shadows !== 'off' && quality.shadowsEnabled;
    this.scene.renderer.shadowMap.enabled = shadowsOn;
    const size = env.shadows === 'high' ? 2048 : env.shadows === 'medium' ? 1024 : 512;
    this.scene.setQuality({ ...quality, shadowsEnabled: shadowsOn, shadowMapSize: size });

    this.postfx?.setSettings({
      bloom: env.post.bloom,
      vignette: env.post.vignette,
      saturation: env.post.saturation,
      contrast: env.post.contrast,
      depthFade: env.post.depthFade,
      blurEnabled: env.post.blur.enabled,
      blurRadiusPx: env.post.blur.radiusPx,
      blurMix: env.post.blur.enabled ? 1 : 0,
      enabled: quality.postEnabled,
    });
  }

  private updateWater(dt: number): void {
    for (const m of this.waterMaterials) {
      const u = m.uniforms.uTime as { value: number };
      u.value += dt;
    }
  }

  private updateHelpers(state: ReturnType<typeof this.store.getState>): void {
    // grid
    const wantGrid = state.project.center.enabled || state.ui.mode === 'edit';
    if (wantGrid && !this.gridHelper) {
      const metersPerPixel = (2 * this.rig.distance * Math.tan((this.rig.fovDeg * Math.PI) / 360)) / Math.max(1, this.scene.viewportSize.height);
      const spacing = adaptiveGridSpacing(metersPerPixel);
      const size = Math.max(spacing * 40, 512);
      this.gridHelper = new THREE.GridHelper(size, Math.round(size / spacing), 0x3a4a55, 0x24303a);
      (this.gridHelper.material as THREE.Material).transparent = true;
      (this.gridHelper.material as THREE.Material).opacity = 0.35;
      this.gridHelper.position.y = 0.05;
      this.helperGroup.add(this.gridHelper);
    } else if (!wantGrid && this.gridHelper) {
      this.helperGroup.remove(this.gridHelper);
      this.gridHelper.dispose();
      this.gridHelper = null;
    }

    // contours
    const wantContours = state.project.terrain.contours.enabled;
    if (wantContours && !this.contourLines) this.rebuildContours();
    if (!wantContours && this.contourLines) {
      this.helperGroup.remove(this.contourLines);
      this.contourLines.geometry.dispose();
      this.contourLines = null;
    }
  }

  rebuildContours(): void {
    if (!this.terrain) return;
    const st = this.store.getState();
    const positions: number[] = [];
    for (const key of this.terrain.tileKeys()) {
      const tile = this.terrain.getTile(key);
      if (!tile) continue;
      const hf = tile.heightfield;
      const step = st.project.terrain.contours.interval;
      const { min, max } = hf.minMax();
      for (let level = Math.ceil(min / step) * step; level <= max; level += step) {
        // coarse marching squares over the heightfield grid
        const r = hf.resolution;
        for (let gy = 0; gy < r - 1; gy += 1) {
          for (let gx = 0; gx < r - 1; gx += 1) {
            const a = hf.data[gy * r + gx];
            const b = hf.data[gy * r + gx + 1];
            if ((a - level) * (b - level) < 0) {
              const t = (level - a) / (b - a || 1);
              const x = hf.originX + (gx + t) * hf.step;
              const y = hf.originY + gy * hf.step;
              positions.push(x - this.renderOffset.x, level + 0.4, y - this.renderOffset.z);
              positions.push(x - this.renderOffset.x + hf.step * 0.35, level + 0.4, y - this.renderOffset.z);
            }
          }
        }
      }
    }
    if (this.contourLines) {
      this.helperGroup.remove(this.contourLines);
      this.contourLines.geometry.dispose();
      this.contourLines = null;
    }
    if (!positions.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.contourLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xd6c48a, transparent: true, opacity: 0.55 }));
    this.contourLines.renderOrder = 6;
    this.helperGroup.add(this.contourLines);
  }

  private updateLabels(): void {
    const now = performance.now();
    if (now - this.lastLabelUpdate < 100) return;
    this.lastLabelUpdate = now;
    const st = this.store.getState();
    const basis = this.cameraBasis();
    const vp = this.scene.viewportSize;
    const candidates = st.project.layers
      .filter((n) => n.kind === 'labels' || n.kind === 'markers')
      .map((n) => {
        const s = worldToScreen(
          { x: n.position.x - this.renderOffset.x, y: n.position.y + 3 - this.renderOffset.y, z: n.position.z - this.renderOffset.z },
          basis,
          vp,
        );
        return {
          id: n.id,
          text: n.name || n.kind,
          x: s.x,
          y: s.y,
          visible: s.visible && n.visible,
          distance: Math.hypot(n.position.x - this.rig.position.x, n.position.y - this.rig.position.y, n.position.z - this.rig.position.z),
          priority: n.kind === 'markers' ? 60 : 40,
          width: 92,
          height: 20,
        };
      });
    this.labelLayout = layoutLabels(candidates, vp, 120);
  }

  /* ------------------------------------------------------------ panorama --- */

  /** (Re)enter panorama mode against the current document. */
  enterPanoramaMode(): void {
    const st = this.store.getState();
    const nodes = st.project.panorama.nodes;
    if (!nodes.length) {
      st.notify('warn', 'No panorama nodes in this world yet. Add one from the Panorama panel.');
      return;
    }
    const current = st.project.panorama.currentNodeId ?? nodes[0].id;
    if (!this.panorama) {
      this.panorama = new PanoramaCrossfade();
      this.scene.scene.add(this.panorama.group);
    }
    this.panoramaTransition = new PanoramaTransition({
      durationMs: st.project.panorama.transitionMs,
      persistence: st.project.panorama.persistence,
    });
    this.panoramaGraph.replaceAll(nodes);
    this.syncGridWalker(st.project);
    st.setPanoramaCurrent(current);
    this.loadPanorama(current, null);
    const node = nodes.find((n) => n.id === current);
    if (node) {
      this.rig.position = { ...node.position };
      this.rig.pitchDeg = 0;
      this.rig.headingDeg = node.headingDeg;
    }
  }

  /** Rebuild the panorama graph and grid walker from a (possibly new) document. */
  syncPanorama(project: Project): void {
    if (this.store.getState().project.camera.mode !== 'panorama') return;
    this.panoramaGraph.replaceAll(project.panorama.nodes);
    this.syncGridWalker(project);
  }

  /**
   * Build (or rebuild) the grid walker from canonical project state. The
   * signature check means an unrelated edit does not drop you mid-walk.
   */
  private syncGridWalker(project: Project): void {
    const cfg = project.panorama.grid;
    if (!cfg) {
      this.gridWalker = null;
      this.gridConfigSignature = '';
      return;
    }
    // Reconstruct the square list from the node ids. Squares are named
    // `<prefix>_<row>_<col>` by the demo builder, but anything with a matching
    // node is placed by its world position on the grid, so hand-authored
    // graphs work too.
    const spacing = cfg.spacing;
    const nodes = project.panorama.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      col: Math.round(n.position.x / spacing),
      row: Math.round(-n.position.z / spacing),
      x: n.position.x,
      z: n.position.z,
      image: n.image,
      goal: n.id === cfg.goalNodeId,
    }));
    const signature = `${cfg.cols}x${cfg.rows}@${spacing}|${nodes.length}|${cfg.goalNodeId ?? ''}|${nodes.map((n) => n.id).sort().join(',')}`;
    if (signature === this.gridConfigSignature && this.gridWalker) {
      this.gridWalker.setNodes(nodes);
      return;
    }
    this.gridConfigSignature = signature;
    this.gridWalker = new GridWalker({
      cols: cfg.cols,
      rows: cfg.rows,
      spacing,
      walkSpeed: cfg.walkSpeed,
      gaitNoise: cfg.gaitNoise,
      bobAmplitude: cfg.bobAmplitude,
      bobHz: cfg.bobHz,
      seed: cfg.seed,
    });
    this.gridWalker.setNodes(nodes);
    const start = project.panorama.currentNodeId ?? nodes[0]?.id;
    if (start) this.gridWalker.teleport(start);
    this.gridPath.length = 0;
    if (start) this.gridPath.push(start);
  }

  /** Read-only snapshot of grid-walk state, for the HUD. */
  getGridSnapshot() {
    const w = this.gridWalker;
    if (!w) return null;
    const cur = w.currentNode;
    return {
      nodeId: cur?.id ?? null,
      name: cur?.name ?? '',
      col: cur?.col ?? 0,
      row: cur?.row ?? 0,
      stepsTaken: this.gridPath.length - 1,
      movesToGoal: w.movesToGoal,
      stepping: w.isStepping,
      path: [...this.gridPath],
      moves: w.availableMoves().map((m) => ({ dx: m.dx, dy: m.dy, name: m.name, to: m.to.id, toName: m.to.name })),
    };
  }

  /**
   * Take one king's move programmatically — used by the on-screen direction
   * pad so the board is walkable without a keyboard.
   */
  gridStep(dx: number, dy: number): boolean {
    const w = this.gridWalker;
    if (!w) return false;
    if (w.isStepping) return false;
    const started = w.startStep(dx, dy);
    if (started) this.telemetry.panoramaSteps++;
    return started;
  }

  /** Warp straight to a square (used by the minimap and the node list). */
  jumpToGridNode(nodeId: string): boolean {
    if (!this.gridWalker) return false;
    if (!this.gridWalker.teleport(nodeId)) return false;
    const prev = this.store.getState().project.panorama.currentNodeId;
    this.loadPanorama(nodeId, prev);
    this.store.getState().setPanoramaCurrent(nodeId);
    this.gridPath.push(nodeId);
    return true;
  }

  private loadPanorama(nodeId: string, previousId: string | null): void {
    const st = this.store.getState();
    const node = st.project.panorama.nodes.find((n) => n.id === nodeId);
    if (!this.panorama) return;
    if (!node) return;
    const caps = node.cap ?? { enabled: true, top: '#8fb8e8', bottom: '#4a4a45', blendDeg: 18 };
    this.panorama.incoming.setCaps(caps);
    this.panorama.outgoing.setCaps(caps);
    this.panorama.incoming.setVFovScale(node.vfovDeg ?? 180);
    this.panorama.outgoing.setVFovScale(node.vfovDeg ?? 180);

    if (previousId) {
      const prevTex = this.panoTextures.get(previousId) ?? null;
      this.panorama.outgoing.setTexture(prevTex);
      this.panorama.outgoing.setOpacity(1);
      this.panoramaTransition?.start(previousId, nodeId);
    }
    if (!node.image) {
      this.panorama.incoming.setTexture(null);
      st.notify('warn', `Panorama "${node.name || node.id}" has no image — showing the environment fallback.`);
      return;
    }
    let tex = this.panoTextures.get(node.id);
    if (!tex) {
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin('anonymous');
      tex = loader.load(
        node.image,
        (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.mapping = THREE.EquirectangularReflectionMapping;
          t.minFilter = THREE.LinearFilter;
          t.generateMipmaps = false;
        },
        undefined,
        () => {
          st.setErrors({ provider: `Could not load panorama image for "${node.name || node.id}". Check the URL or your connection.` });
        },
      );
      this.panoTextures.set(node.id, tex);
    }
    this.panorama.incoming.setTexture(tex);
  }

  stepPanorama(direction: 1 | -1): void {
    const st = this.store.getState();
    const nodes = st.project.panorama.nodes;
    if (!nodes.length) return;
    const currentId = st.project.panorama.currentNodeId ?? nodes[0].id;
    const idx = nodes.findIndex((n) => n.id === currentId);
    const next = nodes[(idx + direction + nodes.length) % nodes.length];
    this.goToPanorama(next.id);
  }

  goToPanorama(nodeId: string): void {
    const st = this.store.getState();
    const prev = st.project.panorama.currentNodeId;
    if (prev === nodeId) return;
    const node = st.project.panorama.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    this.loadPanorama(nodeId, prev);
    st.setPanoramaCurrent(nodeId);
    if (st.project.panorama.persistence.keepCameraState) {
      // keep the look direction; only the position changes
      this.rig.position = { ...node.position };
    } else {
      this.rig.position = { ...node.position };
      this.rig.headingDeg = node.headingDeg;
      this.rig.pitchDeg = 0;
    }
  }

  private updatePanorama(state: ReturnType<typeof this.store.getState>, dt: number): void {
    if (!this.panorama) return;
    const camPos = new THREE.Vector3(
      this.rig.position.x - this.renderOffset.x,
      this.rig.position.y - this.renderOffset.y,
      this.rig.position.z - this.renderOffset.z,
    );
    this.panorama.follow(camPos);
    const panoState = this.panoramaTransition?.update();
    const persistence = state.project.panorama.persistence;
    if (panoState && panoState.phase === 'crossfading') {
      this.panorama.setProgress(panoState.progress, persistence.enabled, persistence.strength);
    } else {
      this.panorama.setProgress(1, persistence.enabled, persistence.strength);
    }

    // pitch clamp so poles are never exposed (REQUIREMENT 040)
    const limit = state.project.panorama.pitchClampDeg;
    const clamped = clampPanoramaPitch(this.rig.pitchDeg, limit);
    if (clamped !== this.rig.pitchDeg) this.rig.pitchDeg = clamped;

    // Discrete grid walking ("chessboard street view"): WASD takes one king's
    // move per press, the step is a gait-noise spring, and the panorama warps
    // when the square is committed.
    if (this.gridWalker) {
      this.updateGridWalk(state, dt);
      return;
    }

    // synthetic spatial movement between linked nodes (REQUIREMENT 043)
    const current = state.project.panorama.nodes.find((n) => n.id === state.project.panorama.currentNodeId);
    if (current && this.axes.forward !== 0) {
      const neighbours = this.panoramaGraph.neighborsOf(current.id);
      if (neighbours.length) {
        const dir = headingDir2(this.rig.headingDeg);
        const best = neighbours
          .map((n) => ({ n, dot: dot2(dir, { x: n.position.x - current.position.x, y: n.position.z - current.position.z }) }))
          .sort((a, b) => b.dot - a.dot)[0];
        if (best && best.dot > 0.5) {
          const t = Math.min(1, Math.abs(this.axes.forward) * dt * 1.6);
          const plan = planSyntheticMove(
            { from: current as PanoramaNode, to: best.n as PanoramaNode, direction: dir, t },
            Math.hypot(best.n.position.x - current.position.x, best.n.position.z - current.position.z),
          );
          if (t >= 0.999) this.goToPanorama(best.n.id);
          else this.rig.pitchDeg = clampPanoramaPitch(this.rig.pitchDeg, plan.pitchClampDeg);
        }
      }
    }
    void dt;
  }

  private updateGridWalk(state: ReturnType<typeof this.store.getState>, dt: number): void {
    const w = this.gridWalker;
    if (!w) return;
    const cfg = state.project.panorama.grid;
    if (!cfg) return;

    // A press, not a hold, starts a step — that is what makes it a chessboard
    // rather than free movement. The axis is edge-detected here.
    const wantMove = this.axes.forward !== 0 || this.axes.right !== 0;
    if (wantMove && !w.isStepping && !this.gridMoveLatch) {
      const move = this.resolveKingMove(cfg.allowDiagonals);
      if (move) {
        if (w.startStep(move.dx, move.dy)) this.telemetry.panoramaSteps++;
        else this.store.getState().notify('info', 'There is no capture square that way.');
      }
      this.gridMoveLatch = true;
    } else if (!wantMove) {
      this.gridMoveLatch = false;
    }

    const s = w.advance(dt, 1.7);

    // Drive the rig from the walker so the sphere follows the feet.
    this.rig.position.x = s.x;
    this.rig.position.y = s.y;
    this.rig.position.z = s.z;
    if (s.phase === 'stepping' && s.targetId) {
      // Turn to face where you are walking, but keep manual look authority.
      const delta = shortestAngleDeg(this.rig.headingDeg, s.headingDeg);
      this.rig.headingDeg += delta * Math.min(1, dt * 6);
    }

    if (s.arrivedAt) {
      const prev = state.project.panorama.currentNodeId;
      this.loadPanorama(s.arrivedAt, prev);
      this.store.getState().setPanoramaCurrent(s.arrivedAt);
      this.gridPath.push(s.arrivedAt);
      const node = state.project.panorama.nodes.find((n) => n.id === s.arrivedAt);
      const left = w.movesToGoal;
      if (node?.id === cfg.goalNodeId) {
        this.store.getState().notify('ok', `Arrived at ${node.name}. ${this.gridPath.length - 1} squares walked.`);
      } else if (left !== null) {
        this.store.getState().notify('info', `${node?.name ?? s.arrivedAt} — ${left} king move${left === 1 ? '' : 's'} to the church.`);
      }
    }
  }

  /**
   * Combine the WASD axes into one of the eight king's moves, then snap to the
   * camera heading so "forward" means "away from where I am looking".
   */
  private resolveKingMove(allowDiagonals: boolean): { dx: number; dy: number; name: string } | null {
    const f = this.axes.forward;
    const r = this.axes.right;
    if (f === 0 && r === 0) return null;
    // Input-space direction, then rotate by the camera heading.
    const ix = r;
    const iy = f;
    const heading = ((this.rig.headingDeg % 360) + 360) % 360;
    // World heading of the requested move: heading 0 = north = -Z.
    const worldHeading = (Math.atan2(ix, iy) * 180) / Math.PI + heading;
    const move = headingToKingMove(worldHeading);
    if (!allowDiagonals && move.dx !== 0 && move.dy !== 0) {
      // Snap a diagonal request to whichever cardinal the user leaned on more.
      return Math.abs(f) >= Math.abs(r) ? headingToKingMove(heading) : headingToKingMove(heading + 90);
    }
    return move;
  }

  private updatePanoramaLook(dt: number): void {
    const s = this.axes;
    this.rig.headingDeg -= s.yaw * 90 * dt;
    this.rig.pitchDeg += s.pitch * 60 * dt;
    this.rig.headingDeg = ((this.rig.headingDeg + 180) % 360 + 360) % 360 - 180;
  }

  /* ----------------------------------------------------------- fullscreen --- */

  async toggleFullscreen(): Promise<boolean> {
    const ok = await this.input.fullscreen.toggle();
    this.scene.resize();
    // The viewport must keep input ownership in fullscreen (REQUIREMENT 031).
    this.input.focus.focusViewport('programmatic');
    return ok;
  }

  get isFullscreen(): boolean {
    return this.input.fullscreen.active;
  }

  requestPointerLock(): boolean {
    this.telemetry.pointerLockAttempts++;
    return this.input.lock.request();
  }

  /* --------------------------------------------------------------- misc --- */

  frameSelection(): void {
    const st = this.store.getState();
    const ids = st.ui.selectedIds;
    if (!ids.length) return;
    const first = findNodeById(st.project.layers, ids[0]);
    if (!first) return;
    this.flyTo({ target: { ...first.position }, distance: Math.max(20, this.rig.distance * 0.6) }, 'Frame selection');
  }

  /** Hand keyboard ownership back to the canvas after an overlay closes. */
  focusViewport(): void {
    this.input.focus.setOverlayOpen('command-palette', false);
    const canvas = this.scene.renderer.domElement as HTMLCanvasElement;
    this.input.focus.setViewport(canvas);
    canvas.focus({ preventScroll: true });
  }

  /** Dolly the orbit rig by a multiplicative factor (clamped by the mode). */
  zoomBy(factor: number, label = 'Zoom'): void {
    const d = this.rig.distance * factor;
    this.flyTo({ distance: Math.min(200000, Math.max(0.5, d)) }, label);
  }

  /** Set an absolute heading, animated through the transition controller. */
  setHeading(headingDeg: number, label = 'Rotate'): void {
    this.flyTo({ headingDeg }, label);
  }

  setPitch(pitchDeg: number, label = 'Tilt'): void {
    this.flyTo({ pitchDeg: Math.max(-89, Math.min(89, pitchDeg)) }, label);
  }

  /** Return the saved starting view of the current document. */
  resetView(): void {
    const cam = this.store.getState().project.camera;
    this.flyTo(
      {
        position: { ...cam.position },
        target: { ...cam.target },
        headingDeg: cam.headingDeg,
        pitchDeg: cam.pitchDeg,
        distance: cam.distance,
        fovDeg: cam.fovDeg,
      },
      'Reset view',
    );
  }

  /**
   * Ground resolution at the current orbit pivot, in metres per CSS pixel.
   * Derived from the live projection — this is what the scale bar renders, so
   * the bar can never disagree with what is actually on screen.
   */
  metersPerPixel(): number {
    const cam = this.scene.camera;
    const heightPx = Math.max(1, this.scene.viewportSize.height);
    const fov = ((cam.fov || 60) * Math.PI) / 180;
    const viewHeightAtPivot = 2 * Math.tan(fov / 2) * Math.max(0.001, this.rig.distance);
    return viewHeightAtPivot / heightPx;
  }

  /** Public hook used by the QA harness and the benchmark script. */
  getDebugSnapshot() {
    return {
      rig: JSON.parse(JSON.stringify(this.rig)) as RigState,
      renderOffset: { x: this.renderOffset.x, y: this.renderOffset.y, z: this.renderOffset.z },
      telemetry: { ...this.telemetry },
      tiles: this.terrain?.stats ?? null,
      commandStats: this.input.bus.getStats(),
      focus: this.input.focus.snapshot(),
      pointerLock: this.input.lock.getState(),
      fullscreen: this.input.fullscreen.active,
      transition: this.transition.stats,
      panorama: this.panoramaTransition?.stats ?? null,
      adaptive: this.adaptive.current,
      tileCount: this.tileMeshes.size,
      objectCount: this.objectMeshes.size,
      labels: { placed: this.labelLayout.placed.length, dropped: this.labelLayout.dropped },
      frames: this.scene.frameCount,
      info: this.scene.getInfo(),
    };
  }

  /** Force a synchronous terrain update — used by tests and QA. */
  forceTerrainUpdate(): void {
    const st = this.store.getState();
    this.updateTerrain(st);
  }

  getTerrainEngine(): TerrainEngine | null {
    return this.terrain;
  }

  getSceneManager(): SceneManager {
    return this.scene;
  }

  getCameraBasis() {
    return this.cameraBasis();
  }

  /** Screen->world on the terrain, used by tools outside the pointer layer. */
  screenToTerrain(sx: number, sy: number): { x: number; y: number; z: number } | null {
    const hit = this.pickTerrain(sx, sy);
    if (hit) return { x: hit.point.x + this.renderOffset.x, y: hit.point.y, z: hit.point.z + this.renderOffset.z };
    const vp = this.scene.viewportSize;
    const basis = this.cameraBasis();
    const p = screenToWorldOnPlane(sx, sy, basis, vp, 0);
    return p ? { x: p.x + this.renderOffset.x, y: 0, z: p.z + this.renderOffset.z } : null;
  }

  /** Ray-terrain hit used by walk-mode ground probes and the QA harness. */
  rayTerrain(sx: number, sy: number) {
    const vp = this.scene.viewportSize;
    const ray = rayFromScreen(sx, sy, this.cameraBasis(), vp);
    return rayTerrainHit(ray, (x, z) => this.terrain?.heightAt(x + this.renderOffset.x, z + this.renderOffset.z) ?? null, {
      maxDistance: 20000,
    });
  }
}

/* ------------------------------------------------------------------ helpers --- */

function findNodeById(nodes: ObjectNode[], id: string): ObjectNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const f = findNodeById(n.children, id);
    if (f) return f;
  }
  return null;
}

function contentSignature(node: ObjectNode): string {
  return JSON.stringify({ k: node.kind, d: node.data, a: node.anchor });
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
}

function defaultFootprint(w: number, d: number): Vec2[] {
  const hw = w / 2;
  const hd = d / 2;
  return [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ];
}

/** Minimal geometry merge (no BufferGeometryUtils dependency). */
function mergeGeometriesSimple(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const pa = a.getAttribute('position') as THREE.BufferAttribute;
  const pb = b.getAttribute('position') as THREE.BufferAttribute;
  const positions = new Float32Array(pa.count * 3 + pb.count * 3);
  positions.set(pa.array as Float32Array, 0);
  positions.set(pb.array as Float32Array, pa.count * 3);
  const indices: number[] = [];
  const ia = a.getIndex();
  const ib = b.getIndex();
  if (ia) for (let i = 0; i < ia.count; i++) indices.push(ia.getX(i));
  else for (let i = 0; i < pa.count; i++) indices.push(i);
  if (ib) for (let i = 0; i < ib.count; i++) indices.push(ib.getX(i) + pa.count);
  else for (let i = 0; i < pb.count; i++) indices.push(i + pa.count);
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setIndex(indices);
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}

function sunAzimuthForTime(hour: number): number {
  // Sun sweeps east -> west over the day.
  return ((hour - 6) / 12) * 180;
}

function sunElevationForTime(hour: number): number {
  const t = ((hour - 6) / 12) * Math.PI;
  return Math.sin(t) * 62;
}

/** Signed shortest difference a -> b in degrees, in (-180, 180]. */
function shortestAngleDeg(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

function headingDir2(headingDeg: number): { x: number; y: number } {
  const rad = (headingDeg * Math.PI) / 180;
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}

function dot2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const la = Math.hypot(a.x, a.y) || 1;
  const lb = Math.hypot(b.x, b.y) || 1;
  return (a.x * b.x + a.y * b.y) / (la * lb);
}

export { UP, applyStroke, buildTerrainMesh };
