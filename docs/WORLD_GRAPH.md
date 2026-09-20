# The world graph

`#/worlds` is the connected panorama world. The single most important fact about
it: **the world is a graph, not a gallery.** There is one source of truth, and the
2D map and the 360° viewer both read it. Neither keeps its own copy of position,
state or connectivity, which is what stops them disagreeing.

## Coordinate and id maths

```
index = y * width + x
id    = index + 1
```

On an 8×8 board: `(0,0) → 1`, `(7,0) → 8`, `(0,7) → 57`, `(7,7) → 64`.

**Adjacency is always calculated from coordinates, never inferred from ids.**
This is the rule that makes the whole system trustworthy. Numeric ids are
convenient for keys and for ordering, but `id + 1` is only a neighbour when the
two squares share a row — and `id + width` is only a neighbour when neither
square is blocked. Every neighbour lookup in `WorldGraph` goes through grid
coordinates (`at`, `neighborsOf`, `kingMovesFrom`, `edgeInDirection`), so a
numbering quirk can never imply a connection that is not physically there.

## Movement is king movement, then subtracted

King movement defines the **maximum** possible move set:

```
|dx| <= 1 && |dy| <= 1, and not both zero
```

Eight directions: north, northEast, east, southEast, south, southWest, west,
northWest. A corner square has 3 moves, an edge square 5, an interior square 8.

The world graph is the **actual** allowed movement. Roads, walls and rivers remove
edges from that maximum. So there are two different things here and conflating
them is the classic bug:

- what a square *could* reach on an empty board — the king moves;
- what it *can* reach in this world — the directed edges in the graph.

Before a move is applied, the physical connection has to exist. On the 8×8 board
that is 420 directed king edges at maximum; the shipped world has 404.

## Grid distance is not geographic distance

`metersPerGridUnit` is stored explicitly on the graph (25 m for all three boards).
A grid step is **not** a metre. A cardinal step is `metersPerGridUnit`; a diagonal
step is `√2 × metersPerGridUnit` ≈ 35.355 m on these boards.

Routing uses **Chebyshev** distance as the A* heuristic — `h = max(|dx|, |dy|)` —
because that is the true cost under king movement. Euclidean would be inadmissible
here and would produce non-optimal routes.

## The 2D map

The map is **SVG, not ASCII**. It draws roads, paths, nodes, connections, the
current position, the destination, visited versus unvisited nodes, landmarks, and
the recommended route.

- **Click** selects a node.
- **Double-click** warps there.
- **Clicking the destination** shows the route.

Node states are explicit and rendered distinctly: `UNSEEN`, `VISIBLE`, `VISITED`,
`CURRENT`, `DESTINATION`, `LOADING`, `ERROR`. Visibility is a radius in king moves
(`WorldMapState.visibleRadius`).

`gridToScreen` / `screenToGrid` round-trip exactly, which is asserted for every
cell on both 8×8 and 32×32, and no two distinct cells ever map to the same screen
position.

## Camera-relative movement

`W` does not move the camera. It resolves like this:

```
cameraYaw ──▶ world direction ──▶ quantise to nearest of 8 ──▶ look up graph edge ──▶ next node
```

The quantisation lives in `packages/panorama/src/intent.ts` (`quantiseToDirection`,
`resolveMovementIntent`, `intentFromKey`), and `headingOnArrival` restores the
heading after a transition so you keep facing the way you were going.

**WASD never translates the camera through the panorama texture.** That was a
legacy failure mode and it is a hard requirement here.

## Randomness is quarantined

Gaussian noise is permitted for exactly three things: camera bob, micro yaw/pitch
drift, and timing variation — all with small σ. It must **never** influence:

- node selection
- coordinates
- world geometry
- path correctness

The graph stays mathematically exact. This is not a stylistic preference; a
pathfinder that is occasionally wrong is worse than useless, because you cannot
tell when.

## Transitions

```
preload ──▶ fade / directional ──▶ swap ──▶ restore heading ──▶ settle
```

No jarring black screen. During a transition the view reports *both* the origin
and the target node, which is what keeps the origin visible underneath the
outgoing shell — a QA check that used to treat this as a bug was wrong about it.

`PanoramaCrossfade` owns the two spheres and the progress value. A texture that is
still referenced by the other sphere is never disposed; `setTexture` takes an
explicit `disposePrevious` flag because getting this wrong disposes a texture the
viewer is still rendering.

## Preloading

Neighbours are preloaded prioritising the current direction of travel, through an
LRU cache. **Never hold 1,000+ full-resolution panoramas** — the 32×32 board has
903 nodes and loading them all would exhaust memory.

`PanoramaCache` and `rankPrefetch` (`apps/web/src/worlds/preloader.ts`) handle
this. Priority is a sort key where **higher runs first**, which is worth stating
because the opposite reading is intuitive and a QA check originally got it wrong.

`nearby(gridX, gridY, radius)` is backed by a spatial hash, so nearby-node queries
stay cheap at scale: 903 queries at radius 3 take ~3.7 ms total.

## Landmarks

Landmarks get persistent ids and vector relationships. `landmarkVector` gives the
bearing and distance from a node to a landmark, and distance to a landmark must
shrink monotonically along a route to it — that is asserted, and it reaches 0.

## Generation

A frontier queue walks outward from where the player can already stand
(`runFrontier`). Every candidate node passes a continuity gate before entering the
world:

| Check | Rejects |
|---|---|
| `plate-known` | an unknown panorama plate URL |
| `geometry-bounds` | a `worldX` off the grid, a `gridX` of −1 |
| `geometry-scale` | coordinates inconsistent with the scale |
| `lighting-envelope` | a `sunDirection` of 400° |
| `seam-neighbours` | a 120° sun jump at a seam, a 4× exposure jump, a weather change across a seam |
| `landuse-plausible` | implausible adjacency of land use |
| `provenance-present` | an empty licence, or a `googleapis/.../streetview` reference |

OSM and CC-BY-SA references are accepted; Street View URLs are rejected. Street
View is **geographic reference only**, per its terms — there is no scraper. The
generated layer is separate from the reference layer, and every image carries
provenance and licence metadata.

`lighting.timeOfDay` is a clock string like `"16:30"`, not a `dawn|day|dusk|night`
enum. `parseClockTime` and `isPlausibleSunTime` derive a plausibility band for the
sun azimuth, which catches a noon sun stamped onto a dusk plate.

## The three boards

| Board | Nominal | Reachable nodes | Directed edges | Landmarks | Metres/unit |
|---|---|---|---|---|---|
| small | 8×8 = 64 | **63** | 404 | 1 | 25 |
| medium | 20×20 = 400 | **363** | 2,462 | 3 | 25 |
| large | 32×32 = 1,024 | **903** | 6,186 | 3 | 25 |

Counts fall short of nominal because blocked cells are removed from the graph
entirely. A test asserts `occupancy` ≡ `graph.size`, so the two cannot silently
diverge.

Generation stays close to linear: 8×8 → 32×32 is 16× the cells for 7.7× the
generation time (0.60 ms → 4.60 ms).

The engine scales 64 → 400 → 1,024+ without rewriting. The same `WorldGraph`,
the same renderer, the same map component — only the spec changes.
