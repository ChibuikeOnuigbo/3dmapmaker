/**
 * apps/web — the layer tree (REQUIREMENTS 066-069).
 *
 * Rendered from a flattened, iterative walk of the canonical tree, so a cyclic
 * or self-referencing document cannot hang the UI — that is the exact failure
 * that took down the old monolith. The list is windowed: only the rows inside
 * the scroll viewport are in the DOM.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconButton, Tooltip } from '@3dmm/ui';
import { auditTree, findNode, flattenTree, type FlatNode } from '@3dmm/layers';
import type { ObjectNode } from '@3dmm/project';
import { useStore } from '../../state/store';

const ROW_HEIGHT = 26;
const OVERSCAN = 8;

const KIND_GLYPH: Record<string, string> = {
  group: '▸',
  terrain: '▲',
  water: '≈',
  roads: '═',
  buildings: '▣',
  vegetation: '♣',
  objects: '◆',
  panoramas: '◎',
  labels: 'T',
  measurements: '⟋',
  annotations: '✎',
  markers: '●',
  paths: '┄',
  polygons: '⬠',
  triggers: '⚡',
  effects: '✧',
};

function countDescendants(node: ObjectNode): number {
  let n = 0;
  const stack = [...node.children];
  while (stack.length) {
    const c = stack.pop()!;
    n++;
    for (const g of c.children) stack.push(g);
  }
  return n;
}

export function LayersPanel(): React.ReactElement {
  const layers = useStore((s) => s.project.layers);
  const selectedIds = useStore((s) => s.ui.selectedIds);
  const select = useStore((s) => s.select);
  const toggleVisibility = useStore((s) => s.toggleLayerVisibility);
  const toggleLock = useStore((s) => s.toggleLayerLock);
  const reorder = useStore((s) => s.reorderLayer);
  const moveLayer = useStore((s) => s.moveLayer);
  const isolate = useStore((s) => s.isolate);
  const isolated = useStore((s) => s.ui.isolated);
  const notify = useStore((s) => s.notify);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /* Flattened, collapse-filtered view of the tree. */
  const rows = useMemo(() => {
    const flat = flattenTree(layers);
    // flattenTree walks every node; hide descendants of collapsed groups here
    // rather than during the walk so the walk stays a pure structural op.
    const hidden = new Set<string>();
    for (const row of flat) {
      if (collapsed.has(row.node.id)) {
        const stack = [...row.node.children];
        while (stack.length) {
          const c = stack.pop()!;
          hidden.add(c.id);
          for (const g of c.children) stack.push(g);
        }
      }
    }
    return flat.filter((r) => !hidden.has(r.node.id));
  }, [layers, collapsed]);

  /* Structural audit — surfaced instead of crashing (REQ 004/067). */
  const audit = useMemo(() => auditTree(layers), [layers]);
  const auditIssues = useMemo(() => {
    const issues: string[] = [];
    if (audit.duplicateIds.length) issues.push(`${audit.duplicateIds.length} duplicate layer id(s) — the document will not save cleanly.`);
    if (audit.maxDepthExceeded) issues.push(`A branch is deeper than ${audit.maxDepth} levels; deeper nodes are not rendered.`);
    return issues;
  }, [audit]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const total = rows.length * ROW_HEIGHT;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);
  const window = rows.slice(first, last);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="layers" data-testid="layers-panel">
      <div className="layers__toolbar">
        <span className="ui-section-label">{rows.length} nodes</span>
        <div className="layers__toolbar-actions">
          <Tooltip label="Show only the selection" side="bottom">
            <IconButton
              label="Isolate selection"
              size="xs"
              variant="ghost"
              active={isolated !== null}
              disabled={selectedIds.length === 0 && isolated === null}
              onClick={() => isolate(isolated ? null : selectedIds)}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
              </svg>
            </IconButton>
          </Tooltip>
          <Tooltip label="Expand every group" side="bottom">
            <IconButton label="Expand all" size="xs" variant="ghost" onClick={() => setCollapsed(new Set())}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M7 10l5 5 5-5" />
              </svg>
            </IconButton>
          </Tooltip>
          <Tooltip label="Collapse every group" side="bottom">
            <IconButton
              label="Collapse all"
              size="xs"
              variant="ghost"
              onClick={() => {
                const groups = new Set<string>();
                const stack = [...layers];
                while (stack.length) {
                  const n = stack.pop()!;
                  if (n.children.length) groups.add(n.id);
                  for (const c of n.children) stack.push(c);
                }
                setCollapsed(groups);
              }}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M7 14l5-5 5 5" />
              </svg>
            </IconButton>
          </Tooltip>
        </div>
      </div>

      {auditIssues.length > 0 && (
        <div className="layers__audit" role="alert">
          {auditIssues.map((msg) => (
            <div key={msg}>{msg}</div>
          ))}
        </div>
      )}

      <div className="layers__scroll" ref={scrollRef} onScroll={onScroll} role="tree" aria-label="Scene layers">
        <div style={{ height: total, position: 'relative' }}>
          {window.map((row: FlatNode, i) => {
            const node = row.node as ObjectNode;
            const index = first + i;
            const isSelected = selectedIds.includes(node.id);
            const hasChildren = node.children.length > 0;
            const isCollapsed = collapsed.has(node.id);
            return (
              <div
                key={node.id}
                className="layer-row"
                role="treeitem"
                aria-selected={isSelected}
                aria-level={row.depth + 1}
                aria-expanded={hasChildren ? !isCollapsed : undefined}
                data-selected={isSelected ? 'true' : 'false'}
                style={{ position: 'absolute', top: index * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0, paddingLeft: 6 + row.depth * 12 }}
                onClick={(e) => select([node.id], e.shiftKey ? 'add' : e.metaKey || e.ctrlKey ? 'toggle' : 'replace')}
              >
                <button
                  type="button"
                  className="layer-row__chevron"
                  aria-label={isCollapsed ? `Expand ${node.name}` : `Collapse ${node.name}`}
                  tabIndex={-1}
                  disabled={!hasChildren}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapse(node.id);
                  }}
                >
                  {hasChildren ? (isCollapsed ? '▸' : '▾') : ''}
                </button>
                <span className="layer-row__icon" aria-hidden="true">
                  {KIND_GLYPH[node.kind] ?? '·'}
                </span>
                <span className="layer-row__name" title={node.name || node.kind}>
                  {node.name || node.kind}
                  {hasChildren && <span className="layer-row__count">{countDescendants(node)}</span>}
                </span>
                <span className="layer-row__actions">
                  <button
                    type="button"
                    className="layer-row__action"
                    aria-label={node.visible ? `Hide ${node.name}` : `Show ${node.name}`}
                    title={node.visible ? 'Visible' : 'Hidden'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleVisibility(node.id);
                    }}
                  >
                    {node.visible ? '👁' : '—'}
                  </button>
                  <button
                    type="button"
                    className="layer-row__action"
                    aria-label={node.locked ? `Unlock ${node.name}` : `Lock ${node.name}`}
                    title={node.locked ? 'Locked' : 'Unlocked'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleLock(node.id);
                    }}
                  >
                    {node.locked ? '🔒' : '🔓'}
                  </button>
                  <button
                    type="button"
                    className="layer-row__action"
                    aria-label={`Move ${node.name} up`}
                    title="Move up"
                    onClick={(e) => {
                      e.stopPropagation();
                      const siblings = row.parentId ? findNode(layers, row.parentId)?.children ?? layers : layers;
                      const at = siblings.findIndex((c) => c.id === node.id);
                      reorder(node.id, Math.max(0, at - 1));
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="layer-row__action"
                    aria-label={`Move ${node.name} into a new group`}
                    title="Group selection"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (selectedIds.length < 2) {
                        notify('info', 'Select two or more layers first, then click this to group them.');
                        return;
                      }
                      for (const id of selectedIds) {
                        if (id !== node.id) moveLayer(id, node.id);
                      }
                    }}
                  >
                    ⌸
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
