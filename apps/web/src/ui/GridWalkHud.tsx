/**
 * apps/web — the grid-walk HUD.
 *
 * Shows up only when the open world defines a discrete capture grid (the "road
 * to church" demo). It reports the square you are standing on, how many king
 * moves are left to the goal, and renders a clickable board so you can warp
 * straight to any square you have already reached.
 *
 * Every number here is read from the live GridWalker — nothing is simulated.
 */
import React, { useEffect, useState } from 'react';
import { useEngine } from '../engine/engineRef';
import { useStore } from '../state/store';

interface GridMove {
  dx: number;
  dy: number;
  name: string;
  to: string;
  toName: string;
}

interface GridSnap {
  nodeId: string | null;
  name: string;
  col: number;
  row: number;
  stepsTaken: number;
  movesToGoal: number | null;
  stepping: boolean;
  path: string[];
  moves: GridMove[];
}

/** Screen layout for the 3×3 direction pad: [row, col] with the centre empty. */
const PAD: Array<{ dx: number; dy: number; label: string; glyph: string }> = [
  { dx: -1, dy: 1, label: 'North-west', glyph: '↖' },
  { dx: 0, dy: 1, label: 'North', glyph: '↑' },
  { dx: 1, dy: 1, label: 'North-east', glyph: '↗' },
  { dx: -1, dy: 0, label: 'West', glyph: '←' },
  { dx: 0, dy: 0, label: 'Here', glyph: '•' },
  { dx: 1, dy: 0, label: 'East', glyph: '→' },
  { dx: -1, dy: -1, label: 'South-west', glyph: '↙' },
  { dx: 0, dy: -1, label: 'South', glyph: '↓' },
  { dx: 1, dy: -1, label: 'South-east', glyph: '↘' },
];

export function GridWalkHud(): React.ReactElement | null {
  const engine = useEngine();
  const mode = useStore((s) => s.project.camera.mode);
  const nodes = useStore((s) => s.project.panorama.nodes);
  const grid = useStore((s) => s.project.panorama.grid);
  const [snap, setSnap] = useState<GridSnap | null>(null);

  useEffect(() => {
    if (!engine || !grid) {
      setSnap(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      setSnap(engine.getGridSnapshot());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, grid]);

  if (!engine || !grid || mode !== 'panorama' || !snap) return null;

  const cols = grid.cols;
  const rows = grid.rows;
  const visited = new Set(snap.path);
  const goalId = grid.goalNodeId;

  // Row 0 is the start (bottom of the board); rows run northward, so render
  // the highest row at the top.
  const cells: React.ReactElement[] = [];
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = 0; col < cols; col++) {
      const id = nodes.find((n) => {
        const c = Math.round(n.position.x / grid.spacing);
        const r = Math.round(-n.position.z / grid.spacing);
        return c === col && r === row;
      })?.id;
      if (!id) continue;
      const here = id === snap.nodeId;
      const seen = visited.has(id);
      const goal = id === goalId;
      cells.push(
        <button
          key={id}
          type="button"
          className="grid-hud__cell"
          data-here={here ? 'true' : 'false'}
          data-seen={seen ? 'true' : 'false'}
          data-goal={goal ? 'true' : 'false'}
          title={`${col},${row}${goal ? ' — the church' : ''}`}
          aria-label={`Square at column ${col} row ${row}${goal ? ', the church' : ''}${here ? ', you are here' : ''}`}
          onClick={() => {
            if (!seen && !here) {
              useStore.getState().notify('info', 'Walk there first — you can only warp to squares you have visited.');
              return;
            }
            engine.jumpToGridNode(id);
          }}
        />
      );
    }
  }

  return (
    <div className="grid-hud" data-testid="grid-hud">
      <div className="grid-hud__head">
        <span className="grid-hud__title">Grid walk</span>
        <span className={`ui-badge ${snap.stepping ? 'ui-badge--warn' : 'ui-badge--ok'}`}>
          {snap.stepping ? 'stepping…' : 'standing'}
        </span>
      </div>
      <div className="grid-hud__pos">
        <strong>{snap.name || '—'}</strong>
        <span className="grid-hud__coord">
          col {snap.col} · row {snap.row}
        </span>
      </div>
      <div className="grid-hud__board" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }} role="group" aria-label="Capture board">
        {cells}
      </div>
      <div className="grid-hud__pad" role="group" aria-label="Walk one square">
        {PAD.map((cell) => {
          if (cell.dx === 0 && cell.dy === 0) {
            return (
              <span key="here" className="grid-hud__pad-here" aria-hidden="true">
                {cell.glyph}
              </span>
            );
          }
          const move = snap.moves.find((m) => m.dx === cell.dx && m.dy === cell.dy);
          return (
            <button
              key={cell.label}
              type="button"
              className="grid-hud__pad-btn"
              disabled={!move || snap.stepping}
              title={move ? `${cell.label} → ${move.toName}` : `${cell.label}: no square that way`}
              aria-label={move ? `Walk ${cell.label} to ${move.toName}` : `${cell.label} is off the board`}
              onClick={() => move && engine.gridStep(move.dx, move.dy)}
            >
              {cell.glyph}
            </button>
          );
        })}
      </div>
      <div className="grid-hud__stats">
        <span>{snap.stepsTaken} squares walked</span>
        {snap.movesToGoal !== null && (
          <span>
            {snap.movesToGoal} king move{snap.movesToGoal === 1 ? '' : 's'} to the church
          </span>
        )}
      </div>
      <p className="grid-hud__hint">WASD or the arrow keys walk one square per press. Click a square you have visited to warp there.</p>
    </div>
  );
}
