# Development

## Setup

```bash
npm install
npm run dev          # http://localhost:5173
```

Node 22 is what this was developed and verified on. There is no build step for
development — Vite aliases every `@3dmm/*` package straight at its
`src/index.ts`, so editing `packages/*` hot-reloads.

`apps/web/vite.config.ts` is the **authoritative** Vite config. The repo-root
`vite.config.ts` re-exports it. The config has to live in `apps/web` because
`npm run dev -w @3dmm/web` runs Vite with `apps/web` as the working directory and
Vite only auto-discovers a config there.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server, bound to `0.0.0.0:5173` |
| `npm run build` | Production bundle to `apps/web/dist` |
| `npm run preview` | Serve the built bundle |
| `npm run typecheck` | `tsc --noEmit` across all packages |
| `npm test` | vitest, single run |
| `npm run test:watch` | vitest, watch |
| `npm run qa` | 109-check hardening/regression harness |
| `npm run bench` | Compute-path benchmark |
| `npm run audit:licenses` | SPDX dependency audit |
| `npm run check` | typecheck + test |
| `python3 timer.py` | Run everything and record wall-clock + exit codes |
| `npm run rust:build` | Native core (reports honestly; see below) |

## Running the checks

The suite has three tiers and they answer different questions.

**`npm test` — 447 tests across 21 files.** Unit and component tests under jsdom.
Every one is labelled as a jsdom test. This is the tier that catches logic bugs.

**`npm run qa` — 109 checks.** 100 hardening checks (10 kinds × 10), 7 legacy
regressions, plus the audit and migration checks. These drive the *same registry*
the in-browser `#/qa` page uses, so a check added to the page is automatically
checked in CI.

Current state: **109 pass, 0 skip, 0 fail.**

Four of these checks — `h1` count, live regions, `prefers-reduced-motion`,
landmark regions — inspect the live document. They are written to return
**skipped** rather than passed or failed when the document is empty, because
"could not be measured here" is neither. The headless runner now mounts the real
`<App />` and injects the shipped `workbench.css` before the run, so all four
measure something real and the skip count is zero.

That change is worth noting because it found a genuine bug rather than just
clearing a skip. With the app mounted, A11Y-004 *failed*: the landing route had no
live region in the document. The check's assumption was too coarse — the app does
have live regions in `Toasts`, `TutorialOverlay`, `WorldView` and `DraftBar`, they
just do not render on `#/`. But the failure pointed at a real gap: hash routing
swaps the whole page with no announcement, so a screen-reader user following a nav
link got no feedback. `App.tsx` now carries a shell-level `aria-live` region naming
the route on change. The check passes because the app was fixed, not because the
check was relaxed.

**`npm run bench` — measured timings.** 15 repetitions per measurement, median
reported, first call discarded as warm-up. Nothing is estimated.

```bash
node scripts/run-qa.mjs --list        # print the 100-check inventory
node scripts/run-qa.mjs --json        # machine-readable
node scripts/run-bench.mjs --json     # machine-readable
node scripts/run-bench.mjs --reps 25  # more repetitions
python3 timer.py --only qa,test       # subset
```

## Writing a test

vitest's `include` covers **only** `packages/*/src/**` and `apps/web/src/**`. A
test file placed anywhere else — including under `scripts/` — will not run, and
vitest will not warn you about it. Keep generated test files inside one of those
trees.

jsdom is missing several APIs. `ResizeObserver` and
`HTMLCanvasElement.getContext('2d')` are shimmed globally in `vitest.setup.ts`.
`URL.createObjectURL` / `revokeObjectURL` are stubbed locally in the tests that
need them. **`PointerEvent` is undefined in jsdom** — use the `pointerEvent()`
helper in `apps/web/src/qa/checks.ts`, which falls back to a `MouseEvent` carrying
the pointer fields.

WebGL is `null` under jsdom. The editor correctly renders `.viewport-error` in
that case, and there is a test for it.

## Writing a QA check

Checks live in `apps/web/src/qa/checks.ts`. Each is an object with `id`, `name`,
`description` and `run`. Return `pass(detail)`, `fail(detail)` or `skip(reason)`.

Two things worth knowing before you add one:

**Verify the check's own assumptions against the source first.** Seven checks
turned out to be wrong about the engine rather than the engine being wrong. A
check that fails is a hypothesis, not a verdict. The full list is in
`DEVELOPMENT_LOG.md` §6.11.

**If a check needs the app mounted, guard it.** Use `mountedApp()`. A check that
reads `document` directly and finds nothing should skip, not fail — and certainly
not pass.

The registry API is deliberately narrow: `runHardeningChecks('list' | 'run')`,
`runRegressionChecks(…)`, `runAuditCheck()`, `runMigrationCheck()`, `CHECK_COUNT`,
`KIND_COUNT`. The `ALL` array is module-private. Use those functions; do not
reach into the array.

## Adding a package

1. Create `packages/<name>/src/index.ts` and `packages/<name>/package.json`.
2. Add the alias to `workspaceAliases` in `apps/web/vite.config.ts`.
3. If the package is imported by `workers/terrain.worker.ts`, also add it to the
   `worker-alias` plugin in the same file — workers do **not** inherit
   `resolve.alias`.

Missing step 3 is silent at build time and fails at runtime in the worker only.

## Conventions that are easy to get wrong

These have each cost real debugging time.

- **The projection matrix is row-major everywhere.** Do not "fix" it to
  column-major.
- **`CharacterState.position` is the EYE, not the feet.** Feet are
  `position.y - eyeHeight` (default 1.65 m). Use `feetY(state)` from
  `@3dmm/physics`.
- **`Direction` is the full word form**: `'north' | 'northEast' | …`, never `'N'`.
- **gis `Vec3` uses `z` for elevation**, not `y`.
- **Preload priority: higher runs first.**
- **Grid walker rows run northward**: `z = -row * spacing`.
- **`WORLD_SPECS` is a `Record`, not an array.** It has no `.map`.
- `Segmented` requires a `label`. `ErrorBanner` has no `title`. `IconButton` needs
  `label` + `children`. `Badge` has no `'accent'` — use `'info'`.
- `-0` and `+0` fail `toBe` / `toEqual`.

## Rust

```bash
npm run rust:build      # host + wasm32-unknown-unknown
npm run rust:test       # also cargo test
```

`scripts/build-rust.mjs` searches PATH, `~/.cargo/bin`, `~/.rusttoolchain`, and
`CARGO_HOME` / `RUST_TOOLCHAIN` before concluding there is no toolchain. It never
reports a build it did not observe.

**Current status: not built.** This sandbox has no Rust toolchain and `crates/`
has not been populated. The script reports both facts and exits non-zero.
`python3 timer.py` records this as an *expected* failure, so it cannot quietly
start reading as a pass.

Nothing in the browser app depends on the native core.

## What is not verified

- **No browser E2E exists and none was run.** Playwright's browser binary cannot
  be downloaded here. Every test is a jsdom test.
- **No 360° pixel output has been visually confirmed.** The sphere geometry,
  crossfade and persistence maths are unit-tested; the rendered result has not
  been looked at in a real browser.
- **The native core is absent**, as above.

`DEVELOPMENT_LOG.md` §3 records this in full. It is the honest record of the
project: what was built, seventeen real bugs the tests found, the seven checks
that were wrong about the engine, and the seven root causes behind the legacy
app's failures.
