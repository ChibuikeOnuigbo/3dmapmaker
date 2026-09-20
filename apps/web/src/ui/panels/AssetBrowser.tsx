/**
 * apps/web — the asset browser (REQUIREMENTS 061-065, 138).
 *
 * Import GLB/GLTF (and OBJ where three's loader supports it), get a real
 * geometry/texture budget analysis before the model enters the scene, run a
 * non-destructive optimisation pass, and keep a licence record for every
 * asset. Nothing is fetched from a remote CDN.
 */
import React, { useRef, useState } from 'react';
import { Badge, Button, Panel, Slider, StatRow, Switch } from '@3dmm/ui';
import {
  AssetRegistry,
  detectModelFormat,
  loadModel,
  optimiseCopy,
  type AssetRecord,
  type ModelAnalysis,
} from '@3dmm/assets';
import { newId } from '@3dmm/project';
import { useStore } from '../../state/store';

const registry = new AssetRegistry();

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function AnalysisRows({ a }: { a: ModelAnalysis }): React.ReactElement {
  return (
    <>
      <StatRow label="Meshes" value={a.meshes} />
      <StatRow label="Triangles" value={a.triangles.toLocaleString()} />
      <StatRow label="Vertices" value={a.vertices.toLocaleString()} />
      <StatRow label="Materials" value={a.materials} />
      <StatRow label="Textures" value={a.textures} />
      <StatRow label="Texture bytes" value={fmtBytes(a.textureBytes)} tone={a.textureBytes > 64 * 1024 * 1024 ? 'warn' : undefined} />
      <StatRow label="Estimated GPU" value={fmtBytes(a.estimatedGpuBytes)} />
      <StatRow label="Animations" value={a.animations} />
      <StatRow label="Budget" value={a.budget} tone={a.budget === 'heavy' || a.budget === 'unusable' ? 'warn' : 'ok'} />
      {a.warnings.map((w) => (
        <p className="ui-hint" key={w}>
          ⚠ {w}
        </p>
      ))}
    </>
  );
}

export function AssetBrowser(): React.ReactElement {
  const addLayer = useStore((s) => s.addLayer);
  const notify = useStore((s) => s.notify);
  const setErrors = useStore((s) => s.setErrors);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; file: File; analysis: ModelAnalysis; url: string } | null>(null);
  const [ratio, setRatio] = useState(0.35);
  const [simplify, setSimplify] = useState(true);
  const [merge, setMerge] = useState(true);
  const [records, setRecords] = useState<AssetRecord[]>(() => [...registry.list()]);
  const [spdx, setSpdx] = useState('CC0-1.0');
  const [source, setSource] = useState('local file');
  const [attribution, setAttribution] = useState('');

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const format = detectModelFormat(file.name);
    if (format === 'unknown') {
      setErrors({ import: `"${file.name}" is not a supported model. Use .glb, .gltf or .obj.` });
      return;
    }
    setBusy(true);
    setProgress('Parsing geometry…');
    const abort = new AbortController();
    try {
      const loaded = await loadModel(file, file.name, { signal: abort.signal });
      const url = URL.createObjectURL(file);
      setPreview({ name: file.name, file, analysis: loaded.analysis, url });
      registry.add({
        id: newId('asset'),
        kind: 'model',
        name: file.name,
        url,
        bytes: loaded.bytes,
        license: { name: spdx || 'unspecified', spdx: spdx || 'unspecified', source, attribution },
        addedAt: Date.now(),
        analysis: loaded.analysis,
        derivatives: [],
      });
      setRecords([...registry.list()]);
      setProgress(null);
      notify('ok', `Imported ${file.name} — ${loaded.analysis.triangles.toLocaleString()} triangles, budget “${loaded.analysis.budget}”.`);
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      setErrors({ import: aborted ? 'Import cancelled.' : `Import failed: ${(err as Error).message}` });
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const addToScene = async (optimised: boolean) => {
    if (!preview) return;
    try {
      // Re-parse from the file so the optimiser works on a fresh copy and the
      // preview object is never mutated.
      const loaded = await loadModel(preview.file, preview.name, {});
      let analysis = loaded.analysis;
      let notes: string[] = [];
      if (optimised) {
        const result = optimiseCopy(loaded.scene, { triangleRatio: ratio, simplifyMaterials: simplify, mergeMeshes: merge, maxTextureSize: 1024 });
        analysis = result.after;
        notes = result.notes;
      }
      addLayer({
        id: newId('model'),
        kind: 'objects',
        name: preview.name.replace(/\.[^.]+$/, ''),
        visible: true,
        locked: false,
        position: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        anchor: { type: 'terrain', offset: 0 },
        data: {
          shape: 'imported',
          modelUrl: preview.url,
          optimised,
          triangles: analysis.triangles,
          meshes: analysis.meshes,
        },
        children: [],
      });
      for (const n of notes) notify('info', n);
      notify('ok', `Added ${preview.name} to the scene (${analysis.triangles.toLocaleString()} triangles).`);
    } catch (err) {
      setErrors({ import: `Could not add the model: ${(err as Error).message}` });
    }
  };

  return (
    <div className="panels" data-testid="asset-browser">
      <Panel title="Import model" panelId="assets-import">
        <p className="ui-hint">GLB and GLTF are first-class. OBJ loads without material animation. Files stay local.</p>
        <div className="ui-field">
          <span className="ui-label">Licence record</span>
          <div className="ui-trio">
            <input className="ui-input" value={spdx} onChange={(e) => setSpdx(e.target.value)} placeholder="SPDX id" aria-label="Licence identifier" />
            <input className="ui-input" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Source" aria-label="Licence source" />
            <input className="ui-input" value={attribution} onChange={(e) => setAttribution(e.target.value)} placeholder="Attribution" aria-label="Attribution" />
          </div>
        </div>
        <input ref={fileRef} type="file" accept=".glb,.gltf,.obj,model/gltf-binary,model/gltf+json" className="visually-hidden" onChange={(e) => void importFile(e.target.files?.[0])} />
        <div className="panel-actions">
          <Button size="xs" variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Importing…' : 'Choose a model…'}
          </Button>
        </div>
        {progress && <p className="ui-hint">{progress}</p>}
      </Panel>

      {preview && (
        <Panel title={`Budget: ${preview.name}`} panelId="assets-analysis">
          <AnalysisRows a={preview.analysis} />
          <Slider label="Target triangle ratio" value={ratio} onValueChange={setRatio} min={0.05} max={1} step={0.05} format={(v) => `${(v * 100).toFixed(0)}% kept`} />
          <Switch label="Simplify materials" description="Replace PBR graphs with a single standard material." checked={simplify} onChange={setSimplify} />
          <Switch label="Merge meshes sharing a material" checked={merge} onChange={setMerge} />
          <div className="panel-actions">
            <Button size="xs" variant="primary" onClick={() => void addToScene(false)}>
              Add as imported
            </Button>
            <Button size="xs" onClick={() => void addToScene(true)}>
              Add optimised copy
            </Button>
          </div>
          <p className="ui-hint">
            Optimising never changes the original asset; it produces a separate copy and reports the ratio it actually
            achieved. Decimation is vertex-cluster based — cheap and dependency-free.
          </p>
        </Panel>
      )}

      <Panel title={`Library (${records.length})`} panelId="assets-library">
        {records.length === 0 && <p className="ui-hint">No assets imported yet in this session.</p>}
        <ul className="asset-list">
          {records.map((r) => (
            <li key={r.id} className="asset-row">
              <span className="asset-row__name" title={r.name}>
                {r.name}
              </span>
              <Badge tone={r.license.spdx.toLowerCase().includes('cc0') ? 'ok' : 'info'}>{r.license.spdx}</Badge>
              <span className="asset-row__meta">{fmtBytes(r.bytes)}</span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  registry.remove(r.id);
                  setRecords([...registry.list()]);
                }}
              >
                Forget
              </Button>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
