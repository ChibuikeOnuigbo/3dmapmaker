/**
 * apps/web — the minimal navigation HUD (REQUIREMENTS 078, 079, 080).
 *
 * Deliberately small: a compass you can click to face north, a real scale bar
 * derived from the live projection, zoom and reset, the camera mode switch and
 * fullscreen. Everything else lives behind the command palette so the canvas
 * stays dominant.
 */
import React, { useEffect, useState } from 'react';
import { Button, IconButton, Popover, Segmented, Tooltip } from '@3dmm/ui';
import { useEngine } from '../engine/engineRef';
import { useStore } from '../state/store';

/** Round a raw metres value to a legible bar length. */
export function niceScaleLength(meters: number): { meters: number; label: string } {
  if (!Number.isFinite(meters) || meters <= 0) return { meters: 0, label: '—' };
  const pow = Math.pow(10, Math.floor(Math.log10(meters)));
  const steps = [1, 2, 5, 10];
  for (const s of steps) {
    const candidate = s * pow;
    if (candidate <= meters) continue;
    const prev = candidate / (s === 10 ? 2 : s === 5 ? 2.5 : 2);
    const value = Math.abs(meters - prev) < Math.abs(meters - candidate) ? prev : candidate;
    return { meters: value, label: formatMeters(value) };
  }
  return { meters: 10 * pow, label: formatMeters(10 * pow) };
}

export function formatMeters(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
  return `${Math.round(m)} m`;
}

function Compass({ headingDeg }: { headingDeg: number }): React.ReactElement {
  const engine = useEngine();
  const setCamera = useStore((s) => s.setCamera);
  return (
    <Tooltip label="Compass — click to face north" side="left">
      <button
        type="button"
        className="compass"
        data-testid="compass"
        aria-label={`Heading ${Math.round(headingDeg)} degrees. Click to face north.`}
        onClick={() => {
          setCamera({ headingDeg: 0 });
          engine?.setHeading(0, 'Face north');
        }}
      >
        <span className="compass__needle" style={{ transform: `rotate(${-headingDeg}deg)` }} />
        <span className="compass__n" aria-hidden="true">
          N
        </span>
      </button>
    </Tooltip>
  );
}

function ScaleBar({ metersPerPixel }: { metersPerPixel: number }): React.ReactElement | null {
  // Aim for a bar between 60 and 130 CSS pixels wide.
  const target = metersPerPixel > 0 ? 100 * metersPerPixel : 0;
  const nice = niceScaleLength(target);
  if (!nice.meters || !metersPerPixel) return null;
  const px = Math.max(20, Math.min(200, nice.meters / metersPerPixel));
  return (
    <div className="scale-bar" data-testid="scale-bar" aria-label={`Scale: ${nice.label}`}>
      <span className="scale-bar__rule" style={{ width: `${px}px` }} />
      <span>{nice.label}</span>
    </div>
  );
}

export function NavigationControls(): React.ReactElement {
  const engine = useEngine();
  const mode = useStore((s) => s.project.camera.mode);
  const setCameraMode = useStore((s) => s.setCameraMode);
  const setTransition = useStore((s) => s.setTransition);
  const speed = useStore((s) => s.project.transition.speed);
  const heading = useStore((s) => s.project.camera.headingDeg);
  const pitch = useStore((s) => s.project.camera.pitchDeg);
  const distance = useStore((s) => s.project.camera.distance);
  const fullscreen = useStore((s) => s.ui.fullscreen);
  const showCompass = useStore((s) => s.project.ui.showCompass);
  const showScaleBar = useStore((s) => s.project.ui.showScaleBar);
  const viewportFocused = useStore((s) => s.ui.viewportFocused);

  // Live projection scale — read from the renderer, not estimated.
  const [mpp, setMpp] = useState(0);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = () => {
      const e = engine ?? undefined;
      if (e) {
        const now = performance.now();
        if (now - last > 200) {
          last = now;
          setMpp(e.metersPerPixel());
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return (
    <>
      <div className="viewport-hud-tr">
        {showCompass && mode !== 'panorama' && <Compass headingDeg={heading} />}
        <div className="nav-controls">
          <div className="nav-controls__row">
            <Tooltip label="Zoom in (wheel or +)" side="left">
              <IconButton label="Zoom in" size="xs" variant="ghost" data-testid="zoom-in" onClick={() => engine?.zoomBy(0.7, 'Zoom in')}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </IconButton>
            </Tooltip>
            <Tooltip label="Zoom out (wheel or −)" side="left">
              <IconButton label="Zoom out" size="xs" variant="ghost" data-testid="zoom-out" onClick={() => engine?.zoomBy(1 / 0.7, 'Zoom out')}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M5 12h14" />
                </svg>
              </IconButton>
            </Tooltip>
            <Tooltip label="Reset to the saved starting view" side="left">
              <IconButton label="Reset view" size="xs" variant="ghost" data-testid="reset-view" onClick={() => engine?.resetView()}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                </svg>
              </IconButton>
            </Tooltip>
            <Popover
              label="Navigation settings"
              side="left"
              trigger={
                <IconButton label="Navigation settings" size="xs" variant="ghost" data-testid="nav-settings">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z" />
                  </svg>
                </IconButton>
              }
            >
              <div className="ui-field">
                <span className="ui-label">Camera mode</span>
                <Segmented
                  size="xs"
                  label="Camera mode"
                  value={mode}
                  onChange={(v) => setCameraMode(v as 'orbit' | 'fly' | 'walk' | 'panorama')}
                  options={[
                    { value: 'orbit', label: 'Orbit' },
                    { value: 'fly', label: 'Fly' },
                    { value: 'walk', label: 'Walk' },
                    { value: 'panorama', label: 'Pano' },
                  ]}
                />
              </div>
              <div className="ui-field">
                <span className="ui-label">Move speed</span>
                <Segmented
                  size="xs"
                  label="Move speed"
                  value={speed}
                  onChange={(v) => setTransition({ speed: v as 'cinematic' | 'normal' | 'fast' | 'custom' })}
                  options={[
                    { value: 'cinematic', label: 'Cinematic' },
                    { value: 'normal', label: 'Normal' },
                    { value: 'fast', label: 'Fast' },
                    { value: 'custom', label: 'Custom' },
                  ]}
                />
              </div>
              <div className="ui-hint">
                Pitch {pitch.toFixed(0)}° · distance {distance < 1000 ? `${distance.toFixed(0)} m` : `${(distance / 1000).toFixed(2)} km`}
              </div>
            </Popover>
          </div>
        </div>
      </div>

      <div className="viewport-hud-br">
        {showScaleBar && <ScaleBar metersPerPixel={mpp} />}
        <div className="nav-controls__row">
          {mode !== 'panorama' && (
            <Tooltip label={viewportFocused ? 'Keyboard active in the viewport' : 'Click the map to use WASD and arrows'} side="top">
              <Button size="xs" variant="ghost" data-testid="focus-hint" tabIndex={-1} aria-hidden="true">
                {viewportFocused ? 'Keys: viewport' : 'Click map for keys'}
              </Button>
            </Tooltip>
          )}
          <Tooltip label={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen (F)'} side="top">
            <IconButton
              label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              size="xs"
              variant="ghost"
              data-testid="fullscreen-toggle"
              onClick={() => engine?.toggleFullscreen()}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                {fullscreen ? <path d="M9 3v6H3M15 21v-6h6M21 9h-6V3M3 15h6v6" /> : <path d="M3 9V3h6M21 15v6h-6M15 3h6v6M9 21H3v-6" />}
              </svg>
            </IconButton>
          </Tooltip>
        </div>
      </div>
    </>
  );
}
