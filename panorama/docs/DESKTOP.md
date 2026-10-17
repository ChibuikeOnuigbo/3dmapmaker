# Panorama Maps — desktop

**The same app, with a worlds database.** Linux, Windows and macOS.

The desktop build serves the exact same `panorama/index.html` + `panorama/js/` you already have
— no fork, no second codebase — and adds what a browser cannot keep: a real
database for every world you make, with its images, versions and activity.

```
┌──────────────────────────── the app (panorama/index.html + panorama/js/) ───────────────────────────┐
│  Worlds ▸ Save new world      Worlds ▸ library table      Versions      Activity   │
└───────────────────────────────────────┬───────────────────────────────────────────┘
                                        │  relative URLs: api/...
┌───────────────────────────────────────┴───────────────────────────────────────────┐
│ Agent/desktop/server.mjs  ·  zero npm dependencies (node:http + node:fs + node:sqlite)   │
│   /api/health · /api/worlds · /api/worlds/:id · /api/worlds/:id/pworld · /api/import  │
│   /api/worlds/:id/assets/:assetId[/:kind] · /api/worlds/:id/revisions · /api/events  │
│   /api/storage · /api/settings · /api/save-file                                      │
└───────────────────────────────────────┬───────────────────────────────────────────┘
                                        │
                             Agent/desktop/db.mjs  (WorldDatabase)
                          sqlite  → node:sqlite, the default
                          json    → plain-file fallback for older Node
```

## Run it

Requires [Node.js](https://nodejs.org) 18 or newer (22.5+ gives the SQLite
database; older versions use the JSON fallback automatically).

| Platform | How |
|---|---|
| Linux | double-click `Agent/desktop/start.sh` (or `bash Agent/desktop/start.sh`) |
| macOS | double-click `Agent/desktop/start.command` (first time: right-click → Open) |
| Windows | double-click `Agent/desktop/start.bat` |
| any terminal | `node Agent/desktop/main.mjs` |

It prints the address, opens your browser at it, and stops cleanly on `Ctrl`+`C`.

```
node Agent/desktop/main.mjs --port 8080        pick the port (default 7654, steps up if taken)
node Agent/desktop/main.mjs --no-open          do not launch a browser
node Agent/desktop/main.mjs --host 0.0.0.0     reachable from your phone on the same network
node Agent/desktop/main.mjs --data-dir DIR     keep worlds somewhere specific
```

## Where your worlds live

| OS | Folder |
|---|---|
| Linux | `~/.local/share/panorama-maps/` |
| macOS | `~/Library/Application Support/PanoramaMaps/` |
| Windows | `%APPDATA%\PanoramaMaps\` |

`PM_DATA_DIR` overrides it. Inside:

```
panorama-maps.db        the database (WAL mode)
assets/<ab>/<sha256>.jpg   every image, content addressed — an image used by
                           ten worlds is stored once
assets/covers/*.jpg     library covers
exports/*.pworld        world files written by the desktop build
```

## The database

| Table | Holds | Why |
|---|---|---|
| `worlds` | one row per world: name, maker, notes, tags, counts, size, cover, the graph itself, the session, settings | the library columns you see in the Worlds panel |
| `assets` | one row per image per world: role, mode, name, mime, bytes, sha256, path | images live as files (content addressed), the row is the index |
| `revisions` | snapshots of a world (last 30 kept) | version history, restorable |
| `events` | what happened: save, import, export, delete, restore, asset writes | the Activity tab |
| `settings` | app-level key/value (last world, cached identity metadata) | plus `cache:<worldId>` for validation reports |

Deleting a world removes its rows and unlinks its image files **unless
another world still references them**.

## What the desktop build adds in the UI

- **Worlds** button in the toolbar, the Panels menu (*Save world file…*,
  *Open world file*, *Worlds database*), and `Ctrl`/`Cmd`+`S` to save.
- **Save new world** — name, maker, notes, tags; choose which scene modes to
  embed (with a live readout of what that saves: images, size, what still has
  to be fetched); then *Save to worlds database*, *Save .pworld file* (written
  straight into `exports/`, no download folder involved), or both.
- **Worlds** — the library table: World (with maker and last update under the
  name) · Places · Images · Size · open / export / copy / delete.
- **Versions** — snapshots of the open world, restorable.
- **Activity** — the database's recent work.

Everything else — walking, the studios, the designers — is untouched: the
desktop build is the same application.

## Command line

```
node Agent/desktop/cli.mjs list
node Agent/desktop/cli.mjs info <worldId>
node Agent/desktop/cli.mjs import path/World.pworld [--name "Renamed"]
node Agent/desktop/cli.mjs export <worldId> [--out DIR] [--modes day,night]
node Agent/desktop/cli.mjs delete <worldId>
node Agent/desktop/cli.mjs gc            remove image files no world references
node Agent/desktop/cli.mjs stats
```

## Optional: installers (no Node needed on the target machine)

The Electron wrapper runs the same server in a window and can be packaged:

```
cd Agent/desktop
npm install                 # electron + electron-builder (network required)
npm run start:window        # window instead of a browser tab
npm run dist:linux          # AppImage + .deb
npm run dist:win            # NSIS installer + portable .exe
npm run dist:mac            # .dmg + .zip
```

Artifacts land in `dist-desktop/`. The plain `node Agent/desktop/main.mjs` path
needs none of this — it is one less moving part, and it is the way the
desktop build is tested in this repository: `node panorama/tests/desktop-api.test.mjs`
(16 checks: server, database, uploads, de-duplication, `.pworld` export and
import, the cover travelling with an import, versions listed and restored,
activity, the save-file route on a fresh data directory, deletes, error paths)
plus the browser run in `panorama/tools-render/world-e2e.mjs` (24 checks that click
through the real UI: save to the database, the library columns, versions,
copy, delete, export, reopen, cross-build import).

## The web build stays database-free

The web build is deliberately static HTML + CSS + JavaScript: no database, no
server, no build step. Worlds there travel as [`.pworld` files](WORLD-FILE.md)
that carry all of their images. Open a `.pworld` in the desktop app and it
lands in the database; export from the database and you get a file the web
build opens. The file is the common language; the database is the desktop
convenience.

## Security notes

- The server binds `127.0.0.1` by default: nothing outside the machine can
  reach it. `--host 0.0.0.0` is a deliberate choice for phone/tablet access —
  use it only on a network you trust.
- Static file serving is restricted to the app folder, with path traversal
  refused and only known file extensions served.
- User data is never uploaded anywhere. The API is served by your own machine,
  from your own folder.
