# Continuity validation — `tools/panorama_validate.py`

A standalone Python/OpenCV **hard gate** for panorama continuity. This is the
authoritative verdict used before a generated frame may be cached as part of
the world.

## Why it exists

The requirements demand a specific kill-switch: facing the church, one
movement step must not replace the church by a beach, random color, blur or a
different time of day. The validator encodes the *expected distances* of the
spec (few meters ⇒ near-identical; 10–20 m ⇒ small change; 50–100 m ⇒
moderate; 100–500 m ⇒ large but identifiable; > 500 m ⇒ zone/landmark logic)
and yields **structured PASS/FAIL with reasons**, usable offline, in a
server hook, or from tests.

## Checks and weights (configurable via `--weights`)

| check | w  | what it measures |
|---|---|---|
| `integrity` | — (hard veto) | decodes, size ≥ 512×256, no all-black/blank frame, no NaN |
| `feature`   | 0.28 | ORB keypoints cross-matched with ratio test; ≥60 good matches ⇒ strong |
| `geometry`  | 0.20 | affine RANSAC inlier ratio (×1.8 panorama-parallax factor) + coverage |
| `landmark`  | 0.16 | inlier geometry × pHash(16×16) proximity — the "same church" proxy |
| `structure` | 0.16 | Canny edge overlap at half resolution with 7 px elastic tolerance |
| `color`     | 0.10 | Bhattacharyya distance of RGB histograms |
| `brightness`| 0.10 | Lab L-channel mean delta |
| `metadata`  | — (hard veto) | zone/graph metadata; `forbiddenChange` ⇒ instant FAIL (confidence 0.99) |

Score = Σ w·s after integrity & metadata vetoes, compared with a
**distance-aware threshold**:

```
effective = min(threshold, max(floor(d)·0.85, threshold − d·0.00025))
floor: 0 m→0.92 … 10–20 m→0.72 … 100–500 m→0.30 … >500 m→0.20
```

So a 10 m move must be quite similar; a 400 m horizon shot may differ more
but must still agree on the landmark-bearing structures.

## CLI

```bash
python3 tools/panorama_validate.py \
  --prev A.png --next B.png [--distance-m 10] [--zone-same|--zone-change]
  [--threshold 0.78] [--weights feature=0.30,color=0.14]

# chain of entire streets (uses pairwise metrics + overall chain verdict)
python3 tools/panorama_validate.py --sequence n1.png n2.png n3.png … --step-m 10
```

Exit code `0` = PASS, `1` = FAIL — chain verdict prints human reasons:
e.g. `scene features lost (match score 0.12) — likely an unrelated image`.

Output JSON (written with `--report out.json`) contains per-pair, per-check
scores, effective thresholds, `failure_reasons`, `advice` ("lower threshold
or check provider drift"), probabilities (spec §64 fields) and metadata —
exactly the shape the generation pipeline consumes as feedback.

## Integration with the app

- **Generation pipeline**: a backend implementing
  `RemoteGenerationProvider` should run this validator server-side before
  returning an image; on failure it regenerates with the failed checks fed
  back into `context.feedback.previousRejections`, up to N retries, then
  marks `node.meta.needsReview`.
- **Test suite** (`tools/tests/test_validator.py`, 15 tests): church-chain
  acceptance, reverse symmetry, yaw continuity, unrelated/black/blank
  rejection, distance-aware relaxation, weight config, probability output,
  forbiddenChange hard-veto. All green.
- **End-to-end proof** (see TESTING.md): the *real* app panoramas rendered by
  `tools-render/render-panoramas.mjs` score 0.80–0.94 across the whole
  chapel-lane street; a beach injection mid-chain scores 0.29 and is rejected.

## Dependencies

```
opencv-python-headless
numpy
pytest        # for tools/tests only
```

Install: `python3 -m venv .venv && .venv/bin/pip install opencv-python-headless numpy pytest`
