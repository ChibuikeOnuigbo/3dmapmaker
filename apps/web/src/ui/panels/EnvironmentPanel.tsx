/**
 * apps/web — scene environment (REQUIREMENTS 102-110).
 *
 * Sun position is derived from time of day, so the two controls stay
 * consistent. Fog, post effects and shadows map onto real renderer state
 * through SceneManager/PostFx; the blur is a separable, downsampled GPU pass,
 * never a full-resolution CPU loop.
 */
import React from 'react';
import { Panel, Segmented, Slider, StatRow, Switch } from '@3dmm/ui';
import { useStore } from '../../state/store';

/** Sun elevation/azimuth from a 24 h clock — a real, if simple, solar model. */
export function sunFromTimeOfDay(hours: number, latitudeDeg: number): { azimuthDeg: number; elevationDeg: number } {
  const t = ((hours - 6) / 12) * Math.PI; // 06:00 -> 0, 18:00 -> π
  const lat = (latitudeDeg * Math.PI) / 180;
  const declination = 0; // equinox; the model is deliberately honest about that
  const elevation = Math.asin(Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(t));
  const azimuth = Math.atan2(Math.sin(t), Math.cos(t) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat));
  return {
    elevationDeg: (elevation * 180) / Math.PI,
    azimuthDeg: ((azimuth * 180) / Math.PI + 180 + 360) % 360,
  };
}

const WEATHER_PRESETS: Record<string, { fogMode: 'linear' | 'exponential' | 'height'; density: number; near: number; far: number; color: string; saturation: number; contrast: number }> = {
  clear: { fogMode: 'linear', density: 0.0002, near: 600, far: 6000, color: '#b9c8d8', saturation: 1, contrast: 1 },
  rain: { fogMode: 'exponential', density: 0.0012, near: 100, far: 2200, color: '#6d7c88', saturation: 0.82, contrast: 0.94 },
  snow: { fogMode: 'height', density: 0.0009, near: 80, far: 2600, color: '#dfe7ee', saturation: 0.9, contrast: 0.97 },
  fog: { fogMode: 'exponential', density: 0.0035, near: 20, far: 900, color: '#c3ccd4', saturation: 0.72, contrast: 0.9 },
};

export function EnvironmentPanel(): React.ReactElement {
  const env = useStore((s) => s.project.environment);
  const setEnvironment = useStore((s) => s.setEnvironment);
  const setPerformance = useStore((s) => s.setPerformance);
  const perf = useStore((s) => s.project.performance);
  const origin = useStore((s) => s.project.world.origin);
  const stats = useStore((s) => s.stats);

  const sun = sunFromTimeOfDay(env.timeOfDay, origin.lat);

  const setFog = (patch: Partial<typeof env.fog>) => setEnvironment({ fog: { ...env.fog, ...patch } });
  const setPost = (patch: Partial<typeof env.post>) => setEnvironment({ post: { ...env.post, ...patch } });

  return (
    <div className="panels" data-testid="environment-panel">
      <Panel title="Lighting & time" panelId="env-lighting">
        <Slider
          label="Time of day"
          value={env.timeOfDay}
          onValueChange={(v) => {
            const s = sunFromTimeOfDay(v, origin.lat);
            setEnvironment({ timeOfDay: v, sunAzimuthDeg: s.azimuthDeg, sunElevationDeg: Math.max(-90, s.elevationDeg) });
          }}
          min={0}
          max={24}
          step={0.05}
          format={(v) => `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`}
        />
        <Slider
          label="Sun azimuth"
          value={env.sunAzimuthDeg}
          onValueChange={(v) => setEnvironment({ sunAzimuthDeg: v })}
          min={0}
          max={360}
          step={1}
          format={(v) => `${v.toFixed(0)}°`}
        />
        <Slider
          label="Sun elevation"
          value={env.sunElevationDeg}
          onValueChange={(v) => setEnvironment({ sunElevationDeg: v })}
          min={-10}
          max={90}
          step={0.5}
          format={(v) => `${v.toFixed(1)}°`}
        />
        <StatRow label="Solar model" value={`equinox @ ${origin.lat.toFixed(2)}° lat`} />
        <StatRow label="Derived elevation" value={`${sun.elevationDeg.toFixed(1)}°`} />
        <Segmented
          size="xs"
          label="Shadows"
          value={env.shadows}
          onChange={(v) => setEnvironment({ shadows: v })}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ]}
        />
        <Segmented
          size="xs"
          label="Render quality"
          value={perf.quality}
          onChange={(v) => setPerformance({ quality: v })}
          options={[
            { value: 'low', label: 'Low' },
            { value: 'normal', label: 'Normal' },
            { value: 'high', label: 'High' },
          ]}
        />
        <Switch
          label="Adaptive quality"
          description="Drops a tier when the frame budget is missed repeatedly, and recovers when it can."
          checked={perf.adaptive}
          onChange={(v) => setPerformance({ adaptive: v })}
        />
        <StatRow label="Adaptive tier changes" value={stats.adaptiveChanges} />
      </Panel>

      <Panel title="Atmosphere & fog" panelId="env-atmosphere">
        <Segmented
          size="xs"
          label="Weather preset"
          value={env.weather}
          onChange={(v) => {
            const preset = WEATHER_PRESETS[v];
            if (!preset) return;
            setEnvironment({
              weather: v,
              fog: { ...env.fog, mode: preset.fogMode, density: preset.density, near: preset.near, far: preset.far, color: preset.color },
              post: { ...env.post, saturation: preset.saturation, contrast: preset.contrast },
            });
          }}
          options={[
            { value: 'clear', label: 'Clear' },
            { value: 'rain', label: 'Rain' },
            { value: 'snow', label: 'Snow' },
            { value: 'fog', label: 'Fog' },
          ]}
        />
        <Segmented
          size="xs"
          label="Fog mode"
          value={env.fog.mode}
          onChange={(v) => setFog({ mode: v })}
          options={[
            { value: 'linear', label: 'Linear' },
            { value: 'exponential', label: 'Exp' },
            { value: 'height', label: 'Height' },
          ]}
        />
        {env.fog.mode === 'linear' && (
          <>
            <Slider label="Fog near" value={env.fog.near} onValueChange={(v) => setFog({ near: v })} min={0} max={5000} step={10} format={(v) => `${v.toFixed(0)} m`} />
            <Slider label="Fog far" value={env.fog.far} onValueChange={(v) => setFog({ far: Math.max(v, env.fog.near + 10) })} min={100} max={40000} step={50} format={(v) => `${(v / 1000).toFixed(1)} km`} />
          </>
        )}
        {env.fog.mode !== 'linear' && (
          <Slider label="Fog density" value={env.fog.density} onValueChange={(v) => setFog({ density: Math.max(0.00001, v) })} min={0.00001} max={0.01} step={0.00005} format={(v) => v.toFixed(5)} />
        )}
        {env.fog.mode === 'height' && (
          <Slider label="Fog height" value={env.fog.height} onValueChange={(v) => setFog({ height: v })} min={0} max={2000} step={5} format={(v) => `${v.toFixed(0)} m`} />
        )}
        <div className="ui-field ui-field--row">
          <label className="ui-label" htmlFor="fog-color">Fog colour</label>
          <input id="fog-color" type="color" className="ui-color" value={env.fog.color} onChange={(e) => setFog({ color: e.target.value })} />
        </div>
      </Panel>

      <Panel title="Post effects" panelId="env-post">
        <p className="ui-hint">All passes run on the GPU at reduced resolution; the blur is separable, so cost is linear in radius.</p>
        <Slider label="Bloom" value={env.post.bloom} onValueChange={(v) => setPost({ bloom: v })} min={0} max={2} step={0.01} format={(v) => v.toFixed(2)} />
        <Slider label="Vignette" value={env.post.vignette} onValueChange={(v) => setPost({ vignette: v })} min={0} max={1} step={0.01} format={(v) => v.toFixed(2)} />
        <Slider label="Saturation" value={env.post.saturation} onValueChange={(v) => setPost({ saturation: v })} min={0} max={2} step={0.01} format={(v) => v.toFixed(2)} />
        <Slider label="Contrast" value={env.post.contrast} onValueChange={(v) => setPost({ contrast: v })} min={0} max={2} step={0.01} format={(v) => v.toFixed(2)} />
        <Slider label="Depth fade" value={env.post.depthFade} onValueChange={(v) => setPost({ depthFade: v })} min={0} max={1} step={0.01} format={(v) => v.toFixed(2)} />
        <Switch label="Selection outline" checked={env.post.outline} onChange={(v) => setPost({ outline: v })} />
        <Switch label="Depth-of-field blur" description="Downsampled, separable." checked={env.post.blur.enabled} onChange={(v) => setPost({ blur: { ...env.post.blur, enabled: v } })} />
        {env.post.blur.enabled && (
          <Slider label="Blur radius" value={env.post.blur.radiusPx} onValueChange={(v) => setPost({ blur: { ...env.post.blur, radiusPx: v } })} min={0} max={24} step={1} format={(v) => `${v.toFixed(0)} px`} />
        )}
      </Panel>
    </div>
  );
}
