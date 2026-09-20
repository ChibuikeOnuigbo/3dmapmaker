/**
 * apps/web — import / export dialog.
 *
 * Import is validated and sanitised before anything touches the scene, and the
 * failures are listed rather than swallowed.
 */
import React, { useRef, useState } from 'react';
import { Button, Modal, TextArea } from '@3dmm/ui';
import { useStore } from '../state/store';
import { downloadProjectFile, downloadText, exportGeoJson, importGeoJson, importProjectFromFile, parseImportedJson } from '../state/io';

export function ImportExportDialog(): React.ReactElement | null {
  const modal = useStore((s) => s.ui.modal);
  const setUi = useStore((s) => s.setUi);
  const openProjectJson = useStore((s) => s.openProjectJson);
  const notify = useStore((s) => s.notify);
  const exportProject = useStore((s) => s.exportProject);
  const projectFileRef = useRef<HTMLInputElement | null>(null);
  const geoFileRef = useRef<HTMLInputElement | null>(null);
  const [json, setJson] = useState('');
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  if (modal !== 'import') return null;

  const close = () => {
    setUi({ modal: null });
    setIssues([]);
    setJson('');
  };

  const runPasteImport = () => {
    if (!json.trim()) {
      setIssues(['Paste some JSON first.']);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (err) {
      setIssues([`Not valid JSON: ${(err as Error).message}`]);
      return;
    }
    const outcome = parseImportedJson(raw);
    setIssues(outcome.issues);
    if (outcome.ok && outcome.project) {
      openProjectJson(outcome.project);
      notify('ok', `Imported “${outcome.project.name}”.`);
      close();
    }
  };

  const runFileImport = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const outcome = await importProjectFromFile(file);
    setBusy(false);
    setIssues(outcome.issues);
    if (outcome.ok && outcome.project) {
      openProjectJson(outcome.project);
      notify('ok', `Imported “${outcome.project.name}” from ${file.name}.`);
      close();
    }
  };

  const runGeoImport = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const outcome = importGeoJson(JSON.parse(text));
      setIssues(outcome.issues);
      if (outcome.ok) close();
    } catch (err) {
      setIssues([`Could not read that GeoJSON: ${(err as Error).message}`]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(v) => !v && close()}
      title="Import & export"
      description="Project files are JSON. Imported content is sanitised and schema-validated before it reaches the scene."
      width={560}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={downloadProjectFile}>
            Download project
          </Button>
          <Button size="sm" variant="ghost" onClick={() => downloadText('world.geojson', exportGeoJson(), 'application/geo+json')}>
            Download GeoJSON
          </Button>
          <Button size="sm" variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <input ref={projectFileRef} type="file" accept=".json,application/json" className="visually-hidden" onChange={(e) => void runFileImport(e.target.files?.[0])} />
      <input ref={geoFileRef} type="file" accept=".json,.geojson,application/geo+json" className="visually-hidden" onChange={(e) => void runGeoImport(e.target.files?.[0])} />

      <div className="panel-actions">
        <Button size="xs" variant="primary" disabled={busy} onClick={() => projectFileRef.current?.click()}>
          Import project file…
        </Button>
        <Button size="xs" disabled={busy} onClick={() => geoFileRef.current?.click()}>
          Import GeoJSON…
        </Button>
      </div>

      <TextArea label="Or paste project JSON" value={json} onChange={setJson} rows={8} placeholder='{ "schemaVersion": 5, … }' />
      <div className="panel-actions">
        <Button size="xs" onClick={runPasteImport}>
          Validate & import
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setJson(exportProject());
            setIssues([]);
          }}
        >
          Paste current project
        </Button>
      </div>

      {issues.length > 0 && (
        <div className="ui-error-banner" role="alert">
          <div className="ui-error-banner__text">
            <strong>Import rejected</strong>
            <ul>
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}
