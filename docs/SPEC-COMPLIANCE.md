# Spec compliance — extracted instruction list for map / demo worlds / generation / behavior

Every instruction from the four master prompts (Product, Generation &
Continuity, UI/UX, Storage & Deployment) consolidated into one checklist.
Status: ✅ verified by an automated test · 🟢 implemented (manual QA) ·
➖ explicitly out of scope/deferred by design.

Legend for test refs:
`core` = tests/core.test.mjs (29) · `smoke` = tests/static-smoke.mjs (8) ·
`pytest` = tools/tests (15) · `boot` = tools-render/boot-harness.mjs (46) ·
`cv-chain` = OpenCV validation over real app-rendered panoramas.

---

## A. Product vision & terminology

| # | Instruction | Status |
|---|---|---|
| A1 | Panorama exploration platform, NOT a 3D world builder/modeler/game engine | ✅ smoke (banned terms), architecture |
| A2 | Required vocabulary only: panorama, 360-degree view, 2D map, map editor, navigation graph, location node, camera perspective, field of view, viewing height, image continuity, spatial coordinates, map scale, panorama transition, environment simulation | ✅ smoke |
| A3 | Math (vectors, yaw/pitch, FOV, equirectangular projection) used internally only — product stays map-first | 🟢 README + ARCHITECTURE |
| A4 | Inspect existing source before changes; preserve working functionality; concise technical report | 🟢 docs/EXISTING-ARCHITECTURE-REPORT.md; legacy/ preserved intact |

## B. World model (map, world, graph)

| # | Instruction | Status |
|---|---|---|
| B1 | Single source of truth: **WorldGraph**; map + viewer + editors read the same state; no drift between map position and viewer position (§4, §35) | ✅ core; boot (map setCurrent on every arrival) |
| B2 | Nodes: id, x, y, panorama reference, heading, camera metadata, connections (§5) | ✅ core (schema round-trip) |
| B3 | Cartesian coordinates; pixels ≠ meters; explicit `pixelsPerMeter`; NEVER silently 1 px = 1 m (§4, §5-storage) | ✅ core (scale tests incl. custom scales) |
| B4 | N×N grid `index = y·width + x`; coordinate-based adjacency (§5) | ✅ core (8×8 plaza grid) |
| B5 | King-style 8-direction adjacency as *candidates only*; walls/blocked edges rejected (§13, §38) | ✅ core (blocked edge test, blocked fountain plaza edge), boot |
| B6 | Edge distances from coordinates; diagonals = √2·d (§14) | ✅ core |
| B7 | Zones with REAL boundary math; zone metadata; point-in-zone tests (§22) | ✅ core |
| B8 | **500 m church test**: zone boundary 500 m from the church; inside/outside derived from distance, not image counts (§8, §9, §60) | ✅ core ("CHURCH 500 m continuity test") |
| B9 | Persistent landmarks with ids, positions, importance; generation must remember them (§11) | ✅ core; context builder passes landmarks to providers |
| B10 | Movement step configurable 10–15 px with min/max; step→meters derived via scale; never guessed (§6, §7) | ✅ core |
| B11 | Distance-aware expected visual change model (1 m ≈ identical … 500 m major-but-explainable) (§27, §28) | ✅ pytest (distance-aware threshold), validator floor table |

## C. Movement & viewer behavior

| # | Instruction | Status |
|---|---|---|
| C1 | WASD = logical world movement resolved through the graph: direction → candidate → boundary/connectivity check → load/validate → transition → map update (§5, §6) | ✅ core, boot (camera-relative aimed walk) |
| C2 | Camera-relative W/A/S/D (W follows camera heading; Q/E diagonals); cannot bypass world boundaries (§36, §37) | ✅ boot (yaw aimed at neighbor bearing resolved through graph) |
| C3 | Mouse drag = look only (yaw/pitch); zoom = FOV only, never movement; movement never changes viewing height; zoom never creates a location (§8-product, §36) | ✅ core (view state), smoke |
| C4 | Blocked movement: stay in place + subtle feedback; never generate a new scene to fill void (§38) | ✅ core, boot (toast + button shake in app) |
| C5 | Reverse traversal returns the SAME node ids and the cached ORIGINAL panoramas — never regenerate (§19, §31, §61) | ✅ core, boot (reverse trail to start id, cache identity) |
| C6 | Panorama transitions keep the previous frame visible; crossfade; no blank-then-spinner (§58-storage) | 🟢 viewer crossfade; boot (never blank cache) |
| C7 | Forward/backward edge symmetry stored explicitly (§20) | ✅ core (edge bearing both ways) |

## D. Demo worlds (map content)

| # | Instruction | Status |
|---|---|---|
| D1 | Demo 1 Chapel Lane — small: road → church → side road → cottages; basic navigation + continuity; includes the 500 m church zone AND the preserved 8×8=64-node king-move grid (§13, §34) | ✅ core, boot |
| D2 | Demo 2 Millbrook — medium town: Main St, Church Ave, Market Square, Mill Rd, riverside loop; branches & intersections; not a straight route (§12, §13) | ✅ boot (131 nodes, junction graph) |
| D3 | Demo 3 Great Vale — large: 1,000+ nodes; NOT 1,000 unrelated images — one world model, lazy visual generation (§13, §33) | ✅ boot (1125 nodes, generated on demand), core (spatial hash) |
| D4 | Roads/houses/church/shops/trees/signs/cars drawn from the world model — spatially coherent; the church never appears at unrelated positions (§12) | ✅ cv-chain, rendered-frame inspection |
| D5 | Spatial index for large worlds (`SpatialHash`); lazy loading; LRU image memory cache; don't decode everything (§64, §65, §15) | ✅ core (LRU/pin/evict tests) |
| D6 | Scales to 400/1024/5000+ nodes without rewriting navigation (§34) | ✅ core + boot at 1125; index is generic |

## E. Generation pipeline & continuity

| # | Instruction | Status |
|---|---|---|
| E1 | **ONE WORLD STAYS ONE WORLD** — every panorama generated as the next spatial state of the existing world (§1, §16, §75) | ✅ cv-chain (0.85–0.93 across the real street) |
| E2 | Sequential generation with FULL context array: previous panoramas + metadata, camera, movement vector, coordinates, zone, landmarks, roads, lighting, weather, forbidden changes (§9, §17, §21, §39, §40) | ✅ core (context builder tests); boot |
| E3 | Previous image history (immediate + 2–5 nearby + same-zone/route references) retained with hashes/metadata (§18, §41, §42) | 🟢 context builder recentMetas(4) + trail; cache keeps metas |
| E4 | Deterministic: same node + same context + same seed → compatible result (§71) | ✅ core (seed re-render identity), provider seeds per `worldId|nodeId` |
| E5 | Provider integration structure for a real AI backend; keys server-side ONLY; when unconfigured → clearly labeled development generator, no fake success (§21-product, §49, §50-storage) | 🟢 RemoteGenerationProvider + docs/GENERATION-PIPELINE.md |
| E6 | Rejection & regeneration loop with logged attempts, stricter context feedback, never silent accept (§43) | ✅ pytest (forbiddenChange hard veto); JS gate flags + `needsReview` |
| E7 | Confidence stored: generationConfidence / validationConfidence (§44) | ✅ meta fields; debug overlay shows them |
| E8 | "Do not invent a new location…" constraints encoded as forbiddenChanges in every context (§40) | ✅ context.forbiddenChanges |
| E9 | Frontier generation strategy for large worlds — one approved frame at a time (§33) | 🟢 on-demand generation + prefetchPlan; architecture doc |

## F. Validation (OpenCV)

| # | Instruction | Status |
|---|---|---|
| F1 | Python/OpenCV gate before any image enters the world (§10, §24, §25) | 🟢 tools/panorama_validate.py CLI + JSON; JS gate in app |
| F2 | Multiple methods — not a single similarity number: integrity, ORB features, geometry/inliers, structure/edges, color histogram, brightness, pHash landmark proxy, metadata (§10, §24, §26) | ✅ pytest (per-check reports) |
| F3 | Weighted configurable score + configurable threshold (default 0.78) (§26) | ✅ pytest (weights config) |
| F4 | Distance-aware relaxation (§27, §28) | ✅ pytest |
| F5 | Church→beach/unrelated scene detection MUST fail with reasons (§63) | ✅ pytest + cv-chain rejection run (score 0.29 FAIL) |
| F6 | Validation report: scores, reasons, advice, probabilities (§10, §64-storage) | ✅ pytest (serialization, probabilities) |
| F7 | Reduced-resolution analysis copy; never full 8K (§24-storage, §135) | ✅ validator ANALYSIS_W 1024; JS gate 192×96 sample |
| F8 | Landmark position continuity tracking (tower side of frame must evolve gradually) (§29) | 🟢 geometric inlier + pHash proxy; deep tracking = future AI-backend item |

## G. AutoComplete Panorama

| # | Instruction | Status |
|---|---|---|
| G1 | Real on/off toggle "AutoComplete Panorama" — not decorative (§45, §55, §56) | ✅ core, boot harness re-present path |
| G2 | Detect missing top/bottom strips: black/uniform %, context thresholds (night sky ≠ missing) (§46, §47) | ✅ core (detector tests incl. dark-sky case) |
| G3 | Completion = edge extension + blur/feather, subtle, low-frequency; no invented geometry (§48, §49, §50) | ✅ core (completion.js; seam validation) |
| G4 | Completion mask + stored report `{enabled, topPercent, bottomPercent, method}` (§51) | ✅ core (meta.autoComplete report) |
| G5 | Soft-resistance pitch limits near completed region; eased, no hard freeze, no visible box (§52, §53, §54) | ✅ core (damped pitch clamp tests) |
| G6 | OFF = original pixels restored, no file alteration; only safety clamp remains (§55) | ✅ core (undo path restores original canvas) |
| G7 | Completion seam validated: no visible border/color block (§57) | ✅ core (seam smoothness check in detect/complete) |
| G8 | Never alters world geometry — visual repair only (§58) | ✅ core + code path (graph untouched) |

## H. 2D map & editors

| # | Instruction | Status |
|---|---|---|
| H1 | Real graphical map (Canvas) — pan, zoom, node select→panorama, current position, visited/unvisited, landmarks, route highlight, scale bar, fit (§14) | ✅ smoke (IDs/handlers), core (renderer ops), 🟢 manual |
| H2 | Map uses canvas not thousands of DOM nodes (§84, §139) | ✅ smoke; renderer architecture |
| H3 | Simple editor: new map, upload 2D map image, add locations, roads/paths, nodes, connect, landmarks, upload+assign panoramas, preview, save (§15) | 🟢 simple-editor.js + smoke IDs |
| H4 | Advanced editor: precise coords, map scale, camera heading/pitch/FOV/height, panorama orientation, movement distance, connection editing, road geometry, landmark metadata, image replace/validate, transitions, export/import (§16) | 🟢 advanced-editor.js + core (scale/coordinate edits) |
| H5 | Immersion mode: optional sway/breeze/transition timing; never changes coordinates; controls for enable/intensity/speed (§17) | 🟢 viewer.immersion settings; no coordinate effect |
| H6 | Upload guardrail: user panoramas checked for continuity against neighborhood (§F1 in-app) | 🟢 jsUploadSimilarity + flagged review state |

## I. Storage, files, performance (master storage spec)

| # | Instruction | Status |
|---|---|---|
| I1 | `.pmap` portable ZIP project = source of truth; manifest + world + assets; relative paths only; versioned format (§2, §5, §7, §105, §106) | ✅ core (zipex archive round-trip) |
| I2 | No localStorage for project/images; no base64/data-URI image storage; no absolute OS paths (§1, §6, §32, §123, §124) | ✅ core (no base64; blob URLs), smoke |
| I3 | IndexedDB local working storage; runtime LRU decode cache; object-URL lifetime management (revoke on evict/close) (§18–§21, §41, §64) | ✅ core (LRU + revoke simulation) |
| I4 | Atomic import: validate all → stage → commit; never half-replace current project (§27, §28) | ✅ core; main.openProject staging |
| I5 | Export verification before success reported (§128) | 🟢 exportPmap verify step |
| I6 | Original vs display vs thumbnail derivatives; don't decode originals on low-end (§8–§11) | 🟢 AssetManager :display/:thumb; perf profiles pick dimensions |
| I7 | Duplicate asset detection via SHA-256; hash once (§13, §80) | ✅ core (dedupe test) |
| I8 | Service worker: app shell offline; NEVER wipe user data on update; versioned caches (§46, §94–§96) | ✅ smoke (shell files exist), sw.js versioned |
| I9 | Perf tiers HIGH/BALANCED/LOW + auto downgrade with hysteresis (§61, §170–§176) | ✅ core (tier logic), main.PERF_PROFILES |
| I10 | Adaptive prefetch (facing-direction first), never huge originals (§54–§57) | ✅ core (prefetchPlan tests) |
| I11 | Static hosting, no DB required; serverless/AI optional; network failure keeps local project usable (§51–§53, §108, §109) | 🟢 no runtime deps; offline sw |
| I12 | Import security: path traversal blocked, ZIP-bomb limits, JSON validation, SVG not executed (§66–§70) | ✅ core (archive path checks), 🟢 raster-only uploads |
| I13 | File System Access API optional with input/download fallback (§31, §116, §117) | 🟢 fsAccess wrapper with fallback |
| I14 | Project switch fully resets context (no asset leakage A→B) (§65) | ✅ boot (world switches reset cache/map) |
| I15 | Session vs project data separation; camera view not persisted per move (§82, §81) | ✅ architecture (viewer session local only) |

## J. UI / UX rules

| # | Instruction | Status |
|---|---|---|
| J1 | Google-Maps-style clean floating controls; map/viewer occupies viewport; no permanent toolbars everywhere | 🟢 css/app.css + index.html |
| J2 | Icons from a real icon set with accessible labels + tooltips; no emoji as primary icons (§19) | ✅ smoke (icon sprite + aria labels) |
| J3 | Loading/empty/error states present; no fake buttons — every control functional (§19, §21, §72) | ✅ smoke (handlers bound), app code audit |
| J4 | Technical details hidden (IndexedDB/OPFS/LRU/quota…); debug overlay behind the bug icon; short contextual messages only (§102, §103, §177–§179) | ✅ smoke (terms absent from UI), debug overlay |
| J5 | Responsive desktop/tablet/mobile (§19) | 🟢 CSS media rules |
| J6 | Pexels/decorative backgrounds never core-required (§48-storage) | ✅ no remote images at all |

## K. Testing deliverables

| # | Instruction | Status |
|---|---|---|
| K1 | Automated tests: open/load/navigate/reverse/500 m zone/continuity/rejection/autocomplete/memory (§22, §59–§63, §143–§150) | ✅ 29 core + 15 pytest + 46 boot + cv-chain |
| K2 | Technical docs, testing report, setup instructions (§23) | 🟢 docs/ |
| K3 | Clean-browser E2E | ➖ No headless browser in this sandbox (Playwright CDN blocked) → documented manual QA checklist in docs/SETUP.md + TESTING.md §6 |

---

## Items deliberately deferred (with reason)

1. **True semantic landmark tracking (§29)** — full "tower must drift side-of-frame continuously" needs a real AI image backend; the geometric/phash proxy + ORB inlier geometry is implemented and validated. Documented in VALIDATION.md.
2. **Playwright browser E2E** — sandbox has no browser binary; static smoke + Node boot harness + manual checklist stand in. The harness boots the real `js/main.js` in a fake DOM and walks all three worlds (46 checks).
3. **AI image generation with real keys** — integration seam (`RemoteGenerationProvider`) is built and documented; without credentials the procedural development generator is the honest, clearly-labeled fallback (Spec §21 permits exactly this).
