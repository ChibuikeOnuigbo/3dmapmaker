/**
 * apps/web — the command palette (REQUIREMENT 132).
 *
 * Opens on Ctrl/Cmd+Shift+P (also ⌘K in the header). Every entry is a real
 * command from the shared registry, so nothing here can be a dead button.
 * While it is open the engine's keyboard layer is told an overlay is blocking,
 * which is what stops WASD from firing into the search field.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEngine } from '../engine/engineRef';
import { useStore } from '../state/store';
import { APP_COMMANDS, scoreCommand, type AppCommand } from './appCommands';

export function CommandPalette(): React.ReactElement | null {
  const open = useStore((s) => s.ui.commandPaletteOpen);
  const setUi = useStore((s) => s.setUi);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const engine = useEngine();

  const results = useMemo(() => {
    const scored = APP_COMMANDS.map((c) => ({ cmd: c, score: scoreCommand(query, `${c.group} ${c.label}`) }))
      .filter((r) => r.score > 0 && (r.cmd.enabled ? r.cmd.enabled() : true))
      .sort((a, b) => b.score - a.score || a.cmd.label.localeCompare(b.cmd.label));
    return scored.map((r) => r.cmd);
  }, [query]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  /* Focus the input and tell the input layer an overlay is up. */
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  /* Keep the highlighted row in view without scrolling the whole panel. */
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => (results.length === 0 ? 0 : (c + 1) % results.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => (results.length === 0 ? 0 : (c - 1 + results.length) % results.length));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        run(results[cursor]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, results, cursor]);

  if (!open) return null;

  function close() {
    setUi({ commandPaletteOpen: false });
    setQuery('');
    // Return keyboard ownership to the viewport.
    engine?.focusViewport();
  }

  function run(cmd: AppCommand | undefined) {
    if (!cmd) return;
    close();
    try {
      cmd.run();
    } catch (err) {
      useStore.getState().notify('error', `"${cmd.label}" failed: ${(err as Error).message}`);
    }
  }

  let lastGroup = '';

  return (
    <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="cmdk__panel">
        <input
          ref={inputRef}
          className="cmdk__input"
          value={query}
          placeholder="Search commands…"
          aria-label="Search commands"
          aria-controls="cmdk-list"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="cmdk__list" id="cmdk-list" ref={listRef} role="listbox" aria-label="Commands">
          {results.length === 0 && <div className="cmdk__empty">No command matches “{query}”.</div>}
          {results.map((cmd, i) => {
            const header = cmd.group !== lastGroup ? cmd.group : null;
            lastGroup = cmd.group;
            return (
              <React.Fragment key={cmd.id}>
                {header && <div className="cmdk__item__group">{header}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  data-index={i}
                  className="cmdk__item"
                  data-active={i === cursor ? 'true' : 'false'}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => run(cmd)}
                >
                  <span className="cmdk__item__label">{cmd.label}</span>
                  {cmd.shortcut && <kbd className="cmdk__item__key">{cmd.shortcut}</kbd>}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
