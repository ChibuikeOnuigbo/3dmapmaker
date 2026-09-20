/**
 * apps/web — the left tool rail (REQUIREMENT 130).
 *
 * Every button switches a real tool that the engine honours; none of them are
 * decorative. Shortcuts shown in the tooltips are the same ones registered in
 * the command bus, and they only fire while the viewport has focus.
 */
import React from 'react';
import { IconButton, Tooltip } from '@3dmm/ui';
import { useStore, type ToolId } from '../state/store';

interface ToolDef {
  id: ToolId;
  label: string;
  hint: string;
  key: string;
  glyph: React.ReactNode;
}

const G = {
  cursor: <path d="M5 3l13 7-6 1.6L9.6 18 5 3z" />,
  move: (
    <g>
      <path d="M12 3v18M3 12h18" />
      <path d="M12 3l-2.5 3h5L12 3zM12 21l-2.5-3h5L12 21zM3 12l3-2.5v5L3 12zM21 12l-3-2.5v5L21 12z" />
    </g>
  ),
  rotate: (
    <g>
      <path d="M20 12a8 8 0 1 1-2.5-5.8" />
      <path d="M20 4v4h-4" />
    </g>
  ),
  scale: (
    <g>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
      <path d="M11 11l2 2" />
    </g>
  ),
  sculpt: (
    <g>
      <path d="M3 17c3 0 3-6 6-6s3 4 6 4 3-3 6-3" />
      <path d="M3 21h18" />
    </g>
  ),
  measure: (
    <g>
      <path d="M3 15L15 3l6 6L9 21z" />
      <path d="M7 11l2 2M11 7l2 2M15 11l2 2" />
    </g>
  ),
  path: (
    <g>
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="6" r="2" />
      <path d="M7 17c6-1 4-8 10-10" />
    </g>
  ),
  polygon: <path d="M12 3l8 6-3 10H7L4 9z" />,
  panorama: (
    <g>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.6 2.4 2.6 14 0 17M12 3.5c-2.6 2.4-2.6 14 0 17" />
    </g>
  ),
  water: <path d="M12 3.5s6 6.6 6 10.5a6 6 0 1 1-12 0c0-3.9 6-10.5 6-10.5z" />,
  tree: (
    <g>
      <path d="M12 3l5 7h-3l4 6H6l4-6H7z" />
      <path d="M12 16v5" />
    </g>
  ),
};

const TOOLS: ToolDef[] = [
  { id: 'select', label: 'Select', hint: 'Click to select, Shift-click to add, drag for a marquee.', key: 'V', glyph: G.cursor },
  { id: 'move', label: 'Move', hint: 'Translate the selection. Hold Shift to snap to the grid.', key: 'G', glyph: G.move },
  { id: 'rotate', label: 'Rotate', hint: 'Rotate around the active axis.', key: 'R', glyph: G.rotate },
  { id: 'scale', label: 'Scale', hint: 'Scale the selection uniformly or per axis.', key: 'K', glyph: G.scale },
  { id: 'sculpt', label: 'Sculpt terrain', hint: 'Paint height and material with the brush.', key: 'T', glyph: G.sculpt },
  { id: 'measure', label: 'Measure', hint: 'Click points to measure distance, area or bearing.', key: 'M', glyph: G.measure },
  { id: 'path', label: 'Draw road / path', hint: 'Click to add points, Enter to finish, Esc to cancel.', key: 'P', glyph: G.path },
  { id: 'polygon', label: 'Draw polygon', hint: 'Click to outline an area, Enter to close.', key: 'O', glyph: G.polygon },
  { id: 'panorama', label: 'Panorama', hint: 'Step between linked 360° positions.', key: 'L', glyph: G.panorama },
  { id: 'water', label: 'Water', hint: 'Place a water body at the current level.', key: 'U', glyph: G.water },
  { id: 'vegetation', label: 'Vegetation', hint: 'Scatter instanced vegetation in the brush area.', key: 'B', glyph: G.tree },
];

const GROUP_BREAK = new Set<ToolId>(['measure', 'panorama']);

function ToolButton({ tool }: { tool: ToolDef }): React.ReactElement {
  const active = useStore((s) => s.ui.tool === tool.id);
  const setUi = useStore((s) => s.setUi);
  return (
    <Tooltip
      label={`${tool.label} — ${tool.hint} (${tool.key})`}
      side="right"
    >
      <IconButton
        className="tool-rail__btn"
        label={tool.label}
        aria-pressed={active}
        active={active}
        variant={active ? 'primary' : 'ghost'}
        data-tool={tool.id}
        onClick={() => setUi({ tool: tool.id })}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
          {tool.glyph}
        </svg>
      </IconButton>
    </Tooltip>
  );
}

export function ToolRail(): React.ReactElement {
  return (
    <nav className="tool-rail" aria-label="Tools">
      {TOOLS.map((t) => (
        <React.Fragment key={t.id}>
          {GROUP_BREAK.has(t.id) && <div className="tool-rail__divider" role="presentation" />}
          <ToolButton tool={t} />
        </React.Fragment>
      ))}
    </nav>
  );
}
