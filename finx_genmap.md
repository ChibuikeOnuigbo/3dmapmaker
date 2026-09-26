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

## Ring optics (updated state)

- Street S-chain holes closed this iter: n163–n166, n171, n174, n175.
- n58's neighbors (n317/n318) are themselves missing → n58 unlocks when
  the ring reaches them (they sort at ring imgs 317/318).
- Remaining holes adjacent to existing frames: continue ring fill from
  img order (ring scanner re-run each iteration).

## Cursor

`anchor=ring-cell n176 next (S ← n?) — resume the sorted ring scan in finx_genmap protocol step 4: rebuild ring list from the graph each iteration, take the first 10 missing-adjacent imgs, edit from their existing neighbor; after the ring closes around main street, re-run for church path, west bend, green road, hall/pond/school/forge/meadow/orchard/manor branches`
