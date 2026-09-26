#!/usr/bin/env python3
"""
Chain auditor (tools-render/chain-audit.py) — OpenCV walk-consistency check.

For every graph edge whose BOTH endpoint frames exist, the auditor measures
how much the AI drifted between those two chained photos:
  1. HSV 3-D histogram correlation (palette match of the same street)
  2. Sky-band mean-luminance delta (top 12% rows — overcast vs sunny breaks)
  3. Exposure delta (global mean luminance)

A pair is SUSPECT when:  histCorrel < 0.72  or  skyDelta > 22  or  exposure > 18
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
    """Histogram (H,S,V 8x8x8) + sky luminance + global luminance."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 8, 8], [0, 180, 0, 256, 0, 256])
    cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)
    h = img.shape[0]
    sky = img[: max(8, h // 8)]
    skyL = float(np.mean(cv2.cvtColor(sky, cv2.COLOR_BGR2GRAY)))
    expo = float(np.mean(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)))
    return hist, skyL, expo


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
    """Run the world densify in node and dump edges as img pairs."""
    import subprocess, json
    js = """
import { densify } from './js/worlds/willow-parish.js';
const { edges } = densify();
console.log(JSON.stringify(edges));
"""
    out = subprocess.run(['node', '--input-type=module', '-e', js], cwd=ROOT,
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def main():
    top = int(sys.argv[sys.argv.index('--top') + 1]) if '--top' in sys.argv else 15
    frames = load_frames()
    edges = graph_edges()

    rows, suspicion = [], {}
    for a, b in edges:
        if a not in frames or b not in frames:
            continue
        ha, sa, ea = frames[a]
        hb, sb, eb = frames[b]
        corr = cv2.compareHist(ha, hb, cv2.HISTCMP_CORREL)
        sky = abs(sa - sb)
        expo = abs(ea - eb)
        bad = corr < TOP_HIST_CORREL or sky > MAX_SKY_DELTA or expo > MAX_EXPO_DELTA
        rows.append((a, b, corr, sky, expo, bad))
        if bad:
            suspicion[a] = suspicion.get(a, 0) + 1
            suspicion[b] = suspicion.get(b, 0) + 1

    worst_pairs = sorted([r for r in rows if r[5]], key=lambda r: (r[2], -r[3]))
    worst_frames = sorted(suspicion.items(), key=lambda kv: -kv[1])

    lines = []
    lines.append(f"chain audit: {len(rows)} walkable edges checked, {len(worst_pairs)} suspect breaks")
    lines.append("")
    lines.append("WORST FRAMES (regenerate as edits of their best neighbor):")
    for img, score in worst_frames[:top]:
        # best-correlated existing neighbor as suggested source
        best = None
        for a, b, corr, sky, expo, bad in rows:
            for (x, y) in ((a, b), (b, a)):
                if x == img and (best is None or corr > best[1]):
                    best = (y, corr)
        lines.append(f"  n{img}: {score} suspect edges   suggested source n{best[0]} (correl {best[1]:.2f})")
    lines.append("")
    lines.append("SUSPECT PAIRS (worst first):")
    for a, b, corr, sky, expo, bad in worst_pairs[:40]:
        lines.append(f"  n{a} <-> n{b}: correl {corr:.3f}  skyΔ {sky:.1f}  expoΔ {expo:.1f}")

    report = "\n".join(lines)
    print(report)
    with open(os.path.join(ROOT, 'tools-render', 'chain-audit.txt'), 'w') as fh:
        fh.write(report + "\n")


if __name__ == '__main__':
    main()
