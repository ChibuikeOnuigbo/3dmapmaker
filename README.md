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
cd 3dmapmaker
python3 -m http.server 8080
# open http://localhost:8080

# DESKTOP — the same app with a worlds database (Linux · Windows · macOS)
node desktop/main.mjs          # or double-click desktop/start.sh | start.command | start.bat
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
6. **Save world file** writes one portable `.pworld` — the whole world, with
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
[docs/WORLD-FILE.md](docs/WORLD-FILE.md).

### The desktop build

`node desktop/main.mjs` serves this same app from disk with a real database
behind it — worlds, their images (content addressed, so duplicates cost
nothing), version history and an activity log. Zero npm dependencies
(`node:http` + `node:fs` + `node:sqlite`), with a plain-file fallback for
older Node versions, and optional Electron installers if you want a packaged
window instead of a browser tab. Full guide, including where your worlds are
kept on each OS: [docs/DESKTOP.md](docs/DESKTOP.md).

The web build stays deliberately database-free: files are the currency there,
the database is the desktop convenience, and both speak the same `.pworld`.

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
js/io/                      .pworld world file, .pmap archive (ZIP),
                            IndexedDB storage, FS Access, desktop bridge
js/ui/                      landing page + the Worlds surface (save card,
                            library, versions, activity)
desktop/                    desktop app: database, API server, launchers, CLI
                            (zero npm dependencies; Electron wrapper optional)
js/worlds/                  four demo worlds (3 procedural + Willow Parish photo demo)
assets/willow/              Willow Parish AI-photographed panoramas (day/rain/night × 7 nodes)
js/viewer/sharpen.js          Sharpen: real unsharp mask clarity pass (menu switch)
tools/                      Python/OpenCV continuity validator + scene synth
tools/tests/                pytest suite (OpenCV validation)
tests/                      Node core tests + static integration smoke
tools-render/               offline renderer used to verify real app panoramas
docs/                       architecture, pipeline, validation, testing, setup,
                            WORLD-FILE.md, DESKTOP.md
legacy/                     the original CampusNav 360 code (preserved, unmodified)
```

## Tests

```bash
node tests/core.test.mjs          # 42 tests: scale, graph, movement, 500 m zone,
                                  # reverse-travel identity, autocomplete, archive
node tests/pworld.test.mjs        # 14 tests: the .pworld file — export → verify →
                                  # import with the pixels coming out of the file,
                                  # offline embedding, damaged files refused
node tests/desktop-api.test.mjs   # 16 tests: the desktop app end to end — real
                                  # server, real database, uploads, de-duplication,
                                  # library columns, versions, export and import
node tests/static-smoke.mjs       # 19 tests: wiring: imports, DOM ids, icons,
                                  # terminology, the worlds surface, the file kinds
node tools-render/boot-harness.mjs # 74 checks: boots the REAL app (fake DOM),
                                  # walks all 4 demo worlds incl. the 1,125-node one,
                                  # saves a world to a .pworld, reopens it offline,
                                  # switches modes and walks inside the file
.venv/bin/python -m pytest tools/tests -q   # 15 tests: OpenCV continuity gate
```

The world file and the worlds database are also driven end to end **in a real
browser** — a world is saved from the running app, the originals are cut off at
the network layer, and the file is opened on a clean machine:

```bash
npm i playwright-core @sparticuz/chromium     # any folder; or use your own Chromium
NODE_PATH=$PWD/node_modules node tools-render/world-e2e.mjs
# writes screenshots to qa/world-file/ and 78 browser checks
```

Spec-by-spec status (map worlds, demo worlds, generation rules, behavior):
[docs/SPEC-COMPLIANCE.md](docs/SPEC-COMPLIANCE.md)

See [docs/TESTING.md](docs/TESTING.md) for the end-to-end verification, which
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
