/**
 * apps/web — the sculpt / vegetation brush bar (REQUIREMENTS 046-049).
 *
 * Appears only when a brush tool is active, so the default interface stays
 * uncluttered. Every control writes straight to the live brush on the engine,
 * and terrain edits are committed to `project.terrain.edits` so they survive
 * reload, undo and export.
 */
import React, { useEffect, useState } from 'react';
import { Button, NumberScrub, Segmented, Slider, Switch } from '@3dmm/ui';
import type { BrushParams, BrushTool } from '@3dmm/terrain';
import { defaultBrush } from '@3dmm/terrain';
import { useEngine } from '../engine/engineRef';
import { useStore } from '../state/store';

const TOOLS: Array<{ value: BrushTool; label: string; hint: string }> = [
  { value: 'raise', label: 'Raise', hint: 'Add height under the brush' },
  { value: 'lower', label: 'Lower', hint: 'Remove height under the brush' },
  { value: 'smooth', label: 'Smooth', hint: 'Average neighbouring heights' },
  { value: 'flatten', label: 'Flatten', hint: 'Pull towards the target elevation' },
  { value: 'terrace', label: 'Terrace', hint: 'Quantise to stepped contours' },
  { value: 'noise', label: 'Noise', hint: 'Add fractal detail' },
  { value: 'erosion', label: 'Erosion', hint: 'Simulate water erosion passes' },
  { value: 'stamp', label: 'Stamp', hint: 'Apply a height profile' },
  { value: 'ridge', label: 'Ridge', hint: 'Sharpen into a ridge line' },
  { value: 'valley', label: 'Valley', hint: 'Carve a valley profile' },
  { value: 'plateau', label: 'Plateau', hint: 'Flat top with sloped sides' },
  { value: 'crater', label: 'Crater', hint: 'Bowl with a raised rim' },
  { value: 'roadcut', label: 'Road cut', hint: 'Level a corridor for a road' },
  { value: 'watercarve', label: 'Water carve', hint: 'Cut a channel below water level' },
];

const STAMPS: Array<{ value: BrushParams['stampProfile']; label: string }> = [
  { value: 'cone', label: 'Cone' },
  { value: 'dome', label: 'Dome' },
  { value: 'bell', label: 'Bell' },
  { value: 'mesa', label: 'Mesa' },
  { value: 'trench', label: 'Trench' },
];

export function SculptBar(): React.ReactElement | null {
  const engine = useEngine();
  const tool = useStore((s) => s.ui.tool);
  const [brush, setBrush] = useState<BrushParams>(() => defaultBrush());
  const [mirror, setMirror] = useState(false);
  const [autoTarget, setAutoTarget] = useState(true);

  // Pull the live brush whenever the engine (re)appears so the panel is never
  // showing values the renderer does not have.
  useEffect(() => {
    if (!engine) return;
    setBrush({ ...engine.getBrush() });
  }, [engine, tool]);

  if (tool !== 'sculpt' && tool !== 'vegetation') return null;

  const apply = (patch: Partial<BrushParams>) => {
    const next = { ...brush, ...patch };
    setBrush(next);
    engine?.setBrush(patch);
  };

  const activeTool = brush.tool;
  const needsTarget = activeTool === 'flatten' || activeTool === 'plateau' || activeTool === 'roadcut' || activeTool === 'watercarve';

  return (
    <div className="viewport-hud-bl">
      <div className="brush-bar" data-testid="brush-bar">
        <div className="brush-bar__tools" role="group" aria-label="Sculpt tool">
          {TOOLS.map((t) => (
            <button
              key={t.value}
              type="button"
              className="brush-bar__tool"
              data-active={activeTool === t.value ? 'true' : 'false'}
              title={t.hint}
              aria-pressed={activeTool === t.value}
              onClick={() => apply({ tool: t.value })}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="brush-bar__controls">
          <Slider label="Radius" value={brush.radius} onValueChange={(v) => apply({ radius: v })} min={2} max={400} step={1} format={(v) => `${v.toFixed(0)} m`} />
          <Slider label="Strength" value={brush.strength} onValueChange={(v) => apply({ strength: v })} min={0.5} max={120} step={0.5} format={(v) => `${v.toFixed(1)} m/s`} />
          <Slider label="Falloff" value={brush.falloff} onValueChange={(v) => apply({ falloff: v })} min={0} max={1} step={0.01} format={(v) => v.toFixed(2)} />
          <Slider label="Hardness" value={brush.hardness} onValueChange={(v) => apply({ hardness: v })} min={0} max={1} step={0.01} format={(v) => v.toFixed(2)} />

          {activeTool === 'noise' && (
            <Slider label="Noise amount" value={brush.noiseAmount} onValueChange={(v) => apply({ noiseAmount: v })} min={0} max={60} step={0.5} format={(v) => `${v.toFixed(1)} m`} />
          )}
          {activeTool === 'terrace' && (
            <Slider label="Step height" value={brush.terraceStep} onValueChange={(v) => apply({ terraceStep: v })} min={1} max={100} step={1} format={(v) => `${v.toFixed(0)} m`} />
          )}
          {activeTool === 'stamp' && (
            <Segmented size="xs" label="Stamp profile" value={brush.stampProfile} onChange={(v) => apply({ stampProfile: v })} options={STAMPS} />
          )}
          {needsTarget && (
            <>
              <Switch
                label="Follow terrain under cursor"
                description="Otherwise the brush pulls to a fixed elevation."
                checked={autoTarget}
                onChange={setAutoTarget}
              />
              {!autoTarget && (
                <NumberScrub label="Target elevation" value={brush.target} onChange={(v) => apply({ target: v })} min={-5000} max={9000} step={1} precision={1} suffix="m" />
              )}
            </>
          )}

          <Segmented
            size="xs"
            label="Symmetry"
            value={brush.symmetry}
            onChange={(v) => {
              setMirror(v !== 'none');
              apply({ symmetry: v });
            }}
            options={[
              { value: 'none', label: 'None' },
              { value: 'x', label: 'X' },
              { value: 'y', label: 'Y' },
              { value: 'both', label: 'Both' },
            ]}
          />

          <div className="brush-bar__actions">
            <Button size="xs" variant="ghost" onClick={() => { const b = defaultBrush(); setBrush(b); engine?.setBrush(b); }}>
              Reset brush
            </Button>
            <Button size="xs" variant="ghost" onClick={() => useStore.getState().notify('info', mirror ? 'Mirrored strokes are applied around the world centre.' : 'Symmetry is off.')}>
              {mirror ? 'Mirroring on' : 'Mirroring off'}
            </Button>
          </div>
        </div>

        {autoTarget && needsTarget && <p className="ui-hint">Target follows the terrain under the cursor.</p>}
      </div>
    </div>
  );
}
