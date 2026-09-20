# Setup & usage

## Requirements

- Any modern browser (Chrome, Edge, Firefox, Safari ≥ 15). WebGL is used for
  the panorama view (Canvas 2D fallback is provided by the LOW perf tier).
- No install, no build, no account, no database.

## Run

```bash
cd 3dmapmaker
python3 -m http.server 8080        # or: npx serve, Netlify/Vercel static, nginx…
# open http://localhost:8080
```

The app is pure static files — deploy the repository root to any static host
unchanged. A service worker (`sw.js`) makes the shell + demo worlds work
offline after first load.

## Controls

| where | input | action |
|---|---|---|
| viewer | drag | look around (yaw/pitch) |
| viewer | wheel / pinch | zoom = **field of view only** (never movement) |
| viewer | `W A S D` | walk forward/left/back/right through the navigation graph (camera-relative) |
| viewer | `Q E` | diagonal steps |
| viewer | arrow keys | reserved look / accessibility pad equivalent |
| toolbar | world button | switch demo world / open a `.pmap` file |
| toolbar | pencil | open the map editor (Simple / Advanced) |
| toolbar | save | export the whole project to **one `.pmap` file** |
| map | click node | teleport the viewer there |
| map | drag | pan the map; wheel = map zoom (independent of panorama FOV) |
| map | expand | fullscreen big map with scale bar |
| location card | toggle | **AutoComplete Panorama** on/off (repairs missing bands) |

Movement is always validated against the navigation graph: no edge ⇒ a soft
"no path" hint, never a teleport into void. Zoom never moves the camera; the
viewing height is a fixed camera property.

## Worlds included

1. **Chapel Lane** (small) — the acceptance world: a lane approaching a church
   inside a 500×500 m zone (zone boundary math verifiable), plaza with an
   *intentionally incomplete* panorama to exercise AutoComplete.
2. **Millbrook** (medium) — streets, a green, water edge, several zones and
   landmark types.
3. **Great Vale** (large) — 1,000+ nodes on an 8×8-style block grid grown by
   frontier expansion, demonstrating the spatial index + perf tiers.

## The `.pmap` file

One portable project file (ZIP): `project.json` + `assets/pano_*`. Save/Open
buttons handle it; no absolute paths are stored, so the file moves between
computers freely. Import replaces the current project atomically; nothing is
merged half-way. Internally assets are served as Blob URLs; IndexedDB is only
a local cache of the last-opened project (normal users never see these words
in the UI).

## Map editor

- **Simple**: click map to add a node, name it, auto-connect; upload a
  panorama per node (checked by the continuity guardrail); set a custom 2D
  map background image; draw roads/corridors.
- **Advanced**: precise node coordinates in **meters** (auto-converted via
  `pixelsPerMeter`), edge create/delete with distance preview, zone tools,
  landmark placement, per-node AutoComplete override, world scale
  (`pixelsPerMeter`), forbidden-change flags for the generation pipeline.

## Optional: AI generation backend

Install nothing. Provide an endpoint that accepts `POST /api/generate` with
the JSON context documented in `docs/GENERATION-PIPELINE.md` and returns an
equirect panorama + validation report (run `tools/panorama_validate.py` on
your server). Point the app at it in *Settings → Advanced → Generation
endpoint* or `?genapi=https://…`. **Keys live on your server, never in this
client.** Without an endpoint, the built-in procedural development generator
(labeled as such) keeps everything fully functional.

## Optional: validation CLI

```bash
python3 -m venv .venv
.venv/bin/pip install opencv-python-headless numpy pytest
.venv/bin/python tools/panorama_validate.py --prev a.png --next b.png --distance-m 10
.venv/bin/python -m pytest tools/tests -q
```

## Verification (manual QA)

1. Open → Chapel Lane loads, marker on map matches viewer location.
2. Drag to face the church; press `W` 3× (10 m steps): church grows; scale
   bar increases from the origin node; map marker walks.
3. Press `S` 3×: the *original* previous panoramas return instantly (cache).
4. Switch to Millbrook, repeat across a zone edge: distance reported in the
   header respects the boundary change only when actually crossed.
5. Open the editor, add a node off-road, connect it, walk there and back.
6. Select the incomplete plaza node → toggle **AutoComplete** on: top band is
   filled smoothly; drag pitch up: soft resistance, band not visible;
   toggle off: original band returns and full pitch restored.
7. Save → a `.pmap` downloads. Reload the page (storage cleared),
   Open that file → identical world, panoramas, edits.
8. Toggle offline in devtools → app shell and last world still load.
