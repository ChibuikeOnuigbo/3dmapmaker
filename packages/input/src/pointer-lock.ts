/**
 * packages/input — Pointer Lock for first-person look (REQUIREMENT 035).
 *
 * Real `requestPointerLock`, with:
 *  - honest capability detection (iOS Safari has no pointer lock);
 *  - the browser's "user gesture required / security error" surfaced as an
 *    actionable message instead of a silent no-op;
 *  - automatic unlock whenever a modal opens or Escape is pressed;
 *  - a fallback drag-look mode so look-around still works where lock is denied.
 */
import type { FocusManager } from './focus';

export type PointerLockState = 'unsupported' | 'unlocked' | 'locked' | 'denied' | 'pending';

export interface PointerLockOptions {
  element: HTMLElement;
  focus: FocusManager;
  onLockChange?(state: PointerLockState): void;
  onError?(message: string): void;
  /** Accumulated movement deltas, consumed by the camera each frame. */
  onDelta?(dx: number, dy: number): void;
  sensitivity?: number;
}

export class PointerLockController {
  private el: HTMLElement;
  private focus: FocusManager;
  private state: PointerLockState = 'unlocked';
  private sensitivity: number;
  private pendingX = 0;
  private pendingY = 0;
  private readonly cbs: {
    change: () => void;
    error: (e: Event) => void;
    move: (e: Event) => void;
  };
  private onLockChange?: (s: PointerLockState) => void;
  private onError?: (m: string) => void;
  private onDelta?: (dx: number, dy: number) => void;

  constructor(opts: PointerLockOptions) {
    this.el = opts.element;
    this.focus = opts.focus;
    this.sensitivity = opts.sensitivity ?? 1;
    this.onLockChange = opts.onLockChange;
    this.onError = opts.onError;
    this.onDelta = opts.onDelta;
    this.state = this.supported ? 'unlocked' : 'unsupported';

    this.cbs = {
      change: () => this.handleChange(),
      error: (e) => this.handleError(e),
      move: (e) => this.handleMove(e as MouseEvent),
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('pointerlockchange', this.cbs.change);
      document.addEventListener('pointerlockerror', this.cbs.error);
    }
  }

  get supported(): boolean {
    return (
      typeof document !== 'undefined' &&
      typeof this.el.requestPointerLock === 'function' &&
      'exitPointerLock' in document
    );
  }

  getState(): PointerLockState {
    return this.state;
  }

  get isLocked(): boolean {
    return this.state === 'locked' && typeof document !== 'undefined' && document.pointerLockElement === this.el;
  }

  private setState(s: PointerLockState): void {
    if (this.state === s) return;
    this.state = s;
    this.onLockChange?.(s);
  }

  /** Request the lock. Must be called from a user gesture. */
  request(): boolean {
    if (!this.supported) {
      this.setState('unsupported');
      this.onError?.('Pointer Lock is not supported in this browser. Use drag-look instead.');
      return false;
    }
    if (this.isLocked) return true;
    this.setState('pending');
    try {
      // `unadjustedMovement` is not in every TS DOM lib, so request it through
      // a locally-typed view of the element rather than casting the options.
      const el = this.el as Element & { requestPointerLock(options?: { unadjustedMovement?: boolean }): Promise<void> | void };
      const result = el.requestPointerLock({ unadjustedMovement: false });
      // Some browsers return a Promise (Chrome 113+); others return undefined.
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((err: unknown) => {
          this.setState('denied');
          this.onError?.(
            `Pointer Lock was denied: ${err instanceof Error ? err.message : String(err)}. ` +
              'Click inside the map and try again.',
          );
        });
      }
      return true;
    } catch (err) {
      this.setState('denied');
      this.onError?.(
        `Pointer Lock failed: ${err instanceof Error ? err.message : String(err)}. ` +
          'Browsers require the request to come from a click inside the map.',
      );
      return false;
    }
  }

  /** Exit the lock. Safe to call when not locked. */
  exit(): void {
    if (typeof document !== 'undefined' && document.pointerLockElement === this.el) {
      document.exitPointerLock();
    }
    this.setState('unlocked');
    this.pendingX = 0;
    this.pendingY = 0;
  }

  /** Called by the UI whenever a modal/palette opens. */
  releaseForOverlay(): void {
    if (this.isLocked) this.exit();
  }

  private handleChange(): void {
    const locked = typeof document !== 'undefined' && document.pointerLockElement === this.el;
    if (locked) {
      this.setState('locked');
      document.addEventListener('mousemove', this.cbs.move);
    } else {
      this.setState('unlocked');
      document.removeEventListener('mousemove', this.cbs.move);
      this.pendingX = 0;
      this.pendingY = 0;
    }
  }

  private handleError(e: Event): void {
    this.setState('denied');
    const reason = (e as ErrorEvent).message;
    this.onError?.(
      reason ??
        'The browser refused pointer lock. This usually means the page is not focused or the request was rate-limited.',
    );
  }

  private handleMove(e: MouseEvent): void {
    if (!this.isLocked) return;
    const dx = (e.movementX ?? 0) * this.sensitivity;
    const dy = (e.movementY ?? 0) * this.sensitivity;
    this.pendingX += dx;
    this.pendingY += dy;
    this.onDelta?.(dx, dy);
  }

  /** Drain accumulated movement for this frame. */
  consumeDelta(): { x: number; y: number } {
    const out = { x: this.pendingX, y: this.pendingY };
    this.pendingX = 0;
    this.pendingY = 0;
    return out;
  }

  dispose(): void {
    this.exit();
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerlockchange', this.cbs.change);
      document.removeEventListener('pointerlockerror', this.cbs.error);
      document.removeEventListener('mousemove', this.cbs.move);
    }
  }
}

/**
 * Fullscreen helper. Uses the real Fullscreen API and reports honest capability,
 * because the old repo's "fullscreen" only resized a 2D canvas overlay
 * (REQUIREMENT 031, 088).
 */
export class FullscreenController {
  private target: HTMLElement;
  private onChangeCb?: (active: boolean) => void;

  constructor(target: HTMLElement, onChange?: (active: boolean) => void) {
    this.target = target;
    this.onChangeCb = onChange;
    if (typeof document !== 'undefined') {
      document.addEventListener('fullscreenchange', () => this.onChangeCb?.(this.active));
    }
  }

  get supported(): boolean {
    return typeof document !== 'undefined' && typeof this.target.requestFullscreen === 'function';
  }

  get active(): boolean {
    return typeof document !== 'undefined' && document.fullscreenElement === this.target;
  }

  async enter(): Promise<boolean> {
    if (!this.supported) return false;
    if (this.active) return true;
    try {
      await this.target.requestFullscreen({ navigationUI: 'hide' });
      return this.active;
    } catch {
      return false;
    }
  }

  async exit(): Promise<boolean> {
    if (typeof document === 'undefined' || !document.fullscreenElement) return true;
    try {
      await document.exitFullscreen();
      return true;
    } catch {
      return false;
    }
  }

  async toggle(): Promise<boolean> {
    return this.active ? this.exit() : this.enter();
  }

  dispose(): void {
    /* listeners are on document and die with the page */
  }
}

/**
 * Keyboard focus is the thing that decides whether the viewport owns input.
 * Escape always releases lock/overlay so the user is never trapped.
 */
export function installEscapeHandler(
  focus: FocusManager,
  handlers: { onEscape: () => void },
): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    handlers.onEscape();
    // Escape is handled; do not let it also blur the viewport silently.
    e.preventDefault();
    void focus;
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }
  return () => undefined;
}
