/**
 * apps/web — saved measurements (REQUIREMENTS 074, 075).
 *
 * Values are recomputed from the stored points every render with the real
 * measurement functions, so an edit to the terrain or the exaggeration setting
 * can never leave a stale number on screen.
 */
import React from 'react';
import { Button, IconButton, Panel, StatRow, Switch } from '@3dmm/ui';
import { measureLocal, polylineLength, ringArea, ringPerimeter } from '@3dmm/gis';
import { useEngine } from '../../engine/engineRef';
import { useStore } from '../../state/store';

type Measurement = ReturnType<typeof useStore.getState>['project']['measurements'][number];

function report(m: Measurement): Array<[string, string]> {
  const pts = m.points.map((p) => ({ x: p.x, y: p.z, z: p.y }));
  const ring = m.ring.map((p) => ({ x: p.x, y: p.z, z: p.y }));
  switch (m.kind) {
    case 'distance':
      return pts.length >= 2
        ? [
            ['Straight line', `${measureLocal(pts[0], pts[pts.length - 1]).distance3d.toFixed(2)} m`],
            ['Along path', `${polylineLength(pts).toFixed(2)} m`],
            ['Horizontal', `${polylineLength(pts, false).toFixed(2)} m`],
          ]
        : [['Points', `${pts.length}`]];
    case 'surface':
      return pts.length >= 2
        ? [
            ['Surface distance', `${polylineLength(pts, true).toFixed(2)} m`],
            ['Plan distance', `${polylineLength(pts, false).toFixed(2)} m`],
            ['Climb', `${(pts[pts.length - 1].z - pts[0].z).toFixed(2)} m`],
          ]
        : [['Points', `${pts.length}`]];
    case 'elevation': {
      if (pts.length < 2) return [['Points', `${pts.length}`]];
      const m1 = measureLocal(pts[0], pts[pts.length - 1]);
      return [
        ['Δ elevation', `${m1.vertical.toFixed(2)} m`],
        ['Slope', `${m1.slopeDeg.toFixed(2)}°`],
        ['Grade', `${m1.slopePct.toFixed(1)} %`],
      ];
    }
    case 'bearing': {
      if (pts.length < 2) return [['Points', `${pts.length}`]];
      const m1 = measureLocal(pts[0], pts[pts.length - 1]);
      return [
        ['Bearing', `${m1.bearingDeg.toFixed(2)}°`],
        ['Horizontal', `${m1.horizontal.toFixed(2)} m`],
      ];
    }
    case 'area':
      return ring.length >= 3 ? [['Area', `${ringArea(ring).toFixed(1)} m²`], ['Vertices', `${ring.length}`]] : [['Vertices', `${ring.length}`]];
    case 'perimeter':
      return ring.length >= 3 ? [['Perimeter', `${ringPerimeter(ring).toFixed(2)} m`], ['Area', `${ringArea(ring).toFixed(1)} m²`]] : [['Vertices', `${ring.length}`]];
    default:
      return [];
  }
}

export function MeasurementPanel(): React.ReactElement {
  const measurements = useStore((s) => s.project.measurements);
  const clear = useStore((s) => s.clearMeasurements);
  const center = useStore((s) => s.project.center);
  const mutate = useStore((s) => s.mutate);
  const engine = useEngine();

  return (
    <Panel
      title="Measurements"
      panelId="measurements"
      actions={
        measurements.length > 0 ? (
          <Button size="xs" variant="ghost" onClick={clear}>
            Clear all
          </Button>
        ) : undefined
      }
    >
      {measurements.length === 0 && <p className="ui-hint">Use the measure tool (M), click two or more points, then press Enter.</p>}
      {measurements.map((m, i) => (
        <div className="measure-row" key={m.id}>
          <div className="measure-row__head">
            <span className="measure-row__name">
              {m.kind} {i + 1}
            </span>
            <IconButton
              label={`Fly to measurement ${i + 1}`}
              size="xs"
              variant="ghost"
              onClick={() => {
                const pts = m.points.length ? m.points : m.ring;
                if (!pts.length) return;
                engine?.flyTo({ target: { ...pts[0] } }, 'Measurement');
              }}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </IconButton>
          </div>
          {report(m).map(([k, v]) => (
            <StatRow key={k} label={k} value={v} />
          ))}
          {center.enabled && (m.points[0] || m.ring[0]) && (
            <StatRow
              label="From centre"
              value={(() => {
                const p = m.points[0] ?? m.ring[0];
                const r = measureLocal({ x: center.position.x, y: center.position.z, z: center.position.y }, { x: p.x, y: p.z, z: p.y });
                return `${r.distance3d.toFixed(1)} m @ ${r.bearingDeg.toFixed(0)}°`;
              })()}
            />
          )}
        </div>
      ))}
      <Switch
        label="Show centre-relative coordinates"
        description="Report every point relative to a fixed centre instead of the world origin."
        checked={center.enabled}
        onChange={(v) =>
          mutate((d) => {
            d.center = { ...d.center, enabled: v };
          }, 'Centre reference', null)
        }
      />
    </Panel>
  );
}
