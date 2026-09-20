/**
 * apps/web — the contextual inspector (REQUIREMENTS 071-075, 129).
 *
 * What you see depends entirely on what is selected: nothing until you select
 * something, a transform block for objects, geometry parameters for authored
 * layers, terrain controls when nothing is selected at all.
 */
import React, { useMemo } from 'react';
import { Badge, Button, NumberScrub, Panel, Segmented, Slider, StatRow, Switch, TextField } from '@3dmm/ui';
import { findNode } from '@3dmm/layers';
import { measureLocal, polylineLength, ringArea, ringPerimeter } from '@3dmm/gis';
import type { ObjectNode } from '@3dmm/project';
import { useEngine } from '../../engine/engineRef';
import { useStore } from '../../state/store';
import { TerrainPanel } from './TerrainPanel';
import { PanoramaPanel } from './PanoramaPanel';
import { MeasurementPanel } from './MeasurementPanel';
import { BookmarkPanel } from './BookmarkPanel';
import { TimelinePanel } from './TimelinePanel';
import { SearchPanel } from './SearchPanel';

function TransformBlock({ node }: { node: ObjectNode }): React.ReactElement {
  const updateLayer = useStore((s) => s.updateLayer);
  const grid = useStore((s) => s.project.grid);
  const setGrid = useStore((s) => s.setGrid);

  const snap = (v: number, step: number) => (grid.snap && step > 0 ? Math.round(v / step) * step : v);

  return (
    <Panel title="Transform" panelId="inspector-transform">
      <div className="ui-field ui-field--row">
        <span className="ui-label">Anchor</span>
        <Segmented
          size="xs"
          label="Anchor type"
          value={node.anchor.type}
          onChange={(v) => {
            if (v === 'world') updateLayer(node.id, { anchor: { type: 'world' } });
            else if (v === 'terrain') updateLayer(node.id, { anchor: { type: 'terrain', offset: 0 } });
            else if (v === 'camera') updateLayer(node.id, { anchor: { type: 'camera', offset: { x: 0, y: 0, z: 0 } } });
            else updateLayer(node.id, { anchor: { type: 'parent', parentId: node.id, offset: { x: 0, y: 0, z: 0 } } });
          }}
          options={[
            { value: 'world', label: 'World' },
            { value: 'terrain', label: 'Terrain' },
            { value: 'camera', label: 'Camera' },
          ]}
        />
      </div>
      {node.anchor.type === 'terrain' && (
        <NumberScrub
          label="Ground offset"
          value={node.anchor.offset}
          onChange={(v) => updateLayer(node.id, { anchor: { type: 'terrain', offset: v } })}
          min={-500}
          max={5000}
          step={0.1}
          precision={2}
          suffix="m"
        />
      )}
      <div className="ui-field__head">
        <span className="ui-label">Position (local metres)</span>
      </div>
      <div className="ui-trio">
        <NumberScrub label="X" value={node.position.x} onChange={(v) => updateLayer(node.id, { position: { ...node.position, x: snap(v, grid.spacing) } })} step={0.1} precision={2} suffix="m" />
        <NumberScrub label="Y" value={node.position.y} onChange={(v) => updateLayer(node.id, { position: { ...node.position, y: snap(v, grid.spacing) } })} step={0.1} precision={2} suffix="m" />
        <NumberScrub label="Z" value={node.position.z} onChange={(v) => updateLayer(node.id, { position: { ...node.position, z: snap(v, grid.spacing) } })} step={0.1} precision={2} suffix="m" />
      </div>
      <div className="ui-field__head">
        <span className="ui-label">Rotation (degrees)</span>
      </div>
      <div className="ui-trio">
        <NumberScrub label="X" value={node.rotationDeg.x} onChange={(v) => updateLayer(node.id, { rotationDeg: { ...node.rotationDeg, x: snap(v, grid.snapDegrees) } })} step={0.5} precision={1} suffix="°" />
        <NumberScrub label="Y" value={node.rotationDeg.y} onChange={(v) => updateLayer(node.id, { rotationDeg: { ...node.rotationDeg, y: snap(v, grid.snapDegrees) } })} step={0.5} precision={1} suffix="°" />
        <NumberScrub label="Z" value={node.rotationDeg.z} onChange={(v) => updateLayer(node.id, { rotationDeg: { ...node.rotationDeg, z: snap(v, grid.snapDegrees) } })} step={0.5} precision={1} suffix="°" />
      </div>
      <div className="ui-field__head">
        <span className="ui-label">Scale</span>
      </div>
      <div className="ui-trio">
        <NumberScrub label="X" value={node.scale.x} onChange={(v) => updateLayer(node.id, { scale: { ...node.scale, x: v } })} min={0.01} step={0.05} precision={3} />
        <NumberScrub label="Y" value={node.scale.y} onChange={(v) => updateLayer(node.id, { scale: { ...node.scale, y: v } })} min={0.01} step={0.05} precision={3} />
        <NumberScrub label="Z" value={node.scale.z} onChange={(v) => updateLayer(node.id, { scale: { ...node.scale, z: v } })} min={0.01} step={0.05} precision={3} />
      </div>
      <div className="panel-actions">
        <Button size="xs" onClick={() => updateLayer(node.id, { position: { x: 0, y: node.position.y, z: 0 } })}>
          Centre on origin
        </Button>
        <Button size="xs" onClick={() => updateLayer(node.id, { rotationDeg: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } })}>
          Reset rotation & scale
        </Button>
      </div>
      <div className="ui-field">
        <Switch label="Snap to grid" description={`Translate in ${grid.spacing} m steps, rotate in ${grid.snapDegrees}° steps.`} checked={grid.snap} onChange={(v) => setGrid({ snap: v })} />
        <Slider label="Grid spacing" value={grid.spacing} onValueChange={(v) => setGrid({ spacing: v })} min={0.5} max={200} step={0.5} format={(v) => `${v.toFixed(1)} m`} />
      </div>
    </Panel>
  );
}

function GeometryBlock({ node }: { node: ObjectNode }): React.ReactElement | null {
  const updateLayer = useStore((s) => s.updateLayer);

  if (node.kind === 'buildings') {
    const floors = Number(node.data.floors ?? 1);
    const floorHeight = Number(node.data.floorHeight ?? 3.3);
    const roof = String(node.data.roof ?? 'flat');
    return (
      <Panel title="Building" panelId="inspector-building">
        <Slider label="Floors" value={floors} onValueChange={(v) => updateLayer(node.id, { data: { ...node.data, floors: Math.round(v) } })} min={1} max={120} step={1} format={(v) => v.toFixed(0)} />
        <Slider label="Floor height" value={floorHeight} onValueChange={(v) => updateLayer(node.id, { data: { ...node.data, floorHeight: v } })} min={2} max={8} step={0.1} format={(v) => `${v.toFixed(1)} m`} />
        <Segmented
          size="xs"
          label="Roof"
          value={roof as 'flat' | 'gable' | 'hip'}
          onChange={(v) => updateLayer(node.id, { data: { ...node.data, roof: v } })}
          options={[{ value: 'flat', label: 'Flat' }, { value: 'gable', label: 'Gable' }, { value: 'hip', label: 'Hip' }]}
        />
        <StatRow label="Total height" value={`${(floors * floorHeight).toFixed(1)} m`} />
      </Panel>
    );
  }

  if (node.kind === 'roads' || node.kind === 'paths') {
    const width = Number(node.data.width ?? 8);
    const sidewalk = Number(node.data.sidewalkWidth ?? 0);
    const smoothing = Number(node.data.smoothing ?? 0.5);
    const pts = (node.data.points as Array<{ x: number; y: number }>) ?? [];
    const length = pts.length > 1 ? polylineLength(pts.map((p) => ({ x: p.x, y: 0, z: p.y })), false) : 0;
    return (
      <Panel title={node.kind === 'roads' ? 'Road' : 'Path'} panelId="inspector-road">
        <Slider label="Width" value={width} onValueChange={(v) => updateLayer(node.id, { data: { ...node.data, width: v } })} min={0.5} max={60} step={0.5} format={(v) => `${v.toFixed(1)} m`} />
        {node.kind === 'roads' && (
          <Slider label="Sidewalk width" value={sidewalk} onValueChange={(v) => updateLayer(node.id, { data: { ...node.data, sidewalkWidth: v } })} min={0} max={8} step={0.1} format={(v) => `${v.toFixed(1)} m`} />
        )}
        <Slider label="Curve smoothing" value={smoothing} onValueChange={(v) => updateLayer(node.id, { data: { ...node.data, smoothing: v } })} min={0} max={1} step={0.05} format={(v) => v.toFixed(2)} />
        <StatRow label="Control points" value={pts.length} />
        <StatRow label="Plan length" value={`${length.toFixed(1)} m`} />
        <StatRow label="Carriageway area" value={`${(length * width).toFixed(0)} m²`} />
      </Panel>
    );
  }

  if (node.kind === 'water' || node.kind === 'polygons') {
    const ring = (node.data.ring as Array<{ x: number; y: number }>) ?? [];
    const asVec = ring.map((p) => ({ x: p.x, y: 0, z: p.y }));
    return (
      <Panel title={node.kind === 'water' ? 'Water body' : 'Polygon'} panelId="inspector-polygon">
        <Slider
          label="Level"
          value={Number(node.data.level ?? 0)}
          onValueChange={(v) => updateLayer(node.id, { data: { ...node.data, level: v } })}
          min={-400}
          max={2000}
          step={0.5}
          format={(v) => `${v.toFixed(1)} m`}
        />
        <StatRow label="Vertices" value={ring.length} />
        <StatRow label="Area" value={ring.length >= 3 ? `${ringArea(asVec).toFixed(0)} m²` : '—'} />
        <StatRow label="Perimeter" value={ring.length >= 3 ? `${ringPerimeter(asVec).toFixed(1)} m` : '—'} />
      </Panel>
    );
  }

  if (node.kind === 'vegetation') {
    const count = Number(node.data.count ?? 100);
    const seed = Number(node.data.seed ?? 1);
    const maxSlope = Number(node.data.maxSlopeDeg ?? 30);
    return (
      <Panel title="Vegetation" panelId="inspector-vegetation">
        <Slider label="Instances" value={count} onValueChange={(v) => updateLayer(node.id, { data: { ...node.data, count: Math.round(v) } })} min={1} max={20000} step={10} format={(v) => v.toFixed(0)} />
        <Slider label="Max slope" value={maxSlope} onValueChange={(v) => updateLayer(node.id, { data: { ...node.data, maxSlopeDeg: v } })} min={0} max={80} step={1} format={(v) => `${v.toFixed(0)}°`} />
        <NumberScrub label="Seed" value={seed} onChange={(v) => updateLayer(node.id, { data: { ...node.data, seed: Math.round(v) } })} min={0} max={999999} step={1} precision={0} />
        <p className="ui-hint">One draw call per material, regardless of instance count.</p>
      </Panel>
    );
  }

  return null;
}

function MultiSelectionBlock({ ids }: { ids: string[] }): React.ReactElement {
  const select = useStore((s) => s.select);
  const duplicate = useStore((s) => s.duplicateSelection);
  const remove = useStore((s) => s.deleteSelection);
  const engine = useEngine();
  return (
    <Panel title={`${ids.length} layers selected`} panelId="inspector-multi">
      <div className="panel-actions">
        <Button size="xs" variant="primary" onClick={() => engine?.frameSelection()}>
          Frame
        </Button>
        <Button size="xs" onClick={duplicate}>
          Duplicate
        </Button>
        <Button size="xs" variant="danger" onClick={remove}>
          Delete
        </Button>
        <Button size="xs" variant="ghost" onClick={() => select([])}>
          Clear
        </Button>
      </div>
    </Panel>
  );
}

export function Inspector(): React.ReactElement {
  const layers = useStore((s) => s.project.layers);
  const selectedIds = useStore((s) => s.ui.selectedIds);
  const updateLayer = useStore((s) => s.updateLayer);
  const toggleVisibility = useStore((s) => s.toggleLayerVisibility);
  const toggleLock = useStore((s) => s.toggleLayerLock);
  const duplicate = useStore((s) => s.duplicateSelection);
  const remove = useStore((s) => s.deleteSelection);
  const engine = useEngine();

  const node = useMemo(() => (selectedIds.length === 1 ? findNode(layers, selectedIds[0]) : null), [layers, selectedIds]);

  return (
    <div className="panels" data-testid="inspector">
      {selectedIds.length > 1 && <MultiSelectionBlock ids={selectedIds} />}

      {node && (
        <>
          <Panel title="Layer" panelId="inspector-layer">
            <TextField label="Name" value={node.name} onChange={(v) => updateLayer(node.id, { name: v })} />
            <div className="ui-field ui-field--row">
              <Badge tone="neutral">{node.kind}</Badge>
              <Badge tone={node.locked ? 'warn' : 'neutral'}>{node.locked ? 'locked' : 'editable'}</Badge>
              <Badge tone={node.visible ? 'ok' : 'neutral'}>{node.visible ? 'visible' : 'hidden'}</Badge>
            </div>
            <div className="panel-actions">
              <Button size="xs" onClick={() => toggleVisibility(node.id)}>
                {node.visible ? 'Hide' : 'Show'}
              </Button>
              <Button size="xs" onClick={() => toggleLock(node.id)}>
                {node.locked ? 'Unlock' : 'Lock'}
              </Button>
              <Button size="xs" onClick={duplicate}>
                Duplicate
              </Button>
              <Button size="xs" onClick={() => engine?.frameSelection()}>
                Frame
              </Button>
              <Button size="xs" variant="danger" onClick={remove}>
                Delete
              </Button>
            </div>
          </Panel>
          <TransformBlock node={node} />
          <GeometryBlock node={node} />
        </>
      )}

      {!node && selectedIds.length === 0 && (
        <Panel title="Nothing selected" panelId="inspector-empty">
          <p className="ui-hint">
            Click an object in the viewport, or pick a layer on the left. With nothing selected this panel shows the world
            controls below.
          </p>
        </Panel>
      )}

      <TerrainPanel />
      <MeasurementPanel />
      <BookmarkPanel />
      <TimelinePanel />
      <PanoramaPanel />
      <SearchPanel />
    </div>
  );
}

/** Small shared helper for measuring between two authored points. */
export function summariseTwoPoints(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  const m = measureLocal({ x: a.x, y: a.z, z: a.y }, { x: b.x, y: b.z, z: b.y });
  return m;
}
