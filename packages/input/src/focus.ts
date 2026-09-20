/**
 * packages/input — focus ownership (REQUIREMENT 025, HARDENING CHECK 001).
 *
 * The old repository attached `keydown`/`wheel` directly to the canvas and then
 * gated them on `document.activeElement === canvas`. Any focus loss (a toast,
 * a re-render, a modal) silently killed WASD and wheel zoom — exactly the bug
 * report in `dd.txt`.
 *
 * Here the question "does the viewport own input right now?" is answered by one
 * function with one implementation, driven by real DOM state:
 *
 *   - a modal / popover / command palette open            -> viewport does NOT own input
 *   - focus is on a text input, textarea, contenteditable,
 *     select or combobox                                  -> viewport does NOT own input
 *   - focus is on the viewport element or its overlay      -> viewport DOES own input
 *   - a drag session started on the viewport is live       -> viewport DOES own input
 *   - anything else                                        -> viewport does NOT own input
 */

export type InputSurface =
  | 'viewport'
  | 'panel'
  | 'dialog'
  | 'popover'
  | 'command-palette'
  | 'text-entry'
  | 'none';

export interface FocusSnapshot {
  surface: InputSurface;
  /** True when map movement (WASD / arrows / wheel-dolly) is allowed. */
  viewportOwnsInput: boolean;
  /** True when a text field owns the caret, so typing must not move the map. */
  isTyping: boolean;
  /** True when a modal-ish overlay blocks the viewport. */
  blockedByOverlay: boolean;
  activeElementTag: string | null;
  activeElementId: string | null;
}

const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'radio',
  'range',
  'submit',
  'reset',
  'color',
  'file',
]);

/** Does this element take typed text? (checkboxes/ranges/buttons do not.) */
export function isTextEntryTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '') {
    return true;
  }
  if (el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'combobox') return true;
  return false;
}

/** Is the element inside a scrollable panel/dialog rather than the viewport? */
export function isInsideScrollContainer(el: Element | null, root: Element | null): boolean {
  let cur: Element | null = el;
  while (cur && cur !== root) {
    if (cur.hasAttribute('data-scroll-region')) return true;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(cur) : null;
    if (style) {
      const oy = style.overflowY;
      if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight + 1) return true;
    }
    cur = cur.parentElement;
  }
  return false;
}

export interface FocusManagerOptions {
  /** The element that represents the map viewport. */
  viewportSelector?: string;
  /** Selector matching anything that is a blocking overlay. */
  overlaySelector?: string;
  getDocument?: () => Document | null;
}

/**
 * Tracks which surface owns input. It is intentionally *stateless about
 * intent*: it only reads the DOM plus the explicitly registered overlay state,
 * so it cannot drift out of sync with what the user actually sees.
 */
export class FocusManager {
  private viewport: Element | null = null;
  private overlays = new Set<string>();
  private dragOnViewport = false;
  private getDoc: () => Document | null;
  private readonly overlaySelector: string;
  private listeners: Array<() => void> = [];

  constructor(opts: FocusManagerOptions = {}) {
    this.getDoc = opts.getDocument ?? (() => (typeof document !== 'undefined' ? document : null));
    this.overlaySelector = opts.overlaySelector ?? '[data-blocking-overlay="true"]';
    if (opts.viewportSelector) this.setViewportFromDocument(opts.viewportSelector);
  }

  private setViewportFromDocument(selector: string): void {
    const doc = this.getDoc();
    if (doc) this.viewport = doc.querySelector(selector);
  }

  setViewport(el: Element | null): void {
    this.viewport = el;
  }

  getViewport(): Element | null {
    return this.viewport;
  }

  /** Register/unregister a blocking overlay by id (dialogs, palettes, popovers). */
  setOverlayOpen(id: string, open: boolean): void {
    if (open) this.overlays.add(id);
    else this.overlays.delete(id);
  }

  setDragOnViewport(active: boolean): void {
    this.dragOnViewport = active;
  }

  /** True while any registered overlay is open, or one is present in the DOM. */
  overlayOpen(): boolean {
    if (this.overlays.size > 0) return true;
    const doc = this.getDoc();
    if (!doc || !doc.querySelector) return false;
    const found = doc.querySelector(`${this.overlaySelector}[data-open="true"]`);
    return found !== null;
  }

  snapshot(): FocusSnapshot {
    const doc = this.getDoc();
    const active = (doc?.activeElement as Element | null) ?? null;
    const typing = isTextEntryTarget(active);
    const overlay = this.overlayOpen();

    let surface: InputSurface = 'none';
    if (typing) surface = 'text-entry';
    else if (overlay) surface = this.overlays.has('command-palette') ? 'command-palette' : 'dialog';
    else if (active && this.viewport && this.viewport.contains(active)) surface = 'viewport';
    else if (active && active !== doc?.body) surface = 'panel';
    else if (this.dragOnViewport) surface = 'viewport';

    const viewportOwnsInput =
      !typing && !overlay && ((surface === 'viewport') || (this.dragOnViewport && !typing));

    return {
      surface,
      viewportOwnsInput,
      isTyping: typing,
      blockedByOverlay: overlay,
      activeElementTag: active?.tagName ?? null,
      activeElementId: active?.id ?? null,
    };
  }

  viewportOwnsInput(): boolean {
    return this.snapshot().viewportOwnsInput;
  }

  /** Move focus to the viewport so movement keys start working immediately. */
  focusViewport(reason: 'click' | 'programmatic' = 'programmatic'): boolean {
    const vp = this.viewport as HTMLElement | null;
    if (!vp) return false;
    if (!vp.hasAttribute('tabindex')) vp.setAttribute('tabindex', '0');
    try {
      vp.focus({ preventScroll: true });
    } catch {
      vp.focus();
    }
    void reason;
    return this.getDoc()?.activeElement === vp;
  }

  onChange(fn: (snap: FocusSnapshot) => void): () => void {
    const doc = this.getDoc();
    const handler = () => fn(this.snapshot());
    if (doc) {
      doc.addEventListener('focusin', handler, true);
      doc.addEventListener('focusout', handler, true);
    }
    const off = () => {
      if (doc) {
        doc.removeEventListener('focusin', handler, true);
        doc.removeEventListener('focusout', handler, true);
      }
    };
    this.listeners.push(off);
    return off;
  }

  dispose(): void {
    for (const off of this.listeners) off();
    this.listeners = [];
    this.overlays.clear();
  }
}
