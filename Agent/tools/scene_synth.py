#!/usr/bin/env python3
"""
Panorama Maps — tools/scene_synth.py

Synthetic 360° scene renderer for tests and pipeline demos. Renders a small
deterministic "world" (sky, ground, road, church+tower, trees, houses) as an
equirectangular-style image from a given camera X along the road — the trick
used by the pytest-suite: movement-produced variants stay the SAME world,
so related pairs must PASS the continuity gate and unrelated ones must FAIL.
"""
from __future__ import annotations

import cv2
import numpy as np

W, H = 1024, 512


def render_road_world(cam_x_m: float = 0.0, cam_yaw_deg: float = 0.0, seed: int = 7) -> np.ndarray:
    """Render the world from a camera cam_x_m meters along the road."""
    rng = np.random.default_rng(seed)          # world-fixed seed: same world always
    img = np.zeros((H, W, 3), np.uint8)

    # sky gradient
    for y in range(H // 2):
        t = y / (H / 2)
        img[y, :] = (int(210 - 60 * (1 - t)), int(170 - 40 * (1 - t)), int(120 - 40 * (1 - t)))
    # ground
    img[H // 2:, :] = (80, 110, 80)
    noise = rng.integers(-8, 9, (H - H // 2, W, 1), dtype=np.int16)
    img[H // 2:, :] = np.clip(img[H // 2:, :].astype(np.int16) + noise, 0, 255).astype(np.uint8)

    horizon = H // 2

    def project(wx_m: float, wy_m: float, w_h_m: float, base_w_m: float):
        """Bearing/scale projection of an object at world (wx, h=wy depth)."""
        depth = max(2.0, wy_m)
        bearing = np.deg2rad(np.arctan2(wx_m - cam_x_m, depth) * 180 / np.pi)
        x = int((bearing / (2 * np.pi) + 0.5) * W)
        scale = 8.0 / depth
        return x, scale, w_h_m * scale, base_w_m * scale

    # church (THE landmark — must persist across frames)
    cx, cs, chh, cw = project(60.0, 60.0, 22.0, 14.0)
    ch_px, cw_px = int(chh * H / 60), int(cw * W / 60)
    if cw_px > 4:
        top = horizon - ch_px
        cv2.rectangle(img, (cx - cw_px // 2, top), (cx + cw_px // 2, horizon), (210, 200, 180), -1)
        cv2.rectangle(img, (cx - cw_px // 8, top - ch_px // 2), (cx + cw_px // 8, top), (200, 190, 170), -1)
        cv2.line(img, (cx, top - ch_px // 2 - 8), (cx, top - ch_px // 2 + 6), (60, 40, 30), 2)
        cv2.rectangle(img, (cx - 6, horizon - 16), (cx + 6, horizon), (70, 50, 40), -1)

    # houses + trees (identity-stable via world seed)
    for i in range(6):
        hx = 8.0 + 14 * i + rng.integers(-2, 2)
        hd = 24.0 + 8 * rng.random()
        x, s, hh, ww = project(hx, hd, 6.0, 5.0)
        hh_px, ww_px = max(2, int(hh * H / 60)), max(2, int(ww * W / 60))
        col = (int(rng.integers(40, 90)), int(rng.integers(90, 140)), int(rng.integers(140, 200)))
        cv2.rectangle(img, (x - ww_px // 2, horizon - hh_px), (x + ww_px // 2, horizon), col, -1)
        tx, ts, th, tw2 = project(hx - 7, hd + 3, 7.0, 2.4)
        th_px = max(2, int(th * H / 60))
        cv2.circle(img, (tx, horizon - th_px), max(2, th_px // 2), (30, 90, 40), -1)

    # road band through the bottom
    cv2.rectangle(img, (0, H - 70), (W, H), (70, 70, 75), -1)
    for x in range(0, W, 90):
        cv2.rectangle(img, (x + 20, H - 38), (x + 60, H - 34), (200, 190, 140), -1)

    # camera yaw = horizontal shift
    shift = int((cam_yaw_deg / 360.0) * W)
    if shift:
        img = np.roll(img, shift, axis=1)
    return img


def unrelated_scene(seed: int = 99) -> np.ndarray:
    """A random unrelated scene — the 'church → beach' failure case (§63)."""
    rng = np.random.default_rng(seed)
    img = np.zeros((H, W, 3), np.uint8)
    img[: H // 2] = (220, 190, 120)                    # random sky
    img[H // 2:] = (30, 90, 160)                       # random ground
    for _ in range(40):
        x, y = int(rng.integers(0, W)), int(rng.integers(0, H))
        r = int(rng.integers(6, 40))
        cv2.circle(img, (x, y), r, tuple(int(v) for v in rng.integers(0, 255, 3)), -1)
    noise = rng.integers(0, 255, (H, W, 1), dtype=np.uint8)
    return cv2.addWeighted(img, 0.75, noise.repeat(3, axis=2), 0.25, 0)


if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/scene.png"
    cam = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
    cv2.imwrite(out, render_road_world(cam))
    print(out)
