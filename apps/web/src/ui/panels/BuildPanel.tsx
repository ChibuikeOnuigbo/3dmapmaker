/**
 * apps/web — the build panel (REQUIREMENTS 055-064, 070).
 *
 * Everything that adds authored content to the world lives here. Each action
 * creates a real layer node with real geometry parameters; the engine turns it
 * into a mesh on the next sync. Nothing is a stub.
 */
import React, { useState } from 'react';
import { Button, NumberScrub, Panel, Segmented, Slider, Switch, TextField } from '@3dmm/ui';
import { newId, type LayerKind, type ObjectNode } from '@3dmm/project';
import { useEngine } from '../../engine/engineRef';
import { useStore } from '../../state/store';

function makeNode(kind: LayerKind, name: string, data: Record<string, unknown>, partial: Partial<ObjectNode> = {}): ObjectNode {
  return {
    id: newId(kind),
    kind,
    name,
    visible: true,
    locked: false,
    position: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    anchor: { type: 'world' },
    data,
    children: [],
    ...partial,
  };
}

function squareFootprint(w: number, d: number) {
  const hw = w / 2;
  const hd = d / 2;
  return [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ];
}

/* ------------------------------------------------------------- buildings --- */

function BuildingForm(): React.ReactElement {
  const addLayer = useStore((s) => s.addLayer);
  const engine = useEngine();
  const [width, setWidth] = useState(14);
  const [depth, setDepth] = useState(12);
  const [floors, setFloors] = useState(4);
  const [floorHeight, setFloorHeight] = useState(3.3);
  const [roof, setRoof] = useState<'flat' | 'gable' | 'hip'>('gable');
  const [count, setCount] = useState(6);
  const [spread, setSpread] = useState(40);

  const place = (atOrigin: boolean) => {
    const group: ObjectNode = makeNode('group', `Block (${count} buildings)`, {});
    for (let i = 0; i < count; i++) {
      const angle = (i / Math.max(1, count)) * Math.PI * 2;
      const r = atOrigin ? 0 : spread;
      const jitter = atOrigin ? 0 : ((i * 2654435761) % 1000) / 1000;
      group.children.push(
        makeNode('buildings', `Building ${i + 1}`, {
          footprint: squareFootprint(width * (0.7 + jitter * 0.6), depth * (0.7 + ((jitter * 7) % 1) * 0.6)),
          floors: Math.max(1, Math.round(floors * (0.7 + jitter * 0.7))),
          floorHeight,
          roof,
        }, {
          position: atOrigin ? { x: 0, y: 0, z: 0 } : { x: Math.cos(angle) * r, y: 0, z: Math.sin(angle) * r },
          anchor: { type: 'terrain', offset: 0 },
        }),
      );
    }
    addLayer(group);
    engine?.forceTerrainUpdate();
  };

  return (
    <Panel title="Buildings" panelId="build-buildings">
      <Slider label="Footprint width" value={width} onValueChange={setWidth} min={4} max={120} step={1} format={(v) => `${v.toFixed(0)} m`} />
      <Slider label="Footprint depth" value={depth} onValueChange={setDepth} min={4} max={120} step={1} format={(v) => `${v.toFixed(0)} m`} />
      <Slider label="Floors" value={floors} onValueChange={setFloors} min={1} max={80} step={1} format={(v) => v.toFixed(0)} />
      <Slider label="Floor height" value={floorHeight} onValueChange={setFloorHeight} min={2} max={8} step={0.1} format={(v) => `${v.toFixed(1)} m`} />
      <Segmented size="xs" label="Roof" value={roof} onChange={setRoof} options={[{ value: 'flat', label: 'Flat' }, { value: 'gable', label: 'Gable' }, { value: 'hip', label: 'Hip' }]} />
      <Slider label="Buildings" value={count} onValueChange={setCount} min={1} max={60} step={1} format={(v) => v.toFixed(0)} />
      <Slider label="Spread radius" value={spread} onValueChange={setSpread} min={0} max={400} step={5} format={(v) => `${v.toFixed(0)} m`} />
      <div className="panel-actions">
        <Button size="xs" variant="primary" onClick={() => place(false)}>
          Add block
        </Button>
        <Button size="xs" onClick={() => place(true)}>
          Add one at centre
        </Button>
      </div>
    </Panel>
  );
}

/* ----------------------------------------------------------------- water --- */

function WaterForm(): React.ReactElement {
  const addLayer = useStore((s) => s.addLayer);
  const [level, setLevel] = useState(2);
  const [radius, setRadius] = useState(90);
  const [color, setColor] = useState('#2f6f8f');
  const [segments, setSegments] = useState(28);

  return (
    <Panel title="Water" panelId="build-water">
      <Slider label="Surface level" value={level} onValueChange={setLevel} min={-200} max={800} step={0.5} format={(v) => `${v.toFixed(1)} m`} />
      <Slider label="Radius" value={radius} onValueChange={setRadius} min={5} max={1200} step={5} format={(v) => `${v.toFixed(0)} m`} />
      <Slider label="Outline detail" value={segments} onValueChange={setSegments} min={6} max={64} step={1} format={(v) => v.toFixed(0)} />
      <div className="ui-field ui-field--row">
        <label className="ui-label" htmlFor="water-color">Colour</label>
        <input id="water-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="ui-color" />
      </div>
      <div className="panel-actions">
        <Button
          size="xs"
          variant="primary"
          onClick={() => {
            const ring: Array<{ x: number; y: number }> = [];
            for (let i = 0; i < segments; i++) {
              const a = (i / segments) * Math.PI * 2;
              ring.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
            }
            addLayer(makeNode('water', `Water body ${level.toFixed(0)} m`, { ring, level, color }));
          }}
        >
          Add water body
        </Button>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------ vegetation --- */

function VegetationForm(): React.ReactElement {
  const addLayer = useStore((s) => s.addLayer);
  const [count, setCount] = useState(600);
  const [radius, setRadius] = useState(160);
  const [maxSlope, setMaxSlope] = useState(32);
  const [seed, setSeed] = useState(1234);
  const [billboards, setBillboards] = useState(true);

  return (
    <Panel title="Vegetation" panelId="build-vegetation">
      <Slider label="Instance count" value={count} onValueChange={setCount} min={10} max={20000} step={10} format={(v) => v.toFixed(0)} />
      <Slider label="Scatter radius" value={radius} onValueChange={setRadius} min={10} max={2000} step={10} format={(v) => `${v.toFixed(0)} m`} />
      <Slider label="Max slope" value={maxSlope} onValueChange={setMaxSlope} min={0} max={80} step={1} format={(v) => `${v.toFixed(0)}°`} />
      <NumberScrub label="Seed" value={seed} onChange={(v) => setSeed(Math.round(v))} min={0} max={999999} step={1} precision={0} />
      <Switch label="Distance billboards" description="Swap far instances to camera-facing quads." checked={billboards} onChange={setBillboards} />
      <div className="panel-actions">
        <Button
          size="xs"
          variant="primary"
          onClick={() =>
            addLayer(
              makeNode('vegetation', `Vegetation (${count})`, {
                count,
                seed,
                bounds: { minX: -radius, minZ: -radius, maxX: radius, maxZ: radius },
                maxSlopeDeg: maxSlope,
                minScale: 0.6,
                maxScale: 1.8,
                billboards,
              }),
            )
          }
        >
          Scatter
        </Button>
      </div>
      <p className="ui-hint">Instanced on the GPU from one seeded pass, so the same seed always gives the same forest.</p>
    </Panel>
  );
}

/* --------------------------------------------------------------- objects --- */

function ObjectForm(): React.ReactElement {
  const addLayer = useStore((s) => s.addLayer);
  const [shape, setShape] = useState<'box' | 'sphere' | 'cylinder' | 'cone' | 'torus'>('box');
  const [size, setSize] = useState(4);
  const [color, setColor] = useState('#c0663f');
  const [snapToTerrain, setSnapToTerrain] = useState(true);

  return (
    <Panel title="Objects" panelId="build-objects">
      <Segmented
        size="xs"
        label="Shape"
        value={shape}
        onChange={setShape}
        options={[
          { value: 'box', label: 'Box' },
          { value: 'sphere', label: 'Sphere' },
          { value: 'cylinder', label: 'Cylinder' },
          { value: 'cone', label: 'Cone' },
          { value: 'torus', label: 'Torus' },
        ]}
      />
      <Slider label="Size" value={size} onValueChange={setSize} min={0.5} max={60} step={0.5} format={(v) => `${v.toFixed(1)} m`} />
      <div className="ui-field ui-field--row">
        <label className="ui-label" htmlFor="obj-color">Colour</label>
        <input id="obj-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="ui-color" />
      </div>
      <Switch label="Snap to terrain" description="Drop the object onto the ground beneath it." checked={snapToTerrain} onChange={setSnapToTerrain} />
      <div className="panel-actions">
        <Button
          size="xs"
          variant="primary"
          onClick={() =>
            addLayer(
              makeNode('objects', `${shape} ${size.toFixed(0)}m`, { shape, color, size }, {
                position: { x: 0, y: snapToTerrain ? 0 : size / 2, z: 0 },
                scale: { x: size, y: size, z: size },
                anchor: snapToTerrain ? { type: 'terrain', offset: 0 } : { type: 'world' },
              }),
            )
          }
        >
          Add {shape}
        </Button>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------- annotations --- */

function AnnotationForm(): React.ReactElement {
  const addLayer = useStore((s) => s.addLayer);
  const engine = useEngine();
  const [name, setName] = useState('New marker');
  const [kind, setKind] = useState<'markers' | 'labels' | 'annotations'>('markers');
  const [note, setNote] = useState('');

  const addAtCentre = () => {
    const snap = engine?.getDebugSnapshot();
    const t = snap?.rig.target ?? { x: 0, y: 0, z: 0 };
    addLayer(
      makeNode(kind, name, { note, color: '#f6c453' }, {
        position: { x: t.x, y: 0, z: t.z },
        anchor: { type: 'terrain', offset: 0 },
      }),
    );
  };

  return (
    <Panel title="Markers, labels & notes" panelId="build-annotations">
      <Segmented size="xs" label="Type" value={kind} onChange={setKind} options={[{ value: 'markers', label: 'Marker' }, { value: 'labels', label: 'Label' }, { value: 'annotations', label: 'Note' }]} />
      <TextField label="Name" value={name} onChange={setName} />
      {kind === 'annotations' && <TextField label="Note text" value={note} onChange={setNote} />}
      <div className="panel-actions">
        <Button size="xs" variant="primary" onClick={addAtCentre}>
          Place at view centre
        </Button>
      </div>
    </Panel>
  );
}

/* --------------------------------------------------------------- trigger --- */

function TriggerForm(): React.ReactElement {
  const addLayer = useStore((s) => s.addLayer);
  const [name, setName] = useState('Entry trigger');
  const [radius, setRadius] = useState(12);
  const [action, setAction] = useState('notify');
  const [message, setMessage] = useState('You entered the area.');

  return (
    <Panel title="Triggers" panelId="build-triggers">
      <p className="ui-hint">
        Triggers are declarative: they can move the camera, show a message, toggle a layer or start a tour. They never run
        code, so an imported world cannot do anything you did not configure.
      </p>
      <TextField label="Name" value={name} onChange={setName} />
      <Slider label="Radius" value={radius} onValueChange={setRadius} min={1} max={400} step={1} format={(v) => `${v.toFixed(0)} m`} />
      <Segmented
        size="xs"
        label="Action"
        value={action}
        onChange={setAction}
        options={[
          { value: 'notify', label: 'Message' },
          { value: 'flyTo', label: 'Fly here' },
          { value: 'toggleLayer', label: 'Toggle layer' },
          { value: 'startTour', label: 'Start tour' },
        ]}
      />
      {action === 'notify' && <TextField label="Message" value={message} onChange={setMessage} />}
      <div className="panel-actions">
        <Button
          size="xs"
          variant="primary"
          onClick={() => addLayer(makeNode('triggers', name, { radius, action, message }, { anchor: { type: 'terrain', offset: 0 } }))}
        >
          Add trigger
        </Button>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ shell --- */

export function BuildPanel(): React.ReactElement {
  return (
    <div className="panels" data-testid="build-panel">
      <BuildingForm />
      <WaterForm />
      <VegetationForm />
      <ObjectForm />
      <AnnotationForm />
      <TriggerForm />
    </div>
  );
}
