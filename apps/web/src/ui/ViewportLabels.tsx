/**
 * apps/web — screen-space labels and markers (REQUIREMENTS 091, 092, 093).
 *
 * The engine runs the collision-avoiding layout every 100 ms on the projected
 * positions of every label/marker node; this component only paints the result.
 * Labels that do not fit are genuinely dropped (counted in `dropped`), never
 * stacked on top of each other, and priority + distance decide who wins.
 */
import React, { useEffect, useState } from 'react';
import type { PlacedLabel } from '@3dmm/scene-core';
import { useEngine } from '../engine/engineRef';
import { useStore } from '../state/store';

export function ViewportLabels(): React.ReactElement | null {
  const engine = useEngine();
  const select = useStore((s) => s.select);
  const [labels, setLabels] = useState<PlacedLabel[]>([]);

  useEffect(() => {
    if (!engine) return;
    let raf = 0;
    let last = 0;
    const tick = () => {
      const now = performance.now();
      if (now - last > 110) {
        last = now;
        const next = engine.labelLayout.placed;
        setLabels((prev) => (prev.length === next.length && prev.every((p, i) => p.id === next[i].id && p.placedX === next[i].placedX) ? prev : next));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  if (labels.length === 0) return null;

  return (
    <div className="viewport-label-layer" aria-label="Map labels">
      {labels.map((l) => (
        <button
          key={l.id}
          type="button"
          className={`viewport-label viewport-label--${l.priority >= 60 ? 'marker' : 'label'}`}
          style={{ left: `${l.placedX}px`, top: `${l.placedY}px` }}
          onClick={() => select([l.id])}
          title={l.text}
        >
          {l.text}
        </button>
      ))}
    </div>
  );
}
