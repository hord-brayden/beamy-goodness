/* Beam — tiny projection mapper.
 * One file, two modes: "editor" (UI) and "output" (what the projector shows).
 * In the native Mac app the two talk through window.webkit.messageHandlers.pm;
 * in a plain browser they fall back to BroadcastChannel.
 */
(() => {
'use strict';

const NATIVE = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pm);
const MODE = window.__PM_MODE || new URLSearchParams(location.search).get('mode') || 'editor';
const post = (msg) => { if (NATIVE) window.webkit.messageHandlers.pm.postMessage(msg); };
const bc = (!NATIVE && 'BroadcastChannel' in window) ? new BroadcastChannel('beam') : null;
const PM = (window.PM = {});

/* ------------------------------------------------------------------ utils */
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const safeColor = (c, d) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : d);
const fileName = (u) => { try { return decodeURIComponent(String(u).split(/[\\/]/).pop().split(/[?#]/)[0]); } catch { return 'media'; } };

const BLENDS = ['normal', 'screen', 'multiply', 'overlay', 'lighten', 'darken', 'color-dodge',
  'soft-light', 'hard-light', 'difference', 'exclusion', 'hue', 'color', 'luminosity'];
// name: [base seconds, timing function]
const ANIMS = {
  none: null, pulse: [2, 'ease-in-out'], strobe: [0.2, 'linear'], flicker: [1.6, 'linear'],
  hue: [6, 'linear'], spin: [8, 'linear'], breathe: [4, 'ease-in-out'], slide: [4, 'linear'],
};
const LAYER_TYPES = { color: 'Color', gradient: 'Gradient', media: 'Media', playlist: 'Playlist', text: 'Text', grid: 'Grid' };
const LAYER_DEFAULTS = {
  color: { color: '#ff3d7f' },
  gradient: { c1: '#00e5ff', c2: '#7c4dff', angle: 45, kind: 'linear' },
  media: { src: '', name: '', kind: 'image', fit: 'cover', rate: 1, audio: false },
  playlist: { items: [], duration: 5, fade: 1, fit: 'cover' },
  text: { text: 'HELLO', color: '#ffffff', size: 30, font: 'Helvetica Neue', weight: '800' },
  grid: { color: '#ffffff', div: 8 },
};
const PALETTE = [['#00e5ff', '#7c4dff'], ['#ff4fa3', '#ffb84f'], ['#3dffa8', '#008cff'], ['#ffe14f', '#ff3d3d'], ['#b44fff', '#4fd0ff']];
const FONTS = ['Helvetica Neue', 'Avenir Next', 'Futura', 'Gill Sans', 'Impact', 'Georgia',
  'Didot', 'Menlo', 'Courier New', 'Marker Felt', 'Chalkduster', 'system-ui'];
const VIDEO_RE = /\.(mp4|m4v|mov|webm|ogv)$/i;
const MEDIA_RE = /\.(mp4|m4v|mov|webm|ogv|gif|png|jpe?g|webp|bmp|svg|heic|tiff?|avif)$/i;

/* ------------------------------------------------------ homography (corner pin)
 * Maps the rectangle (0,0)-(w,h) onto an arbitrary quad and returns a CSS matrix3d.
 * Classic projective mapping via the adjugate: H = B_dst · adj(B_src).
 */
function adj(m) {
  return [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ];
}
function mulMM(a, b) {
  const c = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0; for (let k = 0; k < 3; k++) s += a[3 * i + k] * b[3 * k + j];
    c[3 * i + j] = s;
  }
  return c;
}
function mulMV(m, v) {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
function basis(p) {
  const m = [p[0][0], p[1][0], p[2][0], p[0][1], p[1][1], p[2][1], 1, 1, 1];
  const v = mulMV(adj(m), [p[3][0], p[3][1], 1]);
  return mulMM(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
}
function quadMatrix(w, h, c) {
  const t = mulMM(basis(c), adj(basis([[0, 0], [w, 0], [w, h], [0, h]])));
  if (!t[8] || !t.every(isFinite)) return 'none';
  for (let i = 0; i < 9; i++) t[i] /= t[8];
  return `matrix3d(${t[0]},${t[3]},0,${t[6]},${t[1]},${t[4]},0,${t[7]},0,0,1,0,${t[2]},${t[5]},0,${t[8]})`;
}
function surfSize(c) {
  return [
    Math.max(1, (dist(c[0], c[1]) + dist(c[3], c[2])) / 2),
    Math.max(1, (dist(c[0], c[3]) + dist(c[1], c[2])) / 2),
  ];
}
PM._quadMatrix = quadMatrix; // exposed for testing

/* ------------------------------------------------------------- model */
function defaultState() {
  return { version: 1, stage: { w: 1920, h: 1080, bg: '#000000' }, calibrate: false, surfaces: [] };
}
function newSurface(x, y, w, h, name) {
  return {
    id: uid(), name: name || 'Surface', visible: true, locked: false, opacity: 1, blend: 'normal',
    shape: 'rect', corners: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], layers: [],
  };
}
function newLayer(type, extra) {
  return Object.assign({ id: uid(), type, visible: true, opacity: 1, blend: 'normal', anim: 'none', speed: 1 },
    JSON.parse(JSON.stringify(LAYER_DEFAULTS[type])), extra || {});
}
// Defensive load: project files come from disk, so coerce every field we rely on.
function normalize(raw) {
  const st = defaultState();
  if (!raw || typeof raw !== 'object') return st;
  if (raw.stage) {
    st.stage.w = clamp(Math.round(num(raw.stage.w, 1920)), 64, 16384);
    st.stage.h = clamp(Math.round(num(raw.stage.h, 1080)), 64, 16384);
    st.stage.bg = safeColor(raw.stage.bg, '#000000');
  }
  st.calibrate = !!raw.calibrate;
  const surfaces = Array.isArray(raw.surfaces) ? raw.surfaces : [];
  st.surfaces = surfaces
    .filter((s) => s && Array.isArray(s.corners) && s.corners.length === 4)
    .map((s) => ({
      id: String(s.id || uid()),
      name: String(s.name || 'Surface').slice(0, 80),
      visible: s.visible !== false,
      locked: !!s.locked,
      opacity: clamp(num(s.opacity, 1), 0, 1),
      blend: BLENDS.includes(s.blend) ? s.blend : 'normal',
      shape: s.shape === 'ellipse' ? 'ellipse' : 'rect',
      corners: s.corners.map((p) => [num(+p[0], 0), num(+p[1], 0)]),
      layers: (Array.isArray(s.layers) ? s.layers : [])
        .filter((L) => L && LAYER_DEFAULTS[L.type])
        .map((L) => normalizeLayer(L)),
    }));
  return st;
}
function normalizeLayer(L) {
  const base = newLayer(L.type);
  const out = { ...base };
  for (const k of Object.keys(base)) if (k in L && typeof L[k] === typeof base[k]) out[k] = L[k];
  out.id = String(L.id || uid());
  out.opacity = clamp(out.opacity, 0, 1);
  out.blend = BLENDS.includes(out.blend) ? out.blend : 'normal';
  out.anim = out.anim in ANIMS ? out.anim : 'none';
  for (const k of ['color', 'c1', 'c2']) if (k in out) out[k] = safeColor(out[k], base[k]);
  if (out.type === 'media') out.kind = out.kind === 'video' ? 'video' : 'image';
  if (out.type === 'playlist') {
    out.items = (Array.isArray(L.items) ? L.items : [])
      .filter((it) => it && typeof it.src === 'string')
      .map((it) => ({ src: it.src, name: String(it.name || fileName(it.src)), kind: it.kind === 'video' ? 'video' : 'image' }));
  }
  return out;
}

/* ------------------------------------------------------------- rendering (shared) */
function gridSVG(w, h, n, color) {
  n = clamp(n | 0, 1, 64);
  const W = w.toFixed(1), H = h.toFixed(1);
  let d = '';
  for (let i = 1; i < n; i++) {
    const x = ((i * w) / n).toFixed(1), y = ((i * h) / n).toFixed(1);
    d += `M${x} 0V${H}M0 ${y}H${W}`;
  }
  const r = (Math.min(w, h) * 0.4).toFixed(1);
  const sw = Math.max(1.5, Math.min(w, h) / 250).toFixed(1);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g fill="none" stroke="${color}" stroke-width="${sw}">` +
    `<path d="${d}" opacity=".7"/><rect x="${sw}" y="${sw}" width="${(w - 2 * sw).toFixed(1)}" height="${(h - 2 * sw).toFixed(1)}" stroke-width="${sw * 2}"/>` +
    `<path d="M0 0L${W} ${H}M${W} 0L0 ${H}" opacity=".45"/><circle cx="${(w / 2).toFixed(1)}" cy="${(h / 2).toFixed(1)}" r="${r}"/></g></svg>`;
}

function makeMedia(src, kind) {
  let m;
  if (kind === 'video') {
    m = document.createElement('video');
    m.autoplay = true; m.loop = true; m.muted = true; m.playsInline = true;
    m.src = src;
    m.play().catch(() => {});
  } else {
    m = document.createElement('img');
    m.draggable = false;
    m.src = src;
  }
  m.className = 'media';
  return m;
}
const disposeMedia = (m) => { if (m.tagName === 'VIDEO') { m.pause(); m.removeAttribute('src'); m.load(); } m.remove(); };

// Playlists pick the current item from the wall clock, so the editor preview and the
// projector always show the same item without any extra syncing.
const playlists = new Set();
function tickPlaylist(le) {
  const p = le._pl;
  const n = p.items.length;
  if (!n) return;
  const idx = Math.floor(Date.now() / 1000 / p.duration) % n;
  if (idx === le._cur) return;
  le._cur = idx;
  const fx = le._fx;
  const old = [...fx.children];
  const m = makeMedia(p.items[idx].src, p.items[idx].kind);
  m.style.objectFit = p.fit;
  if (p.fade > 0 && old.length) {
    m.style.opacity = '0';
    m.style.transition = `opacity ${p.fade}s ease`;
    fx.appendChild(m);
    requestAnimationFrame(() => requestAnimationFrame(() => (m.style.opacity = '1')));
    setTimeout(() => old.forEach(disposeMedia), p.fade * 1000 + 150);
  } else {
    old.forEach(disposeMedia);
    fx.appendChild(m);
  }
  const next = p.items[(idx + 1) % n];
  if (n > 1 && next.kind !== 'video') new Image().src = next.src; // preload
}
setInterval(() => {
  for (const le of playlists) { if (!le.isConnected) { playlists.delete(le); continue; } tickPlaylist(le); }
}, 200);

function renderSurfaces(root, st, opts) {
  if (!root._map) root._map = new Map();
  const map = root._map;
  const seen = new Set();
  st.surfaces.forEach((s, i) => {
    seen.add(s.id);
    let el = map.get(s.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'surface';
      el.dataset.sid = s.id;
      el._layers = new Map();
      map.set(s.id, el);
    }
    if (root.children[i] !== el) root.insertBefore(el, root.children[i] || null);
    const [w, h] = surfSize(s.corners);
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.style.transform = quadMatrix(w, h, s.corners);
    el.style.opacity = s.opacity;
    el.style.mixBlendMode = s.blend;
    el.style.display = s.visible ? '' : 'none';
    el.style.borderRadius = s.shape === 'ellipse' ? '50%' : '0';
    el.classList.toggle('locked', !!s.locked);
    renderLayers(el, s, w, h, opts);

    if (st.calibrate) {
      let cal = el._cal;
      if (!cal) {
        cal = el._cal = document.createElement('div');
        cal.className = 'calib';
        cal._label = document.createElement('div');
        cal._label.className = 'cal-label';
      }
      if (el.lastChild !== cal) el.appendChild(cal);
      const color = `hsl(${(i * 67) % 360},100%,62%)`;
      const key = [color, Math.round(w), Math.round(h)].join('|');
      if (cal._key !== key) {
        cal._key = key;
        cal.innerHTML = gridSVG(w, h, 8, color);
        cal.appendChild(cal._label);
      }
      cal._label.textContent = `${i + 1} · ${s.name}`;
      cal._label.style.fontSize = Math.max(10, Math.min(w, h) / 9) + 'px';
    } else if (el._cal) {
      el._cal.remove();
      el._cal = null;
    }
  });
  for (const [id, el] of map) if (!seen.has(id)) { el.remove(); map.delete(id); }
}

function renderLayers(el, s, w, h, opts) {
  const map = el._layers;
  const seen = new Set();
  s.layers.forEach((L, i) => {
    seen.add(L.id);
    let le = map.get(L.id);
    if (!le || le._type !== L.type) {
      if (le) le.remove();
      le = document.createElement('div');
      le.className = 'layer';
      le._type = L.type;
      le._fx = document.createElement('div');
      le._fx.className = 'fx';
      le.appendChild(le._fx);
      map.set(L.id, le);
    }
    if (el.children[i] !== le) el.insertBefore(le, el.children[i] || null);
    le.style.opacity = L.opacity;
    le.style.mixBlendMode = L.blend;
    le.style.display = L.visible ? '' : 'none';

    const fx = le._fx;
    const a = ANIMS[L.anim];
    const animKey = a ? `${L.anim}|${L.speed}` : '';
    if (le._anim !== animKey) {
      le._anim = animKey;
      fx.style.animation = a ? `beam-${L.anim} ${(a[0] / Math.max(0.05, L.speed)).toFixed(3)}s ${a[1]} infinite` : '';
    }

    switch (L.type) {
      case 'color':
        fx.style.background = L.color;
        break;
      case 'gradient':
        fx.style.background = L.kind === 'radial'
          ? `radial-gradient(circle at center, ${L.c1}, ${L.c2})`
          : `linear-gradient(${num(L.angle, 0)}deg, ${L.c1}, ${L.c2})`;
        break;
      case 'media': {
        let m = fx.firstChild;
        if (le._src !== L.src || le._kind !== L.kind) {
          fx.textContent = '';
          le._src = L.src; le._kind = L.kind;
          m = null;
          if (L.src) { m = makeMedia(L.src, L.kind); fx.appendChild(m); }
        }
        if (m) {
          m.style.objectFit = L.fit;
          if (L.kind === 'video') {
            const rate = clamp(num(L.rate, 1), 0.1, 4);
            if (m.playbackRate !== rate) m.playbackRate = rate;
            const muted = opts.editor || !L.audio;
            if (m.muted !== muted) { m.muted = muted; m.play().catch(() => {}); }
          }
        }
        break;
      }
      case 'playlist': {
        const items = Array.isArray(L.items) ? L.items : [];
        const key = items.map((it) => it.src).join('\n');
        if (le._key !== key) { le._key = key; [...fx.children].forEach(disposeMedia); le._cur = -1; }
        le._pl = { items, duration: Math.max(0.5, num(L.duration, 5)), fade: clamp(num(L.fade, 1), 0, 10), fit: L.fit };
        playlists.add(le);
        tickPlaylist(le);
        for (const m of fx.children) m.style.objectFit = L.fit;
        break;
      }
      case 'text': {
        let t = fx.firstChild;
        if (!t) { t = document.createElement('div'); t.className = 'text'; fx.appendChild(t); }
        if (t.textContent !== L.text) t.textContent = L.text;
        t.style.color = L.color;
        t.style.fontSize = (clamp(num(L.size, 30), 1, 200) / 100) * h + 'px';
        t.style.fontFamily = `"${String(L.font).replace(/["\\]/g, '')}", sans-serif`;
        t.style.fontWeight = L.weight;
        break;
      }
      case 'grid': {
        const key = [L.color, L.div, Math.round(w), Math.round(h)].join('|');
        if (le._key !== key) { le._key = key; fx.innerHTML = gridSVG(w, h, L.div, safeColor(L.color, '#ffffff')); }
        break;
      }
    }
  });
  for (const [id, le] of map) if (!seen.has(id)) { le.remove(); map.delete(id); }
}

/* ================================================================ OUTPUT MODE */
if (MODE === 'output') {
  document.body.innerHTML = '<div id="stage"></div>';
  document.body.className = 'output';
  const stageEl = document.getElementById('stage');
  let st = null;
  const fit = () => {
    if (!st) return;
    // Stretch the stage to fill the output exactly; the mapping lives in stage coordinates.
    const sx = innerWidth / st.stage.w, sy = innerHeight / st.stage.h;
    stageEl.style.cssText = `width:${st.stage.w}px;height:${st.stage.h}px;background:${st.stage.bg};transform:scale(${sx},${sy})`;
  };
  PM.applyState = (json) => {
    try { st = typeof json === 'string' ? JSON.parse(json) : json; } catch { return; }
    fit();
    renderSurfaces(stageEl, st, { editor: false });
  };
  PM.splash = (name) => {
    let el = document.getElementById('splash');
    if (!el) {
      el = document.createElement('div');
      el.id = 'splash';
      el.innerHTML = '<img src="logo.png" alt=""><div class="t">Beam is connected</div><div class="s"></div>';
      document.body.appendChild(el);
    }
    el.querySelector('.s').textContent = `${name} · ready to project`;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 4000);
  };
  addEventListener('resize', fit);
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') post({ type: 'exitFullscreen' });
    if (!NATIVE && (e.key === 'f' || e.key === 'F')) document.documentElement.requestFullscreen?.();
  });
  if (!NATIVE) addEventListener('dblclick', () => document.documentElement.requestFullscreen?.());
  if (bc) {
    bc.onmessage = (e) => { if (e.data !== 'hello') PM.applyState(e.data); };
    bc.postMessage('hello');
  }
  post({ type: 'outputReady' });
  return;
}

/* ================================================================ EDITOR MODE */
if (NATIVE) document.body.classList.add('native');
const $ = (id) => document.getElementById(id);
const viewport = $('viewport'), stageEl = $('stage'), overlay = $('overlay');

let state = defaultState();
const sel = { surface: null, corner: null };
const view = { k: 1, ox: 0, oy: 0 };
let screens = [], currentOutput = -1;
const collapsed = new Set();

try {
  const saved = window.__PM_AUTOSAVE || (!NATIVE && localStorage.getItem('beam.autosave'));
  if (saved) state = normalize(JSON.parse(saved));
} catch { /* bad autosave → start fresh */ }

const selected = () => state.surfaces.find((s) => s.id === sel.surface) || null;
const findSurface = (id) => state.surfaces.find((s) => s.id === id) || null;

/* ---------- history + sync */
const hist = { stack: [], i: -1 };
function commit() {
  const j = JSON.stringify(state);
  if (hist.stack[hist.i] === j) return;
  hist.stack = hist.stack.slice(0, hist.i + 1);
  hist.stack.push(j);
  if (hist.stack.length > 200) hist.stack.shift();
  hist.i = hist.stack.length - 1;
  scheduleAutosave();
}
let commitTimer = 0;
const commitSoon = () => { clearTimeout(commitTimer); commitTimer = setTimeout(commit, 350); };
function undo() { if (hist.i > 0) { hist.i--; state = JSON.parse(hist.stack[hist.i]); afterLoad(); scheduleAutosave(); } }
function redo() { if (hist.i < hist.stack.length - 1) { hist.i++; state = JSON.parse(hist.stack[hist.i]); afterLoad(); scheduleAutosave(); } }
function afterLoad() {
  if (!selected()) sel.surface = null;
  sel.corner = null;
  layout();
  refreshUI();
  changed();
}

let raf = 0;
function changed() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderSurfaces(stageEl, state, { editor: true });
    drawOverlay();
    broadcast();
    $('empty').style.display = state.surfaces.length ? 'none' : '';
  });
}
function broadcast() {
  const j = JSON.stringify(state);
  if (NATIVE) post({ type: 'state', json: j });
  else if (bc) bc.postMessage(j);
}
PM.broadcast = broadcast;

let autosaveTimer = 0;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    const j = JSON.stringify(state);
    if (NATIVE) post({ type: 'autosave', json: j });
    else { try { localStorage.setItem('beam.autosave', j); } catch { /* quota / private mode */ } }
  }, 400);
}

let toastTimer = 0;
PM.toast = (msg) => {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
};

/* ---------- view transform */
function layout() {
  const r = viewport.getBoundingClientRect();
  const pad = 48;
  const k = Math.min((r.width - pad * 2) / state.stage.w, (r.height - pad * 2) / state.stage.h);
  view.k = k > 0 ? k : 0.1;
  view.ox = (r.width - state.stage.w * view.k) / 2;
  view.oy = (r.height - state.stage.h * view.k) / 2;
  stageEl.style.width = state.stage.w + 'px';
  stageEl.style.height = state.stage.h + 'px';
  stageEl.style.background = state.stage.bg;
  stageEl.style.transform = `translate(${view.ox}px,${view.oy}px) scale(${view.k})`;
  drawOverlay();
}
new ResizeObserver(layout).observe(viewport);

const toScreen = (p) => [p[0] * view.k + view.ox, p[1] * view.k + view.oy];
function toStage(clientX, clientY) {
  const r = viewport.getBoundingClientRect();
  return [(clientX - r.left - view.ox) / view.k, (clientY - r.top - view.oy) / view.k];
}

function drawOverlay() {
  const s = selected();
  let out = '';
  for (const t of state.surfaces) {
    if (!t.visible) continue;
    const pts = t.corners.map(toScreen).map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
    out += `<polygon class="outline${t.id === sel.surface ? ' sel' : ''}" points="${pts}"/>`;
  }
  if (s && s.visible && !s.locked) {
    const c = s.corners.map(toScreen);
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      out += `<rect class="edge" data-h="e${i}" x="${(mx - 4).toFixed(1)}" y="${(my - 4).toFixed(1)}" width="8" height="8" rx="2"/>`;
    }
    const labels = ['TL', 'TR', 'BR', 'BL'];
    for (let i = 0; i < 4; i++) {
      out += `<circle class="corner${sel.corner === i ? ' active' : ''}" data-h="c${i}" cx="${c[i][0].toFixed(1)}" cy="${c[i][1].toFixed(1)}" r="7"/>`;
      out += `<text class="clabel" x="${(c[i][0] + 10).toFixed(1)}" y="${(c[i][1] - 9).toFixed(1)}">${labels[i]}</text>`;
    }
  }
  overlay.innerHTML = out;
}

/* ---------- snapping */
function snapCandidates(excludeId) {
  const pts = [[0, 0], [state.stage.w, 0], [state.stage.w, state.stage.h], [0, state.stage.h]];
  for (const s of state.surfaces) if (s.visible && s.id !== excludeId) pts.push(...s.corners);
  return pts;
}
function snapPoint(p, excludeId) {
  const th = 10 / view.k;
  let best = null, bd = th;
  for (const c of snapCandidates(excludeId)) { const d = dist(p, c); if (d < bd) { bd = d; best = c; } }
  return best ? [best[0], best[1]] : p;
}
function snapOffset(corners, excludeId) {
  const th = 10 / view.k;
  let best = null, bd = th;
  const cands = snapCandidates(excludeId);
  for (const p of corners) for (const c of cands) {
    const d = dist(p, c);
    if (d < bd) { bd = d; best = [c[0] - p[0], c[1] - p[1]]; }
  }
  return best || [0, 0];
}

/* ---------- pointer interaction on the stage */
let drag = null;
viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const p = toStage(e.clientX, e.clientY);
  const handle = e.target.closest && e.target.closest('[data-h]');
  const s0 = selected();
  if (handle && s0) {
    const kind = handle.dataset.h[0], idx = +handle.dataset.h[1];
    drag = { type: kind === 'c' ? 'corner' : 'edge', idx, start: p, orig: s0.corners.map((c) => c.slice()), sid: s0.id };
    if (kind === 'c') sel.corner = idx;
  } else {
    const sEl = e.target.closest && e.target.closest('.surface');
    if (sEl) {
      if (sel.surface !== sEl.dataset.sid) { sel.surface = sEl.dataset.sid; sel.corner = null; refreshUI(); }
      const s = selected();
      if (s && !s.locked) drag = { type: 'move', start: p, orig: s.corners.map((c) => c.slice()), sid: s.id };
    } else {
      if (sel.surface) { sel.surface = null; sel.corner = null; refreshUI(); }
    }
  }
  if (drag) viewport.setPointerCapture(e.pointerId);
  changed();
});
viewport.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const s = findSurface(drag.sid);
  if (!s) { drag = null; return; }
  const p = toStage(e.clientX, e.clientY);
  let dx = p[0] - drag.start[0], dy = p[1] - drag.start[1];
  if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
  const o = drag.orig;
  if (drag.type === 'move') {
    let moved = o.map((c) => [c[0] + dx, c[1] + dy]);
    if (!e.altKey) { const [sx, sy] = snapOffset(moved, s.id); moved = moved.map((c) => [c[0] + sx, c[1] + sy]); }
    s.corners = moved;
  } else if (drag.type === 'corner') {
    let q = [o[drag.idx][0] + dx, o[drag.idx][1] + dy];
    if (!e.altKey) q = snapPoint(q, s.id);
    s.corners = o.map((c, i) => (i === drag.idx ? q : c.slice()));
  } else {
    const a = drag.idx, b = (drag.idx + 1) % 4;
    s.corners = o.map((c, i) => (i === a || i === b ? [c[0] + dx, c[1] + dy] : c.slice()));
  }
  changed();
});
const endDrag = () => { if (drag) { drag = null; commit(); refreshUI(); } };
viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);

/* ---------- keyboard */
const isTyping = () => {
  const a = document.activeElement;
  if (!a) return false;
  if (a.tagName === 'TEXTAREA') return true;
  if (a.tagName === 'INPUT') return !['checkbox', 'range', 'color', 'button'].includes(a.type);
  return false;
};
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (mod) {
    if (key === 'z' && !isTyping()) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (key === 's') { e.preventDefault(); saveProject(); }
    else if (key === 'o' && !e.shiftKey) { e.preventDefault(); openProject(); }
    else if (key === 'd' && !isTyping()) { e.preventDefault(); duplicateSurface(); }
    else if (key === 'g') { e.preventDefault(); toggleCalibrate(); }
    return;
  }
  if (isTyping()) return;
  if (document.activeElement && document.activeElement.tagName === 'SELECT') return;
  const s = selected();
  if (e.key === 'Escape') { sel.surface = null; sel.corner = null; refreshUI(); changed(); return; }
  if (!s) return;
  if (e.key === 'Tab') { e.preventDefault(); sel.corner = sel.corner == null ? 0 : (sel.corner + (e.shiftKey ? 3 : 1)) % 4; changed(); return; }
  if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSurface(s.id); return; }
  const step = e.shiftKey ? 10 : 1;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d && !s.locked) {
    e.preventDefault();
    s.corners = s.corners.map((c, i) => (sel.corner == null || sel.corner === i ? [c[0] + d[0], c[1] + d[1]] : c));
    changed();
    commitSoon();
  }
});

/* ---------- surface operations */
function addSurface(at, name) {
  const w = state.stage.w * 0.3, h = w * 9 / 16;
  const n = state.surfaces.length;
  const cx = at ? at[0] : state.stage.w / 2 + ((n % 6) - 2.5) * 30;
  const cy = at ? at[1] : state.stage.h / 2 + ((n % 6) - 2.5) * 30;
  const s = newSurface(cx - w / 2, cy - h / 2, w, h, name || `Surface ${n + 1}`);
  state.surfaces.push(s);
  sel.surface = s.id; sel.corner = null;
  return s;
}
function deleteSurface(id) {
  state.surfaces = state.surfaces.filter((s) => s.id !== id);
  if (sel.surface === id) { sel.surface = null; sel.corner = null; }
  commit(); refreshUI(); changed();
}
function duplicateSurface() {
  const s = selected();
  if (!s) return;
  const c = JSON.parse(JSON.stringify(s));
  c.id = uid();
  c.name = s.name + ' copy';
  c.corners = c.corners.map(([x, y]) => [x + 30, y + 30]);
  c.layers.forEach((L) => (L.id = uid()));
  state.surfaces.splice(state.surfaces.indexOf(s) + 1, 0, c);
  sel.surface = c.id;
  commit(); refreshUI(); changed();
}
function moveSurface(id, dir) {
  const i = state.surfaces.findIndex((s) => s.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= state.surfaces.length) return;
  [state.surfaces[i], state.surfaces[j]] = [state.surfaces[j], state.surfaces[i]];
  commit(); refreshUI(); changed();
}
const centroid = (c) => [c.reduce((a, p) => a + p[0], 0) / 4, c.reduce((a, p) => a + p[1], 0) / 4];
function transformSurface(s, fn) {
  const [cx, cy] = centroid(s.corners);
  s.corners = s.corners.map(([x, y]) => { const [nx, ny] = fn(x - cx, y - cy); return [nx + cx, ny + cy]; });
}
const OPS = {
  scaleUp: (s) => transformSurface(s, (x, y) => [x * 1.05, y * 1.05]),
  scaleDown: (s) => transformSurface(s, (x, y) => [x / 1.05, y / 1.05]),
  rotL: (s) => rotate(s, -5),
  rotR: (s) => rotate(s, 5),
  flipH: (s) => { const c = s.corners; s.corners = [c[1], c[0], c[3], c[2]]; },
  flipV: (s) => { const c = s.corners; s.corners = [c[3], c[2], c[1], c[0]]; },
  turn: (s) => { const c = s.corners; s.corners = [c[3], c[0], c[1], c[2]]; },
  reset: (s) => {
    const [w, h] = surfSize(s.corners), [cx, cy] = centroid(s.corners);
    s.corners = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
  },
  fill: (s) => { const { w, h } = state.stage; s.corners = [[0, 0], [w, 0], [w, h], [0, h]]; },
};
function rotate(s, deg) {
  const r = (deg * Math.PI) / 180, co = Math.cos(r), si = Math.sin(r);
  transformSurface(s, (x, y) => [x * co - y * si, x * si + y * co]);
}
function toggleCalibrate() {
  state.calibrate = !state.calibrate;
  $('calibrate').checked = state.calibrate;
  commit(); changed();
}

/* ---------- media */
let pickTarget = null;
function pickMedia(target) {
  pickTarget = target || { mode: 'newSurface' };
  if (NATIVE) post({ type: 'pickMedia' });
  else $('fileInput').click();
}
$('fileInput').addEventListener('change', () => {
  const files = [...$('fileInput').files];
  $('fileInput').value = '';
  handleMedia(files.map((f) => ({ url: URL.createObjectURL(f), name: f.name, kind: f.type.startsWith('video') ? 'video' : 'image' })), null);
});
PM.pickCancelled = () => { pickTarget = null; };
const toItems = (list) => list
  .map((u) => ({ url: u, name: fileName(u) }))
  .filter((it) => MEDIA_RE.test(it.name))
  .map((it) => ({ ...it, kind: VIDEO_RE.test(it.name) ? 'video' : 'image' }));
PM.onMedia = (urls, x, y, folders) => {
  urls = urls || [];
  const loose = toItems(urls);
  const groups = (folders || [])
    .map((f) => ({ name: String(f.name || 'Folder').slice(0, 40), items: toItems(f.urls || []) }))
    .filter((g) => g.items.length);
  if (urls.length > loose.length) PM.toast(`Skipped ${urls.length - loose.length} file(s) that aren't images or videos`);
  if (!loose.length && !groups.length) { pickTarget = null; PM.toast('No images, GIFs or videos found there'); return; }
  handleMedia(loose, x == null ? null : { x, y }, groups);
};
function probeAspect(item) {
  return new Promise((resolve) => {
    if (item.kind === 'video') {
      const v = document.createElement('video');
      v.preload = 'metadata'; v.muted = true;
      v.onloadedmetadata = () => resolve(v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : null);
      v.onerror = () => resolve(null);
      v.src = item.url;
    } else {
      const im = new Image();
      im.onload = () => resolve(im.naturalWidth && im.naturalHeight ? im.naturalWidth / im.naturalHeight : null);
      im.onerror = () => resolve(null);
      im.src = item.url;
    }
  });
}

const mediaProps = (it) => ({ src: it.url, name: it.name, kind: it.kind });
const plItem = (it) => ({ src: it.url, name: it.name, kind: it.kind });

// One new surface per file, shaped to the media's real aspect ratio once it loads.
function addMediaSurface(it, at) {
  const s = addSurface(at, it.name.replace(/\.[^.]+$/, '').slice(0, 40));
  s.layers.push(newLayer('media', mediaProps(it)));
  const snapshot = JSON.stringify(s.corners);
  probeAspect(it).then((ratio) => {
    if (!ratio || JSON.stringify(s.corners) !== snapshot) return;
    const [w0] = surfSize(s.corners), [cx, cy] = centroid(s.corners);
    let w = w0, h = w / ratio;
    if (h > state.stage.h * 0.6) { h = state.stage.h * 0.6; w = h * ratio; }
    s.corners = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
    if (hist.stack[hist.i]) hist.stack[hist.i] = JSON.stringify(state); // fold into the same undo step
    scheduleAutosave();
    changed();
  });
}

// A folder dropped on empty stage becomes a tidy grid of surfaces filling the stage.
function addGrid(items, label) {
  const MAX = 48;
  if (items.length > MAX) {
    PM.toast(`“${label}” has ${items.length} files — placed the first ${MAX}. Tip: drop the folder onto a surface to make a playlist instead.`);
    items = items.slice(0, MAX);
  }
  const W = state.stage.w, H = state.stage.h, n = items.length;
  const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
  const gap = Math.min(W, H) * 0.015;
  const cw = (W - gap * (cols + 1)) / cols, ch = (H - gap * (rows + 1)) / rows;
  items.forEach((it, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const s = newSurface(gap + c * (cw + gap), gap + r * (ch + gap), cw, ch, `${label} ${i + 1}`);
    s.layers.push(newLayer('media', mediaProps(it)));
    state.surfaces.push(s);
    sel.surface = s.id;
  });
}

function handleMedia(items, dropPt, groups) {
  groups = groups || [];
  const all = items.concat(...groups.map((g) => g.items));
  if (!all.length) return;
  let target = pickTarget || { mode: 'newSurface' };
  pickTarget = null;
  if (dropPt) {
    const el = document.elementFromPoint(dropPt.x, dropPt.y);
    const sEl = el && el.closest && el.closest('.surface');
    target = sEl ? { mode: 'addLayer', sid: sEl.dataset.sid } : { mode: 'newSurface', at: toStage(dropPt.x, dropPt.y) };
  }
  const s = target.sid ? findSurface(target.sid) : null;
  const L = s && target.lid ? s.layers.find((l) => l.id === target.lid) : null;

  if (target.mode === 'replace' && L) {
    Object.assign(L, mediaProps(all[0]));
  } else if (target.mode === 'playlistAdd' && L) {
    L.items.push(...all.map(plItem));
    PM.toast(`Added ${all.length} item(s) to the playlist`);
  } else if ((target.mode === 'addLayer' || target.mode === 'newPlaylist') && s) {
    if (all.length === 1 && target.mode === 'addLayer') {
      s.layers.push(newLayer('media', mediaProps(all[0])));
      PM.toast(`Added “${all[0].name}” to ${s.name}`);
    } else {
      s.layers.push(newLayer('playlist', { items: all.map(plItem) }));
      PM.toast(`Made a ${all.length}-item playlist on ${s.name} — it cycles every 5s`);
    }
    sel.surface = s.id;
  } else {
    items.forEach((it, n) => addMediaSurface(it, target.at ? [target.at[0] + n * 30, target.at[1] + n * 30] : null));
    groups.forEach((g) => addGrid(g.items, g.name));
    if (groups.length) PM.toast(`Laid out ${groups.map((g) => g.items.length).reduce((a, b) => a + b, 0)} files as a grid`);
  }
  commit(); refreshUI(); changed();
}

// Browser-only drag & drop (the Mac app intercepts drops natively to get real file paths).
if (!NATIVE) {
  viewport.addEventListener('dragover', (e) => { e.preventDefault(); viewport.classList.add('dragover'); });
  viewport.addEventListener('dragleave', () => viewport.classList.remove('dragover'));
  viewport.addEventListener('drop', (e) => {
    e.preventDefault();
    viewport.classList.remove('dragover');
    const files = [...e.dataTransfer.files].filter((f) => /^(image|video)\//.test(f.type));
    handleMedia(files.map((f) => ({ url: URL.createObjectURL(f), name: f.name, kind: f.type.startsWith('video') ? 'video' : 'image' })),
      { x: e.clientX, y: e.clientY });
  });
}

/* ---------- projects */
function saveProject() {
  const j = JSON.stringify(state, null, 2);
  if (NATIVE) return post({ type: 'save', json: j });
  const hasBlobs = state.surfaces.some((s) => s.layers.some((L) => String(L.src || '').startsWith('blob:')));
  if (hasBlobs) PM.toast('Note: media added in the browser can’t be saved. Use the Mac app for portable projects.');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([j], { type: 'application/json' }));
  a.download = 'mapping.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function openProject() {
  if (NATIVE) post({ type: 'open' });
  else $('projectInput').click();
}
$('projectInput').addEventListener('change', async () => {
  const f = $('projectInput').files[0];
  $('projectInput').value = '';
  if (f) PM.loadProject(await f.text());
});
PM.loadProject = (text) => {
  let raw;
  try { raw = JSON.parse(text); } catch { PM.toast('That file isn’t a valid Beam project'); return; }
  state = normalize(raw);
  sel.surface = null;
  commit();
  afterLoad();
  PM.toast(`Loaded ${state.surfaces.length} surface(s)`);
};

/* ---------- output selection (native) */
let mirrored = false;
PM.setScreens = (list, current, mir) => {
  screens = list || [];
  currentOutput = current;
  mirrored = !!mir;
  const s = $('outputSel');
  s.innerHTML = '';
  const opt = (v, label) => { const o = document.createElement('option'); o.value = v; o.textContent = label; s.appendChild(o); };
  opt(-1, 'Preview window');
  screens.forEach((sc) => opt(sc.index, `Fullscreen on ${sc.name} (${sc.w}×${sc.h})${sc.editor ? ' — this screen' : ''}`));
  opt(-2, 'Hidden');
  s.value = String(current);
  renderProjector();
  // Keep the stage the same shape as the projector so the editor preview matches the wall.
  const sc = screens.find((x) => x.index === current);
  if (sc && !sc.editor && (sc.w !== state.stage.w || sc.h !== state.stage.h)) setStageSize(sc.w, sc.h);
  renderStagePanel();
};
function renderProjector() {
  const pill = $('projPill');
  const sc = screens.find((x) => x.index === currentOutput);
  pill.textContent = '';
  if (mirrored) {
    pill.className = 'pill warn';
    pill.append(h('span', { class: 'dot' }), 'Projector is mirroring your screen',
      h('button', { class: 'small', onclick: () => post({ type: 'unmirror' }) }, 'Fix it'),
      h('button', { class: 'small ghost', onclick: () => post({ type: 'displaySettings' }) }, 'Settings'));
  } else if (sc && !sc.editor) {
    pill.className = 'pill live';
    pill.append(h('span', { class: 'dot' }), `Projecting on ${sc.name}`);
  } else if (sc) {
    pill.className = 'pill warn';
    pill.append(h('span', { class: 'dot' }), 'Covering this screen — press Esc on it');
  } else {
    pill.className = 'pill idle';
    pill.append(h('span', { class: 'dot' }), currentOutput === -2 ? 'Output hidden' : 'No projector — plug in HDMI');
  }
}
$('outputSel').addEventListener('change', (e) => {
  const v = +e.target.value;
  const sc = screens.find((x) => x.index === v);
  if (sc && sc.editor) PM.toast('Output covers this screen — press Esc on it to come back');
  post({ type: 'setOutput', screen: v });
  e.target.blur();
});

/* ---------- toolbar / menu */
const ACTIONS = {
  addSurface: () => {
    const s = addSurface();
    const pal = PALETTE[(state.surfaces.length - 1) % PALETTE.length];
    s.layers.push(newLayer('gradient', { c1: pal[0], c2: pal[1] }));
    commit(); refreshUI(); changed();
  },
  addMedia: () => pickMedia({ mode: 'newSurface' }),
  undo, redo,
  save: saveProject,
  open: openProject,
  duplicate: duplicateSurface,
  calibrate: toggleCalibrate,
  tutorial: () => openTutorial(0),
  demo: () => loadDemo(),
  openOutput: () => window.open(location.pathname + '?mode=output', 'beam-output', 'width=960,height=540'),
};
document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => { ACTIONS[b.dataset.act](); b.blur(); }));
$('calibrate').addEventListener('change', () => { state.calibrate = $('calibrate').checked; commit(); changed(); });
PM.menu = (name) => {
  if ((name === 'undo' || name === 'redo') && isTyping()) { document.execCommand(name); return; }
  if (name === 'duplicate' && isTyping()) return;
  ACTIONS[name] && ACTIONS[name]();
};
if (bc) bc.onmessage = (e) => { if (e.data === 'hello') broadcast(); };

/* ================================================================ PANELS */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
const row = (label, ...ctrl) => h('label', { class: 'row' }, h('span', {}, label), h('div', { class: 'pair' }, ...ctrl));

// Controls write straight into the model: 'input' re-renders live, 'change' records an undo step.
function slider(obj, key, min, max, step, fmt) {
  const out = h('span', { class: 'val' });
  const show = () => (out.textContent = fmt ? fmt(obj[key]) : obj[key]);
  const i = h('input', {
    type: 'range', min, max, step,
    oninput: () => { obj[key] = +i.value; show(); changed(); },
    onchange: commit,
  });
  i.value = obj[key];
  show();
  return h('div', { class: 'slider', style: 'flex:1' }, i, out);
}
function colorIn(obj, key) {
  const i = h('input', { type: 'color', oninput: () => { obj[key] = i.value; changed(); }, onchange: commit });
  i.value = safeColor(obj[key], '#ffffff').slice(0, 7);
  return i;
}
function selectIn(obj, key, options, after) {
  const s = h('select', {
    onchange: () => { obj[key] = typeof obj[key] === 'number' ? +s.value : s.value; changed(); commit(); after && after(); },
  }, ...Object.entries(options).map(([v, label]) => h('option', { value: v }, label)));
  s.value = String(obj[key]);
  return s;
}
function textIn(obj, key, multiline, after) {
  const i = h(multiline ? 'textarea' : 'input', {
    type: multiline ? null : 'text',
    oninput: () => { obj[key] = i.value; changed(); after && after(); },
    onchange: commit,
  });
  i.value = obj[key];
  return i;
}
function checkIn(obj, key, label) {
  const i = h('input', { type: 'checkbox', onchange: () => { obj[key] = i.checked; changed(); commit(); } });
  i.checked = !!obj[key];
  return h('label', { class: 'toggle', style: 'padding:2px 0' }, i, h('span', {}, label));
}
function numIn(value, onSet) {
  const i = h('input', { type: 'number', min: 64, max: 16384, onchange: () => onSet(+i.value) });
  i.value = value;
  return i;
}
const opts = (arr) => Object.fromEntries(arr.map((v) => [v, v]));
const swatchColor = (i) => `hsl(${(i * 67) % 360},100%,62%)`;

function refreshUI() {
  renderList();
  renderStagePanel();
  renderInspector();
  $('calibrate').checked = state.calibrate;
}

function renderList() {
  const list = $('surfaceList');
  list.textContent = '';
  if (!state.surfaces.length) { list.append(h('div', { class: 'emptylist' }, 'No surfaces yet.')); return; }
  [...state.surfaces].reverse().forEach((s) => {
    const idx = state.surfaces.indexOf(s);
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
    list.append(h('div', {
      class: `item${s.id === sel.surface ? ' sel' : ''}${s.visible ? '' : ' hidden'}`,
      onclick: () => { sel.surface = s.id; sel.corner = null; refreshUI(); changed(); },
    },
    h('span', { class: 'swatch', style: `background:${swatchColor(idx)}` }),
    h('span', { class: 'name' }, s.name),
    h('button', { class: `ib${s.visible ? ' on' : ''}`, title: s.visible ? 'Hide' : 'Show', onclick: stop(() => { s.visible = !s.visible; commit(); refreshUI(); changed(); }) }, s.visible ? '◉' : '○'),
    h('button', { class: `ib${s.locked ? ' warn' : ''}`, title: s.locked ? 'Unlock' : 'Lock position', onclick: stop(() => { s.locked = !s.locked; commit(); refreshUI(); changed(); }) }, s.locked ? '🔒' : '🔓'),
    h('button', { class: 'ib', title: 'Bring forward', onclick: stop(() => moveSurface(s.id, 1)) }, '▲'),
    h('button', { class: 'ib', title: 'Send backward', onclick: stop(() => moveSurface(s.id, -1)) }, '▼')));
  });
}

function setStageSize(w, hgt) {
  w = clamp(Math.round(w) || 1920, 64, 16384);
  hgt = clamp(Math.round(hgt) || 1080, 64, 16384);
  const fx = w / state.stage.w, fy = hgt / state.stage.h;
  // Scale existing mappings so they stay put relative to the stage.
  state.surfaces.forEach((s) => (s.corners = s.corners.map(([x, y]) => [x * fx, y * fy])));
  state.stage.w = w; state.stage.h = hgt;
  commit(); layout(); refreshUI(); changed();
}
function renderStagePanel() {
  const p = $('stagePanel');
  p.textContent = '';
  const out = screens.find((s) => s.index === currentOutput);
  p.append(h('div', { class: 'group' },
    row('Size', numIn(state.stage.w, (v) => setStageSize(v, state.stage.h)), numIn(state.stage.h, (v) => setStageSize(state.stage.w, v))),
    row('Background', colorIn(state.stage, 'bg')),
    out ? h('div', { class: 'btns', style: 'padding:4px 0 0' },
      h('button', { class: 'small', onclick: () => setStageSize(out.w, out.h) }, `Match output (${out.w}×${out.h})`)) : null));
  p.querySelector('input[type=color]').addEventListener('input', () => layout());
}

function renderInspector() {
  const box = $('inspector');
  box.textContent = '';
  const s = selected();
  if (!s) {
    box.append(h('div', { class: 'hint' },
      h('div', { style: 'font-size:14px;color:var(--text);font-weight:600;margin:6px 0 8px' }, 'Quick start'),
      h('div', {}, '1. Point your projector at the object and pick it under ', h('b', {}, 'Output'), '.'),
      h('div', {}, '2. Add a ', h('b', {}, 'Surface'), ' for each face you want to light up.'),
      h('div', {}, '3. Turn on ', h('b', {}, 'Calibrate'), ' and drag corners until the grid lines up with the real object.'),
      h('div', {}, '4. Drop GIFs, images or videos onto a surface to add them as layers.'),
      h('div', {}, '5. Stack layers with blend modes and animations. Save when you’re done.'),
      h('div', { style: 'margin-top:10px' }, 'Select a surface to edit it.')));
    return;
  }

  box.append(textIn(s, 'name', false, () => renderList()));
  box.lastChild.className = 'title-input';

  box.append(h('div', { class: 'panel-title' }, 'Surface'),
    h('div', { class: 'group' },
      row('Opacity', slider(s, 'opacity', 0, 1, 0.01, (v) => Math.round(v * 100) + '%')),
      row('Blend', selectIn(s, 'blend', opts(BLENDS))),
      row('Shape', selectIn(s, 'shape', { rect: 'Rectangle', ellipse: 'Ellipse' }))),
    h('div', { class: 'panel-title' }, 'Warp'),
    h('div', { class: 'btns' }, ...[
      ['−', 'scaleDown', 'Shrink 5%'], ['+', 'scaleUp', 'Grow 5%'], ['⟲', 'rotL', 'Rotate −5°'], ['⟳', 'rotR', 'Rotate +5°'],
      ['⇋', 'flipH', 'Flip horizontally'], ['⇵', 'flipV', 'Flip vertically'], ['↻90', 'turn', 'Rotate content 90°'],
    ].map(([label, op, title]) => h('button', { class: 'small', title, onclick: () => { if (s.locked) return PM.toast('Surface is locked'); OPS[op](s); commit(); changed(); } }, label))),
    h('div', { class: 'btns' },
      h('button', { class: 'small', onclick: () => { if (s.locked) return PM.toast('Surface is locked'); OPS.reset(s); commit(); changed(); } }, 'Unwarp'),
      h('button', { class: 'small', onclick: () => { if (s.locked) return PM.toast('Surface is locked'); OPS.fill(s); commit(); changed(); } }, 'Fill stage'),
      h('button', { class: 'small', onclick: duplicateSurface }, 'Duplicate'),
      h('button', { class: 'small danger', onclick: () => deleteSurface(s.id) }, 'Delete')));

  const addSel = h('select', {
    onchange: () => {
      const t = addSel.value;
      addSel.value = '';
      if (!t) return;
      if (t === 'media') return pickMedia({ mode: 'addLayer', sid: s.id });
      if (t === 'playlist') return pickMedia({ mode: 'newPlaylist', sid: s.id });
      s.layers.push(newLayer(t));
      commit(); renderInspector(); changed();
    },
  }, h('option', { value: '' }, '+ Add layer'), ...Object.entries(LAYER_TYPES).map(([k, v]) => h('option', { value: k }, k === 'media' ? 'Media (image / GIF / video)…' : k === 'playlist' ? 'Playlist (many files, cycles)…' : v)));
  box.append(h('div', { class: 'layers-head' }, h('div', { class: 'panel-title' }, `Layers (${s.layers.length})`), addSel));

  if (!s.layers.length) box.append(h('div', { class: 'hint' }, 'Empty surface. Add a layer or drop media onto it.'));
  [...s.layers].reverse().forEach((L) => box.append(layerCard(s, L)));
}

function layerCard(s, L) {
  const idx = s.layers.indexOf(L);
  const move = (dir) => {
    const j = idx + dir;
    if (j < 0 || j >= s.layers.length) return;
    [s.layers[idx], s.layers[j]] = [s.layers[j], s.layers[idx]];
    commit(); renderInspector(); changed();
  };
  const title = L.type === 'media' ? L.name || 'Media' : L.type === 'text' ? `“${L.text.slice(0, 18)}”`
    : L.type === 'playlist' ? `Playlist (${L.items.length})` : LAYER_TYPES[L.type];
  const body = h('div', { class: 'card-body' });
  const add = (...kids) => body.append(...kids.filter((k) => k != null)); // append(null) would print "null"
  const card = h('div', { class: `card${collapsed.has(L.id) ? ' collapsed' : ''}${L.visible ? '' : ' off'}` },
    h('div', { class: 'card-head' },
      h('button', { class: 'ib', title: 'Collapse', onclick: () => { collapsed.has(L.id) ? collapsed.delete(L.id) : collapsed.add(L.id); card.classList.toggle('collapsed'); } }, '▾'),
      h('span', { class: 't' }, title, h('small', {}, L.type === 'media' ? L.kind : '')),
      h('button', { class: `ib${L.visible ? ' on' : ''}`, title: 'Toggle visibility', onclick: () => { L.visible = !L.visible; commit(); renderInspector(); changed(); } }, L.visible ? '◉' : '○'),
      h('button', { class: 'ib', title: 'Move up', onclick: () => move(1) }, '▲'),
      h('button', { class: 'ib', title: 'Move down', onclick: () => move(-1) }, '▼'),
      h('button', { class: 'ib', title: 'Delete layer', onclick: () => { s.layers.splice(s.layers.indexOf(L), 1); commit(); renderInspector(); changed(); } }, '✕')),
    body);

  switch (L.type) {
    case 'color':
      add(row('Color', colorIn(L, 'color')));
      break;
    case 'gradient':
      add(row('Colors', colorIn(L, 'c1'), colorIn(L, 'c2')),
        row('Type', selectIn(L, 'kind', { linear: 'Linear', radial: 'Radial' })),
        row('Angle', slider(L, 'angle', 0, 360, 1, (v) => v + '°')));
      break;
    case 'media':
      add(
        row('Fit', selectIn(L, 'fit', { cover: 'Cover (crop)', contain: 'Contain', fill: 'Stretch' })),
        L.kind === 'video' ? row('Speed', slider(L, 'rate', 0.1, 4, 0.05, (v) => v.toFixed(2) + '×')) : null,
        L.kind === 'video' ? row('', checkIn(L, 'audio', 'Play audio on output')) : null,
        row('', h('button', { class: 'small', onclick: () => pickMedia({ mode: 'replace', sid: s.id, lid: L.id }) }, 'Replace…')));
      break;
    case 'playlist':
      add(
        row('Each item', slider(L, 'duration', 1, 60, 1, (v) => v + 's')),
        row('Crossfade', slider(L, 'fade', 0, 5, 0.1, (v) => v.toFixed(1) + 's')),
        row('Fit', selectIn(L, 'fit', { cover: 'Cover (crop)', contain: 'Contain', fill: 'Stretch' })),
        h('div', { class: 'pl-list' }, ...L.items.map((it, i) => h('div', { class: 'pl-item' },
          h('span', { class: 'pl-n' }, String(i + 1)),
          h('span', { class: 'pl-name', title: it.name }, it.name),
          h('button', { class: 'ib', title: 'Move earlier', onclick: () => { if (i > 0) { [L.items[i - 1], L.items[i]] = [L.items[i], L.items[i - 1]]; commit(); renderInspector(); changed(); } } }, '▲'),
          h('button', { class: 'ib', title: 'Remove', onclick: () => { L.items.splice(i, 1); commit(); renderInspector(); changed(); } }, '✕')))),
        row('', h('button', { class: 'small', onclick: () => pickMedia({ mode: 'playlistAdd', sid: s.id, lid: L.id }) }, '+ Add files or a folder…')));
      break;
    case 'text':
      add(row('Text', textIn(L, 'text', true)),
        row('Color', colorIn(L, 'color'), selectIn(L, 'weight', { 300: 'Light', 400: 'Regular', 600: 'Semibold', 800: 'Heavy' })),
        row('Font', selectIn(L, 'font', opts(FONTS))),
        row('Size', slider(L, 'size', 2, 120, 1, (v) => v + '%')));
      break;
    case 'grid':
      add(row('Color', colorIn(L, 'color')), row('Cells', slider(L, 'div', 1, 32, 1)));
      break;
  }
  add(
    row('Opacity', slider(L, 'opacity', 0, 1, 0.01, (v) => Math.round(v * 100) + '%')),
    row('Blend', selectIn(L, 'blend', opts(BLENDS))),
    row('Animate', selectIn(L, 'anim', Object.fromEntries(Object.keys(ANIMS).map((k) => [k, k[0].toUpperCase() + k.slice(1)])), () => renderInspector())),
    L.anim !== 'none' ? row('Speed', slider(L, 'speed', 0.1, 5, 0.05, (v) => v.toFixed(2) + '×')) : null);
  return card;
}

/* ================================================================ DEMO + TUTORIAL */
function loadDemo() {
  const W = state.stage.w, H = state.stage.h;
  const P = (x, y) => [x * W, y * H];
  const left = newSurface(0, 0, 1, 1, 'Demo · Left face');
  left.corners = [P(0.14, 0.24), P(0.49, 0.16), P(0.49, 0.86), P(0.14, 0.76)];
  left.layers.push(newLayer('gradient', { c1: '#00e5ff', c2: '#7c4dff', anim: 'hue' }),
    newLayer('text', { text: 'BEAM', font: 'Futura', size: 34 }));
  const right = newSurface(0, 0, 1, 1, 'Demo · Right face');
  right.corners = [P(0.49, 0.16), P(0.86, 0.26), P(0.86, 0.78), P(0.49, 0.86)];
  right.layers.push(newLayer('gradient', { c1: '#ff4fa3', c2: '#ffb84f', angle: 135 }),
    newLayer('grid', { div: 6, opacity: 0.4, anim: 'pulse' }));
  const orb = newSurface(0, 0, 1, 1, 'Demo · Orb');
  orb.corners = [P(0.6, 0.38), P(0.75, 0.38), P(0.75, 0.62), P(0.6, 0.62)];
  orb.shape = 'ellipse';
  orb.blend = 'screen';
  orb.layers.push(newLayer('gradient', { kind: 'radial', c1: '#ffffff', c2: '#ff4fa3', anim: 'breathe' }));
  state.surfaces.push(left, right, orb);
  sel.surface = left.id; sel.corner = null;
  commit(); refreshUI(); changed();
  PM.toast('Demo loaded — drag the corners around, then try Calibrate');
}

const TG = '<defs><linearGradient id="tg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00e5ff"/><stop offset=".45" stop-color="#7c4dff"/><stop offset=".8" stop-color="#ff4fa3"/><stop offset="1" stop-color="#ffd34f"/></linearGradient></defs>';
const QUAD = 'M200 40 L320 22 L326 156 L196 140Z';
const TUTORIAL = [
  {
    title: 'Welcome to Beam',
    art: '<img class="tut-logo" src="logo.png" alt="">',
    body: `<p>Beam turns any projector into a <b>projection-mapping rig</b>. You shape glowing <b>surfaces</b> to fit real things (a wall, boxes, a stage, a building) and fill them with GIFs, videos and effects.</p>
      <p>This walkthrough takes about two minutes. Reopen it any time from <b>Help → Beam Tutorial</b> or the <b>?</b> button.</p>`,
  },
  {
    title: '1 · Plug in the projector',
    art: `<svg viewBox="0 0 360 180">${TG}<rect x="18" y="62" width="86" height="56" rx="6" fill="#232731" stroke="#5b8cff" stroke-width="2"/><rect x="8" y="118" width="106" height="8" rx="4" fill="#3a4157"/><text x="61" y="95" text-anchor="middle" fill="#8b92a3" font-size="10">editor</text><path d="M112 120 C140 168 160 160 172 128" fill="none" stroke="#ffd34f" stroke-width="4" stroke-linecap="round"/><text x="128" y="172" fill="#ffd34f" font-size="11" font-weight="700">HDMI</text><rect x="164" y="104" width="58" height="30" rx="7" fill="#2a2f3b" stroke="#8b92a3"/><circle cx="210" cy="119" r="9" fill="#bfe9ff"/><path d="M216 112 L320 22 L326 156 L216 126Z" fill="#8fb4ff" opacity=".16"/><path d="M290 26 L320 22 L326 156 L292 152Z" fill="url(#tg)"/><text x="300" y="174" fill="#3dffa8" font-size="11" font-weight="700" text-anchor="middle">wall</text></svg>`,
    body: `<p>Connect the projector with an <b>HDMI cable</b> (use a USB-C/Thunderbolt-to-HDMI adapter if your Mac needs one).</p>
      <p><b>That's it.</b> Beam detects it and sends the projection there <b>fullscreen</b>, with only your mapping on it: no menus, no cursor. Your Mac screen keeps the editor. The projector briefly says <i>“Beam is connected.”</i></p>
      <p>The status at the top right tells you what's happening: <span class="chip live">green = projecting</span>. If it says <span class="chip warn">mirroring</span>, click <b>Fix it</b>.</p>`,
  },
  {
    title: '2 · Add a surface for each thing you light up',
    art: `<svg viewBox="0 0 360 180">${TG}<path d="${QUAD}" fill="url(#tg)" opacity=".9"/><path d="${QUAD}" fill="none" stroke="#fff" stroke-width="2"/><g fill="#fff" stroke="#5b8cff" stroke-width="3"><circle cx="200" cy="40" r="7"/><circle cx="320" cy="22" r="7"/><circle cx="326" cy="156" r="7"/><circle cx="196" cy="140" r="7"/></g><g fill="#5b8cff"><rect x="256" y="27" width="8" height="8" rx="2"/><rect x="319" y="85" width="8" height="8" rx="2"/></g><path d="M150 40 L188 40" stroke="#ff4fa3" stroke-width="3" marker-end="url(#ar)"/><defs><marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#ff4fa3"/></marker></defs><text x="40" y="44" fill="#e8eaf0" font-size="12">drag corners</text><text x="40" y="100" fill="#e8eaf0" font-size="12">drag middle = move</text><text x="40" y="150" fill="#e8eaf0" font-size="12">edge squares = slant</text></svg>`,
    body: `<p>Click <b>+ Surface</b>. A surface is a shape you stretch over <b>one real object or one face</b> of it. For a box you'd use one surface per visible side.</p>
      <ul><li><b>Drag the middle</b> to move it.</li><li><b>Drag the white corner dots</b> to pin each corner to a corner of the real object. This is how you bend it into perspective.</li><li><b>Drag the small edge squares</b> to slant one side.</li></ul>`,
  },
  {
    title: '3 · Line it up with Calibrate',
    art: `<svg viewBox="0 0 360 180">${TG}<path d="${QUAD}" fill="#1b1e25"/><g stroke="#3dffa8" stroke-width="1.5" fill="none"><path d="${QUAD}" stroke-width="3"/><path d="M230 35.5 L228.5 144 M260 31 L261 148 M290 26.5 L293.5 152 M199 65 L321.5 51 M198 90 L323 84 M197 115 L324.5 117"/><ellipse cx="261" cy="90" rx="40" ry="44"/></g><text x="261" y="94" fill="#fff" font-size="13" font-weight="700" text-anchor="middle">1 · Wall</text><text x="30" y="70" fill="#e8eaf0" font-size="12">Look at the wall,</text><text x="30" y="88" fill="#e8eaf0" font-size="12">not your screen.</text><text x="30" y="118" fill="#8b92a3" font-size="11">Circle round = done ✓</text></svg>`,
    body: `<p>Turn on <b>Calibrate</b> (⌘G). Every surface shows a numbered grid with a circle <b>on the projector</b>.</p>
      <p>Look at the real object and drag corners until the grid sits flat on it and <b>the circle looks round</b>. For precision: <kbd>Tab</kbd> picks a corner, arrow keys nudge 1px (<kbd>⇧</kbd> = 10px). Corners snap to each other so neighbouring faces meet cleanly.</p>
      <p>When a surface is perfect, click its <b>🔓</b> in the left list to lock it.</p>`,
  },
  {
    title: '4 · Fill it with GIFs, videos & images',
    art: `<svg viewBox="0 0 360 180">${TG}<g font-size="10" font-weight="700" text-anchor="middle"><rect x="18" y="22" width="44" height="54" rx="5" fill="#2a2f3b" stroke="#ff4fa3"/><text x="40" y="54" fill="#ff4fa3">GIF</text><rect x="70" y="22" width="44" height="54" rx="5" fill="#2a2f3b" stroke="#00e5ff"/><text x="92" y="54" fill="#00e5ff">MP4</text><rect x="122" y="22" width="44" height="54" rx="5" fill="#2a2f3b" stroke="#ffd34f"/><text x="144" y="54" fill="#ffd34f">JPG</text><path d="M30 112 h26 l8 8 h42 v44 h-76z" fill="#5b8cff" opacity=".85"/><text x="68" y="148" fill="#fff">folder</text></g><path d="M170 50 L196 60" stroke="#fff" stroke-width="2"/><path d="M112 140 L196 120" stroke="#fff" stroke-width="2"/><path d="${QUAD}" fill="url(#tg)"/><g stroke="#0b0c0f" stroke-width="3"><path d="M258 31 L261 148 M198 90 L323 89"/></g></svg>`,
    body: `<p><b>Drag files from Finder</b> onto the stage, or click <b>+ Media</b> (hold <kbd>⌘</kbd> or <kbd>⇧</kbd> to pick many at once). GIFs and videos loop automatically.</p>
      <ul><li>Drop on <b>empty space</b>: each file gets its own surface.</li><li>Drop on <b>a surface</b>: it fills that surface. Several files at once become a <b>Playlist</b> that cycles with crossfades.</li><li>Drop a <b>whole folder</b> on empty space for a neat grid of surfaces, or onto a surface for a playlist.</li></ul>`,
  },
  {
    title: '5 · Stack layers & effects',
    art: `<svg viewBox="0 0 360 180">${TG}<g transform="translate(110 30)"><path d="M0 100 L90 120 L180 100 L90 80Z" fill="#7c4dff" opacity=".9"/><path d="M0 75 L90 95 L180 75 L90 55Z" fill="#ff4fa3" opacity=".85"/><path d="M0 50 L90 70 L180 50 L90 30Z" fill="url(#tg)"/><path d="M0 25 L90 45 L180 25 L90 5Z" fill="#fff" opacity=".25"/></g><g fill="#8b92a3" font-size="11"><text x="20" y="62">Text</text><text x="20" y="88">Media</text><text x="20" y="112">Playlist</text><text x="20" y="136">Gradient</text></g></svg>`,
    body: `<p>Select a surface and use <b>+ Add layer</b> on the right: Color, Gradient, Media, Playlist, Text or Grid. Layers higher in the list sit on top.</p>
      <p>Every layer has <b>Opacity</b>, a <b>Blend</b> mode (try <i>Screen</i> or <i>Overlay</i>) and an <b>Animate</b> effect: pulse, strobe, flicker, hue cycle, spin, breathe or slide. They even work on still images.</p>`,
  },
  {
    title: '6 · Showtime',
    art: `<svg viewBox="0 0 360 180">${TG}<circle cx="70" cy="90" r="26" fill="#14161e" stroke="#3a4157" stroke-width="5"/><circle cx="70" cy="90" r="11" fill="#bfe9ff"/><path d="M90 78 L300 24 L306 160 L90 102Z" fill="#8fb4ff" opacity=".15"/><path d="M240 34 L300 24 L306 160 L238 148Z" fill="url(#tg)"/><text x="170" y="96" fill="#3dffa8" font-size="30" font-weight="800" text-anchor="middle">✓</text></svg>`,
    body: `<ul><li><b>Save</b> your mapping with ⌘S. Beam also autosaves constantly.</li><li>Your Mac and the projector <b>won't go to sleep</b> while Beam is projecting.</li><li>Unplug HDMI and the output returns to a preview window. Plug it back in and it jumps straight back to the projector.</li><li>Pressing <kbd>Esc</kbd> on a fullscreen output always gets you out.</li></ul>`,
    final: true,
  },
];
let tutStep = 0;
function openTutorial(step) {
  tutStep = step || 0;
  $('tutorial').hidden = false;
  renderTutorial();
}
function closeTutorial() {
  $('tutorial').hidden = true;
  if (NATIVE) post({ type: 'tutorialSeen' });
  else { try { localStorage.setItem('beam.tutorialSeen', '1'); } catch { /* ignore */ } }
}
function renderTutorial() {
  const t = TUTORIAL[tutStep];
  const box = $('tutorial');
  // Static, author-written content only, so innerHTML is safe here.
  box.innerHTML = `<div class="tut-card"><button class="tut-x" title="Close">✕</button><div class="tut-art">${t.art}</div>
    <div class="tut-body"><h2>${t.title}</h2>${t.body}</div>
    <div class="tut-foot"><div class="dots">${TUTORIAL.map((_, i) => `<span class="${i === tutStep ? 'on' : ''}"></span>`).join('')}</div>
    <div class="tut-btns">${tutStep ? '<button data-t="back">Back</button>' : '<button data-t="skip">Skip</button>'}
    ${t.final ? '<button data-t="demo">Load demo scene</button><button class="primary" data-t="done">Start mapping</button>' : '<button class="primary" data-t="next">Next</button>'}</div></div></div>`;
}
$('tutorial').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (e.target.id === 'tutorial' || (b && b.classList.contains('tut-x'))) return closeTutorial();
  if (!b) return;
  const a = b.dataset.t;
  if (a === 'next') { tutStep = Math.min(TUTORIAL.length - 1, tutStep + 1); renderTutorial(); }
  else if (a === 'back') { tutStep = Math.max(0, tutStep - 1); renderTutorial(); }
  else if (a === 'skip' || a === 'done') closeTutorial();
  else if (a === 'demo') { closeTutorial(); loadDemo(); }
});
document.addEventListener('keydown', (e) => {
  if ($('tutorial').hidden) return;
  if (e.key === 'Escape') { e.stopImmediatePropagation(); closeTutorial(); }
  else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.stopImmediatePropagation(); if (tutStep < TUTORIAL.length - 1) { tutStep++; renderTutorial(); } else closeTutorial(); }
  else if (e.key === 'ArrowLeft') { e.stopImmediatePropagation(); if (tutStep) { tutStep--; renderTutorial(); } }
}, true);

/* ---------- boot */
commit();
layout();
refreshUI();
changed();
post({ type: 'ready' });
if (!NATIVE) PM.setScreens([], -1, false);
let seen = window.__PM_TUTORIAL_SEEN;
if (!NATIVE) { try { seen = !!localStorage.getItem('beam.tutorialSeen'); } catch { seen = false; } }
if (!seen) openTutorial(0);
})();
