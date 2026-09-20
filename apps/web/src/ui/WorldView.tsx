/**
 * apps/web — the panorama world viewer (spec §29–§34, §38).
 *
 * One component, two views of the SAME graph:
 *   left  — the 360° plate, look-around by drag, WASD to move
 *   right — the 2D SVG map
 *
 * Neither owns its own copy of the world. The WorldGraph is the single source
 * of truth; the WorldSession owns the walk; both views subscribe to it.
 *
 * The camera NEVER translates through the texture. WASD is resolved through
 * resolveMovementIntent() into a graph edge and a destination node id; the
 * camera stays at the centre of the sphere and only its yaw/pitch change.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { PanoramaCrossfade } from '@3dmm/scene-core';
import {
  intentFromKey,
  incomingWarpDeg,
  outgoingWarpDeg,
  warpOpacities,
  type Direction,
  type WorldGraph,
  type WorldNode,
} from '@3dmm/panorama';
import { cx, ErrorBanner, Button, Segmented } from '@3dmm/ui';
import { WorldMap } from './WorldMap';
import { WorldSession, IDLE_GAIT, type GaitState, type SessionSnapshot } from '../worlds/worldSession';
import { EMPTY_MAP_STATE, type WorldMapState } from '../worlds/mapModel';
import { kindLabel, type CellKind } from '../worlds/generate';
import { buildContextPacket, runFrontier, validateContinuity, type AiContextPacket, type ContinuityResult } from '../worlds/frontier';

export interface WorldViewProps {
  graph: WorldGraph;
  kinds: CellKind[];
  worldName: string;
  startNodeId: string;
  metersPerGridUnit: number;
  onExit?: () => void;
  /** Route shown to the player before they start, from the preview card. */
  className?: string;
}

/** Vertical FOV the player sees; horizontal follows the aspect ratio. */
const V_FOV = 78;
const PITCH_LIMIT = 62; // degrees — never lets the player look past the poles
const TRANSITION_MS = 520;

export function WorldView({ graph, kinds, worldName, startNodeId, metersPerGridUnit, onExit, className }: WorldViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const crossfadeRef = useRef<PanoramaCrossfade | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rafRef = useRef<number>(0);
  const sessionRef = useRef<WorldSession | null>(null);
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const gaitRef = useRef<GaitState>({ ...IDLE_GAIT });
  const incomingTexRef = useRef<THREE.Texture | null>(null);
  const currentTexRef = useRef<THREE.Texture | null>(null);
  const dragRef = useRef<{ x: number; y: number; active: boolean; moved: boolean }>({ x: 0, y: 0, active: false, moved: false });

  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [mapState, setMapState] = useState<WorldMapState>({ ...EMPTY_MAP_STATE });
  const [fatal, setFatal] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(true);
  const [showRoute, setShowRoute] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [routeInfo, setRouteInfo] = useState<{ distance: number; expanded: number } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [landmarkReadout, setLandmarkReadout] = useState<Array<{ name: string; meters: number; bearingDeg: number }>>([]);
  const [fps, setFps] = useState(0);

  const startNode = useMemo(() => graph.get(startNodeId), [graph, startNodeId]);

  /* ------------------------------------------------------------ renderer --- */

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch (err) {
      setFatal(`WebGL is unavailable in this browser: ${(err as Error).message}`);
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    host.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(V_FOV, 1, 0.1, 2000);
    camera.position.set(0, 0, 0);
    cameraRef.current = camera;

    const crossfade = new PanoramaCrossfade();
    scene.add(crossfade.group);
    crossfadeRef.current = crossfade;

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(host);
    window.addEventListener('resize', resize);

    let last = performance.now();
    let frames = 0;
    let fpsClock = 0;

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      frames++;
      fpsClock += dt;
      if (fpsClock >= 0.5) {
        setFps(Math.round(frames / fpsClock));
        frames = 0;
        fpsClock = 0;
      }

      const session = sessionRef.current;
      if (session) {
        const { progress, phase } = session.tick(dt, TRANSITION_MS);

        // Spatial transition, not a dissolve. Each sphere's sample direction is
        // rotated about the vertical axis — the outgoing view swings away as it
        // fades, the incoming one swings into alignment — so the two coincide at
        // the halfway point where they trade places. The schedules come from
        // packages/panorama/src/warp.ts, which is unit-tested; the shader mirrors
        // the same rotation.
        //
        // Opacity still has to move, because the outgoing plate has to leave, but
        // it holds for the first part of the sweep so the motion stays readable
        // rather than dissolving immediately.
        // The warp only exists while a move is in flight, and only when the
        // session knows which way you are going — an arrival or a warp-to has no
        // travel direction, so there is no meaningful axis to sweep along and
        // those fall back to the plain swap.
        const warping = phase === 'transitioning' && session.snapshot().travelDirection !== null;
        crossfade.incoming.setWarpYaw(warping ? incomingWarpDeg(progress) : 0);
        crossfade.outgoing.setWarpYaw(warping ? outgoingWarpDeg(progress) : 0);
        const alpha = phase === 'transitioning' ? warpOpacities(progress) : { outgoing: 0, incoming: 1 };
        crossfade.outgoing.setOpacity(alpha.outgoing);
        crossfade.incoming.setOpacity(alpha.incoming);
        if (phase === 'transitioning' && incomingTexRef.current) {
          // The swap point: promote incoming to the primary sphere so the
          // outgoing one can fade without a black frame in between.
          if (progress >= 0.5 && currentTexRef.current !== incomingTexRef.current) {
            currentTexRef.current = incomingTexRef.current;
          }
        }
        // Camera bob, driven only by the gait integrator — never by the graph.
        const g = gaitRef.current;
        camera.rotation.set(0, 0, 0);
        camera.rotateY(THREE.MathUtils.degToRad(-(yawRef.current + g.yawNoise)));
        camera.rotateX(THREE.MathUtils.degToRad(-(pitchRef.current + g.pitchNoise)));
        camera.position.set(0, g.bob, 0);
        crossfade.follow(camera.position);
      }
      renderer.render(scene, camera);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro?.disconnect();
      window.removeEventListener('resize', resize);
      crossfade.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      rendererRef.current = null;
      crossfadeRef.current = null;
      sceneRef.current = null;
    };
  }, []);

  /* -------------------------------------------------------------- session --- */

  useEffect(() => {
    if (!startNode) {
      setFatal(`Start square ${startNodeId} is not in this world's graph.`);
      return;
    }
    const session = new WorldSession(
      graph,
      {
        onPlateReady: (node, bitmap) => {
          const cf = crossfadeRef.current;
          if (!cf) return;
          const tex = new THREE.Texture(bitmap as never);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;

          // The two spheres deliberately SHARE the outgoing texture during a
          // fade, so neither may dispose what the other is still rendering.
          // Ownership is tracked here and disposal happens only when a texture
          // is on neither sphere.
          const prevOutgoing = currentTexRef.current;
          const prevIncoming = incomingTexRef.current;

          incomingTexRef.current = tex;
          // Outgoing shows what the player is looking at right now.
          currentTexRef.current = prevIncoming ?? prevOutgoing ?? tex;

          cf.incoming.setTexture(tex, false);
          cf.incoming.setVFovScale(180);
          cf.incoming.setCaps({ enabled: true, top: '#8fb8e8', bottom: '#4a4a45', blendDeg: 8 });
          cf.outgoing.setTexture(currentTexRef.current, false);

          // Release anything neither sphere holds any more.
          for (const old of [prevOutgoing, prevIncoming]) {
            if (old && old !== tex && old !== currentTexRef.current && old !== incomingTexRef.current) {
              old.dispose();
            }
          }
          void node;
        },
        onChange: () => {
          const s = session.snapshot();
          setSnap(s);
          setRefusal(s.refusal);
          setMapState((prev) => ({
            ...prev,
            currentId: s.currentId,
            destinationId: s.destinationId,
            visited: session.visitedSet(),
            route: showRoute ? s.route : [],
            selectedId,
          }));
          const readouts: Array<{ name: string; meters: number; bearingDeg: number }> = [];
          for (const l of graph.landmarks.slice(0, 6)) {
            const v = s.currentId ? graph.landmarkVector(s.currentId, l.id) : null;
            if (v) readouts.push({ name: l.name, meters: v.meters, bearingDeg: v.bearingDeg });
          }
          setLandmarkReadout(readouts);
        },
        onError: (_url, message) => setRefusal(message),
      },
      { maxEntries: 18 },
    );
    sessionRef.current = session;
    void session.arrive(startNode);
    return () => {
      session.dispose();
      sessionRef.current = null;
      incomingTexRef.current = null;
      currentTexRef.current = null;
    };
    // showRoute/selectedId are read through the closure above; re-running the
    // whole session when they change would reset the walk, so they are not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, startNode]);

  // Keep the map's selection and route visibility in sync without rebuilding
  // the session.
  useEffect(() => {
    setMapState((prev) => ({ ...prev, selectedId, route: showRoute ? prev.route : [] }));
  }, [selectedId, showRoute]);

  /* --------------------------------------------------------------- input --- */

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const session = sessionRef.current;
    if (!session) return;
    const intent = intentFromKey(e.key);
    if (!intent) return;
    e.preventDefault();
    // Refuse WASD while a text field has focus — the map canvas owns it here.
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    void session.move(intent, yawRef.current);
  }, []);

  /** Turn the gait integrator on for one step so the bob is visible. */
  const runGait = useCallback((dir: Direction | null) => {
    const g = gaitRef.current;
    const startTime = performance.now();
    const dur = 480;
    const step = () => {
      const t = Math.min(1, (performance.now() - startTime) / dur);
      // Deterministic easing — NOT gaussian. Noise is confined to amplitude.
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      g.stepPhase = t;
      g.bob = Math.sin(t * Math.PI * 2) * 0.055;
      g.sway += 0.02;
      g.yawNoise = Math.sin(g.sway) * 0.35;
      g.pitchNoise = Math.cos(g.sway * 0.7) * 0.22;
      if (dir) {
        // Nudge the camera toward the travel direction so the walk reads.
        const target = directionToYaw(dir);
        yawRef.current = lerpAngle(yawRef.current, target, ease * 0.35);
      }
      if (t < 1) requestAnimationFrame(step);
      else {
        g.bob = 0;
        g.yawNoise = 0;
        g.pitchNoise = 0;
      }
    };
    requestAnimationFrame(step);
  }, []);

  // Fire the gait whenever the session starts a transition.
  useEffect(() => {
    if (snap?.phase === 'preloading' && snap.travelDirection) runGait(snap.travelDirection);
    else if (snap?.phase === 'preloading') runGait(null);
  }, [snap?.phase, snap?.travelDirection, snap?.currentId, runGait]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY, active: true, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.active) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    // Look-around only. No translation, ever.
    yawRef.current = normaliseYaw(yawRef.current + dx * 0.18);
    pitchRef.current = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitchRef.current + dy * 0.14));
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current.active = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  /* ----------------------------------------------------------------- map --- */

  const onSelect = useCallback((id: string) => {
    setSelectedId(id);
    const session = sessionRef.current;
    if (!session) return;
    const r = session.setDestination(id);
    setRouteInfo(r.ok ? { distance: r.distance, expanded: r.expanded } : null);
    if (!r.ok) setRefusal(r.reason);
    else setRefusal(null);
  }, []);

  const onWarp = useCallback((id: string) => {
    const session = sessionRef.current;
    if (!session) return;
    void session.warpTo(id);
    setSelectedId(null);
    setRouteInfo(null);
  }, []);

  const onStepRoute = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    void session.stepAlongRoute(yawRef.current);
  }, []);

  const onClearRoute = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    session.setDestination(null);
    setRouteInfo(null);
    setSelectedId(null);
  }, []);

  const current = snap?.currentId ? graph.get(snap.currentId) : null;
  const cacheStats = sessionRef.current?.cache.stats;
  const audit = useMemo(() => graph.audit(), [graph]);

  // The generation pipeline, visible rather than assumed: what the frontier
  // accepted, and the exact context packet + continuity verdict for the square
  // the player is standing on.
  const frontier = useMemo(() => runFrontier({ graph, kinds, startId: startNodeId }), [graph, kinds, startNodeId]);
  const packet: AiContextPacket | null = useMemo(
    () => (current ? buildContextPacket(graph, current, kinds, kindLabel) : null),
    [graph, current, kinds],
  );
  const continuity: ContinuityResult | null = useMemo(
    () => (current ? validateContinuity(graph, current, kinds) : null),
    [graph, current, kinds],
  );
  const [showGen, setShowGen] = useState(false);

  return (
    <div className={cx('world-view', className)} data-testid="world-view">
      <div className="wv-stage" ref={hostRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} tabIndex={0} onKeyDown={onKeyDown} aria-label="Panorama viewer. Drag to look around, W A S D to walk." role="application">
        {fatal ? <div className="wv-fatal"><ErrorBanner message={`Cannot start the panorama viewer: ${fatal}`} /></div> : null}
        <div className="wv-hud">
          <div className="wv-hud-top">
            <span className="wv-chip wv-chip-strong" data-testid="wv-square">
              {current ? `square ${current.number}` : '—'}
            </span>
            {current ? (
              <span className="wv-chip" data-testid="wv-coord">
                ({current.gridX},{current.gridY})
              </span>
            ) : null}
            {current ? (
              <span className="wv-chip" data-testid="wv-world">
                {(current.worldX >= 0 ? '+' : '') + current.worldX.toFixed(0)} / {(current.worldZ >= 0 ? '+' : '') + current.worldZ.toFixed(0)} m
              </span>
            ) : null}
            <span className="wv-chip" data-testid="wv-heading">
              heading {Math.round(normaliseYaw(yawRef.current))}°
            </span>
            <span className="wv-chip" data-testid="wv-fps">{fps} fps</span>
            {snap?.phase && snap.phase !== 'idle' ? (
              <span className={cx('wv-chip', 'wv-phase', `wv-phase-${snap.phase}`)} data-testid="wv-phase">
                {snap.phase}
                {snap.phase === 'preloading' ? ` ${Math.round((snap.loadProgress || 0) * 100)}%` : ''}
              </span>
            ) : null}
          </div>

          {refusal ? (
            <div className="wv-refusal" data-testid="wv-refusal" role="status">
              {refusal}
            </div>
          ) : null}

          {landmarkReadout.length ? (
            <div className="wv-landmarks" data-testid="wv-landmarks">
              {landmarkReadout.map((l) => (
                <span key={l.name} className="wv-chip">
                  {l.name}: {l.meters >= 1000 ? `${(l.meters / 1000).toFixed(2)} km` : `${l.meters.toFixed(0)} m`} @ {Math.round(l.bearingDeg)}°
                </span>
              ))}
            </div>
          ) : null}

          <div className="wv-hud-bottom">
            <div className="wv-dpad" aria-hidden="true">
              <button className="wv-key" data-dir="northWest">Q</button>
              <button className="wv-key wv-key-primary" data-dir="north" data-testid="wv-key-n">W</button>
              <button className="wv-key" data-dir="northEast">E</button>
              <button className="wv-key" data-dir="west">A</button>
              <button className="wv-key" data-dir="south">S</button>
              <button className="wv-key" data-dir="east">D</button>
              <button className="wv-key" data-dir="southWest">Z</button>
              <button className="wv-key" data-dir="southEast">C</button>
            </div>
            <div className="wv-stats">
              <span className="wv-chip" data-testid="wv-steps">{snap?.steps ?? 0} steps</span>
              <span className="wv-chip" data-testid="wv-metres">{(snap?.metresWalked ?? 0).toFixed(0)} m walked</span>
              <span className="wv-chip" data-testid="wv-visited">
                {snap?.visitedCount ?? 0}/{graph.size} visited
              </span>
              {snap?.routeRemaining ? (
                <span className="wv-chip wv-chip-route" data-testid="wv-route-left">
                  {snap.routeRemaining} to go
                </span>
              ) : null}
              {cacheStats ? (
                <span className="wv-chip" data-testid="wv-cache">
                  cache {cacheStats.entries} · {(cacheStats.bytes / 1048576).toFixed(0)} MB · {cacheStats.hits} hits
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <aside className="wv-side">
        <header className="wv-side-head">
          <h2>{worldName}</h2>
          <div className="wv-side-tools">
            <Segmented
              label="2D map"
              value={showMap ? 'map' : 'hide'}
              onChange={(v) => setShowMap(v === 'map')}
              options={[
                { value: 'map', label: 'Map' },
                { value: 'hide', label: 'Hide' },
              ]}
            />
            <Button size="sm" variant="ghost" onClick={onStepRoute} disabled={!snap?.routeRemaining}>
              Step route
            </Button>
            <Button size="sm" variant="ghost" onClick={onClearRoute} disabled={!snap?.destinationId}>
              Clear
            </Button>
            {onExit ? (
              <Button size="sm" variant="ghost" onClick={onExit} data-testid="wv-exit">
                Exit
              </Button>
            ) : null}
          </div>
        </header>

        <dl className="wv-facts">
          <div>
            <dt>grid</dt>
            <dd data-testid="wv-grid">{graph.width}×{graph.height} · {graph.size} nodes</dd>
          </div>
          <div>
            <dt>scale</dt>
            <dd data-testid="wv-scale">{metersPerGridUnit} m per grid unit · diagonal {(metersPerGridUnit * Math.SQRT2).toFixed(1)} m</dd>
          </div>
          <div>
            <dt>edges</dt>
            <dd data-testid="wv-edges">{graph.allEdges().length} directed</dd>
          </div>
          <div>
            <dt>graph audit</dt>
            <dd data-testid="wv-audit">{audit.problems.length ? `${audit.problems.length} problems` : 'clean'}</dd>
          </div>
          {routeInfo ? (
            <div>
              <dt>route</dt>
              <dd data-testid="wv-route-info">
                {routeInfo.distance >= 1000 ? `${(routeInfo.distance / 1000).toFixed(2)} km` : `${routeInfo.distance.toFixed(0)} m`} · A* expanded {routeInfo.expanded}
              </dd>
            </div>
          ) : null}
        </dl>

        {showMap ? (
          <WorldMap
            graph={graph}
            kinds={kinds}
            state={mapState}
            metersPerGridUnit={metersPerGridUnit}
            onSelect={onSelect}
            onWarp={onWarp}
            className="wv-map"
          />
        ) : (
          <div className="wv-map-hidden">Map hidden.</div>
        )}

        <details className="wv-gen" open={showGen} onToggle={(e) => setShowGen((e.target as HTMLDetailsElement).open)}>
          <summary>
            Generation pipeline — {frontier.accepted} accepted, {frontier.rejected} rejected in {frontier.elapsedMs.toFixed(1)} ms
          </summary>
          <div className="wv-gen-body">
            <p className="wv-gen-note" data-testid="wv-frontier">
              Breadth-first from square {graph.get(startNodeId)?.number ?? 1}. {frontier.queued} cells queued,{' '}
              {frontier.cancelled ? 'cancelled part way' : 'completed'}. Each plate was checked against the neighbours
              already placed before it was accepted.
            </p>
            {continuity ? (
              <div className={cx('wv-gen-verdict', continuity.valid ? 'wv-gen-ok' : 'wv-gen-bad')} data-testid="wv-continuity">
                <strong>square {current?.number}:</strong> {continuity.valid ? 'continuity valid' : `${continuity.issues.length} issue(s)`}
                <span className="wv-gen-checks">{continuity.checksRun.length} checks: {continuity.checksRun.join(', ')}</span>
                {continuity.issues.map((i, n) => (
                  <span key={n} className="wv-gen-issue">
                    {i.kind}: {i.message}
                  </span>
                ))}
              </div>
            ) : null}
            {packet ? (
              <div className="wv-gen-packet" data-testid="wv-packet">
                <div className="wv-gen-packet-head">
                  AI context packet <code>{packet.packetId}</code>
                </div>
                <dl className="wv-gen-facts">
                  <div>
                    <dt>cell</dt>
                    <dd>{packet.cellKind} — {packet.cellDescription}</dd>
                  </div>
                  <div>
                    <dt>plate</dt>
                    <dd>{packet.targetPlate}</dd>
                  </div>
                  <div>
                    <dt>continues from</dt>
                    <dd>
                      {packet.parentPlate ? `${packet.parentPlate} (${packet.parentDirection})` : 'world entry — no parent'}
                    </dd>
                  </div>
                  <div>
                    <dt>lighting</dt>
                    <dd>
                      {packet.lighting.timeOfDay} · {packet.lighting.weather} · sun {packet.lighting.sunDirectionDeg}° · exp{' '}
                      {packet.lighting.exposure}
                    </dd>
                  </div>
                  <div>
                    <dt>tolerance</dt>
                    <dd>
                      ±{packet.lighting.tolerance.sunDirectionDeg}° sun · ±{packet.lighting.tolerance.exposure} exposure
                    </dd>
                  </div>
                </dl>
                <div className="wv-gen-seams">
                  {packet.edges.map((e) => (
                    <div key={e.direction} className={cx('wv-gen-seam', e.neighborPlate ? 'wv-gen-seam-open' : 'wv-gen-seam-closed')}>
                      <strong>{e.direction}</strong> {e.distanceMeters.toFixed(1)} m
                      <span>{e.requirement}</span>
                    </div>
                  ))}
                </div>
                {packet.visibleLandmarks.length ? (
                  <div className="wv-gen-landmarks">
                    must be visible:{' '}
                    {packet.visibleLandmarks.map((l) => `${l.name} @ ${Math.round(l.bearingDeg)}° (${l.distanceMeters.toFixed(0)} m)`).join('; ')}
                  </div>
                ) : null}
                <ul className="wv-gen-mustnot">
                  {packet.mustNot.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>

        {snap?.errors.length ? (
          <div className="wv-errors">
            <ErrorBanner message={`${snap.errors.length} plate${snap.errors.length === 1 ? '' : 's'} failed to load — ${snap.errors.slice(0, 3).join(' · ')}`} />
          </div>
        ) : null}
      </aside>
    </div>
  );
}

/* --------------------------------------------------------------- helpers --- */

function normaliseYaw(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Shortest-path interpolation between two bearings. */
function lerpAngle(from: number, to: number, t: number): number {
  let delta = ((to - from + 540) % 360) - 180;
  if (delta < -180) delta += 360;
  return normaliseYaw(from + delta * t);
}

const DIR_YAW: Record<Direction, number> = {
  north: 0,
  northEast: 45,
  east: 90,
  southEast: 135,
  south: 180,
  southWest: 225,
  west: 270,
  northWest: 315,
};

function directionToYaw(dir: Direction): number {
  return DIR_YAW[dir];
}

export type { WorldNode };
