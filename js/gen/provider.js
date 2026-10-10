/**
 * Panorama Maps — gen/provider.js
 *
 * GenerationProvider interface + ProceduralWorldProvider (development fallback,
 * clearly labeled) + RemoteGenerationProvider stub (Spec §21 code quality).
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ CONTINUITY MODEL (Spec §7, §16, §19)                                 │
 * │ The procedural provider never invents a scene. It renders the SAME    │
 * │ world model (roads, church, houses, trees, lighting) from the exact   │
 * │ node coordinate. Neighboring nodes therefore depict one continuous    │
 * │ environment BY CONSTRUCTION — the church stays the church, growing    │
 * │ as you approach it. A real AI image API plugs into the same          │
 * │ interface and must pass the same validation gate.                    │
 * └──────────────────────────────────────────────────────────────────────┘
 */
import { hashStr, rngFor, luminanceGrid16, aHash16 } from './util.js';

const DEG = Math.PI / 180;

/* Small deterministic integer hash for world-noise (no Math.random anywhere). */
function cellHash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise over continuous world coords: bilinear-blended
    cellHash — organic streaks that never grid-lock. 0..1 */
function vnoise(x, y, cell, seed) {
  const gx = x / cell, gy = y / cell;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const fx = gx - ix, fy = gy - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = cellHash(ix, iy, seed), b = cellHash(ix + 1, iy, seed);
  const c = cellHash(ix, iy + 1, seed), d = cellHash(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function hex(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function css(c) { return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; }

const SKY_PRESETS = {
  day:    { top: '#4f8bd0', horizon: '#d7e5ee', sun: '#fff4d6', groundFog: '#cfdbe4' },
  golden: { top: '#6f7ab8', horizon: '#f0c99a', sun: '#ffdf9e', groundFog: '#e3c9ab' },
  dusk:   { top: '#3d4470', horizon: '#c98a6d', sun: '#ffb98a', groundFog: '#a88f88' },
  overcast: { top: '#8b98a3', horizon: '#c8ced2', sun: '#e8ecee', groundFog: '#c2c9cd' },
  night:  { top: '#0b1026', horizon: '#22304d', sun: '#e8ecff', groundFog: '#171f31' },
};
const ROAD_COLORS = { asphalt: [74, 77, 82], stone: [146, 140, 128], dirt: [139, 119, 92] };
const SNOW_C = [236, 242, 249];        // fresh snowpack under an overcast sky

export class GenerationProvider {
  /** @returns {Promise<{canvas:CanvasImageSource, meta:object}>} */
  async generate(/* node, context, opts */) { throw new Error('GenerationProvider.generate not implemented'); }
}

/**
 * Renders equirectangular panoramas of the world model via an environment
 * simulation: ground-plane ray-marching + identity-stable billboards.
 */
export class ProceduralWorldProvider extends GenerationProvider {
  constructor({ width = 2048, height = 1024, cullRadiusM = 420 } = {}) {
    super();
    this.W = width; this.H = height; this.cullRadiusM = cullRadiusM;
    this.id = 'procedural-world';
  }

  async generate(node, context, opts = {}) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const world = opts.world;               // serialized world slice from app
    const scale = opts.scale;               // MapScale
    const ppm = scale.pixelsPerMeter;
    const W = this.W, H = this.H;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const env = world.environment;
    // clone the preset — weather must never mutate SKY_PRESETS, or the next
    // regeneration (mode flip) would inherit stale overcast colors
    const sky = { ...(SKY_PRESETS[env.timeOfDay] || SKY_PRESETS.day) };
    if (['overcast', 'rain', 'snow', 'storm'].includes(env.weather)) Object.assign(sky, SKY_PRESETS.overcast);
    const weatherFog = env.weather === 'rain' ? 0.75 : env.weather === 'storm' ? 0.9 : env.weather === 'snow' ? 0.85 : env.weather === 'overcast' ? 0.6 : 0.5;
    this._envNow = env;                     // painters read sun/shadow/window state from here

    this._paintSky(ctx, W, H, sky, env);
    this._paintGround(ctx, canvas, node, world, ppm, sky, weatherFog, opts.groundResolution ?? 1);
    this._paintStructures(ctx, node, world, ppm, sky, weatherFog);
    this._paintSun(ctx, W, H, sky, env);
    this._paintGodRays(ctx, W, H, sky, env);

    // Simulated incomplete panorama for AutoComplete testing (explicitly authored)
    const inc = node.pano?.incomplete;
    if (inc && (inc.top > 0 || inc.bottom > 0)) {
      ctx.fillStyle = '#000';
      if (inc.top > 0) ctx.fillRect(0, 0, W, Math.round(H * inc.top / 100));
      if (inc.bottom > 0) ctx.fillRect(0, H - Math.round(H * inc.bottom / 100), W, Math.round(H * inc.bottom / 100));
    }

    // identity metadata
    const full = ctx.getImageData(0, 0, W, H);
    const seed = hashStr(`${world.id}|${node.id}`);
    const meta = {
      nodeId: node.id,
      provider: this.id,
      promptVersion: context.promptVersion,
      seed,
      worldId: world.id,
      coordinate: { x: node.x, y: node.y },
      contextSummary: `${context.movement ? `moved ${context.movement.distanceMeters?.toFixed(1)}m` : 'initial'} @ ${targetZoneName(context)}`,
      phash: aHash16(luminanceGrid16(full.data, W, H)),
      incomplete: inc || null,
      generatedAt: new Date().toISOString(),
      generationAttempt: (opts.priorMeta?.generationAttempt ?? 0) + 1,
      generationConfidence: 1.0,
      renderMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
    };
    return { canvas, meta };
  }

  /* ----------------------- sky ----------------------- */
  _paintSky(ctx, W, H, sky, env) {
    if (env.kind === 'indoor') {
      ctx.fillStyle = env.timeOfDay === 'night' ? '#181a20' : '#f0ece4';
      ctx.fillRect(0, 0, W, H / 2 + 1);
      // Soft ambient warm ceiling spotlights
      for (let i = 0; i < 6; i++) {
        const lx = (i / 6 + 0.08) * W, ly = H * 0.24;
        const grad = ctx.createRadialGradient(lx, ly, 2, lx, ly, 55);
        grad.addColorStop(0, 'rgba(255, 235, 180, 0.45)');
        grad.addColorStop(1, 'rgba(255, 235, 180, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(lx, ly, 55, 0, Math.PI * 2); ctx.fill();
      }
      return;
    }
    const g = ctx.createLinearGradient(0, 0, 0, H / 2);
    g.addColorStop(0, sky.top);
    g.addColorStop(1, sky.horizon);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H / 2 + 1);
    // deterministic cloud bands (seeded by world env, not node)
    const rng = rngFor(env.description || 'clouds');
    ctx.save();
    ctx.globalAlpha = env.weather === 'overcast' || env.weather === 'rain' ? 0.5 : 0.22;
    for (let i = 0; i < 8; i++) {
      const x = rng() * W, y = rng() * H * 0.34, w = 200 + rng() * 480, h = 14 + rng() * 30;
      const cg = ctx.createRadialGradient(x, y, 2, x, y, w / 2);
      cg.addColorStop(0, 'rgba(255,255,255,0.85)');
      cg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.ellipse(x, y, w / 2, h, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /* ----------------------- ground ray-march ----------------------- */
  _paintGround(ctx, canvas, node, world, ppm, sky, weatherFog, resolution) {
    const W = this.W, H = this.H;
    const gw = Math.round(W * 0.5 * resolution), gh = Math.round(H * 0.5 * resolution);
    const img = ctx.createImageData(gw, gh);
    const data = img.data;
    const horizonFog = mix(hex(sky.horizon), hex(sky.groundFog), 0.5);

    const camH = 1.7;               // viewing height, meters (camera metadata)
    const maxD = 140;               // meters of meaningful ground detail; beyond → fog
    const seedG = hashStr(world.id + '|ground');

    // Precompute per-row ground distance and per-column bearing sin/cos.
    const rowDist = new Float32Array(gh);
    for (let j = 0; j < gh; j++) {
      const pitch = ((j + 0.5) / gh) * 90 * DEG;           // 0..90 below horizon
      rowDist[j] = Math.min(maxD, camH / Math.tan(Math.max(pitch, 0.35 * DEG)));
    }
    const colSin = new Float32Array(gw), colCos = new Float32Array(gw), colB = new Float32Array(gw);
    for (let i = 0; i < gw; i++) {
      const b = ((i + 0.5) / gw * 360 - 180) * DEG;
      colSin[i] = Math.sin(b); colCos[i] = Math.cos(b); colB[i] = b;
    }

    const ground = this._groundSampler(world, ppm);
    const env = world.environment;
    const sunAz = ((env.sunAzimuthDeg % 360) + 360) % 360 * DEG;
    const glintC = env.timeOfDay === 'night' ? [214, 224, 250] : [255, 244, 214];
    const canGlint = env.weather === 'clear';
    for (let j = 0; j < gh; j++) {
      const dM = rowDist[j];
      const dPx = dM * ppm;
      const fogT = Math.max(0, Math.min(1, (dM - 28) / 95)) * weatherFog;
      for (let i = 0; i < gw; i++) {
        const wx = node.x + colSin[i] * dPx;
        const wy = node.y - colCos[i] * dPx;
        let c = ground.at(wx, wy, seedG);
        // snowpack: open water stays dark & glassy, everything else drifts white
        if (env.weather === 'snow') c = mix(c, SNOW_C, ground.groundKind() === 'water' ? 0.16 : 0.78);
        // sun path sparkle across open water — specular streak toward the sun
        // azimuth (the "ray-traced" tell: it shifts believably as you turn)
        if (canGlint && ground.groundKind() === 'water') {
          const rel = Math.cos(colB[i] - sunAz);
          if (rel > 0) c = mix(c, glintC, Math.pow(rel, 26) * (env.timeOfDay === 'night' ? 0.4 : 0.55));
        }
        if (fogT > 0) c = mix(c, horizonFog, fogT);
        const o = (j * gw + i) * 4;
        data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
      }
    }
    // Blit into the lower half.
    const tmp = document.createElement('canvas');
    tmp.width = gw; tmp.height = gh;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, H / 2, W, H / 2);
  }

  /** World-anchored ground color sampler: grass noise → regions → roads. */
  _groundSampler(world, ppm) {
    const base = hex(world.environment.groundBase || '#7d9b6a');
    const regions = (world.environment.features || []).filter(f => f.type === 'region');
    const roads = (world.environment.features || []).filter(f => f.type === 'road');
    // coarse spatial bucket of road segments and regions
    const CELL = 32 * ppm;
    const grid = new Map();
    const key = (ix, iy) => ix + ':' + iy;
    const addTo = (x, y, item) => {
      const k = key(Math.floor(x / CELL), Math.floor(y / CELL));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(item);
    };
    for (const r of roads) {
      for (let s = 0; s < r.points.length - 1; s++) {
        const [x1, y1] = r.points[s], [x2, y2] = r.points[s + 1];
        const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / CELL);
        for (let t = 0; t <= steps; t++) addTo(x1 + (x2 - x1) * t / steps, y1 + (y2 - y1) * t / steps, { f: r, s });
      }
    }
    for (const rg of regions) {
      const pts = rg.shape === 'rect' ? [[rg.x, rg.y], [rg.x + rg.w, rg.y + rg.h]] : rg.points;
      if (rg.shape === 'rect') {
        for (let x = rg.x; x <= rg.x + rg.w; x += CELL) for (let y = rg.y; y <= rg.y + rg.h; y += CELL) addTo(x, y, { f: rg });
      } else if (rg.shape === 'circle') {
        for (let a = 0; a < 12; a++) addTo(rg.cx + Math.cos(a / 12 * 6.28) * rg.radiusPx, rg.cy + Math.sin(a / 12 * 6.28) * rg.radiusPx, { f: rg });
        addTo(rg.cx, rg.cy, { f: rg });
      } else void pts;
    }

    const noise = (wx, wy, s) => cellHash(Math.floor(wx / (2 * ppm)), Math.floor(wy / (2 * ppm)), s);
    const vary = (c, n, amt) => [c[0] + (n - 0.5) * amt, c[1] + (n - 0.5) * amt, c[2] + (n - 0.5) * amt * 0.7];
    const lastKind = { v: null };

    const distToSeg = (px, py, x1, y1, x2, y2) => {
      const dx = x2 - x1, dy = y2 - y1;
      const L2 = dx * dx + dy * dy;
      let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = x1 + t * dx, qy = y1 + t * dy;
      return { d: Math.hypot(px - qx, py - qy), t, len: Math.sqrt(L2) };
    };

    return {
      groundKind: () => lastKind.v,
      at: (wx, wy, seed) => {
        lastKind.v = null;
        let c = vary(base, noise(wx, wy, seed), 26);   // world-anchored grass/ground variation
        const k = key(Math.floor(wx / CELL), Math.floor(wy / CELL));
        const near = [
          ...(grid.get(k) || []),
          ...(grid.get(key(Math.floor(wx / CELL) + 1, Math.floor(wy / CELL))) || []),
          ...(grid.get(key(Math.floor(wx / CELL) - 1, Math.floor(wy / CELL))) || []),
          ...(grid.get(key(Math.floor(wx / CELL), Math.floor(wy / CELL) + 1)) || []),
          ...(grid.get(key(Math.floor(wx / CELL), Math.floor(wy / CELL) - 1)) || []),
        ];
        let roadBest = null;
        for (const item of near) {
          const f = item.f;
          if (f.type === 'region') {
            let inside = false;
            if (f.shape === 'rect') inside = wx >= f.x && wx <= f.x + f.w && wy >= f.y && wy <= f.y + f.h;
            else if (f.shape === 'circle') inside = Math.hypot(wx - f.cx, wy - f.cy) <= f.radiusPx;
            else if (f.shape === 'poly') {
              const p = f.points; let ins = false;
              for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
                const [xi, yi] = p[i], [xj2, yj2] = p[j];
                if (((yi > wy) !== (yj2 > wy)) && (wx < (xj2 - xi) * (wy - yi) / (yj2 - yi) + xi)) ins = !ins;
              }
              inside = ins;
            }
            if (inside) {
              lastKind.v = f.kind;
              if (f.kind === 'plaza') c = vary([168, 162, 150], noise(wx, wy, seed + 7), 14);
              else if (f.kind === 'water') c = mix([58, 96, 130], [72, 112, 146], noise(wx, wy, seed + 11));
              else if (f.kind === 'field') c = vary([129, 148, 82], noise(wx, wy, seed + 13), 34);
            }
          } else if (f.type === 'road') {
            if (roadBest && roadBest.f === f && item.s !== roadBest.s) continue;
            const [x1, y1] = f.points[item.s], [x2, y2] = f.points[item.s + 1];
            const r = distToSeg(wx, wy, x1, y1, x2, y2);
            const hw = (f.widthM / 2) * ppm;
            if (r.d <= hw + 1.2 * ppm) {           // realistic 1.2 m sidewalk margin
              if (!roadBest || r.d < roadBest.d) roadBest = { f, d: r.d, t: r.t, len: r.len, s: item.s, hw };
            }
          }
        }
        if (roadBest) {
          const { f, d, t, len, hw } = roadBest;
          const surface = ROAD_COLORS[f.surface || 'asphalt'];
          const snowy = world.environment?.weather === 'snow';
          if (d <= hw) {
            c = vary(surface, noise(wx, wy, seed + 3), 12);
            if (f.surface === 'stone') c = mix(c, [170, 164, 150], noise(wx, wy, seed + 5) * 0.4);
            // realism decals (world-space value noise — stable, never slides):
            // hairline cracks meander across the asphalt, oil & wear stain
            // the busiest lane, tyres polish two darker tracks at ±0.8 m
            if (f.surface !== 'dirt' && !snowy) {
              const ridge = Math.abs(vnoise(wx, wy, 3.2 * ppm, seed + 401) * 2 - 1);
              const vein = vnoise(wx, wy, 9 * ppm, seed + 402);
              if (ridge < 0.05 && vein > 0.42) c = mix(c, [36, 38, 44], 0.55);            // crack
              const stain = vnoise(wx, wy, 6 * ppm, seed + 403);
              if (stain > 0.72) c = mix(c, [30, 32, 38], Math.min(0.34, (stain - 0.72) * 1.5));  // oil patch
              if (f.surface === 'asphalt' && d > 0.55 * ppm && d < 1.05 * ppm) {
                const band = Math.exp(-Math.pow((d - 0.8 * ppm) / (0.22 * ppm), 2));
                c = mix(c, [54, 56, 60], band * 0.12);                                  // tyre polish
              }
            }
            // worn centre line (14 cm wide, dashed)
            if ((f.widthM >= 4) && d < 0.07 * ppm && ((t * len / ppm) % 9) < 4.5) c = snowy ? mix([188, 176, 130], SNOW_C, 0.7) : [188, 176, 130];
          } else {
            // sidewalk band
            c = vary([152, 150, 144], noise(wx, wy, seed + 17), 10);
          }
        }
        return c;
      },
    };
  }

  /* ----------------------- structures (identity-stable billboards) -------- */
  _paintStructures(ctx, node, world, ppm, sky, weatherFog) {
    const W = this.W, H = this.H;
    const camH = 1.7;
    const feats = (world.environment.features || []).filter(f => ['building', 'tree', 'car', 'sign', 'tower', 'sheep', 'hedge', 'fence', 'bench', 'bush', 'flowers', 'furniture'].includes(f.type));
    const items = [];
    for (const f of feats) {
      const dx = (f.x - node.x) / ppm, dy = (node.y - f.y) / ppm;
      const dist = Math.hypot(dx, dy);
      if (dist > this.cullRadiusM || dist < 0.8) continue;
      items.push({ f, dx, dy, dist });
    }
    items.sort((a, b) => b.dist - a.dist);   // far → near painter order
    const fogC = hex(sky.groundFog);

    const drawWrapped = (fn, xCx) => {
      for (const off of [-W, 0, W]) {
        const x = xCx + off;
        if (x > -W * 0.3 && x < W * 1.3) fn(x);
      }
    };

    for (const { f, dx, dy, dist } of items) {
      const bearing = Math.atan2(dx, dy);         // rad, 0 = north
      const xC = ((bearing / Math.PI + 1) / 2) * W;
      const radiusM = f.type === 'building' ? Math.max(f.w, f.d) / ppm / 2
        : f.type === 'car' ? (f.rM ?? 1.1)
        : f.type === 'sheep' ? (f.rM ?? 0.7)
        : f.type === 'hedge' || f.type === 'fence' ? (f.halfLenM ?? 3)
        : (f.rM ?? 1.6);
      // true angular size; floor at ~1.5 screen px so far things stay SMALL
      // (the old 0.35 rad minimum fused every far object into a wall)
      const halfWpx = Math.max(1.5, ((radiusM / dist) / (2 * Math.PI)) * W);
      const fogT = Math.min(0.75, Math.max(0, (dist - 130) / 300) * weatherFog);
      const topYFor = (hM, dM) => (0.5 - (Math.atan((hM - camH) / dM) / Math.PI)) * H;
      const botY = (0.5 - (Math.atan(-camH / dist) / Math.PI)) * H;

      // approximate height per type — feeds top-Y AND the shadow length
      const hM = f.type === 'building' ? f.h
        : f.type === 'tree' ? (f.hM ?? 7)
        : f.type === 'tower' ? (f.hM ?? 20)
        : f.type === 'sign' ? 3
        : f.type === 'sheep' ? 0.85
        : f.type === 'flowers' ? 0.35
        : f.type === 'furniture' ? (f.kind === 'stairs' ? 2.8 : f.kind === 'window' ? 2.6 : 1.2)
        : (f.hM ?? 1.2);

      drawWrapped((x) => {
        this._castShadow(ctx, x, botY, halfWpx, radiusM, hM, bearing, dist, fogT);
        if (f.type === 'building') this._drawBuilding(ctx, f, x, halfWpx, topYFor(f.h, Math.max(1.5, dist)), botY, fogT, fogC, dist);
        else if (f.type === 'tree') this._drawTree(ctx, f, x, halfWpx, topYFor(f.hM ?? 7, dist), botY, fogT, fogC);
        else if (f.type === 'car') this._drawCar(ctx, f, x, halfWpx, topYFor(1.5, dist), botY, fogT, fogC, dist);
        else if (f.type === 'sign') this._drawSign(ctx, f, x, halfWpx, topYFor(3, dist), botY, fogT, fogC);
        else if (f.type === 'tower') this._drawTower(ctx, f, x, halfWpx, topYFor(f.hM ?? 20, dist), botY, fogT, fogC);
        else if (f.type === 'sheep') this._drawSheep(ctx, f, x, halfWpx, topYFor(0.85, dist), botY, fogT, fogC, dist);
        else if (f.type === 'hedge') this._drawHedge(ctx, f, x, halfWpx, topYFor(f.hM ?? 1.1, dist), botY, fogT, fogC, dist);
        else if (f.type === 'fence') this._drawFence(ctx, f, x, halfWpx, topYFor(f.hM ?? 1.0, dist), botY, fogT, fogC, dist);
        else if (f.type === 'bench') this._drawBench(ctx, f, x, halfWpx, topYFor(f.hM ?? 0.9, dist), botY, fogT, fogC, dist);
        else if (f.type === 'bush') this._drawBush(ctx, f, x, halfWpx, topYFor(f.hM ?? 1.6, dist), botY, fogT, fogC, dist);
        else if (f.type === 'flowers') this._drawFlowers(ctx, f, x, halfWpx, topYFor(0.35, dist), botY, fogT, fogC, dist);
        else if (f.type === 'furniture') this._drawFurniture(ctx, f, x, halfWpx, topYFor(hM, dist), botY, fogT, fogC, dist);
      }, xC);
    }
  }

  _shade(base, fogT, fogC) { return css(mix(base, fogC, fogT)); }

  _drawBuilding(ctx, f, xC, halfW, topY, botY, fogT, fogC, dist) {
    const rng = rngFor(f.id);
    const wallBase = f.color ? hex(f.color) : mix([222, 214, 196], [188, 154, 122], rng());
    const wall = this._shade(wallBase, fogT, fogC);
    const w = halfW * 2, h = botY - topY;
    const x = xC - halfW;

    ctx.fillStyle = wall;
    ctx.fillRect(x, topY, w, h);

    // side shading (east face darker) for subtle volume
    ctx.fillStyle = this._shade(mix(wallBase, [60, 54, 50], 0.22), fogT, fogC);
    ctx.fillRect(x + w * 0.8, topY, w * 0.2, h);

    if (f.kind === 'church') {
      // gable roof
      const roofH = Math.min(h * 0.5, w * 0.34);
      ctx.fillStyle = this._shade(mix([84, 64, 58], wallBase, 0.2), fogT, fogC);
      ctx.beginPath(); ctx.moveTo(x, topY); ctx.lineTo(xC, topY - roofH); ctx.lineTo(x + w, topY); ctx.closePath(); ctx.fill();
      // arched door
      const dw = w * 0.22, dh = Math.min(h * 0.5, dw * 2.1);
      ctx.fillStyle = this._shade([70, 52, 40], fogT, fogC);
      ctx.beginPath();
      ctx.ellipse(xC, botY - dh, dw / 2, dw / 2, Math.PI, 0, Math.PI);
      ctx.rect(xC - dw / 2, botY - dh, dw * 1.0, dh);
      ctx.fill();
      // rose window
      ctx.strokeStyle = this._shade([236, 230, 214], fogT, fogC);
      ctx.lineWidth = Math.max(1.5, w * 0.012);
      ctx.beginPath(); ctx.arc(xC, topY + h * 0.18, Math.min(w, h) * 0.09, 0, Math.PI * 2); ctx.stroke();
    } else {
      // pitched roof for houses, flat parapet for shops
      if (f.kind === 'house') {
        const roofH = Math.min(h * 0.42, w * 0.3);
        ctx.fillStyle = this._shade(mix([128, 74, 62], [96, 62, 58], rng()), fogT, fogC);
        ctx.beginPath(); ctx.moveTo(x - w * 0.04, topY); ctx.lineTo(xC, topY - roofH); ctx.lineTo(x + w * 1.04, topY); ctx.closePath(); ctx.fill();
      } else {
        ctx.fillStyle = this._shade([86, 88, 94], fogT, fogC);
        ctx.fillRect(x - w * 0.02, topY - h * 0.06, w * 1.04, h * 0.1);
        // shop sign band
        ctx.fillStyle = this._shade(mix([64, 96, 130], [150, 96, 64], rng() * 0.6), fogT, fogC);
        ctx.fillRect(x, topY + h * 0.12, w, h * 0.14);
      }
      if (dist < 260) {
        // windows grid (identity-stable layout)
        const cols = Math.max(2, Math.min(5, Math.round(w / Math.max(18, h * 0.28))));
        const rows = Math.max(1, Math.min(3, Math.round(h / Math.max(26, h * 0.3))));
        const ww = w * 0.62 / cols, wh = h * 0.5 / rows;
        ctx.fillStyle = this._shade([58, 66, 78], fogT, fogC);
        for (let cxi = 0; cxi < cols; cxi++) for (let ryi = 0; ryi < rows; ryi++) {
          if (rng() < 0.12) continue;
          ctx.fillRect(x + w * 0.19 + cxi * (w * 0.62 / cols), topY + h * 0.22 + ryi * (h * 0.5 / rows), ww * 0.62, wh * 0.66);
        }
        // door
        ctx.fillStyle = this._shade([78, 60, 46], fogT, fogC);
        ctx.fillRect(xC - w * 0.05, botY - h * 0.3, w * 0.1, h * 0.3);
        // NIGHT: warm lamps come on — seeded per-building so the SAME windows
        // glow from every node and every rerender (neighbourhood consistency)
        if (this._envNow?.timeOfDay === 'night') {
          const rngW = rngFor(f.id + '|win');
          for (let cxi = 0; cxi < cols; cxi++) for (let ryi = 0; ryi < rows; ryi++) {
            if (rngW() < 0.45) continue;
            const wx = x + w * 0.19 + cxi * (w * 0.62 / cols), wy = topY + h * 0.22 + ryi * (h * 0.5 / rows);
            ctx.fillStyle = 'rgba(255,196,102,0.95)';
            ctx.fillRect(wx, wy, ww * 0.62, wh * 0.66);
            const g = ctx.createRadialGradient(wx + ww * 0.3, wy + wh * 0.3, 1, wx + ww * 0.3, wy + wh * 0.3, ww * 1.4);
            g.addColorStop(0, 'rgba(255,190,96,0.30)');
            g.addColorStop(1, 'rgba(255,190,96,0)');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(wx + ww * 0.3, wy + wh * 0.3, ww * 1.4, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
    }
  }

  _drawTree(ctx, f, xC, halfW, topY, botY, fogT, fogC) {
    const rng = rngFor(f.id);
    const h = botY - topY;
    ctx.fillStyle = this._shade([94, 74, 56], fogT, fogC);
    const tw = Math.max(2, halfW * 0.22);
    ctx.fillRect(xC - tw / 2, topY + h * 0.55, tw, h * 0.45);
    const g0 = mix([76, 116, 66], [96, 132, 70], rng());
    for (let i = 0; i < 3; i++) {
      const r = halfW * (1.05 - i * 0.26);
      const cy = topY + h * (0.2 + i * 0.2);
      ctx.fillStyle = this._shade(mix(g0, [60, 96, 54], i * 0.25), fogT, fogC);
      ctx.beginPath(); ctx.ellipse(xC + (rng() - 0.5) * r * 0.3, cy, r, r * 0.82, 0, 0, Math.PI * 2); ctx.fill();
    }
  }

  _drawCar(ctx, f, xC, halfW, topY, botY, fogT, fogC, dist) {
    if (dist > 120) return;
    const rng = rngFor(f.id);
    const base = f.color ? hex(f.color) : [[172, 62, 52], [62, 92, 150], [196, 196, 188], [52, 52, 56]][(rng() * 4) | 0];
    const body = mix(base, [128, 124, 118], 0.18);        // desaturate — read as object, not poster
    const h = botY - topY, w = halfW * 2 * 1.6, x = xC - w / 2;
    // soft ground shadow
    ctx.fillStyle = 'rgba(30,32,36,0.35)';
    ctx.beginPath(); ctx.ellipse(xC, botY, w * 0.52, Math.max(2, h * 0.07), 0, 0, Math.PI * 2); ctx.fill();
    // body
    ctx.fillStyle = this._shade(body, fogT, fogC);
    ctx.beginPath();
    ctx.roundRect(x, botY - h * 0.42, w, h * 0.34, Math.min(h * 0.16, 9));
    ctx.fill();
    // cabin
    ctx.fillStyle = this._shade(mix(body, [44, 50, 58], 0.55), fogT, fogC);
    ctx.beginPath();
    ctx.roundRect(x + w * 0.2, botY - h * 0.6, w * 0.6, h * 0.3, Math.min(h * 0.12, 7));
    ctx.fill();
    // wheels
    ctx.fillStyle = this._shade([32, 34, 38], fogT, fogC);
    ctx.beginPath(); ctx.ellipse(x + w * 0.22, botY - h * 0.08, Math.max(1.5, w * 0.07), Math.max(1.5, h * 0.08), 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + w * 0.78, botY - h * 0.08, Math.max(1.5, w * 0.07), Math.max(1.5, h * 0.08), 0, 0, Math.PI * 2); ctx.fill();
  }

  _drawSign(ctx, f, xC, halfW, topY, botY, fogT, fogC) {
    const h = botY - topY;
    ctx.fillStyle = this._shade([110, 112, 116], fogT, fogC);
    const pw = Math.max(1.5, halfW * 0.08);
    ctx.fillRect(xC - pw / 2, topY, pw, h);
    ctx.fillStyle = this._shade([64, 96, 130], fogT, fogC);
    const bw = halfW * 1.1, bh = h * 0.16;
    ctx.fillRect(xC - bw / 2, topY + h * 0.08, bw, bh);
  }

  /** Grazing sheep — small wool billboard, stable per-feature (powered by the
      same seeded rng as cars) so the flock never jumps between neighbours. */
  _drawSheep(ctx, f, xC, halfW, topY, botY, fogT, fogC, dist) {
    if (dist > 55) return;                       // beyond ~55 m a sheep is a speck — save the paint
    const rng = rngFor(f.id);
    const h = botY - topY, w = halfW * 2 * 1.35, x = xC - w / 2;
    ctx.fillStyle = 'rgba(30,32,36,0.28)';
    ctx.beginPath(); ctx.ellipse(xC, botY, w * 0.5, Math.max(1.4, h * 0.08), 0, 0, Math.PI * 2); ctx.fill();
    const wool = [216, 210, 198];
    ctx.fillStyle = this._shade(mix(wool, [184, 178, 166], rng() * 0.5), fogT, fogC);
    ctx.beginPath(); ctx.ellipse(xC, botY - h * 0.46, w * 0.46, h * 0.34, 0, 0, Math.PI * 2); ctx.fill();
    const headR = Math.max(1.2, h * 0.13);
    const hx = xC + (rng() < 0.5 ? -1 : 1) * w * 0.42;   // facing baked in by seed — never flickers
    ctx.fillStyle = this._shade([52, 46, 42], fogT, fogC);
    ctx.beginPath(); ctx.ellipse(hx, botY - h * 0.5, headR, headR * 1.15, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(xC - w * 0.3, botY - h * 0.18, Math.max(1, w * 0.06), h * 0.18);
    ctx.fillRect(xC + w * 0.24, botY - h * 0.18, Math.max(1, w * 0.06), h * 0.18);
  }

  /** Rural hedgerow — low, wide, bumpy dark-green band used to line lanes and
      field edges; adds depth layering the plain grass ground never could. */
  _drawHedge(ctx, f, xC, halfW, topY, botY, fogT, fogC, dist) {
    if (dist > 130) return;
    const rng = rngFor(f.id);
    const h = botY - topY, w = halfW * 2;
    ctx.fillStyle = 'rgba(30,36,28,0.30)';
    ctx.beginPath(); ctx.ellipse(xC, botY, w * 0.55, Math.max(1.5, h * 0.09), 0, 0, Math.PI * 2); ctx.fill();
    const g0 = [54, 84, 44];
    const bumps = 3;
    for (let i = 0; i < bumps; i++) {
      const bx = xC - w * 0.33 + (w / bumps) * i + (rng() - 0.5) * w * 0.06;
      const r = w / bumps * (0.66 + rng() * 0.1);
      ctx.fillStyle = this._shade(mix(g0, [74, 104, 56], rng() * 0.7), fogT, fogC);
      ctx.beginPath(); ctx.ellipse(bx, botY - h * (0.34 + rng() * 0.1), r, h * 0.52, 0, 0, Math.PI * 2); ctx.fill();
    }
  }

  /** Post-and-rail paddock fence — the rural workhorse detail object:
      culls past 80 m where rails would alias. */
  _drawFence(ctx, f, xC, halfW, topY, botY, fogT, fogC, dist) {
    if (dist > 80) return;
    const rng = rngFor(f.id);
    const h = botY - topY, w = halfW * 2, x = xC - halfW;
    const wood = this._shade(mix([122, 92, 62], [96, 72, 50], rng() * 0.5), fogT, fogC);
    const postW = Math.max(1.2, w * 0.03);
    const posts = Math.max(2, Math.round(w / Math.max(6, h * 0.55)));
    ctx.fillStyle = wood;
    for (let i = 0; i <= posts; i++) {
      ctx.fillRect(x + (w * i) / posts - postW / 2, topY, postW, h);
    }
    const railH = Math.max(1, h * 0.12);
    ctx.fillRect(x, topY + h * 0.12, w, railH);
    ctx.fillRect(x, topY + h * 0.52, w, railH);
  }

  /** Park bench for the village green — seat slab, back slab, two legs. */
  _drawBench(ctx, f, xC, halfW, topY, botY, fogT, fogC, dist) {
    if (dist > 45) return;
    const rng = rngFor(f.id);
    const h = botY - topY, w = halfW * 2, x = xC - halfW;
    ctx.fillStyle = 'rgba(30,32,36,0.30)';
    ctx.beginPath(); ctx.ellipse(xC, botY, w * 0.52, Math.max(1.3, h * 0.08), 0, 0, Math.PI * 2); ctx.fill();
    const wood = this._shade(mix([140, 104, 60], [112, 82, 48], rng() * 0.5), fogT, fogC);
    const iron = this._shade([48, 50, 54], fogT, fogC);
    ctx.fillStyle = iron;
    ctx.fillRect(x + w * 0.14, botY - h * 0.5, Math.max(1.2, w * 0.05), h * 0.5);
    ctx.fillRect(x + w * 0.8, botY - h * 0.5, Math.max(1.2, w * 0.05), h * 0.5);
    ctx.fillStyle = wood;
    ctx.fillRect(x, botY - h * 0.56, w, h * 0.14);          // seat
    ctx.fillRect(x, topY, w, h * 0.16);                     // back rail
  }

  /** Single round bush — cottage garden filler. */
  _drawBush(ctx, f, xC, halfW, topY, botY, fogT, fogC, dist) {
    if (dist > 130) return;
    const rng = rngFor(f.id);
    const h = botY - topY;
    ctx.fillStyle = 'rgba(30,36,28,0.28)';
    ctx.beginPath(); ctx.ellipse(xC, botY, halfW, Math.max(1.5, h * 0.09), 0, 0, Math.PI * 2); ctx.fill();
    const g0 = mix([62, 92, 50], [84, 112, 60], rng());
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = this._shade(mix(g0, [52, 82, 44], i * 0.3), fogT, fogC);
      ctx.beginPath();
      ctx.ellipse(xC + (rng() - 0.5) * halfW * 0.4, topY + h * (0.28 + i * 0.22), halfW * (0.95 - i * 0.2), h * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Wildflower patch — tiny seeded colour specks on short stems. */
  _drawFlowers(ctx, f, xC, halfW, topY, botY, fogT, fogC, dist) {
    if (dist > 35) return;
    const rng = rngFor(f.id);
    const h = botY - topY, w = halfW * 2, x = xC - halfW;
    const petal = [[214, 74, 74], [232, 208, 92], [236, 234, 224], [150, 96, 190], [240, 150, 120]];
    ctx.lineWidth = Math.max(0.8, h * 0.05);
    for (let i = 0; i < 14; i++) {
      const fx = x + rng() * w, fy = botY - rng() * h * 0.85;
      ctx.strokeStyle = this._shade([74, 110, 52], fogT, fogC);
      ctx.beginPath(); ctx.moveTo(fx, botY); ctx.lineTo(fx, fy); ctx.stroke();
      const c = petal[(rng() * petal.length) | 0];
      ctx.fillStyle = this._shade(c, fogT * 0.7, fogC);
      const r = Math.max(1.1, h * (0.09 + rng() * 0.07));
      ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  _drawFurniture(ctx, f, xC, halfW, topY, botY, fogT, fogC, dist) {
    const h = botY - topY, w = halfW * 2, x = xC - halfW;
    ctx.fillStyle = 'rgba(20,22,25,0.3)';
    ctx.beginPath(); ctx.ellipse(xC, botY, w * 0.5, Math.max(1.5, h * 0.08), 0, 0, Math.PI * 2); ctx.fill();

    if (f.kind === 'bed') {
      // Headboard
      ctx.fillStyle = this._shade([74, 52, 42], fogT, fogC);
      ctx.fillRect(x + w * 0.1, topY, w * 0.8, h * 0.45);
      // Mattress & duvet
      ctx.fillStyle = this._shade([240, 242, 245], fogT, fogC);
      ctx.fillRect(x + w * 0.05, topY + h * 0.45, w * 0.9, h * 0.4);
      // Pillows
      ctx.fillStyle = this._shade([255, 255, 255], fogT, fogC);
      ctx.beginPath();
      ctx.ellipse(x + w * 0.3, topY + h * 0.48, w * 0.18, h * 0.1, 0, 0, Math.PI * 2);
      ctx.ellipse(x + w * 0.7, topY + h * 0.48, w * 0.18, h * 0.1, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (f.kind === 'stairs') {
      ctx.fillStyle = this._shade([130, 100, 75], fogT, fogC);
      const steps = 6;
      for (let i = 0; i < steps; i++) {
        const sy = topY + (h / steps) * i;
        ctx.fillRect(x + (w / steps) * i, sy, w - (w / steps) * i, h / steps);
      }
    } else if (f.kind === 'window') {
      ctx.fillStyle = this._shade([135, 206, 250], fogT, fogC);
      ctx.fillRect(x, topY, w, h);
      ctx.strokeStyle = '#2c3e50';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, topY, w, h);
    } else if (f.kind === 'bath') {
      ctx.fillStyle = this._shade([235, 240, 245], fogT, fogC);
      ctx.beginPath();
      ctx.ellipse(xC, topY + h * 0.5, w * 0.45, h * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = this._shade([90, 65, 50], fogT, fogC);
      ctx.fillRect(x, topY + h * 0.3, w, h * 0.6);
    }
  }

  /** Unified ground shadow — EVERY structure gets one. Under sun it leans
      away from the light and stretches with height·cot(elevation) (the
      ray-traced look); under rain/night it collapses to a soft contact pool.
      Pure screen-space transform, alpha capped so it never reads as a smear. */
  _castShadow(ctx, xC, botY, halfW, radiusM, hM, bearingRad, distM, fogT) {
    const env = this._envNow || {};
    const strength = env.weather === 'rain' ? 0
      : env.weather === 'overcast' ? 0.05
      : env.timeOfDay === 'night' ? 0.06
      : 0.20;
    if (strength <= 0.01 || distM > 90) return;
    const el = Math.max(0.18, (env.sunElevationDeg || 35) * DEG);
    const lenM = Math.min(hM / Math.tan(el), 26);            // shadow run, metres
    const shadowAz = ((env.sunAzimuthDeg || 0) + 180) * DEG; // falls away from the sun
    const rel = shadowAz - bearingRad;                       // vs. viewer direction
    const pxPerM = halfW / Math.max(0.3, radiusM);
    const dxPx = lenM * pxPerM * Math.sin(rel) * 0.55;
    const stretch = 1 + Math.min(2.2, lenM * 0.16 * (0.35 + Math.abs(Math.cos(rel))));
    ctx.save();
    ctx.translate(xC + dxPx * 0.5, botY);
    ctx.rotate(Math.max(-0.5, Math.min(0.5, -Math.sin(rel) * 0.5)));
    ctx.scale(stretch, 0.24);
    ctx.globalAlpha = Math.min(strength, strength * (1.1 - fogT));
    ctx.fillStyle = 'rgb(26,30,24)';
    ctx.beginPath(); ctx.ellipse(0, 0, halfW * 0.95, halfW * 0.95, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  _drawTower(ctx, f, xC, halfW, topY, botY, fogT, fogC) {
    const w = Math.max(halfW * 1.4, 6);
    const h = botY - topY;
    // stone body
    ctx.fillStyle = this._shade([206, 196, 176], fogT, fogC);
    ctx.fillRect(xC - w / 2, topY, w, h);
    ctx.fillStyle = this._shade(mix([206, 196, 176], [70, 62, 54], 0.18), fogT, fogC);
    ctx.fillRect(xC + w * 0.22, topY, w * 0.28, h);
    // belfry opening band
    ctx.fillStyle = this._shade([64, 52, 44], fogT, fogC);
    ctx.fillRect(xC - w * 0.28, topY + h * 0.1, w * 0.56, h * 0.09);
    // clock
    if (h > 40) {
      ctx.strokeStyle = this._shade([240, 236, 224], fogT, fogC);
      ctx.lineWidth = Math.max(1.2, w * 0.06);
      ctx.beginPath(); ctx.arc(xC, topY + h * 0.32, w * 0.24, 0, Math.PI * 2); ctx.stroke();
    }
    // cross finial
    const cw = Math.max(1.5, w * 0.1);
    ctx.fillStyle = this._shade([58, 48, 40], fogT, fogC);
    ctx.fillRect(xC - cw / 2, topY - h * 0.14, cw, h * 0.14);
    ctx.fillRect(xC - cw * 1.8, topY - h * 0.115, cw * 3.6, cw);
  }

  _paintSun(ctx, W, H, sky, env) {
    if (env.weather === 'overcast' || env.weather === 'rain') return;
    const night = env.timeOfDay === 'night';
    if (night) this._paintStars(ctx, W, H, env);
    const az = ((env.sunAzimuthDeg % 360) + 360) % 360;
    const el = env.sunElevationDeg;
    const x = ((az + 180) % 360) / 360 * W;
    const y = (0.5 - el / 180) * H;
    const r = H * (night ? 0.026 : 0.045);
    const g = ctx.createRadialGradient(x, y, 1, x, y, r * 5);
    g.addColorStop(0, sky.sun);
    g.addColorStop(0.25, sky.sun + '');
    g.addColorStop(1, night ? 'rgba(232,236,255,0)' : 'rgba(255,244,214,0)');
    ctx.save();
    ctx.globalAlpha = night ? 0.55 : 0.9;
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = sky.sun;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    if (night) {   // soft moon shading: darker disc offset for a crescent feel
      ctx.fillStyle = 'rgba(11,16,38,0.55)';
      ctx.beginPath(); ctx.arc(x - r * 0.38, y - r * 0.22, r * 0.86, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /** Deterministic star field for clear nights — fixed seed per resolution,
      so regenerating the same node repaints the same sky (perfect sync). */
  _paintStars(ctx, W, H, env) {
    if (env.weather === 'overcast' || env.weather === 'rain') return;
    const rng = rngFor(`stars_${W}x${H}`);
    ctx.save();
    for (let i = 0; i < 260; i++) {
      const x = rng() * W, y = rng() * H * 0.46;
      const a = (0.25 + rng() * 0.6) * (1 - y / (H * 0.5));
      const s = rng() < 0.12 ? 1.6 : (rng() < 0.4 ? 1.1 : 0.6);
      ctx.fillStyle = `rgba(226,234,255,${a.toFixed(2)})`;
      ctx.fillRect(x, y, s, s);
    }
    ctx.restore();
  }

  /** Volumetric light shafts fanning down from the sun ("ray-traced" read):
      a seeded fan of additive wedges — same sky every redraw, hidden in rain,
      overcast and at night. */
  _paintGodRays(ctx, W, H, sky, env) {
    if (env.weather === 'overcast' || env.weather === 'rain' || env.timeOfDay === 'night') return;
    const az = ((env.sunAzimuthDeg % 360) + 360) % 360;
    const x = ((az + 180) % 360) / 360 * W;
    const y = (0.5 - env.sunElevationDeg / 180) * H;
    const rng = rngFor(`rays_${env.sunAzimuthDeg}_${env.sunElevationDeg}`);
    const sunC = hex(sky.sun);
    for (const off of [-W, 0, W]) {
      for (let i = 0; i < 9; i++) {
        const ang = (i - 4) * 0.085 + (rng() - 0.5) * 0.04;
        const len = H * (0.34 + rng() * 0.34);
        const wpx = 8 + rng() * 30;
        ctx.save();
        ctx.translate(x + off, y);
        ctx.rotate(ang);
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.045 + rng() * 0.05;
        const g = ctx.createLinearGradient(0, 0, 0, len);
        g.addColorStop(0, css(sunC));
        g.addColorStop(1, css([sunC[0], sunC[1], sunC[2]]).replace('rgb', 'rgba').replace(')', ',0)'));
        ctx.fillStyle = g;
        ctx.fillRect(-wpx / 2, 10, wpx, len);
        ctx.restore();
      }
    }
  }
}

function targetZoneName(context) { return context.zones?.[0]?.name ?? 'open'; }

/**
 * RemoteGenerationProvider — integration seam for a real AI image API.
 * Credentials must live server-side (Spec §21/§50 of the code-quality rules);
 * the client only calls YOUR endpoint with the full generation context.
 */
export class RemoteGenerationProvider extends GenerationProvider {
  constructor(endpoint) { super(); this.endpoint = endpoint; this.id = 'remote'; }
  async generate(node, context) {
    const res = await fetch(this.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(context),
    });
    if (!res.ok) throw new Error(`generation failed: ${res.status}`);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width; canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    return { canvas, meta: { provider: this.id, nodeId: node.id, seed: null, generationAttempt: 1 } };
  }
}
