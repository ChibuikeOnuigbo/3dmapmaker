/**
 * apps/web — the marketing landing page (REQUIREMENT 136).
 *
 * A separate surface from the editor, on its own route, with its own layout. It
 * describes real capabilities of this build and links to the demo worlds that
 * actually exist.
 *
 * Two copy corrections, both found by measuring rather than reading:
 *
 * - The demo count is derived from `DEMOS.length` rather than hardcoded. This
 *   heading used to say "five" while the array below it held six, so the page
 *   contradicted itself in the same viewport.
 * - The footer no longer advertises a WASM terrain core. Nothing in this build
 *   loads a wasm module: `wasmAvailable` defaults to `false`, there is no `.wasm`
 *   asset, and `crates/terrain-core` has never been compiled. The status bar
 *   already reports "ts core" honestly; the landing page claimed otherwise.
 */
import React from 'react';
import { Badge, Button } from '@3dmm/ui';
import { useStore } from '../state/store';
import { DEMOS } from '../demos/demos';
import { navigate } from '../App';

const PILLARS = [
  {
    title: 'Author, don’t just view',
    body: 'Sculpt terrain with 14 real brush tools, draw roads that follow the ground, extrude buildings from footprints, scatter instanced vegetation from a seed. Everything lands in a versioned project document you can export as JSON.',
  },
  {
    title: 'Built for large worlds',
    body: 'Terrain streams as tiles around the camera with a priority queue, seven explicit tile states, stale-request abortion and protected edited tiles. A floating origin keeps float precision honest past thousands of metres.',
  },
  {
    title: 'Panoramas that hold up',
    body: 'Inverted-sphere equirectangular projection, environment caps sampled from the image, pitch clamping so you cannot look into missing data, a linkable node graph, and spatial warping rather than a plain crossfade when you move between nodes.',
  },
  {
    title: 'Honest performance',
    body: 'Adaptive quality, GPU instancing, LOD with hysteresis, LRU caches with byte budgets, and a performance overlay that reports real frame times, draw calls and memory. No simulated numbers anywhere.',
  },
];

export function LandingPage({ onOpenEditor }: { onOpenEditor: () => void }): React.ReactElement {
  const loadDemo = useStore((s) => s.loadDemo);
  const setUi = useStore((s) => s.setUi);

  const openDemo = (index: number) => {
    const demo = DEMOS[index];
    loadDemo(demo.build(), demo.name);
    onOpenEditor();
  };

  return (
    <div className="landing">
      <nav className="landing__nav">
        <span className="app-header__logo" aria-hidden="true" />
        <strong>3DMapMaker Next</strong>
        <span className="app-header__spacer" />
        <Button size="sm" variant="ghost" onClick={() => navigate('tutorial')}>
          Guide
        </Button>
        <Button size="sm" variant="ghost" onClick={() => navigate('worlds')}>
          Panorama worlds
        </Button>
        <Button size="sm" variant="ghost" onClick={() => navigate('qa')}>
          QA
        </Button>
        <Button size="sm" variant="primary" onClick={onOpenEditor}>
          Open the editor
        </Button>
      </nav>

      <header className="landing__hero">
        <h1 className="landing__title">Build a 3D world in the browser. Keep it.</h1>
        <p className="landing__sub">
          An authoring tool, not a viewer. Sculpt terrain, lay roads, raise buildings, link panoramas and walk the result —
          all saved to a versioned project you can export, re-import and undo your way through.
        </p>
        <div className="landing__cta">
          <Button size="md" variant="primary" onClick={onOpenEditor}>
            Start building
          </Button>
          <Button size="md" variant="ghost" onClick={() => setUi({ modal: 'demos' })}>
            Browse demo worlds
          </Button>
        </div>
        <p className="ui-hint">Runs entirely in your browser. No account, no upload, no server round-trip required.</p>
      </header>

      <section className="landing__grid">
        {PILLARS.map((p) => (
          <article className="landing__card" key={p.title}>
            <h2>{p.title}</h2>
            <p>{p.body}</p>
          </article>
        ))}
      </section>

      <section className="landing__demos">
        <h2>{DEMOS.length} demo worlds, generated on the spot</h2>
        <p className="ui-hint">
          Every demo is built procedurally when you open it — no baked scenes, no downloads. Assets are synthetic or
          openly licensed and recorded in LICENSES.md.
        </p>
        <div className="landing__grid">
          {DEMOS.map((d, i) => (
            <article className="landing__demo" key={d.id}>
              <h3>{d.name}</h3>
              <p>{d.blurb}</p>
              <div className="landing__demo-tags">
                {d.tags.map((t) => (
                  <Badge key={t} tone="neutral">
                    {t}
                  </Badge>
                ))}
              </div>
              <Button size="xs" variant="primary" onClick={() => openDemo(i)}>
                Open {d.name}
              </Button>
            </article>
          ))}
        </div>
      </section>

      <footer className="landing__footer">
        <span>WebGL2 baseline · Web Workers · zero mandatory network calls</span>
        <span>
          <Button size="xs" variant="ghost" onClick={() => navigate('tutorial')}>
            Read the guide
          </Button>
        </span>
      </footer>
    </div>
  );
}
