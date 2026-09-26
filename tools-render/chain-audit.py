#!/usr/bin/env python3
"""
Chain auditor (tools-render/chain-audit.py) — OpenCV walk-consistency check.

For every graph edge whose BOTH endpoint frames exist, the auditor measures
how much the AI drifted between those two chained photos:
  1. HSV 3-D histogram correlation (palette match of the same street)
  2. Sky-band mean-luminance delta (top 12% rows — overcast vs sunny breaks)
  3. Exposure delta (global mean luminance)
  4. SIFT keypoint persistence (structure — catches a hallucinated street)
  5. LAB color drift at matched SIFT points (materials repainted: door color,
     car color — geometry still matches, but matched patches changed color)

A pair is SUSPECT when:  histCorrel < 0.72  or  skyDelta > 22  or  exposure > 18
  or  (siftMatches < 12 while both frames are keypoint-rich)   [STR break]
  or  (siftMatches >= 12 and median matched-patch LAB drift > 14)  [MAT break]
A frame's suspicion score = how many suspect edges it participates in; the
worst-scoring frames are the hallucination breaks to regenerate (as camera-
shift edits of their best-correlated EXISTING neighbor).

Usage: .venv/bin/python tools-render/chain-audit.py [--top 15]
Output: console table + tools-render/chain-audit.txt (committed for the ledger)
"""
import sys, os
import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAY = os.path.join(ROOT, 'assets', 'willow', 'day')

TOP_HIST_CORREL = 0.72
MAX_SKY_DELTA = 22.0
MAX_EXPO_DELTA = 18.0


def descriptor(img):
    """Histogram (H,S,V 8x8x8) + sky luminance + global luminance + SIFT."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 8, 8], [0, 180, 0, 256, 0, 256])
    cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)
    h = img.shape[0]
    sky = img[: max(8, h // 8)]
    skyL = float(np.mean(cv2.cvtColor(sky, cv2.COLOR_BGR2GRAY)))
    expo = float(np.mean(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    kp, des = _SIFT.detectAndCompute(gray, None)
    return hist, skyL, expo, kp, des, img


_SIFT = cv2.SIFT_create(nfeatures=1600)
_BF = cv2.BFMatcher(cv2.NORM_L2)


def match_metrics(da, db):
    """SIFT structure persistence + LAB color drift on matched points.

    Same physical street photographed one stride away matches MANY SIFT
    keypoints and their neighborhoods keep the SAME colors. When the AI
    repaints a door/car/material, keypoints still match (geometry kept,
    parallax small) but the LAB values at matched points drift — that is
    exactly the 'door changed color' alarm.
    """
    kpA, desA = da[3], da[4]
    kpB, desB = db[3], db[4]
    if desA is None or desB is None or not kpA or not kpB:
        return 0, 0.0, 999.0
    matches = _BF.knnMatch(desA, desB, k=2)
    good = []
    for pair in matches:
        m = pair[0]
        if len(pair) == 2:
            if m.distance < 0.72 * pair[1].distance:
                good.append(m)
        elif m.distance < 230:
            good.append(m)
    n = len(good)
    if n < 4:
        return n, 0.0, 999.0
    labA = cv2.cvtColor(da[5], cv2.COLOR_BGR2LAB)
    labB = cv2.cvtColor(db[5], cv2.COLOR_BGR2LAB)
    hA, wA = labA.shape[:2]
    diffs = []
    for m in good[:200]:
        xa, ya = int(round(kpA[m.queryIdx].pt[0])), int(round(kpA[m.queryIdx].pt[1]))
        xb, yb = int(round(kpB[m.trainIdx].pt[0])), int(round(kpB[m.trainIdx].pt[1]))
        if 2 <= xa < wA - 2 and 2 <= ya < hA - 2 and 2 <= xb < wA - 2 and 2 <= yb < hA - 2:
            a = labA[ya - 2: ya + 3, xa - 2: xa + 3].reshape(-1, 3).mean(axis=0)
            b = labB[yb - 2: yb + 3, xb - 2: xb + 3].reshape(-1, 3).mean(axis=0)
            diffs.append(float(np.linalg.norm(a - b)))
    drift = float(np.median(diffs)) if diffs else 999.0
    return n, n / max(1, min(len(kpA), len(kpB))), drift


def load_frames():
    frames = {}
    for f in sorted(os.listdir(DAY)):
        if f.endswith('.jpg'):
            n = int(f[1:-4])
            img = cv2.imread(os.path.join(DAY, f))
            if img is not None:
                img = cv2.resize(img, (512, 256), interpolation=cv2.INTER_AREA)
                frames[n] = descriptor(img)
    return frames


def graph_edges():
    """Collapsed walk pairs: consecutive EXISTING frames along each branch.

    The 4 m sub-stride stage inserts topology knots whose photos are still
    being generated, so raw edges hardly ever join two existing frames.
    Walk each branch from every existing frame until the NEXT existing
    frame on that branch and compare THOSE — exactly the visual pair a
    walker experiences.
    """
    import subprocess, json, os
    js = """
import { densify } from './js/worlds/willow-parish.js';
const { edges } = densify();
console.log(JSON.stringify(edges));
"""
    out = subprocess.run(['node', '--input-type=module', '-e', js], cwd=ROOT,
                         capture_output=True, text=True, check=True)
    raw = json.loads(out.stdout)
    adj = {}
    for a, b in raw:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    have = set()
    for f in os.listdir(DAY):
        if f.endswith('.jpg'):
            have.add(int(f[1:-4]))
    pairs = set()
    for start in sorted(have):
        for nb in adj.get(start, []):
            prev, cur, hops = start, nb, 1
            while cur not in have and hops < 24:           # walk toward next existing frame
                nxts = [x for x in adj.get(cur, []) if x != prev]
                if not nxts: break
                prev, cur = cur, nxts[0]
                hops += 1
            if cur in have:
                pairs.add(tuple(sorted((start, cur))))
    return sorted(pairs)


def main():
    top = int(sys.argv[sys.argv.index('--top') + 1]) if '--top' in sys.argv else 15
    frames = load_frames()
    edges = graph_edges()

    rows, suspicion = [], {}
    for a, b in edges:
        if a not in frames or b not in frames:
            continue
        da, db = frames[a], frames[b]
        corr = cv2.compareHist(da[0], db[0], cv2.HISTCMP_CORREL)
        sky = abs(da[1] - db[1])
        expo = abs(da[2] - db[2])
        sift, rate, drift = match_metrics(da, db)
        # suspect when: palette/sky/exposure broke (as before) OR the structure
        # itself doesn't match (different street hallucinated while keypoints
        # exist to compare) OR geometry matches but materials were repainted
        # (door color/car — LAB drift on matched points)
        structBad = sift < 12 and len(da[3] or []) > 200 and len(db[3] or []) > 200
        matBad = sift >= 12 and drift > 14
        bad = corr < TOP_HIST_CORREL or sky > MAX_SKY_DELTA or expo > MAX_EXPO_DELTA or structBad or matBad
        rows.append((a, b, corr, sky, expo, sift, drift, structBad, matBad, bad))
        if bad:
            suspicion[a] = suspicion.get(a, 0) + 1
            suspicion[b] = suspicion.get(b, 0) + 1

    worst_pairs = sorted([r for r in rows if r[-1]], key=lambda r: (r[2], -r[3]))
    worst_frames = sorted(suspicion.items(), key=lambda kv: -kv[1])

    lines = []
    lines.append(f"chain audit: {len(rows)} walkable edges checked, {len(worst_pairs)} suspect breaks")
    lines.append("")
    lines.append("WORST FRAMES (regenerate as edits of their best neighbor):")
    for img, score in worst_frames[:top]:
        best = None
        for a, b, corr, sky, expo, sift, drift, sb, mb, bad in rows:
            for (x, y) in ((a, b), (b, a)):
                if x == img and (best is None or corr > best[1]):
                    best = (y, corr)
        lines.append(f"  n{img}: {score} suspect edges   suggested source n{best[0]} (correl {best[1]:.2f})")
    lines.append("")
    lines.append("SUSPECT PAIRS (worst first):  [MAT = materials repainted (door/car drift), STR = structure mismatch]")
    for a, b, corr, sky, expo, sift, drift, structBad, matBad, bad in worst_pairs[:40]:
        tags = (" MAT" if matBad else "") + (" STR" if structBad else "")
        lines.append(f"  n{a} <-> n{b}: correl {corr:.3f}  skyΔ {sky:.1f}  expoΔ {expo:.1f}  sift {sift}  driftΔ {drift:.1f}{tags}")

    report = "\n".join(lines)
    print(report)
    with open(os.path.join(ROOT, 'tools-render', 'chain-audit.txt'), 'w') as fh:
        fh.write(report + "\n")


if __name__ == '__main__':
    main()
