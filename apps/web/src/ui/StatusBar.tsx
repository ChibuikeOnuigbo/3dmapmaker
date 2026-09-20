/**
 * apps/web — the status bar (REQUIREMENTS 126, 129, 141).
 *
 * Everything here is a real reading from the engine or the store: FPS and frame
 * time come from the profiler, tile counts from the terrain scheduler, memory
 * from `performance.memory` where the browser exposes it, and the save state
 * from the SaveController. Nothing is simulated and nothing is a placeholder.
 */
import React, { useEffect, useState } from 'react';
import { useEngine } from '../engine/engineRef';
import { useStore } from '../state/store';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function SaveIndicator(): React.ReactElement {
  const status = useStore((s) => s.saveStatus);
  const lastSavedAt = useStore((s) => s.lastSavedAt);
  const saveError = useStore((s) => s.errors.save);
  const saveNow = useStore((s) => s.saveNow);
  const [ago, setAgo] = useState('');

  useEffect(() => {
    const tick = () => {
      if (!lastSavedAt) return setAgo('never');
      const secs = Math.max(0, Math.round((Date.now() - lastSavedAt) / 1000));
      setAgo(secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`);
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, [lastSavedAt]);

  const tone = saveError ? 'error' : status === 'saving' || status === 'pending' ? 'warn' : 'ok';
  const label = saveError ? 'Save failed' : status === 'saving' ? 'Saving…' : status === 'pending' ? 'Unsaved changes' : `Saved ${ago}`;

  return (
    <button type="button" className="app-status__item app-status__button" onClick={saveNow} title="Save now (Ctrl/Cmd + S)">
      <span className={`ui-badge ui-badge--${tone}`}>{label}</span>
    </button>
  );
}

export function StatusBar(): React.ReactElement {
  const engine = useEngine();
  const stats = useStore((s) => s.stats);
  const tool = useStore((s) => s.ui.tool);
  const selection = useStore((s) => s.ui.selectedIds.length);
  const quality = useStore((s) => s.project.performance.quality);
  const setUi = useStore((s) => s.setUi);
  const statsOpen = useStore((s) => s.ui.statsOpen);

  // JS heap where the browser exposes it (Chrome). Absent elsewhere — reported
  // as unavailable rather than invented.
  const [heap, setHeap] = useState<number | null>(null);
  useEffect(() => {
    const read = () => {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      setHeap(mem?.usedJSHeapSize ?? null);
    };
    read();
    const id = window.setInterval(read, 2000);
    return () => window.clearInterval(id);
  }, []);

  const rig = engine?.getDebugSnapshot().rig;
  const pos = rig?.position;

  return (
    <footer className="app-status">
      <button
        type="button"
        className="app-status__item app-status__button"
        aria-pressed={statsOpen}
        onClick={() => setUi({ statsOpen: !statsOpen })}
        title="Toggle the performance overlay"
      >
        {stats.fps.toFixed(0)} fps · {stats.frameMs.toFixed(1)} ms
      </button>
      <span className="app-status__item">{stats.drawCalls} draws</span>
      <span className="app-status__item">{formatCount(stats.triangles)} tris</span>
      <span className="app-status__item" title="Active / loading / queued / failed tiles">
        tiles {stats.tiles.active}/{stats.tiles.loading}/{stats.tiles.queued}/{stats.tiles.failed}
      </span>
      <span className="app-status__item">{stats.geometries} geo · {stats.textures} tex</span>
      <span className="app-status__item">{formatBytes(stats.cacheBytes)} cache</span>
      <span className="app-status__item">heap {formatBytes(heap ?? Number.NaN)}</span>
      <span className="app-status__item">{stats.workerAvailable ? 'worker' : 'inline'}</span>
      <span className="app-status__item">{stats.wasmAvailable ? 'wasm' : 'ts core'}</span>
      <span className="app-status__item">{quality}</span>
      <span className="app-status__spacer" />
      {pos && (
        <span className="app-status__item" title="Camera position in local metres">
          x {pos.x.toFixed(0)} y {pos.y.toFixed(0)} z {pos.z.toFixed(0)}
        </span>
      )}
      <span className="app-status__item">{tool}</span>
      <span className="app-status__item">{selection} selected</span>
      <SaveIndicator />
    </footer>
  );
}
