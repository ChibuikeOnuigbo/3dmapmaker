# MEMORY — Panorama Maps (3dmapmaker)

Date: 2026-10-08 · Branch state: arena/373b11d1-3dmapmaker (desktop build + world files).

## REPOSITORY ORGANIZATION — standing rule (2026-10-17)

The repository is intentionally split into three top-level domains. Keep it
that way in every future update:

- **`README.md`** — the only Markdown file at the root. Orientation, quick start
  and the "where new work goes" table.
- **`panorama/`** — the standalone web app and all reference/full work:
  `index.html`, `css/`, `js/`, `assets/`, `api/`, `manifest.webmanifest`,
  `sw.js`, `tests/`, `tools-render/`, `legacy/`, `qa/`, `docs/`, `MEMORY.md`,
  `GENERATION-LOG.md`, `finx_genmap.md`.
- **`Agent/`** — every model and data store, and no Markdown: `models/` (ONNX
  + JSON weights, canonical), `desktop/` (server, SQLite/JSON database, CLI,
  launchers, Electron wrapper), `tools-model/` (training + ONNX export),
  `tools/` (OpenCV validation + pytest). Its full explanation lives in
  `panorama/docs/AGENT-DATA-STORE.md`.

Runtime paths are explicit now: the desktop server serves `panorama/`
(`APP_ROOT`) and exposes `Agent/models` at `/models/`; the web client reads
`../Agent/models/panorama_vision_weights.json` with a `models/…` fallback;
`sw.js` caches the same canonical file. Do not reintroduce root-level symlinks
or duplicate copies of the weights.

Removed as superseded/rotten during the reorganization: the vendored
`legacy/google-street-view-clone`, old `legacy/saved/*.html` snapshots,
unreferenced `legacy/img` duplicates and the stray legacy prompt/notes text
files. The CampusNav source itself (`legacy/index.html`, `legacy/css`,
`legacy/js`) is retained as reference.

## SUPPORTED (implemented + covered by automated tests)

### `.pworld` — one file holds a whole world, images included
| Feature | State | Evidence |
|---|---|---|
| Save any world (demos, built, imported) to one self contained file | SUPPORTED + TESTED | `panorama/js/io/pworld.js`; `panorama/tests/pworld.test.mjs` 14/14; boot-harness saves the live app's world and reopens it |
| Every image inside (uploads, bundled photo sets per scene mode, 2D map image, previews, thumbnails, cover) | SUPPORTED + TESTED | boot-harness: 12/12 images in the harness file; browser e2e: 12/12 real Willow frames; desktop export byte identical |
| Opens with no network, no originals, no store | SUPPORTED + TESTED | browser e2e cuts the originals at the network layer and the world still renders and walks |
| Integrity: sha256 per asset and per world, damaged files refused | SUPPORTED + TESTED | damaged image and damaged graph tests |
| Scene modes travel inside the file (`pano.kind = "embedded"`) | SUPPORTED + TESTED | mode swap reads a different embedded image; cache key carries the mode |
| Legacy `.pmap` still saves and opens; the extension decides the opener | SUPPORTED | `openAnyFile()`, `FILE_KINDS` |
| One surface everywhere: toolbar Worlds, Panels menu, both map studios, the scripting studio, `Ctrl/Cmd+S` | SUPPORTED + TESTED | static smoke asserts each; browser e2e clicks the studio button and the panel button |
| Live readout of what a save will contain (images, size, what still has to be fetched) | SUPPORTED | `WorldLibrary.measure()` |

### Desktop build (Linux · Windows · macOS)
| Feature | State | Evidence |
|---|---|---|
| The same app served from disk with a database behind it | SUPPORTED + TESTED | `Agent/desktop/server.mjs`; `panorama/tests/desktop-api.test.mjs` 19/19 |
| Worlds database (SQLite via `node:sqlite`, JSON fallback): worlds, assets, revisions, events, settings | SUPPORTED + TESTED | schema + CRUD on both engines |
| Images content addressed (identical image stored once) | SUPPORTED + TESTED | two rows, one file on disk |
| Library columns: world, places, images, size, updated (updated sits under the name) | SUPPORTED + TESTED | library response + browser e2e assertions |
| Version history: list, snapshot, restore (30 kept) | SUPPORTED + TESTED | `GET/POST /api/worlds/:id/revisions`, restore test, browser e2e snapshot |
| Export from the database to `.pworld`, import back (import brings its cover) | SUPPORTED + TESTED | server side archive with real images; cover test; import never overwrites a world silently |
| Save dialog stand in: `POST /api/save-file` writes into `<data>/exports` | SUPPORTED + TESTED | fresh directory test (folders are created at boot), traversal neutered, empty refused |
| Library row actions: open · export · copy · delete | SUPPORTED + TESTED | browser e2e drives all four |
| Launchers `start.sh` / `start.command` / `start.bat` / `main.mjs`; CLI list/info/import/export/delete/gc/stats | SUPPORTED (smoke) | CLI ran; server boot + health verified |
| Optional Electron wrapper + electron-builder targets | PROVIDED (needs `cd Agent/desktop && npm install`) | `Agent/desktop/electron/main.cjs`, `Agent/desktop/package.json` |
| The web build stays database free | SUPPORTED | the panel says so; `Desktop.probe()` fails soft |

### Browser end to end (tools-render/world-e2e.mjs · 73 checks)
| Feature | State | Evidence |
|---|---|---|
| A real browser saves the running world, blocks the originals, reopens the file on a clean machine | SUPPORTED + TESTED | web phase: 49 checks |
| The same browser drives the desktop build: database save, library, versions, copy, delete, export, reopen, cross import | SUPPORTED + TESTED | desktop phase: 24 checks |
| Screenshots of every step | PROVIDED | `panorama/qa/world-file/*.png` |

### World modes
| Feature | State | Evidence |
|---|---|---|
| Animated procedural worlds (Chapel Lane, Millbrook, Great Vale) | SUPPORTED + TESTED | boot-harness 58 checks walk them; live `/tools-render/` previews from committed generator |
| AI real demo worlds (Willow Parish, day/rain/night) | SUPPORTED + TESTED | 637-node village graph with day/rain/night variant switching |
| Loop 1 Custom World: The Grand Hotel Suite | SUPPORTED + TESTED | `panorama/js/worlds/hotel-suite.js`; 50+ continuous indoor stations, mezzanine stairs, luxury bath, OpenCV tracking, `panorama/assets/hotel/suite-master.jpg` |
| Loop 2 Custom World: Neo-Kyoto Skyway | SUPPORTED + TESTED | `panorama/js/worlds/neo-kyoto.js`; outdoor futuristic cyberpunk maglev concourse, holographic array, skyline parapet, and wet reflective deck |
| Loop 2 Custom World: Solaris Orbital Colony | SUPPORTED + TESTED | `panorama/js/worlds/solaris-colony.js`; outdoor futuristic geodesic biodome, solar harvester core, planetary ring overlook, and luminescent flora |
| Loop 2 Custom World: The Obsidian Art Gallery | SUPPORTED + TESTED | `panorama/js/worlds/obsidian-gallery.js`; indoor modernist rotunda, titanium kinetic helix sculpture, cantilevered mezzanine ramp, terrazzo floor |
| Loop 2 Custom World: Subterranean Bio-Archive | SUPPORTED + TESTED | `panorama/js/worlds/sub-archive.js`; indoor cryogenic specimen silo, quantum data banks, observation catwalk, and decontamination chamber |
| Void mode (empty world import) | SUPPORTED | start-null guard removed; move pads/keys toasts "this world has no places" |
| Project open/save/export `.pmap` | SUPPORTED | ProjectArchive export/import round-trip, atomic staged import |
| World save/open `.pworld` (self contained) | SUPPORTED + TESTED | see the world file table above |
| Auto-save to IndexedDB | SUPPORTED | debounced persist on every world change |

### Neural Vision, Optics & Adaptive Morph
| Feature | State | Evidence |
|---|---|---|
| ONNX Neural Vision Model (`Agent/models/panorama_vision_model.onnx`, opset 17) | SUPPORTED + TESTED | `Agent/desktop/model-runner.mjs`, `panorama/js/ai/vision-model.js`; 7 output heads |
| Screen-Space Ray Tracing & Ambient Occlusion | SUPPORTED + TESTED | `pano-renderer.js` WebGL shader; floor/wall contact AO & specular bounce |
| Subtle 3Dness Parallax Relief | SUPPORTED + TESTED | strictly bounded $\le 0.05$m to eliminate warping artifacts |
| Real-time Denoise & Enhance | SUPPORTED + TESTED | bilateral range-weighted kernel + unsharp mask clarity sharpening |
| Epipolar Flow & Normal Mapping | SUPPORTED + TESTED | micro-surface normal perturbations & epipolar curl tensor |
| Wide-Angle Optics & FOV Control | SUPPORTED + TESTED | Rectilinear, Panini, and Fisheye barrel distortion correction with $50^\circ$–$100^\circ$ slider |
| Atmospheric View Illusion | SUPPORTED + TESTED | distance-aware aerial perspective and horizon depth haze |
| Head / Neck Pivot Parallax | SUPPORTED + TESTED | Loop 3: physical neck pivot rotational offset in WebGL ray computation |
| Indirect Light Bounce Radiance | SUPPORTED + TESTED | Loop 3: ground-plane upward indirect diffuse radiance bounce in ray tracing |
| Neural Model Inference Telemetry | SUPPORTED + TESTED | Loop 3: live telemetry status badge in `#visionPop` (Opset 17, 7/7 heads) |
| Adaptive Velocity-Conserving Morph | SUPPORTED + TESTED | keypress ms dynamic blend ($t^{0.45}$ tap, cubic Hermite, $t^{1.65}$ hold) with zero speed alteration |
| Settings UI (`#visionPop`) | SUPPORTED + TESTED | granular toggles and tuning sliders for all model features |

### Navigation
| Feature | State | Evidence |
|---|---|---|
| WASD / Arrow movement with graph-aware bearings | SUPPORTED + TESTED | 45° sectors, no dead angles; blocked edges never chosen (core tests) |
| Double click / double tap = turn + walk | SUPPORTED | panoCanvas dblclick → same pipeline as W |
| Move pad (on-screen) | SUPPORTED | 4 buttons, same pipeline |
| Long-edge walking with camera glide, chained keys | SUPPORTED + TESTED | run-line bearing fix + ramp-up test; chained pending dir on arrival |
| Speed slider (0.5–14 m/s, persistent) | SUPPORTED | bottom-left widget, live `graph.settings.walkSpeedMps` |
| Once-per-keypress default, hold = continuous | SUPPORTED | bespoke `tickOnce` model (no blind traversal) |
| Compass, location card, live mini-map with cones | SUPPORTED | widgets toggleable from Panels menu; follower preserves zoom/scale |

### View
| Feature | State | Evidence |
|---|---|---|
| 360 equirectangular viewer, drag look, wheel/pinch FOV, pitch limits | SUPPORTED + TESTED | pitch clamp/FOV pinch synthesis tests |
| Transitions (walk crossfade + slide), reverse-identical panoramas | SUPPORTED + TESTED | reverse travel test uses node cache |
| AutoComplete (missing top/bottom repair) | SUPPORTED + TESTED | completeness analysis + repair, toggleable |
| Sharpen (edge-aware unsharp) / Smoothen (edge-aware denoise) | SUPPORTED + TESTED | cached per node; core tests cover edge preservation |
| Scene modes (day/rain/night) | SUPPORTED (Willow Wood) | mode group auto-appears, rain fx + bus wipers |
| Mobile: bottom dock toolbar, search expanded overlay, gestures | SUPPORTED | full layout rework; ≤700 px touch targets ≥38 px |

### Studios / editors
| Feature | State | Evidence |
|---|---|---|
| Blank world creation (canvas size) | SUPPORTED | create-empty flow; start node locked to first place |
| Closed loop street builder | SUPPORTED + TESTED | shift-draft preview; auto-edge on loop detection |
| Walk-first clusters, roaming dropped pear-drops | SUPPORTED | placement math tested |
| Zone editor (draw/nudge/re-clip, boundary glide) | SUPPORTED | multi-nudge autonomy; boundary crossing shown on map card |
| Blocked street editor (cut + mask) | SUPPORTED | blocked edges untraversable, live map |
| Scene templates (cinematic/school/makeup/…/void) | SUPPORTED | 17-point migration of custom presets; per-template lighting |
| Panels menu (widgets, debug, sharpen, smoothen) | SUPPORTED | one consolidated menu for all secondary UI |
| Advanced studio (video-editor-style maker) | SUPPORTED | functional label, toast explains import mode |

### Media / AI imagery
| Feature | State | Evidence |
|---|---|---|
| Local AI demo generation (Gemini/Imagen/OpenAI keys, chain continuation) | SUPPORTED (locally, with user keys) | `local-studio/`; Willow Wood produced this way; one-world chaining rule implemented |
| Reference-image guidance + continuity kit export | SUPPORTED | context builder `refs[]` honored, `chain_refs_with` manifest field |

## PLANNED / NOT-SUPPORTED (must never be presented as working)

| Feature | Status | Note |
|---|---|---|
| Server-side AI generation without user keys | PLANNED / BLOCKED | requires deploy with credentials; provider returns `NO_API_KEY` error, never a fake image |
| 3D object placement / terrain modeling | NOT-SUPPORTED (by design) | this is a world walker; placement tools = streets/landmarks/zones only |
| Traditional video/audio editing (timeline clips) | NOT-SUPPORTED (different product) | advanced studio is a maker surface, not a clip editor |
| Multiplayer, cloud project sync | PLANNED | no code exists; not advertised in UI |

## UI consolidation state (this pass)
- Topbar: brand | search (expand overlay) | panels | view | bookmarks | studio toggle | zoom | close | fullscreen. The world chip popup was removed by directive: world switching lives on the landing demos page via the back button.
- One Panels menu for all secondary UI (widgets, debug, view tweaks) — no scattered toggles.
- Popups clamp to viewport; mobile popups open upward from the bottom dock.
- Toast: max 3, identical messages refresh in place.
- Widgets live on one calm surface system (backdrop, sh-1, 1 px borders); speed pill is fully styled (custom track/thumb).

## Invariants that must hold
- ONE WORLD STAYS ONE WORLD: reverse movement returns the cached original panorama; AI continuation chains off the last panorama as its reference.
- No hyphens ever in user-facing text.
- No localStorage for project/images; `.pworld` stays self-contained and portable — an image that cannot be embedded is reported in `missing[]` and its link kept as a fallback, never silently dropped.
- The web build never requires a server or a database; the desktop build never requires a network.
- `panorama/js/io/desktop.js` speaks relative `api/...` URLs only — no hardcoded host.
- Loader must clean up after module failure (coverage test exists).
