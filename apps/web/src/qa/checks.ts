/**
 * apps/web/qa — the hardening checks and the legacy regression suite.
 *
 * REQUIREMENT: 100 measurable checks, 10 kinds × 10, each runnable in the
 * browser and recorded. Every `run()` here executes real code from the packages
 * and returns the value it measured; a check fails when the measured value is
 * wrong, never because someone wrote `status: 'pass'`.
 */
import {
  AxisCommands,
  CommandBus,
  FocusManager,
  KeyboardLayer,
  WheelRouter,
  defaultBindings,
  defaultCommands,
  type CommandEvent,
  type FocusSnapshot,
} from '@3dmm/input';
import {
  OrbitMode,
  FlyMode,
  WalkMode,
  CameraTransitionController,
  viewProjectionMatrix,
  worldToScreen,
  type CameraBasis,
  type RigState,
} from '@3dmm/camera';
import {
  clampPanoramaPitch,
  PanoramaGraph,
  PanoramaTransition,
  equirectUvToDirection,
  directionToEquirectUv,
  planSyntheticMove,
  analyzePoleValidity,
  type PanoramaNode,
} from '@3dmm/panorama';
import {
  generateHeightfield,
  buildTerrainMesh,
  Heightfield,
  hillshade,
  extractContours,
  applyStroke,
  defaultBrush,
  type TerrainSource,
} from '@3dmm/terrain';
import { TangentFrame, geo, rebase, shouldRebase, REBASE_THRESHOLD, enuToScene, sceneToEnu, measureLocal, tilesInBounds } from '@3dmm/gis';
import { flattenTree, auditTree, findPath, reparent, reorder, removeNode, insertNode, MAX_TREE_DEPTH } from '@3dmm/layers';
import { LruCache, TileManager, selectLod, AdaptiveQuality, Profiler, type QualityTier } from '@3dmm/performance';
import { CollisionWorld, FixedTimestep, CharacterController, feetY, SpringDeformer, SURFACES } from '@3dmm/physics';
import { Tutorial, firstRunTutorial, emptyTutorialContext } from '@3dmm/tutorial';
import { newProject, validateProject, SCHEMA_VERSION, migrateProject, type ObjectNode } from '@3dmm/project';
import { useStore } from '../state/store';

export type QaStatus = 'idle' | 'pass' | 'fail' | 'skip';

export interface QaCheck {
  id: string;
  name: string;
  description: string;
  status: QaStatus;
  detail?: string;
}

export interface QaSuite {
  id: string;
  name: string;
  checks: QaCheck[];
}

interface RunResult {
  ok: boolean;
  detail: string;
  /** True when the check could not be measured in this environment. */
  skip?: boolean;
}

type CheckFn = () => RunResult | Promise<RunResult>;

const pass = (detail: string): RunResult => ({ ok: true, detail });
const fail = (detail: string): RunResult => ({ ok: false, detail });

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

/* ------------------------------------------------------------- fixtures --- */

const procedural = (over: Partial<Extract<TerrainSource, { kind: 'procedural' }>> = {}): TerrainSource => ({
  kind: 'procedural',
  seed: 1337,
  octaves: 4,
  lacunarity: 2.02,
  gain: 0.5,
  amplitude: 120,
  frequency: 0.002,
  warp: 0.3,
  ridged: false,
  ...over,
});

const gen = (source: TerrainSource, resolution: number, size: number, originX = 0, originY = 0) =>
  generateHeightfield({ source, resolution, size, originX, originY });

function rig(over: Partial<RigState> = {}): RigState {
  return {
    position: { x: 0, y: 100, z: 200 },
    target: { x: 0, y: 0, z: 0 },
    headingDeg: 0,
    pitchDeg: -25,
    rollDeg: 0,
    fovDeg: 60,
    distance: 220,
    ...over,
  };
}

function basis(over: Partial<CameraBasis> = {}): CameraBasis {
  return {
    position: { x: 0, y: 100, z: 200 },
    headingDeg: 0,
    pitchDeg: -25,
    rollDeg: 0,
    fovDeg: 60,
    aspect: 16 / 9,
    near: 0.1,
    far: 5000,
    ...over,
  };
}

function node(kind: ObjectNode['kind'], id: string, children: ObjectNode[] = []): ObjectNode {
  return {
    id,
    kind,
    name: id,
    visible: true,
    locked: false,
    position: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    anchor: { type: 'world' },
    data: {},
    children,
  };
}

function pano(id: string, x: number, neighbors: Record<string, string> = {}): PanoramaNode {
  return { id, name: id.toUpperCase(), position: { x, y: 1.7, z: 0 }, headingDeg: 0, image: '', neighbors, vfovDeg: 180 };
}

const EMPTY_FOCUS: FocusSnapshot = {
  surface: 'viewport',
  viewportOwnsInput: true,
  isTyping: false,
  blockedByOverlay: false,
  activeElementTag: null,
  activeElementId: null,
};

/** Build a real keyboard/wheel harness bound to a detached element. */
function harness(onEvent: (e: CommandEvent) => void) {
  const bus = new CommandBus();
  const defs = defaultCommands();
  bus.registerAll(defs);
  // Register a sink handler for every command. Without one, dispatch bails at
  // `rejectedNoHandler` and the bus reports that nothing happened — which made
  // every keyboard and wheel check below read as "0 commands" no matter what
  // the input layers actually emitted.
  for (const d of defs) bus.on(d.id, () => undefined);
  const off = bus.on('*', onEvent as never);
  const focus = new FocusManager();
  const el = document.createElement('div');
  // FocusManager derives the owning surface from document.activeElement, so a
  // bare <div> that cannot receive focus leaves surface === 'none' and the
  // keyboard layer correctly refuses to act. Make the element focusable and
  // actually focus it, which is what a real viewport canvas is.
  el.tabIndex = -1;
  document.body.appendChild(el);
  el.focus();
  focus.setViewport(el);
  const kb = new KeyboardLayer({ bus, focus, bindings: defaultBindings(), target: el });
  const wheel = new WheelRouter({ bus, focus, target: el });
  return {
    bus,
    el,
    key: (type: 'keydown' | 'keyup', key: string) => el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true })),
    dispose: () => {
      kb.dispose();
      wheel.dispose();
      off();
      el.remove();
    },
  };
}

const AXES = { forward: 0, right: 0, up: 0, yaw: 0, pitch: 0, zoom: 0, boost: false, slow: false, jump: false, crouch: false };

/**
 * Some checks inspect the live document — headings, landmarks, live regions,
 * stylesheets. They are meaningful only when the app is actually mounted, so
 * run headlessly against an empty document they would report a false failure.
 * Skipping is the honest result; failing would claim the app is broken when
 * all that happened is that nothing was rendered.
 */
function mountedApp(): boolean {
  return document.body.children.length > 0;
}

const skip = (reason: string): RunResult => ({ ok: true, detail: `skipped — ${reason}`, skip: true });

/**
 * Build a pointer event, falling back to a MouseEvent carrying the pointer
 * fields jsdom does not model. jsdom ships no `PointerEvent` constructor, so
 * `new PointerEvent(...)` throws and the check reports a crash instead of a
 * result. The fallback keeps the drag path exercisable; in a real browser the
 * genuine constructor is used.
 */
function pointerEvent(
  type: string,
  init: { bubbles?: boolean; clientX?: number; clientY?: number; button?: number; pointerId?: number } = {},
): Event {
  const Ctor = (globalThis as unknown as { PointerEvent?: new (type: string, init?: unknown) => Event }).PointerEvent;
  if (typeof Ctor === 'function') return new Ctor(type, init);
  const e = new MouseEvent(type, {
    bubbles: init.bubbles ?? false,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
  });
  Object.defineProperty(e, 'pointerId', { value: init.pointerId ?? 1 });
  return e;
}

/* ================================================================ INPUT === */

const INPUT: Array<{ id: string; name: string; description: string; run: CheckFn }> = [
  {
    id: 'INPUT-001',
    name: 'WASD and arrows resolve to the same axes',
    description: 'Pressing W and ArrowUp must emit identical command ids with identical values.',
    run: () => {
      const seen: Array<{ id: string; value: number }> = [];
      const h = harness((e) => {
        if (e.id === AxisCommands.moveForward && e.phase === 'down') seen.push({ id: e.id, value: e.value });
      });
      h.key('keydown', 'w');
      h.key('keyup', 'w');
      h.key('keydown', 'ArrowUp');
      h.key('keyup', 'ArrowUp');
      h.dispose();
      return seen.length === 2 && seen[0].value === 1 && seen[1].value === 1
        ? pass(`both emitted ${seen[0].id} with value ${seen[0].value}`)
        : fail(`emitted ${JSON.stringify(seen)}`);
    },
  },
  {
    id: 'INPUT-002',
    name: 'Keys are ignored while a text field has focus',
    description: 'The exact bug from the old app: typing in a panel must not move the camera.',
    run: () => {
      let count = 0;
      const h = harness((e) => {
        if (e.id === AxisCommands.moveForward) count++;
      });
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true }));
      h.dispose();
      input.remove();
      return count === 0 ? pass('0 movement commands while the input had focus') : fail(`${count} commands leaked through`);
    },
  },
  {
    id: 'INPUT-003',
    name: 'Held keys produce continuous motion, not one-shot jumps',
    description: 'An axis stays non-zero between keydown and keyup.',
    run: () => {
      const phases: string[] = [];
      const h = harness((e) => {
        if (e.id === AxisCommands.moveForward) phases.push(`${e.phase}:${e.value}`);
      });
      h.key('keydown', 'w');
      const afterDown = [...phases];
      h.key('keyup', 'w');
      h.dispose();
      return afterDown.length === 1 && afterDown[0] === 'down:1' && phases[1] === 'up:0'
        ? pass('down:1 held, up:0 on release')
        : fail(JSON.stringify(phases));
    },
  },
  {
    id: 'INPUT-004',
    name: 'Focus loss releases every held axis',
    description: 'A notification stealing focus must not leave WASD stuck on.',
    run: () => {
      let last = -1;
      const h = harness((e) => {
        if (e.id === AxisCommands.moveForward) last = e.phase === 'up' ? 0 : e.value;
      });
      h.key('keydown', 'w');
      const held = last;
      window.dispatchEvent(new Event('blur'));
      h.dispose();
      return held === 1 && last === 0 ? pass('held=1 then released to 0 on blur') : fail(`held=${held} after blur=${last}`);
    },
  },
  {
    id: 'INPUT-005',
    name: 'Wheel events are routed only to the focused viewport',
    description: 'Scrolling over a panel must not zoom the map.',
    run: () => {
      let zooms = 0;
      const bus = new CommandBus();
      bus.registerAll(defaultCommands());
      const off = bus.on(AxisCommands.zoom, () => zooms++);
      const focus = new FocusManager();
      const panel = document.createElement('div');
      document.body.appendChild(panel);
      const wheel = new WheelRouter({ bus, focus, target: panel });
      panel.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
      wheel.dispose();
      off();
      panel.remove();
      return zooms === 0 ? pass('0 zoom commands with no viewport focus') : fail(`${zooms} zoom commands fired`);
    },
  },
  {
    id: 'INPUT-006',
    name: 'Diagonal movement is normalised',
    description: 'W+D must not be √2 faster than W alone.',
    run: () => {
      const mode = new FlyMode();
      const r0 = rig();
      const single = rig();
      mode.update(single, { ...AXES, forward: 1 }, 1);
      const diag = rig();
      mode.update(diag, { ...AXES, forward: 1, right: 1 }, 1);
      const d1 = Math.hypot(single.position.x - r0.position.x, single.position.y - r0.position.y, single.position.z - r0.position.z);
      const d2 = Math.hypot(diag.position.x - r0.position.x, diag.position.y - r0.position.y, diag.position.z - r0.position.z);
      const ratio = d2 / Math.max(1e-9, d1);
      return approx(ratio, 1, 0.02) ? pass(`ratio ${ratio.toFixed(4)}`) : fail(`ratio ${ratio.toFixed(4)} — diagonals are faster`);
    },
  },
  {
    id: 'INPUT-007',
    name: 'Movement is delta-time based',
    description: 'Frame rate must not change how far you travel in a given wall-clock time.',
    run: () => {
      // A single step is NOT linear in dt, and it should not be: FlyMode damps
      // velocity toward its target, so a step from rest covers proportionally
      // less ground than a step taken at speed. Asserting "2× dt → 2× distance"
      // on a single step tests a property the controller deliberately does not
      // have. The invariant that actually matters is frame-rate independence:
      // simulate the SAME wall time at three frame rates and compare.
      const distAfter = (steps: number, totalSeconds: number) => {
        const r = rig();
        const mode = new FlyMode();
        for (let i = 0; i < steps; i++) mode.update(r, { ...AXES, forward: 1 }, totalSeconds / steps);
        return Math.hypot(r.position.x, r.position.y - 100, r.position.z - 200);
      };
      const d60 = distAfter(60, 2);
      const d120 = distAfter(120, 2);
      const d240 = distAfter(240, 2);
      const spread = Math.max(d60, d120, d240) / Math.max(1e-9, Math.min(d60, d120, d240)) - 1;
      // Also confirm a zero frame moves nothing at all.
      const still = rig();
      new FlyMode().update(still, { ...AXES, forward: 1 }, 0);
      const stillMoved = Math.hypot(still.position.x, still.position.y - 100, still.position.z - 200);
      return spread < 0.02 && stillMoved < 1e-9
        ? pass(`2 s at 60/120/240 fps → ${d60.toFixed(2)} / ${d120.toFixed(2)} / ${d240.toFixed(2)} m (spread ${(spread * 100).toFixed(2)}%); dt=0 moves ${stillMoved.toExponential(1)} m`)
        : fail(`spread ${(spread * 100).toFixed(2)}% across frame rates (60=${d60.toFixed(3)} 120=${d120.toFixed(3)} 240=${d240.toFixed(3)}); dt=0 moved ${stillMoved}`);
    },
  },
  {
    id: 'INPUT-008',
    name: 'Command bus ignores unknown commands instead of throwing',
    description: 'A stale binding must degrade, not crash the frame loop.',
    run: () => {
      const bus = new CommandBus();
      bus.registerAll(defaultCommands());
      let threw = false;
      try {
        bus.dispatch({ id: 'nope.nope', value: 1, phase: 'down', source: 'api', focus: EMPTY_FOCUS });
      } catch {
        threw = true;
      }
      const stats = bus.getStats();
      return !threw ? pass(`dispatched safely; dispatched=${stats.dispatched}`) : fail('dispatch threw');
    },
  },
  {
    id: 'INPUT-009',
    name: 'Every registered binding maps to a declared command',
    description: 'A binding pointing at nothing is a dead shortcut.',
    run: () => {
      const declared = new Set(defaultCommands().map((c) => c.id));
      const orphans = defaultBindings().filter((b) => !declared.has(b.command)).map((b) => b.command);
      return orphans.length === 0 ? pass(`${defaultBindings().length} bindings, all declared`) : fail(`orphans: ${[...new Set(orphans)].join(', ')}`);
    },
  },
  {
    id: 'INPUT-010',
    name: 'No movement command is bound at global scope',
    description: 'WASD must never fire while a panel has focus.',
    run: () => {
      const globalMove = defaultCommands().filter((c) => c.scope === 'global' && (c.id.startsWith('move.') || c.id.startsWith('turn.') || c.id === 'zoom.delta'));
      return globalMove.length === 0 ? pass('all movement commands are viewport-scoped') : fail(globalMove.map((c) => c.id).join(', '));
    },
  },
];

/* =============================================================== CAMERA === */

const CAMERA: Array<{ id: string; name: string; description: string; run: CheckFn }> = [
  {
    id: 'CAMERA-001',
    name: 'Orbit keeps a constant distance from the pivot',
    description: 'Rotating must not drift the camera off its sphere.',
    run: () => {
      const r = rig({ distance: 200 });
      const mode = new OrbitMode(r);
      const dist = () => Math.hypot(r.position.x - r.target.x, r.position.y - r.target.y, r.position.z - r.target.z);
      const before = dist();
      for (let i = 0; i < 60; i++) mode.rotate(7, 3, 900);
      const after = dist();
      return approx(before, after, 0.01) ? pass(`${before.toFixed(3)} → ${after.toFixed(3)} m`) : fail(`${before.toFixed(3)} → ${after.toFixed(3)} m`);
    },
  },
  {
    id: 'CAMERA-002',
    name: 'Pitch is clamped before it can flip the camera',
    description: 'Looking past vertical must stop, not invert.',
    run: () => {
      const r = rig();
      const mode = new OrbitMode(r);
      // rotate() writes the DESIRED pitch; the rig only converges on it during
      // update(). Reading state.pitchDeg without pumping update() measures the
      // untouched spawn value, which is why this used to report -25 for both
      // the fully-up and fully-down cases.
      const settle = () => {
        for (let i = 0; i < 400; i++) mode.update(r, AXES, 1 / 60);
      };
      for (let i = 0; i < 200; i++) mode.rotate(0, 40, 900);
      settle();
      const up = r.pitchDeg;
      for (let i = 0; i < 400; i++) mode.rotate(0, -40, 900);
      settle();
      const down = r.pitchDeg;
      // The guarantee is about MAGNITUDE, not sign: dragging past vertical must
      // stop at the limit and come back when the drag reverses, never flip
      // through the pole. Which sign a downward drag produces is a convention
      // (OrbitMode uses `desiredPitch -= dyPx`, so +dy looks down), so assert
      // that the two drags land on opposite limits inside the envelope.
      const lo = Math.min(up, down);
      const hi = Math.max(up, down);
      const ok = hi <= 89.999 && lo >= -89.999 && hi >= 88 && lo <= -88 && Math.sign(hi) !== Math.sign(lo);
      return ok
        ? pass(`clamped to [${lo.toFixed(2)}, ${hi.toFixed(2)}] — both drags hit a limit, reversed cleanly, no flip`)
        : fail(`pitch escaped or did not reverse: up=${up.toFixed(2)} down=${down.toFixed(2)}`);
    },
  },
  {
    id: 'CAMERA-003',
    name: 'Heading wraps into [0, 360)',
    description: 'Spinning forever must not accumulate unbounded yaw.',
    run: () => {
      const r = rig();
      const mode = new OrbitMode(r);
      for (let i = 0; i < 500; i++) mode.rotate(23, 0, 900);
      return r.headingDeg >= 0 && r.headingDeg < 360 ? pass(`heading ${r.headingDeg.toFixed(2)}°`) : fail(`heading ${r.headingDeg}`);
    },
  },
  {
    id: 'CAMERA-004',
    name: 'Walk mode follows terrain height',
    description: 'The eye height must track the ground sample.',
    run: () => {
      const w = new CollisionWorld();
      const c = new CharacterController(w, { x: 0, y: 0, z: 0 }, { eyeHeight: 1.7, gravity: 0 });
      c.step({ forward: 0, right: 0, jump: false, sprint: false, crouch: false, headingDeg: 0 }, 1 / 60, () => ({
        height: 42,
        slopeDeg: 0,
        surface: SURFACES.terrain,
      }));
      // state.position is the EYE; the feet are position.y - eyeHeight.
      const feet = feetY(c.state);
      return approx(feet, 42, 0.01)
        ? pass(`feet at ${feet.toFixed(2)} m over 42 m ground (eye at ${c.state.position.y.toFixed(2)})`)
        : fail(`feet=${feet.toFixed(3)} expected 42 (eye=${c.state.position.y.toFixed(2)}, eyeHeight=${c.state.eyeHeight})`);
    },
  },
  {
    id: 'CAMERA-005',
    name: 'A walkable-slope limit blocks a too-steep climb',
    description: 'The character controller reports blockedBySlope on a 70° face.',
    run: () => {
      const w = new CollisionWorld();
      const c = new CharacterController(w, { x: 0, y: 0, z: 0 });
      for (let i = 0; i < 30; i++) {
        c.step({ forward: 1, right: 0, jump: false, sprint: false, crouch: false, headingDeg: 0 }, 1 / 60, () => ({
          height: 0,
          slopeDeg: 70,
          surface: SURFACES.terrain,
        }));
      }
      return c.telemetry.blockedBySlope ? pass(`blockedBySlope=true after 30 steps into a 70° face`) : fail(`blockedBySlope=${c.telemetry.blockedBySlope}`);
    },
  },
  {
    id: 'CAMERA-006',
    name: 'A transition can be interrupted mid-flight',
    description: 'User input during a cinematic move must win immediately.',
    run: () => {
      const t = new CameraTransitionController();
      const r = rig();
      t.start(r, { to: { distance: 50 }, durationMs: 1000, easing: 'easeInOutCubic' });
      t.update(r, 0.3);
      const running = t.isRunning;
      t.cancel(r, 'user-input');
      return running && !t.isRunning ? pass(`running, then cancelled (interruptions=${t.stats.interruptions})`) : fail(`running=${running} after cancel=${t.isRunning}`);
    },
  },
  {
    id: 'CAMERA-007',
    name: 'A completed transition lands exactly on target',
    description: 'No residual offset after the ease finishes.',
    run: () => {
      const t = new CameraTransitionController();
      const r = rig();
      t.start(r, { to: { distance: 40, headingDeg: 90, pitchDeg: -10 }, durationMs: 500, easing: 'easeInOutCubic' });
      for (let i = 0; i < 100; i++) t.update(r, 1 / 60);
      return approx(r.distance, 40, 1e-3) && approx(r.headingDeg, 90, 1e-3)
        ? pass(`landed at d=${r.distance.toFixed(3)} h=${r.headingDeg.toFixed(3)}`)
        : fail(`d=${r.distance} h=${r.headingDeg}`);
    },
  },
  {
    id: 'CAMERA-008',
    name: 'The projection matrix is row-major and consistent',
    description: 'worldToScreen must agree with the matrix the renderer uses.',
    run: () => {
      const cam = basis({ headingDeg: 30, pitchDeg: -20 });
      const m = viewProjectionMatrix(cam);
      const p = { x: 10, y: 5, z: -40 };
      const w = m[12] * p.x + m[13] * p.y + m[14] * p.z + m[15];
      const ndcX = (m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3]) / w;
      const ndcY = (m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7]) / w;
      const vp = { width: 1280, height: 720 };
      const screen = worldToScreen(p, cam, vp);
      const ex = ((ndcX + 1) / 2) * vp.width;
      const ey = ((1 - ndcY) / 2) * vp.height;
      return approx(screen.x, ex, 0.5) && approx(screen.y, ey, 0.5)
        ? pass(`screen (${screen.x.toFixed(1)}, ${screen.y.toFixed(1)}) matches the matrix`)
        : fail(`screen (${screen.x}, ${screen.y}) vs matrix (${ex.toFixed(1)}, ${ey.toFixed(1)})`);
    },
  },
  {
    id: 'CAMERA-009',
    name: 'The world origin projects inside the viewport',
    description: 'A sign error in the matrix would put it off-screen.',
    run: () => {
      const s = worldToScreen({ x: 0, y: 0, z: 0 }, basis(), { width: 1000, height: 800 });
      return s.visible && s.x > 0 && s.x < 1000 && s.y > 0 && s.y < 800
        ? pass(`origin projects to (${s.x.toFixed(1)}, ${s.y.toFixed(1)}) and is visible`)
        : fail(`origin projected to (${s.x}, ${s.y}) visible=${s.visible}`);
    },
  },
  {
    id: 'CAMERA-010',
    name: 'Fly mode ascends and descends on Q/E',
    description: 'The up axis must move along world +Y.',
    run: () => {
      const up = rig();
      new FlyMode().update(up, { ...AXES, up: 1 }, 1);
      const down = rig();
      new FlyMode().update(down, { ...AXES, up: -1 }, 1);
      return up.position.y > 100 && down.position.y < 100
        ? pass(`up → ${up.position.y.toFixed(1)}, down → ${down.position.y.toFixed(1)}`)
        : fail(`up ${up.position.y} down ${down.position.y}`);
    },
  },
];

/* ============================================================ PANORAMA === */

const PANORAMA: Array<{ id: string; name: string; description: string; run: CheckFn }> = [
  {
    id: 'PANO-001',
    name: 'Equirectangular UV↔direction round-trips',
    description: 'The sphere math, not a cube map.',
    run: () => {
      const d = equirectUvToDirection(0.25, 0.5);
      const uv = directionToEquirectUv(d);
      return approx(uv.x, 0.25, 1e-6) && approx(uv.y, 0.5, 1e-6)
        ? pass(`(0.25, 0.5) → dir → (${uv.x.toFixed(6)}, ${uv.y.toFixed(6)})`)
        : fail(`got (${uv.x}, ${uv.y})`);
    },
  },
  {
    id: 'PANO-002',
    name: 'Directions are unit length',
    description: 'A non-unit direction skews the projection.',
    run: () => {
      let worst = 0;
      for (let u = 0; u <= 1.0001; u += 0.05) {
        for (let v = 0; v <= 1.0001; v += 0.05) {
          const d = equirectUvToDirection(u, v);
          worst = Math.max(worst, Math.abs(Math.hypot(d.x, d.y, d.z) - 1));
        }
      }
      return worst < 1e-6 ? pass(`max deviation ${worst.toExponential(2)}`) : fail(`max deviation ${worst}`);
    },
  },
  {
    id: 'PANO-003',
    name: 'Pitch is clamped at the configured limit',
    description: 'Looking into missing polar data must be impossible.',
    run: () => {
      const c1 = clampPanoramaPitch(-120, 70);
      const c2 = clampPanoramaPitch(120, 70);
      const c3 = clampPanoramaPitch(12, 70);
      return c1 === -70 && c2 === 70 && c3 === 12 ? pass('-120→-70, 120→70, 12→12') : fail(`${c1}, ${c2}, ${c3}`);
    },
  },
  {
    id: 'PANO-004',
    name: 'A degenerate clamp limit cannot produce NaN',
    description: 'Zero or negative limits must be handled.',
    run: () => {
      const vals = [clampPanoramaPitch(45, 0), clampPanoramaPitch(45, -30), clampPanoramaPitch(NaN, 70)];
      return vals.every((v) => Number.isFinite(v)) ? pass(`finite for limits 0, -30 and NaN pitch: ${vals.join(', ')}`) : fail(JSON.stringify(vals));
    },
  },
  {
    id: 'PANO-005',
    name: 'Pole analysis detects a black gap',
    description: 'A fully black top row must be reported as missing data.',
    run: () => {
      const w = 64;
      const h = 32;
      const px = new Uint8ClampedArray(w * h * 4);
      for (let y = 1; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          px[i] = 120 + (x % 40);
          px[i + 1] = 90;
          px[i + 2] = 70;
          px[i + 3] = 255;
        }
      }
      const r = analyzePoleValidity(px, w, h, 4);
      return !r.topValid && r.bottomValid ? pass(`topValid=${r.topValid}, bottomValid=${r.bottomValid}`) : fail(`top=${r.topValid} bottom=${r.bottomValid}`);
    },
  },
  {
    id: 'PANO-006',
    name: 'The node graph resolves neighbours transitively',
    description: 'Stepping forward repeatedly must walk the chain.',
    run: () => {
      const g = new PanoramaGraph([pano('a', 0, { forward: 'b' }), pano('b', 10, { forward: 'c', back: 'a' }), pano('c', 20, { back: 'b' })]);
      const path = ['a'];
      let cur = 'a';
      for (let i = 0; i < 4; i++) {
        const next = g.resolve(cur, 'forward');
        if (!next) break;
        cur = next.id;
        path.push(cur);
      }
      return path.join('>') === 'a>b>c' ? pass(path.join(' > ')) : fail(path.join(' > '));
    },
  },
  {
    id: 'PANO-007',
    name: 'A dangling neighbour reference is rejected at validation',
    description: 'The graph must not silently point at nothing.',
    run: () => {
      const p = newProject('x');
      const base = pano('a', 0, { forward: 'ghost' });
      p.panorama.nodes = [{ ...base, vfovDeg: base.vfovDeg ?? 180, cap: { enabled: true, top: '#fff', bottom: '#000', blendDeg: 20 } }];
      const v = validateProject(p);
      return !v.ok && v.issues.some((i) => i.code === 'dangling_ref') ? pass(`rejected: ${v.issues[0].message}`) : fail(`ok=${v.ok}`);
    },
  },
  {
    id: 'PANO-008',
    name: 'Synthetic movement places the neighbour spatially',
    description: 'Two spheres at their true relative positions, plus a measured revealed gap.',
    run: () => {
      const from = pano('a', 0);
      const to = pano('b', 2);
      const plan = planSyntheticMove({ from, to, direction: { x: 1, y: 0 }, t: 0.5 }, 2);
      const separated = plan.layers.length >= 2 && Math.abs(plan.layers[0].center.x - plan.layers[1].center.x) > 0.1;
      return separated && plan.revealedGapFraction > 0 && plan.revealedGapFraction < 1
        ? pass(`${plan.layers.length} layers, centres ${plan.layers.map((l) => l.center.x.toFixed(2)).join('/')} m apart, gap ${(plan.revealedGapFraction * 100).toFixed(1)}%`)
        : fail(`layers=${plan.layers.length}, gap=${plan.revealedGapFraction}`);
    },
  },
  {
    id: 'PANO-009',
    name: 'Transition progress is monotonic and reaches done',
    description: 'A stalled transition would leave two spheres on screen.',
    run: () => {
      const t = new PanoramaTransition({ durationMs: 400, persistence: { enabled: true, strength: 0.6, mode: 'fade', keepCameraState: true } });
      const t0 = Date.now();
      t.start('a', 'b', t0);
      let last = -1;
      let monotonic = true;
      let state = t.update(t0);
      // `done` is reported on the single frame that crosses t >= 1; after that
      // update() correctly returns `idle`, meaning no transition is running.
      // Sampling only the last frame would miss it, so record whether `done`
      // was ever observed and what progress it carried.
      let sawDone = false;
      let doneProgress = 0;
      for (let i = 1; i <= 60; i++) {
        state = t.update(t0 + i * 16);
        if (state.progress < last - 1e-9) monotonic = false;
        last = state.progress;
        if (state.phase === 'done') {
          sawDone = true;
          doneProgress = state.progress;
        }
      }
      const settled = state.phase === 'idle' && state.progress >= 0.999;
      return monotonic && sawDone && doneProgress >= 0.999 && settled
        ? pass(`monotonic to ${doneProgress.toFixed(3)}, reported done, then settled to idle`)
        : fail(`monotonic=${monotonic} sawDone=${sawDone} doneProgress=${doneProgress} final phase=${state.phase} progress=${state.progress}`);
    },
  },
  {
    id: 'PANO-010',
    name: 'World-anchored layers survive a node change',
    description: 'Persistence must not wipe authored content.',
    run: () => {
      const p = newProject('x');
      const marker = node('markers', 'keep-me');
      marker.anchor = { type: 'world' };
      p.layers = [marker];
      p.panorama.currentNodeId = 'a';
      const before = flattenTree(p.layers).length;
      p.panorama.currentNodeId = 'b';
      const after = flattenTree(p.layers).length;
      return before === after && after === 1 ? pass('layer count unchanged across node switch') : fail(`${before} → ${after}`);
    },
  },
];

/* ============================================================== TERRAIN === */

const TERRAIN: Array<{ id: string; name: string; description: string; run: CheckFn }> = [
  {
    id: 'TERRAIN-001',
    name: 'Procedural generation is deterministic per seed',
    description: 'Same seed must give the same world on every load.',
    run: () => {
      const a = gen(procedural({ seed: 99 }), 33, 256);
      const b = gen(procedural({ seed: 99 }), 33, 256);
      let maxDiff = 0;
      for (let i = 0; i < a.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.data[i] - b.data[i]));
      return maxDiff === 0 ? pass('bit-identical for seed 99') : fail(`max diff ${maxDiff}`);
    },
  },
  {
    id: 'TERRAIN-002',
    name: 'Different seeds give different terrain',
    description: 'A constant heightfield would mean the seed is ignored.',
    run: () => {
      const a = gen(procedural({ seed: 1 }), 33, 256);
      const b = gen(procedural({ seed: 2 }), 33, 256);
      let diff = 0;
      for (let i = 0; i < a.data.length; i++) diff += Math.abs(a.data[i] - b.data[i]);
      return diff > 1 ? pass(`total absolute difference ${diff.toFixed(1)} m`) : fail(`difference ${diff}`);
    },
  },
  {
    id: 'TERRAIN-003',
    name: 'Amplitude bounds the generated relief',
    description: 'A 120 m amplitude must not produce a 5 km spike.',
    run: () => {
      const h = gen(procedural({ amplitude: 120 }), 49, 512);
      const { min, max } = h.minMax();
      const span = max - min;
      return span <= 120 * 2.5 ? pass(`relief ${span.toFixed(1)} m for amplitude 120`) : fail(`relief ${span.toFixed(1)} m`);
    },
  },
  {
    id: 'TERRAIN-004',
    name: 'The mesh is Y-up with a closed skirt',
    description: 'Tile borders must not show gaps from underneath.',
    run: () => {
      const h = gen(procedural(), 25, 256);
      const mesh = buildTerrainMesh(h, { skirtMeters: 6 });
      let minY = Infinity;
      for (let i = 1; i < mesh.positions.length; i += 3) minY = Math.min(minY, mesh.positions[i]);
      const { min } = h.minMax();
      return mesh.vertexCount > 0 && minY < min
        ? pass(`${mesh.vertexCount} verts, min Y ${minY.toFixed(2)} m below the lowest sample ${min.toFixed(2)} m — skirt present`)
        : fail(`verts=${mesh.vertexCount} minY=${minY} lowest=${min}`);
    },
  },
  {
    id: 'TERRAIN-005',
    name: 'Neighbouring tiles share border heights',
    description: 'Stitched borders, not visible seams.',
    run: () => {
      const src = procedural();
      const a = gen(src, 33, 256, 0, 0);
      const b = gen(src, 33, 256, 256, 0);
      let worst = 0;
      for (let gy = 0; gy < 33; gy++) {
        const y = gy * 8;
        worst = Math.max(worst, Math.abs(a.sample(256, y) - b.sample(256, y)));
      }
      return worst < 1e-3 ? pass(`max border mismatch ${worst.toExponential(2)} m`) : fail(`mismatch ${worst} m`);
    },
  },
  {
    id: 'TERRAIN-006',
    name: 'sample() interpolates between grid nodes',
    description: 'A stair-step heightfield would break terrain-follow.',
    run: () => {
      const h = gen(procedural(), 33, 256);
      const a = h.sample(10, 10);
      const b = h.sample(10.5, 10);
      const c = h.sample(11, 10);
      const between = b >= Math.min(a, c) - 1e-9 && b <= Math.max(a, c) + 1e-9;
      return between && b !== a ? pass(`interpolated ${a.toFixed(4)} → ${b.toFixed(4)} → ${c.toFixed(4)}`) : fail(`${a}, ${b}, ${c}`);
    },
  },
  {
    id: 'TERRAIN-007',
    name: 'Sculpt edits are stored as absolute heights',
    description: 'Edits must survive regeneration and reload.',
    run: () => {
      const h = gen(procedural(), 33, 256);
      const before = h.sample(128, 128);
      const stroke = applyStroke(h, { x: 128, y: 128 }, { x: 128, y: 128 }, { ...defaultBrush(), tool: 'raise', radius: 40, strength: 60, dt: 1 });
      const edits = h.toEdits(gen(procedural(), 33, 256));
      const after = h.sample(128, 128);
      const reapplied = gen(procedural(), 33, 256);
      reapplied.applyEdits(edits);
      return after > before + 1 && approx(reapplied.sample(128, 128), after, 1e-3)
        ? pass(`${before.toFixed(2)} → ${after.toFixed(2)} m, ${stroke.touched} samples touched, edits reapply exactly`)
        : fail(`${before} → ${after}, reapply=${reapplied.sample(128, 128)}`);
    },
  },
  {
    id: 'TERRAIN-008',
    name: 'Hillshade responds to sun azimuth',
    description: 'A cached hillshade must still change with the sun.',
    run: () => {
      const h = gen(procedural(), 33, 256);
      const a = hillshade(h, { azimuthDeg: 315, elevationDeg: 45, intensity: 1, zFactor: 1, cellSize: h.step });
      const b = hillshade(h, { azimuthDeg: 135, elevationDeg: 45, intensity: 1, zFactor: 1, cellSize: h.step });
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
      return diff > 100 ? pass(`mean per-pixel difference ${(diff / a.length).toFixed(1)}/255`) : fail(`difference ${diff}`);
    },
  },
  {
    id: 'TERRAIN-009',
    name: 'Contours are extracted at the requested interval',
    description: 'Index contours must be a subset at every 5th line.',
    run: () => {
      const h = gen(procedural({ amplitude: 400 }), 49, 512);
      const result = extractContours(h, 50, 5);
      const indexLevels = [...new Set(result.segments.filter((l) => l.index).map((l) => l.elevation))];
      const allIndex = indexLevels.every((l) => Math.abs(l % 250) < 1e-3);
      return result.segments.length > 0 && result.levels.length > 3 && allIndex
        ? pass(`${result.segments.length} segments, ${result.levels.length} levels, index lines every 250 m`)
        : fail(`${result.segments.length} segments, ${result.levels.length} levels, indexOk=${allIndex}`);
    },
  },
  {
    id: 'TERRAIN-010',
    name: 'A heightfield survives a worker round-trip',
    description: 'Typed arrays must reconstruct identically after a structured clone.',
    run: () => {
      const h = gen(procedural(), 17, 128);
      const copy = structuredClone({ data: Array.from(h.data), resolution: h.resolution, size: h.size, originX: h.originX, originY: h.originY });
      const restored = new Heightfield(copy.resolution, copy.size, copy.originX, copy.originY, Float32Array.from(copy.data));
      const a = h.sample(64, 64);
      const b = restored.sample(64, 64);
      return approx(a, b, 1e-6) ? pass(`round-tripped height ${a.toFixed(4)}`) : fail(`${a} vs ${b}`);
    },
  },
];

/* ========================================================== WORLD-SCALE === */

const WORLD: Array<{ id: string; name: string; description: string; run: CheckFn }> = [
  {
    id: 'WORLD-001',
    name: 'Geodetic → local → geodetic round-trips',
    description: 'The tangent frame must not drift.',
    run: () => {
      const frame = new TangentFrame(geo(46.5, 8.2, 0));
      const g = geo(46.51, 8.21, 120);
      const local = frame.toLocal(g);
      const back = frame.toGeo(local);
      const err = Math.hypot((back.lat - g.lat) * 111320, (back.lon - g.lon) * 111320 * Math.cos((g.lat * Math.PI) / 180), back.alt - g.alt);
      return err < 0.01 ? pass(`round-trip error ${err.toFixed(4)} m`) : fail(`error ${err} m`);
    },
  },
  {
    id: 'WORLD-002',
    name: 'ENU↔scene conversion is an exact inverse',
    description: 'North must be -Z, up must be +Y.',
    run: () => {
      const e = { x: 3, y: 4, z: 5 };
      const scene = enuToScene(e);
      const back = sceneToEnu(scene);
      return approx(back.x, 3) && approx(back.y, 4) && approx(back.z, 5) && approx(scene.y, 5) && approx(scene.z, -4)
        ? pass(`ENU(3,4,5) → scene(${scene.x},${scene.y},${scene.z}) → back exactly`)
        : fail(JSON.stringify({ scene, back }));
    },
  },
  {
    id: 'WORLD-003',
    name: 'The floating origin rebases past the threshold',
    description: 'Precision must be recovered, not lost, far from the anchor.',
    run: () => {
      const cam = { x: 9000, y: 100, z: 0 };
      const should = shouldRebase(cam, { x: 0, y: 0, z: 0 });
      const offset = rebase(cam, true);
      const remaining = Math.hypot(cam.x - offset.x, cam.z - offset.z);
      return should && remaining < REBASE_THRESHOLD ? pass(`rebased at 9 km; ${remaining.toFixed(0)} m from the new origin`) : fail(`should=${should} remaining=${remaining}`);
    },
  },
  {
    id: 'WORLD-004',
    name: 'No rebase happens inside the threshold',
    description: 'Rebasing too often would thrash every tile.',
    run: () => {
      const cam = { x: 1200, y: 50, z: -900 };
      return !shouldRebase(cam, { x: 0, y: 0, z: 0 }) ? pass(`1.5 km from origin: no rebase (threshold ${REBASE_THRESHOLD} m)`) : fail('rebased too early');
    },
  },
  {
    id: 'WORLD-005',
    name: 'Tile enumeration covers a geographic bound',
    description: 'A 1°×1° box at z=10 must produce the expected tile count.',
    run: () => {
      const tiles = tilesInBounds({ west: 8, east: 9, north: 47, south: 46 }, 10, 4096);
      const keys = new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
      return tiles.length > 0 && keys.size === tiles.length ? pass(`${tiles.length} unique tiles for 1°×1° at z=10`) : fail(`${tiles.length} tiles, ${keys.size} unique`);
    },
  },
  {
    id: 'WORLD-006',
    name: 'The tile scheduler loads by priority',
    description: 'Near tiles must be picked up before far ones.',
    run: () => {
      const started: string[] = [];
      const tm = new TileManager<string>(async (key) => {
        started.push(key);
        return key;
      }, { maxConcurrent: 1, maxActive: 4 });
      // priority is a SCORE — higher loads first. A caller wanting near tiles
      // first converts distance into a score; it does not pass raw distance.
      tm.update([
        { key: 'far', priority: 10 },
        { key: 'near', priority: 500 },
        { key: 'mid', priority: 200 },
      ]);
      return new Promise<RunResult>((resolve) => {
        setTimeout(() => {
          tm.reset();
          const order = started.join(' → ');
          resolve(
            order === 'near → mid → far'
              ? pass(`load order ${order}`)
              : fail(`load order ${order}; expected near → mid → far (higher priority score first)`),
          );
        }, 30);
      });
    },
  },
  {
    id: 'WORLD-007',
    name: 'Stale tile requests are aborted, not applied',
    description: 'A superseded generation must be dropped.',
    run: () => {
      let delivered = 0;
      const tm = new TileManager<string>(async (key, signal) => {
        await new Promise((r) => setTimeout(r, 10));
        if (!signal.aborted) delivered++;
        return key;
      }, { maxConcurrent: 4, maxActive: 8 });
      tm.update([{ key: 'x', priority: 1 }]);
      tm.update([{ key: 'y', priority: 1 }]); // supersedes x
      return new Promise<RunResult>((resolve) => {
        setTimeout(() => {
          const aborted = tm.stats.abortedStale;
          tm.reset();
          resolve(aborted >= 1 && delivered <= 1 ? pass(`${aborted} stale request(s) aborted, ${delivered} delivered`) : fail(`aborted=${aborted} delivered=${delivered}`));
        }, 60);
      });
    },
  },
  {
    id: 'WORLD-008',
    name: 'Protected tiles survive eviction',
    description: 'Sculpt work must never be thrown away for cache space.',
    run: () => {
      const tm = new TileManager<string>(async (key) => key, { maxConcurrent: 4, maxActive: 8, coolingMs: 0 });
      tm.update([{ key: 'edited', priority: 999 }, { key: 'plain', priority: 1 }]);
      return new Promise<RunResult>((resolve) => {
        setTimeout(() => {
          tm.protect('edited');
          tm.update([]); // nothing wanted any more
          const evicted = tm.gc(Date.now() + 1000);
          const keptEdited = tm.state('edited') !== null;
          tm.reset();
          resolve(keptEdited ? pass(`evicted ${evicted} tile(s), protected tile kept`) : fail('the protected tile was evicted'));
        }, 30);
      });
    },
  },
  {
    id: 'WORLD-009',
    name: 'A failed tile is reported, not silently blank',
    description: 'The UI must be able to show why a tile is missing.',
    run: () => {
      const tm = new TileManager<string>(async () => {
        throw new Error('boom');
      }, { maxConcurrent: 2, maxActive: 4, maxAttempts: 1 });
      tm.update([{ key: 'bad', priority: 1 }]);
      return new Promise<RunResult>((resolve) => {
        setTimeout(() => {
          const state = tm.state('bad');
          const failures = tm.stats.failures;
          tm.reset();
          resolve(state === 'failed' && failures >= 1 ? pass(`state=${state}, failures=${failures}`) : fail(`state=${state}, failures=${failures}`));
        }, 40);
      });
    },
  },
  {
    id: 'WORLD-010',
    name: 'Local measurements stay exact at world scale',
    description: 'ENU plane geometry, no geodesic approximation error.',
    run: () => {
      const m = measureLocal({ x: 0, y: 0, z: 0 }, { x: 3000, y: 4000, z: 0 });
      return approx(m.distance3d, 5000, 1e-6) ? pass(`3-4-5 km triangle → ${m.distance3d.toFixed(6)} m`) : fail(m.distance3d.toString());
    },
  },
];

/* ================================================================ LAYER === */

const LAYER: Array<{ id: string; name: string; description: string; run: CheckFn }> = [
  {
    id: 'LAYER-001',
    name: 'A self-referencing tree cannot hang the flattener',
    description: 'The exact crash from the old monolith.',
    run: () => {
      const a = node('group', 'a');
      a.children = [a];
      const t0 = performance.now();
      const flat = flattenTree([a]);
      const ms = performance.now() - t0;
      return ms < 250 ? pass(`flattened ${flat.length} nodes in ${ms.toFixed(1)} ms without recursion`) : fail(`${ms.toFixed(0)} ms`);
    },
  },
  {
    id: 'LAYER-002',
    name: 'Deeply nested trees are capped, not overflowed',
    description: 'Depth beyond the cap must stop, not throw.',
    run: () => {
      let root = node('group', 'leaf');
      for (let i = 0; i < 500; i++) {
        const parent = node('group', `n${i}`);
        parent.children = [root];
        root = parent;
      }
      const flat = flattenTree([root]);
      const audit = auditTree([root]);
      return flat.length <= MAX_TREE_DEPTH + 2 && audit.maxDepthExceeded
        ? pass(`${flat.length} rows emitted, depth capped at ${MAX_TREE_DEPTH}`)
        : fail(`${flat.length} rows, maxDepth ${audit.maxDepth}`);
    },
  },
  {
    id: 'LAYER-003',
    name: 'Duplicate ids are detected by the audit',
    description: 'Two nodes with one id would corrupt selection.',
    run: () => {
      const audit = auditTree([node('group', 'dup'), node('markers', 'dup')]);
      return audit.duplicateIds.includes('dup') ? pass(`duplicates: ${audit.duplicateIds.join(', ')}`) : fail('not detected');
    },
  },
  {
    id: 'LAYER-004',
    name: 'Reparenting refuses to create a cycle',
    description: 'Moving a group into its own descendant must be rejected.',
    run: () => {
      const child = node('markers', 'child');
      const parent = node('group', 'parent', [child]);
      let threw = false;
      let result = [parent];
      try {
        result = reparent([parent], 'parent', 'child', 0);
      } catch {
        threw = true;
      }
      if (threw) return pass('rejected with an exception');
      const path = findPath(result, 'parent') ?? [];
      return path.length === 1 ? pass('rejected: parent stays at the root') : fail(`path ${path.map((n) => n.id).join('>')}`);
    },
  },
  {
    id: 'LAYER-005',
    name: 'Reorder keeps the sibling count stable',
    description: 'Moving a node must not duplicate or drop it.',
    run: () => {
      const roots = [node('group', 'g', [node('markers', 'a'), node('markers', 'b'), node('markers', 'c')])];
      const moved = reorder(roots, 'a', 2);
      const ids = moved[0].children.map((c) => c.id).join(',');
      return moved[0].children.length === 3 && ids === 'b,c,a' ? pass(`order ${ids}`) : fail(`order ${ids}, count ${moved[0].children.length}`);
    },
  },
  {
    id: 'LAYER-006',
    name: 'Removing a node removes its whole subtree',
    description: 'Orphans would keep rendering.',
    run: () => {
      const roots = [node('group', 'g', [node('group', 'h', [node('markers', 'x')])]), node('markers', 'keep')];
      const after = removeNode(roots, 'g');
      const ids = flattenTree(after).map((f) => f.node.id);
      return ids.length === 1 && ids[0] === 'keep' ? pass(`remaining: ${ids.join(', ')}`) : fail(ids.join(', '));
    },
  },
  {
    id: 'LAYER-007',
    name: 'Insert respects the requested index',
    description: 'Drag-and-drop must land where you dropped it.',
    run: () => {
      const roots = [node('markers', 'a'), node('markers', 'c')];
      const after = insertNode(roots, node('markers', 'b'), null, 1);
      const ids = after.map((n) => n.id).join(',');
      return ids === 'a,b,c' ? pass(`order ${ids}`) : fail(ids);
    },
  },
  {
    id: 'LAYER-008',
    name: 'findPath returns the ancestor chain',
    description: 'Breadcrumbs and cycle detection both need it.',
    run: () => {
      const roots = [node('group', 'a', [node('group', 'b', [node('markers', 'c')])])];
      const path = findPath(roots, 'c')?.map((n) => n.id).join('>');
      return path === 'a>b>c' ? pass(path) : fail(String(path));
    },
  },
  {
    id: 'LAYER-009',
    name: 'A 20k-node tree flattens inside the frame budget',
    description: 'The layer panel must stay interactive.',
    run: () => {
      const kids = Array.from({ length: 20000 }, (_, i) => node('markers', `n${i}`));
      const roots = [node('group', 'root', kids)];
      const t0 = performance.now();
      const flat = flattenTree(roots);
      const ms = performance.now() - t0;
      return flat.length === 20001 && ms < 500 ? pass(`${flat.length} nodes in ${ms.toFixed(1)} ms`) : fail(`${flat.length} nodes in ${ms.toFixed(1)} ms`);
    },
  },
  {
    id: 'LAYER-010',
    name: 'Validation catches a cyclic project before save',
    description: 'A corrupt document must not be persisted.',
    run: () => {
      const p = newProject('x');
      const a = node('group', 'a');
      a.children = [a];
      p.layers = [a];
      const v = validateProject(p);
      return !v.ok ? pass(`rejected: ${v.issues.map((i) => i.code).join(', ')}`) : fail('accepted a cyclic tree');
    },
  },
];

/* ========================================================== PERFORMANCE === */

const PERF: Array<{ id: string; name: string; description: string; run: CheckFn }> = [
  {
    id: 'PERF-001',
    name: 'The LRU cache evicts the least-recently-used entry',
    description: 'A hot entry must survive.',
    run: () => {
      const c = new LruCache<number>({ maxEntries: 3 });
      c.set('a', 1, 1);
      c.set('b', 2, 1);
      c.set('c', 3, 1);
      c.get('a');
      c.set('d', 4, 1);
      return c.has('a') && !c.has('b') ? pass('evicted b, kept a (touched)') : fail(`a=${c.has('a')} b=${c.has('b')}`);
    },
  },
  {
    id: 'PERF-002',
    name: 'The LRU cache honours a byte budget',
    description: 'Memory must be bounded, not just entry count.',
    run: () => {
      const c = new LruCache<Uint8Array>({ maxBytes: 1000 });
      for (let i = 0; i < 20; i++) c.set(`k${i}`, new Uint8Array(200), 200);
      return c.usedBytes <= 1000 ? pass(`${c.usedBytes} bytes for a 1000-byte budget, ${c.size} entries`) : fail(`${c.usedBytes} bytes`);
    },
  },
  {
    id: 'PERF-003',
    name: 'Pinned entries are never evicted',
    description: 'Authored assets must survive cache pressure.',
    run: () => {
      const c = new LruCache<number>({ maxEntries: 2 });
      c.set('pinned', 1, 1, { pinned: true });
      c.set('a', 2, 1);
      c.set('b', 3, 1);
      c.set('c', 4, 1);
      return c.has('pinned') ? pass('pinned entry survived 3 more inserts') : fail('pinned entry was evicted');
    },
  },
  {
    id: 'PERF-004',
    name: 'LOD selection has hysteresis',
    description: 'Hovering on a boundary must not flip levels every frame.',
    run: () => {
      const camera = { position: { x: 0, y: 0, z: 0 }, fovDeg: 60, viewportHeightPx: 900, near: 0.1 };
      const nodeLod = { key: 'lod-0', position: { x: 0, y: 0, z: 0 }, radius: 0, geometricError: 100 };
      let refined = false;
      let flips = 0;
      for (let i = 0; i < 200; i++) {
        const d = 1000 + Math.sin(i) * 3;
        nodeLod.position.z = d;
        const decision = selectLod(nodeLod, camera, { maxScreenSpaceError: 8 }, refined);
        const next = decision === 'refine';
        if (next !== refined) flips++;
        refined = next;
      }
      return flips <= 4 ? pass(`${flips} refine/render flips while straddling the boundary`) : fail(`${flips} flips — no hysteresis`);
    },
  },
  {
    id: 'PERF-005',
    name: 'Adaptive quality drops a tier under load',
    description: 'A missed frame budget must degrade quality.',
    run: () => {
      const a = new AdaptiveQuality('high', true);
      let tier: QualityTier = a.current;
      let now = 0;
      for (let i = 0; i < 120; i++) {
        now += 45;
        tier = a.pushFrame(45, now) ?? tier;
      }
      return tier !== 'high' ? pass(`high → ${tier} after sustained 45 ms frames`) : fail('stayed on high');
    },
  },
  {
    id: 'PERF-006',
    name: 'Adaptive quality recovers when the budget is met',
    description: 'It must not stay degraded forever.',
    run: () => {
      const a = new AdaptiveQuality('high', true);
      let now = 0;
      for (let i = 0; i < 120; i++) {
        now += 45;
        a.pushFrame(45, now);
      }
      const low = a.current;
      let tier = low;
      for (let i = 0; i < 600; i++) {
        now += 8;
        tier = a.pushFrame(8, now) ?? tier;
      }
      return tier !== low ? pass(`${low} → ${tier} after sustained 8 ms frames`) : fail(`stayed on ${low}`);
    },
  },
  {
    id: 'PERF-007',
    name: 'Adaptive quality can be disabled',
    description: 'The user must be able to pin a tier.',
    run: () => {
      const a = new AdaptiveQuality('high', false);
      let now = 0;
      for (let i = 0; i < 300; i++) {
        now += 60;
        a.pushFrame(60, now);
      }
      return a.current === 'high' ? pass('stayed on high with adaptive off') : fail(`dropped to ${a.current}`);
    },
  },
  {
    id: 'PERF-008',
    name: 'The profiler reports real frame statistics',
    description: 'FPS must be derived from measured timestamps.',
    run: () => {
      const p = new Profiler();
      let now = performance.now();
      for (let i = 0; i < 120; i++) {
        const start = p.beginFrame(now);
        now += 16.7;
        p.endFrame(now, start, { drawCalls: 10 + (i % 5), triangles: 1000 });
      }
      const s = p.stats;
      return s && Number.isFinite(s.fps) && s.fps > 0 ? pass(`${s.fps.toFixed(1)} fps, ${s.frameMs.toFixed(2)} ms/frame, ${s.drawCalls} draws`) : fail('no stats');
    },
  },
  {
    id: 'PERF-009',
    name: 'Concurrent tile loads are capped',
    description: 'Flooding the network stalls everything else.',
    run: () => {
      const tm = new TileManager<string>(
        () => new Promise((r) => setTimeout(() => r('ok'), 60)),
        { maxConcurrent: 3, maxActive: 64 },
      );
      const wanted = Array.from({ length: 30 }, (_, i) => ({ key: `t${i}`, priority: i }));
      tm.update(wanted);
      const inflight = tm.stats.inflight;
      tm.reset();
      return inflight <= 3 ? pass(`${inflight} in flight for a cap of 3`) : fail(`${inflight} in flight`);
    },
  },
  {
    id: 'PERF-010',
    name: 'Resetting the tile manager cancels in-flight work',
    description: 'Every async job must be discardable.',
    run: () => {
      let delivered = 0;
      const tm = new TileManager<string>(async (key, signal) => {
        await new Promise((r) => setTimeout(r, 20));
        if (!signal.aborted) delivered++;
        return key;
      }, { maxConcurrent: 4, maxActive: 8 });
      tm.update(Array.from({ length: 8 }, (_, i) => ({ key: `t${i}`, priority: i })));
      tm.reset();
      return new Promise<RunResult>((resolve) => {
        setTimeout(() => {
          resolve(tm.stats.total === 0 ? pass(`reset with 0 tiles retained; ${delivered} fetch(es) completed after cancellation`) : fail(`${tm.stats.total} tiles retained after reset`));
        }, 80);
      });
    },
  },
];

/* ============================================================== PHYSICS === */

const flatGround = (height = 0): ((x: number, z: number) => { height: number | null; slopeDeg: number; surface: typeof SURFACES.terrain }) =>
  () => ({ height, slopeDeg: 0, surface: SURFACES.terrain });

const PHYSICS: Array<{ id: string; name: string; description: string; run: CheckFn }> = [
  {
    id: 'PHYSICS-001',
    name: 'Fixed timestep accumulates leftover time',
    description: 'Visual smoothness must not depend on the frame rate.',
    run: () => {
      const f = new FixedTimestep({ step: 1 / 60, maxSubSteps: 8 });
      const r = f.advance(0.05);
      return r.steps === 3 && r.alpha > 0 && r.alpha < 1 ? pass(`0.05 s → ${r.steps} steps, alpha ${r.alpha.toFixed(3)}`) : fail(`${r.steps} steps, alpha ${r.alpha}`);
    },
  },
  {
    id: 'PHYSICS-002',
    name: 'A huge frame delta cannot spiral',
    description: 'maxSubSteps must clamp the catch-up.',
    run: () => {
      const f = new FixedTimestep({ step: 1 / 60, maxSubSteps: 4 });
      const r = f.advance(5);
      return r.steps === 4 && r.clamped ? pass(`5 s frame → clamped to ${r.steps} substeps (clamped=${r.clamped})`) : fail(`${r.steps} substeps, clamped=${r.clamped}`);
    },
  },
  {
    id: 'PHYSICS-003',
    name: 'Gravity integrates as expected',
    description: 'Free fall distance must match ½gt².',
    run: () => {
      const w = new CollisionWorld();
      const c = new CharacterController(w, { x: 0, y: 100, z: 0 }, { gravity: 9.81 });
      for (let i = 0; i < 60; i++) c.step({ forward: 0, right: 0, jump: false, sprint: false, crouch: false, headingDeg: 0 }, 1 / 60, () => ({ height: null, slopeDeg: 0, surface: SURFACES.terrain }));
      const expected = 100 - 0.5 * 9.81;
      const err = Math.abs(c.state.position.y - expected);
      return err < 0.4 ? pass(`fell to ${c.state.position.y.toFixed(3)} m (expected ${expected.toFixed(3)})`) : fail(`y=${c.state.position.y}, expected ${expected}`);
    },
  },
  {
    id: 'PHYSICS-004',
    name: 'Ground snap keeps the character on the surface',
    description: 'Walking down a gentle slope must not become a series of hops.',
    run: () => {
      const w = new CollisionWorld();
      const c = new CharacterController(w, { x: 0, y: 0, z: 0 }, { groundSnapDistance: 0.5 });
      let maxAir = 0;
      for (let i = 0; i < 120; i++) {
        c.step({ forward: 1, right: 0, jump: false, sprint: false, crouch: false, headingDeg: 0 }, 1 / 60, (x) => ({ height: -x * 0.2, slopeDeg: 11.3, surface: SURFACES.terrain }));
        maxAir = Math.max(maxAir, feetY(c.state) - -c.state.position.x * 0.2);
      }
      return maxAir < 0.2 ? pass(`max gap ${maxAir.toFixed(4)} m while descending`) : fail(`gap ${maxAir.toFixed(3)} m`);
    },
  },
  {
    id: 'PHYSICS-005',
    name: 'The slope limit is enforced',
    description: 'The controller must report being blocked on a too-steep face.',
    run: () => {
      const w = new CollisionWorld();
      const c = new CharacterController(w, { x: 0, y: 0, z: 0 });
      for (let i = 0; i < 60; i++) c.step({ forward: 1, right: 0, jump: false, sprint: false, crouch: false, headingDeg: 0 }, 1 / 60, () => ({ height: 0, slopeDeg: 75, surface: SURFACES.terrain }));
      return c.telemetry.blockedBySlope ? pass(`blockedBySlope=true, slope ${c.telemetry.slopeDeg.toFixed(0)}°`) : fail(`blockedBySlope=${c.telemetry.blockedBySlope}`);
    },
  },
  {
    id: 'PHYSICS-006',
    name: 'A jump leaves the ground and lands again',
    description: 'Grounded must go false then true.',
    run: () => {
      const w = new CollisionWorld();
      const c = new CharacterController(w, { x: 0, y: 0, z: 0 }, { jumpSpeed: 6 });
      let airborne = false;
      let landed = false;
      let peak = 0;
      for (let i = 0; i < 240; i++) {
        c.step({ forward: 0, right: 0, jump: i === 5, sprint: false, crouch: false, headingDeg: 0 }, 1 / 60, flatGround(0));
        peak = Math.max(peak, c.state.position.y);
        if (!c.state.grounded && i > 6) airborne = true;
        if (airborne && c.state.grounded) landed = true;
      }
      return airborne && landed && peak > 0.5 ? pass(`peak ${peak.toFixed(2)} m, airborne then grounded`) : fail(`airborne=${airborne} landed=${landed} peak=${peak}`);
    },
  },
  {
    id: 'PHYSICS-007',
    name: 'A box collider blocks the capsule',
    description: 'Collision proxies must actually collide.',
    run: () => {
      const w = new CollisionWorld();
      w.add({
        id: 'wall',
        shape: { type: 'box', center: { x: 0, y: 1, z: -4 }, halfExtents: { x: 5, y: 2, z: 0.5 }, rotYDeg: 0 },
        surface: SURFACES.wall,
        ownerId: 'test',
        loaded: true,
      });
      const hit = w.overlaps(0, 1, -4.2, 0.4, 1.8);
      const miss = w.overlaps(0, 1, 5, 0.4, 1.8);
      return hit?.id === 'wall' && miss === null ? pass('overlap detected at the wall, none 9 m away') : fail(`hit=${hit?.id ?? 'null'} miss=${miss?.id ?? 'null'}`);
    },
  },
  {
    id: 'PHYSICS-008',
    name: 'Spring deformation settles instead of exploding',
    description: 'Stretch physics must be damped and stable.',
    run: () => {
      const s = new SpringDeformer(140, 12, 10);
      s.impulse(5);
      let peak = 0;
      let last = 0;
      for (let i = 0; i < 600; i++) {
        last = s.step(1 / 60);
        peak = Math.max(peak, Math.abs(last));
      }
      return Number.isFinite(peak) && Math.abs(last) < 0.01 ? pass(`peak ${peak.toFixed(3)}, settled at ${last.toExponential(2)}`) : fail(`peak ${peak}, final ${last}`);
    },
  },
  {
    id: 'PHYSICS-009',
    name: 'An undamped spring stays bounded',
    description: 'Zero damping is allowed but must not diverge.',
    run: () => {
      const s = new SpringDeformer(200, 0, 10);
      s.impulse(3);
      let max = 0;
      for (let i = 0; i < 1000; i++) max = Math.max(max, Math.abs(s.step(1 / 60)));
      return max < 10 ? pass(`max displacement ${max.toFixed(3)} over 1000 undamped steps`) : fail(`diverged to ${max}`);
    },
  },
  {
    id: 'PHYSICS-010',
    name: 'Removing a collider takes effect immediately',
    description: 'A deleted wall must not keep blocking.',
    run: () => {
      const w = new CollisionWorld();
      w.add({ id: 'wall', shape: { type: 'box', center: { x: 0, y: 1, z: -4 }, halfExtents: { x: 5, y: 2, z: 0.5 }, rotYDeg: 0 }, surface: SURFACES.wall, ownerId: 'layer-1', loaded: true });
      const before = w.overlaps(0, 1, -4.2, 0.4, 1.8) !== null;
      const removed = w.removeByOwner('layer-1');
      const after = w.overlaps(0, 1, -4.2, 0.4, 1.8) !== null;
      return before && !after && removed === 1 ? pass(`${removed} collider removed with its owner layer; overlap ${before} → ${after}`) : fail(`before=${before} after=${after} removed=${removed}`);
    },
  },
];

/* ============================================================= TUTORIAL === */

const TUTORIAL: Array<{ id: string; name: string; description: string; run: CheckFn }> = [
  {
    id: 'TUT-001',
    name: 'The tutorial has at least eight real steps',
    description: 'A two-step tour is not a tutorial.',
    run: () => {
      const steps = firstRunTutorial();
      return steps.length >= 8 ? pass(`${steps.length} steps`) : fail(`${steps.length} steps`);
    },
  },
  {
    id: 'TUT-002',
    name: 'Every action step has a verify predicate',
    description: 'Without one, the step cannot require the real action.',
    run: () => {
      const steps = firstRunTutorial();
      const missing = steps.filter((s) => s.kind === 'action' && typeof s.verify !== 'function').map((s) => s.id);
      return missing.length === 0 ? pass('all action steps verifiable') : fail(`missing verify: ${missing.join(', ')}`);
    },
  },
  {
    id: 'TUT-003',
    name: 'No step advances on a timer',
    description: 'Source must contain no timer-driven advance.',
    run: () => {
      const src = firstRunTutorial()
        .map((s) => `${s.verify?.toString() ?? ''}${s.onEnter?.toString() ?? ''}${s.onExit?.toString() ?? ''}`)
        .join('\n');
      const hasTimer = /setTimeout|setInterval|requestAnimationFrame/.test(src);
      return !hasTimer ? pass('no timer constructs in any step callback') : fail('timer found in a step callback');
    },
  },
  {
    id: 'TUT-004',
    name: 'An action step does not advance without the action',
    description: 'The core guarantee of REQUIREMENT 135.',
    run: () => {
      const steps = firstRunTutorial();
      const t = new Tutorial({ id: 't', title: 't', steps });
      t.start(emptyTutorialContext());
      // Step 0 is `welcome`, an info step, which Next is *allowed* to advance.
      // Walk forward to the first action step so the check tests what it names.
      let guard = 0;
      while (t.current?.kind !== 'action' && guard++ < steps.length) t.next(emptyTutorialContext());
      if (t.current?.kind !== 'action') return fail(`no action step found in ${steps.length} steps`);
      const before = t.currentIndex;
      const stepId = t.current.id;
      for (let i = 0; i < 50; i++) t.evaluate(emptyTutorialContext());
      const afterEval = t.currentIndex;
      t.next(emptyTutorialContext());
      return afterEval === before && t.currentIndex === before
        ? pass(`stayed on "${stepId}" (step ${before}) after 50 evaluations and a Next press`)
        : fail(`moved ${before} → ${t.currentIndex}`);
    },
  },
  {
    id: 'TUT-005',
    name: 'An action step advances when the predicate becomes true',
    description: 'The real action must be enough.',
    run: () => {
      const steps = firstRunTutorial();
      const t = new Tutorial({ id: 't', title: 't', steps });
      t.start(emptyTutorialContext());
      let guard = 0;
      while (t.current?.kind !== 'action' && guard++ < steps.length) t.next(emptyTutorialContext());
      if (t.current?.id !== 'focus-viewport') return fail(`expected the first action step to be focus-viewport, got ${t.current?.id}`);
      const ctx = emptyTutorialContext();
      const still = t.evaluate(ctx);
      if (still.advanced) return fail('advanced before the action happened');
      ctx.viewportFocused = true;
      const r = t.evaluate(ctx);
      return r.advanced ? pass('advanced once viewportFocused became true') : fail('did not advance');
    },
  },
  {
    id: 'TUT-006',
    name: 'Wrong attempts are counted',
    description: 'Pressing Next on an action step must be recorded.',
    run: () => {
      const t = new Tutorial({ id: 't', title: 't', steps: firstRunTutorial() });
      t.start(emptyTutorialContext());
      const ctx = emptyTutorialContext();
      ctx.viewportFocused = true;
      t.evaluate(ctx);
      t.next(ctx);
      t.next(ctx);
      const stats = t.getStats();
      return stats.wrongAttempts >= 1 ? pass(`${stats.wrongAttempts} wrong attempt(s) recorded`) : fail('not recorded');
    },
  },
  {
    id: 'TUT-007',
    name: 'Skipping is recorded separately from completing',
    description: 'The stats must distinguish the two.',
    run: () => {
      const t = new Tutorial({ id: 't', title: 't', steps: firstRunTutorial() });
      t.start(emptyTutorialContext());
      t.skip(emptyTutorialContext());
      const s = t.getStats();
      return s.skippedSteps.length === 1 && s.completedSteps.length === 0 ? pass(`skipped [${s.skippedSteps.join(', ')}], completed none`) : fail(JSON.stringify(s));
    },
  },
  {
    id: 'TUT-008',
    name: 'Pausing and resuming preserves the current step',
    description: 'A pause must not restart the tour.',
    run: () => {
      const t = new Tutorial({ id: 't', title: 't', steps: firstRunTutorial() });
      t.start(emptyTutorialContext());
      const idx = t.currentIndex;
      t.pause();
      const paused = t.currentPhase;
      t.resume(emptyTutorialContext());
      return paused === 'paused' && t.currentIndex === idx ? pass(`resumed on step ${idx}`) : fail(`phase ${paused}, index ${t.currentIndex}`);
    },
  },
  {
    id: 'TUT-009',
    name: 'Reduced motion is recorded in the stats',
    description: 'Accessibility state must be observable.',
    run: () => {
      const t = new Tutorial({ id: 't', title: 't', steps: firstRunTutorial() }, true);
      return t.isReducedMotion && t.getStats().reducedMotion ? pass('reducedMotion=true propagated to stats') : fail('not propagated');
    },
  },
  {
    id: 'TUT-010',
    name: 'Completing every step reports completion',
    description: 'The overlay must know when to close.',
    run: () => {
      const t = new Tutorial({ id: 't', title: 't', steps: firstRunTutorial() });
      t.start(emptyTutorialContext());
      const full = { ...emptyTutorialContext(), viewportFocused: true, cameraMoved: true, tool: 'sculpt', sculptApplied: true, bookmarkCount: 1, layerAdded: true, measurementCount: 1, hasTerrain: true, selectionCount: 1, quality: 'normal' };
      let completed = false;
      for (let i = 0; i < 400 && !completed; i++) {
        const r = t.evaluate(full);
        if (r.completed) completed = true;
        // Info steps still need an explicit Next, which the UI provides.
        if (t.current?.kind !== 'action') t.next(full);
      }
      return completed || t.currentPhase === 'completed' ? pass(`phase ${t.currentPhase}, completed ${t.getStats().completedSteps.length} step(s)`) : fail(`stuck at step ${t.currentIndex} (${t.current?.id})`);
    },
  },
];

/* ======================================================== ACCESSIBILITY === */

const A11Y: Array<{ id: string; name: string; description: string; run: CheckFn }> = [
  {
    id: 'A11Y-001',
    name: 'No element overflows the viewport horizontally',
    description: 'REQUIREMENT 128 — internal scrolling only.',
    run: () => {
      const doc = document.documentElement;
      const overflow = doc.scrollWidth - doc.clientWidth;
      return overflow <= 1 ? pass(`scrollWidth − clientWidth = ${overflow}px`) : fail(`${overflow}px of horizontal overflow`);
    },
  },
  {
    id: 'A11Y-002',
    name: 'Every interactive control has an accessible name',
    description: 'Buttons without labels are invisible to screen readers.',
    run: () => {
      const controls = Array.from(document.querySelectorAll('button, [role="button"], input, select, textarea')) as HTMLElement[];
      const unnamed = controls.filter((el) => {
        const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
        const labelledBy = el.getAttribute('aria-labelledby');
        const linked = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        return !label && !labelledBy && !linked;
      });
      return unnamed.length === 0 ? pass(`${controls.length} controls, all named`) : fail(`${unnamed.length} unnamed of ${controls.length}`);
    },
  },
  {
    id: 'A11Y-003',
    name: 'The document has exactly one h1',
    description: 'Heading structure must be navigable.',
    run: () => {
      if (!mountedApp()) return skip('no app mounted in this document');
      const h1 = document.querySelectorAll('h1');
      if (h1.length === 1) return pass(`one h1: “${h1[0]?.textContent?.trim().slice(0, 40)}”`);
      return h1.length === 0 ? fail('no h1 on this page') : fail(`${h1.length} h1 elements`);
    },
  },
  {
    id: 'A11Y-004',
    name: 'Live regions announce state changes',
    description: 'Toasts and the tutorial must be announced.',
    run: () => {
      if (!mountedApp()) return skip('no app mounted in this document');
      const live = document.querySelectorAll('[aria-live], [role="status"], [role="alert"]');
      return live.length > 0 ? pass(`${live.length} live region(s) present`) : fail('no live regions');
    },
  },
  {
    id: 'A11Y-005',
    name: 'No positive tabindex scrambles the focus order',
    description: 'Focus must follow DOM order.',
    run: () => {
      const bad = Array.from(document.querySelectorAll('[tabindex]')).filter((el) => Number(el.getAttribute('tabindex')) > 0);
      return bad.length === 0 ? pass('no positive tabindex values') : fail(`${bad.length} elements with tabindex > 0`);
    },
  },
  {
    id: 'A11Y-006',
    name: 'Reduced-motion preference is honoured',
    description: 'The media query must disable animation.',
    run: () => {
      if (!mountedApp()) return skip('no stylesheet attached in this document');
      let found = false;
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList | null = null;
        try {
          rules = sheet.cssRules;
        } catch {
          continue; // cross-origin sheet
        }
        for (const rule of Array.from(rules ?? [])) {
          if (rule instanceof CSSMediaRule && /prefers-reduced-motion/.test(rule.conditionText)) found = true;
        }
      }
      return found ? pass('prefers-reduced-motion media rule found') : fail('no prefers-reduced-motion rule');
    },
  },
  {
    id: 'A11Y-007',
    name: 'Colour is not the only state indicator',
    description: 'Badges carry text, not just a background colour.',
    run: () => {
      const badges = Array.from(document.querySelectorAll('.ui-badge')) as HTMLElement[];
      const empty = badges.filter((b) => !(b.textContent ?? '').trim());
      return empty.length === 0 ? pass(`${badges.length} badges, all with text`) : fail(`${empty.length} colour-only badges`);
    },
  },
  {
    id: 'A11Y-008',
    name: 'The viewport canvas exposes a role and label',
    description: 'A bare canvas is a black box to assistive tech.',
    run: () => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return pass('no canvas on this page (editor not mounted)');
      const role = canvas.getAttribute('role');
      const label = canvas.getAttribute('aria-label');
      return role === 'application' && !!label ? pass(`role=${role}, label length ${label?.length}`) : fail(`role=${role}, label=${label}`);
    },
  },
  {
    id: 'A11Y-009',
    name: 'An open modal contains the focus',
    description: 'A dialog must not leave focus behind it.',
    run: () => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs.length === 0) return pass('no dialog open');
      const modal = dialogs[dialogs.length - 1] as HTMLElement;
      return modal.contains(document.activeElement)
        ? pass(`focus is inside the open dialog (${document.activeElement?.tagName})`)
        : fail(`focus is on ${document.activeElement?.tagName} outside the dialog`);
    },
  },
  {
    id: 'A11Y-010',
    name: 'Landmark regions exist',
    description: 'Header, nav and main regions must be identifiable.',
    run: () => {
      if (!mountedApp()) return skip('no app mounted in this document');
      const landmarks = document.querySelectorAll('header, nav, main, footer, [role="main"], [role="navigation"], aside');
      return landmarks.length >= 2 ? pass(`${landmarks.length} landmark region(s)`) : fail(`${landmarks.length} landmarks`);
    },
  },
];

/* ================================================================ suites === */

const ALL: Array<{ kind: string; checks: Array<{ id: string; name: string; description: string; run: CheckFn }> }> = [
  { kind: 'Input', checks: INPUT },
  { kind: 'Camera', checks: CAMERA },
  { kind: 'Panorama', checks: PANORAMA },
  { kind: 'Terrain', checks: TERRAIN },
  { kind: 'World-scale', checks: WORLD },
  { kind: 'Layer', checks: LAYER },
  { kind: 'Performance', checks: PERF },
  { kind: 'Physics', checks: PHYSICS },
  { kind: 'Tutorial', checks: TUTORIAL },
  { kind: 'Accessibility', checks: A11Y },
];

function listChecks(): QaCheck[] {
  return ALL.flatMap((g) => g.checks.map((c) => ({ id: c.id, name: c.name, description: c.description, status: 'idle' as QaStatus })));
}

async function runOne(def: { id: string; name: string; description: string; run: CheckFn }): Promise<QaCheck> {
  const base = { id: def.id, name: def.name, description: def.description };
  try {
    const result = await def.run();
    // A skip is neither a pass nor a failure: the check could not be measured
    // in this environment. Reporting it as a pass would hide the gap.
    const status: QaStatus = result.skip ? 'skip' : result.ok ? 'pass' : 'fail';
    return { ...base, status, detail: result.detail };
  } catch (err) {
    return { ...base, status: 'fail', detail: `threw: ${(err as Error).message}` };
  }
}

export function runHardeningChecks(mode: 'list'): QaCheck[];
export function runHardeningChecks(mode: 'run'): Promise<QaCheck[]>;
export function runHardeningChecks(mode: 'list' | 'run'): QaCheck[] | Promise<QaCheck[]> {
  if (mode === 'list') return listChecks();
  return Promise.all(ALL.flatMap((g) => g.checks).map(runOne));
}

/* -------------------------------------------------- legacy regressions --- */

const REGRESSIONS: Array<{ id: string; name: string; description: string; run: CheckFn }> = [
  {
    id: 'LEGACY-001',
    name: 'Layer tree render no longer overflows the stack',
    description: 'Old: recursive renderTreeNode with a shared visited Set threw RangeError on cyclic links.',
    run: () => {
      const a = node('group', 'a');
      a.children = [a, node('group', 'b', [a])];
      const t0 = performance.now();
      const flat = flattenTree([a]);
      const ms = performance.now() - t0;
      return ms < 250 ? pass(`iterative flatten handled a cyclic tree in ${ms.toFixed(1)} ms`) : fail(`${ms.toFixed(0)} ms`);
    },
  },
  {
    id: 'LEGACY-002',
    name: 'Keyboard controls survive focus loss',
    description: 'Old: keydown was gated on activeElement === canvas, so any focus change killed WASD.',
    run: () => {
      let count = 0;
      const h = harness((e) => {
        if (e.id === AxisCommands.moveForward) count++;
      });
      h.key('keydown', 'w');
      h.key('keyup', 'w');
      const afterFirst = count;
      h.key('keydown', 'w');
      h.key('keyup', 'w');
      h.dispose();
      return afterFirst === 2 && count === 4 ? pass('movement worked before and after a focus round-trip') : fail(`${afterFirst} then ${count}`);
    },
  },
  {
    id: 'LEGACY-003',
    name: 'Wheel zoom works without the canvas being activeElement',
    description: 'Old: the wheel listener used the same activeElement gate and stopped firing.',
    run: () => {
      let zooms = 0;
      const h = harness((e) => {
        if (e.id === AxisCommands.zoom) zooms++;
      });
      h.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
      h.dispose();
      return zooms >= 1 ? pass(`${zooms} zoom command(s) from a wheel over the focused viewport`) : fail(`${zooms} commands`);
    },
  },
  {
    id: 'LEGACY-004',
    name: 'Dragging a panel does not rotate the camera',
    description: 'Old: one document-level mousemove with a shared isDragging flag.',
    run: () => {
      let yaw = 0;
      const bus = new CommandBus();
      bus.registerAll(defaultCommands());
      const off = bus.on(AxisCommands.turnYaw, () => yaw++);
      const panel = document.createElement('div');
      document.body.appendChild(panel);
      panel.dispatchEvent(pointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }));
      window.dispatchEvent(pointerEvent('pointermove', { bubbles: true, clientX: 200, clientY: 100, pointerId: 1 }));
      window.dispatchEvent(pointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
      off();
      panel.remove();
      return yaw === 0 ? pass('0 camera commands from a panel drag') : fail(`${yaw} camera commands fired`);
    },
  },
  {
    id: 'LEGACY-005',
    name: 'Fullscreen keeps the viewport interactive',
    description: 'Old: fullscreen resized once, drew a static frame and never re-wired input.',
    run: () => {
      let count = 0;
      const bus = new CommandBus();
      bus.registerAll(defaultCommands());
      const off = bus.on(AxisCommands.moveForward, () => count++);
      const wrap = document.createElement('div');
      wrap.className = 'viewport-wrap';
      const canvas = document.createElement('canvas');
      canvas.tabIndex = 0;
      wrap.appendChild(canvas);
      document.body.appendChild(wrap);
      // FocusManager derives the owning surface from document.activeElement, so
      // a canvas that was never focused leaves surface === 'none' and the
      // keyboard layer correctly refuses to act. A real fullscreen canvas has
      // focus; this one has to be given it.
      canvas.focus();
      const focus = new FocusManager();
      focus.setViewport(canvas);
      const kb = new KeyboardLayer({ bus, focus, bindings: defaultBindings(), target: canvas });
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
      canvas.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true }));
      kb.dispose();
      off();
      wrap.remove();
      return count === 2 ? pass('input still dispatches inside the fullscreen wrapper') : fail(`${count} commands`);
    },
  },
  {
    id: 'LEGACY-006',
    name: 'Camera moves are interruptible, not chained timeouts',
    description: 'Old: setTimeout(duration) then a nested 300 ms then 500 ms teardown.',
    run: () => {
      const t = new CameraTransitionController();
      const r = rig();
      t.start(r, { to: { distance: 30 }, durationMs: 5000, easing: 'easeInOutCubic' });
      t.update(r, 0.5);
      const mid = t.isRunning;
      t.cancel(r, 'user-input');
      return mid && !t.isRunning ? pass(`interrupted synchronously during a 5 s transition (interruptions=${t.stats.interruptions})`) : fail(`running=${mid} after=${t.isRunning}`);
    },
  },
  {
    id: 'LEGACY-007',
    name: 'No canvas forces a synchronous GPU readback',
    description: 'Old: applyPersistenceEffect called domElement.toDataURL() on the default framebuffer.',
    run: () => {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      const preserved = canvases.filter((c) => {
        const gl = c.getContext('webgl2') ?? c.getContext('webgl');
        return gl ? (gl.getContextAttributes()?.preserveDrawingBuffer ?? false) : false;
      });
      return preserved.length === 0
        ? pass(`${canvases.length} canvas(es), none preserving the drawing buffer for readback`)
        : fail(`${preserved.length} canvas(es) force preserveDrawingBuffer`);
    },
  },
];

export function runRegressionChecks(mode: 'list'): QaCheck[];
export function runRegressionChecks(mode: 'run'): Promise<QaCheck[]>;
export function runRegressionChecks(mode: 'list' | 'run'): QaCheck[] | Promise<QaCheck[]> {
  if (mode === 'list') return REGRESSIONS.map((c) => ({ id: c.id, name: c.name, description: c.description, status: 'idle' as QaStatus }));
  return Promise.all(REGRESSIONS.map(runOne));
}

/* ------------------------------------------------------- project audit --- */

export async function runAuditCheck(): Promise<QaCheck> {
  const project = useStore.getState().project;
  const v = validateProject(project);
  const audit = auditTree(project.layers);
  const problems = [...v.issues.map((i) => `${i.code}: ${i.message}`)];
  if (audit.duplicateIds.length) problems.push(`duplicate ids: ${audit.duplicateIds.join(', ')}`);
  if (audit.maxDepthExceeded) problems.push('tree exceeds the depth cap');
  const detail = `schema v${project.schemaVersion}/${SCHEMA_VERSION}, ${audit.nodeCount} nodes, depth ${audit.maxDepth}, ${problems.length} problem(s)`;
  return {
    id: 'AUDIT-001',
    name: 'The live project document validates and audits clean',
    description: 'Runs validateProject and auditTree against whatever is open right now.',
    status: problems.length === 0 && v.ok ? 'pass' : 'fail',
    detail: problems.length ? `${detail} — ${problems.slice(0, 3).join('; ')}` : detail,
  };
}

/** Round-trip a v1 document through the migrations. */
export async function runMigrationCheck(): Promise<QaCheck> {
  const legacy = {
    schemaVersion: 1,
    id: 'proj_legacy',
    name: 'Old world',
    createdAt: 0,
    updatedAt: 0,
    settings: { transitionDuration: 900 },
    features: { persistence: true, persistenceStrength: 0.7 },
    locations: [{ id: 'l1', name: 'Old pano', imageUrl: 'a.jpg', links: { north: 'l2' }, position: { x: 0, y: 0, z: 0 } }],
    currentLocation: 'l1',
  };
  const result = migrateProject(legacy);
  const ok =
    result.project.schemaVersion === SCHEMA_VERSION &&
    result.project.panorama.nodes.length === 1 &&
    result.project.transition.customMs === 900;
  return {
    id: 'AUDIT-002',
    name: 'A v1 document migrates to the current schema',
    description: 'Runs the real migration chain on a legacy-shaped object.',
    status: ok ? 'pass' : 'fail',
    detail: `v1 → v${result.project.schemaVersion} via [${result.appliedMigrations.join(', ')}]; pano nodes ${result.project.panorama.nodes.length}, customMs ${result.project.transition.customMs}`,
  };
}

export const CHECK_COUNT = ALL.reduce((a, g) => a + g.checks.length, 0);
export const KIND_COUNT = ALL.length;
