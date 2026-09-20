/**
 * Panorama Maps — editors/simple-editor.js
 *
 * Beginner-friendly map editor (Spec §15). One clean toolbar; the map
 * canvas is the working surface. No panels-within-panels.
 *
 * Tools: Select · Add location · Connect · Landmark · Road · Delete
 * Actions: Upload panorama · Upload map image · Save
 */
const TOOL_HINTS = {
  select: 'Click a location to select it. Drag empty space to pan the map.',
  'add-node': 'Click anywhere on the map to place a new panorama location.',
  connect: 'Click the first location, then the second, to connect them.',
  landmark: 'Click on the map to drop a landmark (church, tree, tower…).',
  road: 'Click to add road points. Double-click (or press Enter) to finish the road.',
  delete: 'Click a location, landmark, or connection to delete it.',
};

export class SimpleEditor {
  /**
   * @param {object} app  application context (see main.js)
   */
  constructor(app) {
    this.app = app;
    this.panel = document.getElementById('editorPanel');
    this.tool = 'select';
    this.connectFrom = null;
    this.roadPoints = [];
    this._open = false;
    this._renderShell();
  }

  get isOpen() { return this._open; }

  open() {
    this._open = true;
    this.panel.hidden = false;
    this.app.mapRenderer.onCanvasClick = (w, e) => this._mapClick(w, e);
    this._refreshSelection();
  }

  close() {
    this._open = false;
    this.panel.hidden = true;
    this.connectFrom = null;
    this.roadPoints = [];
    this.app.mapRenderer.onCanvasClick = null;
    this.app.mapRenderer.setHighlight([]);
  }

  _renderShell() {
    this.panel.innerHTML = `
      <div class="p-head"><h3>Map editor</h3>
        <button class="iconbtn" data-act="close" aria-label="Close editor"><svg><use href="#i-close"/></svg></button>
      </div>
      <div class="p-body">
        <div class="toolbar" role="toolbar" aria-label="Editor tools">
          <button class="tool active" data-tool="select"><svg><use href="#i-pin"/></svg><span>Select</span></button>
          <button class="tool" data-tool="add-node"><svg><use href="#i-plus"/></svg><span>Location</span></button>
          <button class="tool" data-tool="connect"><svg><use href="#i-link"/></svg><span>Connect</span></button>
          <button class="tool" data-tool="landmark"><svg><use href="#i-flag"/></svg><span>Landmark</span></button>
          <button class="tool" data-tool="road"><svg><use href="#i-route"/></svg><span>Road</span></button>
          <button class="tool" data-tool="delete"><svg><use href="#i-trash"/></svg><span>Delete</span></button>
        </div>
        <div class="hint" id="edHint">${TOOL_HINTS.select}</div>
        <div id="edSelection"></div>
        <div class="stitle">Images</div>
        <button class="btn ghost block" data-act="uploadPano"><svg><use href="#i-image"/></svg>Upload panorama for selected</button>
        <button class="btn ghost block" data-act="uploadMap"><svg><use href="#i-map"/></svg>Upload custom 2D map image</button>
        <div class="divider"></div>
        <button class="btn block" data-act="save"><svg><use href="#i-save"/></svg>Save project</button>
      </div>`;
    this.panel.addEventListener('click', (e) => this._click(e));
  }

  _click(e) {
    const toolBtn = e.target.closest('[data-tool]');
    if (toolBtn) {
      this.tool = toolBtn.dataset.tool;
      this.panel.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b === toolBtn));
      this.panel.querySelector('#edHint').textContent = TOOL_HINTS[this.tool];
      this.connectFrom = null;
      this.roadPoints = [];
      this.app.mapRenderer.setHighlight([]);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') this.app.closePanels();
    else if (act === 'uploadPano') this.app.uploadPanoramaForNode(this.app.selectedNodeId || this.app.movement.currentNodeId);
    else if (act === 'uploadMap') this.app.uploadMapUnderlay();
    else if (act === 'save') this.app.saveProject(true);
  }

  async _mapClick(w, e) {
    const { graph, mapRenderer } = this.app;
    const pickR = 20 / mapRenderer.cam.scale;
    const node = graph.nearestNode(w.x, w.y, pickR);

    switch (this.tool) {
      case 'select':
        this.app.selectNode(node?.id ?? null);
        this._refreshSelection();
        break;

      case 'add-node': {
        const id = 'node_' + Date.now().toString(36) + '_' + Math.floor(w.x) + '_' + Math.floor(w.y);
        const n = graph.addNode({ id, x: w.x, y: w.y, name: `Location ${graph.nodes.size + 1}`, pano: { kind: 'generated' } });
        // auto-connect to a close neighbour for convenience (max 25 m)
        const near = graph.nearestNode(w.x, w.y, Math.min(25 * graph.scale.pixelsPerMeter, Infinity));
        if (near && near.id !== id && distance(near, w) <= 25 * graph.scale.pixelsPerMeter) graph.connect(id, near.id);
        this.app.notifyMapChanged();
        this.app.selectNode(id);
        this._refreshSelection();
        this.app.toast(`Added ${n.name}`, 'ok');
        break;
      }

      case 'connect': {
        if (!node) { this.app.toast('Click a location first'); return; }
        if (!this.connectFrom) {
          this.connectFrom = node.id;
          mapRenderer.setHighlight([node.id]);
          this.panel.querySelector('#edHint').textContent = `From “${node.name}” — now click the second location.`;
        } else if (this.connectFrom !== node.id) {
          try {
            const edge = graph.connect(this.connectFrom, node.id);
            this.app.toast(`Connected (${edge.distM.toFixed(1)} m)`, 'ok');
          } catch { this.app.toast('Already connected'); }
          this.connectFrom = null;
          mapRenderer.setHighlight([]);
          this.panel.querySelector('#edHint').textContent = TOOL_HINTS.connect;
          this.app.notifyMapChanged();
        }
        break;
      }

      case 'landmark': {
        const name = prompt('Landmark name:', 'Landmark');
        if (!name) return;
        const type = prompt('Type (church / tower / tree / water / square):', 'square') || 'square';
        const lm = graph.addLandmark({ id: 'lm_' + Date.now().toString(36), type, name, x: w.x, y: w.y, importance: 0.6 });
        // landmarks also appear in the panorama world as features where visual kinds apply
        if (['tree'].includes(type)) graph.environment.features.push({ id: lm.id + '_f', type: 'tree', x: w.x, y: w.y, hM: 8, rM: 2.2 });
        if (['tower'].includes(type)) graph.environment.features.push({ id: lm.id + '_f', type: 'tower', x: w.x, y: w.y, hM: 18 });
        this.app.notifyMapChanged(true);
        this.app.toast(`Landmark “${name}” added`, 'ok');
        break;
      }

      case 'road': {
        if (this.roadPoints.length && this.roadPoints.length > 1) {
          const last = this.roadPoints[this.roadPoints.length - 1];
          if (Math.hypot(last[0] - w.x, last[1] - w.y) < pickR * 1.5) return this._finishRoad();
        }
        this.roadPoints.push([w.x, w.y]);
        this.panel.querySelector('#edHint').textContent = `Road: ${this.roadPoints.length} point(s) — double-click last point or press Enter to finish.`;
        this.app.previewRoad(this.roadPoints);
        if (e.detail === 2) this._finishRoad();
        break;
      }

      case 'delete': {
        if (node) {
          if (confirm(`Delete location “${node.name}” and its connections?`)) {
            graph.removeNode(node.id);
            if (this.app.movement.currentNodeId === node.id) {
              const anyNode = graph.nodes.keys().next().value;
              if (anyNode) this.app.teleport(anyNode);
            }
            this.app.notifyMapChanged(true);
            this.app.selectNode(null);
            this._refreshSelection();
          }
          return;
        }
        // nearest landmark?
        let best = null, bd = pickR;
        for (const lm of graph.landmarks.values()) {
          const d = Math.hypot(lm.x - w.x, lm.y - w.y);
          if (d < bd) { bd = d; best = lm; }
        }
        if (best && confirm(`Delete landmark “${best.name}”?`)) {
          graph.removeLandmark(best.id);
          this.app.notifyMapChanged(true);
          return;
        }
        // nearest edge midpoint?
        let eBest = null, eBd = pickR;
        for (const e0 of graph.edges.values()) {
          const a = graph.getNode(e0.a), b = graph.getNode(e0.b);
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const d = Math.hypot(mx - w.x, my - w.y);
          if (d < eBd) { eBd = d; eBest = e0; }
        }
        if (eBest && confirm('Delete this connection?')) {
          graph.disconnect(eBest.a, eBest.b);
          this.app.notifyMapChanged();
        }
        break;
      }
    }
  }

  _finishRoad() {
    if (this.roadPoints.length < 2) { this.roadPoints = []; return; }
    const name = prompt('Road name:', 'New Road') || 'New Road';
    this.app.graph.environment.features.push({
      id: 'road_user_' + Date.now().toString(36), type: 'road', name,
      points: this.roadPoints, widthM: 5, surface: 'asphalt',
    });
    this.roadPoints = [];
    this.app.previewRoad(null);
    this.app.notifyMapChanged(true);
    this.panel.querySelector('#edHint').textContent = TOOL_HINTS.road;
    this.app.toast(`Road “${name}” added`, 'ok');
  }

  onEnterKey() { if (this.tool === 'road') this._finishRoad(); }

  _refreshSelection() {
    const host = this.panel.querySelector('#edSelection');
    if (!host) return;
    const n = this.app.selectedNodeId ? this.app.graph.getNode(this.app.selectedNodeId) : null;
    if (!n) { host.innerHTML = ''; return; }
    host.innerHTML = `
      <div class="stitle">Selected location</div>
      <div class="field"><label>Name</label><input type="text" id="edNodeName" value="${escapeAttr(n.name)}"></div>
      <div class="frow">
        <button class="btn ghost" data-act="gotoNode"><svg><use href="#i-play"/></svg>Preview</button>
        <button class="btn ghost" data-act="startHere"><svg><use href="#i-pin"/></svg>Start here</button>
      </div>`;
    host.querySelector('#edNodeName').addEventListener('change', (ev) => {
      n.name = ev.target.value.trim() || n.name;
      this.app.notifyMapChanged();
      this._refreshSelection();
    });
    host.querySelector('[data-act="gotoNode"]').addEventListener('click', () => this.app.teleport(n.id));
    host.querySelector('[data-act="startHere"]').addEventListener('click', () => this.app.teleport(n.id));
  }
}

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
