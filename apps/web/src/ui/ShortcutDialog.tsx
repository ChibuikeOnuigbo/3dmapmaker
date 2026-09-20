/**
 * apps/web — keyboard shortcut reference (REQUIREMENT 133).
 *
 * Lists the bindings the input layer actually registers, grouped by scope, and
 * says plainly which ones only work while the viewport has focus.
 */
import React from 'react';
import { Badge, Button, Modal } from '@3dmm/ui';
import { defaultBindings } from '@3dmm/input';
import { COMMAND_BY_ID } from './appCommands';
import { useStore } from '../state/store';

function chordLabel(chord: { key: string; ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean }): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.meta) parts.push('Cmd');
  if (chord.shift) parts.push('Shift');
  if (chord.alt) parts.push('Alt');
  const key = chord.key.length === 1 ? chord.key.toUpperCase() : chord.key;
  parts.push(key);
  return parts.join(' + ');
}

export function ShortcutDialog(): React.ReactElement | null {
  const modal = useStore((s) => s.ui.modal);
  const setUi = useStore((s) => s.setUi);
  if (modal !== 'shortcuts') return null;

  const bindings = defaultBindings();
  const viewport: Array<[string, string]> = [];
  const global: Array<[string, string]> = [];
  const GLOBAL = new Set(['edit.undo', 'edit.redo', 'edit.delete', 'edit.duplicate', 'ui.commandPalette', 'ui.playToggle', 'file.new', 'file.save', 'file.export', 'file.import', 'file.demos', 'ui.shortcuts', 'ui.statsToggle', 'view.gridToggle', 'view.contoursToggle']);

  for (const b of bindings) {
    const cmd = COMMAND_BY_ID.get(b.command);
    const label = cmd?.label ?? b.command;
    const key = chordLabel(b.chord);
    if (GLOBAL.has(b.command)) global.push([key, label]);
    else viewport.push([key, label]);
  }

  const table = (rows: Array<[string, string]>) => (
    <table className="shortcut-table">
      <tbody>
        {rows.map(([key, label]) => (
          <tr key={`${key}-${label}`}>
            <td>
              <kbd>{key}</kbd>
            </td>
            <td>{label}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <Modal
      open
      onOpenChange={(v) => !v && setUi({ modal: null })}
      title="Keyboard shortcuts"
      description="Movement keys are viewport-scoped on purpose: they never fire while a text field or panel has focus."
      width={680}
      footer={
        <Button size="sm" variant="primary" onClick={() => setUi({ modal: null })}>
          Close
        </Button>
      }
    >
      <h3 className="ui-section-label">
        Viewport only <Badge tone="info">requires focus</Badge>
      </h3>
      {table(viewport)}
      <h3 className="ui-section-label">Everywhere</h3>
      {table(global)}
      <p className="ui-hint">
        WASD and the arrow keys drive the same logical axes, so arrow-key users get identical movement with normalised
        diagonals. Rebinding is stored per browser and never overrides text-entry keys.
      </p>
    </Modal>
  );
}
