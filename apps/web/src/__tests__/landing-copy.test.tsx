/**
 * Landing-page copy must match what the build actually does.
 *
 * This exists because the page lied twice, in ways a reader would not notice:
 *
 *  1. The demo heading was hardcoded to "Five demo worlds" while `DEMOS` held
 *     six entries — so the page contradicted the six cards rendered directly
 *     beneath it, in the same viewport.
 *  2. The footer advertised a "WASM terrain core". Nothing in this build loads a
 *     wasm module: `wasmAvailable` defaults to `false`, there is no `.wasm`
 *     asset anywhere in the bundle, and `crates/terrain-core` has never been
 *     compiled. The status bar already reports "ts core" honestly; the landing
 *     page claimed otherwise.
 *
 * A marketing page describing capabilities the product does not have is the same
 * class of failure as a fake metric, which the brief rules out explicitly. These
 * assertions tie the copy to the real values so it cannot drift silently again.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { App } from '../App';
import { DEMOS } from '../demos/demos';
import { useStore } from '../state/store';

function landing(): void {
  window.location.hash = '';
  act(() => {
    const s = useStore.getState();
    useStore.setState({ ui: { ...s.ui, notifications: [], modal: null } });
  });
  render(<App />);
}

beforeEach(() => {
  window.location.hash = '';
});

describe('landing page describes the real build', () => {
  it('the demo heading count is derived, not hardcoded', () => {
    landing();
    const heading = Array.from(document.querySelectorAll('h2')).find((h) =>
      /demo worlds/i.test(h.textContent ?? ''),
    );
    expect(heading, 'no demo-worlds heading found').toBeTruthy();

    // The number in the copy must equal the number of cards actually rendered.
    expect(heading!.textContent).toContain(String(DEMOS.length));
    expect(document.querySelectorAll('.landing__demo').length).toBe(DEMOS.length);

    // And it must not assert a specific wrong number again.
    expect(heading!.textContent).not.toMatch(/\bfive\b/i);
  });

  it('every demo has an Open button that is not disabled', () => {
    landing();
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.landing__demo button'));
    expect(buttons.length).toBe(DEMOS.length);
    for (const b of buttons) {
      expect(b.disabled, `"${b.textContent}" is disabled`).toBe(false);
      expect(b.textContent).toMatch(/^Open /);
    }
  });

  it('does not advertise a wasm terrain core that is not loaded', () => {
    landing();
    const footer = document.querySelector('.landing__footer');
    expect(footer).toBeTruthy();
    // No wasm module is instantiated anywhere in this build, so claiming one is
    // a false capability statement.
    expect(footer!.textContent).not.toMatch(/wasm/i);
    // The claims that remain must be true: Web Workers really are used, and the
    // store really does default to the TypeScript core. The status bar derives
    // its "ts core" label from this same flag, so the two surfaces now agree.
    expect(footer!.textContent).toMatch(/Web Workers/i);
    expect(useStore.getState().stats.wasmAvailable).toBe(false);
  });

  it('the footer claims no mandatory network calls, and the demos need none', () => {
    landing();
    expect(document.querySelector('.landing__footer')!.textContent).toMatch(
      /zero mandatory network calls/i,
    );
    // Substantiating the claim: every demo builds locally, synchronously, with no
    // fetch. If one ever needed the network this would have to change.
    for (const demo of DEMOS) {
      const project = demo.build();
      expect(project.name.length, `${demo.id} produced an unnamed project`).toBeGreaterThan(0);
      expect(project.schemaVersion).toBeGreaterThan(0);
    }
  });
});
