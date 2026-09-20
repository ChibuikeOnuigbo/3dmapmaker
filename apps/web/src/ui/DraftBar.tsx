/**
 * apps/web — the drafting bar for measure / path / polygon tools.
 *
 * Live readout of the in-progress draft, computed with the real measurement
 * functions from packages/gis. Enter finishes, Escape discards, Backspace
 * removes the last vertex — all of which also work from the buttons here.
 */
import React, { useEffect, useState } from 'react';
import { Button, Segmented } from '@3dmm/ui';
import { measureLocal, polylineLength, ringArea, ringPerimeter } from '@3dmm/gis';
import type { DraftSnapshot } from '../engine/EngineController';
import { useEngine } from '../engine/engineRef';
import { useStore } from '../state/store';
import { formatMeters } from './NavigationControls';

const KINDS: Array<{ value: DraftSnapshot['measureKind']; label: string }> = [
  { value: 'distance', label: 'Distance' },
  { value: 'surface', label: 'Surface' },
  { value: 'elevation', label: 'Elevation' },
  { value: 'bearing', label: 'Bearing' },
  { value: 'area', label: 'Area' },
  { value: 'perimeter', label: 'Perimeter' },
];

function summarise(snap: DraftSnapshot): string[] {
  if (snap.measurePoints.length > 0) {
    const pts = snap.measurePoints.map((p) => ({ x: p.x, y: p.z, z: p.y }));
    const last = measureLocal(pts[pts.length - 2] ?? pts[0], pts[pts.length - 1]);
    const out: string[] = [`${snap.measurePoints.length} pt`];
    switch (snap.measureKind) {
      case 'distance':
        out.push(polylineLength(pts).toFixed(1) + ' m along');
        if (snap.measurePoints.length > 1) out.push(`${last.distance3d.toFixed(1)} m last`);
        break;
      case 'surface':
        out.push(`${polylineLength(pts, true).toFixed(1)} m surface`);
        out.push(`${polylineLength(pts, false).toFixed(1)} m plan`);
        break;
      case 'elevation':
        out.push(`Δ ${(pts[pts.length - 1].z - pts[0].z).toFixed(2)} m`);
        out.push(`slope ${last.slopeDeg.toFixed(1)}°`);
        break;
      case 'bearing':
        out.push(`${last.bearingDeg.toFixed(1)}°`);
        out.push(`${last.horizontal.toFixed(1)} m horiz`);
        break;
      case 'area':
        out.push(snap.measurePoints.length >= 3 ? `${ringArea(pts).toFixed(0)} m²` : 'need 3+ points');
        break;
      case 'perimeter':
        out.push(snap.measurePoints.length >= 3 ? `${ringPerimeter(pts).toFixed(1)} m` : 'need 3+ points');
        break;
    }
    return out;
  }
  if (snap.pathPoints.length > 0) {
    const pts = snap.pathPoints.map((p) => ({ x: p.x, y: p.z, z: p.y }));
    return [`${snap.pathPoints.length} pt`, `${formatMeters(polylineLength(pts, false))} plan`, `${formatMeters(polylineLength(pts, true))} 3D`];
  }
  return ['Click the terrain to place the first point'];
}

export function DraftBar(): React.ReactElement | null {
  const engine = useEngine();
  const tool = useStore((s) => s.ui.tool);
  const [snap, setSnap] = useState<DraftSnapshot | null>(null);

  useEffect(() => {
    if (!engine) return;
    return engine.onDraftChange(setSnap);
  }, [engine]);

  if (tool !== 'measure' && tool !== 'path' && tool !== 'polygon') return null;

  const active = snap ?? engine?.getDraftSnapshot() ?? null;
  const points = active ? (tool === 'measure' ? active.measurePoints.length : active.pathPoints.length) : 0;
  const canCommit = tool === 'measure' ? points >= (active?.measureKind === 'area' || active?.measureKind === 'perimeter' ? 3 : 2) : tool === 'polygon' ? points >= 3 : points >= 2;

  return (
    <div className="viewport-hud-tl">
      <div className="draft-bar" data-testid="draft-bar">
        {tool === 'measure' && (
          <Segmented
            size="xs"
            label="Measurement type"
            value={active?.measureKind ?? 'distance'}
            onChange={(v) => engine?.setMeasureKind(v)}
            options={KINDS}
          />
        )}
        <div className="draft-bar__readout" aria-live="polite">
          {summarise(active ?? { measurePoints: [], pathPoints: [], measureKind: 'distance' }).map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
        <div className="draft-bar__actions">
          <Button size="xs" variant="ghost" disabled={points === 0} onClick={() => engine?.undoDraftPoint()}>
            Undo point
          </Button>
          <Button size="xs" variant="ghost" disabled={points === 0} onClick={() => (tool === 'measure' ? engine?.cancelMeasure() : engine?.cancelDraftPath())}>
            Cancel
          </Button>
          <Button
            size="xs"
            variant="primary"
            disabled={!canCommit}
            data-testid="draft-commit"
            onClick={() => {
              if (tool === 'measure') engine?.commitMeasure();
              else if (tool === 'path') engine?.commitDraftPath('roads', `Road ${Date.now() % 1000}`);
              else engine?.commitDraftPolygon(`Area ${Date.now() % 1000}`);
            }}
          >
            Finish (Enter)
          </Button>
        </div>
      </div>
    </div>
  );
}
