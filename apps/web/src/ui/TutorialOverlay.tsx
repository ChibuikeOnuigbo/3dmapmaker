/**
 * apps/web — the interactive tutorial overlay (REQUIREMENTS 134, 135).
 *
 * An action step advances only when its `verify(ctx)` predicate returns true
 * against real application state. There is no timer and no "Next" that fakes
 * progress: pressing Next on an action step is recorded as a wrong attempt and
 * leaves you on the step.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@3dmm/ui';
import { Tutorial, firstRunTutorial, type AppTutorialContext, type TutorialStep } from '@3dmm/tutorial';
import { useStore } from '../state/store';

export function TutorialOverlay(): React.ReactElement | null {
  const phase = useStore((s) => s.ui.tutorialPhase);
  const setUi = useStore((s) => s.setUi);
  const getTutorialContext = useStore((s) => s.getTutorialContext);
  const reducedMotion = useStore((s) => s.ui.reducedMotion);
  const notify = useStore((s) => s.notify);

  /* Anything that could satisfy a verify() predicate is a dependency here. */
  const projectRevision = useStore((s) => s.projectRevision);
  const tool = useStore((s) => s.ui.tool);
  const selectedCount = useStore((s) => s.ui.selectedIds.length);
  const viewportFocused = useStore((s) => s.ui.viewportFocused);
  const cameraMoves = useStore((s) => s.benchmark.cameraMoves ?? 0);

  const [index, setIndex] = useState(-1);
  const [current, setCurrent] = useState<TutorialStep<AppTutorialContext> | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const tutorialRef = useRef<Tutorial<AppTutorialContext> | null>(null);

  const tutorial = useMemo(() => {
    const t = new Tutorial<AppTutorialContext>(
      {
        id: 'first-run',
        title: 'First run',
        steps: firstRunTutorial(),
        onStepChange: (i, step) => {
          setIndex(i);
          setCurrent(step);
          if (!step) {
            setUi({ tutorialPhase: 'completed' });
            notify('ok', 'Tutorial complete. Open it again any time from the command palette.');
          }
        },
        onBlocked: (_stepId, reason) => setBlocked(reason),
      },
      reducedMotion,
    );
    tutorialRef.current = t;
    return t;
  }, [reducedMotion, setUi, notify]);

  /* Start / resume / stop tracking the UI phase. */
  useEffect(() => {
    if (phase === 'running' && tutorial.currentPhase !== 'running') {
      if (tutorial.currentPhase === 'paused') tutorial.resume(getTutorialContext());
      else if (tutorial.currentPhase === 'idle') tutorial.start(getTutorialContext());
    } else if (phase === 'paused') {
      tutorial.pause();
    } else if (phase === 'skipped' || phase === 'idle') {
      tutorial.stop();
      setCurrent(null);
      setIndex(-1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, tutorial]);

  /* Re-evaluate whenever anything a verify() could depend on changes. */
  useEffect(() => {
    if (phase !== 'running') return;
    const ctx = getTutorialContext();
    ctx.selectionCount = selectedCount;
    ctx.viewportFocused = viewportFocused;
    ctx.cameraMoved = cameraMoves > 0;
    const { completed } = tutorial.evaluate(ctx);
    if (completed) setUi({ tutorialPhase: 'completed' });
  }, [phase, projectRevision, tool, selectedCount, viewportFocused, cameraMoves, tutorial, getTutorialContext, setUi]);

  if (phase !== 'running' && phase !== 'paused') return null;
  const step = current ?? tutorial.current;
  if (!step) return null;

  const total = tutorial.stepCount;
  const shown = Math.max(0, index);

  return (
    <>
      {step.target && <div className="tutorial-spotlight" data-target={step.target} aria-hidden="true" />}
      <div className="tutorial-card" role="dialog" aria-live="polite" aria-label="Tutorial">
        <div className="tutorial-card__head">
          <span className="tutorial-card__title">{step.title}</span>
          <span className="tutorial-card__progress">
            {shown + 1} / {total}
          </span>
        </div>
        <div className="tutorial-card__body">{step.body}</div>
        {step.hint && <div className="tutorial-card__hint">{step.hint}</div>}
        {blocked && <div className="ui-error">{blocked}</div>}
        {step.kind === 'action' && <p className="ui-hint">This step unlocks when you actually do it — there is no skip-ahead.</p>}
        <div className="tutorial-card__actions">
          {step.kind !== 'action' && (
            <Button size="xs" variant="primary" onClick={() => { setBlocked(null); tutorial.next(getTutorialContext()); }}>
              Next
            </Button>
          )}
          {step.kind === 'action' && (
            <Button
              size="xs"
              onClick={() => {
                const r = tutorial.evaluate(getTutorialContext());
                if (!r.advanced) {
                  tutorial.recordWrongAttempt();
                  setBlocked('Not yet — do the action described above and this step will unlock itself.');
                } else {
                  setBlocked(null);
                }
              }}
            >
              Check my work
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => setUi({ tutorialPhase: phase === 'paused' ? 'running' : 'paused' })}>
            {phase === 'paused' ? 'Resume' : 'Pause'}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setUi({ tutorialPhase: 'skipped' })}>
            Skip tutorial
          </Button>
        </div>
      </div>
    </>
  );
}
