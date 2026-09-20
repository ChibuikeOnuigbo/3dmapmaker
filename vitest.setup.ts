import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

// jsdom has no rAF-driven layout; give tests a deterministic clock source.
if (typeof globalThis.performance === 'undefined') {
  // @ts-expect-error test shim
  globalThis.performance = { now: () => Date.now() };
}

// jsdom has no ResizeObserver. The layer panel and the viewport both use it for
// real layout work, so tests that mount them need a working stand-in rather
// than a crash.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom does not implement these; components guard for them, but tests that
// exercise them need something callable.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = ((type: string) => {
    if (type === '2d') {
      return {
        canvas: null,
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
        textAlign: '',
        textBaseline: '',
        globalAlpha: 1,
        fillRect: vi.fn(),
        clearRect: vi.fn(),
        strokeRect: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        rotate: vi.fn(),
        drawImage: vi.fn(),
        createLinearGradient: () => ({ addColorStop: vi.fn() }),
        createRadialGradient: () => ({ addColorStop: vi.fn() }),
        measureText: () => ({ width: 10 }),
        fillText: vi.fn(),
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: vi.fn(),
        setTransform: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
    }
    return null;
  }) as unknown as HTMLCanvasElement['getContext'];
}
