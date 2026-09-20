/**
 * apps/web — engine handle shared between the viewport and the panels.
 *
 * The renderer lives outside React on purpose (it owns a WebGL context and a
 * worker pool), but the panels genuinely need to talk to it: frame the
 * selection, commit a drafted path, change the sculpt brush, step the
 * panorama. Rather than threading refs through ten components, this module
 * holds the one live instance and notifies subscribers when it changes, so
 * `useEngine()` re-renders only when the controller is created or disposed.
 */
import { useSyncExternalStore } from 'react';
import type { EngineController } from './EngineController';

let current: EngineController | null = null;
const listeners = new Set<() => void>();

export function attachEngine(engine: EngineController | null): void {
  if (current === engine) return;
  current = engine;
  for (const fn of listeners) fn();
}

export function getEngine(): EngineController | null {
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useEngine(): EngineController | null {
  return useSyncExternalStore(subscribe, getEngine, () => null);
}
