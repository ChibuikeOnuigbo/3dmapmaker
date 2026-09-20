/**
 * Panorama Maps — editors/advanced-editor.js
 *
 * Advanced editor (Spec §16): precise positioning, map scale, camera
 * metadata, panorama orientation, per-edge distances, connection editing,
 * validation, transitions and Immersion Mode (Spec §17 — visual effects
 * only; they never alter world coordinates).
 */
export class AdvancedEditor {
  constructor(app) {
    this.app = app;
    this.panel = document.getElementById('advPanel');
    this._open = false;
    this._renderShell();
    this._bindWorld();
  }

  get isOpen() { return this._open; }

  open() { this._open = true; this.panel.hidden = false; this.refresh(); }
  close() { this._open = false; this.panel.hidden = true; }

  _renderShell() {
    const sec = (id, title, open, body) =>
      `<div class="sec ${open ? 'open' : ''}" data-sec="${id}">
        <button class="sec-h" type="button"><span class="grow">${title}</span><svg class="chev"><use href="#i-chev"/></svg></button>
        <div class="sec-b">${body}</div>
      </div>`;
    this.panel.innerHTML = `
      <div class="p-head"><h3>Advanced editor</h3>
        <button class="iconbtn mini" data-act="close" aria-label="Close advanced editor"><svg><use href="#i-close"/></svg></button>
      </div>
      <div class="p-body">
        ${sec('node', 'Location (node)', true, `<div id="aeNode"><div class="hint">Select a location on the map or walk to it.</div></div>`)}

        ${sec('edges', 'Connections', true, `<div id="aeEdges"></div>`)}

        ${sec('val', 'Validation & AutoComplete', false, `
          <div id="aeValidation"><div class="hint">Run a continuity check on this location or a world health check.</div></div>
          <div class="btnrow">
            <button class="btn ghost" data-act="validateNode"><svg><use href="#i-check"/></svg>Check location</button>
            <button class="btn ghost" data-act="validateWorld"><svg><use href="#i-bug"/></svg>World health</button>
          </div>`)}

        ${sec('env', 'Environment & lighting', false, `
          <div class="frow">
            <div class="field"><label>Time of day</label>
              <select id="wsTod"><option value="day">Day</option><option value="golden">Golden hour</option><option value="dusk">Dusk</option><option value="overcast">Overcast</option></select></div>
            <div class="field"><label>Weather</label>
              <select id="wsWeather"><option value="clear">Clear</option><option value="overcast">Overcast</option><option value="rain">Rain</option></select></div>
          </div>
          <div class="frow">
            <div class="field"><label>Sun azimuth°</label><input type="number" id="wsSunAz" min="0" max="360" step="1"></div>
            <div class="field"><label>Sun elevation°</label><input type="number" id="wsSunEl" min="0" max="90" step="1"></div>
          </div>
          <div class="hint">Changes apply live and regenerate panoramas. <strong>Rain weather also turns the on-screen drizzle on</strong> — one switch, no double toggles.</div>`)}

        ${sec('imm', 'Immersion (visual only)', false, `
          <div class="switch"><div><div class="lab">Camera sway</div><div class="sub">Subtle idle motion</div></div>
            <label class="tswitch"><input type="checkbox" id="imSway"><span class="track"></span></label></div>
          <div class="field"><label>Sway intensity <span id="imSwayVal" class="suffix">0.4</span></label>
            <input type="range" id="imSwayAmt" min="0" max="1" step="0.05" value="0.4"></div>
          <div class="switch"><div><div class="lab">Breeze</div><div class="sub">Slow drift</div></div>
            <label class="tswitch"><input type="checkbox" id="imBreeze"><span class="track"></span></label></div>
          <div class="field"><label>Transition duration <span id="imTransVal" class="suffix">420 ms</span></label>
            <input type="range" id="imTrans" min="120" max="1600" step="20" value="420"></div>
          <div class="hint">Effects never move the map. Rain is not a separate switch — it follows the Weather setting above.</div>`)}

        ${sec('scale', 'World & scale', false, `
          <div class="field"><label>World name</label><input type="text" id="wsName"></div>
          <div class="frow">
            <div class="field"><label>Pixels per meter</label><input type="number" id="wsPpm" min="0.1" step="0.1"></div>
            <div class="field"><label>Step (px / move)</label><input type="number" id="wsStep" min="1" step="1"></div>
          </div>
          <div class="field"><span class="suffix" id="wsStepInfo"></span></div>
          <button class="btn ghost block" data-act="applyWorld"><svg><use href="#i-check"/></svg>Apply name & scale</button>`)}

        ${sec('data', 'Data', false, `
          <div class="btnrow">
            <button class="btn ghost" data-act="exportJson"><svg><use href="#i-save"/></svg>World JSON</button>
            <button class="btn ghost" data-act="importJson"><svg><use href="#i-open"/></svg>Import JSON</button>
          </div>`)}
      </div>`;
    this.panel.addEventListener('click', (e) => {
      const secH = e.target.closest('.sec-h');
      if (secH) { secH.parentElement.classList.toggle('open'); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'close') this.app.closePanels();
      else if (act === 'validateNode') this.validateNode();
      else if (act === 'validateWorld') this.validateWorld();
      else if (act === 'applyWorld') this._applyWorld();
      else if (act === 'exportJson') this._exportJson();
      else if (act === 'importJson') this._importJson();
      else if (act === 'setCurrent') this.app.teleport(this.app.selectedNodeId);
      else if (act === 'regenPano') { this.app.cache.lru.delete(this._nid()); this.app.reloadCurrentPanorama(true); }
    });
  }

  _bindWorld() {
    const im = this.app.viewer.immersion;
    const $ = (id) => this.panel.querySelector(id);
    $('#imSway').addEventListener('change', (e) => { im.sway = e.target.checked; this.app.persistPrefs(); });
    $('#imSwayAmt').addEventListener('input', (e) => { im.swayIntensity = +e.target.value; $('#imSwayVal').textContent = e.target.value; });
    $('#imBreeze').addEventListener('change', (e) => { im.breeze = e.target.checked; });
    $('#imTrans').addEventListener('input', (e) => {
      im.transitionMs = +e.target.value;
      this.app.graph.settings.transitionMs = im.transitionMs;
      $('#imTransVal').textContent = `${e.target.value} ms`;
    });
    // environment is LIVE (one coherent switch — Spec §17 & continuity rules)
    $('#wsTod').addEventListener('change', () => this._applyEnv());
    $('#wsWeather').addEventListener('change', () => this._applyEnv());
    $('#wsSunAz').addEventListener('change', () => this._applyEnv());
    $('#wsSunEl').addEventListener('change', () => this._applyEnv());
  }

  _applyEnv() {
    const $ = (id) => this.panel.querySelector(id);
    this.app.setEnvironment({
      timeOfDay: $('#wsTod').value,
      weather: $('#wsWeather').value,
      sunAzimuthDeg: parseFloat($('#wsSunAz').value) || this.app.graph.environment.sunAzimuthDeg,
      sunElevationDeg: parseFloat($('#wsSunEl').value) || this.app.graph.environment.sunElevationDeg,
    });
  }

  _nid() { return this.app.selectedNodeId || this.app.movement.currentNodeId; }

  refresh() {
    if (!this._open) return;
    const g = this.app.graph;
    const n = g.getNode(this._nid());
    this._renderNode(n);
    this._renderEdges(n);
    // world settings reflect current graph
    const $ = (id) => this.panel.querySelector(id);
    $('#wsName').value = g.name;
    $('#wsPpm').value = g.scale.pixelsPerMeter;
    $('#wsStep').value = g.scale.movement.stepPixels;
    $('#wsStepInfo').textContent = this._scaleInfo();
    $('#wsTod').value = g.environment.timeOfDay;
    $('#wsWeather').value = g.environment.weather;
    $('#wsSunAz').value = g.environment.sunAzimuthDeg;
    $('#wsSunEl').value = g.environment.sunElevationDeg;
    $('#imTrans').value = this.app.viewer.immersion.transitionMs;
    $('#imTransVal').textContent = `${this.app.viewer.immersion.transitionMs} ms`;
  }

  _renderNode(n) {
    const host = this.panel.querySelector('#aeNode');
    if (!n) { host.innerHTML = '<div class="hint">No location selected.</div>'; return; }
    const g = this.app.graph;
    const cam = { height: 1.7, fov: 75, pitchDeg: 0, yawDeg: 0, ...(n.camera || {}) };
    const meta = this.app.cache.metaOf(n.id);
    host.innerHTML = `
      <div class="field"><label>Name</label><input type="text" data-f="name" value="${esc(n.name)}"></div>
      <div class="frow">
        <div class="field"><label>X (px)</label><input type="number" data-f="x" value="${n.x.toFixed(1)}"></div>
        <div class="field"><label>Y (px)</label><input type="number" data-f="y" value="${n.y.toFixed(1)}"></div>
      </div>
      <div class="suffix" style="font-size:11.5px;color:var(--ink-3);margin:-4px 0 10px">
        = ${(g.scale.pxToM(n.x)).toFixed(1)} m, ${(g.scale.pxToM(n.y)).toFixed(1)} m · zone: ${n.zoneId ? g.zones.get(n.zoneId)?.name : '—'}</div>
      <div class="frow">
        <div class="field"><label>Panorama heading°</label><input type="number" data-f="headingDeg" min="0" max="360" value="${n.headingDeg ?? 0}"></div>
        <div class="field"><label>Camera height (m)</label><input type="number" data-f="cam.height" min="0.5" max="8" step="0.1" value="${cam.height}"></div>
      </div>
      <div class="frow">
        <div class="field"><label>Field of view°</label><input type="number" data-f="cam.fov" min="30" max="110" value="${cam.fov}"></div>
        <div class="field"><label>Pitch°</label><input type="number" data-f="cam.pitchDeg" min="-80" max="80" value="${cam.pitchDeg}"></div>
      </div>
      <div class="frow">
        <div class="field"><label>Missing top %</label><input type="number" data-f="inc.top" min="0" max="25" value="${n.pano?.incomplete?.top ?? 0}"></div>
        <div class="field"><label>Missing bottom %</label><input type="number" data-f="inc.bottom" min="0" max="25" value="${n.pano?.incomplete?.bottom ?? 0}"></div>
      </div>
      <div class="report">
        <div class="kv"><span>Panorama</span><span class="mono">${n.pano?.kind ?? 'generated'}${meta ? ' · seed ' + meta.seed.toString(16).slice(0, 8) : ''}</span></div>
        <div class="kv"><span>phash</span><span class="mono">${meta?.phash ? meta.phash.slice(0, 12) + '…' : '—'}</span></div>
        <div class="kv"><span>Continuity score</span><span class="${scoreCls(meta?.validation?.score)}">${fmtScore(meta?.validation?.score)}</span></div>
        <div class="kv"><span>AutoComplete</span><span>${meta?.autoComplete ? (meta.autoComplete.complete === false ? `repaired top ${meta.autoComplete.topMissingPct.toFixed(1)}% · bottom ${meta.autoComplete.bottomMissingPct.toFixed(1)}%` : 'not needed') : '—'}</span></div>
      </div>
      <div class="btnrow">
        <button class="btn ghost" data-act="setCurrent"><svg><use href="#i-play"/></svg>Preview</button>
        <button class="btn ghost" data-act="regenPano"><svg><use href="#i-image"/></svg>Regenerate view</button>
      </div>`;
    host.querySelectorAll('input').forEach(inp => inp.addEventListener('change', () => this._applyNodeField(n, inp.dataset.f, inp.value)));
  }

  _applyNodeField(n, f, raw) {
    const g = this.app.graph;
    const v = parseFloat(raw);
    if (f === 'name') n.name = raw || n.name;
    else if (f === 'x' || f === 'y') Number.isFinite(v) && g.moveNode(n.id, f === 'x' ? v : n.x, f === 'y' ? v : n.y);
    else if (f === 'headingDeg') n.headingDeg = Number.isFinite(v) ? ((v % 360) + 360) % 360 : 0;
    else if (f.startsWith('cam.')) {
      n.camera = { height: 1.7, fov: 75, pitchDeg: 0, yawDeg: 0, ...(n.camera || {}) };
      const k = f.slice(4);
      if (Number.isFinite(v)) n.camera[k] = v;
    } else if (f.startsWith('inc.')) {
      n.pano = n.pano || { kind: 'generated' };
      n.pano.incomplete = n.pano.incomplete || { top: 0, bottom: 0 };
      n.pano.incomplete[f.slice(4)] = Math.max(0, Math.min(25, v || 0));
      this.app.cache.lru.delete(n.id);
      this.app.cache.meta.delete(n.id);
    }
    this.app.notifyMapChanged();
    if (this.app.movement.currentNodeId === n.id) this.app.refreshLocationUI();
    this._renderEdges(n);
  }

  _renderEdges(n) {
    const host = this.panel.querySelector('#aeEdges');
    if (!n) { host.innerHTML = '<div class="hint">—</div>'; return; }
    const g = this.app.graph;
    const edges = g.edgesOf(n.id);
    host.innerHTML = edges.length ? '' : '<div class="hint">No connections. Use the simple editor’s Connect tool.</div>';
    for (const e of edges) {
      const o = g.getNode(g.otherEnd(e, n.id));
      const el = document.createElement('div');
      el.className = 'edgecard';
      el.innerHTML = `
        <div class="erow"><span class="nm">${esc(o?.name ?? '?')}</span>
          <span>
            <button class="minibtn ${e.blocked ? 'on' : ''}" data-b="block">${e.blocked ? 'Blocked' : 'Open'}</button>
            <button class="minibtn warn" data-b="del">Remove</button>
          </span></div>
        <div class="sub mono">${e.dirNameAB} · bearing ${(g.edgeBearing(e, n.id)).toFixed(0)}° · ${e.distM.toFixed(1)} m (${e.distPx.toFixed(0)} px)</div>`;
      el.querySelector('[data-b="block"]').addEventListener('click', () => { g.setEdgeBlocked(e.a, e.b, !e.blocked); this.app.notifyMapChanged(true); this._renderEdges(n); });
      el.querySelector('[data-b="del"]').addEventListener('click', () => { g.disconnect(e.a, e.b); this.app.notifyMapChanged(true); this._renderEdges(n); });
      host.appendChild(el);
    }
  }

  _scaleInfo() {
    const g = this.app.graph;
    const m = g.scale.stepMeters();
    return `1 move = ${g.scale.movement.stepPixels} px = ${m.toFixed(1)} m · 500 m = ${g.scale.stepsToReachBoundary(500).toFixed(0)} moves`;
  }

  async validateNode() {
    const host = this.panel.querySelector('#aeValidation');
    const nodeId = this._nid();
    const report = await this.app.runContinuityCheck(nodeId);
    host.innerHTML = `
      <div class="report">
        <div class="kv"><span>Panorama integrity</span><span class="${report.integrity ? 'ok' : 'bad'}">${report.integrity ? 'OK' : 'FAIL'}</span></div>
        <div class="kv"><span>Missing regions</span><span>${report.missingText}</span></div>
        <div class="kv"><span>vs previous node</span><span class="${report.simToPrev != null && report.simToPrev >= 0.35 ? 'ok' : ''}">${report.simToPrev == null ? 'n/a' : report.simToPrev.toFixed(2)}</span></div>
        <div class="kv"><span>Distance-aware expectation</span><span>${report.expectText}</span></div>
        <div class="kv"><span>Continuity score</span><span class="${scoreCls(report.score)}">${fmtScore(report.score)}</span></div>
      </div>`;
    this.refresh();
  }

  validateWorld() {
    const host = this.panel.querySelector('#aeValidation');
    const issues = this.app.graph.healthCheck();
    const orphan = [...this.app.graph.nodes.values()].filter(n => this.app.graph.edgesOf(n.id).length === 0).length;
    host.innerHTML = `
      <div class="report">
        <div class="kv"><span>Reference integrity</span><span class="${issues.length ? 'bad' : 'ok'}">${issues.length ? issues.length + ' issue(s)' : 'OK'}</span></div>
        ${issues.slice(0, 6).map(i => `<div class="kv"><span class="bad">${esc(i)}</span></div>`).join('')}
        <div class="kv"><span>Isolated locations</span><span class="${orphan ? 'bad' : 'ok'}">${orphan}</span></div>
        <div class="kv"><span>Nodes / edges</span><span class="mono">${this.app.graph.nodes.size} / ${this.app.graph.edges.size}</span></div>
        <div class="kv"><span>Decoded panoramas</span><span class="mono">${this.app.cache.decodedCount} (LRU cap ${this.app.cache.capacity})</span></div>
      </div>`;
  }

  _applyWorld() {
    const $ = (id) => this.panel.querySelector(id);
    const g = this.app.graph;
    g.name = $('#wsName').value.trim() || g.name;
    const ppm = parseFloat($('#wsPpm').value);
    if (Number.isFinite(ppm) && ppm > 0) g.scale.pixelsPerMeter = ppm;
    const step = parseInt($('#wsStep').value, 10);
    if (Number.isFinite(step) && step > 0) g.scale.movement.stepPixels = step;
    this.app.notifyMapChanged(true, true);
    this.app.toast('Name & scale applied', 'ok');
  }

  _exportJson() {
    const blob = new Blob([JSON.stringify(this.app.graph.toJSON(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = this.app.graph.name.replace(/\W+/g, '-').toLowerCase() + '.world.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  _importJson() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = async () => {
      if (!input.files[0]) return;
      try {
        const json = JSON.parse(await input.files[0].text());
        this.app.loadWorldJson(json, { name: json.name });
      } catch (err) { this.app.toast('Import failed: ' + err.message, 'err'); }
    };
    input.click();
  }
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function fmtScore(s) { return s == null ? '—' : s.toFixed(2); }
function scoreCls(s) { return s == null ? '' : s >= 0.78 ? 'ok' : 'bad'; }
