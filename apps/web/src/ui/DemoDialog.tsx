/**
 * apps/web — demo world picker (REQUIREMENT 137).
 *
 * Five real worlds, each built procedurally at open time from the same schema
 * the editor writes. No baked scenes, no screenshots, no network fetches.
 */
import React, { useState } from 'react';
import { Button, Modal } from '@3dmm/ui';
import { useStore } from '../state/store';
import { DEMOS, buildStressWorld } from '../demos/demos';

export function DemoDialog(): React.ReactElement | null {
  const modal = useStore((s) => s.ui.modal);
  const setUi = useStore((s) => s.setUi);
  const loadDemo = useStore((s) => s.loadDemo);
  const [busy, setBusy] = useState<string | null>(null);

  if (modal !== 'demos') return null;

  const open = (id: string, name: string, build: () => ReturnType<typeof buildStressWorld>) => {
    setBusy(id);
    // Defer one frame so the dialog paints its busy state before the (real)
    // work of building a few thousand nodes runs.
    requestAnimationFrame(() => {
      try {
        loadDemo(build(), name);
        setUi({ modal: null });
      } catch (err) {
        useStore.getState().notify('error', `Could not build that demo: ${(err as Error).message}`);
      } finally {
        setBusy(null);
      }
    });
  };

  return (
    <Modal open onOpenChange={(v) => !v && setUi({ modal: null })} title="Demo worlds" description="Each demo is generated in your browser from procedural data." width={620}>
      <div className="demo-grid">
        {DEMOS.map((d) => (
          <article className="demo-card" key={d.id}>
            <h3 className="demo-card__title">{d.name}</h3>
            <p className="demo-card__blurb">{d.blurb}</p>
            <div className="demo-card__tags">
              {d.tags.map((t) => (
                <span className="ui-badge ui-badge--neutral" key={t}>
                  {t}
                </span>
              ))}
            </div>
            <Button size="xs" variant="primary" disabled={busy !== null} onClick={() => open(d.id, d.name, d.build)}>
              {busy === d.id ? 'Building…' : 'Open'}
            </Button>
          </article>
        ))}
        <article className="demo-card">
          <h3 className="demo-card__title">Stress scene</h3>
          <p className="demo-card__blurb">
            6,000 instanced props, 120 buildings, live contours and a 128 m tile grid. Built to find the frame-rate cliff.
          </p>
          <div className="demo-card__tags">
            <span className="ui-badge ui-badge--warn">heavy</span>
          </div>
          <Button size="xs" disabled={busy !== null} onClick={() => open('stress', 'Stress Scene', () => buildStressWorld())}>
            {busy === 'stress' ? 'Building…' : 'Open'}
          </Button>
        </article>
      </div>
    </Modal>
  );
}
