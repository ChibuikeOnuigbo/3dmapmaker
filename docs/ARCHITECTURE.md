# Architecture

## Overview

Panorama Maps is a **map-first, graph-driven** panorama platform.
Everything a user sees or edits flows through four systems:

```
┌────────────────────────────────────────────────────────────────────┐
│                          USER INTERFACE                            │
│  viewer3D panel   map panel   status bar   editors   toolbar       │
└───────┬─────────────────┬─────────────────┬───────────┬────────────┘
        │                 │                 │           │
┌───────▼─────────┐ ┌─────▼───────────┐ ┌───▼───────────▼─────────┐
│  PanoramaViewer │ │  MapRenderer    │ │ AstralEditor pair       │
│  (WebGL equirect│ │  2D canvas,     │ │  (world editing)        │
│  crossfade, FOV │ │  pan/zoom,scale │ │                         │
└───────┬─────────┘ └──────────▲──────┘ └───────────┬─────────────┘
        │                      │                    │
┌───────▼──────────────────────┴────────────────────▼─────────────┐
│                        APPLICATION CORE                         │
│  MovementController ──► WorldGraph ◄── editors                  │
│       │                    ▲                                    │
│       │           MapScale (pixelsPerMeter everywhere)          │
│       │                    │                                    │
│  generation pipeline ◄─────┘   storage (.pmap ↔ IndexedDB)      │
└───────┬────────────────────────────┬────────────────────────────┘
        │                            │
┌───────▼──────────────┐    ┌────────▼───────────┐
│ GenerationContext    │    │  PanoramaCache     │
│ Builder → Providers  │    │  (LRU, identity)   │
└──────────────────────┘    └────────────────────┘
```

## Core principles

1. **WorldGraph is the single source of truth** — the viewer renders *the
   world at the current node*, movement traverses *edges*, the 2D map renders
   *the graph*. No module keeps a parallel copy of the world.
2. **Continuity is structural, not hopeful** — providers receive a complete
   `GenerationContext` (current + previous panoramas, destination coordinates,
   path anchors, zone scene, landmarks, summary, forbidden changes). Generation
   is sequential frontier expansion, never "1,000 random images".
3. **Cache is identity** — a node's panorama, once accepted, is immutable.
   Reverse travel re-displays the exact original frame.
4. **Validation is a hard gate** — new generations must pass continuity
   checks or are rejected and regenerated (with the failure reason fed back
   into the context summary). A `forbiddenChange` flag is an instant veto.
5. **No runtime dependencies** — ES modules + Canvas 2D + WebGL only;
   deployable on any static host; offline shell via service worker.

## Modules

### `js/core/world-graph.js`
`WorldGraph`: nodes (`id, x, y, edgeLength, panoramaUrl, heading, zone,
camera.height, incomplete, meta`), adjacency map with 8-direction king-style
neighbor lists, coordinate-derived edge distances (`edgeLength × √2` for
diagonals), `neighborsInDirection(nodeId, v)` for movement, `zones` with
**real boundary math**: e.g. Chapel Lane's church grounds are defined as
`[-250,-250]→[250,250]` meters around the chapel at `(0,20)` — tests assert
(0,520 m) = **500 m** from the chapel is outside (`js/core/scale.js` holds
`pixelsPerMeter`; a step is always scale-derived pixels, never "1 px = 1 m").

Also `SpatialHash` (cell grid for neighbor + bounds queries — efficient for
the 1,000-node demo world) and `ZoneManager` (zone containment, per-zone
scene metadata, landmark registry).

### `js/core/movement.js`
`MovementController` turns keys (camera-relative *V* = forward/`W`, *S* =
backward, *A/D* = strafes, *Q/E* = diagonals) into validated node transitions:
candidates = the direction's forward edge, or side edges whose bearing is
within 67.5° of the desired heading; among them the nearest-distance node
wins; going backward prefers the exact previous location (identity).
Bulldozed/blocked edges are respected; failures emit a gentle on-screen
"no path" hint — **movement never places the camera in open void**.

### `js/viewer/pano-renderer.js`
WebGL equirectangular renderer, approximately 220 lines, no library:
triangulated lat-long sphere with MPV `yaw/pitch/FOV/aspect` matrices and a
single `equirect` fragment sampler. Owns `PresentationState` (current +
previous equirect textures, crossfade α, frame hook) and the graded
**perf tier system** (HIGH → BALANCED → LOW → MINIMAL doubles internal
resolution, enables mip-mapping, caps pixel ratio, and at LOW drops the
simulation to software rendering hints; auto-adapts to measured FPS).

### `js/viewer/viewer.js`
`PanoramaViewer`: state machine; `navigate(nodeId, mode)` with
instant/preview modes; `_ensurePanorama()` orchestrates context build →
provider → JS continuity gate → cache write; the **AutoComplete Panorama**
pipeline (`completion.js`) receives raw pixel data *before* entering the
cache so the repaired version IS the identity, with undo to restore the
original. Crossfades between textures place "panorama transitions" at the
viewer; the location card exposes the AC state + missing-band percentages.

### `js/gen/util.js, context.js, provider.js, cache.js`
* `util` — Seeded RNG (mulberry32), `phash16` (16×16 perceptual hash),
  RGB histogram + cosine similarity (`jsUploadSimilarity` gate for uploads).
* `context` — `GenerationContextBuilder` assembles the **exact generation
  context array** required by the spec: current panorama, previous panoramas
  of the route, position meters, path anchors, world metadata, zone scene,
  landmarks, chain position, sequential-consistency summary, forbidden-change
  flags (e.g. `headingFlip`, `seasonChange`), previous-failure feedback.
* `provider` — `GenerationProvider` interface plus:
  * `RemoteGenerationProvider` — documented, fully structured backend client
    (`POST /api/generate` with the context as JSON multipart); clear status
    `offline` when no API is configured (no faked success).
  * `ProceduralWorldProvider` — deterministic in-browser renderer that draws
    each equirect from the world model (zones, landmarks, roads, trees, sky,
    sun, lane-view synthesis from neighbors). Dev fallback, but a *truthful*
    one: same-graph world ⇒ same landforms.
* `cache` — `PanoramaCache` LRU by count, decode-aware; paired with the
  validator report cache in `js/storage`.

### `js/map/map-renderer.js`
Preserves the original canvas renderer design (theme, hit-testing, drag pan,
node expand/full-zoom logic, scale bar) while speaking `WorldGraph`. Draws
 corridors, footprint, nodes with entrance ring highlighting (ACTIVE = where
you stand), travel direction arrows, grid, minimap. `map-renderer.js` is the
same file used by the expanded fullscreen map.

### `js/editors/`
`simple-editor.js` — click-to-add nodes, name → map re-render. Advanced
(`advanced-editor.js`) — full inspector: rename, coordinates (m, always
converted through `MapScale`), edges with distance preview, zone tools,
landmark dropping, autoComplete override, per-node panorama upload with the
**JS upload guardrail** (histogram distance warning), world `pixelsPerMeter`
and theme. All edits go through `WorldGraph` semantics (no direct mutation).

### `js/io/zipex.js, storage.js`
`.pmap` = one portable file: `project.json` (versioned schema, manifest with
hashes, scale, zones, landmarks) + `assets/pano_<id>.<ext>`. Custom pure-JS
ZIP reader/writer (store method, CRC-32) — no dependency. Import/export are
atomic; exports come from the IndexedDB mirror (with in-memory fallbacks),
import replaces the working store in one transaction. **Blob URLs only** —
never base64 in localStorage; `localStorage` holds only small prefs and the
"last world" pointer.

## Data flow — one navigation click

```
key W → MovementController.step(forward)
      → WorldGraph.neighborsInDirection(cur, V)
      → best candidate node N
      → EventBus: preview → MapRenderer highlight + viewer.navigate(N)
      → _ensurePanorama(N):
          cache hit? → instant original texture            (identity)
          miss? → context = GenerationContextBuilder(cur, N)
                 → provider.generate(ctx)                  (frontier step)
                 → js continuity gate (histogram)          (guardrail)
                 → if AC on & N.incomplete: completion     (repair once)
                 → cache.set(N)                            (identity sealed)
      → WebGL crossfade 450 ms; map + status update
```

## Performance tiers & offline

`PerfTier` (HIGH/BALANCED/LOW) changes pixelRatio, WebGL anisotropy, preload
radius and map grid density; auto adapts using a rolling FPS window.
Service worker (`sw.js`) precaches the shell; panoramas are runtime-cached
with a bounded count. Everything works fully offline for demo worlds.

## Terminology

The UI and docs speak the required vocabulary: **panorama, 360-degree view,
2D map, map editor, navigation graph, location node, camera perspective,
field of view, viewing height, image continuity, spatial coordinates, map
scale, panorama transition, environment simulation**.
