# Willow Parish — AI image generation loop

This file drives the never-stop generation loop for the AI real demo world.
A stateless agent can read ONLY this file plus the asset folders to know
exactly what to generate next. Continue until every box is ticked.

## World spec (the ground truth)

- World: `demo_willow_parish` — photoreal fictional English village
  with honey limestone cottages, dark slate roofs, willow trees,
  overcast spring sky, no people, no cars, no text.
- Spots: 34 named + 285 staged-recursive waypoint densification = **319 spots**
  (nodes `n1`..`n319`), one connected tree of 318 edges, every end
  dead-ends at a visible barrier on the 2D map.
- Modes: day / rain / night for each spot → **957 target frames**.
  Waypoints come from STAGED recursive midpoint splitting: 55 m stage
  (n35..n58), 35 m stage (n59..n81), 8 m stage (n82..). Every hop ≤ 8 m —
  one WASD press = one real stride = one photo taken 5–8 m away; map
  distance and image distance are the same thing (user directive).
- Frame: seamless equirectangular 360 photo, 2:1 ratio → normalize every
  generated frame to **2048x1024** (Lanczos) with a light micro contrast
  pass before committing (script below).
- **METHOD (user directive, iteration 14):** every waypoint neighbor frame
  is a CAMERA-SHIFT EDIT of an existing chained frame — the source jpg is
  the image input and the prompt only moves the camera ~6–7 m forward /
  backward / left / right, so the street cannot hallucinate between hops.
  Text-only prompts are reserved for brand-new named views.
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
| n8..n14     |  Y    |  Y     |  -      |
| n15..n17    |  Y    |  -     |  -      |
| n18..n27    |  Y    |  -     |  -      |
| n28..n34    |  Y    |  -     |  -      |
| n35..n44    |  Y    |  -     |  -      |
| n45..n54    |  Y    |  -     |  -      |
| n55..n57    |  Y    |  -     |  -      |
| n58         |  -    |  -     |  -      |
| n59..n68    |  Y    |  -     |  -      |
| n69..n78    |  Y    |  -     |  -      |
| n79..n81    |  Y    |  -     |  -      |
| n82..n91    |  Y    |  -     |  -      |
| n92..n101   |  Y    |  -     |  -      |
| n102        |  Y    |  -     |  -      |
| n103..n111  |  Y    |  -     |  -      |
| n112..n120  |  Y    |  -     |  -      |
| n121..n123  |  -    |  -     |  -      |
| n124        |  Y    |  -     |  -      |
| n125..n161  |  -    |  -     |  -      |
| n162        |  Y    |  -     |  -      |
| n163..n166  |  -    |  -     |  -      |
| n167..n173  |  Y    |  -     |  -      |
| n174..n200  |  -    |  -     |  -      |
| n201..n202  |  Y    |  -     |  -      |
| n203..n225  |  -    |  -     |  -      |
| n226        |  Y    |  -     |  -      |
| n227..n243  |  -    |  -     |  -      |
| n244..n247  |  Y    |  -     |  -      |
| n248..n255  |  -    |  -     |  -      |
| n256        |  Y    |  -     |  -      |
| n257..n311  |  -    |  -     |  -      |
| n312        |  Y    |  -     |  -      |
| n313..n319  |  -    |  -     |  -      |

## Iterations

| # | Date       | Batch produced                    | Frames | Iteration result |
|---|-----------|-----------------------------------|--------|------------------|
| 1 | 2026-09-21 | day n8..n17                        | 10 926 | verified, committed e9c3df7 |
| 2 | 2026-09-21 | day n18..n27                       | 10 936 | verified, committed 6f7df74 |
| 3 | 2026-09-21 | world densified 34→58, map surroundings + barriers + GENERATION-LOG.md created | 0 | tests 35 + 58 green |
| 4 | 2026-09-21 | day n35..n44 waypoints (main street mids, manor mile, church path, west bend approach) | 10 946 | normalized, committed df4c912 |
| 4 | 2026-09-21 | day n35..n44 waypoints (main street mids, manor mile, church path, west bend approach) | 10 946 | normalized, committed df4c912 |
| 5 | 2026-09-24 | day n45..n54 waypoints (inn mews corner, west hedgeline, manor mile limes, manor gate approach, inn front, main east end, meadow gate, croft gate, croft hedgerow, Westfold path) | 10 | normalized, spot-verified, committed aba8eb1 |
| 6 | 2026-09-24 | world re-densified RECURSIVELY 58→81 spots (threshold 55→35 m, seed pass preserves n35..n58 positions; max hop now 30 m); walk-feel engine js/viewer/walk-steps.js (recursive 5 m stride schedule + quantized dolly + head-bob, Motion pop gains "Walk" default style); day n59..n68 (main street mids y 85..535) | 10 | tests 36 core + 58 harness green; normalized, 2 spot-verified, committed d5df8fa |
| 7 | 2026-09-25 | walk pacing made SLOWER per user directive (950 + 200 ms per stride, dolly phase 68% of the hop, stray \n in index.html motion pop fixed); day n69..n78 (village-north thinning, orchard junction, manor lane ha-has/lime avenue/parkland/manor gates, church path yews→stile, pond walk) | 10 | tests 36 core + 58 harness green; normalized, 2 spot-verified, committed fcf76a4 |
| 8 | 2026-09-25 | DAY COMPLETE 81/81: day n79 (school bell gable on School Rise), n80 (smithy forge mouth, anvil, glow, horseshoes), n81 (orchard walk far end, beehives, pasture gate); rain sweep STARTED as day-frame edits: rain n8..n14 (wet lanes, puddles, rain streaks, heavy sky) | 10 | spot-verified n80 + n11; normalized; suites green; pending commit |

| 9 | 2026-09-25 | 8 m stride densification: staged recursion (55→35→8 m) takes the world to 319 spots / 318 edges, every hop ≤ 7.5 m; older frames n35..n81 positions untouched; mini map draws waypoints small and faint, named spots full-size; day n82..n91 (main-street south stride frames) | 10 | tests 36 core + 58 harness green; normalized, 2 spot-verified, pending commit |

| 10 | 2026-09-25 | WASD trapwire crosscheck added to core tests (straight-segment hop < 8 m forward; A/D never yields a long lateral hop; junction laterals resolve ≤ 8 m); day n92..n101 terrace/school-turn/forge-chimney/northern thinning stride frames | 10 | tests 37 core green; normalized, 2 spot-verified, pending commit |

| 11 | 2026-09-25 | A/D strictness locked: coneDeg 45 verified in resolveEdge, crosscheck test strengthened to assert left/right STRICTLY blocked on a straight segment; day n103..n111 (orchard track mouth, manor-lane ha-has, lime avenue, trough + crest stone, clock-tower rise, manor-gates bend) | 9 (+n102 deferred: 10/turn cap hit) | tests 37 core green; normalized, 2 spot-verified, pending commit |

| 12 | 2026-09-25 | live WASD simulation printed (6 W presses = 7.5 m each from the porch, A/D strictly blocked mid-segment, S walks 7.5 m back); day n102 + n112..n120 (hedged lane, upper manor lane, manor gates close, south church approach, lych-gate corner, churchyard corner, yew-avenue strides x4 to the Glebe stile) | 10 | suites green; normalized, 2 spot-verified, pending commit |

| 13 | 2026-09-25 | live preview server restarted (port 8080) for hands-on WASD; BACKFILL: n28..n34 (orchard row/end, manor mile, manor gates close, meadow rise mouth + far gate, Pinfold wall) + n55..n57 (orchard mouth, orchard mid-row, meadow-rise turn) — gap now only n58 | 10 | suites green; normalized, 2 spot-verified (manor gates chain to n48..n113 ✓), pending commit |

| 14 | 2026-09-25 | USER DIRECTIVE — CAMERA-SHIFT EDITS become the mandatory fill method (kills hallucination at hops): neighbor panoramas must be generated as EDITS of an existing chained frame, prompt pattern below; proof: n87 → n172/n173 (6 m forward/backward — same inn, same baskets, coherent parallax), n60 → n167/n168, junction n2 → n169/n170/n256 (forward/backward/LEFT-strafe onto Green Road), junction n6 → n201/n202/n312 (forward/backward/RIGHT-strafe onto Meadow Rise) | 10 | chain verified visually n87↔n172; normalized; suites green; pending commit |

## Next batch (iteration 15)

1. CAMERA-SHIFT ONLY from here on: take a frame whose neighbors are missing
   (compute via the coverage audit one-liner in §3), generate each missing
   neighbor as an edit `[images: day/nX.jpg]` of the chained frame:
   - W (forward): "shift the camera about 6 metres NORTH/FORWARD along the
     street: same scene, only the viewpoint changes, correct parallax"
   - S (backward): same with SOUTH/BACKWARD
   - A (leftward)/D (rightward): only at junctions, ~7 m onto the side lane
   Fill in rings around existing frames until day coverage is 319/319;
   then resume rain/night via day-frame edits.
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
4. AUTHORITATIVE coverage audit (run instead of trusting the table):
   `node --input-type=module -e "import('./js/worlds/willow-parish.js').then(async m=>{const ids=m.densify().nodes.map(n=>n[0]);const fs=await import('fs');const have=new Set(fs.readdirSync('assets/willow/day').filter(f=>f.endsWith('.jpg')).map(f=>+f.slice(1,-4)));console.log(ids.filter(i=>!have.has(i)).join(','))})"`
