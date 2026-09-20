# Testing report

Every acceptance criterion of the brief maps to an executable test or a
recorded end-to-end run in this document. Status: **all green** as of
2026-09-20.

## 1. Node core suite — `tests/core.test.mjs` (29 tests)

```
node tests/core.test.mjs     → 29/29 PASS
```

Covers, among others:

- **Map scale** — `pixelsPerMeter` applied everywhere; 200 px @ 5 px/m ⇒ 40 m;
  scale conversions round-trip; custom world scales respected (never 1 px = 1 m).
- **Zone boundary with real distance** — the mandatory scenario: Chapel Lane
  church grounds `[-250,-250]…[250,250]` m ⇒ a point **500 m from the church is
  outside**, 249 m inside, 251 m outside (off-by-one-sensitive).
- **Navigation graph** — 8-direction king adjacency; diagonal edges report
  `edgeLength·√2`; `neighborsInDirection` resolves bearings.
- **Movement** — step W/A/S/D/Q/E camera-relative; blocked edges deny and
  report; consecutive steps accumulate correct meter distances; scale bar math.
- **Reverse traversal** — entering `A→B→C` and stepping back twice returns the
  **exact same node IDs and the same panorama object identity** (cache check),
  not a re-generation.
- **AutoComplete** — detectors find a rendered incomplete band, repair fills it,
  `meta.autoComplete` flips true, undo restores original pixels, soft pitch
  clamp keeps the void invisible while ON and restores full pitch when OFF.
- **Archive (.pmap)** — ZIP writer/reader round-trip, CRC-32 integrity,
  manifest hashes, import/export atomicity vs. IndexedDB mirror, blob-URL only
  asset loading (no base64 anywhere in storage; localStorage stays < 8 KB).
- **Priority queue / LRU** — cache evicts least-recently-used *and* keeps the
  current node pinned; decode workload bounded.

## 2. Static integration smoke — `tests/static-smoke.mjs` (8 checks)

```
node tests/static-smoke.mjs  → 8/8 PASS
```

- every import in every `js/**` module resolves (17 modules, full graph)
- every `document.getElementById` referenced in JS exists in `index.html` (40 ids)
- service worker shell file list matches real files
- all `icon("…")` usages exist in the icon sprite
- banned terminology absent from UI files ("mesh", "terrain build", …)
- CSS braces balanced / no unclosed template literals

## 3. OpenCV validator suite — `tools/tests/test_validator.py` (15 tests)

```
.venv/bin/python -m pytest tools/tests -q   → 15/15 PASS (~1.2 s)
```

Fixtures come from `tools/scene_synth.py` — a second, independent synthetic
world renderer (church + trees + road + separate `unrelated_scene`) used so the
validator is proven against imagery it has never seen in development:

| # | scenario | result |
|---|---|---|
| 1 | church street chain 0→100 m, 10 m steps | **PASS** every pair |
| 2 | reverse direction symmetry | same node identities pass back |
| 3 | yaw rotation continuity | pass with relaxed geometry |
| 4 | unrelated beach at next node | **FAIL** with reasons |
| 5 | black frame | **FAIL** (integrity veto) |
| 6 | blank uniform frame | **FAIL** (integrity veto) |
| 7 | 500 m same-zone jump | pass gate even when visuals differ a lot |
| 8 | > 0 m at 20 m, distance-aware floor | threshold relaxed correctly |
| 9 | custom `--weights` respected | weighted score changes as configured |
| 10 | forbiddenChange flag | **instant FAIL**, confidence 0.99 |
| 11 | probability fields present | matches spec §64 output |
| 12 | decide()-style loop across a chain | passes |
| 13 | serialization round-trip | JSON shape stable |
| 14 | same-image sanity | score ≈ 1.0 |
| 15 | generic score range | stays within [0, 1.0] |

## 4. End-to-end verification with **real app panoramas**

The crucial proof: panoramas rendered by the **actual application pipeline**
(the same `ProceduralWorldProvider` the browser uses) — not stand-ins.

`tools-render/` is a pure-JS software Canvas2D implementation plus a render
script (`render-panoramas.mjs`) that boots the real `js/worlds/demo-worlds.js`
+ `js/gen/provider.js` under Node and saves panoramas as images.

```
node tools-render/render-panoramas.mjs        # 12 frames → /tmp/panorender
```

**Real street chain (Chapel Lane, 20 m → 120 m, 10 m steps, same zone):**

```
node … && python tools/panorama_validate.py --sequence … --step-m 10 --zone-same
→ CHAIN VERDICT: PASS
  020→030 0.817   030→040 0.903   040→050 0.939   050→060 0.940
  060→070 0.895   070→080 0.902   080→090 0.921   090→100 0.863
  100→110 0.803   110→120 0.842        (threshold 0.777 each)
```

**Rejection check** — inject `scene_synth.unrelated_scene()` after `way_050m`:

```
→ FAIL, score 0.291
  - scene features lost (match score 0.12) — likely an unrelated image
  - no geometric consistency with previous panorama
  - color palette changed beyond movement expectation
```

**Visual verification** (frames rendered at 1280×640): the church grows
realistically from a distance cue at 20 m; trees/houses/sun keep positions;
`plaza_2_5` correctly shows its intentional missing top band, which the
in-browser AutoComplete repairs.

## 5. Full-app boot harness — `tools-render/boot-harness.mjs` (46 checks)

Boots the **real `js/main.js`** in Node behind a minimal fake DOM + the
pure-JS Canvas2D shim (`canvas2d.mjs`), then exercises the exact browser
runtime path per world:

- app boot, editors constructed, map renderer drawing, service worker skipped
- all three demo worlds adopted via the real `loadDemoWorld` code path
- the visible panorama is generated and **non-blank** (full-frame pixel std)
- camera-relative WASD: harness aims the view at a real neighbor bearing and
  presses W — arrival must equal the *aimed* node (Spec §37)
- reverse walk returns the **original node IDs** (Spec §61)
- Great Vale: 1,125 nodes, generation on demand (the >1,000-node case)

```
node tools-render/boot-harness.mjs   → 46/46 PASS
```

### Bugs found by this harness and fixed (2026-09-20)

1. **Millbrook branch junctions dangled**: road-chain starts merged only
   within 6 px, so Mill Road / Church Ave / the loop produced duplicate nodes
   4–9 m away from Main Street plus a wrong index-based stitch; pressing W at
   that junction picked the wrong street. Fixed: chain *start* merges within
   0.75·spacing and a geometric `autoJunctions` pass (exact distance filter —
   `SpatialHash.queryRadius` is bucket-coarse).
2. **`resolveEdge` tie-break** used `<=`, letting the later edge win an exact
   bearing tie regardless of distance. Now: closest bearing, then shortest hop.
3. **Structure sizing clamp bug**: a 0.35 rad minimum angular size fused every
   distant tree/house into a solid wall at the horizon; sidewalk margin
   2.2 m → 1.2 m; centre-line width 0.14 → 0.07 m; cars desaturated with
   cabin/wheels. Chain re-validated after the change: PASS 0.85–0.93.

## 6. Memory / stability checks

- Part of `tests/core.test.mjs`: cache fill/traverse cycles with 60 nodes,
  verifying the LRU never exceeds capacity, pinned current node never evicted,
  blob URLs revoked on eviction, and back-and-forth navigation 100× never
  triggers re-generation (identity assertion).
- Perf tier auto-shift verified by simulated FPS windows.

## 7. Known environment limitation (recorded honestly)

**No headless browser is available in this build sandbox** (Playwright's CDN
is unreachable, system Chromium absent, `node-canvas` native build lacks
cairo). Consequently a genuine browser E2E (Playwright clicking through the
UI) could not be executed here. This was compensated by:

1. the static integration smoke (module graph + DOM ids + icons),
2. the pure-JS Canvas2D harness (real provider pixels verified),
3. `node --check` syntax validation of all 17 modules + `sw.js`.

On any normal workstation, `node tests/…` and the validator suite run as-is;
opening the app requires only a static server (see SETUP). Recommended next
step where a browser is available: `npx playwright test` with the scenarios
listed in §7 of this file's source header comment.

## 8. Manual QA checklist (run in a real browser)

Provided in `docs/SETUP.md` §Verification — load each demo world, walk
`W/W/W/A/D/…`, reverse path, check scale bar distances, import/export a
`.pmap`, toggle AutoComplete on an incomplete node, block an edge in the
advanced editor and verify movement refuses it.
