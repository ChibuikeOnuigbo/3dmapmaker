/**
 * apps/web — the graphical 2D world map (spec §6).
 *
 * A real SVG map, not ASCII. Every element is derived from the WorldGraph, so
 * the map can never disagree with the graph: nodes come from graph.all(), edges
 * from graph.neighborsOf(), the route from graph.findPath().
 *
 * Interaction:
 *   click        select a node
 *   double-click warp there (if the graph says it is walkable)
 *   wheel        zoom around the pointer
 *   drag         pan
 *   arrows       pan by keyboard
 *   r            fit the board back into view
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chebyshev, type WorldGraph } from '@3dmm/panorama';
import { cx } from '@3dmm/ui';
import { buildMapModel, EMPTY_MAP_STATE, fitCell, screenToGrid, type WorldMapState } from '../worlds/mapModel';
import type { CellKind } from '../worlds/generate';

export interface WorldMapProps {
  graph: WorldGraph;
  kinds: CellKind[];
  state: WorldMapState;
  metersPerGridUnit: number;
  onSelect: (id: string) => void;
  onWarp: (id: string) => void;
  className?: string;
}

const VIEW_COLORS: Record<string, string> = {
  unseen: '#2a3138',
  visible: '#4a6070',
  visited: '#3f7f6a',
  current: '#f0b429',
  destination: '#5ab0ff',
  loading: '#c98a1e',
  error: '#e5544b',
};

const KIND_TINT: Record<CellKind, string> = {
  road: 'rgba(255,255,255,0.06)',
  lane: 'rgba(255,255,255,0.035)',
  junction: 'rgba(255,255,255,0.10)',
  houses: 'rgba(120,110,100,0.42)',
  market: 'rgba(190,140,90,0.30)',
  school: 'rgba(150,150,170,0.30)',
  river: 'rgba(30,80,120,0.60)',
  farm: 'rgba(90,120,70,0.20)',
  square: 'rgba(200,180,150,0.24)',
  churchyard: 'rgba(110,130,100,0.30)',
  church: 'rgba(240,180,41,0.30)',
  blocked: 'rgba(0,0,0,0.40)',
};

export function WorldMap({ graph, kinds, state, metersPerGridUnit, onSelect, onWarp, className }: WorldMapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 640, h: 480 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const lastClick = useRef<{ id: string; at: number }>({ id: '', at: 0 });

  // Measure the host so the map always fills its panel with no overflow.
  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    if (r.width > 0) setSize({ w: r.width, h: r.height });
    return () => ro.disconnect();
  }, []);

  const baseCell = useMemo(() => fitCell(graph.width, graph.height, Math.min(size.w, size.h), 28), [graph.width, graph.height, size]);
  const cell = baseCell * zoom;
  const pad = 28 * zoom;

  const boardW = pad * 2 + (graph.width - 1) * cell;
  const boardH = pad * 2 + (graph.height - 1) * cell;

  // Only cull on big boards — culling an 8×8 would be more work than drawing it.
  const viewport = useMemo(() => {
    if (graph.size <= 400) return null;
    const m = cell * 2;
    return { x: -pan.x / 1, y: -pan.y / 1, w: size.w, h: size.h, margin: m };
  }, [graph.size, cell, pan.x, pan.y, size.w, size.h]);

  const model = useMemo(
    () => buildMapModel({ graph, state, kinds, cell, pad, viewport: viewport ? { ...viewport, x: -pan.x, y: -pan.y } : null }),
    [graph, state, kinds, cell, pad, viewport, pan.x, pan.y],
  );

  const fit = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Re-centre on the player whenever it moves, but only on large boards where
  // the player would otherwise walk out of frame.
  useEffect(() => {
    if (graph.size <= 400) return;
    const cur = state.currentId ? graph.get(state.currentId) : null;
    if (!cur) return;
    const cx = pad + cur.gridX * cell;
    const cy = pad + (graph.height - 1 - cur.gridY) * cell;
    setPan({ x: size.w / 2 - cx, y: size.h / 2 - cy });
  }, [state.currentId, graph, cell, pad, size.w, size.h]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom((z) => {
        const nz = Math.max(0.25, Math.min(6, z * factor));
        const k = nz / z;
        // Keep the point under the pointer fixed while zooming.
        setPan((p) => ({ x: mx - (mx - p.x) * k, y: my - (my - p.y) * k }));
        return nz;
      });
    },
    [],
  );

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [pan.x, pan.y]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    setDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  /** Convert a click position to a node id, or null. */
  const hitTest = useCallback(
    (clientX: number, clientY: number): string | null => {
      const host = hostRef.current;
      if (!host) return null;
      const rect = host.getBoundingClientRect();
      // Screen → SVG space, undoing the pan transform.
      const sx = clientX - rect.left - pan.x;
      const sy = clientY - rect.top - pan.y;
      const g = screenToGrid(sx, sy, graph.height, cell, pad);
      if (g.x < 0 || g.y < 0 || g.x >= graph.width || g.y >= graph.height) return null;
      const node = graph.at(g.x, g.y);
      return node?.id ?? null;
    },
    [graph, cell, pad, pan.x, pan.y],
  );

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (dragging) return;
      const id = hitTest(e.clientX, e.clientY);
      if (!id) return;
      const now = Date.now();
      if (lastClick.current.id === id && now - lastClick.current.at < 320) {
        lastClick.current = { id: '', at: 0 };
        onWarp(id);
        return;
      }
      lastClick.current = { id, at: now };
      onSelect(id);
    },
    [hitTest, dragging, onSelect, onWarp],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = 40;
      if (e.key === 'ArrowLeft') setPan((p) => ({ ...p, x: p.x + step }));
      else if (e.key === 'ArrowRight') setPan((p) => ({ ...p, x: p.x - step }));
      else if (e.key === 'ArrowUp') setPan((p) => ({ ...p, y: p.y + step }));
      else if (e.key === 'ArrowDown') setPan((p) => ({ ...p, y: p.y - step }));
      else if (e.key === 'r' || e.key === 'R') fit();
      else if ((e.key === 'Enter' || e.key === ' ') && state.selectedId) {
        e.preventDefault();
        onWarp(state.selectedId);
      } else return;
      e.preventDefault();
    },
    [fit, state.selectedId, onWarp],
  );

  const landmarkAt = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of graph.landmarks) {
      const n = graph.at(l.gridX, l.gridY);
      if (n) m.set(n.id, l.name);
    }
    return m;
  }, [graph]);

  const hoverNode = hover ? graph.get(hover) : null;
  const currentNode = state.currentId ? graph.get(state.currentId) : null;
  const hoverDist =
    hoverNode && currentNode ? chebyshev({ x: currentNode.gridX, y: currentNode.gridY }, { x: hoverNode.gridX, y: hoverNode.gridY }) : null;

  const routeLengthMeters = useMemo(() => {
    if (state.route.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < state.route.length; i++) {
      const a = graph.get(state.route[i - 1]);
      const b = graph.get(state.route[i]);
      if (!a || !b) continue;
      // Prefer the real edge distance; fall back to the geometric step.
      const edge = graph.neighborsOf(a.id).find((n) => n.node.id === b.id)?.edge;
      total += edge ? edge.distance : Math.hypot(b.worldX - a.worldX, b.worldZ - a.worldZ);
    }
    return total;
  }, [graph, state.route]);

  return (
    <div className={cx('world-map', className)} ref={hostRef} data-testid="world-map">
      <div
        className="world-map-canvas"
        role="application"
        aria-label={`World map, ${graph.width} by ${graph.height} grid, ${graph.size} nodes`}
        tabIndex={0}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <svg width="100%" height="100%" style={{ display: 'block', touchAction: 'none', cursor: dragging ? 'grabbing' : 'grab' }}>
          <g transform={`translate(${pan.x},${pan.y})`}>
            {/* Cell tints show land use under the graph. */}
            {kinds.map((k, i) => {
              const x = i % graph.width;
              const y = Math.floor(i / graph.width);
              if (k === 'farm') return null;
              const { cx: cxp, cy: cyp } = { cx: pad + x * cell, cy: pad + (graph.height - 1 - y) * cell };
              return (
                <rect
                  key={`cell-${i}`}
                  x={cxp - cell / 2}
                  y={cyp - cell / 2}
                  width={cell}
                  height={cell}
                  fill={KIND_TINT[k] ?? 'transparent'}
                />
              );
            })}

            {/* Edges */}
            <g>
              {model.edges.map((e) => (
                <line
                  key={e.id}
                  x1={e.x1}
                  y1={e.y1}
                  x2={e.x2}
                  y2={e.y2}
                  stroke={e.onRoute ? '#f0b429' : e.walkable ? 'rgba(255,255,255,0.34)' : 'rgba(229,84,75,0.28)'}
                  strokeWidth={e.onRoute ? Math.max(2, cell * 0.16) : Math.max(1, cell * 0.07)}
                  strokeDasharray={e.walkable ? undefined : `${cell * 0.12} ${cell * 0.1}`}
                />
              ))}
            </g>

            {/* Route overlay */}
            {model.routePath ? (
              <path d={model.routePath} fill="none" stroke="#f0b429" strokeOpacity={0.35} strokeWidth={Math.max(4, cell * 0.5)} strokeLinecap="round" strokeLinejoin="round" />
            ) : null}

            {/* Nodes */}
            <g>
              {model.nodes.map((n) => {
                const r = Math.max(2.5, cell * (n.view === 'current' ? 0.34 : n.view === 'destination' ? 0.3 : 0.2));
                const isSel = state.selectedId === n.id;
                return (
                  <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}>
                    {isSel ? <circle cx={n.cx} cy={n.cy} r={r * 1.9} fill="none" stroke="#ffffff" strokeOpacity={0.5} strokeWidth={1.5} /> : null}
                    {n.view === 'current' ? (
                      <circle cx={n.cx} cy={n.cy} r={r * 2.2} fill="none" stroke="#f0b429" strokeOpacity={0.6} strokeWidth={1.5}>
                        <animate attributeName="r" values={`${r * 1.8};${r * 2.6};${r * 1.8}`} dur="2s" repeatCount="indefinite" />
                      </circle>
                    ) : null}
                    <circle cx={n.cx} cy={n.cy} r={r} fill={VIEW_COLORS[n.view]} stroke={n.onRoute ? '#f0b429' : 'rgba(0,0,0,0.5)'} strokeWidth={n.onRoute ? 1.5 : 0.5} />
                    {landmarkAt.has(n.id) && cell > 14 ? (
                      <text x={n.cx} y={n.cy - r - 3} textAnchor="middle" fontSize={Math.max(7, cell * 0.34)} fill="#ffd97a" style={{ pointerEvents: 'none' }}>
                        {landmarkAt.get(n.id)}
                      </text>
                    ) : null}
                    {cell > 26 ? (
                      <text x={n.cx} y={n.cy + 3} textAnchor="middle" fontSize={Math.max(6, cell * 0.28)} fill={n.view === 'unseen' ? '#6a7580' : '#0c0f12'} style={{ pointerEvents: 'none' }}>
                        {n.number}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
      </div>

      <div className="world-map-hud">
        <div className="wmh-row">
          <span className="wmh-chip" data-testid="map-zoom">×{zoom.toFixed(2)}</span>
          <span className="wmh-chip" data-testid="map-nodes">{model.nodes.length}/{model.totalNodes} nodes</span>
          {model.culled > 0 ? <span className="wmh-chip" data-testid="map-culled">{model.culled} culled</span> : null}
          {hoverNode ? (
            <span className="wmh-chip" data-testid="map-hover">
              #{hoverNode.number} ({hoverNode.gridX},{hoverNode.gridY})
              {hoverDist !== null ? ` · ${hoverDist} move${hoverDist === 1 ? '' : 's'} · ${(hoverDist * metersPerGridUnit).toFixed(0)} m` : ''}
              {landmarkAt.get(hoverNode.id) ? ` · ${landmarkAt.get(hoverNode.id)}` : ''}
            </span>
          ) : null}
        </div>
        {routeLengthMeters > 0 ? (
          <div className="wmh-row">
            <span className="wmh-chip wmh-route" data-testid="map-route">
              route: {state.route.length} nodes · {routeLengthMeters >= 1000 ? `${(routeLengthMeters / 1000).toFixed(2)} km` : `${routeLengthMeters.toFixed(0)} m`}
            </span>
          </div>
        ) : null}
        <div className="wmh-row wmh-legend">
          {(['current', 'destination', 'visited', 'visible', 'unseen', 'loading', 'error'] as const).map((v) => (
            <span key={v} className="wmh-legend-item">
              <i style={{ background: VIEW_COLORS[v] }} />
              {v}
            </span>
          ))}
        </div>
        <div className="wmh-hint">click select · double-click walk there · scroll zoom · drag pan · R fit</div>
      </div>
    </div>
  );
}

/** A minimal state for maps that have no traversal yet (e.g. the generator preview). */
export const previewMapState = EMPTY_MAP_STATE;
