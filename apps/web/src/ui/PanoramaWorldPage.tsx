/**
 * apps/web — the panorama world page (spec §15, §54).
 *
 * Three demo worlds at three scales: 8×8 (64 nodes), 20×20 (400), 32×32 (1024).
 * Each gets a preview card with the REAL route computed before entry — not a
 * canned number, so the player sees the cost of the world they are about to walk.
 */
import React, { useMemo, useState } from 'react';
import { WorldGraph } from '@3dmm/panorama';
import { Button, Badge, cx } from '@3dmm/ui';
import { WorldView } from './WorldView';
import { generateWorld, WORLD_SPECS, kindLabel, type WorldSpec } from '../worlds/generate';

interface Preview {
  spec: WorldSpec;
  graph: WorldGraph;
  kinds: ReturnType<typeof generateWorld>['kinds'];
  startId: string;
  goalId: string;
  route: number;
  routeMetres: number;
  expanded: number;
  edges: number;
  landmarks: number;
  buildMs: number;
  problems: string[];
}

function buildPreview(spec: WorldSpec): Preview {
  const t0 = performance.now();
  const { graph, kinds, startId, destinationId } = generateWorld(spec);
  const buildMs = performance.now() - t0;
  const path = graph.findPath(startId, destinationId);
  const audit = graph.audit();
  return {
    spec,
    graph,
    kinds,
    startId,
    goalId: destinationId,
    route: path ? path.nodes.length : 0,
    routeMetres: path ? path.distance : 0,
    expanded: path ? path.expanded : 0,
    edges: graph.allEdges().length,
    landmarks: graph.landmarks.length,
    buildMs,
    problems: audit.problems,
  };
}

const SCALE_LABEL: Record<string, string> = {
  'demo-small': 'Small · 8×8',
  'demo-medium': 'Medium · 20×20',
  'demo-large': 'Large · 32×32',
};

/** Stable display order for the three demo worlds. */
const SPEC_ORDER: WorldSpec[] = [WORLD_SPECS.small, WORLD_SPECS.medium, WORLD_SPECS.large];

export function PanoramaWorldPage() {
  const [active, setActive] = useState<Preview | null>(null);

  // Built once per spec, lazily, so opening the page does not pay for 1,024
  // nodes the player may never walk.
  const [previews, setPreviews] = useState<Record<string, Preview>>({});

  const enter = (spec: WorldSpec) => {
    const existing = previews[spec.id];
    if (existing) {
      setActive(existing);
      return;
    }
    const p = buildPreview(spec);
    setPreviews((prev) => ({ ...prev, [spec.id]: p }));
    setActive(p);
  };

  if (active) {
    return (
      <WorldView
        graph={active.graph}
        kinds={active.kinds}
        worldName={`${active.spec.name} — ${SCALE_LABEL[active.spec.id] ?? active.spec.id}`}
        startNodeId={active.startId}
        metersPerGridUnit={active.spec.metersPerGridUnit}
        onExit={() => setActive(null)}
      />
    );
  }

  return (
    <div className="pano-page">
      <header className="pano-head">
        <div>
          <h1>Connected Panorama World</h1>
          <p className="pano-sub">
            One graph, two views. The 2D map and the 360° viewer both read the same <code>WorldGraph</code>, so neither can
            drift. <kbd>W</kbd>/<kbd>A</kbd>/<kbd>S</kbd>/<kbd>D</kbd> move you node to node — they never slide the camera
            across the image.
          </p>
        </div>
        <Badge tone="neutral">graph-driven · no cube maps · no fake metrics</Badge>
      </header>

      <div className="pano-cards">
        {SPEC_ORDER.map((spec) => {
          const p = previews[spec.id];
          return (
            <article key={spec.id} className={cx('pano-card', p ? 'pano-card-ready' : '')} data-testid={`pano-card-${spec.id}`}>
              <div className="pano-card-head">
                <h2>{spec.name}</h2>
                <Badge tone={spec.id === 'demo-large' ? 'warn' : 'info'}>
                  {spec.width}×{spec.height} · {spec.width * spec.height} nodes
                </Badge>
              </div>
              <p className="pano-card-desc">{spec.blurb}</p>

              <dl className="pano-card-facts">
                <div>
                  <dt>scale</dt>
                  <dd>{spec.metersPerGridUnit} m / unit</dd>
                </div>
                <div>
                  <dt>diagonal step</dt>
                  <dd>{(spec.metersPerGridUnit * Math.SQRT2).toFixed(1)} m</dd>
                </div>
                <div>
                  <dt>origin</dt>
                  <dd>
                    {spec.origin.lat.toFixed(4)}, {spec.origin.lon.toFixed(4)}
                  </dd>
                </div>
                <div>
                  <dt>seed</dt>
                  <dd>{spec.seed}</dd>
                </div>
              </dl>

              {p ? (
                <dl className="pano-card-facts pano-card-measured" data-testid={`pano-measured-${spec.id}`}>
                  <div>
                    <dt>route 1 → {p.graph.size}</dt>
                    <dd>
                      {p.route} nodes · {p.routeMetres >= 1000 ? `${(p.routeMetres / 1000).toFixed(2)} km` : `${p.routeMetres.toFixed(0)} m`}
                    </dd>
                  </div>
                  <div>
                    <dt>A* expanded</dt>
                    <dd>
                      {p.expanded} of {p.graph.size}
                    </dd>
                  </div>
                  <div>
                    <dt>directed edges</dt>
                    <dd>{p.edges}</dd>
                  </div>
                  <div>
                    <dt>landmarks</dt>
                    <dd>{p.landmarks}</dd>
                  </div>
                  <div>
                    <dt>build</dt>
                    <dd>{p.buildMs.toFixed(1)} ms</dd>
                  </div>
                  <div>
                    <dt>graph audit</dt>
                    <dd className={p.problems.length ? 'pano-bad' : 'pano-good'}>
                      {p.problems.length ? `${p.problems.length} problems` : 'clean'}
                    </dd>
                  </div>
                </dl>
              ) : null}

              <div className="pano-card-actions">
                <Button variant="primary" onClick={() => enter(spec)} data-testid={`pano-enter-${spec.id}`}>
                  {p ? 'Enter world' : 'Analyse & enter'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setPreviews((prev) => ({ ...prev, [spec.id]: buildPreview(spec) }))}
                  disabled={!!p}
                >
                  {p ? 'Analysed' : 'Analyse route'}
                </Button>
              </div>
            </article>
          );
        })}
      </div>

      <section className="pano-legend">
        <h3>How movement works</h3>
        <ol>
          <li>
            <strong>The key is camera-relative.</strong> <kbd>W</kbd> plus your current yaw gives a world heading; that
            heading is quantised to the nearest of the eight compass directions.
          </li>
          <li>
            <strong>The graph decides.</strong> If that direction has no edge — a wall, a river, the edge of the board —
            the move is refused and the HUD tells you which ways ARE open. It never silently picks a different direction.
          </li>
          <li>
            <strong>Then, and only then, does anything load.</strong> The destination plate is fetched into a bounded LRU
            cache, swapped in mid-fade, and your heading is restored on arrival.
          </li>
          <li>
            <strong>The camera never translates.</strong> It stays at the centre of the sphere; only yaw and pitch change.
            Walking is a graph operation, not a texture pan.
          </li>
        </ol>
        <h3>Controls</h3>
        <ul className="pano-keys">
          <li><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> — walk (camera-relative)</li>
          <li><kbd>Q</kbd> <kbd>E</kbd> <kbd>Z</kbd> <kbd>C</kbd> — the four diagonals</li>
          <li><kbd>drag</kbd> — look around</li>
          <li><kbd>click</kbd> a map node — plot a route with A*</li>
          <li><kbd>double-click</kbd> a map node — warp there</li>
          <li><kbd>scroll</kbd> / <kbd>drag</kbd> the map — zoom and pan</li>
        </ul>
        <h3>Plates</h3>
        <p>
          Twelve generated equirectangular plates (1456×720, 2.02:1) stand in for the world's imagery. Each node carries
          provenance metadata — <code>sourceType</code>, generator, licence — and the generator records which real
          location informed it. Reference imagery is never scraped or redistributed.
        </p>
        <h3>Cell kinds</h3>
        <ul className="pano-kinds">
          {(['road', 'lane', 'junction', 'houses', 'market', 'school', 'river', 'farm', 'square', 'churchyard', 'church', 'blocked'] as const).map(
            (k) => (
              <li key={k}>
                <code>{k}</code> — {kindLabel(k)}
              </li>
            ),
          )}
        </ul>
      </section>
    </div>
  );
}

export default PanoramaWorldPage;
