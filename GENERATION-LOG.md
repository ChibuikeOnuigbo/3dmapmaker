# Willow Parish — AI image generation loop

This file drives the never-stop generation loop for the AI real demo world.
A stateless agent can read ONLY this file plus the asset folders to know
exactly what to generate next. Continue until every box is ticked.

## World spec (the ground truth)

- World: `demo_willow_parish` — photoreal fictional English village
  with honey limestone cottages, dark slate roofs, willow trees,
  overcast spring sky, no people, no cars, no text.
- Spots: 34 named + 24 waypoint densification = **58 spots**
  (nodes `n1`..`n58`), one connected tree of 57 edges, every end
  dead-ends at a visible barrier on the 2D map.
- Modes: day / rain / night for each spot → **174 target frames**.
- Frame: seamless equirectangular 360 photo, 2:1 ratio → normalize every
  generated frame to **2048x1024** (Lanczos) with a light micro contrast
  pass before committing (script below).
- Grounding is identity chaining: every new frame is generated with the
  committed frames as the fixed style reference — never invent a
  different village. Gem AI never lan, never drift off for ms.

## Prompt style block (reuse verbatim, swap the location sentence)

```
Seamless 360 degree equirectangular photograph, 2 to 1 aspect,
photorealistic, of the fictional English village Willow Wood.
<LOCATION SENTENCE>. Warm honey limestone cottages with dark slate
roofs, willow trees, overcast spring daylight, soft even sky, no
people, no cars, no text. Same village identity as the committed
frames, landmarks must sit on the bearing the 2D map dictates.
VR ready equirectangular projection.
```

Rain variant: same but drizzle, wet asphalt reflections, grey flat sky.
Night variant: same but dusk, warm window glow, cold blue shadows; the
church windows glow gently.

## Normalize after every batch

```
python3 -m venv .venv && .venv/bin/pip install opencv-python-headless
.venv/bin/python tools-render/normalize-willow.py   # 2048x1024 + light contrast
```

## Frame status (tick as generated, Y = present, - = pending)

| Spot        | n Day | n Rain | n Night |
|-------------|-------|--------|---------|
| n1..n7      |  Y    |  Y     |  Y      |
| n8..n17     |  Y    |  -     |  -      |
| n18..n27    |  Y    |  -     |  -      |
| n28..n34    |  -    |  -     |  -      |
| n35..n44    |  Y    |  -     |  -      |
| n45..n54    |  Y    |  -     |  -      |
| n55..n58    |  -    |  -     |  -      |

## Iterations

| # | Date       | Batch produced                    | Frames | Iteration result |
|---|-----------|-----------------------------------|--------|------------------|
| 1 | 2026-09-21 | day n8..n17                        | 10 926 | verified, committed e9c3df7 |
| 2 | 2026-09-21 | day n18..n27                       | 10 936 | verified, committed 6f7df74 |
| 3 | 2026-09-21 | world densified 34→58, map surroundings + barriers + GENERATION-LOG.md created | 0 | tests 35 + 58 green |
| 4 | 2026-09-21 | day n35..n44 waypoints (main street mids, manor mile, church path, west bend approach) | 10 946 | normalized, committed df4c912 |
| 4 | 2026-09-21 | day n35..n44 waypoints (main street mids, manor mile, church path, west bend approach) | 10 946 | normalized, committed df4c912 |
| 5 | 2026-09-24 | day n45..n54 waypoints (inn mews corner, west hedgeline, manor mile limes, manor gate approach, inn front, main east end, meadow gate, croft gate, croft hedgerow, Westfold path) | 10 | normalized, spot-verified, pending commit |

## Next batch (iteration 6)

1. day n55..n58 (4 frames) — the remaining densified waypoints; list names via
   `node -e "import('./js/worlds/willow-parish.js').then(m=>console.log(m.NODES.length))"`
   or read the waypoint suffixes from the densify output — then DAY is COMPLETE (58/58).
2. Then RAIN n1..n58 in batches of 10 and NIGHT n1..n58 in batches of 10 —
   keep the LOCKED style block identical, only swap the lighting/weather line:
   - RAIN: "steady rain, wet reflective cobbles and puddles, heavy overcast, umbrellas on porches"
   - NIGHT: "night, warm lantern and window glow, moonlit slate roofs, deep blue sky, street lamps on the green"
   Rain/night frames for n1..n7 already exist — resume rain/night at n8.
3. After every batch: `.venv/bin/python tools-render/normalize-willow.py`
   (recreate `.venv` with opencv-python-headless first if missing),
   spot-verify 2 frames via read_file, tick the table, append the iteration row, commit.
   NEVER stop the loop; the user says "continue" to trigger the next batch.
