/**
 * apps/web — the compact map timeline and tour mode (REQUIREMENTS 083-085).
 *
 * The timeline is a real, scrubable representation of the tour: the playhead
 * position is derived from elapsed time against the stop durations, and
 * scrubbing performs an actual camera transition. Play mode walks the same
 * stops with the same transition controller.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Button, IconButton, NumberScrub, Panel, Segmented, TextField } from '@3dmm/ui';
import type { TourStop } from '@3dmm/project';
import { useEngine } from '../../engine/engineRef';
import { useStore } from '../../state/store';

export function TimelinePanel(): React.ReactElement {
  const tour = useStore((s) => s.project.tour);
  const addTourStop = useStore((s) => s.addTourStop);
  const removeTourStop = useStore((s) => s.removeTourStop);
  const mutate = useStore((s) => s.mutate);
  const playing = useStore((s) => s.ui.tourPlaying);
  const tourIndex = useStore((s) => s.ui.tourIndex);
  const setUi = useStore((s) => s.setUi);
  const engine = useEngine();
  const [easing, setEasing] = useState<'linear' | 'easeInOutCubic' | 'easeOutExpo' | 'easeInOutSine'>('easeInOutCubic');
  const rafRef = useRef(0);
  const startRef = useRef(0);
  const [playhead, setPlayhead] = useState(0);

  const totalMs = tour.reduce((a, s) => a + s.durationMs, 0);

  /* Playback: drives the real camera, one stop at a time. */
  useEffect(() => {
    if (!playing || tour.length === 0) return;
    startRef.current = performance.now();
    let idx = 0;
    const step = () => {
      const elapsed = performance.now() - startRef.current;
      let acc = 0;
      let current = 0;
      for (let i = 0; i < tour.length; i++) {
        if (elapsed < acc + tour[i].durationMs) {
          current = i;
          break;
        }
        acc += tour[i].durationMs;
        current = i;
      }
      setPlayhead(Math.min(1, totalMs > 0 ? elapsed / totalMs : 0));
      if (current !== idx || elapsed < 16) {
        idx = current;
        setUi({ tourIndex: idx });
        const stop = tour[idx];
        if (stop) {
          mutate((d) => {
            d.transition = { ...d.transition, easing, customMs: stop.durationMs };
          }, 'Tour transition', null);
          engine?.flyTo(
            {
              position: { ...stop.camera.position },
              target: { ...stop.camera.target },
              headingDeg: stop.camera.headingDeg,
              pitchDeg: stop.camera.pitchDeg,
              distance: stop.camera.distance,
            },
            `Tour: ${stop.name}`,
          );
        }
      }
      if (elapsed >= totalMs) {
        setUi({ tourPlaying: false });
        setPlayhead(1);
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, tour, totalMs]);

  const scrub = (fraction: number) => {
    if (tour.length === 0) return;
    const target = Math.max(0, Math.min(totalMs - 1, fraction * totalMs));
    let acc = 0;
    let index = 0;
    for (let i = 0; i < tour.length; i++) {
      if (target < acc + tour[i].durationMs) {
        index = i;
        break;
      }
      acc += tour[i].durationMs;
      index = i;
    }
    setPlayhead(fraction);
    setUi({ tourIndex: index, tourPlaying: false });
    const stop = tour[index];
    if (!stop) return;
    engine?.flyTo(
      {
        position: { ...stop.camera.position },
        target: { ...stop.camera.target },
        headingDeg: stop.camera.headingDeg,
        pitchDeg: stop.camera.pitchDeg,
        distance: stop.camera.distance,
      },
      `Scrub: ${stop.name}`,
    );
  };

  const addStop = () => {
    const snap = engine?.getDebugSnapshot();
    const rig = snap?.rig;
    const project = useStore.getState().project;
    const camera = rig
      ? {
          ...project.camera,
          position: { ...rig.position },
          target: { ...rig.target },
          headingDeg: rig.headingDeg,
          pitchDeg: rig.pitchDeg,
          distance: rig.distance,
          fovDeg: rig.fovDeg,
        }
      : project.camera;
    const stop: TourStop = {
      id: `tour_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      name: `Stop ${tour.length + 1}`,
      caption: '',
      camera,
      durationMs: 3000,
    };
    addTourStop(stop);
  };

  return (
    <Panel
      title="Timeline & tour"
      panelId="timeline"
      actions={
        <Button size="xs" variant="ghost" onClick={addStop}>
          Add stop
        </Button>
      }
    >
      <div className="timeline">
        <div
          className="timeline__track"
          role="slider"
          tabIndex={0}
          aria-label="Tour playhead"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(playhead * 100)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') scrub(Math.min(1, playhead + 0.05));
            if (e.key === 'ArrowLeft') scrub(Math.max(0, playhead - 0.05));
          }}
          onPointerDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            scrub((e.clientX - rect.left) / Math.max(1, rect.width));
          }}
        >
          {tour.map((s, i) => (
            <span
              key={s.id}
              className="timeline__stop"
              data-active={i === tourIndex ? 'true' : 'false'}
              style={{ left: `${(tour.slice(0, i).reduce((a, x) => a + x.durationMs, 0) / Math.max(1, totalMs)) * 100}%` }}
              title={s.name}
            />
          ))}
          <span className="timeline__head" style={{ left: `${playhead * 100}%` }} />
        </div>
        <div className="timeline__row">
          <Button size="xs" variant={playing ? 'danger' : 'primary'} disabled={tour.length === 0} onClick={() => setUi({ tourPlaying: !playing })}>
            {playing ? 'Stop' : 'Play'}
          </Button>
          <span className="ui-hint">
            {tour.length} stops · {(totalMs / 1000).toFixed(1)} s
          </span>
        </div>
      </div>

      <Segmented
        size="xs"
        label="Tour easing"
        value={easing}
        onChange={setEasing}
        options={[
          { value: 'linear', label: 'Linear' },
          { value: 'easeInOutCubic', label: 'Smooth' },
          { value: 'easeOutExpo', label: 'Snap' },
          { value: 'easeInOutSine', label: 'Sine' },
        ]}
      />

      <ul className="tour-list">
        {tour.map((s, i) => (
          <li key={s.id} className="tour-row" data-active={i === tourIndex ? 'true' : 'false'}>
            <button type="button" className="tour-row__go" onClick={() => scrub(tour.slice(0, i).reduce((a, x) => a + x.durationMs, 0) / Math.max(1, totalMs))}>
              {s.name}
            </button>
            <NumberScrub
              label="Duration"
              value={s.durationMs / 1000}
              onChange={(v) =>
                mutate((d) => {
                  const t = d.tour.find((x) => x.id === s.id);
                  if (t) t.durationMs = Math.max(200, Math.round(v * 1000));
                }, 'Tour stop duration', null)
              }
              min={0.2}
              max={60}
              step={0.1}
              precision={1}
              suffix="s"
            />
            <IconButton label={`Delete ${s.name}`} size="xs" variant="ghost" onClick={() => removeTourStop(s.id)}>
              ×
            </IconButton>
          </li>
        ))}
      </ul>
      {tour.length === 0 && <p className="ui-hint">Add stops to build a guided tour, then press Play or enter presentation mode.</p>}
      {tour[tourIndex] && <TextField label="Caption" value={tour[tourIndex].caption} onChange={(v) => mutate((d) => { const t = d.tour.find((x) => x.id === tour[tourIndex].id); if (t) t.caption = v; }, 'Caption', null)} />}
    </Panel>
  );
}
