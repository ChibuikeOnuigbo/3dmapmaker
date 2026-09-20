# Concise technical report on the pre-existing app

*(This analysis was produced before the architectural rework, as required.
The old code is preserved in `legacy/`.)*

## What existed

The repository contained **CampusNav 360** (`legacy/index.html` + `js/` +
`css/`): a single-map campus 360° viewer written as one ~4,700-line monolith
(globals in `js/*.js` classic scripts, no modules), plus a
`google-street-view-clone/` reference folder and some saved assets/reports.

Inventory of working functionality (preserved behaviorally in the redesign):

| old system | where | disposition in redesign |
|---|---|---|
| equirect three.js viewer w/ drag/zoom | `legacy/js/pano-*.js` | replaced by a **dependency-free WebGL renderer** (`js/viewer/pano-renderer.js`); interaction model (drag, wheel FOV, hotspot transitions) retained |
| 2D canvas map renderer with theme, hit-testing, drag, scale bar | `legacy/js/map.js` | **directly evolved** into `js/map/map-renderer.js` — same drawing vocabulary, now driven by `WorldGraph` |
| node graph implicit in hotspot links | scattered | formalized into `js/core/world-graph.js` (nodes/edges/zones/distances) |
| localStorage project save (base64 images) | `legacy/js/save.js` | **removed by requirement** → `.pmap` ZIP + IndexedDB + Blob URLs |
| UI (top bar, cards) | `legacy/index.html + css` | re-skinned Google-Maps-style (`css/app.css`, floating panels) |

## Weaknesses that motivated the redesign

1. **No coherent world model** — hotspots were ad-hoc; no distances in
   meters, no zones, no reverse-travel identity; graph edits were fragile.
2. **Hard-coded scale** — pixels were treated as meters (`500 m church test`
   impossible to express).
3. **Storage anti-patterns** — base64 in localStorage, no portability, quota
   failures on real panoramas.
4. **No validation** — any swapped panorama was accepted silently; no way to
   detect the "church → beach" failure.
5. **Global-script architecture** — 20+ globals, no testability; the redesign
   is ES modules with a Node-testable core.
6. **No generation pipeline** — nothing to anchor continuity against; the new
   context/provider/validator trio makes it explicit.

## What was NOT done (by decision)

- The legacy viewer was not blindly deleted: it still opens standalone from
  `legacy/index.html` untouched.
- No framework, bundler, or three.js/Babylon dependency added; the brief
  requires static-host deployability and testability, so the math (yaw/pitch/
  FOV/equirect projection) is hand-rolled and unit-tested.
- No 3D modeling features — by requirement this is not a world builder.
