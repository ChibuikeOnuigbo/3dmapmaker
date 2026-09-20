/**
 * apps/web — the written tutorial (REQUIREMENT 134).
 *
 * A plain, readable guide that does not require the editor to be running. It is
 * generated from the same step list the interactive tutorial uses, so the two
 * can never drift apart.
 */
import React from 'react';
import { Button } from '@3dmm/ui';
import { firstRunTutorial } from '@3dmm/tutorial';
import { navigate } from '../App';

const EXTRA: Array<{ title: string; body: string }> = [
  {
    title: 'How the terrain is built',
    body: 'Terrain is generated as heightfields, meshed in a Web Worker, and streamed as tiles around the camera. Tiles move through seven states — queued, loading, ready, active, cooling, evicting, failed — and a tile you have sculpted is protected from eviction so an edit can never be thrown away to make room. Level of detail uses ±25% hysteresis, so a tile does not flip between detail levels when you hover near a boundary.',
  },
  {
    title: 'Keyboard and focus',
    body: 'WASD, the arrow keys, Q/E and the wheel only work while the 3D viewport owns focus. Click the map to take focus; click a panel or a text field to give it back. Nothing is bound globally, so typing in a name field can never fly your camera somewhere.',
  },
  {
    title: 'Panoramas',
    body: 'Panoramas are projected onto an inverted sphere with the camera at its centre — never a cube map, so there are no visible seams. Partial panoramas get gradient environment caps sampled from the image itself, and pitch is clamped so you cannot look into missing data. Nodes form a graph: link them by direction, then step between them. Persistence carries the previous view across the transition instead of cutting.',
  },
  {
    title: 'Saving and recovery',
    body: 'Every edit is debounced into local storage about 800 ms after you stop, with a hard flush every 5 seconds. If the tab dies mid-edit, the next load offers the autosave and lists anything it had to repair. Exports are plain JSON with a schema version, and imports are sanitised and validated before they touch the scene.',
  },
  {
    title: 'Performance',
    body: 'The performance overlay shows real numbers: frame time, draw calls, triangles, tile counts, geometry and texture counts, cache size, and the JS heap where the browser exposes it. Adaptive quality drops a tier when the frame budget is missed repeatedly and recovers when it can. Every number on screen comes from the renderer or the scheduler — none of it is simulated.',
  },
  {
    title: 'What is limited by the browser',
    body: 'Pointer lock and fullscreen need a real user gesture and can be refused by the browser; the app reports that instead of pretending. Rendering is WebGL2 — the app probes for WebGPU and reports whether the browser exposes it, but does not use it yet. Memory is bounded by LRU caches you can configure. Anything that needs a network provider is opt-in and clearly labelled.',
  },
];

export function StaticTutorial(): React.ReactElement {
  const steps = firstRunTutorial();
  return (
    <div className="doc-page">
      <header className="doc-page__head">
        <h1>3DMapMaker Next — guide</h1>
        <div className="doc-page__actions">
          <Button size="sm" variant="primary" onClick={() => navigate('editor')}>
            Open the editor
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate('qa')}>
            QA harness
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate('landing')}>
            Home
          </Button>
        </div>
      </header>

      <section className="doc-page__section">
        <h2>Guided tour</h2>
        <ol className="doc-steps">
          {steps.map((s, i) => (
            <li key={s.id} className="doc-step">
              <h3>
                {i + 1}. {s.title}
              </h3>
              <p>{s.body}</p>
              {s.hint && <p className="doc-step__hint">Expected action: {s.hint}</p>}
              {s.kind === 'action' && <p className="doc-step__kind">The interactive tutorial only advances this step when you actually do it.</p>}
            </li>
          ))}
        </ol>
      </section>

      <section className="doc-page__section">
        <h2>How it works</h2>
        {EXTRA.map((e) => (
          <article className="doc-block" key={e.title}>
            <h3>{e.title}</h3>
            <p>{e.body}</p>
          </article>
        ))}
      </section>

      <section className="doc-page__section">
        <h2>Shortcuts at a glance</h2>
        <table className="doc-table">
          <tbody>
            <tr><td>V / G / R / K</td><td>Select, move, rotate, scale</td></tr>
            <tr><td>T / M / P / O</td><td>Sculpt, measure, road/path, polygon</td></tr>
            <tr><td>L / U / B</td><td>Panorama, water, vegetation</td></tr>
            <tr><td>1 / 2 / 3 / 4</td><td>Orbit, fly, walk, panorama camera</td></tr>
            <tr><td>Enter / Esc / Backspace</td><td>Finish draft, cancel draft, remove last point</td></tr>
            <tr><td>Ctrl/Cmd + Shift + P</td><td>Command palette</td></tr>
            <tr><td>Ctrl/Cmd + S</td><td>Save</td></tr>
            <tr><td>F / H / J / Tab</td><td>Fullscreen, grid, contours, performance overlay</td></tr>
          </tbody>
        </table>
        <p className="ui-hint">All of the above except the Ctrl/Cmd chords require the viewport to have focus.</p>
      </section>
    </div>
  );
}
