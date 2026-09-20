/**
 * apps/web — the panorama node graph (REQUIREMENTS 038-045).
 *
 * Nodes, neighbour edges, environment caps, pitch clamping, transition length
 * and persistence are all canonical project state. Synthetic depth is always
 * labelled as synthetic, and a node with no image says so instead of showing a
 * black gap.
 */
import React, { useRef, useState } from 'react';
import { Button, NumberScrub, Panel, Segmented, Slider, StatRow, Switch, TextField } from '@3dmm/ui';
import { analyzePoleValidity, clampPanoramaPitch } from '@3dmm/panorama';
import { useEngine } from '../../engine/engineRef';
import { useStore } from '../../state/store';

export function PanoramaPanel(): React.ReactElement {
  const pano = useStore((s) => s.project.panorama);
  const setPanorama = useStore((s) => s.setPanorama);
  const upsertNode = useStore((s) => s.upsertPanoramaNode);
  const link = useStore((s) => s.linkPanorama);
  const setCurrent = useStore((s) => s.setPanoramaCurrent);
  const mutate = useStore((s) => s.mutate);
  const setCameraMode = useStore((s) => s.setCameraMode);
  const engine = useEngine();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [targetId, setTargetId] = useState('');
  const [name, setName] = useState('');
  const [poles, setPoles] = useState<{ topValid: boolean; bottomValid: boolean; topMean: [number, number, number]; bottomMean: [number, number, number] } | null>(null);

  const current = pano.nodes.find((n) => n.id === pano.currentNodeId) ?? null;

  const addNode = () => {
    const snap = engine?.getDebugSnapshot();
    const t = snap?.rig.target ?? { x: 0, y: 0, z: 0 };
    const id = `pano_${Date.now().toString(36)}`;
    upsertNode({
      id,
      name: name.trim() || `Panorama ${pano.nodes.length + 1}`,
      position: { x: t.x, y: 1.7, z: t.z },
      headingDeg: snap?.rig.headingDeg ?? 0,
      image: '',
      neighbors: {},
      vfovDeg: 180,
      cap: { enabled: true, top: '#8fb6e0', bottom: '#4a4740', blendDeg: 20 },
    });
    setCurrent(id);
    setName('');
  };

  const attachImage = async (file: File | undefined) => {
    if (!file || !current) return;
    try {
      const bitmap = await createImageBitmap(file);
      const w = bitmap.width;
      const h = bitmap.height;
      const ratio = w / Math.max(1, h);
      // Read the pixels so the pole analysis and the cap colours come from the
      // actual image rather than a guess.
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      let analysis: ReturnType<typeof analyzePoleValidity> | null = null;
      let topHex = current.cap.top;
      let bottomHex = current.cap.bottom;
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0);
        const { data } = ctx.getImageData(0, 0, w, h);
        analysis = analyzePoleValidity(data, w, h, 4);
        setPoles(analysis);
        const toHex = (c: [number, number, number]) =>
          `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
        topHex = toHex(analysis.topMean);
        bottomHex = toHex(analysis.bottomMean);
      }
      bitmap.close();
      if (ratio < 1.5) {
        useStore.getState().notify('warn', `That image is ${ratio.toFixed(2)}:1. An equirectangular panorama should be close to 2:1.`);
      }
      const url = URL.createObjectURL(file);
      upsertNode({
        ...current,
        image: url,
        cap: { enabled: true, top: topHex, bottom: bottomHex, blendDeg: current.cap.blendDeg },
      });
      const missing = analysis && (!analysis.topValid || !analysis.bottomValid)
        ? ` Missing data at the ${!analysis.topValid ? 'top' : ''}${analysis && !analysis.topValid && !analysis.bottomValid ? ' and ' : ''}${!analysis.bottomValid ? 'bottom' : ''} — the environment caps cover it.`
        : '';
      useStore.getState().notify(analysis && (!analysis.topValid || !analysis.bottomValid) ? 'warn' : 'ok', `Panorama attached (${w}px wide).${missing}`);
    } catch (err) {
      useStore.getState().setErrors({ import: `Could not read that image: ${(err as Error).message}` });
    }
  };

  const validity = poles;

  return (
    <Panel title="Panoramas" panelId="panorama">
      <StatRow label="Nodes" value={pano.nodes.length} />
      <StatRow label="Linked pairs" value={pano.nodes.reduce((a, n) => a + Object.keys(n.neighbors).length, 0)} />

      <div className="panel-actions">
        <Button size="xs" variant="primary" onClick={addNode}>
          Add node at view centre
        </Button>
        <Button
          size="xs"
          disabled={pano.nodes.length === 0}
          onClick={() => {
            setCameraMode('panorama');
            engine?.setMode('panorama');
          }}
        >
          Enter panorama mode
        </Button>
      </div>

      <div className="ui-field">
        <span className="ui-label">New node name</span>
        <TextField label="Name" value={name} onChange={setName} placeholder="e.g. Station Square" />
      </div>

      {current && (
        <>
          <div className="ui-field">
            <span className="ui-label">Current node</span>
            <div className="ui-field ui-field--row">
              <strong>{current.name}</strong>
              {current.image ? <span className="ui-badge ui-badge--ok">image</span> : <span className="ui-badge ui-badge--warn">no image — colour caps only</span>}
            </div>
          </div>

          <input ref={fileRef} type="file" accept="image/*" className="visually-hidden" onChange={(e) => void attachImage(e.target.files?.[0])} />
          <div className="panel-actions">
            <Button size="xs" onClick={() => fileRef.current?.click()}>
              Attach equirectangular image…
            </Button>
            <Button size="xs" variant="ghost" onClick={() => upsertNode({ ...current, image: '' })}>
              Detach image
            </Button>
          </div>

          <NumberScrub
            label="Vertical FOV"
            value={current.vfovDeg}
            onChange={(v) => upsertNode({ ...current, vfovDeg: Math.min(360, Math.max(1, v)) })}
            min={1}
            max={360}
            step={1}
            precision={0}
            suffix="°"
          />
          {validity && (
            <p className="ui-hint">
              Pole coverage: {validity.topValid ? 'top present' : 'top missing'} / {validity.bottomValid ? 'bottom present' : 'bottom missing'}. Cap
              colours were sampled from the image itself.
            </p>
          )}

          <Switch
            label="Environment caps"
            description="Gradient-filled top and bottom so a partial panorama never shows a black gap."
            checked={current.cap.enabled}
            onChange={(v) => upsertNode({ ...current, cap: { ...current.cap, enabled: v } })}
          />
          {current.cap.enabled && (
            <>
              <Slider
                label="Cap blend"
                value={current.cap.blendDeg}
                onValueChange={(v) => upsertNode({ ...current, cap: { ...current.cap, blendDeg: v } })}
                min={0}
                max={90}
                step={1}
                format={(v) => `${v.toFixed(0)}°`}
              />
              <div className="ui-field ui-field--row">
                <label className="ui-label" htmlFor="cap-top">Top</label>
                <input id="cap-top" type="color" className="ui-color" value={current.cap.top} onChange={(e) => upsertNode({ ...current, cap: { ...current.cap, top: e.target.value } })} />
                <label className="ui-label" htmlFor="cap-bottom">Bottom</label>
                <input id="cap-bottom" type="color" className="ui-color" value={current.cap.bottom} onChange={(e) => upsertNode({ ...current, cap: { ...current.cap, bottom: e.target.value } })} />
              </div>
            </>
          )}

          <Slider
            label="Pitch clamp"
            value={pano.pitchClampDeg}
            onValueChange={(v) => setPanorama({ pitchClampDeg: v })}
            min={5}
            max={89}
            step={1}
            format={(v) => `±${v.toFixed(0)}°`}
          />
          <p className="ui-hint">
            Live pitch is clamped to ±{pano.pitchClampDeg}°. Current: {clampPanoramaPitch(useStore.getState().project.camera.pitchDeg, pano.pitchClampDeg).toFixed(1)}°.
          </p>

          <div className="ui-field">
            <span className="ui-label">Link this node to…</span>
            <select className="ui-select__trigger" value={targetId} onChange={(e) => setTargetId(e.target.value)} aria-label="Target node">
              <option value="">Choose a node</option>
              {pano.nodes
                .filter((n) => n.id !== current.id)
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="panel-actions">
            {['north', 'east', 'south', 'west', 'forward', 'back'].map((dir) => (
              <Button
                key={dir}
                size="xs"
                disabled={!targetId}
                onClick={() => {
                  link(current.id, dir, targetId);
                  useStore.getState().notify('ok', `Linked ${current.name} → ${targetId} as "${dir}".`);
                }}
              >
                Link {dir}
              </Button>
            ))}
          </div>
          {Object.keys(current.neighbors).length > 0 && (
            <div className="ui-field">
              <span className="ui-label">Existing links</span>
              {Object.entries(current.neighbors).map(([dir, to]) => (
                <div className="ui-field ui-field--row" key={dir}>
                  <span>
                    {dir} → {pano.nodes.find((n) => n.id === to)?.name ?? to}
                  </span>
                  <Button size="xs" variant="ghost" onClick={() => link(current.id, dir, '')}>
                    Unlink
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <Slider
        label="Transition length"
        value={pano.transitionMs}
        onValueChange={(v) => setPanorama({ transitionMs: v })}
        min={0}
        max={2000}
        step={20}
        format={(v) => `${v.toFixed(0)} ms`}
      />

      <Switch
        label="Persistence between nodes"
        description="Carry the previous view across the transition instead of a hard cut."
        checked={pano.persistence.enabled}
        onChange={(v) => setPanorama({ persistence: { ...pano.persistence, enabled: v } })}
      />
      {pano.persistence.enabled && (
        <>
          <Slider
            label="Persistence strength"
            value={pano.persistence.strength}
            onValueChange={(v) => setPanorama({ persistence: { ...pano.persistence, strength: v } })}
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
          />
          <Segmented
            size="xs"
            label="Persistence mode"
            value={pano.persistence.mode}
            onChange={(v) => setPanorama({ persistence: { ...pano.persistence, mode: v } })}
            options={[
              { value: 'fade', label: 'Crossfade' },
              { value: 'blur', label: 'Blur' },
              { value: 'echo', label: 'Echo' },
            ]}
          />
        </>
      )}

      <Switch
        label="Synthetic depth"
        description="Parallax from a generated depth estimate. Always marked as synthetic — never presented as real capture."
        checked={pano.depth.enabled}
        onChange={(v) => setPanorama({ depth: { ...pano.depth, enabled: v } })}
      />
      {pano.depth.enabled && (
        <>
          <span className="ui-badge ui-badge--warn">synthetic</span>
          <Slider
            label="Depth scale"
            value={pano.depth.scale}
            onValueChange={(v) => setPanorama({ depth: { ...pano.depth, scale: v } })}
            min={0}
            max={1}
            step={0.01}
            format={(v) => v.toFixed(2)}
          />
        </>
      )}

      <ul className="pano-list">
        {pano.nodes.map((n) => (
          <li key={n.id} className="pano-row" data-active={n.id === pano.currentNodeId ? 'true' : 'false'}>
            <button
              type="button"
              className="pano-row__go"
              onClick={() => {
                setCurrent(n.id);
                engine?.goToPanorama(n.id);
              }}
            >
              {n.name}
            </button>
            <span className="pano-row__meta">{Object.keys(n.neighbors).length} links</span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                mutate((d) => {
                  d.panorama = {
                    ...d.panorama,
                    nodes: d.panorama.nodes.filter((x) => x.id !== n.id).map((x) => {
                      const neighbors = { ...x.neighbors };
                      for (const [k, v] of Object.entries(neighbors)) if (v === n.id) delete neighbors[k];
                      return { ...x, neighbors };
                    }),
                    currentNodeId: d.panorama.currentNodeId === n.id ? null : d.panorama.currentNodeId,
                  };
                }, 'Remove panorama node')
              }
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
