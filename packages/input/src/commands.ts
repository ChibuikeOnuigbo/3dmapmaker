/**
 * packages/input — one command abstraction for every input device
 * (REQUIREMENT 024, 026, 027, 028, 132, 133).
 *
 * Mouse, keyboard, touch and the visible on-screen controls all resolve to the
 * same *command id*. A command is either:
 *
 *   - an **axis** command  (`move.forward`, `turn.yaw`) with a signed value, or
 *   - an **action** command (`tool.select`, `camera.resetNorth`) fired once.
 *
 * Nothing in the engine ever listens to a raw `keydown`. That is the structural
 * reason WASD, arrows and the joystick buttons cannot drift apart again.
 */
import type { FocusSnapshot } from './focus';

export const AxisCommands = {
  moveForward: 'move.forward',
  moveRight: 'move.right',
  moveUp: 'move.up',
  turnYaw: 'turn.yaw',
  turnPitch: 'turn.pitch',
  zoom: 'zoom.delta',
} as const;

export const ActionCommands = {
  boost: 'move.boost',
  slow: 'move.slow',
  jump: 'move.jump',
  crouch: 'move.crouch',
  cameraResetNorth: 'camera.resetNorth',
  cameraResetPitch: 'camera.resetPitch',
  cameraZoomIn: 'camera.zoomIn',
  cameraZoomOut: 'camera.zoomOut',
  cameraToggleFullscreen: 'camera.toggleFullscreen',
  modeOrbit: 'mode.orbit',
  modeFly: 'mode.fly',
  modeWalk: 'mode.walk',
  modePanorama: 'mode.panorama',
  toolSelect: 'tool.select',
  toolMove: 'tool.move',
  toolRotate: 'tool.rotate',
  toolScale: 'tool.scale',
  toolSculpt: 'tool.sculpt',
  toolMeasure: 'tool.measure',
  toolPath: 'tool.path',
  toolPolygon: 'tool.polygon',
  editUndo: 'edit.undo',
  editRedo: 'edit.redo',
  editDelete: 'edit.delete',
  editDuplicate: 'edit.duplicate',
  paletteOpen: 'ui.commandPalette',
  playToggle: 'ui.playToggle',
  panoramaNext: 'panorama.next',
  panoramaPrev: 'panorama.prev',
  toolPanorama: 'tool.panorama',
  toolWater: 'tool.water',
  toolVegetation: 'tool.vegetation',
  /** Finish the drafted measurement / road / polygon. */
  draftConfirm: 'draft.confirm',
  /** Discard the current draft without saving it. */
  draftCancel: 'draft.cancel',
  /** Remove the last vertex of the current draft. */
  draftUndoPoint: 'draft.undoPoint',
  /** Fly the camera to frame the current selection. */
  frameSelection: 'camera.frameSelection',
  fileNew: 'file.new',
  fileSave: 'file.save',
  fileExport: 'file.export',
  fileImport: 'file.import',
  demoOpen: 'file.demos',
  shortcutsOpen: 'ui.shortcuts',
  statsToggle: 'ui.statsToggle',
  gridToggle: 'view.gridToggle',
  contoursToggle: 'view.contoursToggle',
} as const;

export type AxisCommandId = (typeof AxisCommands)[keyof typeof AxisCommands];
export type ActionCommandId = (typeof ActionCommands)[keyof typeof ActionCommands];
export type CommandId = AxisCommandId | ActionCommandId | string;

/** Which surfaces a command may fire from. Movement defaults to viewport-only. */
export type CommandScope = 'viewport' | 'global';

export interface CommandDef {
  id: CommandId;
  kind: 'axis' | 'action';
  scope: CommandScope;
  label: string;
  /** Whether holding produces a continuous value (axis) or repeats (action). */
  repeatable?: boolean;
}

export interface CommandEvent {
  id: CommandId;
  /** -1..1 for axis commands, 1 for actions. */
  value: number;
  /** 'down' | 'up' | 'change' | 'tap' */
  phase: 'down' | 'up' | 'change' | 'tap';
  source: 'keyboard' | 'pointer' | 'touch' | 'ui' | 'api';
  focus: FocusSnapshot;
  /** Original DOM event when there is one. */
  original?: Event;
}

export type CommandHandler = (e: CommandEvent) => void;

/** Why a dispatch did or did not reach its handlers. */
export type DispatchOutcome = 'dispatched' | 'rejected-focus' | 'rejected-no-handler';

/**
 * A wildcard observer. It sees EVERY command, including the ones the bus
 * rejected, so a telemetry or QA listener can tell "nothing was pressed" apart
 * from "it was pressed and the bus dropped it". A plain CommandHandler passed
 * to `on('*')` simply ignores the second argument.
 */
export type CommandObserver = (e: CommandEvent, outcome: DispatchOutcome) => void;

/** The subscription key that means "every command". */
export const WILDCARD: CommandId = '*';

export interface CommandBusStats {
  dispatched: number;
  rejectedByFocus: number;
  rejectedNoHandler: number;
  byCommand: Record<string, number>;
}

export class CommandBus {
  private defs = new Map<string, CommandDef>();
  private handlers = new Map<string, Set<CommandHandler>>();
  private observers = new Set<CommandObserver>();
  private stats: CommandBusStats = { dispatched: 0, rejectedByFocus: 0, rejectedNoHandler: 0, byCommand: {} };

  register(def: CommandDef): void {
    this.defs.set(def.id, def);
  }

  registerAll(defs: CommandDef[]): void {
    for (const d of defs) this.register(d);
  }

  getDef(id: CommandId): CommandDef | undefined {
    return this.defs.get(id);
  }

  all(): CommandDef[] {
    return [...this.defs.values()];
  }

  /**
   * Subscribe to one command, or to `'*'` for every command.
   *
   * Previously `on('*')` stored the handler under the literal key `'*'` while
   * `dispatch` only looked up the exact command id, so a wildcard subscription
   * was accepted and then never called. It is now a real observer.
   */
  on(id: CommandId, handler: CommandHandler | CommandObserver): () => void {
    if (id === WILDCARD) {
      const obs = handler as CommandObserver;
      this.observers.add(obs);
      return () => this.observers.delete(obs);
    }
    let set = this.handlers.get(id);
    if (!set) {
      set = new Set();
      this.handlers.set(id, set);
    }
    set.add(handler as CommandHandler);
    return () => set!.delete(handler as CommandHandler);
  }

  /**
   * Dispatch a command. Returns true when at least one handler ran.
   *
   * Focus gating happens HERE, not in the caller: a `viewport`-scoped command
   * is dropped when the snapshot says the viewport does not own input. This is
   * the single choke point that makes HARDENING CHECK 001 measurable.
   */
  dispatch(e: CommandEvent): boolean {
    const def = this.defs.get(e.id);
    const scope: CommandScope = def?.scope ?? 'viewport';
    // A malformed event must be rejected, not thrown over. `e.focus` is read
    // here on every dispatch, and an api/ui caller that forgets it would
    // otherwise get a TypeError from inside the bus.
    const ownsInput = Boolean(e.focus?.viewportOwnsInput);
    if (scope === 'viewport' && !ownsInput) {
      this.stats.rejectedByFocus++;
      this.observe(e, 'rejected-focus');
      return false;
    }
    const set = this.handlers.get(e.id);
    if (!set || set.size === 0) {
      this.stats.rejectedNoHandler++;
      this.observe(e, 'rejected-no-handler');
      return false;
    }
    this.stats.dispatched++;
    this.stats.byCommand[e.id] = (this.stats.byCommand[e.id] ?? 0) + 1;
    for (const h of set) h(e);
    this.observe(e, 'dispatched');
    return true;
  }

  private observe(e: CommandEvent, outcome: DispatchOutcome): void {
    if (this.observers.size === 0) return;
    for (const obs of this.observers) obs(e, outcome);
  }

  getStats(): CommandBusStats {
    return { ...this.stats, byCommand: { ...this.stats.byCommand } };
  }

  resetStats(): void {
    this.stats = { dispatched: 0, rejectedByFocus: 0, rejectedNoHandler: 0, byCommand: {} };
  }
}

/** The default command catalogue used by the workbench. */
export function defaultCommands(): CommandDef[] {
  const axis = (id: CommandId, label: string): CommandDef => ({ id, kind: 'axis', scope: 'viewport', label });
  const view = (id: CommandId, label: string): CommandDef => ({ id, kind: 'action', scope: 'viewport', label });
  const global = (id: CommandId, label: string): CommandDef => ({ id, kind: 'action', scope: 'global', label });
  return [
    axis(AxisCommands.moveForward, 'Move forward / back'),
    axis(AxisCommands.moveRight, 'Strafe left / right'),
    axis(AxisCommands.moveUp, 'Ascend / descend'),
    axis(AxisCommands.turnYaw, 'Turn'),
    axis(AxisCommands.turnPitch, 'Look up / down'),
    axis(AxisCommands.zoom, 'Zoom'),
    view(ActionCommands.boost, 'Boost'),
    view(ActionCommands.slow, 'Slow'),
    view(ActionCommands.jump, 'Jump'),
    view(ActionCommands.crouch, 'Crouch'),
    view(ActionCommands.cameraZoomIn, 'Zoom in'),
    view(ActionCommands.cameraZoomOut, 'Zoom out'),
    view(ActionCommands.cameraResetNorth, 'Reset to north'),
    view(ActionCommands.cameraResetPitch, 'Reset pitch'),
    view(ActionCommands.cameraToggleFullscreen, 'Toggle fullscreen'),
    view(ActionCommands.modeOrbit, 'Orbit mode'),
    view(ActionCommands.modeFly, 'Fly mode'),
    view(ActionCommands.modeWalk, 'Walk mode'),
    view(ActionCommands.modePanorama, 'Panorama mode'),
    view(ActionCommands.toolSelect, 'Select tool'),
    view(ActionCommands.toolMove, 'Move tool'),
    view(ActionCommands.toolRotate, 'Rotate tool'),
    view(ActionCommands.toolScale, 'Scale tool'),
    view(ActionCommands.toolSculpt, 'Sculpt tool'),
    view(ActionCommands.toolMeasure, 'Measure tool'),
    view(ActionCommands.toolPath, 'Path tool'),
    view(ActionCommands.toolPolygon, 'Polygon tool'),
    view(ActionCommands.panoramaNext, 'Next panorama'),
    view(ActionCommands.panoramaPrev, 'Previous panorama'),
    global(ActionCommands.editUndo, 'Undo'),
    global(ActionCommands.editRedo, 'Redo'),
    global(ActionCommands.editDelete, 'Delete selection'),
    global(ActionCommands.editDuplicate, 'Duplicate selection'),
    global(ActionCommands.paletteOpen, 'Command palette'),
    global(ActionCommands.playToggle, 'Toggle play mode'),
    view(ActionCommands.toolPanorama, 'Panorama tool'),
    view(ActionCommands.toolWater, 'Water tool'),
    view(ActionCommands.toolVegetation, 'Vegetation tool'),
    view(ActionCommands.draftConfirm, 'Finish drawing'),
    view(ActionCommands.draftCancel, 'Cancel drawing'),
    view(ActionCommands.draftUndoPoint, 'Remove last point'),
    view(ActionCommands.frameSelection, 'Frame selection'),
    global(ActionCommands.fileNew, 'New world'),
    global(ActionCommands.fileSave, 'Save'),
    global(ActionCommands.fileExport, 'Export project'),
    global(ActionCommands.fileImport, 'Import project'),
    global(ActionCommands.demoOpen, 'Open a demo world'),
    global(ActionCommands.shortcutsOpen, 'Keyboard shortcuts'),
    global(ActionCommands.statsToggle, 'Toggle performance overlay'),
    global(ActionCommands.gridToggle, 'Toggle grid'),
    global(ActionCommands.contoursToggle, 'Toggle contours'),
  ];
}
