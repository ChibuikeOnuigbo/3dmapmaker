/**
 * apps/web — camera bookmarks (REQUIREMENT 082).
 *
 * A bookmark is a full camera snapshot stored in the project, so it survives
 * reload, export and undo. Restoring one runs the real transition controller —
 * the same animated move you get from any other camera command.
 */
import React from 'react';
import { Button, IconButton, Panel, TextField } from '@3dmm/ui';
import { useEngine } from '../../engine/engineRef';
import { useStore } from '../../state/store';

export function BookmarkPanel(): React.ReactElement {
  const bookmarks = useStore((s) => s.project.bookmarks);
  const addBookmark = useStore((s) => s.addBookmark);
  const removeBookmark = useStore((s) => s.removeBookmark);
  const mutate = useStore((s) => s.mutate);
  const engine = useEngine();
  const [name, setName] = React.useState('');

  const go = (index: number) => {
    const b = bookmarks[index];
    if (!b) return;
    engine?.flyTo(
      {
        position: { ...b.camera.position },
        target: { ...b.camera.target },
        headingDeg: b.camera.headingDeg,
        pitchDeg: b.camera.pitchDeg,
        distance: b.camera.distance,
        fovDeg: b.camera.fovDeg,
      },
      `Bookmark: ${b.name}`,
    );
  };

  return (
    <Panel title="Bookmarks" panelId="bookmarks">
      <div className="bookmark-add">
        <TextField label="Name" value={name} onChange={setName} placeholder="View name" />
        <Button
          size="xs"
          variant="primary"
          onClick={() => {
            addBookmark(name.trim() || `View ${bookmarks.length + 1}`);
            setName('');
          }}
        >
          Save view
        </Button>
      </div>
      {bookmarks.length === 0 && <p className="ui-hint">No bookmarks yet. Save the current camera to jump back to it later.</p>}
      <ul className="bookmark-list">
        {bookmarks.map((b, i) => (
          <li key={b.id} className="bookmark-row">
            <button type="button" className="bookmark-row__go" onClick={() => go(i)}>
              {b.name}
            </button>
            <span className="bookmark-row__meta">
              {b.camera.mode} · {b.camera.pitchDeg.toFixed(0)}°
            </span>
            <IconButton
              label={`Rename ${b.name}`}
              size="xs"
              variant="ghost"
              onClick={() => {
                const next = window.prompt('Bookmark name', b.name);
                if (next === null) return;
                mutate((d) => {
                  const target = d.bookmarks.find((x) => x.id === b.id);
                  if (target) target.name = next;
                }, 'Rename bookmark');
              }}
            >
              ✎
            </IconButton>
            <IconButton label={`Delete ${b.name}`} size="xs" variant="ghost" onClick={() => removeBookmark(b.id)}>
              ×
            </IconButton>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
