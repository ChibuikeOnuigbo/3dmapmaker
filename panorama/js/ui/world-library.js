/**
 * Panorama Maps — ui/world-library.js
 *
 * THE WORLDS SURFACE — one panel for saving the world you are in and for
 * every world you have made.
 *
 *   Save new world      name · author · notes · tags, then
 *                       “Save to database” (desktop) or “Save .pworld file”
 *   Worlds              the library table: World · Places · Images · Size ·
 *                       Updated · Open / Export / Delete  (desktop build)
 *   Versions            snapshots of the open world, restorable
 *   Activity            what the database has been doing (desktop build)
 *
 * The panel is honest in both homes: on the web it says plainly that worlds
 * live in `.pworld` files and that the desktop app adds the database, and it
 * never shows a control that cannot work.
 */
import { Desktop } from '../io/desktop.js';
import { formatBytes, PWORLD_EXT } from '../io/pworld.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const when = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export class WorldLibrary {
  constructor(app) {
    this.app = app;
    this.panel = document.getElementById('worldsPanel');
    this._open = false;
    this._tab = 'save';
    this._worlds = [];
    this._busy = false;
    this._progress = null;
    this._card = { author: '', description: '', tags: '' };
    this._inspectFile = null;
    // one listener for the life of the panel: re-rendering replaces the
    // markup, never the handler (a per-render listener would double-fire)
    this.panel.addEventListener('click', (e) => this._click(e));
  }

  get isOpen() { return this._open; }

  async open(tab = null) {
    this._open = true;
    this.panel.hidden = false;
    if (tab) this._tab = tab;
    this._render();
    if (Desktop.online) await this.refresh();
  }

  close() { this._open = false; this.panel.hidden = true; }

  toggle(tab = null) { return this.isOpen ? this.close() : this.open(tab); }

  /** The world under the panel changed (opened, imported, swapped): redraw it,
      so the save card never describes the world you were in a minute ago. */
  worldChanged() { if (this._open) this._render(); }

  /* ================= data ================= */
  async refresh() {
    if (!Desktop.online) return;
    try {
      const [lib, storage, versions] = await Promise.all([
        Desktop.listWorlds(),
        Desktop.storage(),
        this.app.project?.id ? Desktop.listRevisions(this.app.project.id).catch(() => null) : null,
      ]);
      this._worlds = lib.worlds || [];
      this._storage = storage;
      this._versions = versions?.revisions || null;
    } catch (err) {
      this.app.toast(`Worlds database: ${err.message}`, 'err', 4000);
    }
    if (this._open) this._render();
  }

  /* ================= render ================= */
  _render() {
    const world = this.app.graph;
    const card = this._cardFor(world);
    const tabs = [['save', 'Save new world'], ['library', 'Worlds']];
    if (Desktop.online) { tabs.push(['versions', 'Versions'], ['activity', 'Activity']); }

    this.panel.innerHTML = `
      <div class="p-head">
        <h3>Worlds</h3>
        <button class="iconbtn mini" data-act="close" aria-label="Close worlds panel"><svg><use href="#i-close"/></svg></button>
      </div>

      <div class="wl-mode ${Desktop.online ? 'desk' : 'web'}">
        <svg class="ic"><use href="#${Desktop.online ? 'i-db' : 'i-save'}"/></svg>
        ${Desktop.online
          ? `<span><strong>Desktop build</strong> · worlds database (${esc(Desktop.dbEngine)})<br><span class="wl-path">${esc(Desktop.dbPath || '')}</span></span>`
          : '<span><strong>Web build</strong> · no database by design — worlds travel as one <code>.pworld</code> file. The desktop app adds the worlds database.</span>'}
      </div>

      <div class="wl-tabs">
        ${tabs.map(([id, label]) => `<button class="wl-tab ${this._tab === id ? 'on' : ''}" data-tab="${id}">${label}${id === 'library' && this._worlds.length ? `<span class="pill">${this._worlds.length}</span>` : ''}</button>`).join('')}
      </div>

      <div class="p-body">
        ${this._busy ? this._progressView() : ''}
        <div data-view="save" ${this._tab === 'save' ? '' : 'hidden'}>
          ${this._saveView(card, world)}
        </div>
        <div data-view="library" ${this._tab === 'library' ? '' : 'hidden'}>
          ${this._libraryView()}
        </div>
        <div data-view="versions" ${this._tab === 'versions' ? '' : 'hidden'}>
          ${this._versionsView()}
        </div>
        <div data-view="activity" ${this._tab === 'activity' ? '' : 'hidden'}>
          ${this._activityView()}
        </div>
      </div>`;

    this.panel.querySelectorAll('[data-field]').forEach((el) => {
      el.addEventListener('input', () => { this._card[el.dataset.field] = el.value; });
    });
    this.panel.querySelectorAll('[data-mode]').forEach((el) => {
      el.addEventListener('change', () => {
        this.setEstimate('measuring…');
        this.measure().then((out) => { if (out && this._tab === 'save') this.setEstimate(out.text); }).catch(() => {});
      });
    });
    if (this._tab === 'save') {
      this.setEstimate('measuring…');
      this.measure().then((out) => { if (out && this._tab === 'save') this.setEstimate(out.text); }).catch(() => {});
    }
  }

  _cardFor(world) {
    const p = this.app.project || {};
    if (this._card.id !== (world?.id || p.id)) {
      this._card = {
        id: world?.id || p.id,
        author: p.author || this._card.author || '',
        description: this.app.worldDef?.blurb || world?.description || this._card.description || '',
        tags: (p.tags || []).join(', '),
      };
    }
    return this._card;
  }

  _progressView() {
    const p = this._progress || { label: 'working…', done: 0, total: 0 };
    const pct = p.total ? Math.round((p.done / p.total) * 100) : null;
    return `<div class="wl-progress">
      <div class="wl-bar"><span style="width:${pct ?? 15}%${pct == null ? ';animation:pulse 1.2s infinite' : ''}"></span></div>
      <div class="hint">${esc(p.label)}${pct != null ? ` · ${pct}%` : ''}</div>
    </div>`;
  }

  _saveView(card, world) {
    const nodes = world ? world.nodes.size : 0;
    const images = world ? [...world.nodes.values()].filter(n => n.pano?.kind === 'asset' || n.pano?.kind === 'embedded' || n.pano?.kind === 'urlset').length : 0;
    const modes = this.app._urlsetModes || [];
    return `
      <div class="hint">Everything about this world is written into the file: every place, every connection, the map scale, the zones, the landmarks — and <strong>every image, embedded inside the file</strong>. Delete the photos from this device, open the file on another machine, walk it offline: it still works.</div>

      <div class="stitle">World card</div>
      <div class="field"><label>World name</label><input type="text" data-field="name" value="${esc(world?.name || '')}" placeholder="My world"></div>
      <div class="field"><label>Made by</label><input type="text" data-field="author" value="${esc(card.author)}" placeholder="your name"></div>
      <div class="field"><label>Notes</label><input type="text" data-field="description" value="${esc(card.description)}" placeholder="what this world is"></div>
      <div class="field"><label>Tags <span class="suffix">comma separated</span></label><input type="text" data-field="tags" value="${esc(card.tags)}" placeholder="village, demo"></div>

      ${modes.length ? `
      <div class="stitle">Scene modes to embed</div>
      <div class="wl-modes" id="wlModes">
        ${modes.map(m => `<label class="switch"><span class="lab">${esc(m)}</span><span class="tswitch"><input type="checkbox" data-mode="${esc(m)}" checked><span class="track"></span></span></label>`).join('')}
      </div>
      <div class="hint">Unticking a mode keeps it as a link instead of embedding it — smaller file, but that mode needs the original site.</div>` : ''}

      <div class="wl-facts">
        <span><strong>${nodes.toLocaleString()}</strong> places</span>
        <span><strong>${world ? world.edges.size.toLocaleString() : 0}</strong> connections</span>
        <span><strong>${images.toLocaleString()}</strong> panorama${images === 1 ? '' : 's'}</span>
        <span id="wlEstimate">measuring…</span>
      </div>

      <div class="stitle">Save</div>
      ${Desktop.online ? `
        <button class="btn block" data-act="saveDb"><svg><use href="#i-db"/></svg>Save to worlds database</button>
        <div class="hint" style="margin-bottom:8px">Stores the world and its images in the desktop database, with a version snapshot.</div>` : ''}
      <button class="btn ${Desktop.online ? 'ghost ' : ''}block" data-act="saveFile"><svg><use href="#i-save"/></svg>Save ${PWORLD_EXT} file${Desktop.online ? ` <small>· written to the exports folder</small>` : ''}</button>
      ${Desktop.online ? '<button class="btn ghost block" data-act="saveBoth"><svg><use href="#i-check"/></svg>Save both — database + file</button>' : ''}
      <button class="btn ghost block" data-act="openFile"><svg><use href="#i-open"/></svg>Open a world file</button>
      <button class="btn ghost block" data-act="inspect"><svg><use href="#i-search"/></svg>Look inside a world file first</button>
      <div id="wlInspect"></div>
      <div class="divider"></div>
      <div class="hint">Also in the Panels menu, and on <kbd>Ctrl</kbd>+<kbd>S</kbd>.</div>`;
  }

  _libraryView() {
    if (!Desktop.online) {
      return `
        <div class="stitle">No database in the web build</div>
        <div class="hint">The web build is static HTML and JavaScript only — deliberately no database. Every world you make is saved as a <code>${PWORLD_EXT}</code> file that carries all of its images inside it, so it opens anywhere, with or without this site.</div>
        <div class="divider"></div>
        <div class="stitle">Open the desktop app to get</div>
        <ul class="wl-list">
          <li>A worlds database (SQLite) listing every world you made</li>
          <li>All images stored once, content addressed, de-duplicated</li>
          <li>Version history for each world, restorable</li>
          <li>“.pworld” export and import straight from the library</li>
        </ul>
        <div class="hint">See <code>docs/DESKTOP.md</code> — it runs on Linux, Windows and macOS with no install.</div>`;
    }
    if (!this._worlds.length) {
      return `<div class="stitle">Worlds</div><div class="hint">The database is empty. Save the world you are walking in — use <strong>Save new world</strong>.</div>`;
    }
    const rows = this._worlds.map((w) => {
      const current = w.id === this.app.project?.id;
      const sub = [w.author ? `by ${esc(w.author)}` : null, when(w.updatedAt)].filter(Boolean).join(' · ');
      return `<tr class="${current ? 'on' : ''}">
        <td class="wl-name"><span class="dot"></span><span class="wl-nm"><b title="${esc(w.name)}">${esc(w.name)}</b><small title="${esc(sub)}">${sub}</small></span>${current ? '<span class="pill">open</span>' : ''}</td>
        <td>${w.nodeCount.toLocaleString()}</td>
        <td>${w.assetCount.toLocaleString()}</td>
        <td>${formatBytes(w.assetBytes)}</td>
        <td class="wl-acts">
          <button class="mini" data-wact="open" data-id="${esc(w.id)}" title="Open this world"><svg><use href="#i-play"/></svg></button>
          <button class="mini" data-wact="export" data-id="${esc(w.id)}" title="Export a .pworld file"><svg><use href="#i-save"/></svg></button>
          <button class="mini" data-wact="copy" data-id="${esc(w.id)}" title="Save a copy under a new name"><svg><use href="#i-plus"/></svg></button>
          <button class="mini danger" data-wact="delete" data-id="${esc(w.id)}" title="Delete from the database"><svg><use href="#i-trash"/></svg></button>
        </td>
      </tr>`;
    }).join('');
    const s = this._storage || {};
    return `
      <div class="stitle">Worlds <span class="sub">${this._worlds.length} in the database</span></div>
      <div class="wl-tablewrap">
        <table class="wl-table">
          <thead><tr><th>World</th><th>Places</th><th>Images</th><th>Size</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="wl-facts">
        <span><strong>${(s.worlds ?? this._worlds.length).toLocaleString()}</strong> worlds</span>
        <span><strong>${(s.assets ?? 0).toLocaleString()}</strong> images</span>
        <span><strong>${formatBytes(s.assetBytes ?? 0)}</strong> stored</span>
        <span><strong>${(s.revisions ?? 0).toLocaleString()}</strong> versions</span>
      </div>
      <button class="btn ghost block" data-act="refresh"><svg><use href="#i-wind"/></svg>Refresh</button>`;
  }

  _versionsView() {
    if (!Desktop.online) return '<div class="hint">Version history lives in the desktop database.</div>';
    const revs = this._versions;
    if (!revs) return '<div class="hint">Open a world from the database to see its versions.</div>';
    if (!revs.length) return '<div class="hint">No snapshots yet for this world — save it once.</div>';
    return `
      <div class="stitle">Versions <span class="sub">of the open world</span></div>
      ${revs.map((r) => `<div class="wl-rev">
        <div class="grow"><strong>${esc(r.label || 'snapshot')}</strong><small>${when(r.createdAt || r.created_at)} · ${r.node_count ?? r.nodeCount} places · ${r.asset_count ?? r.assetCount} images</small></div>
        <button class="mini" data-wact="restore" data-id="${r.id}" title="Restore this version"><svg><use href="#i-up"/></svg></button>
      </div>`).join('')}
      <button class="btn ghost block" data-act="snapshot"><svg><use href="#i-plus"/></svg>Snapshot the current state</button>`;
  }

  _activityView() {
    if (!Desktop.online) return '<div class="hint">Activity lives in the desktop database.</div>';
    const ev = this._storage?.events || [];
    if (!ev.length) return '<div class="hint">Nothing recorded yet.</div>';
    return `<div class="stitle">Recent activity</div>
      ${ev.map(e => `<div class="wl-ev"><span class="kind">${esc(e.kind)}</span><span class="grow">${esc(e.detail)}</span><small>${when(e.at)}</small></div>`).join('')}`;
  }

  /* ================= interactions ================= */
  _click(e) {
    const tab = e.target.closest('[data-tab]')?.dataset.tab;
    if (tab) { this._tab = tab; return this._render(); }

    const wact = e.target.closest('[data-wact]');
    if (wact) return this._worldAction(wact.dataset.wact, wact.dataset.id);

    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    switch (act) {
      case 'close': return this.app.closePanels();
      case 'refresh': return this.refresh().then(() => this._render());
      case 'saveDb': return this.app.saveWorldToDatabase(this._cardNow());
      case 'saveFile': return this.app.saveWorldFile(this._cardNow());
      case 'saveBoth': return this.app.saveWorldToDatabase(this._cardNow()).then((ok) => ok && this.app.saveWorldFile(this._cardNow()));
      case 'openFile': return this.app.openAnyFile();
      case 'inspect': return this.app.inspectWorldFileFlow();
      case 'inspectOpen': return this.app.openWorldFile(this._inspectFile);
      case 'inspectClose': return this.showInspect(null);
      case 'snapshot': return this.app.snapshotWorldVersion(this._cardNow());
      default: return undefined;
    }
  }

  _cardNow() {
    const q = (sel) => this.panel.querySelector(sel)?.value ?? '';
    const modes = [...this.panel.querySelectorAll('[data-mode]')].filter(c => c.checked).map(c => c.dataset.mode);
    return {
      name: q('[data-field="name"]').trim() || this.app.graph?.name || 'Untitled world',
      author: q('[data-field="author"]').trim(),
      description: q('[data-field="description"]').trim(),
      tags: q('[data-field="tags"]').split(',').map(s => s.trim()).filter(Boolean),
      modes: modes.length ? modes : null,
    };
  }

  async _worldAction(what, id) {
    const world = this._worlds.find(w => w.id === id);
    try {
      if (what === 'open') {
        await this.app.loadWorldFromDatabase(id);
        this.close();
      } else if (what === 'export') {
        this.busy({ label: `Exporting “${world?.name || id}” with its images…` });
        const out = await Desktop.exportPworld(id);
        this.busy(null);
        if (out?.saved) this.app.toast(`Saved ${out.saved} (${formatBytes(out.bytes)})`, 'ok', 7000);
      } else if (what === 'copy') {
        const name = prompt('Name for the copy:', `${world?.name || 'World'} copy`);
        if (!name) return;
        const rec = await Desktop.getWorld(id);
        const newId = `${id}_${Date.now().toString(36)}`;
        rec.world.id = newId;
        rec.world.name = name;
        const assets = rec.assets.map(a => ({ id: a.id, blobUrl: Desktop.assetUrl(id, a.id), meta: a }));
        await Desktop.saveWorld({ id: newId, name, author: rec.meta.author, description: rec.meta.description, tags: rec.meta.tags, worldJson: rec.world, revisionLabel: 'copy' });
        for (const a of assets) {
          const blob = await fetch(a.blobUrl).then(r => (r.ok ? r.blob() : null));
          if (blob) await Desktop.putAsset(newId, a.id, new Uint8Array(await blob.arrayBuffer()), { mime: a.meta.mime, role: a.meta.role, mode: a.meta.mode, name: a.meta.name, sha256: a.meta.sha256, width: a.meta.width, height: a.meta.height });
        }
        await Desktop.saveWorld({ id: newId, name, author: rec.meta.author, description: rec.meta.description, tags: rec.meta.tags, worldJson: rec.world, revision: false });
        this.app.toast(`Copied to “${name}” in the database`, 'ok');
        await this.refresh();
        this._render();
      } else if (what === 'delete') {
        if (!confirm(`Delete “${world?.name || id}” from the database? The images stored for it go too.`)) return;
        await Desktop.deleteWorld(id);
        this.app.toast(`Deleted “${world?.name || id}”`, 'ok');
        await this.refresh();
        this._render();
      } else if (what === 'restore') {
        if (!confirm('Replace the open world with this version?')) return;
        await Desktop.restoreRevision(id);
        this.app.toast('Version restored', 'ok');
        await this.app.loadWorldFromDatabase(this.app.project.id);
        await this.refresh();
        this._render();
      }
    } catch (err) {
      this.busy(null);
      this.app.toast(`Worlds: ${err.message}`, 'err', 5000);
    }
  }

  /** Progress display while a big world saves (images take a moment). */
  busy(progress) {
    this._busy = !!progress;
    this._progress = progress;
    if (this._open) this._render();
  }

  setProgress(progress) { this.busy(progress); }

  /**
   * What is inside a world file, read from the file itself — before you open
   * it. The file is not opened by this: it is reported, and you decide.
   */
  showInspect(info, file = null, error = null) {
    this._inspectFile = info ? file : null;
    const slot = this.panel.querySelector('#wlInspect');
    if (!slot) return;
    if (error) {
      slot.innerHTML = `<div class="wl-inspect"><h4>That file could not be read</h4><div class="err">${esc(error)}</div>
        <div class="acts"><button class="btn ghost" data-act="inspectClose">Close</button></div></div>`;
      return;
    }
    if (!info) { slot.innerHTML = ''; return; }
    const row = (k, v) => (v === undefined || v === null || v === '' ? '' : `<span>${esc(k)}</span><b>${esc(String(v))}</b>`);
    slot.innerHTML = `<div class="wl-inspect">
      <h4>${esc(info.name || 'Untitled world')}</h4>
      <div class="rows">
        ${row('Made by', info.author)}
        ${row('Places', info.nodes?.toLocaleString())}
        ${row('Images inside', info.images?.toLocaleString())}
        ${row('Scene modes', info.modes?.join(', '))}
        ${row('File size', formatBytes(info.size))}
        ${row('Saved', info.createdAt ? when(info.createdAt) : null)}
        ${row('Format', `version ${info.version}`)}
      </div>
      ${info.missing ? `<div class="err">${info.missing} image(s) were never embedded in this file</div>` : ''}
      <div class="acts">
        <button class="btn" data-act="inspectOpen"><svg><use href="#i-open"/></svg>Open it</button>
        <button class="btn ghost" data-act="inspectClose">Close</button>
      </div>
    </div>`;
  }

  /** Set the size readout line under the save card. */
  setEstimate(text) {
    const el = this.panel.querySelector('#wlEstimate');
    if (el) el.textContent = text;
  }

  /**
   * Measure what this save will contain — how many images are going in, how
   * many of them are already on this device, and roughly how many bytes that
   * is. Anything not on the device yet is fetched while saving, so it is
   * counted, never guessed at.
   */
  async measure() {
    if (!this.app.graph) return null;
    const boxes = [...this.panel.querySelectorAll('[data-mode]')];
    const modes = boxes.length ? boxes.filter((b) => b.checked).map((b) => b.dataset.mode) : null;
    const pid = this.app.project?.id;

    const known = new Map();                       // assetId → bytes on this device
    for (const [key, rec] of this.app._sessionAssets || new Map()) {
      if (String(key).includes(':') || !rec?.blob) continue;
      known.set(String(key), rec.blob.size);
    }
    if (pid) {
      try {
        for (const row of await this.app.storage.listAssets(pid)) {
          const id = String(row.key).slice(pid.length + 1);
          if (id.includes(':') || !row.blob) continue;
          if (!known.has(id)) known.set(id, row.blob.size);
        }
      } catch { /* no local mirror: the estimate simply counts fewer images */ }
    }
    // the desktop build keeps the images in its database — they are local too
    if (Desktop.online && pid) {
      try {
        const rec = await Desktop.getWorld(pid);
        for (const a of rec?.assets || []) {
          const id = String(a.id || '').split(':')[0];
          if (!id || known.has(id)) continue;
          known.set(id, Number(a.bytes) || 0);
        }
      } catch { /* not in the database yet — it will be saved there */ }
    }

    let images = 0, ready = 0, readyBytes = 0, toFetch = 0;
    for (const node of this.app.graph.nodes.values()) {
      const p = node.pano;
      if (!p || p.kind === 'generated') continue;
      if (p.kind === 'urlset' || p.kind === 'embedded') {
        for (const [mode, id] of Object.entries(p.variants || {})) {
          if (modes && !modes.includes(mode)) continue;
          images++;
          if (p.kind === 'embedded' && known.has(id)) { ready++; readyBytes += known.get(id); }
          else if (p.kind === 'urlset') toFetch++;
        }
      } else if (p.kind === 'asset' && p.assetId) {
        images++;
        if (known.has(p.assetId)) { ready++; readyBytes += known.get(p.assetId); }
        else toFetch++;
      }
    }
    const missing = (this.app._urlsetModes || []).filter((m) => modes && !modes.includes(m)).length;
    const parts = [];
    if (!images) parts.push('nothing to embed — this world draws its own views');
    else if (!toFetch) parts.push(`≈ ${formatBytes(readyBytes)} · ${images} image${images === 1 ? '' : 's'} ready`);
    else if (!ready) parts.push(`${images} image${images === 1 ? '' : 's'} fetched while saving`);
    else parts.push(`≈ ${formatBytes(readyBytes)} ready · ${toFetch} still to fetch`);
    if (missing) parts.push(`${missing} mode${missing === 1 ? '' : 's'} left as links`);
    return { images, ready, readyBytes, toFetch, text: parts.join(' · ') };
  }
}
