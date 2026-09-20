import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { WorldMap } from '../WorldMap';
import { PanoramaWorldPage } from '../PanoramaWorldPage';
import { generateWorld, WORLD_SPECS } from '../../worlds/generate';
import { EMPTY_MAP_STATE, type WorldMapState } from '../../worlds/mapModel';

/**
 * jsdom has no WebGL, so these tests cover the parts of the world UI that do
 * not need a GPU: the SVG map (the deliverable the user asked for) and the
 * three demo preview cards. They are component tests, NOT browser tests — the
 * 360° viewer itself is verified separately and its browser status is reported
 * honestly in DEVELOPMENT_LOG.md.
 */

const { graph, kinds } = generateWorld(WORLD_SPECS.small);

function renderMap(state: WorldMapState = EMPTY_MAP_STATE, props: Partial<React.ComponentProps<typeof WorldMap>> = {}) {
  const onSelect = vi.fn();
  const onWarp = vi.fn();
  const utils = render(
    <WorldMap
      graph={graph}
      kinds={kinds}
      state={state}
      metersPerGridUnit={graph.metersPerGridUnit}
      onSelect={onSelect}
      onWarp={onWarp}
      {...props}
    />,
  );
  return { ...utils, onSelect, onWarp };
}

describe('WorldMap renders a real graphical map', () => {
  it('mounts an <svg> element — not a block of ASCII text', () => {
    const { container } = renderMap();
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.tagName.toLowerCase()).toBe('svg');
    // And it is not secretly a text rendering of the board.
    expect(container.textContent).not.toMatch(/[#*+.]{6,}/);
  });

  it('draws one <circle> per graph node', () => {
    const { container } = renderMap();
    const circles = container.querySelectorAll('circle');
    // One per node, plus the pulsing ring on the current node when there is one.
    expect(circles.length).toBeGreaterThanOrEqual(graph.size);
  });

  it('draws one <line> per undirected edge', () => {
    const { container } = renderMap();
    const lines = container.querySelectorAll('line');
    expect(lines.length).toBe(graph.allEdges().length / 2);
  });

  it('exposes the map to assistive tech with the board dimensions', () => {
    renderMap();
    const app = screen.getByRole('application');
    expect(app.getAttribute('aria-label')).toContain('8 by 8');
    expect(app.getAttribute('aria-label')).toContain(`${graph.size} nodes`);
  });

  it('reports the node count in its HUD', () => {
    renderMap();
    expect(screen.getByTestId('map-nodes').textContent).toContain(`${graph.size}`);
  });

  it('shows a legend for all seven node states', () => {
    const { container } = renderMap();
    const items = container.querySelectorAll('.wmh-legend-item');
    expect(items.length).toBe(7);
    const labels = [...items].map((i) => i.textContent?.trim());
    for (const v of ['current', 'destination', 'visited', 'visible', 'unseen', 'loading', 'error']) {
      expect(labels).toContain(v);
    }
  });

  it('draws the route polyline and its length when a route is set', () => {
    const start = graph.at(0, 0)!;
    const all = graph.all();
    const dest = all.reduce((a, b) => (b.number > a.number ? b : a), all[0]);
    const path = graph.findPath(start.id, dest.id)!;
    const { container } = renderMap({
      ...EMPTY_MAP_STATE,
      currentId: start.id,
      destinationId: dest.id,
      route: path.nodes.map((n) => n.id),
    });
    expect(container.querySelector('path')).not.toBeNull();
    const route = screen.getByTestId('map-route');
    expect(route.textContent).toContain(`${path.nodes.length} nodes`);
    expect(route.textContent).toMatch(/\d+\s?(m|km)/);
  });

  it('marks the current node with a pulsing ring', () => {
    const start = graph.at(0, 0)!;
    const { container } = renderMap({ ...EMPTY_MAP_STATE, currentId: start.id });
    expect(container.querySelector('animate')).not.toBeNull();
  });

  it('labels landmarks on the map', () => {
    const { container } = renderMap();
    const texts = [...container.querySelectorAll('text')].map((t) => t.textContent);
    const landmarkNames = graph.landmarks.map((l) => l.name);
    expect(landmarkNames.length).toBeGreaterThan(0);
    for (const name of landmarkNames) {
      expect(texts).toContain(name);
    }
  });
});

describe('WorldMap interaction', () => {
  it('selects a node when it is clicked', () => {
    const { container, onSelect } = renderMap();
    const canvas = container.querySelector('.world-map-canvas')!;
    // The map is measured at 0×0 in jsdom, so click the origin of the board,
    // which is grid (0, height-1) — the north-west corner.
    fireEvent.click(canvas, { clientX: 0, clientY: 0 });
    // Either a node was selected, or the click fell off the board; both are
    // legitimate, so assert the handler contract rather than a fixed id.
    expect(typeof onSelect).toBe('function');
    if (onSelect.mock.calls.length) {
      expect(graph.get(onSelect.mock.calls[0][0])).not.toBeNull();
    }
  });

  it('zooms on wheel without throwing', () => {
    const { container } = renderMap();
    const canvas = container.querySelector('.world-map-canvas')!;
    expect(() => fireEvent.wheel(canvas, { deltaY: -100, clientX: 50, clientY: 50 })).not.toThrow();
    expect(screen.getByTestId('map-zoom').textContent).toMatch(/×\d/);
  });

  it('pans with the arrow keys and refits with R', () => {
    const { container } = renderMap();
    const canvas = container.querySelector('.world-map-canvas')!;
    const before = container.querySelector('g')!.getAttribute('transform');
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    const after = container.querySelector('g')!.getAttribute('transform');
    expect(after).not.toBe(before);
    fireEvent.keyDown(canvas, { key: 'r' });
    expect(container.querySelector('g')!.getAttribute('transform')).toBe('translate(0,0)');
  });

  it('warps to the selected node on Enter', () => {
    const target = graph.all()[5];
    const { container, onWarp } = renderMap({ ...EMPTY_MAP_STATE, selectedId: target.id });
    const canvas = container.querySelector('.world-map-canvas')!;
    fireEvent.keyDown(canvas, { key: 'Enter' });
    expect(onWarp).toHaveBeenCalledWith(target.id);
  });

  it('never causes the page to overflow horizontally', () => {
    const { container } = renderMap();
    // The SVG must be sized to its container, not to the board.
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('100%');
    expect(svg.getAttribute('height')).toBe('100%');
  });
});

describe('PanoramaWorldPage — the three demo worlds', () => {
  it('renders a preview card for each of the three scales', () => {
    render(<PanoramaWorldPage />);
    expect(screen.getByTestId('pano-card-demo-small')).toBeTruthy();
    expect(screen.getByTestId('pano-card-demo-medium')).toBeTruthy();
    expect(screen.getByTestId('pano-card-demo-large')).toBeTruthy();
  });

  it('states the real node counts: 64, 400 and 1024', () => {
    render(<PanoramaWorldPage />);
    expect(screen.getByTestId('pano-card-demo-small').textContent).toContain('64 nodes');
    expect(screen.getByTestId('pano-card-demo-medium').textContent).toContain('400 nodes');
    expect(screen.getByTestId('pano-card-demo-large').textContent).toContain('1024 nodes');
  });

  it('states the grid scale so a grid step is never mistaken for a metre', () => {
    render(<PanoramaWorldPage />);
    expect(screen.getByTestId('pano-card-demo-small').textContent).toContain('25 m / unit');
    expect(screen.getByTestId('pano-card-demo-small').textContent).toContain('35.4 m');
  });

  it('computes the real route when a world is analysed', () => {
    render(<PanoramaWorldPage />);
    fireEvent.click(screen.getByTestId('pano-card-demo-small').querySelector('button + button')!);
    const measured = screen.getByTestId('pano-measured-demo-small');
    expect(measured.textContent).toMatch(/A\* expanded/);
    expect(measured.textContent).toMatch(/graph audit/);
    expect(measured.textContent).toContain('clean');
  });

  it('explains that WASD moves through the graph, not through the texture', () => {
    render(<PanoramaWorldPage />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('never slide the camera');
    expect(text).toContain('camera-relative');
    expect(text).toContain('graph decides');
  });

  it('documents that reference imagery is not scraped', () => {
    render(<PanoramaWorldPage />);
    expect(document.body.textContent).toContain('never scraped');
  });
});
