# MEMORY — Panorama Maps (3dmapmaker)

Date: 2026-09-21 · Branch state: arena/01a0be25-3dmapmaker tip.

## SUPPORTED (implemented + covered by automated tests)

### World modes
| Feature | State | Evidence |
|---|---|---|
| Animated procedural worlds (Chapel Lane, Millbrook, Great Vale) | SUPPORTED + TESTED | boot-harness 58 checks walk them; live `/tools-render/` previews from committed generator |
| AI real demo worlds (Willow Wood, day/rain/night) | SUPPORTED + TESTED | `assets/stills/willow-*.png`; 21 committed 2048×1024 panoramas in `assets/willow/` + postcard + front page still |
| Void mode (empty world import) | SUPPORTED | start-null guard removed; move pads/keys toasts "this world has no places" |
| Project open/save/export `.pmap` | SUPPORTED | ProjectArchive export/import round-trip, atomic staged import |
| Auto-save to IndexedDB | SUPPORTED | debounced persist on every world change |

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
- Topbar: brand | world | search(+expand) | panels | view | bookmarks | studio toggle | zoom | close | fullscreen — every item real.
- One Panels menu for all secondary UI (widgets, debug, view tweaks) — no scattered toggles.
- Popups clamp to viewport; mobile popups open upward from the bottom dock.
- Toast: max 3, identical messages refresh in place.
- Widgets live on one calm surface system (backdrop, sh-1, 1 px borders); speed pill is fully styled (custom track/thumb).

## Invariants that must hold
- ONE WORLD STAYS ONE WORLD: reverse movement returns the cached original panorama; AI continuation chains off the last panorama as its reference.
- No hyphens ever in user-facing text.
- No localStorage for project/images; `.pmap` stays self-contained and portable.
- Loader must clean up after module failure (coverage test exists).
