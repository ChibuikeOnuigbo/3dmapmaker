/**
 * apps/web — the editor workbench shell (REQUIREMENTS 129, 130).
 *
 * Layout is a fixed grid: header, tool rail, left panel, canvas-dominant
 * viewport, right panel, status bar. Every region scrolls internally so the
 * page itself can never overflow horizontally (REQUIREMENT 128).
 */
import React, { useEffect } from 'react';
import { Button, IconButton, Segmented, Tooltip } from '@3dmm/ui';
import { useStore } from '../state/store';
import { Viewport } from './Viewport';
import { ToolRail } from './ToolRail';
import { StatusBar } from './StatusBar';
import { CommandPalette } from './CommandPalette';
import { Toasts } from './Toasts';
import { TutorialOverlay } from './TutorialOverlay';
import { LayersPanel } from './panels/LayersPanel';
import { BuildPanel } from './panels/BuildPanel';
import { AssetBrowser } from './panels/AssetBrowser';
import { Inspector } from './panels/Inspector';
import { EnvironmentPanel } from './panels/EnvironmentPanel';
import { PhysicsPanel } from './panels/PhysicsPanel';
import { AiPanel } from './panels/AiPanel';
import { ProjectMenu } from './ProjectMenu';
import { ImportExportDialog } from './ImportExportDialog';
import { DemoDialog } from './DemoDialog';
import { ShortcutDialog } from './ShortcutDialog';

const LEFT_PANELS = [
  { value: 'layers', label: 'Layers' },
  { value: 'build', label: 'Build' },
  { value: 'assets', label: 'Assets' },
] as const;

const RIGHT_PANELS = [
  { value: 'inspector', label: 'Inspector' },
  { value: 'environment', label: 'Scene' },
  { value: 'physics', label: 'Physics' },
  { value: 'ai', label: 'AI' },
] as const;

export function Workbench(): React.ReactElement {
  const setUi = useStore((s) => s.setUi);
  const activePanel = useStore((s) => s.ui.activePanel);
  const leftOpen = useStore((s) => s.ui.leftPanelOpen);
  const rightOpen = useStore((s) => s.ui.rightPanelOpen);
  const mode = useStore((s) => s.ui.mode);
  const modal = useStore((s) => s.ui.modal);

  // Escape closes any modal the React side owns.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useStore.getState().ui.modal) setUi({ modal: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setUi]);

  const leftKind = activePanel && LEFT_PANELS.some((p) => p.value === activePanel) ? activePanel : 'layers';
  const rightKind = activePanel && RIGHT_PANELS.some((p) => p.value === activePanel) ? activePanel : 'inspector';

  return (
    <div className="app-shell">
      <header className="app-header">
        <ProjectMenu />
        <div className="app-header__spacer" />
        <div className="app-header__group">
          <Segmented
            size="xs"
            label="Application mode"
            value={mode}
            onChange={(v) => setUi({ mode: v })}
            options={[
              { value: 'edit', label: 'Edit' },
              { value: 'play', label: 'Play' },
              { value: 'presentation', label: 'Present' },
            ]}
          />
          <Tooltip label="Command palette (Ctrl/Cmd + Shift + P)" side="bottom">
            <Button size="xs" variant="ghost" onClick={() => setUi({ commandPaletteOpen: true })}>
              ⌘K
            </Button>
          </Tooltip>
          <Tooltip label="Toggle the left panel" side="bottom">
            <IconButton
              label="Toggle left panel"
              size="xs"
              variant="ghost"
              aria-pressed={leftOpen}
              active={leftOpen}
              onClick={() => setUi({ leftPanelOpen: !leftOpen })}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M9 4v16" />
              </svg>
            </IconButton>
          </Tooltip>
          <Tooltip label="Toggle the right panel" side="bottom">
            <IconButton
              label="Toggle right panel"
              size="xs"
              variant="ghost"
              aria-pressed={rightOpen}
              active={rightOpen}
              onClick={() => setUi({ rightPanelOpen: !rightOpen })}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M15 4v16" />
              </svg>
            </IconButton>
          </Tooltip>
        </div>
      </header>

      <div className="app-body">
        <ToolRail />

        {leftOpen && (
          <aside className="side-panel side-panel--left" aria-label="Content">
            <div className="side-panel__tabs" role="tablist" aria-label="Left panel">
              {LEFT_PANELS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  role="tab"
                  aria-selected={leftKind === p.value}
                  className="side-panel__tab"
                  data-active={leftKind === p.value ? 'true' : 'false'}
                  onClick={() => setUi({ activePanel: p.value })}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="side-panel__scroll">
              {leftKind === 'layers' && <LayersPanel />}
              {leftKind === 'build' && <BuildPanel />}
              {leftKind === 'assets' && <AssetBrowser />}
            </div>
          </aside>
        )}

        <Viewport />

        {rightOpen && mode !== 'presentation' && (
          <aside className="side-panel side-panel--right" aria-label="Properties">
            <div className="side-panel__tabs" role="tablist" aria-label="Right panel">
              {RIGHT_PANELS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  role="tab"
                  aria-selected={rightKind === p.value}
                  className="side-panel__tab"
                  data-active={rightKind === p.value ? 'true' : 'false'}
                  onClick={() => setUi({ activePanel: p.value })}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="side-panel__scroll">
              {rightKind === 'inspector' && <Inspector />}
              {rightKind === 'environment' && <EnvironmentPanel />}
              {rightKind === 'physics' && <PhysicsPanel />}
              {rightKind === 'ai' && <AiPanel />}
            </div>
          </aside>
        )}
      </div>

      <StatusBar />
      <CommandPalette />
      <Toasts />
      <TutorialOverlay />

      {modal === 'import' && <ImportExportDialog />}
      {modal === 'demos' && <DemoDialog />}
      {modal === 'shortcuts' && <ShortcutDialog />}
    </div>
  );
}
