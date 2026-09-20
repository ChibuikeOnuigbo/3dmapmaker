/**
 * apps/web — the project menu in the header.
 *
 * Real actions only: new, open a demo, import, export, save, and the world
 * name. Each one either changes canonical state or produces a real file.
 */
import React from 'react';
import { Button, TextField } from '@3dmm/ui';
import { useStore } from '../state/store';
import { downloadProjectFile, downloadText, exportGeoJson } from '../state/io';

export function ProjectMenu(): React.ReactElement {
  const name = useStore((s) => s.project.name);
  const mutate = useStore((s) => s.mutate);
  const setUi = useStore((s) => s.setUi);
  const newWorld = useStore((s) => s.newWorld);
  const saveNow = useStore((s) => s.saveNow);

  return (
    <div className="app-header__brand">
      <span className="app-header__logo" aria-hidden="true" />
      <span className="app-header__name" title={name}>
        3DMapMaker
      </span>
      <TextField
        label="World name"
        value={name}
        onChange={(v) => mutate((d) => { d.name = v; }, 'Rename world', null)}
        id="project-name"
      />
      <Button size="xs" variant="ghost" onClick={newWorld}>
        New
      </Button>
      <Button size="xs" variant="ghost" onClick={() => setUi({ modal: 'demos' })}>
        Demos
      </Button>
      <Button size="xs" variant="ghost" onClick={() => setUi({ modal: 'import' })}>
        Import
      </Button>
      <Button size="xs" variant="ghost" onClick={downloadProjectFile}>
        Export
      </Button>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => downloadText(`${name.replace(/[^\w.-]+/g, '_') || 'world'}.geojson`, exportGeoJson(), 'application/geo+json')}
      >
        GeoJSON
      </Button>
      <Button size="xs" variant="primary" onClick={saveNow}>
        Save
      </Button>
    </div>
  );
}
