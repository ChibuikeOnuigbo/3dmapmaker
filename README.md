# Panorama Maps

**Explore connected 360-degree panoramas on a real 2D map.**
Google-Maps-style panorama exploration + a map creation tool, running as a
standalone web app with **zero runtime dependencies and no build step**.

Panorama Maps is a *map-first* platform: the 2D map and the navigation graph
are the core systems; the panorama viewer visualizes the location you're
standing at. Movement, distances and scene changes are **mathematically
derived from the world graph** — never random images.

```
SAME WORLD + REAL DISTANCE + REAL POSITION + REAL GRAPH CONNECTION
+ PERSISTENT LANDMARKS + PREVIOUS IMAGE CONTEXT + IMAGE VALIDATION
= CONTINUOUS PANORAMA EXPERIENCE
```

---

## Quick start

```bash
# any static file server works — no build, no install
cd 3dmapmaker
python3 -m http.server 8080
# open http://localhost:8080
```

Then:

1. On the **start screen**, pick a demo world: *Chapel Lane* (small),
   *Millbrook* (medium), *Great Vale* (1,000+ nodes, large) or
   **Willow Parish** — real AI-photographed street frames in three
   pre-rendered looks (**day / rain / night** switchable from the toolbar's
   mode segment). Later you switch worlds from the brand menu, top-left.
2. **Drag** the panorama to look around. **Mouse wheel** zooms (field of view).
3. **W A S D** (or the on-screen pad / arrow keys) to walk between locations —
   movement is camera-relative and resolves through the navigation graph.
4. Click a node on the **2D map** (bottom-right) to teleport; expand it for a
   large map with pan/zoom and a real metric scale bar.
5. Open the **map editor** (pencil) to add locations, connect them, drop
   landmarks, draw roads, and upload your own panoramas / 2D map image.
6. **Save** exports one portable `.pmap` project file. **Open** imports it
   back — on this or another computer — no account needed.

Full controls are in [docs/SETUP.md](docs/SETUP.md).

---

## The continuity contract

If you face the church and walk 10 m closer, the next panorama shows **the
same church, closer** — with the same road, trees, lighting and landmarks.
Walking back returns the *identical original* scenes (cache = identity).

Every panorama is produced through one pipeline:

```
WorldGraph (truth) → GenerationContextBuilder (full world context)
  → GenerationProvider → validation gate (accept/reject/regenerate)
  → PanoramaCache (identity) → viewer transition → map update
```

* **WorldGraph** — single source of truth: nodes with real `x/y`, edges with
  coordinate-derived distances (diagonals are `√2·d`), king-style 8-direction
  adjacency, zones with real boundaries, persistent landmarks, spatial index.
* **Map scale** — an explicit `pixelsPerMeter` everywhere; a pixel is *never*
  silently one meter. The mandatory **500 m church-zone test** is built into
  Chapel Lane and enforced by unit tests.
* **Providers** — the interface is ready for a server-side AI image API (keys
  must stay server-side; see [docs/GENERATION-PIPELINE.md](docs/GENERATION-PIPELINE.md)).
  Ships with a deterministic **procedural development provider** that renders
  each equirectangular frame *from the world model itself* — guaranteeing
  continuity today while documenting the exact seam for a real AI backend.
* **Validation** — a Python/OpenCV gate (`tools/panorama_validate.py`)
  combines ORB feature matching, geometric consistency, structure, color,
  brightness, perceptual hashing and metadata with a **distance-aware
  threshold**. Unrelated images (the "church → beach" case) are rejected with
  reasons and regenerated. A lightweight JS histogram gate flags bad uploads
  in-app.
* **AutoComplete Panorama** — a real on/off toggle (location card). It detects
  missing top/bottom panorama bands, repairs them by edge-extension + blur +
  feathered seams, and applies **soft-resistance pitch limits** so you never
  look into the void. Turning it off restores the original pixels.

---

## Repository layout

```
index.html                  app shell (zero external deps)
css/app.css                 design system
js/core/                    WorldGraph, MapScale, movement, events
js/viewer/                  WebGL equirect renderer, viewer, AutoComplete
js/gen/                     provider, context builder, LRU cache, utils
js/map/                     2D canvas map renderer
js/editors/                 simple + advanced editors
js/io/                      .pmap archive (ZIP), IndexedDB storage, FS Access API
js/worlds/                  four demo worlds (3 procedural + Willow Parish photo demo)
assets/willow/              Willow Parish AI-photographed panoramas (day/rain/night × 7 nodes)
js/viewer/sharpen.js          Sharpen: real unsharp mask clarity pass (menu switch)
tools/                      Python/OpenCV continuity validator + scene synth
tools/tests/                pytest suite (OpenCV validation)
tests/                      Node core tests + static integration smoke
tools-render/               offline renderer used to verify real app panoramas
docs/                       architecture, pipeline, validation, testing, setup
legacy/                     the original CampusNav 360 code (preserved, unmodified)
```

## Tests

```bash
node tests/core.test.mjs          # 32 tests: scale, graph, movement, 500 m zone,
                                  # reverse-travel identity, autocomplete, archive
node tests/static-smoke.mjs       # wiring: imports, DOM ids, icons, terminology
node tools-render/boot-harness.mjs # 58 checks: boots the REAL app (fake DOM),
                                  # walks all 4 demo worlds incl. the 1,125-node one,
                                  # verifies Willow Parish mode spectra + cache identity
.venv/bin/python -m pytest tools/tests -q   # 15 tests: OpenCV continuity gate
```

Spec-by-spec status (map worlds, demo worlds, generation rules, behavior):
[docs/SPEC-COMPLIANCE.md](docs/SPEC-COMPLIANCE.md)

See [docs/TESTING.md](docs/TESTING.md) for the end-to-end verification, which
renders **real app panoramas** and validates the whole chain with OpenCV.

## Design rules honored

- Not a 3D world builder: mathematics (vectors, yaw/pitch, FOV, equirectangular
  projection) serves *panorama viewing*, the product is a panorama map platform.
- No API keys in client code. No fake buttons: every toggle works.
- Portable `.pmap` project = source of truth; IndexedDB is only a local mirror;
  `localStorage` only holds tiny preferences — never images.
- Static-hosting friendly; offline shell via service worker.
