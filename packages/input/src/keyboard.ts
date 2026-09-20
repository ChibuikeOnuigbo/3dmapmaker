/**
 * packages/input — keyboard bindings (REQUIREMENT 026, 027, 133).
 *
 * Bound at `window` level (so the app never depends on canvas focus surviving a
 * re-render) but *gated* by the FocusManager at dispatch time. Movement keys are
 * NEVER bound globally: they are `viewport`-scoped commands and the bus drops
 * them when a dialog, popover or text field owns input.
 *
 * Arrow keys and WASD map to the SAME command ids, which is what makes the
 * on-screen movement buttons, the joystick and the keyboard interchangeable
 * (REQUIREMENT 027).
 */
import { AxisCommands, ActionCommands, type CommandBus, type CommandEvent } from './commands';
import type { FocusManager, FocusSnapshot } from './focus';

export interface ChordSpec {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface Binding {
  chord: ChordSpec;
  command: string;
  /** For axis bindings: the value produced while held. */
  value?: number;
  /** Axis bindings also emit an 'up' event with value 0 on keyup. */
  axis?: boolean;
}

export function chordToString(c: ChordSpec): string {
  return [c.ctrl ? 'Ctrl' : '', c.meta ? 'Meta' : '', c.alt ? 'Alt' : '', c.shift ? 'Shift' : '', c.key].filter(Boolean).join('+');
}

/**
 * Canonical form of a key name.
 *
 * A single character is lowercased so `W` and `w` are the same chord. A named
 * key (`ArrowUp`, `PageDown`, `Enter`, `Tab`) is lowercased too, because
 * `defaultBindings()` spells them in lower case while `KeyboardEvent.key`
 * delivers them in camel case. Without this both sides disagree and every
 * named-key binding is silently dead — which is exactly why the arrow keys
 * stopped resolving to the movement axes while WASD kept working.
 */
function canonicalKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

function eventChord(e: KeyboardEvent): ChordSpec {
  return {
    key: canonicalKey(e.key),
    ctrl: e.ctrlKey,
    meta: e.metaKey,
    alt: e.altKey,
    shift: e.shiftKey,
  };
}

function chordKey(c: ChordSpec): string {
  // Canonicalise on the binding side as well, so a binding written as
  // 'ArrowUp' and one written as 'arrowup' land on the same key instead of
  // colliding silently.
  return `${c.ctrl ? 'C' : ''}${c.meta ? 'M' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}|${canonicalKey(c.key)}`;
}

/** Default map. Deliberately editable at runtime (REQUIREMENT 133). */
export function defaultBindings(): Binding[] {
  const ax = (key: string, command: string, value: number): Binding => ({ chord: { key }, command, value, axis: true });
  return [
    // WASD + arrows resolve to the same axes (REQUIREMENT 026/027)
    ax('w', AxisCommands.moveForward, 1),
    ax('s', AxisCommands.moveForward, -1),
    ax('arrowup', AxisCommands.moveForward, 1),
    ax('arrowdown', AxisCommands.moveForward, -1),
    ax('a', AxisCommands.moveRight, -1),
    ax('d', AxisCommands.moveRight, 1),
    ax('arrowleft', AxisCommands.moveRight, -1),
    ax('arrowright', AxisCommands.moveRight, 1),
    ax('q', AxisCommands.moveUp, -1),
    ax('e', AxisCommands.moveUp, 1),
    // Arrows with shift steer the camera instead of translating the rig.
    { chord: { key: 'ArrowUp', shift: true }, command: AxisCommands.turnPitch, value: 1, axis: true },
    { chord: { key: 'ArrowDown', shift: true }, command: AxisCommands.turnPitch, value: -1, axis: true },
    { chord: { key: 'ArrowLeft', shift: true }, command: AxisCommands.turnYaw, value: -1, axis: true },
    { chord: { key: 'ArrowRight', shift: true }, command: AxisCommands.turnYaw, value: 1, axis: true },
    // modifiers
    { chord: { key: 'Shift' }, command: ActionCommands.boost, axis: false },
    { chord: { key: 'Control' }, command: ActionCommands.slow, axis: false },
    { chord: { key: ' ' }, command: ActionCommands.jump, axis: false },
    { chord: { key: 'c' }, command: ActionCommands.crouch, axis: false },
    // camera
    { chord: { key: '=' }, command: ActionCommands.cameraZoomIn },
    { chord: { key: '+' }, command: ActionCommands.cameraZoomIn },
    { chord: { key: '-' }, command: ActionCommands.cameraZoomOut },
    { chord: { key: 'n' }, command: ActionCommands.cameraResetNorth },
    { chord: { key: 'f' }, command: ActionCommands.cameraToggleFullscreen },
    // modes
    { chord: { key: '1' }, command: ActionCommands.modeOrbit },
    { chord: { key: '2' }, command: ActionCommands.modeFly },
    { chord: { key: '3' }, command: ActionCommands.modeWalk },
    { chord: { key: '4' }, command: ActionCommands.modePanorama },
    // Tools — deliberately avoid WASDQE and every key already bound to movement
    // (REQUIREMENT 133: WASD is never bound globally, and never stolen from
    // a text field either; KeyboardLayer only dispatches while the viewport
    // owns focus).
    { chord: { key: 'v' }, command: ActionCommands.toolSelect },
    { chord: { key: 'g' }, command: ActionCommands.toolMove },
    { chord: { key: 'r' }, command: ActionCommands.toolRotate },
    { chord: { key: 'k' }, command: ActionCommands.toolScale },
    { chord: { key: 't' }, command: ActionCommands.toolSculpt },
    { chord: { key: 'm' }, command: ActionCommands.toolMeasure },
    { chord: { key: 'p' }, command: ActionCommands.toolPath },
    { chord: { key: 'o' }, command: ActionCommands.toolPolygon },
    { chord: { key: 'l' }, command: ActionCommands.toolPanorama },
    { chord: { key: 'u' }, command: ActionCommands.toolWater },
    { chord: { key: 'b' }, command: ActionCommands.toolVegetation },
    // drawing drafts
    { chord: { key: 'Enter' }, command: ActionCommands.draftConfirm },
    { chord: { key: 'Escape' }, command: ActionCommands.draftCancel },
    { chord: { key: 'Backspace' }, command: ActionCommands.draftUndoPoint },
    { chord: { key: 'Home' }, command: ActionCommands.frameSelection },
    // edit (global scope — these are safe while a panel has focus)
    { chord: { key: 'z', ctrl: true }, command: ActionCommands.editUndo },
    { chord: { key: 'z', meta: true }, command: ActionCommands.editUndo },
    { chord: { key: 'z', ctrl: true, shift: true }, command: ActionCommands.editRedo },
    { chord: { key: 'z', meta: true, shift: true }, command: ActionCommands.editRedo },
    { chord: { key: 'Delete' }, command: ActionCommands.editDelete },
    { chord: { key: 'd', ctrl: true }, command: ActionCommands.editDuplicate },
    { chord: { key: 'd', meta: true }, command: ActionCommands.editDuplicate },
    // files
    { chord: { key: 's', ctrl: true }, command: ActionCommands.fileSave },
    { chord: { key: 's', meta: true }, command: ActionCommands.fileSave },
    { chord: { key: 's', ctrl: true, shift: true }, command: ActionCommands.fileExport },
    { chord: { key: 's', meta: true, shift: true }, command: ActionCommands.fileExport },
    { chord: { key: 'o', ctrl: true }, command: ActionCommands.fileImport },
    { chord: { key: 'o', meta: true }, command: ActionCommands.fileImport },
    { chord: { key: '?' }, command: ActionCommands.shortcutsOpen },
    { chord: { key: 'Tab' }, command: ActionCommands.statsToggle },
    { chord: { key: 'h' }, command: ActionCommands.gridToggle },
    { chord: { key: 'j' }, command: ActionCommands.contoursToggle },
    // palette: Ctrl/Cmd+Shift+P (REQUIREMENT 132)
    { chord: { key: 'p', ctrl: true, shift: true }, command: ActionCommands.paletteOpen },
    { chord: { key: 'p', meta: true, shift: true }, command: ActionCommands.paletteOpen },
    // panorama stepping
    { chord: { key: 'PageDown' }, command: ActionCommands.panoramaNext },
    { chord: { key: 'PageUp' }, command: ActionCommands.panoramaPrev },
  ];
}

export interface KeyboardLayerOptions {
  bus: CommandBus;
  focus: FocusManager;
  bindings?: Binding[];
  target?: EventTarget;
}

export class KeyboardLayer {
  private bus: CommandBus;
  private focus: FocusManager;
  private bindings = new Map<string, Binding[]>();
  private held = new Map<string, { command: string; value: number }>();
  private target: EventTarget;
  private readonly onKeyDownBound: (e: Event) => void;
  private readonly onKeyUpBound: (e: Event) => void;
  private readonly onBlurBound: () => void;
  /** Keys we preventDefault'ed, so we can be precise about what we steal. */
  private suppressedKeys = new Set<string>();

  constructor(opts: KeyboardLayerOptions) {
    this.bus = opts.bus;
    this.focus = opts.focus;
    this.setBindings(opts.bindings ?? defaultBindings());
    this.target = opts.target ?? (typeof window !== 'undefined' ? window : new EventTarget());
    this.onKeyDownBound = (e) => this.onKeyDown(e as KeyboardEvent);
    this.onKeyUpBound = (e) => this.onKeyUp(e as KeyboardEvent);
    this.onBlurBound = () => this.releaseAll();
    this.target.addEventListener('keydown', this.onKeyDownBound);
    this.target.addEventListener('keyup', this.onKeyUpBound);
    this.target.addEventListener('blur', this.onBlurBound);
    if (typeof window !== 'undefined') window.addEventListener('blur', this.onBlurBound);
  }

  setBindings(bindings: Binding[]): void {
    this.bindings.clear();
    for (const b of bindings) {
      const k = chordKey(b.chord);
      const arr = this.bindings.get(k) ?? [];
      arr.push(b);
      this.bindings.set(k, arr);
    }
  }

  getBindings(): Binding[] {
    return [...this.bindings.values()].flat();
  }

  /** Keys currently held, used by the engine's per-frame axis poll. */
  getHeldAxes(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [, h] of this.held) {
      out.set(h.command, (out.get(h.command) ?? 0) + h.value);
    }
    return out;
  }

  wasSuppressed(key: string): boolean {
    return this.suppressedKeys.has(key);
  }

  private emit(binding: Binding, phase: 'down' | 'up' | 'tap', value: number, focus: FocusSnapshot, original?: Event): boolean {
    const e: CommandEvent = {
      id: binding.command,
      value,
      phase,
      source: 'keyboard',
      focus,
      original,
    };
    return this.bus.dispatch(e);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const focus = this.focus.snapshot();
    // Never intercept typing. This is the exact failure mode from `prompt.txt`:
    // "when am typin on a textfield ... and i press wasd it moves".
    if (focus.isTyping) return;

    const chord = eventChord(e);
    const key = chord.key;
    const matches = this.bindings.get(chordKey(chord));

    // Bare modifier keys must not swallow normal typing in panels.
    if (!matches) {
      if (focus.surface !== 'viewport' && !chord.ctrl && !chord.meta) return;
      return;
    }

    // Global commands work anywhere; viewport commands need viewport focus.
    const anyViewportScoped = matches.some((b) => (this.bus.getDef(b.command)?.scope ?? 'viewport') === 'viewport');
    if (anyViewportScoped && !focus.viewportOwnsInput) {
      // Do not preventDefault: the key may belong to the focused surface.
      return;
    }

    for (const b of matches) {
      if (b.axis) {
        const id = `${chordKey(chord)}:${b.command}`;
        if (this.held.has(id)) continue; // ignore OS key repeat
        this.held.set(id, { command: b.command, value: b.value ?? 1 });
        this.emit(b, 'down', b.value ?? 1, focus, e);
      } else if (!e.repeat) {
        this.emit(b, 'tap', 1, focus, e);
      }
    }
    // Only steal the key when we actually acted on it.
    e.preventDefault();
    this.suppressedKeys.add(key);
  }

  private onKeyUp(e: KeyboardEvent): void {
    const focus = this.focus.snapshot();
    const chord = eventChord(e);
    const matches = this.bindings.get(chordKey(chord));
    if (!matches) return;
    for (const b of matches) {
      if (!b.axis) continue;
      const id = `${chordKey(chord)}:${b.command}`;
      const h = this.held.get(id);
      if (!h) continue;
      this.held.delete(id);
      // Release regardless of focus: a stuck axis is worse than a lost event.
      this.emit(b, 'up', 0, focus, e);
    }
  }

  /** Release every held axis (window blur, tab switch, mode change). */
  releaseAll(): void {
    const focus = this.focus.snapshot();
    for (const [id, h] of [...this.held]) {
      this.held.delete(id);
      this.emit({ chord: { key: '' }, command: h.command, value: h.value, axis: true }, 'up', 0, focus);
    }
  }

  dispose(): void {
    this.releaseAll();
    this.target.removeEventListener('keydown', this.onKeyDownBound);
    this.target.removeEventListener('keyup', this.onKeyUpBound);
    this.target.removeEventListener('blur', this.onBlurBound);
    if (typeof window !== 'undefined') window.removeEventListener('blur', this.onBlurBound);
  }
}
