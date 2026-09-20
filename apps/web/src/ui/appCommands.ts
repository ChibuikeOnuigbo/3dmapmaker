/**
 * apps/web — the application command registry.
 *
 * One list drives the command palette, the keyboard bindings and the QA
 * harness, so a command can never appear in the palette without a real
 * implementation behind it (ACCEPTANCE (a), REQUIREMENT 132).
 */
import { ActionCommands } from '@3dmm/input';
import { getEngine } from '../engine/engineRef';
import { downloadProjectFile } from '../state/io';
import { useStore } from '../state/store';

export interface AppCommand {
  id: string;
  label: string;
  group: 'File' | 'View' | 'Tool' | 'Camera' | 'Edit' | 'World' | 'Help';
  /** Human-readable chord, purely for display. */
  shortcut?: string;
  run: () => void;
  /** Commands that only make sense in some contexts. */
  enabled?: () => boolean;
}

const st = () => useStore.getState();

const downloadProject = downloadProjectFile;

export const APP_COMMANDS: AppCommand[] = [
  /* ---------------------------------------------------------------- file --- */
  { id: ActionCommands.fileNew, label: 'New world', group: 'File', run: () => st().newWorld() },
  { id: ActionCommands.fileSave, label: 'Save now', group: 'File', shortcut: 'Ctrl/Cmd S', run: () => st().saveNow() },
  { id: ActionCommands.fileExport, label: 'Export project as JSON', group: 'File', shortcut: 'Ctrl/Cmd Shift S', run: downloadProject },
  { id: ActionCommands.fileImport, label: 'Import project from JSON', group: 'File', shortcut: 'Ctrl/Cmd O', run: () => st().setUi({ modal: 'import' }) },
  { id: ActionCommands.demoOpen, label: 'Open a demo world…', group: 'File', run: () => st().setUi({ modal: 'demos' }) },

  /* ---------------------------------------------------------------- tool --- */
  { id: ActionCommands.toolSelect, label: 'Tool: Select', group: 'Tool', shortcut: 'V', run: () => st().setUi({ tool: 'select' }) },
  { id: ActionCommands.toolMove, label: 'Tool: Move', group: 'Tool', shortcut: 'G', run: () => st().setUi({ tool: 'move' }) },
  { id: ActionCommands.toolRotate, label: 'Tool: Rotate', group: 'Tool', shortcut: 'R', run: () => st().setUi({ tool: 'rotate' }) },
  { id: ActionCommands.toolScale, label: 'Tool: Scale', group: 'Tool', shortcut: 'K', run: () => st().setUi({ tool: 'scale' }) },
  { id: ActionCommands.toolSculpt, label: 'Tool: Sculpt terrain', group: 'Tool', shortcut: 'T', run: () => st().setUi({ tool: 'sculpt' }) },
  { id: ActionCommands.toolMeasure, label: 'Tool: Measure', group: 'Tool', shortcut: 'M', run: () => st().setUi({ tool: 'measure' }) },
  { id: ActionCommands.toolPath, label: 'Tool: Draw road / path', group: 'Tool', shortcut: 'P', run: () => st().setUi({ tool: 'path' }) },
  { id: ActionCommands.toolPolygon, label: 'Tool: Draw polygon', group: 'Tool', shortcut: 'O', run: () => st().setUi({ tool: 'polygon' }) },
  { id: ActionCommands.toolPanorama, label: 'Tool: Panorama', group: 'Tool', shortcut: 'L', run: () => st().setUi({ tool: 'panorama' }) },
  { id: ActionCommands.toolWater, label: 'Tool: Water', group: 'Tool', shortcut: 'U', run: () => st().setUi({ tool: 'water' }) },
  { id: ActionCommands.toolVegetation, label: 'Tool: Vegetation', group: 'Tool', shortcut: 'B', run: () => st().setUi({ tool: 'vegetation' }) },

  /* -------------------------------------------------------------- camera --- */
  { id: ActionCommands.modeOrbit, label: 'Camera: Orbit', group: 'Camera', shortcut: '1', run: () => st().setCameraMode('orbit') },
  { id: ActionCommands.modeFly, label: 'Camera: Fly', group: 'Camera', shortcut: '2', run: () => st().setCameraMode('fly') },
  { id: ActionCommands.modeWalk, label: 'Camera: Walk (ground following)', group: 'Camera', shortcut: '3', run: () => st().setCameraMode('walk') },
  { id: ActionCommands.modePanorama, label: 'Camera: Panorama', group: 'Camera', shortcut: '4', run: () => st().setCameraMode('panorama') },
  { id: ActionCommands.cameraResetNorth, label: 'Face north', group: 'Camera', shortcut: 'N', run: () => getEngine()?.setHeading(0) },
  { id: ActionCommands.cameraResetPitch, label: 'Reset pitch', group: 'Camera', run: () => getEngine()?.setPitch(-30) },
  { id: ActionCommands.cameraZoomIn, label: 'Zoom in', group: 'Camera', shortcut: '+', run: () => getEngine()?.zoomBy(0.7) },
  { id: ActionCommands.cameraZoomOut, label: 'Zoom out', group: 'Camera', shortcut: '−', run: () => getEngine()?.zoomBy(1 / 0.7) },
  { id: ActionCommands.cameraToggleFullscreen, label: 'Toggle fullscreen', group: 'Camera', shortcut: 'F', run: () => getEngine()?.toggleFullscreen() },
  { id: ActionCommands.frameSelection, label: 'Frame selection', group: 'Camera', shortcut: 'Home', run: () => getEngine()?.frameSelection() },
  {
    id: 'camera.requestPointerLock',
    label: 'Lock the pointer for first-person look',
    group: 'Camera',
    run: () => {
      const ok = getEngine()?.requestPointerLock();
      if (!ok) st().notify('warn', 'Pointer lock was refused. Click directly on the map first, or the browser has blocked it.');
    },
  },
  { id: ActionCommands.panoramaNext, label: 'Panorama: step forward', group: 'Camera', shortcut: 'PageDown', run: () => getEngine()?.stepPanorama(1) },
  { id: ActionCommands.panoramaPrev, label: 'Panorama: step back', group: 'Camera', shortcut: 'PageUp', run: () => getEngine()?.stepPanorama(-1) },

  /* ---------------------------------------------------------------- edit --- */
  { id: ActionCommands.editUndo, label: 'Undo', group: 'Edit', shortcut: 'Ctrl/Cmd Z', run: () => st().undo() },
  { id: ActionCommands.editRedo, label: 'Redo', group: 'Edit', shortcut: 'Ctrl/Cmd Shift Z', run: () => st().redo() },
  { id: ActionCommands.editDelete, label: 'Delete selection', group: 'Edit', shortcut: 'Delete', run: () => st().deleteSelection(), enabled: () => st().ui.selectedIds.length > 0 },
  { id: ActionCommands.editDuplicate, label: 'Duplicate selection', group: 'Edit', shortcut: 'Ctrl/Cmd D', run: () => st().duplicateSelection(), enabled: () => st().ui.selectedIds.length > 0 },
  {
    id: 'edit.selectAll',
    label: 'Select every visible object',
    group: 'Edit',
    run: () => {
      const ids: string[] = [];
      // Iterative walk: a cyclic layer tree must not be able to blow the stack.
      const stack = [...st().project.layers];
      while (stack.length > 0) {
        const n = stack.pop()!;
        if (n.kind !== 'group' && n.visible) ids.push(n.id);
        for (const c of n.children) stack.push(c);
      }
      st().select(ids);
    },
  },
  { id: 'edit.clearSelection', label: 'Clear selection', group: 'Edit', shortcut: 'Esc', run: () => st().select([]) },

  /* --------------------------------------------------------------- world --- */
  { id: ActionCommands.gridToggle, label: 'Toggle grid', group: 'World', shortcut: 'H', run: () => st().setGrid({ enabled: !st().project.grid.enabled }) },
  {
    id: ActionCommands.contoursToggle,
    label: 'Toggle terrain contours',
    group: 'World',
    shortcut: 'J',
    run: () => {
      const t = st().project.terrain.contours;
      st().setTerrain({ contours: { ...t, enabled: !t.enabled } });
      useStore.setState((s) => ({ terrainRevision: s.terrainRevision + 1 }));
    },
  },
  {
    id: 'world.verticalExaggeration',
    label: 'Set vertical exaggeration to 1× (true scale)',
    group: 'World',
    run: () => {
      st().setTerrain({ verticalExaggeration: 1 });
      useStore.setState((s) => ({ terrainRevision: s.terrainRevision + 1 }));
    },
  },
  {
    id: 'world.recenterOrigin',
    label: 'Recentre the floating origin on the camera',
    group: 'World',
    run: () => {
      getEngine()?.forceTerrainUpdate();
      st().notify('info', 'The floating origin rebases automatically past 5 km from the anchor.');
    },
  },
  {
    id: 'world.addBookmark',
    label: 'Bookmark this camera position',
    group: 'World',
    run: () => st().addBookmark(`View ${st().project.bookmarks.length + 1}`),
  },

  /* ---------------------------------------------------------------- view --- */
  { id: ActionCommands.statsToggle, label: 'Toggle performance overlay', group: 'View', shortcut: 'Tab', run: () => st().setUi({ statsOpen: !st().ui.statsOpen }) },
  { id: 'view.leftPanel', label: 'Toggle left panel', group: 'View', run: () => st().setUi({ leftPanelOpen: !st().ui.leftPanelOpen }) },
  { id: 'view.rightPanel', label: 'Toggle right panel', group: 'View', run: () => st().setUi({ rightPanelOpen: !st().ui.rightPanelOpen }) },
  { id: ActionCommands.playToggle, label: 'Toggle play mode', group: 'View', run: () => st().setUi({ mode: st().ui.mode === 'play' ? 'edit' : 'play' }) },
  {
    id: 'view.presentation',
    label: 'Enter presentation mode',
    group: 'View',
    run: () => st().setUi({ mode: st().ui.mode === 'presentation' ? 'edit' : 'presentation' }),
  },
  {
    id: 'view.quality',
    label: 'Cycle render quality (low → normal → high)',
    group: 'View',
    run: () => {
      const order = ['low', 'normal', 'high'] as const;
      const next = order[(order.indexOf(st().project.performance.quality) + 1) % order.length];
      st().setPerformance({ quality: next });
      st().notify('info', `Render quality set to ${next}.`);
    },
  },

  /* ---------------------------------------------------------------- help --- */
  { id: ActionCommands.shortcutsOpen, label: 'Keyboard shortcuts', group: 'Help', shortcut: '?', run: () => st().setUi({ modal: 'shortcuts' }) },
  { id: 'help.tutorial', label: 'Start the guided tutorial', group: 'Help', run: () => st().setUi({ tutorialPhase: 'running', tutorialStep: 0 }) },
  { id: 'help.staticTutorial', label: 'Open the written tutorial', group: 'Help', run: () => { window.location.hash = '#/tutorial'; } },
  { id: 'help.qa', label: 'Open the QA harness', group: 'Help', run: () => { window.location.hash = '#/qa'; } },
  { id: 'help.landing', label: 'Back to the landing page', group: 'Help', run: () => { window.location.hash = '#/'; } },
];

export const COMMAND_BY_ID = new Map(APP_COMMANDS.map((c) => [c.id, c]));

/** Subsequence-free fuzzy match: fast, predictable, and good enough here. */
export function scoreCommand(query: string, label: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 100;
  const at = l.indexOf(q);
  if (at >= 0) return 80 - Math.min(at, 40);
  // initials, e.g. "tp" matches "Tool: Panorama"
  let qi = 0;
  let hits = 0;
  for (const ch of l) {
    if (qi < q.length && ch === q[qi]) {
      qi++;
      hits++;
    }
  }
  return qi === q.length ? 40 + hits : 0;
}
