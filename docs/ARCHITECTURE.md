# Architecture

3DMapMaker Next is a browser-only application. There is no backend. Everything
below runs in the page, in a worker, or (eventually) in a WASM module compiled
from the native core.

## The three-layer split

```
React tree            owns canonical editor state (zustand store)
   │
   ├── EngineController     owns the scene; reads state, never stores it
   │      ├── @3dmm/scene-core    SceneManager, materials, picking, crossfade, post-fx
   │      ├── @3dmm/terrain       TerrainEngine, meshing, sculpt strokes
   │      └── @3dmm/performance   adaptive quality, LOD, budgets
   │
   └── UI panels              read and dispatch against the same store
```

The rule that keeps this honest: **the React tree owns state, `EngineController`
owns the scene.** The controller is constructed once per viewport and reads from
the store. It does not keep its own copy of editor state, which is why the panels
and the viewport cannot drift apart. The same rule applies to the panorama world
— see [WORLD_GRAPH.md](./WORLD_GRAPH.md).

## Package boundaries

Fourteen packages, each with a single responsibility and no cross-imports into
`apps/web`. Nothing here is a convenience split; each one is a boundary where a
test can assert something meaningful.

| Package | Responsibility |
|---|---|
| `gis` | Projections, ECEF conversion, rebasing, contour extraction, tile maths |
| `project` | Document schema (v6), migrations, validation |
| `layers` | Layer tree, ordering, visibility, hierarchy operations |
| `terrain` | Heightfields, procedural noise, meshing, sculpting, analysis |
| `camera` | Orbit / fly / walk modes, all damped |
| `input` | Command bus, keyboard, wheel, pointer, pointer-lock, focus |
| `panorama` | Grid maths, world graph, movement intent resolution |
| `scene-core` | Panorama sphere, crossfade, persistence, labels, post-fx |
| `world` | World-level state |
| `assets` | Asset registry and provenance |
| `physics` | Character controller, collision, gravity |
| `performance` | LOD selection, tile manager, quality tiers, caches, budgets |
| `tutorial` | Tutorial engine |
| `ui` | Component library, Radix-based |

Vite aliases every one of these straight at its `src/index.ts` rather than
through `node_modules`. That has two consequences that matter: editing a package
hot-reloads without a build step, and modules like `three` never end up with two
instances because of a symlinked duplicate.

## Input: a command bus, not event handlers

`packages/input` is built around a `CommandBus` rather than direct DOM listeners
reaching into engine code. Layers emit commands; handlers subscribe.

```
KeyboardLayer ─┐
WheelLayer    ─┼──▶ CommandBus ──▶ handlers (EngineController, WorldSession, …)
PointerLayer  ─┘         │
                         └──▶ observers (on('*')) — sees every dispatch AND every rejection
```

Three properties are load-bearing:

1. **Focus gates everything.** `FocusManager` derives the owning surface from
   `document.activeElement`. When the viewport does not have focus, commands are
   rejected — so typing `w` in a text field never moves the camera. WASD is never
   bound globally.
2. **Rejections are observable.** `dispatch` has three outcomes — `dispatched`,
   `rejected-focus`, `rejected-no-handler` — and observers see all three. This
   existed because a rejection that vanishes silently makes input bugs nearly
   impossible to diagnose: "0 commands" could mean no event, a focus rejection, or
   no subscriber, and those are three different bugs.
3. **Keys are canonicalised on both sides.** `eventChord` and `chordKey` both
   route through `canonicalKey()`. Without that, every lowercase named-key
   binding (`arrowup`, `pageup`) silently matched nothing, because the DOM spells
   them `ArrowUp`.

## Terrain: off the main thread

`workers/terrain.worker.ts` does the expensive work. Its protocol is four
message types:

| Message | Purpose |
|---|---|
| `build-mesh` | Heightfield → vertex/index buffers |
| `sculpt` | Apply a brush stroke to a heightfield |
| `analysis` | `hillshade` \| `slope` \| `aspect` \| `contours` \| `profile` |
| `cancel` | Abort in-flight work |

The worker replies `ready` on start, so the client never dispatches into a
worker that has not finished initialising. Every job is cancellable — that is a
requirement, not a nicety, because a user scrubbing a brush or a slider will
otherwise queue dozens of jobs that each finish after the user has moved on.

Terrain generation is deterministic: same source and same tile produce identical
heights whether they run on the main thread or in the worker. That determinism is
what makes border stitching between adjacent tiles work.

The measured cost explains why this is a worker at all — meshing a 513² heightfield
takes ~251 ms, and producing one takes ~108 ms. See `npm run bench`.

## The document

`packages/project` defines schema v6 with a migration chain from v1. Two things
about it are worth knowing:

- **Validation is bounded.** A cyclic document does not blow the stack; an
  iterative, bounded pre-pass detects reference cycles and reports
  `Cannot validate: reference cycle at $.layers.0.children.0` with `code: 'cycle'`.
- **Migrations supply defaults.** A genuine v1 document lacks the `world` and
  `terrain` sections that later migrations introduce, so the migrations provide
  `DEFAULT_WORLD_ANCHOR` and `DEFAULT_TERRAIN_STATE` rather than letting the
  final-schema parse fail.

## What is deliberately not here

- **No server, no API key, no telemetry.** The core works with no AI configured
  and no Google APIs.
- **No cube maps.** Panoramas render on an inverted sphere. The reference viewer
  in `google-street-view-clone-main/` uses the same approach.
- **No global keyboard bindings.** See the focus gating above.
- **No page-level horizontal overflow.** Panels scroll internally.
