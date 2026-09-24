#!/usr/bin/env python3
"""Normalize all Willow Parish frames to 2048x1024 with light micro contrast.

Run after every generation batch (see GENERATION-LOG.md):
  python3 -m venv .venv && .venv/bin/pip install opencv-python-headless
  .venv/bin/python tools-render/normalize-willow.py
"""
import cv2, glob, os

FIXED = 0
for p in sorted(glob.glob(os.path.join('assets', 'willow', '*', '*.jpg'))):
    im = cv2.imread(p)
    if im is None:
        continue
    h, w = im.shape[:2]
    if (w, h) == (2048, 1024):
        continue
    im2 = cv2.resize(im, (2048, 1024), interpolation=cv2.INTER_LANCZOS4)
    blur = cv2.GaussianBlur(im2, (0, 0), 1.2)
    im2 = cv2.addWeighted(im2, 1.18, blur, -0.18, 0)
    cv2.imwrite(p, im2, [cv2.IMWRITE_JPEG_QUALITY, 90])
    FIXED += 1
    print('normalized', p)
print('done:', FIXED, 'frames updated')
