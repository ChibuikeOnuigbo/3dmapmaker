/**
 * packages/input — pointer sessions and drag separation (REQUIREMENT 029, 030).
 *
 * Every drag in the app is a named session with exactly one owner:
 *
 *   'camera-orbit'   viewport left-drag      -> orbit/pan the world
 *   'camera-look'    viewport drag in fly/walk
 *   'sculpt'         viewport drag with the sculpt tool
 *   'gizmo'          gizmo handle drag        -> transform objects
 *   'dock'           panel header drag        -> move a dock
 *   'layer-reorder'  layer row drag           -> reorder layers
 *   'path-edit'      path vertex drag
 *   'marquee'        selection rectangle
 *
 * Because a session is exclusive, dragging a panel header can never rotate the
 * camera — the failure mode reported against the old monolith, where a single
 * document-level `mousemove` handler and one `isDragging` boolean served both.
 *
 * Sessions always release on pointerup, pointercancel, window blur and explicit
 * mode switch, and use `setPointerCapture` so a fast drag off the element still
 * delivers events.
 */
import type { FocusManager } from './focus';

export type DragKind =
  | 'camera-orbit'
  | 'camera-pan'
  | 'camera-look'
  | 'sculpt'
  | 'gizmo'
  | 'dock'
  | 'layer-reorder'
  | 'path-edit'
  | 'marquee'
  | 'panorama-look'
  | 'measure';

export interface PointerPoint {
  x: number;
  y: number;
  /** NDC-ish normalised coordinates relative to the viewport rect. */
  nx: number;
  ny: number;
  /** Movement since the previous move event, in CSS pixels. */
  dx: number;
  dy: number;
  button: number;
  buttons: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  pressure: number;
  time: number;
}

export interface DragSession {
  id: string;
  kind: DragKind;
  pointerId: number;
  target: Element;
  start: PointerPoint;
  current: PointerPoint;
  startedAt: number;
  movedPx: number;
  /** Set false to cancel from a mode switch. */
  active: boolean;
}

export interface DragHandlers {
  onStart?(s: DragSession): void;
  onMove?(s: DragSession): void;
  onEnd?(s: DragSession, cancelled: boolean): void;
}

export interface PointerLayerOptions {
  element: HTMLElement;
  focus: FocusManager;
  /** Minimum px before a click becomes a drag, so taps still select. */
  dragThresholdPx?: number;
  onDrag?(kind: DragKind, s: DragSession): void;
  onDragEnd?(kind: DragKind, s: DragSession, cancelled: boolean): void;
  onTap?(p: PointerPoint, e: PointerEvent): void;
  onHover?(p: PointerPoint, e: PointerEvent): void;
  /** Which drag kind the current tool wants. Re-evaluated on each pointerdown. */
  resolveKind?: (e: PointerEvent, p: PointerPoint) => DragKind | null;
  /** Hover picking is throttled to keep the main thread free (REQ 069). */
  hoverThrottleMs?: number;
}

let sessionCounter = 0;

export class PointerLayer {
  private el: HTMLElement;
  private focus: FocusManager;
  private threshold: number;
  private handlers: DragHandlers;
  private session: DragSession | null = null;
  private hoverThrottleMs: number;
  private lastHover = 0;
  private captureFailed = 0;
  private sessionsStarted = 0;
  private sessionsCancelled = 0;
  private readonly cbs = {
    down: (e: Event) => this.onDown(e as PointerEvent),
    move: (e: Event) => this.onMove(e as PointerEvent),
    up: (e: Event) => this.onUp(e as PointerEvent, false),
    cancel: (e: Event) => this.onUp(e as PointerEvent, true),
    blur: () => this.cancel('window blur'),
    leave: (e: Event) => this.onLeave(e as PointerEvent),
  };
  private readonly resolveKind: PointerLayerOptions['resolveKind'];
  private readonly onTapCb?: PointerLayerOptions['onTap'];
  private readonly onHoverCb?: PointerLayerOptions['onHover'];
  private readonly onDragCb?: PointerLayerOptions['onDrag'];
  private readonly onDragEndCb?: PointerLayerOptions['onDragEnd'];

  constructor(opts: PointerLayerOptions, handlers: DragHandlers = {}) {
    this.el = opts.element;
    this.focus = opts.focus;
    this.threshold = opts.dragThresholdPx ?? 3;
    this.handlers = handlers;
    this.hoverThrottleMs = opts.hoverThrottleMs ?? 40;
    this.resolveKind = opts.resolveKind;
    this.onTapCb = opts.onTap;
    this.onHoverCb = opts.onHover;
    this.onDragCb = opts.onDrag;
    this.onDragEndCb = opts.onDragEnd;

    this.el.addEventListener('pointerdown', this.cbs.down);
    this.el.addEventListener('pointermove', this.cbs.move);
    this.el.addEventListener('pointerup', this.cbs.up);
    this.el.addEventListener('pointercancel', this.cbs.cancel);
    this.el.addEventListener('pointerleave', this.cbs.leave);
    // A blur must never leave a drag stuck on (the old repo leaked `isDragging`).
    if (typeof window !== 'undefined') window.addEventListener('blur', this.cbs.blur);
  }

  get activeSession(): DragSession | null {
    return this.session;
  }

  get stats() {
    return {
      sessionsStarted: this.sessionsStarted,
      sessionsCancelled: this.sessionsCancelled,
      captureFailed: this.captureFailed,
      active: this.session?.kind ?? null,
    };
  }

  private toPoint(e: PointerEvent): PointerPoint {
    const rect = this.el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return {
      x,
      y,
      nx: rect.width > 0 ? (x / rect.width) * 2 - 1 : 0,
      ny: rect.height > 0 ? -((y / rect.height) * 2 - 1) : 0,
      dx: 0,
      dy: 0,
      button: e.button,
      buttons: e.buttons,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      pressure: e.pressure ?? 0,
      time: e.timeStamp,
    };
  }

  private onDown(e: PointerEvent): void {
    // Only the primary button / touch starts a drag; middle+right are reserved.
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2 && e.button !== 1) return;
    if (this.session) return; // one session at a time — drag separation

    const p = this.toPoint(e);
    const kind = this.resolveKind ? this.resolveKind(e, p) : 'camera-orbit';
    if (!kind) return;

    // Claim focus for the viewport so keyboard movement starts working,
    // but never steal it from a text field.
    if (!this.focus.snapshot().isTyping) this.focus.focusViewport('click');
    this.focus.setDragOnViewport(true);

    const session: DragSession = {
      id: `drag_${++sessionCounter}`,
      kind,
      pointerId: e.pointerId,
      target: e.target as Element,
      start: p,
      current: p,
      startedAt: e.timeStamp,
      movedPx: 0,
      active: true,
    };
    this.session = session;
    this.sessionsStarted++;

    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // jsdom / unsupported: drag still works, we just lose capture.
      this.captureFailed++;
    }

    this.handlers.onStart?.(session);
    this.onDragCb?.(kind, session);
    // The viewport must not scroll/pan underneath a drag.
    if (e.cancelable) e.preventDefault();
  }

  private onMove(e: PointerEvent): void {
    const p = this.toPoint(e);
    if (!this.session || this.session.pointerId !== e.pointerId) {
      const now = e.timeStamp;
      if (this.onHoverCb && now - this.lastHover >= this.hoverThrottleMs) {
        this.lastHover = now;
        this.onHoverCb(p, e);
      }
      return;
    }
    const s = this.session;
    p.dx = p.x - s.current.x;
    p.dy = p.y - s.current.y;
    s.movedPx += Math.hypot(p.dx, p.dy);
    s.current = p;
    if (s.movedPx < this.threshold) return;
    this.handlers.onMove?.(s);
    this.onDragCb?.(s.kind, s);
  }

  private onUp(e: PointerEvent, cancelled: boolean): void {
    const s = this.session;
    if (!s) return;
    if (s.pointerId !== e.pointerId) return;
    this.endSession(cancelled, e);
  }

  private onLeave(e: PointerEvent): void {
    if (!this.session) {
      // leaving without a drag is just hover end
      return;
    }
    if (this.session.pointerId !== e.pointerId) return;
    // With pointer capture this normally does not fire; keep it as a safety net.
    if (this.el.hasPointerCapture?.(e.pointerId)) return;
    this.endSession(false, e);
  }

  private endSession(cancelled: boolean, e: PointerEvent): void {
    const s = this.session;
    if (!s) return;
    s.active = false;
    this.session = null;
    this.focus.setDragOnViewport(false);
    try {
      if (this.el.hasPointerCapture?.(s.pointerId)) this.el.releasePointerCapture(s.pointerId);
    } catch {
      /* already released */
    }
    if (cancelled) this.sessionsCancelled++;
    this.handlers.onEnd?.(s, cancelled);
    this.onDragEndCb?.(s.kind, s, cancelled);

    if (!cancelled && s.movedPx < this.threshold && this.onTapCb) {
      this.onTapCb(s.current, e);
    }
  }

  /** Called on mode/tool switch so a drag can never survive its context. */
  cancel(reason: string): boolean {
    if (!this.session) return false;
    const s = this.session;
    this.endSession(true, { pointerId: s.pointerId, timeStamp: performance.now() } as unknown as PointerEvent);
    void reason;
    return true;
  }

  dispose(): void {
    this.cancel('dispose');
    this.el.removeEventListener('pointerdown', this.cbs.down);
    this.el.removeEventListener('pointermove', this.cbs.move);
    this.el.removeEventListener('pointerup', this.cbs.up);
    this.el.removeEventListener('pointercancel', this.cbs.cancel);
    this.el.removeEventListener('pointerleave', this.cbs.leave);
    if (typeof window !== 'undefined') window.removeEventListener('blur', this.cbs.blur);
  }
}
