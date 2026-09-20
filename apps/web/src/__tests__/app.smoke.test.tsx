/**
 * apps/web — app smoke test.
 *
 * Mounts the real App in jsdom and asserts it renders the landing page, that
 * the hash router reaches the editor, and that loading the church demo puts the
 * store into panorama mode with a live grid config. jsdom has no WebGL, so the
 * viewport falls back to its error banner — which is itself the behaviour under
 * test (ACCEPTANCE (f): errors visible and actionable).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { App } from '../App';
import { useStore } from '../state/store';
import { DEMOS } from '../demos/demos';

const NO_ERRORS = {
  save: null,
  terrain: null,
  provider: null,
  import: null,
  pointerLock: null,
  webgl: null,
  validation: [] as string[],
};

beforeEach(() => {
  window.location.hash = '';
  act(() => {
    const s = useStore.getState();
    useStore.setState({ ui: { ...s.ui, notifications: [], modal: null }, errors: { ...NO_ERRORS } });
  });
});

describe('App shell', () => {
  it('renders the landing page on the default route', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/build a 3d world/i);
    expect(screen.getByRole('button', { name: /open the editor/i })).toBeInTheDocument();
  });

  it('lists every demo world including the road to church', () => {
    render(<App />);
    const names = DEMOS.map((d) => d.name);
    expect(names).toContain('Road to Church');
    expect(names.length).toBeGreaterThanOrEqual(6);
  });

  it('reaches the editor route', () => {
    window.location.hash = '#/editor';
    render(<App />);
    // The editor mounts the tool rail; the canvas itself needs WebGL.
    expect(document.querySelector('.app-shell')).not.toBeNull();
  });

  it('surfaces a real WebGL failure instead of showing a blank canvas', () => {
    // jsdom's canvas has no WebGL context, so mounting the editor must produce
    // an actionable banner rather than a silent black rectangle. The message is
    // the one the Viewport writes when EngineController construction throws.
    window.location.hash = '#/editor';
    render(<App />);
    const alert = document.querySelector('.viewport-error [role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toMatch(/WebGL could not be initialised/i);
    // And it must offer a way out, not just complain.
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders an injected error banner verbatim', () => {
    window.location.hash = '#/editor';
    render(<App />);
    act(() => {
      useStore.getState().setErrors({ provider: 'Tile provider returned HTTP 503.' });
    });
    expect(screen.getByText(/Tile provider returned HTTP 503/i)).toBeInTheDocument();
  });
});

describe('loading the church demo', () => {
  it('switches the store into panorama mode with a grid', () => {
    const demo = DEMOS.find((d) => d.id === 'church')!;
    act(() => {
      useStore.getState().loadDemo(demo.build(), demo.name);
    });
    const p = useStore.getState().project;
    expect(p.name).toBe('Road to Church');
    expect(p.camera.mode).toBe('panorama');
    expect(p.panorama.grid).not.toBeNull();
    expect(p.panorama.grid?.cols).toBe(8);
    expect(p.panorama.grid?.goalNodeId).toBe('sq_64');
    expect(p.panorama.nodes.length).toBe(64);
    expect(p.panorama.currentNodeId).toBe('sq_1');
  });

  it('records no validation errors for the demo', () => {
    const demo = DEMOS.find((d) => d.id === 'church')!;
    act(() => {
      useStore.getState().loadDemo(demo.build(), demo.name);
    });
    expect(useStore.getState().errors.validation ?? []).toEqual([]);
  });

  it('emits a confirmation notification', () => {
    const demo = DEMOS.find((d) => d.id === 'church')!;
    act(() => {
      useStore.getState().loadDemo(demo.build(), demo.name);
    });
    const notes = useStore.getState().ui.notifications;
    expect(notes.some((n) => /Road to Church/.test(n.text))).toBe(true);
  });
});
