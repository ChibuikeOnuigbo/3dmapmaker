# Generation pipeline

## Philosophy

Panorama continuity cannot be achieved by generating images node-by-node with
a prompt string. The pipeline treats generation as a **verification problem**
with context:

> current panorama + previous panoramas + true destination coordinates +
> zone scene + landmarks + forbidden changes → provider → validation gate
> → cache identity.

The mandatory acceptance scenario (§62 of the original requirements):

1. Stand facing the church, door visible.
2. Walk 10 m closer → the *same* church, closer; street, trees, sun,
   brightness agree; scale bar shows 10 m moved; the **map marker moved to
   the connected node**.
3. Walk back → the *identical* previous panorama returns from cache.

This is enforced by tests and by the end-to-end run documented in
[TESTING.md](TESTING.md).

## Generation context (what a provider receives)

`GenerationContextBuilder.build(currentNode, prevNode, world)` returns:

```jsonc
{
  "current":   { "nodeId", "meters", "heading", "zone", "cameraHeight", "panorama" (Phashable) },
  "previous":  [ { "nodeId", "meters", "bearingFromPrev", "distanceM", "phash" } ], // trail
  "destination": { "meters", "distanceM", "bearingDeg", "withinZone" },
  "pathAnchors": [ { "type": "landmark"|"node", "meters", "bearingDeg" }… ],
  "world": { "theme", "palette", "sunAzimuth", "pixelsPerMeter", "seed" },
  "zoneScene": { "kind", "landmarks", "climate", "skyPalette" },
  "landmarks": [ { "type", "meters", "size", "color", "bearingDeg" }… ],
  "chain": { "position": "germ|extension", "turns", "totalNodes" },
  "summary": "string narrative of state for the provider",
  "forbiddenChanges": ["newRandomScene", "eyeLevelJump", "seasonShift", "timeShift", "headingFlip"],
  "feedback": { "previousRejections": [ { "reason", "score" }… ] }
}
```

That structure IS the integration seam — an AI backend only has to honor it.

## Providers

### `RemoteGenerationProvider`

Ready-made client for a real backend. It `POST`s `context` (+ any source
images) to a server endpoint you configure in `?genapi=…` or Settings →
Advanced; the response must be an equirect JPEG/PNG **plus a validation
report** from the server-side OpenCV gate (see [VALIDATION](VALIDATION.md)).
Never embeds keys in the client: the endpoint is expected to hold secrets
server-side. When unconfigured it reports `status: "offline"` and the app
falls back to the procedural provider — clearly labeled in the UI as the
development generator, not "AI".

### `ProceduralWorldProvider` (development generator)

The shipped default: a deterministic **environment simulation**. For a
destination node it renders an equirectangular canvas from the world model:

- sky/sun/clouds from `world.theme.palette` + fixed `sunAzimuth` (so the sun
  never jumps between frames),
- fog gradient,
- **landmarks** — churches (nave, tower, clock, cross, rose window, door,
  pitched roof), trees, houses (walls/roof/window sets), signs — projected
  by true bearing (−180°…180°) and pinhole `h = f/distance`,
- zone-specific fields (grass bands for the church grounds, street rows for
  town zones),
- **road synthesis** — the lane is rebuilt per frame viewing both neighbor
  directions, so walking down a street genuinely shows the road beneath you,
- world-anchored ground texture noise (stable across neighboring frames →
  strong feature matches in OpenCV),
- deterministic per-node seed ⇒ re-rendering a node reproduces identical
  pixels (cache identity is trivially satisfied).

Parallax effects (objects realistically shifting between 10 m steps) come for
free because everything is projected from coordinates.

## Sequential generation & worlds

Worlds are delivered **pre-computed as part of the world definition** (the
three demos ship with all nodes), so navigation never blocks. When an editor
adds a node, generation happens on demand: only the frontier node's frame is
produced, then validated. This is the intended pattern for large AI-world
jobs too — one approved frame at a time, extending the cached frontier; it
cannot degrade into "1000 unrelated images".

## In-app validation guardrails

- **Generation gate (JS):** histogram similarity vs. previous frame
  (configurable); failures regenerate once with the rejection recorded in
  `context.feedback.previousRejections`, then flag the node `meta.needsReview`.
- **Upload guardrail:** user-supplied panoramas are checked through the same
  histogram gate against the graph neighborhood and may be accepted with an
  explicit warning state (see SETUP → Editor).
- **Server-side gate (Python/OpenCV):** the authoritative continuity model —
  see [VALIDATION.md](VALIDATION.md) for checks, weights, thresholds, CLI and
  API. It returns structured JSON: per-check scores, weighted continuity
  score, PASS/FAIL + human-readable reasons, advice fields this pipeline
  feeds back into the next generation attempt.
