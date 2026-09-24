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
| n45..n58    |  -    |  -     |  -      |

## Iterations

| # | Date       | Batch produced                    | Frames | Iteration result |
|---|-----------|-----------------------------------|--------|------------------|
| 1 | 2026-09-21 | day n8..n17                        | 10 926 | verified, committed e9c3df7 |
| 2 | 2026-09-21 | day n18..n27                       | 10 936 | verified, committed 6f7df74 |
| 3 | 2026-09-21 | world densified 34→58, map surroundings + barriers + GENERATION-LOG.md created | 0 | tests 35 + 58 green |
| 4 | 2026-09-21 | day n35..n44 waypoints (main street mids, manor mile, church path, west bend approach) | 10 946 | normalized, pending commit |

## Next batch (iteration 5)

day n35..n44 waypoints (prompt: "midway along <EDGE> between <A> and <B>"):
35 mid main 060-160, 36 mid 160-260, 37 mid 260-360, 38 mid 360-460,
39 mid 460-560, 40 mid 560-660, 41 mid 660-n7..w30? (use EDGES order),
42 mid w30-manor_mile, 43 mid w30-main? no — read densified output order
via a quick node script before prompting; then n45..n58 day;
then rain n1..n10, night n1..n10, etc.
