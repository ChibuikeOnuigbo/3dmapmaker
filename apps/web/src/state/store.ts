/**
 * apps/web — canonical application state.
 *
 * One zustand store owns the project document, the editor UI state and the
 * history/persistence controllers. Every subsystem reads and writes here; the
 * renderer is a pure consumer. That is what "its state is represented in the
 * canonical project/engine state" means in practice.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import {
  History,
  SaveController,
  loadProject,
  newId,
  newProject,
  recover,
  resolveStorage,
  serializeProject,
  validateProject,
  type Bookmark,
  type CameraMode,
  type ObjectNode,
  type PanoramaNode,
  type Project,
  type TerrainSource,
  type TourStop,
  type Vec3T,
} from '@3dmm/project';
import {
  insertNode,
  removeNode,
  reparent,
  reorder,
  setLocked,
  setVisibility,
  updateNode,
  LayerTreeMutationError,
} from '@3dmm/layers';
import type { AppTutorialContext } from '@3dmm/tutorial';
import { emptyTutorialContext } from '@3dmm/tutorial';

export type ToolId =
  | 'select'
  | 'move'
  | 'rotate'
  | 'scale'
  | 'sculpt'
  | 'measure'
  | 'path'
  | 'polygon'
  | 'panorama'
  | 'water'
  | 'vegetation';

export type AppMode = 'edit' | 'play' | 'presentation';

export interface UiState {
  tool: ToolId;
  mode: AppMode;
  selectedIds: string[];
  hoverId: string | null;
  isolated: string[] | null;
  activePanel: 'layers' | 'inspector' | 'build' | 'assets' | 'environment' | 'physics' | 'ai' | null;
  commandPaletteOpen: boolean;
  modal: string | null;
  viewportFocused: boolean;
  pointerLock: 'unsupported' | 'unlocked' | 'locked' | 'denied' | 'pending';
  fullscreen: boolean;
  reducedMotion: boolean;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  statsOpen: boolean;
  qaOpen: boolean;
  tourPlaying: boolean;
  tourIndex: number;
  tutorialStep: number;
  tutorialPhase: 'idle' | 'running' | 'paused' | 'completed' | 'skipped';
  tutorialBlocked: string | null;
  notifications: Array<{ id: string; tone: 'info' | 'ok' | 'warn' | 'error'; text: string; at: number }>;
}

export interface ErrorState {
  save: string | null;
  terrain: string | null;
  provider: string | null;
  import: string | null;
  pointerLock: string | null;
  webgl: string | null;
  validation: string[];
}

export interface StatsSnapshot {
  fps: number;
  frameMs: number;
  cpuMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  tiles: { active: number; loading: number; queued: number; failed: number };
  cacheBytes: number;
  quality: 'low' | 'normal' | 'high';
  adaptiveChanges: number;
  workerAvailable: boolean;
  wasmAvailable: boolean;
}

export interface StoreState {
  project: Project;
  ui: UiState;
  errors: ErrorState;
  stats: StatsSnapshot;
  saveStatus: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
  lastSavedAt: number;
  dirty: boolean;
  recoveryWarnings: string[];
  /** Bumped on every project mutation so the renderer can diff cheaply. */
  projectRevision: number;
  /** Bumped when terrain edits change so tiles are re-fetched. */
  terrainRevision: number;
  canUndo: boolean;
  canRedo: boolean;
  historyLabels: string[];
  benchmark: Record<string, number>;

  // ---- actions ----
  loadDemo: (project: Project, label: string) => void;
  newWorld: () => void;
  openProjectJson: (raw: unknown) => void;
  mutate: (fn: (draft: Project) => void, label: string, tag?: string | null) => void;
  setCamera: (patch: Partial<Project['camera']>) => void;
  setCameraMode: (mode: CameraMode) => void;
  setTransition: (patch: Partial<Project['transition']>) => void;
  setTerrainSource: (source: TerrainSource) => void;
  setTerrain: (patch: Partial<Project['terrain']>) => void;
  commitTerrainEdits: (edits: Record<string, Record<string, number>>) => void;
  setEnvironment: (patch: Partial<Project['environment']>) => void;
  setPerformance: (patch: Partial<Project['performance']>) => void;
  setGrid: (patch: Partial<Project['grid']>) => void;
  setPhysics: (patch: Partial<Project['physics']>) => void;
  setPhysicsSurface: (name: string, patch: Partial<Project['physics']['surfaces'][string]>) => void;
  upsertCollisionProxy: (id: string, proxy: Project['physics']['proxies'][string]) => void;
  removeCollisionProxy: (id: string) => void;
  setAi: (patch: Partial<Project['ai']>) => void;
  appendAiMessage: (entry: { role: 'user' | 'assistant' | 'error'; text: string }) => void;
  setSearchResults: (query: string, results: Project['search']['results']) => void;
  setSearchProvider: (providerId: string, apiKeyRef?: string) => void;
  setPanorama: (patch: Partial<Project['panorama']>) => void;
  upsertPanoramaNode: (node: PanoramaNode) => void;
  linkPanorama: (fromId: string, direction: string, toId: string) => void;
  setPanoramaCurrent: (id: string | null) => void;
  setUi: (patch: Partial<UiState>) => void;
  setErrors: (patch: Partial<ErrorState>) => void;
  setStats: (patch: Partial<StatsSnapshot>) => void;
  notify: (tone: UiState['notifications'][number]['tone'], text: string) => void;
  dismissNotification: (id: string) => void;
  select: (ids: string[], mode?: 'replace' | 'add' | 'toggle') => void;
  setHover: (id: string | null) => void;
  addLayer: (node: ObjectNode, parentId?: string | null) => void;
  deleteSelection: () => void;
  duplicateSelection: () => void;
  updateLayer: (id: string, patch: Partial<ObjectNode>) => void;
  moveLayer: (id: string, parentId: string | null, index?: number) => void;
  reorderLayer: (id: string, index: number) => void;
  toggleLayerVisibility: (id: string) => void;
  toggleLayerLock: (id: string) => void;
  isolate: (ids: string[] | null) => void;
  addMeasurement: (m: Project['measurements'][number]) => void;
  clearMeasurements: () => void;
  addBookmark: (name: string) => void;
  removeBookmark: (id: string) => void;
  addTourStop: (stop: TourStop) => void;
  removeTourStop: (id: string) => void;
  undo: () => void;
  redo: () => void;
  saveNow: () => void;
  exportProject: () => string;
  setBenchmark: (patch: Record<string, number>) => void;
  getTutorialContext: () => AppTutorialContext;
}

const initialProject = newProject('Untitled world');

function initialStorage() {
  return resolveStorage(null);
}

export const useStore = create<StoreState>()(
  subscribeWithSelector((set, get) => {
    const storage = initialStorage();
    const history = new History(initialProject);
    const saveController = new SaveController({
      onStatus: (status) => set({ saveStatus: status }),
    }, storage);

    return {
      project: initialProject,
      ui: {
        tool: 'select',
        mode: 'edit',
        selectedIds: [],
        hoverId: null,
        isolated: null,
        activePanel: 'layers',
        commandPaletteOpen: false,
        modal: null,
        viewportFocused: false,
        pointerLock: 'unlocked',
        fullscreen: false,
        reducedMotion: false,
        leftPanelOpen: true,
        rightPanelOpen: true,
        statsOpen: false,
        qaOpen: false,
        tourPlaying: false,
        tourIndex: 0,
        tutorialStep: 0,
        tutorialPhase: 'idle',
        tutorialBlocked: null,
        notifications: [],
      },
      errors: { save: null, terrain: null, provider: null, import: null, pointerLock: null, webgl: null, validation: [] },
      stats: {
        fps: 0,
        frameMs: 0,
        cpuMs: 0,
        drawCalls: 0,
        triangles: 0,
        geometries: 0,
        textures: 0,
        tiles: { active: 0, loading: 0, queued: 0, failed: 0 },
        cacheBytes: 0,
        quality: 'normal',
        adaptiveChanges: 0,
        workerAvailable: false,
        wasmAvailable: false,
      },
      saveStatus: 'idle',
      lastSavedAt: 0,
      dirty: false,
      recoveryWarnings: [],
      projectRevision: 0,
      terrainRevision: 0,
      canUndo: false,
      canRedo: false,
      historyLabels: history.labels,
      benchmark: {},

      loadDemo: (project, label) => {
        const validation = validateProject(project);
        history.clear(project);
        set((s) => ({
          project,
          projectRevision: s.projectRevision + 1,
          terrainRevision: s.terrainRevision + 1,
          canUndo: false,
          canRedo: false,
          historyLabels: history.labels,
          errors: { ...s.errors, validation: validation.issues.map((i) => `${i.code}: ${i.message}`) },
          ui: { ...s.ui, selectedIds: [], isolated: null, tool: 'select' },
        }));
        get().notify('ok', `Loaded demo: ${label}`);
        saveController.markDirty();
      },

      newWorld: () => {
        const p = newProject('Untitled world');
        history.clear(p);
        set((s) => ({
          project: p,
          projectRevision: s.projectRevision + 1,
          terrainRevision: s.terrainRevision + 1,
          canUndo: false,
          canRedo: false,
          ui: { ...s.ui, selectedIds: [] },
        }));
        saveController.markDirty();
      },

      openProjectJson: (raw) => {
        try {
          const { project, appliedMigrations } = loadProject(raw);
          const validation = validateProject(project);
          if (!validation.ok) {
            set((s) => ({
              errors: { ...s.errors, import: validation.issues.map((i) => `${i.path}: ${i.message}`).slice(0, 5).join('; ') },
            }));
            return;
          }
          history.clear(project);
          set((s) => ({
            project,
            projectRevision: s.projectRevision + 1,
            terrainRevision: s.terrainRevision + 1,
            errors: { ...s.errors, import: null },
            ui: { ...s.ui, selectedIds: [] },
          }));
          if (appliedMigrations.length) {
            get().notify('info', `Imported and migrated from schema v${appliedMigrations[0]}.`);
          } else {
            get().notify('ok', 'Project imported.');
          }
        } catch (err) {
          set((s) => ({
            errors: { ...s.errors, import: err instanceof Error ? err.message : String(err) },
          }));
        }
      },

      mutate: (fn, label, tag = null) => {
        // Produce a new document; we never mutate the store's object in place.
        const next = JSON.parse(JSON.stringify(get().project)) as Project;
        fn(next);
        next.updatedAt = Date.now();
        history.push(next, label, tag);
        set((s) => ({
          project: next,
          projectRevision: s.projectRevision + 1,
          canUndo: history.canUndo,
          canRedo: history.canRedo,
          historyLabels: history.labels,
          dirty: true,
        }));
        saveController.markDirty();
      },

      setCamera: (patch) => {
        const next = { ...get().project, camera: { ...get().project.camera, ...patch } };
        set((s) => ({ project: next, projectRevision: s.projectRevision + 1 }));
      },

      setCameraMode: (mode) => get().mutate((p) => { p.camera.mode = mode; }, `Camera mode: ${mode}`),

      setTransition: (patch) => get().mutate((p) => { Object.assign(p.transition, patch); }, 'Transition preset'),

      setTerrainSource: (source) => {
        get().mutate((p) => { p.terrain.source = source; p.terrain.edits = {}; }, `Terrain source: ${source.kind}`);
        set((s) => ({ terrainRevision: s.terrainRevision + 1 }));
      },

      setTerrain: (patch) => {
        get().mutate((p) => { Object.assign(p.terrain, patch); }, 'Terrain settings');
        set((s) => ({ terrainRevision: s.terrainRevision + 1 }));
      },

      commitTerrainEdits: (edits) => {
        const next = JSON.parse(JSON.stringify(get().project)) as Project;
        next.terrain.edits = edits;
        next.updatedAt = Date.now();
        history.push(next, 'Sculpt terrain', 'sculpt');
        set((s) => ({
          project: next,
          projectRevision: s.projectRevision + 1,
          canUndo: history.canUndo,
          canRedo: history.canRedo,
          dirty: true,
        }));
        saveController.markDirty();
      },

      setEnvironment: (patch) => get().mutate((p) => { Object.assign(p.environment, patch); }, 'Environment'),
      setPerformance: (patch) => get().mutate((p) => { Object.assign(p.performance, patch); }, 'Performance'),

      setGrid: (patch) =>
        get().mutate((d) => {
          d.grid = { ...d.grid, ...patch };
        }, 'Grid', null),

      setPhysics: (patch) =>
        get().mutate((d) => {
          d.physics = { ...d.physics, ...patch };
        }, 'Physics', null),

      setPhysicsSurface: (name, patch) =>
        get().mutate((d) => {
          const current = d.physics.surfaces[name] ?? { friction: 0.6, restitution: 0.05, speedFactor: 1, stiffness: 120, damping: 2 };
          d.physics = { ...d.physics, surfaces: { ...d.physics.surfaces, [name]: { ...current, ...patch } } };
        }, 'Surface', null),

      upsertCollisionProxy: (id, proxy) =>
        get().mutate((d) => {
          d.physics = { ...d.physics, proxies: { ...d.physics.proxies, [id]: proxy } };
        }, 'Collision proxy'),

      removeCollisionProxy: (id) =>
        get().mutate((d) => {
          const next = { ...d.physics.proxies };
          delete next[id];
          d.physics = { ...d.physics, proxies: next };
        }, 'Collision proxy'),

      setAi: (patch) =>
        get().mutate((d) => {
          d.ai = { ...d.ai, ...patch };
        }, 'Assistant', null),

      appendAiMessage: (entry) =>
        get().mutate((d) => {
          d.ai = {
            ...d.ai,
            history: [...d.ai.history, { id: newId('msg'), role: entry.role, text: entry.text, at: Date.now() }].slice(-60),
          };
        }, 'Assistant', null),

      setSearchResults: (query, results) =>
        get().mutate((d) => {
          d.search = { ...d.search, query, results };
        }, 'Search', null),

      setSearchProvider: (providerId, apiKeyRef) =>
        get().mutate((d) => {
          d.search = {
            ...d.search,
            providerId,
            apiKeyRef: apiKeyRef === undefined ? d.search.apiKeyRef : apiKeyRef,
            results: [],
          };
        }, 'Search provider'),

      setPanorama: (patch) => get().mutate((p) => { Object.assign(p.panorama, patch); }, 'Panorama settings'),

      upsertPanoramaNode: (node) =>
        get().mutate((p) => {
          const idx = p.panorama.nodes.findIndex((n) => n.id === node.id);
          if (idx >= 0) p.panorama.nodes[idx] = node;
          else p.panorama.nodes.push(node);
        }, 'Panorama node'),

      linkPanorama: (fromId, direction, toId) =>
        get().mutate((p) => {
          const from = p.panorama.nodes.find((n) => n.id === fromId);
          if (!from) return;
          from.neighbors[direction] = toId;
        }, 'Link panorama'),

      setPanoramaCurrent: (id) => {
        set((s) => ({
          project: { ...s.project, panorama: { ...s.project.panorama, currentNodeId: id } },
          projectRevision: s.projectRevision + 1,
        }));
      },

      setUi: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),

      setErrors: (patch) => set((s) => ({ errors: { ...s.errors, ...patch } })),

      setStats: (patch) => set((s) => ({ stats: { ...s.stats, ...patch } })),

      notify: (tone, text) => {
        const id = newId('note');
        set((s) => ({
          ui: { ...s.ui, notifications: [...s.ui.notifications.slice(-4), { id, tone, text, at: Date.now() }] },
        }));
        setTimeout(() => get().dismissNotification(id), tone === 'error' ? 12000 : 5000);
      },

      dismissNotification: (id) =>
        set((s) => ({ ui: { ...s.ui, notifications: s.ui.notifications.filter((n) => n.id !== id) } })),

      select: (ids, mode = 'replace') =>
        set((s) => {
          if (mode === 'replace') return { ui: { ...s.ui, selectedIds: ids } };
          if (mode === 'add') return { ui: { ...s.ui, selectedIds: [...new Set([...s.ui.selectedIds, ...ids])] } };
          const setIds = new Set(s.ui.selectedIds);
          for (const id of ids) {
            if (setIds.has(id)) setIds.delete(id);
            else setIds.add(id);
          }
          return { ui: { ...s.ui, selectedIds: [...setIds] } };
        }),

      setHover: (id) => set((s) => (s.ui.hoverId === id ? s : { ui: { ...s.ui, hoverId: id } })),

      addLayer: (node, parentId = null) => {
        try {
          const layers = insertNode(get().project.layers, node, parentId);
          get().mutate((p) => { p.layers = layers; }, `Add ${node.kind}`);
          set((s) => ({ ui: { ...s.ui, selectedIds: [node.id] } }));
        } catch (err) {
          const msg = err instanceof LayerTreeMutationError ? err.issue.code : err instanceof Error ? err.message : String(err);
          get().notify('error', `Could not add layer: ${msg}`);
        }
      },

      deleteSelection: () => {
        const ids = get().ui.selectedIds;
        if (!ids.length) return;
        try {
          let layers = get().project.layers;
          for (const id of ids) layers = removeNode(layers, id);
          get().mutate((p) => { p.layers = layers; }, `Delete ${ids.length} item(s)`);
          set((s) => ({ ui: { ...s.ui, selectedIds: [] } }));
        } catch (err) {
          get().notify('error', `Could not delete: ${err instanceof Error ? err.message : String(err)}`);
        }
      },

      duplicateSelection: () => {
        const ids = get().ui.selectedIds;
        if (!ids.length) return;
        get().mutate((p) => {
          const clones: ObjectNode[] = [];
          const walk = (nodes: ObjectNode[]) => {
            for (const n of nodes) {
              if (ids.includes(n.id)) {
                const clone: ObjectNode = JSON.parse(JSON.stringify(n));
                const reassign = (node: ObjectNode) => {
                  node.id = newId(node.kind);
                  node.name = `${node.name} copy`;
                  node.position = { x: node.position.x + 4, y: node.position.y, z: node.position.z + 4 };
                  for (const c of node.children) reassign(c);
                };
                reassign(clone);
                clones.push(clone);
              }
              walk(n.children);
            }
          };
          walk(p.layers);
          p.layers = [...p.layers, ...clones];
        }, 'Duplicate selection');
      },

      updateLayer: (id, patch) => {
        try {
          const layers = updateNode(get().project.layers, id, (n) => ({ ...n, ...patch }));
          get().mutate((p) => { p.layers = layers; }, 'Edit layer', 'transform');
        } catch (err) {
          get().notify('error', `Locked or missing: ${err instanceof LayerTreeMutationError ? err.issue.code : String(err)}`);
        }
      },

      moveLayer: (id, parentId, index = -1) => {
        try {
          const layers = reparent(get().project.layers, id, parentId, index);
          get().mutate((p) => { p.layers = layers; }, 'Move layer');
        } catch (err) {
          const issue = err instanceof LayerTreeMutationError ? err.issue : null;
          get().notify('error', issue ? `Move rejected: ${issue.code}` : `Move failed: ${String(err)}`);
        }
      },

      reorderLayer: (id, index) => {
        try {
          const layers = reorder(get().project.layers, id, index);
          get().mutate((p) => { p.layers = layers; }, 'Reorder layer');
        } catch (err) {
          get().notify('error', `Reorder rejected: ${err instanceof LayerTreeMutationError ? err.issue.code : String(err)}`);
        }
      },

      toggleLayerVisibility: (id) => {
        const find = (nodes: ObjectNode[]): ObjectNode | null => {
          for (const n of nodes) {
            if (n.id === id) return n;
            const f = find(n.children);
            if (f) return f;
          }
          return null;
        };
        const node = find(get().project.layers);
        if (!node) return;
        try {
          const layers = setVisibility(get().project.layers, id, !node.visible);
          get().mutate((p) => { p.layers = layers; }, node.visible ? 'Hide layer' : 'Show layer');
        } catch (err) {
          get().notify('error', String(err));
        }
      },

      toggleLayerLock: (id) => {
        const find = (nodes: ObjectNode[]): ObjectNode | null => {
          for (const n of nodes) {
            if (n.id === id) return n;
            const f = find(n.children);
            if (f) return f;
          }
          return null;
        };
        const node = find(get().project.layers);
        if (!node) return;
        try {
          const layers = setLocked(get().project.layers, id, !node.locked);
          get().mutate((p) => { p.layers = layers; }, node.locked ? 'Unlock layer' : 'Lock layer');
        } catch (err) {
          get().notify('error', String(err));
        }
      },

      isolate: (ids) => set((s) => ({ ui: { ...s.ui, isolated: ids } })),

      addMeasurement: (m) => get().mutate((p) => { p.measurements.push(m); }, 'Measurement'),
      clearMeasurements: () => get().mutate((p) => { p.measurements = []; }, 'Clear measurements'),

      addBookmark: (name) => {
        const bookmark: Bookmark = {
          id: newId('bm'),
          name: name || `Bookmark ${get().project.bookmarks.length + 1}`,
          camera: JSON.parse(JSON.stringify(get().project.camera)),
          createdAt: Date.now(),
        };
        get().mutate((p) => { p.bookmarks.push(bookmark); }, 'Add bookmark');
      },

      removeBookmark: (id) => get().mutate((p) => { p.bookmarks = p.bookmarks.filter((b) => b.id !== id); }, 'Remove bookmark'),

      addTourStop: (stop) => get().mutate((p) => { p.tour.push(stop); }, 'Add tour stop'),
      removeTourStop: (id) => get().mutate((p) => { p.tour = p.tour.filter((t) => t.id !== id); }, 'Remove tour stop'),

      undo: () => {
        const p = history.undo();
        if (!p) return;
        history.breakCoalesce();
        set((s) => ({
          project: p,
          projectRevision: s.projectRevision + 1,
          terrainRevision: s.terrainRevision + 1,
          canUndo: history.canUndo,
          canRedo: history.canRedo,
          historyLabels: history.labels,
          dirty: true,
        }));
        saveController.markDirty();
      },

      redo: () => {
        const p = history.redo();
        if (!p) return;
        set((s) => ({
          project: p,
          projectRevision: s.projectRevision + 1,
          terrainRevision: s.terrainRevision + 1,
          canUndo: history.canUndo,
          canRedo: history.canRedo,
          historyLabels: history.labels,
          dirty: true,
        }));
        saveController.markDirty();
      },

      saveNow: () => {
        const ok = saveController.flush(get().project);
        set((s) => ({
          dirty: !ok,
          lastSavedAt: ok ? Date.now() : s.lastSavedAt,
          errors: { ...s.errors, save: ok ? null : 'Save failed. Check storage quota or project validity.' },
        }));
        if (ok) get().notify('ok', 'Project saved to this browser.');
      },

      exportProject: () => serializeProject(get().project),

      setBenchmark: (patch) => set((s) => ({ benchmark: { ...s.benchmark, ...patch } })),

      getTutorialContext: () => {
        const s = get();
        const ctx = emptyTutorialContext();
        ctx.tool = s.ui.tool;
        ctx.hasTerrain = s.project.terrain.source.kind !== 'flat' || Object.keys(s.project.terrain.edits).length > 0;
        ctx.selectionCount = s.ui.selectedIds.length;
        ctx.sculptApplied = Object.keys(s.project.terrain.edits).length > 0;
        ctx.bookmarkCount = s.project.bookmarks.length;
        ctx.cameraMoved = s.benchmark.cameraMoves ? s.benchmark.cameraMoves > 0 : false;
        ctx.layerAdded = s.project.layers.length > 0;
        ctx.measurementCount = s.project.measurements.length;
        ctx.viewportFocused = s.ui.viewportFocused;
        ctx.quality = s.project.performance.quality;
        return ctx;
      },
    };
  }),
);

/* ----------------------------------------------------------- autosave boot --- */

export function bootPersistence(): { warnings: string[]; recovered: boolean } {
  const storage = resolveStorage(null);
  const { result, warnings } = recover(storage);
  if (result?.project) {
    const st = useStore.getState();
    useStore.setState({
      project: result.project,
      projectRevision: st.projectRevision + 1,
      terrainRevision: st.terrainRevision + 1,
      recoveryWarnings: [...warnings, ...result.issues],
      lastSavedAt: result.savedAt,
    });
  }
  return { warnings, recovered: Boolean(result?.project) };
}

export function startAutosave(): () => void {
  const storage = resolveStorage(null);
  const controller = new SaveController({}, storage, 800, 5000);
  controller.startAutosave(() => useStore.getState().project);
  return () => controller.dispose();
}

export type { Vec3T };
