#!/usr/bin/env python3
"""
Panorama Maps — tools/panorama_validate.py

OpenCV continuity validation gate (Spec §24–§29, §43–§44).

Every newly generated panorama MUST pass this gate before it enters the
world graph. Design notes:

  * A single pixel-diff or similarity score is NOT sufficient (Spec §10).
    This validator combines: integrity checks, ORB local features, descriptor
    matching, homography/geometric consistency, structural (edge) agreement,
    color distribution comparison, brightness analysis, perceptual hashing,
    yaw-shift estimation, and metadata consistency.
  * Validation is DISTANCE-AWARE (Spec §27–§28): at 1 m the scene must be
    nearly identical; at 500 m a major but explainable change is allowed.
  * Analysis runs on a REDUCED 1024x512 copy (performance, sys prompt §24).
  * Nothing here proves two images depict the same place with certainty.
    We emit confidence scores and explicit failure reasons (Spec §10).

CLI:
  python panorama_validate.py --prev a.jpg --next b.jpg --distance-m 10 \
      --zone-same --report report.json

  python panorama_validate.py --sequence s1.jpg s2.jpg s3.jpg \
      --step-m 10 --zone-same --report chain.json

Exit code: 0 = PASS, 1 = FAIL, 2 = usage/IO error.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path

import cv2
import numpy as np

ANALYSIS_W, ANALYSIS_H = 1024, 512       # reduced analysis copy (§24 sys-prompt)
DEFAULT_THRESHOLD = 0.78

# Weights for the continuity score — configurable (Spec §26).
DEFAULT_WEIGHTS = {
    "feature":   0.25,   # ORB descriptor correspondences
    "landmark":  0.25,   # geometric inliers + perceptual hash proximity
    "structure": 0.15,   # edge-map agreement
    "color":     0.10,   # HSV histogram similarity
    "geometry":  0.15,   # yaw-shift / homography consistency
    "metadata":  0.10,   # zone/provider/seed consistency supplied by caller
}


@dataclass
class CheckReport:
    name: str
    score: float          # 0..1
    detail: str = ""
    fatal: bool = False   # fatal failure forces rejection regardless of total


@dataclass
class ValidationReport:
    prev: str
    next: str
    distance_m: float
    threshold: float
    effective_threshold: float
    checks: list = field(default_factory=list)
    continuity_score: float = 0.0
    generation_confidence: float = 1.0
    validation_confidence: float = 0.0
    verdict: str = "FAIL"
    failure_reasons: list = field(default_factory=list)

    def to_json(self) -> dict:
        d = asdict(self)
        return d


# ---------------------------------------------------------------------
# individual checks
# ---------------------------------------------------------------------

def load_image(path: str):
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    return img


def check_integrity(img, name="next") -> CheckReport:
    """Image exists, sane dimensions, not blank/corrupt (§25)."""
    if img is None:
        return CheckReport("integrity", 0.0, f"{name}: cannot decode", fatal=True)
    h, w = img.shape[:2]
    if w < 128 or h < 64:
        return CheckReport("integrity", 0.0, f"{name}: too small ({w}x{h})", fatal=True)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    std = float(gray.std())
    if std < 3.0:
        return CheckReport("integrity", 0.05, f"{name}: nearly uniform image (std {std:.2f})", fatal=True)
    black_frac = float((gray < 6).mean())
    if black_frac > 0.85:
        return CheckReport("integrity", 0.05, f"{name}: {black_frac:.0%} black pixels", fatal=True)
    return CheckReport("integrity", 1.0, f"{name}: {w}x{h} ok")


def check_color(prev_s, next_s) -> CheckReport:
    """Color distribution comparison: HSV histogram — Bhattacharyya (§10)."""
    hp = cv2.cvtColor(prev_s, cv2.COLOR_BGR2HSV)
    hn = cv2.cvtColor(next_s, cv2.COLOR_BGR2HSV)
    hist_p = cv2.calcHist([hp], [0, 1], None, [32, 32], [0, 180, 0, 256])
    hist_n = cv2.calcHist([hn], [0, 1], None, [32, 32], [0, 180, 0, 256])
    cv2.normalize(hist_p, hist_p)
    cv2.normalize(hist_n, hist_n)
    dist = cv2.compareHist(hist_p, hist_n, cv2.HISTCMP_BHATTACHARYYA)
    score = max(0.0, 1.0 - dist)
    return CheckReport("color", score, f"bhattacharyya {dist:.3f}")


def check_brightness(prev_s, next_s) -> CheckReport:
    """Lighting consistency: LAB L-channel mean delta (§7 lighting)."""
    lp = cv2.cvtColor(prev_s, cv2.COLOR_BGR2LAB)[:, :, 0].mean()
    ln = cv2.cvtColor(next_s, cv2.COLOR_BGR2LAB)[:, :, 0].mean()
    delta = abs(float(lp) - float(ln))
    score = math.exp(-delta / 14.0)
    return CheckReport("brightness", score, f"lab-L delta {delta:.1f}")


def phash16(img) -> np.ndarray:
    """Average-hash 16x16 of luminance (Spec §30)."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (16, 16), interpolation=cv2.INTER_AREA)
    return small > small.mean()


def hamming(a: np.ndarray, b: np.ndarray) -> int:
    return int(np.count_nonzero(a != b))


def compute_orb(prev_s, next_s):
    """ORB features + descriptor matching + homography inliers (§24)."""
    orb = cv2.ORB_create(nfeatures=3000, fastThreshold=12)
    kp1, des1 = orb.detectAndCompute(prev_s, None)
    kp2, des2 = orb.detectAndCompute(next_s, None)
    if des1 is None or des2 is None or len(kp1) < 8 or len(kp2) < 8:
        return {"kp": (len(kp1 or []), len(kp2 or [])), "good": 0, "inliers": 0, "inlier_ratio": 0.0, "shift": None}
    bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    matches = bf.knnMatch(des1, des2, k=2)
    good = [m for m, n in matches if m.distance < 0.78 * n.distance]
    inliers, inlier_ratio, shift = 0, 0.0, None
    if len(good) >= 12:
        src = np.float32([kp1[m.queryIdx].pt for m in good])
        dst = np.float32([kp2[m.trainIdx].pt for m in good])
        # affine handles wrap-shift better than full homography for panoramas
        M, mask = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
        if mask is not None:
            inliers = int(mask.sum())
            inlier_ratio = inliers / len(good)
            if M is not None and inlier_ratio > 0.6:
                shift = (float(M[0, 2]), float(M[1, 2]))
    return {"kp": (len(kp1), len(kp2)), "good": len(good), "inliers": inliers, "inlier_ratio": inlier_ratio, "shift": shift}


def check_structure(prev_s, next_s) -> CheckReport:
    """Structural agreement: Canny edge overlap with dilation tolerance.

    Compared at reduced resolution: parallax between panorama nodes shifts
    edges by several px at full analysis size, so coarse+elastic comparison
    measures real structural agreement rather than exact pixel alignment.
    """
    sw, sh = ANALYSIS_W // 2, ANALYSIS_H // 2
    gp = cv2.resize(cv2.cvtColor(prev_s, cv2.COLOR_BGR2GRAY), (sw, sh), interpolation=cv2.INTER_AREA)
    gn = cv2.resize(cv2.cvtColor(next_s, cv2.COLOR_BGR2GRAY), (sw, sh), interpolation=cv2.INTER_AREA)
    ep = cv2.Canny(gp, 60, 140) > 0
    en = cv2.Canny(gn, 60, 140) > 0
    dil = cv2.dilate(en.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    dil_p = cv2.dilate(ep.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    if ep.sum() < 50 or en.sum() < 50:
        return CheckReport("structure", 0.35, "too few edges to compare")
    o1 = (ep & dil).sum() / ep.sum()
    o2 = (en & dil_p).sum() / en.sum()
    return CheckReport("structure", float((o1 + o2) / 2), f"edge overlap {o1:.2f}/{o2:.2f}")


def expected_min_score(distance_m: float) -> float:
    """
    Movement-dependent tolerance (Spec §28): the similarity floor for the raw
    scene-agreement signals BEFORE weighting. Not the final threshold.
    """
    if distance_m <= 2:
        return 0.90
    if distance_m <= 20:
        return 0.72
    if distance_m <= 100:
        return 0.50
    if distance_m <= 500:
        return 0.30
    return 0.15


# ---------------------------------------------------------------------
# validator
# ---------------------------------------------------------------------

def validate_pair(
    prev_path: str,
    next_path: str,
    distance_m: float = 10.0,
    threshold: float = DEFAULT_THRESHOLD,
    weights: dict | None = None,
    same_zone: bool = True,
    meta_next: dict | None = None,
) -> ValidationReport:
    """
    Validate that `next` is a plausible continuation of `prev` given the
    physical movement of `distance_m` meters. Returns a full report; the
    caller decides reject / regenerate (§25, §43).
    """
    w = dict(DEFAULT_WEIGHTS if weights is None else weights)
    rep = ValidationReport(prev=prev_path, next=next_path, distance_m=distance_m,
                           threshold=threshold, effective_threshold=threshold)

    prev = load_image(prev_path)
    next_ = load_image(next_path)
    for label, img in (("prev", prev), ("next", next_)):
        c = check_integrity(img, label)
        rep.checks.append(c)
        if c.fatal:
            rep.failure_reasons.append(c.detail)
            rep.verdict = "FAIL"
            rep.validation_confidence = 0.95
            return rep

    prev_s = cv2.resize(prev, (ANALYSIS_W, ANALYSIS_H), interpolation=cv2.INTER_AREA)
    next_s = cv2.resize(next_, (ANALYSIS_W, ANALYSIS_H), interpolation=cv2.INTER_AREA)

    # --- ORB features + geometry ---
    orb = compute_orb(prev_s, next_s)
    # 60+ good correspondences is strong agreement for a panorama pair
    feat_score = min(1.0, orb["good"] / 60.0)
    rep.checks.append(CheckReport("feature", feat_score,
                                  f"kp {orb['kp'][0]}/{orb['kp'][1]}, good-matches {orb['good']}"))
    # equirect parallax breaks projectivity at the seams — inlier ratios there
    # are lower than in planar photography, so scale sympathetically
    geom_score = min(1.0, orb["inlier_ratio"] * 1.8 + min(0.25, orb["good"] / 400.0))
    rep.checks.append(CheckReport("geometry", geom_score, f"affine inliers {orb['inlier_ratio']:.2f} shift {orb['shift']}"))

    # --- landmark identity proxy: inlier-covered phash proximity ---
    hd = hamming(phash16(prev_s), phash16(next_s))
    phash_score = max(0.0, 1.0 - hd / 96.0)
    landmark_score = 0.5 * min(1.0, orb["inlier_ratio"] * 1.8) + 0.5 * phash_score
    rep.checks.append(CheckReport("landmark", landmark_score, f"phash hamming {hd}/256"))

    rep.checks.append(check_structure(prev_s, next_s))
    rep.checks.append(check_color(prev_s, next_s))
    rep.checks.append(check_brightness(prev_s, next_s))

    meta_score = 1.0
    if not same_zone:
        meta_score = 0.4
    if meta_next and meta_next.get("forbiddenChange"):
        meta_score = 0.0
    rep.checks.append(CheckReport("metadata", meta_score, f"same_zone={same_zone}"))

    named = {c.name: c.score for c in rep.checks}
    score = (
        w["feature"] * named["feature"]
        + w["landmark"] * named["landmark"]
        + w["structure"] * named["structure"]
        + w["color"] * min(1.0, 0.5 * named["color"] + 0.5 * named["brightness"])
        + w["geometry"] * named["geometry"]
        + w["metadata"] * named["metadata"]
    )
    rep.continuity_score = round(score, 4)

    # distance-aware: movement tolerance widens with meters travelled (§27–§28).
    # near moves stay strict (a same-room step must look near-identical), long
    # moves relax toward the configured floor — never below it.
    floor = expected_min_score(distance_m)
    rep.effective_threshold = round(min(threshold, max(floor * 0.85, threshold - distance_m * 0.25 / 1000.0)), 4)

    # A forbidden change flagged in metadata is a HARD veto — never silently
    # accept it just because the pixels happen to look close (Spec §40, §43).
    if meta_next and meta_next.get("forbiddenChange"):
        rep.verdict = "FAIL"
        rep.validation_confidence = 0.99
        rep.failure_reasons.append("metadata marks a forbidden change")
        return rep

    if rep.continuity_score >= rep.effective_threshold:
        rep.verdict = "PASS"
        # confidence scales with how decisively the gate was cleared
        rep.validation_confidence = min(0.99, 0.5 + (rep.continuity_score - rep.effective_threshold))
    else:
        rep.verdict = "FAIL"
        rep.validation_confidence = min(0.99, 0.5 + (rep.effective_threshold - rep.continuity_score))
        if feat_score < 0.15:
            rep.failure_reasons.append(f"scene features lost (match score {feat_score:.2f}) — likely an unrelated image")
        if geom_score < 0.15:
            rep.failure_reasons.append("no geometric consistency with previous panorama")
        if named["color"] < 0.55:
            rep.failure_reasons.append("color palette changed beyond movement expectation")
        if hd > 110:
            rep.failure_reasons.append(f"perceptual hash distance {hd} too large")
        if meta_score == 0.0:
            rep.failure_reasons.append("metadata marks a forbidden change")
    return rep


def decide(rep: ValidationReport, attempt: int, max_attempts: int = 3) -> str:
    """Spec §43: accept / regenerate / escalate."""
    if rep.verdict == "PASS":
        return "accept"
    return "regenerate" if attempt < max_attempts else "reject-escalate-human-review"


# ---------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Panorama Maps continuity validator (OpenCV)")
    ap.add_argument("--prev", help="previous panorama image")
    ap.add_argument("--next", help="new panorama image")
    ap.add_argument("--sequence", nargs="+", help="validate a chain of panoramas")
    ap.add_argument("--distance-m", type=float, default=10.0)
    ap.add_argument("--step-m", type=float, default=10.0, help="for --sequence: meters between frames")
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    ap.add_argument("--weights", help="JSON file overriding score weights")
    ap.add_argument("--zone-same", action="store_true", help="both images are inside the same zone")
    ap.add_argument("--report", help="write JSON report to path")
    args = ap.parse_args(argv)

    weights = None
    if args.weights:
        weights = json.loads(Path(args.weights).read_text())

    reports = []
    if args.sequence:
        files = args.sequence
        for i in range(len(files) - 1):
            reports.append(validate_pair(files[i], files[i + 1], distance_m=args.step_m,
                                         threshold=args.threshold, weights=weights,
                                         same_zone=args.zone_same))
    elif args.prev and args.next:
        reports.append(validate_pair(args.prev, args.next, distance_m=args.distance_m,
                                     threshold=args.threshold, weights=weights,
                                     same_zone=args.zone_same))
    else:
        ap.error("provide --prev/--next or --sequence")

    overall = all(r.verdict == "PASS" for r in reports)
    payload = {
        "tool": "panorama-validate",
        "version": 1,
        "verdict": "PASS" if overall else "FAIL",
        "pairs": [r.to_json() for r in reports],
    }
    text = json.dumps(payload, indent=1, default=str)
    if args.report:
        Path(args.report).write_text(text)
    print(text)
    return 0 if overall else 1


if __name__ == "__main__":
    sys.exit(main())
