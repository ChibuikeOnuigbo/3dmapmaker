/**
 * packages/tutorial — step-by-step tutorial driven by real events
 * (REQUIREMENT 134, 135, HARDENING CHECK 009).
 *
 * A step declares the *observation* that proves the user did the thing:
 * a predicate over the live app state, not a timer. The tutorial only advances
 * when `verify()` returns true. Skipping, restarting, resizing and
 * reduced-motion are all first-class.
 */

export type TutorialStepKind = 'info' | 'action' | 'confirm';

export interface TutorialStep<Ctx> {
  id: string;
  title: string;
  body: string;
  kind: TutorialStepKind;
  /** CSS selector of the element to highlight. Null = no spotlight. */
  target?: string | null;
  /** Optional static screenshot/illustration for the static tutorial. */
  illustration?: string;
  /** Human description of the expected action, shown while waiting. */
  hint?: string;
  /**
   * The ONLY thing that can advance an action step. Must be a pure predicate
   * over the current context — no timers, no animation callbacks.
   */
  verify?: (ctx: Ctx) => boolean;
  /** Called once when the step becomes active (e.g. to select a tool). */
  onEnter?: (ctx: Ctx) => void;
  onExit?: (ctx: Ctx) => void;
  /** Optional guard: refuse to enter until the world is ready. */
  canEnter?: (ctx: Ctx) => { ok: boolean; reason?: string };
}

export type TutorialPhase = 'idle' | 'running' | 'paused' | 'completed' | 'skipped';

export interface TutorialOptions<Ctx> {
  id: string;
  title: string;
  steps: Array<TutorialStep<Ctx>>;
  onStepChange?: (index: number, step: TutorialStep<Ctx> | null) => void;
  onComplete?: (stats: TutorialStats) => void;
  onBlocked?: (stepId: string, reason: string) => void;
}

export interface TutorialStats {
  completedSteps: string[];
  skippedSteps: string[];
  wrongAttempts: number;
  restarts: number;
  startedAt: number;
  finishedAt: number;
  reducedMotion: boolean;
}

export class Tutorial<Ctx> {
  private phase: TutorialPhase = 'idle';
  private index = -1;
  private stats: TutorialStats;
  private opts: TutorialOptions<Ctx>;
  private reducedMotion: boolean;

  constructor(opts: TutorialOptions<Ctx>, reducedMotion = false) {
    this.opts = opts;
    this.reducedMotion = reducedMotion;
    this.stats = {
      completedSteps: [],
      skippedSteps: [],
      wrongAttempts: 0,
      restarts: 0,
      startedAt: 0,
      finishedAt: 0,
      reducedMotion,
    };
  }

  get current(): TutorialStep<Ctx> | null {
    return this.index >= 0 && this.index < this.opts.steps.length ? this.opts.steps[this.index] : null;
  }
  get currentIndex(): number {
    return this.index;
  }
  get currentPhase(): TutorialPhase {
    return this.phase;
  }
  get stepCount(): number {
    return this.opts.steps.length;
  }
  get isReducedMotion(): boolean {
    return this.reducedMotion;
  }
  get progress(): number {
    return this.opts.steps.length ? Math.max(0, this.index) / this.opts.steps.length : 0;
  }
  getStats(): TutorialStats {
    return { ...this.stats, completedSteps: [...this.stats.completedSteps], skippedSteps: [...this.stats.skippedSteps] };
  }
  get steps(): Array<TutorialStep<Ctx>> {
    return [...this.opts.steps];
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
    this.stats.reducedMotion = v;
  }

  start(ctx: Ctx): TutorialStep<Ctx> | null {
    this.phase = 'running';
    this.index = -1;
    this.stats.startedAt = Date.now();
    this.stats.finishedAt = 0;
    this.stats.completedSteps = [];
    this.stats.skippedSteps = [];
    this.stats.wrongAttempts = 0;
    return this.enterNext(ctx);
  }

  restart(ctx: Ctx): TutorialStep<Ctx> | null {
    this.stats.restarts++;
    return this.start(ctx);
  }

  private enterNext(ctx: Ctx): TutorialStep<Ctx> | null {
    this.index++;
    if (this.index >= this.opts.steps.length) {
      this.phase = 'completed';
      this.stats.finishedAt = Date.now();
      this.opts.onStepChange?.(this.index, null);
      this.opts.onComplete?.(this.getStats());
      return null;
    }
    const step = this.opts.steps[this.index];
    const guard = step.canEnter?.(ctx);
    if (guard && !guard.ok) {
      this.phase = 'paused';
      this.opts.onBlocked?.(step.id, guard.reason ?? 'This step cannot start yet.');
      this.opts.onStepChange?.(this.index, step);
      return step;
    }
    step.onEnter?.(ctx);
    this.opts.onStepChange?.(this.index, step);

    // An `info` step is advanced by the user clicking Next; an `action` step is
    // advanced only by verify(). If an action step is already satisfied (e.g.
    // the user did it before the tutorial asked), complete it immediately.
    if (step.kind === 'action' && step.verify?.(ctx)) {
      this.completeCurrent(ctx);
    }
    return step;
  }

  /**
   * Called on every relevant app event (and on a slow rAF tick). This is the
   * single place a step can advance.
   */
  evaluate(ctx: Ctx): { advanced: boolean; completed: boolean } {
    if (this.phase !== 'running') return { advanced: false, completed: this.phase === 'completed' };
    const step = this.current;
    if (!step) return { advanced: false, completed: false };
    if (step.kind !== 'action' || !step.verify) return { advanced: false, completed: false };
    if (!step.verify(ctx)) return { advanced: false, completed: false };
    this.completeCurrent(ctx);
    // completeCurrent may have walked off the end of the step list, which flips
    // the phase to 'completed'.
    return { advanced: true, completed: (this.phase as TutorialPhase) === 'completed' };
  }

  private completeCurrent(ctx: Ctx): void {
    const step = this.current;
    if (!step) return;
    step.onExit?.(ctx);
    this.stats.completedSteps.push(step.id);
    this.enterNext(ctx);
  }

  /** Record that the user did something that was NOT the expected action. */
  recordWrongAttempt(): void {
    this.stats.wrongAttempts++;
  }

  /** Advance an info/confirm step (the "Next" button). */
  next(ctx: Ctx): TutorialStep<Ctx> | null {
    if (this.phase !== 'running') return null;
    const step = this.current;
    if (!step) return null;
    if (step.kind === 'action') {
      // Refuse to skip past an action step with the Next button — the whole
      // point of REQUIREMENT 135 is that it needs the real action.
      this.recordWrongAttempt();
      return step;
    }
    this.completeCurrent(ctx);
    return this.current;
  }

  /** Skip the current step explicitly (recorded in stats). */
  skip(ctx: Ctx): TutorialStep<Ctx> | null {
    if (this.phase !== 'running') return null;
    const step = this.current;
    if (step) {
      this.stats.skippedSteps.push(step.id);
      step.onExit?.(ctx);
    }
    return this.enterNext(ctx);
  }

  skipAll(ctx: Ctx): void {
    while (this.phase === 'running') {
      const before = this.index;
      this.skip(ctx);
      if (this.index === before) break; // safety
    }
  }

  pause(): void {
    if (this.phase === 'running') this.phase = 'paused';
  }

  resume(ctx: Ctx): TutorialStep<Ctx> | null {
    if (this.phase !== 'paused') return this.current;
    this.phase = 'running';
    const step = this.current;
    if (step?.kind === 'action' && step.verify?.(ctx)) this.completeCurrent(ctx);
    return this.current;
  }

  stop(): void {
    this.phase = 'idle';
    this.index = -1;
  }
}

/* ------------------------------------------------------- default tutorial --- */

export interface AppTutorialContext {
  tool: string;
  hasTerrain: boolean;
  selectionCount: number;
  sculptApplied: boolean;
  bookmarkCount: number;
  cameraMoved: boolean;
  layerAdded: boolean;
  measurementCount: number;
  viewportFocused: boolean;
  quality: string;
}

export const emptyTutorialContext = (): AppTutorialContext => ({
  tool: 'select',
  hasTerrain: false,
  selectionCount: 0,
  sculptApplied: false,
  bookmarkCount: 0,
  cameraMoved: false,
  layerAdded: false,
  measurementCount: 0,
  viewportFocused: false,
  quality: 'normal',
});

export function firstRunTutorial(): Array<TutorialStep<AppTutorialContext>> {
  return [
    {
      id: 'welcome',
      kind: 'info',
      title: 'Welcome to 3DMapMaker Next',
      body: 'This is an authoring tool, not a viewer: everything you place is editable and saved to your project. Click Next to begin.',
      target: null,
    },
    {
      id: 'focus-viewport',
      kind: 'action',
      title: 'Give the map focus',
      body: 'Click anywhere inside the 3D viewport. Keyboard movement only works while the viewport owns input — that is deliberate, so typing in a field never moves your map.',
      hint: 'Click inside the 3D viewport.',
      target: '[data-viewport="true"]',
      verify: (ctx) => ctx.viewportFocused,
    },
    {
      id: 'move-camera',
      kind: 'action',
      title: 'Move the camera',
      body: 'Drag with the left mouse button to orbit, or hold W / A / S / D (or the arrow keys) to pan. Scroll the wheel over the map to zoom.',
      hint: 'Orbit or pan the camera.',
      target: '[data-viewport="true"]',
      verify: (ctx) => ctx.cameraMoved,
    },
    {
      id: 'sculpt-tool',
      kind: 'action',
      title: 'Pick the sculpt tool',
      body: 'Open the tool rail and choose Sculpt (or press B). The inspector switches to brush settings.',
      hint: 'Activate the Sculpt tool.',
      target: '[data-tool="sculpt"]',
      verify: (ctx) => ctx.tool === 'sculpt',
    },
    {
      id: 'sculpt-terrain',
      kind: 'action',
      title: 'Sculpt the terrain',
      body: 'Drag on the terrain to raise it. Your edits are stored as absolute heights, so they survive regeneration and reload.',
      hint: 'Drag on the terrain with the sculpt brush.',
      target: '[data-viewport="true"]',
      verify: (ctx) => ctx.sculptApplied,
    },
    {
      id: 'add-layer',
      kind: 'action',
      title: 'Add something to the world',
      body: 'Use the Build panel to add an object, a road, a building or a marker. It appears in the Layers tree.',
      hint: 'Add any layer.',
      target: '[data-panel="layers"]',
      verify: (ctx) => ctx.layerAdded,
    },
    {
      id: 'select-object',
      kind: 'action',
      title: 'Select it',
      body: 'Switch back to the Select tool (V) and click what you just added.',
      hint: 'Select an object in the viewport.',
      target: '[data-tool="select"]',
      verify: (ctx) => ctx.selectionCount > 0,
    },
    {
      id: 'bookmark',
      kind: 'action',
      title: 'Save a bookmark',
      body: 'Press the bookmark button in the navigation controls to save this camera position. Bookmarks are stored locally in your browser.',
      hint: 'Create a bookmark.',
      target: '[data-action="bookmark-add"]',
      verify: (ctx) => ctx.bookmarkCount > 0,
    },
    {
      id: 'done',
      kind: 'info',
      title: 'You are ready',
      body: 'Press Ctrl/Cmd+Shift+P at any time for the command palette. Everything you build is saved locally — nothing is uploaded.',
      target: null,
    },
  ];
}
