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
# WEB — any static file server works: no build, no install, no database
# Run this from the repository root so Agent/models is reachable too.
python3 -m http.server 8080
# open http://localhost:8080/panorama/

# DESKTOP — the same app with a worlds database (Linux · Windows · macOS)
node Agent/desktop/main.mjs
# or double-click Agent/desktop/start.sh | start.command | start.bat
```

Then:

1. On the **start screen**, pick a world:
   - *Chapel Lane* (small plaza & church)
   - *Millbrook* (branching valley)
   - *Great Vale* (1,000+ nodes, connected)
   - *Willow Parish* (real photographed street frames with day/rain/night)
   - *The Grand Hotel Suite* (50+ continuous indoor stations, mezzanine stairs, luxury bath)
   - *Neo-Kyoto Skyway* (outdoor futuristic cyberpunk maglev concourse & skyline parapet)
   - *Solaris Orbital Colony* (outdoor futuristic geodesic biodome & planetary ring overlook)
   - *The Obsidian Art Gallery* (indoor modern art rotunda, kinetic helix & mezzanine ramp)
   - *Subterranean Bio-Archive* (indoor deep cryogenic silo, server banks & airlock)
   Later switch worlds anytime from the top-left brand menu.
2. **Drag** the panorama to look around. **Mouse wheel** zooms (field of view).
3. **W A S D** (or the on-screen pad / arrow keys) to walk between locations —
   movement is camera-relative and resolves through the navigation graph.
   Adaptive morph easing preserves walk speed while blending curves dynamically by keypress duration (ms).
4. Click a node on the **2D map** (bottom-right) to teleport; expand it for a
   large map with pan/zoom, compass rose, animated actors, and a real metric scale bar.
5. Open **Neural Vision & Optics** (eye icon in toolbar) to toggle or tune Ray Tracing, 3Dness relief, bilateral denoising, epipolar normal mapping, wide-angle Panini/Fisheye projections, and atmospheric depth illusion.
6. Open the **map editor** (pencil) to add locations, connect them, drop
   landmarks, draw roads, and upload your own panoramas / 2D map image.
7. **Save world file** writes one portable `.pworld` — the whole world, with
   **every image embedded inside the file**. Open it anywhere, online or off.
   The desktop build also keeps worlds in a database (see below).

### The `.pworld` world file

One file that *is* the world: every place, connection, zone, landmark, the map
scale, the environment, the scene modes, where you were standing — and every
panorama, every scene variant, the 2D map image, the previews and the cover,
byte for byte inside the file. Delete the photos from the device that uploaded
them, lose the website, go offline: the world still opens and still walks.

Every world can be saved this way — the demos, worlds you built, worlds you
imported — from the toolbar **Worlds** button, the Panels menu, either map
studio, the scripting studio, or `Ctrl`/`Cmd`+`S`. Format, layout and integrity:
[panorama/docs/WORLD-FILE.md](panorama/docs/WORLD-FILE.md).

### The desktop build

`node Agent/desktop/main.mjs` serves this same app
from disk with a real database behind it — worlds, their images (content addressed,
so duplicates cost nothing), version history and an activity log. Zero npm dependencies
(`node:http` + `node:fs` + `node:sqlite`), with a plain-file fallback for
older Node versions, and optional Electron installers if you want a packaged
window instead of a browser tab. Full guide, including where your worlds are
kept on each OS: [panorama/docs/DESKTOP.md](panorama/docs/DESKTOP.md).

The web build stays deliberately database-free: files are the currency there,
the database is the desktop convenience, and both speak the same `.pworld`.

Full controls are in [panorama/docs/SETUP.md](panorama/docs/SETUP.md).

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
  must stay server-side; see [panorama/docs/GENERATION-PIPELINE.md](panorama/docs/GENERATION-PIPELINE.md)).
  Ships with a deterministic **procedural development provider** that renders
  each equirectangular frame *from the world model itself* — guaranteeing
  continuity today while documenting the exact seam for a real AI backend.
* **Validation** — a Python/OpenCV gate (`Agent/tools/panorama_validate.py`)
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

The repository is organized into three clean operational domains:

```
3dmapmaker/
├── README.md                       This file — the only Markdown document at the root
│
├── panorama/                       Standalone web application, tests & full reference work
│   ├── README.md                   Web build guide + reference archive index
│   ├── index.html                  Standalone web shell (zero external dependencies)
│   ├── css/                        Design system and stylesheet modules
│   ├── js/                         Client app (core, viewer, editors, map, ui, ai)
│   ├── assets/                     Panoramas (hotel suite master, Willow Parish modes)
│   ├── api/                        Static web-build health marker
│   ├── manifest.webmanifest        PWA web manifest
│   ├── sw.js                       Service Worker offline caching shell
│   ├── tests/                      Node test suites (core, pworld, desktop, smoke, vision)
│   ├── tools-render/               Offline renderer, boot harness and browser E2E
│   ├── legacy/                     Original CampusNav 360 code (preserved, unmodified)
│   ├── MEMORY.md                   Master state record & verified specifications
│   ├── GENERATION-LOG.md           Historical generation ledger
│   ├── finx_genmap.md              Camera-shift fill ledger & standing protocol
│   └── docs/                       Architecture, desktop, world file, testing, setup
│
└── Agent/                          AI models, data stores & desktop runtime
    ├── README.md                   Subsystem documentation & every data store explained
    ├── models/                     ONNX model + runtime JSON weights (canonical data)
    ├── desktop/                    Desktop server, SQLite/JSON database, launchers, CLI
    ├── tools-model/                PyTorch neural training & ONNX export pipeline
    └── tools/                      OpenCV physical-invariant validation suite
```

### Where new work goes (standing rule)

| What you are adding | Where it belongs |
|---|---|
| Pages, styles, viewer/editor logic, maps, demo worlds | `panorama/js/`, `panorama/css/`, `panorama/assets/` |
| Tests, render harnesses, QA captures | `panorama/tests/`, `panorama/tools-render/` |
| Architecture notes, specifications, ledgers | `panorama/docs/`, `panorama/MEMORY.md` |
| ONNX models, weights, training/export scripts | `Agent/models/`, `Agent/tools-model/` |
| Desktop server, database, CLI, launchers | `Agent/desktop/` |
| OpenCV validation tools and fixtures | `Agent/tools/` |
| Top-level orientation | `README.md` (the only Markdown file at the root) |

Generation datasets and volatile caches stay out of Git (`.pworld` files,
`node_modules`, `dist-desktop`, `tools-render/.browser` are ignored). Every
data store in `Agent/` is explained in [`Agent/README.md`](Agent/README.md);
the web build and full reference work are indexed in
[`panorama/README.md`](panorama/README.md).

## Neural Vision & Optics Model

A deep multi-task ONNX model (`Agent/models/panorama_vision_model.onnx`, opset 17) and WebGL shader pipeline executing 7 optical heads in real time:
- **Ray Tracing**: Screen-space ambient occlusion (deepens in floor/wall contact) and surface specular bounce reflection.
- **Subtle 3Dness**: Gentle depth relief and stereoscopic parallax disparity bounded strictly under $\le 0.05$ m.
- **Real-Time Denoise & Enhance**: Edge-preserving bilateral filtering kernel paired with unsharp clarity sharpening.
- **Wide-Angle Optics & FOV**: Standard Rectilinear, Panini cylindrical projection, and Fisheye/barrel distortion correction, with real-time FOV slider control ($50^\circ$ to $100^\circ$).
- **View Illusion**: Distance-aware atmospheric aerial perspective and depth haze.
- **Epipolar & Normal Mapping**: Epipolar tensor calculations and micro-surface normal perturbations.
- **Adaptive Velocity-Conserving Morph**: Blends cubic ease-out, cubic Hermite, and cubic ease-in curves dynamically by the millisecond duration of user button/key presses — **strictly conserving walking speed and stride duration**.
- **Granular Settings UI**: Interactive popup (`#visionPop`) allowing individual toggling and fine parameter tuning for every optical feature.

## Tests

```bash
node panorama/tests/core.test.mjs          # 53 tests: scale, graph, movement, 500 m zone,
                                  # reverse-travel identity, autocomplete, demo worlds
node panorama/tests/pworld.test.mjs        # 15 tests: the .pworld file — export → verify →
                                  # import with the pixels coming out of the file,
                                  # offline embedding, damaged files refused
node panorama/tests/desktop-api.test.mjs   # 18 tests: the desktop app end to end — real
                                  # server, real database, uploads, de-duplication,
                                  # library columns, versions, export and import, CLI
node panorama/tests/static-smoke.mjs       # 21 tests: wiring: imports, DOM ids, icons,
                                  # terminology, the worlds surface, the file kinds
node panorama/tests/vision-model.test.mjs  # 9 tests: ONNX model, 7 neural heads, velocity
                                  # conservation, physical ray tracing, subtle 3Dness
node panorama/tools-render/boot-harness.mjs # 102 checks: boots the REAL app (fake DOM),
                                  # walks all demo worlds incl. The Grand Hotel Suite,
                                  # Neo-Kyoto, Solaris Colony, Obsidian Gallery, Sub-Archive,
                                  # saves a world to a .pworld, reopens it offline
.venv/bin/python -m pytest Agent/tools/tests -q   # 15 tests: OpenCV continuity gate
```

The world file and the worlds database are also driven end to end **in a real
browser** — a world is saved from the running app, the originals are cut off at
the network layer, and the file is opened on a clean machine:

```bash
npm i playwright-core @sparticuz/chromium     # any folder; or use your own Chromium
NODE_PATH=$PWD/node_modules node panorama/tools-render/world-e2e.mjs
# writes screenshots to panorama/qa/world-file/ and 78 browser checks
```

Spec-by-spec status (map worlds, demo worlds, generation rules, behavior):
[panorama/docs/SPEC-COMPLIANCE.md](panorama/docs/SPEC-COMPLIANCE.md)

See [panorama/docs/TESTING.md](panorama/docs/TESTING.md) for the end-to-end verification, which
renders **real app panoramas** and validates the whole chain with OpenCV.

## Design rules honored

- Not a 3D world builder: mathematics (vectors, yaw/pitch, FOV, equirectangular
  projection) serves *panorama viewing*, the product is a panorama map platform.
- No API keys in client code. No fake buttons: every toggle works.
- Portable `.pworld` world file = source of truth (all data, images embedded);
  IndexedDB is only a local mirror; the desktop database is a convenience copy;
  `localStorage` only holds tiny preferences — never images.
- The web build has no database and no server, by design; every world can still
  be saved and opened, because the file carries everything.
- Static-hosting friendly; offline shell via service worker.
