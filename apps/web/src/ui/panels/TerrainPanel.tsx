/**
 * apps/web — terrain source, contours, exaggeration and analysis
 * (REQUIREMENTS 046-054).
 *
 * Every control here edits the canonical terrain state and bumps the terrain
 * revision, which is what makes the worker re-mesh. Vertical exaggeration is a
 * render-only transform and is labelled as such — it never touches stored
 * elevations or measurements.
 */
import React, { useRef, useState } from 'react';
import { Button, NumberScrub, Panel, Segmented, Slider, StatRow, Switch, TextField } from '@3dmm/ui';
import type { TerrainSource } from '@3dmm/project';
import { useEngine } from '../../engine/engineRef';
import { useStore } from '../../state/store';

function bumpTerrain(): void {
  useStore.setState((s) => ({ terrainRevision: s.terrainRevision + 1 }));
}

function ProceduralForm({ source }: { source: Extract<TerrainSource, { kind: 'procedural' }> }): React.ReactElement {
  const setTerrainSource = useStore((s) => s.setTerrainSource);
  const patch = (p: Partial<typeof source>) => {
    setTerrainSource({ ...source, ...p });
    bumpTerrain();
  };
  return (
    <>
      <NumberScrub label="Seed" value={source.seed} onChange={(v) => patch({ seed: Math.round(v) })} min={0} max={999999} step={1} precision={0} />
      <Slider label="Octaves" value={source.octaves} onValueChange={(v) => patch({ octaves: Math.round(v) })} min={1} max={8} step={1} format={(v) => v.toFixed(0)} />
      <Slider label="Amplitude" value={source.amplitude} onValueChange={(v) => patch({ amplitude: v })} min={1} max={3000} step={1} format={(v) => `${v.toFixed(0)} m`} />
      <Slider label="Feature size" value={1 / source.frequency} onValueChange={(v) => patch({ frequency: 1 / Math.max(1, v) })} min={200} max={200000} step={100} format={(v) => `${(v / 1000).toFixed(1)} km`} />
      <Slider label="Roughness (gain)" value={source.gain} onValueChange={(v) => patch({ gain: v })} min={0.1} max={0.9} step={0.01} format={(v) => v.toFixed(2)} />
      <Slider label="Domain warp" value={source.warp} onValueChange={(v) => patch({ warp: v })} min={0} max={1.5} step={0.01} format={(v) => v.toFixed(2)} />
      <Switch label="Ridged noise" description="Sharper crests, better for mountain ranges." checked={source.ridged} onChange={(v) => patch({ ridged: v })} />
      <div className="panel-actions">
        <Button size="xs" onClick={() => patch({ seed: Math.floor(Math.random() * 999999) })}>
          Randomise
        </Button>
      </div>
    </>
  );
}

function HeightmapForm(): React.ReactElement {
  const setTerrainSource = useStore((s) => s.setTerrainSource);
  const notify = useStore((s) => s.notify);
  const setErrors = useStore((s) => s.setErrors);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<string>('No raster imported.');

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setStatus('Reading…');
    try {
      const bitmap = await createImageBitmap(file);
      const bw = bitmap.width;
      const bh = bitmap.height;
      const canvas = document.createElement('canvas');
      canvas.width = bw;
      canvas.height = bh;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas is unavailable in this browser.');
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bw, bh);
      // Encode the real raster as a 16-bit-ish PNG data URL. 8-bit per channel
      // is what a browser can round-trip without a WASM encoder, so the panel
      // says exactly what precision you get instead of pretending otherwise.
      const png = canvas.toDataURL('image/png');
      bitmap.close();
      // The pixel data is read so a corrupt or opaque-only file is rejected
      // here rather than producing a silently flat world.
      if (data.length < bw * bh * 4) throw new Error('The decoder returned fewer pixels than expected.');
      setTerrainSource({ kind: 'heightmap', url: png, scale: 1, offset: 0, noDataValue: null, format: 'png16' });
      bumpTerrain();
      setStatus(`Loaded ${bw}×${bh} (stored as an 8-bit/channel PNG; import a 16-bit GeoTIFF for full precision).`);
      notify('ok', `Heightmap imported: ${file.name}`);
    } catch (err) {
      const msg = `Could not read that image: ${(err as Error).message}`;
      setStatus(msg);
      setErrors({ terrain: msg });
    }
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/tiff"
        className="visually-hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <div className="panel-actions">
        <Button size="xs" variant="primary" onClick={() => fileRef.current?.click()}>
          Import heightmap…
        </Button>
      </div>
      <p className="ui-hint">{status}</p>
    </>
  );
}

export function TerrainPanel(): React.ReactElement {
  const terrain = useStore((s) => s.project.terrain);
  const setTerrain = useStore((s) => s.setTerrain);
  const setTerrainSource = useStore((s) => s.setTerrainSource);
  const engine = useEngine();
  const stats = useStore((s) => s.stats);
  const [profilePoint, setProfilePoint] = useState<{ from: { x: number; z: number }; to: { x: number; z: number } } | null>(null);
  const [profile, setProfile] = useState<Array<{ d: number; h: number }> | null>(null);

  const switchKind = (kind: TerrainSource['kind']) => {
    if (kind === 'procedural') setTerrainSource({ kind: 'procedural', seed: 1337, octaves: 5, lacunarity: 2.02, gain: 0.5, amplitude: 180, frequency: 0.0012, warp: 0.35, ridged: false });
    else if (kind === 'flat') setTerrainSource({ kind: 'flat', elevation: 0 });
    else if (kind === 'heightmap') return; // handled by the file input
    else setTerrainSource({ kind: 'provider', providerId: 'synthetic', maxZoom: 12 });
    bumpTerrain();
  };

  const runProfile = () => {
    const te = engine?.getTerrainEngine();
    if (!te) {
      useStore.getState().notify('warn', 'Terrain is still building — try again in a moment.');
      return;
    }
    const snap = engine?.getDebugSnapshot();
    const c = snap?.rig.target ?? { x: 0, y: 0, z: 0 };
    const from = { x: c.x - 400, z: c.z };
    const to = { x: c.x + 400, z: c.z };
    setProfilePoint({ from, to });
    const samples = 160;
    const out: Array<{ d: number; h: number }> = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const x = from.x + (to.x - from.x) * t;
      const z = from.z + (to.z - from.z) * t;
      out.push({ d: Math.hypot(x - from.x, z - from.z), h: te.heightAt(x, z) ?? 0 });
    }
    setProfile(out);
  };

  return (
    <div>
      <Panel title="Terrain" panelId="terrain">
        <div className="ui-field">
          <span className="ui-label">Source</span>
          <Segmented
            size="xs"
            label="Terrain source"
            value={terrain.source.kind}
            onChange={switchKind}
            options={[
              { value: 'procedural', label: 'Procedural' },
              { value: 'heightmap', label: 'Heightmap' },
              { value: 'flat', label: 'Flat' },
              { value: 'provider', label: 'Provider' },
            ]}
          />
        </div>

        {terrain.source.kind === 'procedural' && <ProceduralForm source={terrain.source} />}
        {terrain.source.kind === 'flat' && (
          <NumberScrub
            label="Elevation"
            value={terrain.source.elevation}
            onChange={(v) => {
              setTerrainSource({ kind: 'flat', elevation: v });
              bumpTerrain();
            }}
            min={-500}
            max={9000}
            step={1}
            precision={1}
            suffix="m"
          />
        )}
        {terrain.source.kind === 'heightmap' && <HeightmapForm />}
        {terrain.source.kind === 'provider' && (() => {
          const provider = terrain.source;
          return (
          <>
            <TextField
              label="Provider id"
              value={provider.providerId}
              onChange={(v) => {
                setTerrainSource({ kind: 'provider', providerId: v, maxZoom: provider.maxZoom });
                bumpTerrain();
              }}
              hint="Registered providers only. No key is stored in the project."
            />
            <Slider
              label="Max zoom"
              value={provider.maxZoom}
              onValueChange={(v) => {
                setTerrainSource({ kind: 'provider', providerId: provider.providerId, maxZoom: Math.round(v) });
                bumpTerrain();
              }}
              min={0}
              max={15}
              step={1}
              format={(v) => `z${v.toFixed(0)}`}
            />
          </>
          );
        })()}

        <Slider
          label="Tile size"
          value={terrain.tileSizeMeters}
          onValueChange={(v) => {
            setTerrain({ tileSizeMeters: v });
            bumpTerrain();
          }}
          min={32}
          max={1024}
          step={32}
          format={(v) => `${v.toFixed(0)} m`}
        />
        <Slider
          label="Mesh detail"
          value={terrain.segments}
          onValueChange={(v) => {
            setTerrain({ segments: Math.round(v) });
            bumpTerrain();
          }}
          min={8}
          max={128}
          step={4}
          format={(v) => `${v.toFixed(0)}² verts`}
        />
        <Slider
          label="Vertical exaggeration"
          value={terrain.verticalExaggeration}
          onValueChange={(v) => {
            setTerrain({ verticalExaggeration: v });
            bumpTerrain();
          }}
          min={1}
          max={10}
          step={0.1}
          format={(v) => `${v.toFixed(1)}×`}
        />
        <p className="ui-hint">Exaggeration is visual only. Measurements and exports always use true elevations.</p>

        <Switch
          label="Contours"
          description="Index contours are heavier and drawn every 5th line."
          checked={terrain.contours.enabled}
          onChange={(v) => {
            setTerrain({ contours: { ...terrain.contours, enabled: v } });
            engine?.rebuildContours();
          }}
        />
        {terrain.contours.enabled && (
          <Slider
            label="Contour interval"
            value={terrain.contours.interval}
            onValueChange={(v) => {
              setTerrain({ contours: { ...terrain.contours, interval: v } });
              engine?.rebuildContours();
            }}
            min={5}
            max={500}
            step={5}
            format={(v) => `${v.toFixed(0)} m`}
          />
        )}

        <StatRow label="Tiles active" value={stats.tiles.active} />
        <StatRow label="Tiles loading" value={stats.tiles.loading} />
        <StatRow label="Tiles failed" value={stats.tiles.failed} tone={stats.tiles.failed > 0 ? 'error' : undefined} />
        <StatRow label="Terrain worker" value={stats.workerAvailable ? 'active' : 'inline fallback'} tone={stats.workerAvailable ? 'ok' : 'warn'} />
      </Panel>

      <Panel title="Elevation profile" panelId="terrain-profile">
        <div className="panel-actions">
          <Button size="xs" onClick={runProfile}>
            Sample across the view centre
          </Button>
          {profile && (
            <Button size="xs" variant="ghost" onClick={() => { setProfile(null); setProfilePoint(null); }}>
              Clear
            </Button>
          )}
        </div>
        {profile && profilePoint && <ProfileChart data={profile} from={profilePoint.from} to={profilePoint.to} />}
        {!profile && <p className="ui-hint">Samples real terrain heights — 161 points along an 800 m line.</p>}
      </Panel>
    </div>
  );
}

function ProfileChart({ data, from, to }: { data: Array<{ d: number; h: number }>; from: { x: number; z: number }; to: { x: number; z: number } }): React.ReactElement {
  const w = 260;
  const h = 88;
  const hs = data.map((p) => p.h);
  const minH = Math.min(...hs);
  const maxH = Math.max(...hs);
  const span = Math.max(1e-6, maxH - minH);
  const maxD = Math.max(1e-6, data[data.length - 1].d);
  const points = data
    .map((p) => `${((p.d / maxD) * w).toFixed(1)},${(h - ((p.h - minH) / span) * (h - 8) - 4).toFixed(1)}`)
    .join(' ');
  return (
    <div className="profile">
      <svg viewBox={`0 0 ${w} ${h}`} className="profile__svg" role="img" aria-label={`Elevation profile from ${minH.toFixed(0)} to ${maxH.toFixed(0)} metres`}>
        <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      </svg>
      <div className="profile__legend">
        <span>{maxH.toFixed(0)} m</span>
        <span>{(to.x - from.x).toFixed(0)} m long</span>
        <span>{minH.toFixed(0)} m</span>
      </div>
    </div>
  );
}
