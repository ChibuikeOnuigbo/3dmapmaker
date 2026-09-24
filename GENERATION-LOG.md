# Willow Parish — AI image generation loop

This file drives the never-stop generation loop for the AI real demo world.
A stateless agent can read ONLY this file plus the asset folders to know
exactly what to generate next. Continue until every box is ticked.

## World spec (the ground truth)

- World: `demo_willow_parish` — photoreal fictional English village
  with honey limestone cottages, dark slate roofs, willow trees,
  overcast spring sky, no people, no cars, no text.
- Spots: 34 named + 47 recursive waypoint densification = **81 spots**
  (nodes `n1`..`n81`), one connected tree of 80 edges, every end
  dead-ends at a visible barrier on the 2D map.
- Modes: day / rain / night for each spot → **243 target frames**.
  Waypoints come from RECURSIVE midpoint splitting until every edge is under
  35 m (seed pass keeps n35..n58 at their original spots forever).
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
| n59..n68    |  Y    |  -     |  -      |
| n69..n81    |  -    |  -     |  -      |

## Iterations

| # | Date       | Batch produced                    | Frames | Iteration result |
|---|-----------|-----------------------------------|--------|------------------|
| 1 | 2026-09-21 | day n8..n17                        | 10 926 | verified, committed e9c3df7 |
| 2 | 2026-09-21 | day n18..n27                       | 10 936 | verified, committed 6f7df74 |
| 3 | 2026-09-21 | world densified 34→58, map surroundings + barriers + GENERATION-LOG.md created | 0 | tests 35 + 58 green |
| 4 | 2026-09-21 | day n35..n44 waypoints (main street mids, manor mile, church path, west bend approach) | 10 946 | normalized, committed df4c912 |
| 4 | 2026-09-21 | day n35..n44 waypoints (main street mids, manor mile, church path, west bend approach) | 10 946 | normalized, committed df4c912 |
| 5 | 2026-09-24 | day n45..n54 waypoints (inn mews corner, west hedgeline, manor mile limes, manor gate approach, inn front, main east end, meadow gate, croft gate, croft hedgerow, Westfold path) | 10 | normalized, spot-verified, committed aba8eb1 |
| 6 | 2026-09-24 | world re-densified RECURSIVELY 58→81 spots (threshold 55→35 m, seed pass preserves n35..n58 positions; max hop now 30 m); walk-feel engine js/viewer/walk-steps.js (recursive 5 m stride schedule + quantized dolly + head-bob, Motion pop gains "Walk" default style); day n59..n68 (main street mids y 85..535) | 10 | tests 36 core + 58 harness green; normalized, 2 spot-verified, pending commit |

## Next batch (iteration 7)

1. day n69..n81 (13 frames → batch 10 + batch 3): n69..n74 main street mids
   (y 585..835, northern end thinning to pasture), n75..n77 church path mids
   (stone path between yews), n78 pond walk mid, n79 school rise mid,
   n80 forge lane mid, n81 orchard walk far end. Then DAY is COMPLETE (81/81).
2. Then RAIN and NIGHT sweeps n1..n81, batches of 10. CRITICAL for identity
   match: generate rain/night frames as EDITS of the committed day jpg
   (pass images: [assets/willow/day/nX.jpg]) so buildings/street stay
   pixel-identical; only weather/lighting changes:
   - RAIN prompt: "same exact panorama, every building and object in the same
     place; now steady rain, wet reflective street and cobbles, puddles,
     heavy overcast grey light, drips off eaves"
   - NIGHT prompt: "same exact panorama, every building and object in the same
     place; now night, warm lantern glow and lit windows, moonlit slate roofs,
     deep blue sky, street lamps lit on the green"
   Rain/night n1..n7 already exist (older direct generations — regenerate as
   edits for consistency if they clash; low priority).
3. After every batch: `.venv/bin/python tools-render/normalize-willow.py`
   (recreate `.venv` with opencv-python-headless first if missing),
   spot-verify 2 frames via read_file, tick the table, append the iteration
   row, commit. NEVER stop the loop; the user says "continue" to trigger
   the next batch.
