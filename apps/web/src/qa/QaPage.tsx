/**
 * apps/web — the in-browser QA harness (REQUIREMENTS 140, 141) and the
 * hundred hardening checks.
 *
 * Every check runs real code in this page: it builds a project, drives the
 * engine, reads the resulting state, and reports pass/fail with the measured
 * value. Nothing is a hardcoded green tick. The benchmark runner measures
 * startup, first frame, camera latency, wheel-zoom response, draw time, tile
 * latency and memory from the live renderer.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Panel, StatRow } from '@3dmm/ui';
import {
  CHECK_COUNT,
  KIND_COUNT,
  runAuditCheck,
  runHardeningChecks,
  runMigrationCheck,
  runRegressionChecks,
  type QaCheck,
  type QaSuite,
} from './checks';
import { runBenchmark, type BenchmarkResult } from './benchmark';
import { useStore } from '../state/store';
import { navigate } from '../App';

function SuiteView({ suite, onRun, running }: { suite: QaSuite; onRun: () => void; running: boolean }): React.ReactElement {
  const passed = suite.checks.filter((c) => c.status === 'pass').length;
  const failed = suite.checks.filter((c) => c.status === 'fail').length;
  return (
    <Panel
      title={suite.name}
      panelId={`qa-${suite.id}`}
      actions={
        <Button size="xs" variant="primary" disabled={running} onClick={onRun}>
          {running ? 'Running…' : 'Run'}
        </Button>
      }
    >
      <div className="ui-field ui-field--row">
        <Badge tone="ok">{passed} passed</Badge>
        <Badge tone={failed > 0 ? 'error' : 'neutral'}>{failed} failed</Badge>
        <Badge tone="neutral">{suite.checks.length - passed - failed} pending</Badge>
      </div>
      <ul className="qa-list">
        {suite.checks.map((c: QaCheck) => (
          <li className="qa-check" key={c.id} data-status={c.status}>
            <span className="qa-check__name" title={c.description}>
              {c.id} · {c.name}
            </span>
            <span className="qa-check__value">{c.detail ?? '—'}</span>
            <span className={`ui-badge ${c.status === 'pass' ? 'ui-badge--ok' : c.status === 'fail' ? 'ui-badge--error' : 'ui-badge--neutral'}`}>
              {c.status === 'idle' ? 'pending' : c.status}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function QaPage(): React.ReactElement {
  const [suites, setSuites] = useState<QaSuite[]>(() => [
    { id: 'regression', name: 'Legacy regression — the 7 bugs from the old app', checks: runRegressionChecks('list') },
    { id: 'hardening', name: `Hardening checks — ${CHECK_COUNT} across ${KIND_COUNT} kinds`, checks: runHardeningChecks('list') },
    { id: 'audit', name: 'Project audit & migrations', checks: [
      { id: 'AUDIT-001', name: 'The live project validates and audits clean', description: 'validateProject + auditTree on the open document.', status: 'idle' },
      { id: 'AUDIT-002', name: 'A v1 document migrates to the current schema', description: 'Runs the real migration chain.', status: 'idle' },
    ] },
  ]);
  const [running, setRunning] = useState<string | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkResult | null>(null);
  const [benchRunning, setBenchRunning] = useState(false);
  const stats = useStore((s) => s.stats);

  useEffect(() => {
    // Keep the audit suite honest about the open document even before it runs.
    const off = useStore.subscribe((s) => s.projectRevision, () => {
      setSuites((prev) => prev.map((s) => (s.id === 'audit' ? { ...s, checks: s.checks.map((c) => ({ ...c, status: 'idle' as const, detail: 'stale — re-run' })) } : s)));
    });
    return off;
  }, []);

  const runSuite = useCallback((id: string) => {
    setRunning(id);
    const work =
      id === 'regression'
        ? runRegressionChecks('run')
        : id === 'hardening'
          ? runHardeningChecks('run')
          : Promise.all([runAuditCheck(), runMigrationCheck()]);
    work
      .then((checks) => setSuites((prev) => prev.map((s) => (s.id === id ? { ...s, checks } : s))))
      .catch((err: Error) =>
        setSuites((prev) =>
          prev.map((s) =>
            s.id === id
              ? { ...s, checks: [{ id: `${id}.crash`, name: 'Suite crashed', description: String(err), status: 'fail' as const, detail: err.message }] }
              : s,
          ),
        ),
      )
      .finally(() => setRunning(null));
  }, []);

  const runBench = useCallback(() => {
    setBenchRunning(true);
    runBenchmark()
      .then((r) => {
        setBenchmark(r);
        useStore.getState().setBenchmark(r.metrics);
      })
      .catch((err: Error) => useStore.getState().notify('error', `Benchmark failed: ${err.message}`))
      .finally(() => setBenchRunning(false));
  }, []);

  const totalPass = suites.reduce((a, s) => a + s.checks.filter((c) => c.status === 'pass').length, 0);
  const totalFail = suites.reduce((a, s) => a + s.checks.filter((c) => c.status === 'fail').length, 0);
  const totalChecks = suites.reduce((a, s) => a + s.checks.length, 0);

  return (
    <div className="qa-page">
      <header className="doc-page__head">
        <h1>QA harness</h1>
        <div className="doc-page__actions">
          <Button size="sm" variant="primary" disabled={running !== null} onClick={() => ['regression', 'hardening', 'audit'].forEach(runSuite)}>
            Run everything
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate('editor')}>
            Back to the editor
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate('landing')}>
            Home
          </Button>
        </div>
      </header>

      <div className="qa-summary">
        <Badge tone="ok">{totalPass} passed</Badge>
        <Badge tone={totalFail ? 'error' : 'neutral'}>{totalFail} failed</Badge>
        <Badge tone="neutral">{totalChecks - totalPass - totalFail} pending</Badge>
        <Badge tone="neutral">{totalChecks} checks total</Badge>
      </div>

      <Panel
        title="Benchmark"
        panelId="qa-benchmark"
        actions={
          <Button size="xs" variant="primary" disabled={benchRunning} onClick={runBench}>
            {benchRunning ? 'Measuring…' : 'Run benchmark'}
          </Button>
        }
      >
        <p className="ui-hint">
          Measures the live renderer. Open the editor first for the frame-rate and draw-time numbers to be meaningful.
        </p>
        {benchmark ? (
          <>
            <StatRow label="Startup to first paint" value={`${benchmark.metrics.startupMs.toFixed(0)} ms`} />
            <StatRow label="First frame after mount" value={`${benchmark.metrics.firstFrameMs.toFixed(1)} ms`} />
            <StatRow label="Camera move latency" value={`${benchmark.metrics.cameraLatencyMs.toFixed(1)} ms`} />
            <StatRow label="Wheel zoom response" value={`${benchmark.metrics.wheelZoomMs.toFixed(1)} ms`} />
            <StatRow label="Median frame time" value={`${benchmark.metrics.drawMs.toFixed(2)} ms`} />
            <StatRow label="p95 frame time" value={`${benchmark.metrics.p95FrameMs.toFixed(2)} ms`} />
            <StatRow label="Tile generate + mesh" value={`${benchmark.metrics.tileLatencyMs.toFixed(1)} ms`} />
            <StatRow
              label="Sustained FPS"
              value={Number.isFinite(benchmark.metrics.largeSceneFps) ? benchmark.metrics.largeSceneFps.toFixed(1) : 'n/a'}
              tone={benchmark.metrics.largeSceneFps < 30 ? 'warn' : 'ok'}
            />
            <StatRow label="JS heap" value={benchmark.memory ?? 'not exposed by this browser'} />
            <StatRow label="Draw calls" value={benchmark.metrics.drawCalls} />
            <StatRow label="Triangles" value={benchmark.metrics.triangles.toLocaleString()} />
            <StatRow label="Active tiles" value={benchmark.metrics.tilesActive} />
            <StatRow label="Samples" value={benchmark.samples} />
            <ul className="ui-hint">
              {benchmark.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <StatRow label="Current FPS" value={stats.fps.toFixed(0)} />
            <StatRow label="Frame time" value={`${stats.frameMs.toFixed(2)} ms`} />
            <StatRow label="Draw calls" value={stats.drawCalls} />
          </>
        )}
      </Panel>

      {suites.map((s) => (
        <SuiteView key={s.id} suite={s} running={running === s.id} onRun={() => runSuite(s.id)} />
      ))}

      <Panel title="Recording a result" panelId="qa-repro">
        <p className="ui-hint">
          A failing check prints the value it measured. Copy it into DEVELOPMENT_LOG.md with the browser, the viewport size
          and the demo world that was open — that is what makes a hardening entry actionable rather than decorative.
        </p>
      </Panel>
    </div>
  );
}
