/**
 * packages/input — wheel routing (REQUIREMENT 028).
 *
 * Rules, in order:
 *   1. wheel over the map viewport, viewport owns input   -> dolly/zoom the map
 *   2. wheel over a scrollable panel or dialog            -> scroll that surface
 *   3. anything else                                      -> leave the event alone
 *
 * The old repository gated wheel on `document.activeElement === canvas`, so the
 * wheel silently stopped working whenever the canvas lost focus. Here routing
 * is decided by *where the pointer is* plus focus state, which is what a real
 * map product does.
 */
import { AxisCommands, type CommandBus } from './commands';
import type { FocusManager } from './focus';
import { isInsideScrollContainer } from './focus';

export interface WheelRouterOptions {
  bus: CommandBus;
  focus: FocusManager;
  target: Element;
  /** Sensitivity multiplier applied to deltaY. */
  sensitivity?: number;
  /** True when the wheel should dolly instead of changing FOV. */
  mode?: 'dolly' | 'fov';
}

export interface WheelDecision {
  action: 'map-zoom' | 'panel-scroll' | 'ignored';
  reason: string;
  prevented: boolean;
}

export class WheelRouter {
  private bus: CommandBus;
  private focus: FocusManager;
  private target: Element;
  private sensitivity: number;
  private mode: 'dolly' | 'fov';
  private lastDecision: WheelDecision = { action: 'ignored', reason: 'none', prevented: false };
  private readonly handler: (e: Event) => void;
  private zoomEvents = 0;

  constructor(opts: WheelRouterOptions) {
    this.bus = opts.bus;
    this.focus = opts.focus;
    this.target = opts.target;
    this.sensitivity = opts.sensitivity ?? 1;
    this.mode = opts.mode ?? 'dolly';
    // non-passive so we can preventDefault ONLY when we actually consume it
    this.handler = (e) => this.onWheel(e as WheelEvent);
    this.target.addEventListener('wheel', this.handler, { passive: false });
  }

  get stats() {
    return { zoomEvents: this.zoomEvents, lastDecision: this.lastDecision };
  }

  setMode(mode: 'dolly' | 'fov'): void {
    this.mode = mode;
  }

  /** Pure routing decision, exported for tests (HARDENING CHECK 001). */
  decide(e: WheelEvent): WheelDecision {
    const target = e.target as Element | null;
    const overViewport = this.target.contains(target);
    const snap = this.focus.snapshot();

    if (!overViewport) {
      // Over a panel/dialog: let the browser scroll it.
      return { action: 'panel-scroll', reason: 'pointer is not over the viewport', prevented: false };
    }
    if (snap.isTyping) {
      return { action: 'panel-scroll', reason: 'a text field owns input', prevented: false };
    }
    if (snap.blockedByOverlay) {
      // A dialog may be visually on top of the map; scroll the dialog instead.
      return { action: 'panel-scroll', reason: 'a blocking overlay is open', prevented: false };
    }
    if (!snap.viewportOwnsInput) {
      return { action: 'ignored', reason: 'viewport does not own input', prevented: false };
    }
    if (isInsideScrollContainer(target, this.target)) {
      return { action: 'panel-scroll', reason: 'wheel target is inside a scroll region', prevented: false };
    }
    return { action: 'map-zoom', reason: 'viewport owns input', prevented: true };
  }

  private onWheel(e: WheelEvent): void {
    const decision = this.decide(e);
    this.lastDecision = decision;
    if (decision.action !== 'map-zoom') return;

    e.preventDefault();
    e.stopPropagation();
    // Normalise trackpad vs wheel deltas into a stable -1..1 step.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const raw = e.deltaY * unit;
    const step = Math.max(-1, Math.min(1, raw / 120)) * this.sensitivity;

    this.zoomEvents++;
    this.bus.dispatch({
      id: AxisCommands.zoom,
      value: step,
      phase: 'change',
      source: 'pointer',
      focus: this.focus.snapshot(),
      original: e,
    });
    void this.mode;
  }

  dispose(): void {
    this.target.removeEventListener('wheel', this.handler);
  }
}
