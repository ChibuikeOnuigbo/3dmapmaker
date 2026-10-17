# Panorama Maps — Standalone Web App & Reference Work (`panorama/`)

Everything needed to run, test, and understand the standalone web application
lives here. The repository root holds only the top-level `README.md`; the AI
models, training pipeline and desktop database live in [`../Agent/`](../Agent/).

---

## Run the web app

The app has **zero runtime dependencies and no build step**.

```bash
# From the repository root (so ../Agent/models is reachable)
python3 -m http.server 8080
# open http://localhost:8080/panorama/
```

Alternatively, serve this folder on its own:

```bash
cd panorama && python3 -m http.server 8080
# open http://localhost:8080
```

Serving `panorama/` alone still runs every world, editor, map and save feature.
The neural weights simply fall back to the engine's analytical defaults if
`../Agent/models/panorama_vision_weights.json` cannot be reached.

## Layout inside this folder

```
index.html                  app shell (zero external deps)
css/                        design system
js/core/                    WorldGraph, MapScale, movement, events
js/viewer/                  WebGL equirect renderer, viewer, AutoComplete
js/ai/                      VisionEngine: neural inference, easing, uniforms
js/gen/                     provider, context builder, LRU cache, utils
js/map/                     2D canvas map renderer
js/editors/                 simple + advanced editors
js/io/                      .pworld world file, .pmap archive (ZIP),
                            IndexedDB storage, FS Access, desktop bridge
js/ui/                      landing page + the Worlds surface
js/worlds/                  demo worlds (Chapel Lane, Millbrook, Great Vale,
                            Willow Parish, The Grand Hotel Suite, Neo-Kyoto,
                            Solaris Colony, Obsidian Gallery, Sub-Archive)
assets/hotel/               The Grand Hotel Suite master panorama
assets/willow/              Willow Parish photographed panoramas (3 scene modes)
tests/                      Node test suites + static smoke + vision model tests
tools-render/               boot harness, offline renderer, browser E2E
legacy/                     original CampusNav 360 code (preserved, unmodified)
```

## Tests

Run from the repository root:

```bash
node panorama/tests/core.test.mjs          # graph, scale, movement, demo worlds
node panorama/tests/pworld.test.mjs        # .pworld export → verify → import
node panorama/tests/desktop-api.test.mjs   # desktop server + database end to end
node panorama/tests/static-smoke.mjs       # wiring, DOM ids, shell, terminology
node panorama/tests/vision-model.test.mjs  # ONNX model, 7 heads, easing
node panorama/tools-render/boot-harness.mjs # boots the real app across all demos
.venv/bin/python -m pytest Agent/tools/tests -q   # OpenCV continuity gate
```

---

## Reference archive

### Project memory & ledgers
- **`MEMORY.md`** — master state record: supported features, verified behavior,
  architectural invariants and roadmap constraints across every build loop.
- **`GENERATION-LOG.md`** — historical generation ledger: batch runs, anchor
  continuity, normalization protocols and image dataset generations.
- **`finx_genmap.md`** — camera-shift fill ledger and standing protocol for
  neighbor interpolation (W/A/S/D coordinate-relative steps, ring completion).

### Technical specifications (`docs/`)
- **`docs/ARCHITECTURE.md`** — system architecture, navigation graph, scale math.
- **`docs/DESKTOP.md`** — desktop runtime, SQLite persistence, content-addressed
  assets, versioning and cross-platform launchers.
- **`docs/WORLD-FILE.md`** — self-contained `.pworld` archive format (ZIP,
  embedded images, manifest schema, sha256 integrity).
- **`docs/GENERATION-PIPELINE.md`** — context builder, provider contracts and
  OpenCV verification pipeline.
- **`docs/VALIDATION.md`** — perceptual hashing, color histograms, ORB
  keypoints and distance-aware thresholds.
- **`docs/SPEC-COMPLIANCE.md`** — specification compliance matrix.
- **`docs/TESTING.md`** — Node, headless browser and OpenCV test harnesses.
- **`docs/SETUP.md`** — setup guide and developer controls.
- **`docs/EXISTING-ARCHITECTURE-REPORT.md`** — baseline codebase audit.
- **`docs/AGENT-DATA-STORE.md`** — every model, database, training and
  validation data store under `../Agent/`, explained component by component.
