"""
Panorama Maps — tools/tests/test_validator.py

pytest suite for the OpenCV continuity gate (Spec §22, §62, §63).
Run:  .venv/bin/python -m pytest tools/tests -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from panorama_validate import (  # noqa: E402
    validate_pair, decide, expected_min_score, DEFAULT_THRESHOLD, DEFAULT_WEIGHTS,
)
from scene_synth import render_road_world, unrelated_scene, W, H  # noqa: E402


@pytest.fixture(scope="module")
def imgs(tmp_path_factory):
    d = tmp_path_factory.mktemp("panos")
    frames = {
        "cam0": render_road_world(0.0),
        "cam10": render_road_world(1.4),           # ~10 m closer to the church
        "cam20": render_road_world(2.9),           # ~20 m
        "cam10_yaw": render_road_world(1.4, cam_yaw_deg=18.0),
        "beach": unrelated_scene(),
        "black": np.zeros((H, W, 3), np.uint8),
        "blank": np.full((H, W, 3), 200, np.uint8),
    }
    paths = {}
    for k, img in frames.items():
        p = str(d / f"{k}.png")
        cv2.imwrite(p, img)
        paths[k] = p
    return paths


# ---------- Spec §62: image continuity test ----------

def test_church_sequence_passes(imgs):
    """church_001 → church_002 (10 m): same environment must be accepted."""
    rep = validate_pair(imgs["cam0"], imgs["cam10"], distance_m=10)
    assert rep.verdict == "PASS", rep.failure_reasons
    assert rep.continuity_score >= rep.effective_threshold


def test_church_four_frame_chain(imgs):
    chain = ["cam0", "cam10", "cam20"]
    reports = [validate_pair(imgs[a], imgs[b], distance_m=10) for a, b in zip(chain, chain[1:])]
    assert all(r.verdict == "PASS" for r in reports), [r.failure_reasons for r in reports]


def test_reverse_pair_symmetry(imgs):
    """Forward/backward symmetry (§20): validating B←A behaves like A→B."""
    fwd = validate_pair(imgs["cam0"], imgs["cam10"], distance_m=10)
    rev = validate_pair(imgs["cam10"], imgs["cam0"], distance_m=10)
    assert fwd.verdict == rev.verdict
    assert abs(fwd.continuity_score - rev.continuity_score) < 0.08


def test_yaw_rotation_stays_continuous(imgs):
    rep = validate_pair(imgs["cam0"], imgs["cam10_yaw"], distance_m=10)
    assert rep.verdict == "PASS", rep.failure_reasons


# ---------- Spec §63: random scene detection ----------

def test_unrelated_scene_rejected(imgs):
    """church → beach must FAIL."""
    rep = validate_pair(imgs["cam0"], imgs["beach"], distance_m=10)
    assert rep.verdict == "FAIL"
    assert rep.continuity_score < rep.effective_threshold
    assert any("features" in r or "hash" in r or "consistency" in r for r in rep.failure_reasons)


def test_black_image_rejected(imgs):
    rep = validate_pair(imgs["cam0"], imgs["black"], distance_m=10)
    assert rep.verdict == "FAIL"
    assert any(c.name == "integrity" and c.fatal for c in rep.checks)


def test_blank_image_rejected(imgs):
    rep = validate_pair(imgs["cam0"], imgs["blank"], distance_m=10)
    assert rep.verdict == "FAIL"


def test_interior_to_unrelated_exterior_rejected(imgs):
    """Interior-like frame → unrelated exterior must fail (§63 pattern)."""
    rep = validate_pair(imgs["cam10"], imgs["beach"], distance_m=10)
    assert rep.verdict == "FAIL"


# ---------- Spec §27/§28: distance-aware expectations ----------

def test_expected_change_model_monotonic():
    assert expected_min_score(1) > expected_min_score(10) > expected_min_score(100) > expected_min_score(500)
    assert expected_min_score(1) >= 0.85
    assert 0.1 <= expected_min_score(500) <= 0.35


def test_long_distance_relaxes_threshold(imgs):
    close = validate_pair(imgs["cam0"], imgs["beach"], distance_m=5)
    far = validate_pair(imgs["cam0"], imgs["beach"], distance_m=500)
    assert far.effective_threshold < close.effective_threshold
    # but 500 m does not excuse a totally unrelated scene either
    assert far.verdict == "FAIL"


# ---------- scoring mechanics ----------

def test_weights_are_configurable(imgs):
    w = dict(DEFAULT_WEIGHTS)
    w["color"] = 1.0
    for k in ("feature", "landmark", "structure", "geometry", "metadata"):
        w[k] = 0.0
    rep = validate_pair(imgs["cam0"], imgs["cam10"], distance_m=10, weights=w)
    named = {c.name: c.score for c in rep.checks}
    expected = 0.5 * named["color"] + 0.5 * named["brightness"]
    assert rep.continuity_score == pytest.approx(expected, abs=0.01)


def test_metadata_forbidden_change(imgs):
    rep = validate_pair(imgs["cam0"], imgs["cam10"], distance_m=10, meta_next={"forbiddenChange": True})
    assert rep.verdict == "FAIL"
    assert any("forbidden" in r for r in rep.failure_reasons)


def test_decide_regeneration_loop(imgs):
    good = validate_pair(imgs["cam0"], imgs["cam10"], distance_m=10)
    assert decide(good, 1) == "accept"
    bad = validate_pair(imgs["cam0"], imgs["beach"], distance_m=10)
    assert decide(bad, 1) == "regenerate"
    assert decide(bad, 2) == "regenerate"
    assert decide(bad, 3) == "reject-escalate-human-review"


def test_report_serializable(imgs):
    import json
    rep = validate_pair(imgs["cam0"], imgs["cam10"], distance_m=10)
    json.dumps(rep.to_json())   # must not raise
    assert rep.generation_confidence > 0
    assert rep.validation_confidence > 0


def test_same_image_is_near_perfect(imgs):
    rep = validate_pair(imgs["cam10"], imgs["cam10"], distance_m=1)
    assert rep.verdict == "PASS"
    assert rep.continuity_score > 0.85
