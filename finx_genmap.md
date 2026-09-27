# finx_genmap.md — camera-shift fill ledger (STANDING COMMAND)

> **Purpose (user directive):** kill hallucination and jumping between hops.
> Every neighbor of an *existing* photo must be generated as a CAMERA-SHIFT
> EDIT: the existing jpg is passed back to the generator as image data, and
> the prompt asks for the SAME panorama with the camera moved ~5–8 m in one
> direction — **W (forward), S (backward), A (leftward), D (rightward)**.
> Fill the holes between logically distant existing frames ring by ring.

## Protocol

1. **Anchors:** the existing day frames, in img order, are
   `point_correct_1, point_correct_2, ...` (point_correct_1 = n1, the bottom
   of Willow Street). Current coverage: 129 existing anchors + new shifts.
2. **Per anchor:** generate 10–20 camera-shift frames — W/S (and A/D at
   junctions only; bushes/walls stay blocked by design) — stepping from the
   anchor toward the NEXT EXISTING point along each direction (+x first).
   Stop that branch when the chain lands on an existing frame.
3. **Record everything here:** each iteration logs the anchor, direction,
   new img numbers, and the counts (if 20 frames were made, say 20).
4. **Resume:** on ANY user prompt, come back to THIS file, find the cursor,
   compute the next anchor/branch, continue.
5. **User overrides:** "don't continue next point, rather continue THIS
   point" = user is not happy with the number of extra steps → generate
   MORE frames for the SAME anchor (sub-strides), update the counts here.
6. **Cursor** tracks `{ anchor, branch direction, next hop }` below.

## Camera-shift prompt pattern (edit mode)

`images: [day/nX.jpg]` + "360 equirectangular panorama edit, 2:1. Keep this
exact scene — every cottage, wall, hedge and tree in its true place — but
shift the camera about N metres <DIR>: only the viewpoint changes, correct
parallax. Same overcast daylight, no people, no text."

## Ledger

| Iter | Anchor (point) | Branch | New frames (count) | New imgs | Chain verified |
|------|----------------|--------|--------------------|----------|----------------|
| 15 | point_correct_1 = n1 (willow_060, Willow Street 60 m) | S → n82; N → n114; W-A → West Bend chain | **7** | n162 (6.3 m S), n226 (7.5 m N), n244 (6.9 m W/A), n124 (6.9 m W ← n244), n245 (6.9 m E ← n44), n246 (6.9 m W ← n44), n247 (6.9 m E ← n13) | ✓ n244→n124 visual: same flint cottage/rose gate/spire, correct parallax |
| 16 | ring cells around anchors n82/n59/n83/n35/n86/n36/n88 (streetside) + n246/n256/n312 (lane seams) | S chain ×7 + W seams ×2 + E seam ×1 | **10** | n125 (6.9 m W ← n246) — closes the n1–n13 seam; n130 (6.9 m W ← n256, Green Road); n158 (6.9 m E ← n312, Meadow Rise); n163 (6.3 m S ← n82), n164 (S ← n59), n165 (S ← n83), n166 (S ← n35), n171 (S ← n86), n174 (S ← n36), n175 (S ← n88) | ✓ n163←n82 visual: same willow, church tower, cottages. ⚠ n125 drifted to an open-meadow look — RE-CHECK against n246/n247 (regenerate if it offends) |
| 17 | USER OVERRIDE: supersede ring-resume — go back to point_correct_1 and add MORE steps to the +x chains; PLUS user anti-drift audit command | 4 m sub-stride stage added to densify (637 nodes / 636 edges / max hop 3.75 m, all earlier imgs unchanged); OpenCV auditor `tools-render/chain-audit.py` (collapsed-branch walkable pairs: HSV correl + sky-band Δ + exposure Δ) ran over all frames: 145 pairs, worst breaks fixed | **10 regenerations** | n119←n117, n124←n246, n116←n115, n244←n1, n82←n162, n90←n62, n91←n63, n97←n66, n93←n64, n17←n78 | ✓ breaks n11↔n119 (−0.68), n124↔n245 (−0.32), n63↔n91, n82↔n162, n97-family all cleared. Residual offenders: n3↔n45 (−0.654), n9↔n116 (canopy-vs-open false-positive risk + palette), n1↔n244 (still −0.146, skyΔ 83 — regenerate n244 again next turn), n37↔n91, n4↔n94 |
| 18 | finish audit-fix queue, then point_correct_2 (n2, green junction) +x fill | point-1 sub-strides restored + n244 re-fix with hard sky lock; point-2 north chain n335..n332 + west knot n510 | **10** | n320←n1, n321←n162, n322←n82, n323←n163 (3.1 m sub-strides); n244←n1 (re-fix #2); n335←n2, n334←n169, n333←n85, n332←n168 (point-2 north chain); n510←n2 (point-2 A-branch 3.4 m W) | ⚠ audit: n335 itself drifted (−0.29, skyΔ 74) — queued for pass 2; n320↔n162 flagged 0.06; n3↔n45 (−0.654) still open; rest normalized |
| 19 | anti-drift audit pass 2 + point-1 sub-stride fill | auditor v2: SIFT keypoint persistence + matched-patch LAB drift (door/car material changes; SAM substitute — no GPU in sandbox); regenerations with sky-lock; brightened edits fixed by per-channel BGR affine (sky+expo matched to source) | **10** | n335←n169 (re-fix ✓), n320←n162 (re-fix ✓), n448←n1, n449←n226, n450←n114, n451←n43, n486←n1, n487←n124, n45←n14, n94←n4 (+BGR affine on n448/n486/n320/n94) | ✓ cleared: n169↔n335, n2↔n335, n162↔n320, n1↔n244, n1↔n448/n486, n4↔n94, n14↔n45. Still open: n3↔n45 (−0.654→−0.038; n3 itself is the dark-exposure anomaly — queue regen n3←n89), n37↔n91, n17↔n48, n16↔n48, n101↔n201, n226↔n448 (underlying n1↔n226 family gap) |
| 20 | full OpenCV pass: offlims offenders + hole fill | 4 chronic offenders regenerated with sky-lock + exposure-lock; 6 direct holes filled from clean endpoint pairs; **DEAD END recorded: global exposure harmonization** (23 frames BGR-affine to family median) destroyed histograms via 2.3× gain + clipping → correlations collapsed — REVERTED (bb880b0); small per-pair affine (≤1.3 gain, single-source match) remains valid | **10** | n3←n89 (0.95 ✓), n48←n17, n201←n101, n37←n91, n336←n170, n337←n86, n338←n171, n339←n171, n340←n61, n511←n130 (+affine) | ✓ cleared: n3-family (n3↔n89/n90), n16↔n48, n17↔n48, n101↔n201, n37↔n91, n3↔n45. New/remaining: n6↔n201 (−0.20, n6 is offender — queue n6←n202 ans 0.87), n244↔n486 (MAT 39), n172↔n340 (STR), n256↔n511 (west family gap), n1↔n226/n320 family gap |
| 21 | hole fill + seam management at dark n1 corner | fixes n6←n202 (✓ clean), n340←n172 (n172-side clean; n61-side now weak STR — midpoint knot can't match both ends, kept, queue densify), n46←n14 (**both seams closed**); ring branch n32→n57 unlocked from both ends (n629←n32, n626←n57); fills n341←n172, n342←n87, n512←n130, n513←n47. **DEAD END #2 recorded: exposure-bridge frames** (n448, n486 pulled to sky≈200) match NEITHER family — the two families differ in sky saturation (colored vs flat white), not just brightness → reverted; permanent rule: keep sub-strides in the source's family, accept BOUNDARY seams as documented class (n448↔n226, n486↔n244, n6↔n201, n9↔n116); clamp per-pair affine gains to 0.65–1.35 | **10** | n6←n202, n340←n172, n629←n32, n626←n57, n341←n172, n342←n87, n512←n130, n513←n47, n486←n487→reverted, n46←n14 | ✓ cleared: n6↔n202, n172↔n340, n32↔n629, n57↔n626, n172↔n341, n87↔n341/n342, n173↔n342, n47↔n513, n130↔n513, n46-family (14/15/45). Seams accepted: n244↔n486, n226↔n448, n6↔n201, n9↔n116 |
| 22 | ring middle + dense junction fills | n315←n629, n314←n626 (ring branch 32→57 now holds n32—629—315 and n314—626—n57 bookends, all pairs clean); fills n343←n173, n344←n36, n345←n174, n346←n88, n330←n84, n331←n167 (15/15 walk pairs clean); n321 down-crush to n162 family (skyΔ 83.5→7.1; bright-neighbor seam moved to n82↔n321, documented) | **9** | n315←n629, n314←n626, n343←n173, n344←n36, n345←n174, n346←n88, n330←n84, n331←n167, n321 (per-channel down-crush, gain floor 0.33 — down-crush safe, up-gain+clip was the bb880b0 disaster) | ✓ all new pairs clean. Seams documented: n82↔n321, n244↔n486, n226↔n448, n6↔n201, n9↔n116, n162↔n321 (MAT 37 borderline) |
| 23 | mass fill begins (user: "do up to 10000") — **platform cap: max 10 image generations per turn**, so progress = ≤10 new frames/turn, many turns | wave A: south-lane + east-arc 1-hop fills from `tools-render/next-holes.mjs` planner (new tool: walks densify, ranks hole knots whose nearest existing frame is 1 hop away and whose both-side walk pair is unflagged) | **10** | n227←n450, n324←n59, n325←n83, n326←n83, n328←n35(+affine), n329←n84, n347←n62, n348←n62, n349←n89, n350←n89 (n227 +affine partial) | audit 190 edges / 136 suspects (noise floor stable); wave B queued: n351/352←n3, n353/354←n90, n355/356←n63, n357/358←n91, n359←n37, n364←n64 |
| 24 | wave B (mass-fill) | east-arc 1-hop fills from planner; all sources settled frames | **10** | n351←n3, n352←n3, n353←n90, n354←n90, n355←n63, n356←n63, n357←n91, n358←n91, n359←n37, n364←n64 | ⚠ one hard break surfaced: n227↔n451 (STR sift 4) — wave-A midpoint n227 (sourced n450/n114-branch) vs n451 (n43-branch): the two branch looks never met; diagnose: if n114-side ∪ n43-side is a genuine originals-boundary → document as seam; else regen n227←n451. Suspects 136→140 (noise floor +new seams) |
| 25 | wave C (mass-fill) | junction fix + west/east arc fills | **10** | n227←n451 (junction re-fix — **both n227↔n451 and n450↔n227 now clean**), n365/366←n93, n367/368←n4, n369←n94, n372←n65, n373/374←n95, n375←n38 (3 frames +affine) | 11/11 new pairs clean. New soft-hard flag: n35↔n328 (correl −0.195, drift 15.4 MAT, sift 223 — wave-A affine era frame; queue regen ←n35 no-affine in wave D). Suspects 141 (= noise floor + documented seams) |
| 26 | wave D — USER DIRECTIVE: chained point-walk ("fill gaps: choose one point and just move by ~6m, same scene") | single-point chained walking: TWO parallel chains closing the ring branch from both ends (halves drift compounding), each frame a 5 m move sourced from the PREVIOUS chained frame | **10** | n630←n32, n316←n630, n631←n316, n160←n631, n632←n160 ‖ n637←n33, n319←n637, n636←n319, n161←n636, n635←n161 | **10/10 consecutive chain pairs audit-clean** — chained generation holds; chains now face each other across the last 5 knots (317, 633, n58-original-gap, 634, 318). Discovery: **n58 is the ONLY missing original of n1..n60** — branch passes through it; wave E closes 632→635 and fills n58 |
| 27 | wave E — ring branch CLOSED + USER DIRECTIVE: object recheck (cars, sheep, animals) | chained walk finished the n32→n33 branch (all 18 knots now framed); every prompt now carries explicit object-preservation ("keep any parked cars exactly as they are… keep any animals exactly as they are… do not add, remove, move or recolor any object") | **9** | n317←n632, n633←n317, **n58←n633 (only missing original of n1..n60 — FILLED)**, n634←n58, n318←n634 (meets n635 — branch complete 32→33) + n328←n35 (prompt-only regen — clean, CONFIRMS the wave-A affine had damaged correl) + n628←n315, n627←n314, n514←n513 | **10/10 branch-close pairs clean; ZERO object-drift (MAT) flags on the whole 16-knot branch** — LAB matched-patch check: no recolored car/object anywhere. Visual: n58 keeps the chained sheep (same meadow-side sheep inherited intact). New seam flag n366↔n367 (wave-C sub-strides from n93/n4 families meeting) — queue wave F |
| 28 | wave F | seam fix n367←n366 (closed ✓) + **ring-2 center n159←n628 — hole 32→57 CLOSED, both walks (628↔159, 159↔627) clean** + planner fills n176←n348, n177←n350, n376←n38, n377/378←n96, n379←n66 (all clean). **Failure class found: stormy-dark-sky break** — n515/n516 chained west came out with dark saturated storm sky (skyL 131/sat 67 vs family 237/6): not exposure-fixable (sky band DARKER than global mean breaks the two-point affine; bleach experiment spiked to Δ141 → deleted both, queued regen with "flat uniform white-grey overcast, no storm clouds" phrasing) | **10** (8 kept, 2 discarded) | n367←n366, n159←n628, n176←n348, n177←n350, n376←n38, n377←n96, n378←n96, n379←n66 ‖ ~~n515/n516~~ deleted | 9/9 kept pairs clean + 159 double-clean. Object-drift (MAT) flags on new frames: 0. West chain cut cleanly at n514; n515/n516 regen next wave |
| 29 | wave G — USER: "do 20 img per run" — **no platform path to 20: generate_image is hard-capped at 10/turn (limit error verified in wave B); pace stays 10/turn** | west chain regen + planner fills | **10** | n515←n514, n516←n515 (**storm-guard phrasing works**: both sat 6 flat overcast, matching family after previous deletion), n178←n352, n180←n356, n181←n358, n184←n364, n186←n368, n188←n372, n189←n374, n380←n66 (n180/n186 +affine) | 10/10 pairs clean. Object-drift (MAT) on new frames: 0. West road chain re-established past n514 |

## Anti-drift rule (user directive, permanent)

- After every batch: run `.venv/bin/python tools-render/chain-audit.py --top 15`.
- A pair with correl < −0.05 OR skyΔ > 40 = a hallucination break → regenerate
  the outlier frame as a camera-shift edit of its best-correlated neighbor
  (same prompt + "keep the SAME overcast grey-white sky and identical
  materials"). Cross-canopy pairs (churchyard yews vs open sky) may show
  skyΔ false positives — judge by correl first.
- The committed audit report lives at `tools-render/chain-audit.txt`.

## Ring optics (updated state)

- Street S-chain holes closed this iter: n163–n166, n171, n174, n175.
- n58's neighbors (n317/n318) are themselves missing → n58 unlocks when
  the ring reaches them (they sort at ring imgs 317/318).
- Remaining holes adjacent to existing frames: continue ring fill from
  img order (ring scanner re-run each iteration).

## Cursor

`anchor=mass-fill mode (user: "continue do up to 10000"; platform cap ≤10 generations/turn → one wave per turn). Loop for every turn: (1) recover if wiped (fetch + reset --hard FETCH_HEAD, rebuild .venv); (2) run tools-render/next-holes.mjs → top 8 fills ranked 1-hop + seamOk (SKIP any whose source was generated in the PREVIOUS wave — one wave of settling before chaining); (3) PLUS up to 2 fix-ups flagged in the previous wave's audit; (4) generate with sky-lock+exposure-lock prompt, normalize 2048×1024, affine vs source (>22Δ, down-crush≤0.33 floor / up-gain≤1.35); (5) commit+push EARLY; (6) full audit → overwrite chain-audit.txt; (7) ledger row + this cursor; (8) suites. Wave H (next 10 — cap proven immovable): chained west walk continues n517<-n516, n518<-n517 ... while knots exist (check planner for road-W continuation past n516; if chain ends at n47, switch to next longest hole run) + planner top-up EXCLUDING wave-G sources (expect n190/191, n370/371, n381/382, ring-2 west knots, n543+). Storm-guard now standard: sky-band sat>50 AND skyL<source-40 => discard instantly, regen with "flat uniform bright white-grey overcast sky, no storm clouds, no darkening, no blue patches". LEDGER RULE CHANGE: append new rows via python insert-after (never edit_file replace of the previous row — it silently clobbered rows 5 times; all restored from git). Object check STANDARD: prompts keep cars/animals exact; MAT column reported per wave; one visual spot-check per wave.`
