/**
 * apps/web — the map viewport host.
 *
 * Owns the canvas element, the terrain worker and the EngineController, and
 * keeps them in sync with the store. The renderer itself lives outside React
 * (see engineRef); this component's job is lifecycle, sizing and the
 * focus/overlay bookkeeping that makes keyboard input obey actual focus
 * (REQUIREMENTS 026, 031, 130, 133).
 */
import React, { useEffect, useRef } from 'react';
import { ErrorBanner } from '@3dmm/ui';
import { EngineController } from '../engine/EngineController';
import { TerrainWorkerClient } from '../engine/TerrainWorkerClient';
import { attachEngine } from '../engine/engineRef';
import { useStore } from '../state/store';
import { NavigationControls } from './NavigationControls';
import { SculptBar } from './SculptBar';
import { DraftBar } from './DraftBar';
import { ViewportLabels } from './ViewportLabels';
import { GridWalkHud } from './GridWalkHud';

export function Viewport(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<EngineController | null>(null);

  const webglError = useStore((s) => s.errors.webgl);
  const terrainError = useStore((s) => s.errors.terrain);
  const providerError = useStore((s) => s.errors.provider);

  /* ----------------------------------------------------------- lifecycle --- */

  useEffect(() => {
    const canvas = canvasRef.current;
    const shell = shellRef.current;
    if (!canvas || !shell) return;

    // A real worker when the platform gives us one; the client falls back to
    // running the same code inline when it does not (REQUIREMENT 007).
    let workerClient: TerrainWorkerClient | null = null;
    try {
      workerClient = new TerrainWorkerClient(
        () => new Worker(new URL('../../../../workers/terrain.worker.ts', import.meta.url), { type: 'module' }),
        2,
      );
      useStore.getState().setStats({ workerAvailable: true });
    } catch (err) {
      workerClient = null;
      useStore.getState().setStats({ workerAvailable: false });
      useStore.getState().notify('warn', `Terrain worker unavailable — running inline: ${(err as Error).message}`);
    }

    let engine: EngineController | null = null;
    try {
      engine = new EngineController({ canvas, container: shell, workerClient });
    } catch (err) {
      useStore.getState().setErrors({
        webgl: `WebGL could not be initialised: ${(err as Error).message}. Try another browser or enable hardware acceleration.`,
      });
      workerClient?.dispose();
      return;
    }

    engineRef.current = engine;
    attachEngine(engine);

    /* Keep the renderer honest with the canonical document. */
    const st = useStore;
    const offProject = st.subscribe(
      (s) => s.projectRevision,
      (rev) => {
        const project = st.getState().project;
        engine?.syncContent(project);
        engine?.applyEnvironment(project);
        engine?.updateSelectionVisuals();
        // Loading a demo replaces the whole document, so the panorama graph and
        // the grid walker have to be rebuilt from it. The camera-mode
        // subscription below only fires when the mode *changes*, which is not
        // enough when the demo you open uses the mode you are already in.
        engine?.syncPanorama(project);
        if (project.camera.mode === 'panorama') engine?.enterPanoramaMode();
        void rev;
      },
    );
    const offTerrain = st.subscribe(
      (s) => s.terrainRevision,
      (rev) => {
        engine?.rebuildTerrain(st.getState().project, workerClient);
        engine?.rebuildContours();
        void rev;
      },
    );
    const offQuality = st.subscribe(
      (s) => s.project.performance,
      (perf) => {
        st.getState().setErrors({ provider: null });
        engine?.forceTerrainUpdate();
        void perf;
      },
    );
    const offTool = st.subscribe(
      (s) => s.ui.tool,
      (tool) => engine?.setTool(tool),
    );
    const offMode = st.subscribe(
      (s) => s.project.camera.mode,
      (mode) => engine?.setMode(mode),
    );
    const offSelection = st.subscribe(
      (s) => s.ui.selectedIds,
      () => engine?.updateSelectionVisuals(),
    );

    const observer = new ResizeObserver(() => engine?.resize());
    observer.observe(shell);

    return () => {
      observer.disconnect();
      offProject();
      offTerrain();
      offQuality();
      offTool();
      offMode();
      offSelection();
      attachEngine(null);
      engineRef.current = null;
      engine.dispose();
      // Cancels every in-flight tile request so a remount never applies a
      // stale mesh (REQUIREMENTS 011, 127).
      workerClient?.dispose();
    };
  }, []);

  /* ------------------------------------------------- viewport focus guard --- */

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    // Focus the canvas on pointer-down only. Deliberately NOT on window focus:
    // the old app listened globally and ate keystrokes from its own panels.
    const onPointerDown = (e: PointerEvent) => {
      if (!shell.contains(e.target as Node)) return;
      const target = e.target as HTMLElement;
      if (target.closest('[data-ui-layer]')) return;
      canvasRef.current?.focus({ preventScroll: true });
    };

    const onBlur = () => useStore.getState().setUi({ viewportFocused: false });
    const onVisibility = () => {
      if (document.hidden) useStore.getState().setUi({ viewportFocused: false });
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const retryWebgl = () => {
    useStore.getState().setErrors({ webgl: null });
    // Re-mount by nudging the engine ref; the effect above owns real teardown.
    engineRef.current?.resize();
  };

  return (
    <div className="viewport-wrap" ref={shellRef}>
      <canvas
        ref={canvasRef}
        className="viewport-canvas"
        tabIndex={0}
        aria-label="3D map viewport. Press Tab to move to the interface."
        role="application"
      />
      <div className="viewport-overlay" data-ui-layer="true">
        <NavigationControls />
        <SculptBar />
        <DraftBar />
        <GridWalkHud />
        <ViewportLabels />
      </div>
      {webglError && (
        <div className="viewport-error" data-ui-layer="true">
          <ErrorBanner message={webglError} onRetry={retryWebgl} actionLabel="Retry" />
        </div>
      )}
      {terrainError && (
        <div className="viewport-error viewport-error--bottom" data-ui-layer="true">
          <ErrorBanner
            message={terrainError}
            onRetry={() => {
              useStore.getState().setErrors({ terrain: null });
              useStore.setState((s) => ({ terrainRevision: s.terrainRevision + 1 }));
            }}
            onDismiss={() => useStore.getState().setErrors({ terrain: null })}
          />
        </div>
      )}
      {providerError && (
        <div className="viewport-error viewport-error--bottom" data-ui-layer="true">
          <ErrorBanner message={providerError} onDismiss={() => useStore.getState().setErrors({ provider: null })} />
        </div>
      )}
    </div>
  );
}
