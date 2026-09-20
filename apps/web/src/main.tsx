/**
 * apps/web — entry point.
 *
 * Boots persistence (recovering an autosaved project if one exists), starts
 * debounced autosave, honours the user's reduced-motion preference and mounts
 * the router. Nothing here touches the network: the app is fully usable
 * offline (REQUIREMENT 120).
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bootPersistence, startAutosave, useStore } from './state/store';
import './styles/workbench.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

const prefersReduced =
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
useStore.setState((s) => ({ ui: { ...s.ui, reducedMotion: prefersReduced } }));

let bootWarnings: string[] = [];
try {
  bootWarnings = bootPersistence().warnings;
} catch (err) {
  // A corrupt autosave must never prevent the app from starting.
  bootWarnings = [`Autosave could not be read: ${(err as Error).message}`];
}
if (bootWarnings.length > 0) {
  useStore.setState((s) => ({ recoveryWarnings: [...s.recoveryWarnings, ...bootWarnings] }));
}

startAutosave();

// Surface genuinely unrecoverable errors instead of a blank white page.
const root = createRoot(container);
function renderError(err: unknown) {
  root.render(
    <React.StrictMode>
      <div className="fatal">
        <h1>3DMapMaker Next could not start</h1>
        <p>{String((err as Error)?.message ?? err)}</p>
        <p className="fatal__hint">
          Nothing was lost: your autosave stays in this browser. Try the QA page, or clear the autosave and start fresh.
        </p>
      </div>
    </React.StrictMode>,
  );
}

try {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (err) {
  renderError(err);
}

window.addEventListener('error', (e) => {
  if (e.error instanceof Error && /WebGL|three/.test(e.error.message)) {
    useStore.setState((s) => ({ errors: { ...s.errors, webgl: e.error.message } }));
  }
});
