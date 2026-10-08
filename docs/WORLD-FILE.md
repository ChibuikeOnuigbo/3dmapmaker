# The `.pworld` world file

**One file that is a whole world — images included.**

A `.pworld` is the world itself, not a link to it. Every place, every
connection, the map scale, the zones, the landmarks, the environment, the
scene modes, the version notes — and **every image, embedded inside the
file**. Delete the photos from the phone that took them, lose the website,
turn off the internet: the world still opens and still walks.

Anyone can save a world this way: demo worlds, worlds you built, worlds you
imported. The same button exists in the web build and in the desktop build,
in the Panels menu, in both map editors, in the scripting studio, and on
`Ctrl`/`Cmd`+`S`.

The save card in the **Worlds** panel measures before it writes: how many
images will go in, how many are already on this device, roughly how many
bytes that is, and how many still have to be fetched. Unticking a scene mode
keeps it as a link instead of embedding it (smaller file, that mode then needs
the original site).

```
World.pworld                (a standard ZIP container — rename to .zip to look inside)
├── pworld.json             header: format, world card, stats, asset table, checksums
├── world/
│   ├── world.json          the complete WorldGraph: nodes, edges, zones,
│   │                       landmarks, scale, environment, settings
│   ├── session.json        where the visitor stood: node, mode, yaw/pitch/fov,
│   │                       walk speed, motion, accessory switches
│   └── cache.json          per-node identity metadata (validation reports,
│                           completeness analysis) so scores survive a round trip
├── assets/panoramas/       EVERY image, byte for byte:
│   ├── asset_ab12cd34ef56.jpg      uploaded panoramas
│   ├── asset_9f8e7d6c5b4a.jpg      bundled photo sets (one per scene mode)
│   └── asset_1029384756ab.png      the 2D map image (underlay)
├── previews/panoramas/     display-size derivatives (webp)
├── thumbnails/panoramas/   library thumbnails (webp)
└── cover.jpg               a picture of the world for the worlds library
```

## Why it is a ZIP

- The image bytes ride along **without base64 inflation** (base64 costs 33%).
- It is universally readable: any unpacker opens it, no library required.
- The app already ships a dependency-free ZIP writer/reader
  (`js/io/zipex.js`), so no runtime dependency is added anywhere.
- It is still ONE file — drag it, mail it, put it on a stick.

## What gets embedded

`collectWorldAssets()` walks the world and pulls in everything it needs:

| In the world | What happens on save |
|---|---|
| `pano.kind = "generated"` | nothing to embed — the panorama is rendered from the world model itself, so the world is already self-contained |
| `pano.kind = "asset"` (uploaded) | the original bytes are embedded (display + thumbnail too) |
| `pano.kind = "urlset"` (bundled photos, e.g. Willow Parish) | every scene mode is downloaded and embedded, and the node becomes `pano.kind = "embedded"` with one asset id per mode |
| `pano.kind = "embedded"` | already embedded — copied straight through |
| `environment.mapUnderlay` | the 2D map image is embedded |
| an image that cannot be read | listed in `missing[]` with the reason — the world is saved without it, and `fallbackVariants` keeps the original URL so that mode still works online |

Images are de-duplicated by SHA-256: the same photo on twenty nodes is stored
once.

## Integrity

- `pworld.json.integrity.worldSha256` covers `world/world.json`.
- every asset row carries its own `sha256`.
- `verifyPworld()` re-hashes both on open. A single flipped byte inside an
  embedded image is **refused** with a checksum error — the app never shows
  silently corrupt pixels.
- untrusted input is schema-checked (`validateWorldJson`): the same rules
  `.pmap` uses — no dangling edges, real coordinates, sane counts.
- path traversal, entry counts and total size are capped.

## Round trip guarantee

```
world + images  →  export  →  World.pworld  →  import  →  the same world
```

The test suite proves it byte for byte: `node tests/pworld.test.mjs`
(export → verify → import, offline embed of photo sets, mode selection,
previews, cover — including the cover coming back on import —
damaged-file refusal, foreign-zip refusal, newer-version refusal,
dangling-edge refusal).

The whole story is also driven **in a real browser**
(`node tools-render/world-e2e.mjs`): the running app saves a world, the
originals are cut off at the network layer, the file is opened on a clean
machine, the embedded pixels are rendered, the scene modes switch, the world
is walked, and a reload proves the local mirror kept it. Screenshots land in
`qa/world-file/`.

## Getting a file into the app

Four ways, one code path (`openAnyFile()` — the extension decides):

| How | Where |
|---|---|
| **Drag the file onto the window** | anywhere; the whole screen becomes a drop target while you drag |
| **Look inside a world file first** | Worlds panel → Save section — name, author, places, images, size, format, saved date, and anything the file is missing, before you commit to opening it |
| **Open a world file** | the start screen, the Worlds panel, or `Ctrl`+`O` |
| **The world's own window** | desktop builds route the File menu here: `#open-world`, `#worlds`, `#save-world` |

A file that is not a world (or one whose bytes were changed on the way) is
refused with a reason, and **the world you were in is left exactly as it
was** — opening is atomic: the current world is only replaced once the new one
has been read, verified and staged.

## Related formats

| File | Contains | Status |
|---|---|---|
| `.pworld` | the world **and** its images | current |
| `.pmap` | the world plus its uploaded images (bundled photos stay linked to the site) | legacy archive, still opens |
| `*.world.json` | the world graph as text — no images, for scripting | developer tool |

## Desktop database vs file

The desktop app also keeps worlds in a database (see
[DESKTOP.md](DESKTOP.md)). The file is the portable, permanent artefact; the
database is the convenient working home. Both hold the same data — exporting
from the database writes the same `.pworld` the web build writes.
