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
| 21 | hole fill + seam management at dark n1 corner | fixes n6←n202 (✓ clean), n340←n172 (n172-side clean; n61-side now weak STR — midpoint knot can't match both ends, kept, queue densify), n46←n14 (**both seams closed**); ring branch n32→n57 unlocked from both ends (n629←n32, n626←n57); fills n341←n172, n342←n87, n512←n130, n513←n47. **DEAD END #2 recorded: exposure-bridge frames** (n448, n486 pulled to sky≈200) match NEITHER family — the two families differ in sky saturation (colored vs flat white), not just brightness → reverted; permanent rule: keep sub-strides in the source's family, accept BOUNDARY seams as documented class (n448↔n226, n486↔n244, n6↔n201, n9↔n116); clamp per-pair affine gains to 0.65–1.35 | **10** | n6←n202, n340←n172, n629←n32, n626←n57, n341←n172, n342←n87, n512←n130, n513←n47, n486←n487→reverted, n46←n14 | ✓ cleared: n6↔n202, n172↔n340, n32↔n629, n57↔n626, n172↔n341, n87↔n341/n342, n173↔n342, n47↔n513, n130↔n513, n46-family (14/15/45). Seams accepted: n244↔n486, n226↔n448, n6↔n201, n9↔n116 |

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

`anchor=point_correct_2 (n2, green junction) +x fill IN PROGRESS. Iteration 22 queue: (1) close ring branch middle — n315←n629, n628←n315(mirror), n314←n626 — fills 32—629—315—628—159—627—314—626—57; (2) n317/n318 unlock from n32 side (after n629 chain stabilizes); (3) continue green-junction fills n343←n173, n344←n36, n345←n174, n346←n88, n330←(n84 family), n331←n167; (4) gentle offenders if budget: n7 (3 edges, worst), n65↔n94, n162↔n321 (n321 bright vs dark n162 — regen n321←n162 with exposure-lock), n2↔n336. RULES: after EVERY batch rerun audit & chain-audit.txt; per-pair affine gains clamp 0.65–1.35 to SOURCE only (global harmonization dead end bb880b0; exposure-bridge dead end iter 21); canopy frames (greenfrac>0.15 or edge>0.15 in top band: n9, n35-n46, n56, n130, n41, n6) LEGIT dark, never exposure-judge; BOUNDARY seams between original dark originals and bright AI family (n448↔n226, n486↔n244, n6↔n201, n9↔n116) = accepted documented class, not regression targets.`
