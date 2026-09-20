# 3DMapMaker Next

A browser-based, authored 3D map and world builder. It replaces the legacy
single-file app (the 183 KB `index.html` at the repository root) with a real
monorepo: typed packages, a worker-backed terrain pipeline, a graph-driven
connected panorama world, and a build you can ship.

Everything here runs client-side. There is no backend, no server-side rendering,
and no API key required for any part of the core — including the parts of the
system designed to talk to an AI.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

Then open one of:

| Route | What it is |
|---|---|
| `#/` | Landing page |
| `#/editor` | The workbench — terrain, layers, scene, lighting, physics, annotations |
| `#/worlds` | The connected AI panorama world (the 2D map + 360° viewer) |
| `#/tutorial` | Guided tutorial |
| `#/qa` | The hardening/regression check harness, run live in the browser |

The editor needs WebGL. In a headless environment it renders a visible,
actionable error state rather than a blank canvas — that is deliberate, and it is
covered by a test.

---

## Verifying it

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript across all 14 packages |
| `npm test` | Unit + component suite (vitest, 447 tests / 21 files) |
| `npm run qa` | 109 checks — 100 hardening + 7 legacy regressions + audit + migration; **109 pass, 0 skip** |
| `npm run bench` | Times the compute-heavy paths against the real modules |
| `npm run audit:licenses` | SPDX audit of every installed dependency |
| `npm run build` | Production bundle |
| `python3 timer.py` | Wall-clock harness that runs all of the above and records exit codes |
| `npm run check` | typecheck + test |

`npm run rust:build` and `npm run rust:test` exist and report honestly; see
[Native core](#native-core) for why they currently exit non-zero.

---

## Layout

```
apps/web/                  the application: routes, panels, engine controller, worlds
packages/
  gis/                     projections, ECEF, contour extraction, tile maths
  project/                 document schema (v6), migrations, validation
  layers/                  layer tree, visibility, ordering
  terrain/                 heightfields, procedural noise, meshing, sculpting
  camera/                  orbit / fly / walk modes, damped
  input/                   command bus, keyboard, pointer, focus management
  panorama/                grid maths, world graph, intent resolution
  scene-core/              panorama sphere, spatial transition warp, persistence modes
  world/                   world-level state
  assets/                  asset registry and provenance
  physics/                 character controller, collision, gravity
  performance/             LOD selection, tile manager, budgets, caches
  tutorial/                tutorial engine
  ui/                      the component library (Radix-based)
workers/                   terrain.worker.ts — generation and meshing off-main
crates/terrain-core/       Rust port of packages/terrain (written, never compiled)
scripts/                   run-qa.mjs, run-bench.mjs, audit-licenses.mjs, build-rust.mjs
research/references.json   120 cited sources behind the technical decisions
DEVELOPMENT_LOG.md         what was built, what broke, and what is still missing
```

`apps/web/vite.config.ts` is the authoritative Vite configuration; the root
`vite.config.ts` re-exports it. Workspace packages are aliased straight at their
`src`, so editing `packages/*` hot-reloads without a build step and three.js
never ends up duplicated as two module instances.

---

## The connected panorama world

This is the piece the project is organised around. `#/worlds` is **not** a
gallery of 360° photos you flip through. It is a graph.

- **One source of truth.** `WorldGraph` holds every node. The 2D map and the
  360° viewer both read it; neither keeps its own copy of position or state.
- **Adjacency comes from coordinates, never from ids.** `index = y*width + x`,
  `id = index + 1`. A node's neighbours are computed from its grid position, so
  no numbering quirk can ever imply a connection that is not physically there.
- **King movement is the maximum, not the minimum.** `|dx| <= 1 && |dy| <= 1`
  with both not zero. Roads, walls and rivers then *remove* edges from that
  maximum, so what you can actually traverse is the graph — and it is verified
  against the board before you are allowed to move.
- **A real graphical map.** The 2D view is SVG: roads, paths, nodes, edges,
  current position, destination, visited versus unvisited, landmarks, and the
  recommended route. Click to select, double-click to warp, click the
  destination to see the route. It is not ASCII and never was.
- **Camera-relative movement.** `W` resolves through the camera yaw into a world
  direction, quantises to the nearest of eight directions, and then looks up a
  graph edge. WASD never translates the camera through the panorama texture.
- **Grid distance is not geographic distance.** `metersPerGridUnit` is stored
  explicitly; a diagonal step is √2 × scale. Routing uses Chebyshev distance
  (`h = max(|dx|, |dy|)`), never Euclidean.
- **Randomness is quarantined.** Gaussian noise is used only for camera bob and
  micro yaw/pitch drift. It never influences node selection, coordinates,
  geometry or path correctness.

Three boards ship: 8×8 (63 reachable nodes), 20×20 (363), 32×32 (903). Counts
fall short of the nominal 64/400/1024 because blocked cells are removed from the
graph, and a test asserts occupancy matches `graph.size` exactly.

Panorama imagery is twelve locally generated equirectangular plates. No Street
View scraping: geographic reference only, and every node carries provenance and
licence metadata.

---

## AI features, and their absence

The AI layer produces **validated structured actions only** — never code, never
raw edits. Every candidate node passes a continuity gate (plate known, geometry
on-grid and in-bounds, lighting envelope plausible, seams consistent with
accepted neighbours, land use plausible, provenance present) before it enters the
world.

The core works with no AI configured and no Google API key. Keys are never
hardcoded and never logged. Generation is a frontier queue walking outward from
where the player can already stand, so a world stopped part-way is still coherent
around the reachable region.

---

## Native core

`crates/terrain-core` is a Rust port of `packages/terrain` — the PRNG, simplex
noise, fBm, the heightfield with its bilinear sampling and slope/aspect/curvature
derivatives, and a hand-written wasm ABI with zero dependencies.

**Current status: written, never compiled.** This sandbox has no Rust toolchain
(`scripts/build-rust.mjs` searches PATH, `~/.cargo/bin`, `~/.rusttoolchain`, and
`CARGO_HOME`/`RUST_TOOLCHAIN` before giving up) and no route to acquire one. The
script reports that and exits non-zero rather than simulating a build;
`python3 timer.py` records it as an expected failure so it cannot quietly start
looking like a pass.

What *is* verified is the parity contract, from the TypeScript side.
`packages/terrain/src/rust-parity.test.ts` (12 tests, passing) re-derives every
constant the Rust parity test asserts against, so if the TypeScript changes the
port is named as stale. What is *not* verified is that the Rust produces them.
Three bugs found by reading the crate are recorded in `crates/README.md`.

No part of the browser app depends on the native core.

---

## Known gaps

Recorded here rather than left to be discovered:

- **The browser E2E suite has never been executed.** `e2e/` holds 4 specs and
  `npx playwright test --list` collects **27 tests**, which proves they parse and
  the config is valid. But Playwright's browser binary cannot be downloaded in
  this sandbox, so none of them has run. Everything that *has* run is a vitest
  test under jsdom, and each is labelled as such. No 360° pixel output has been
  visually confirmed anywhere. See `e2e/README.md`.
- **The native core is written but uncompiled**, as above.
- **`docs/` covers architecture, the world graph and development.** The
  exhaustive record — every bug found, every check that turned out to be wrong —
  is in `DEVELOPMENT_LOG.md`.
- Four QA checks (document `h1` count, live regions, `prefers-reduced-motion`,
  landmark regions) report **skipped** rather than passed when run headlessly,
  because nothing is mounted in the document. In a browser they execute for real.

`DEVELOPMENT_LOG.md` is the honest record: what was built, seventeen real bugs
the tests found, seven checks that turned out to be wrong about the engine rather
than the engine being wrong, and the seven root causes behind the legacy app's
failures.
