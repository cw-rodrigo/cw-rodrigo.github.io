// Playlist (como a do FL Studio) num canvas: faixas livres com clipes de padrão, de áudio e de automação.
// Clique num espaço vazio pinta o padrão escolhido; arraste move; bordas cortam/alongam; Shift+arrastar
// duplica; botão direito apaga (arrastando, apaga vários); Alt desliga a grade. Régua: clique posiciona,
// arraste na metade de cima marca o loop.
import { spb, clipEnd, songEnd, cachedAudio, patternOf, patternLength } from './project.js';
import { valueAt } from './automation.js';

export const TH = 46, RH = 26;

function theme() {
  const dark = document.documentElement.dataset.bsTheme === 'dark';
  return dark
    ? { bg: '#1b1f24', alt: '#20252b', bar: '#3d434c', beat: '#2b3037', sub: '#24292f', ruler: '#262b31', text: '#c9d1d9', loop: 'rgba(88,166,255,.16)', loopOff: 'rgba(140,150,160,.15)', head: '#7ee787', rec: 'rgba(255,80,80,.18)', outline: '#fff', clipText: '#fff' }
    : { bg: '#f7f8fa', alt: '#eef1f4', bar: '#b8bec6', beat: '#dde1e6', sub: '#e9ecef', ruler: '#e6e9ed', text: '#333', loop: 'rgba(13,110,253,.14)', loopOff: 'rgba(120,120,120,.12)', head: '#1f883d', rec: 'rgba(229,56,59,.12)', outline: '#111', clipText: '#fff' };
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); }

/**
 * h: { project(), position(), recordingFrom(), selection(), select(clip|null), seek(beat), begin(), end(), cancel(),
 *      place(track, beat) -> clip novo ou null, open(clip), remove(clip), zoom(fator, batida, x) }
 */
export function playlist(wrap, h) {
  wrap.innerHTML = '<div class="tl-spacer"><canvas class="tl-canvas" aria-label="Playlist"></canvas></div>';
  const spacer = wrap.firstElementChild, cv = spacer.firstElementChild, g = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1, drag = null;
  const P = () => h.project();

  function layout() {
    const p = P();
    W = wrap.clientWidth;
    const beats = Math.max(songEnd(p) + p.sig * 8, p.sig * 32, (W + wrap.scrollLeft) / p.zoom + p.sig * 4, p.loop.end + p.sig * 4);
    spacer.style.width = Math.ceil(beats * p.zoom) + 'px';
    H = RH + p.playlist.tracks.length * TH;
    spacer.style.height = H + 'px';
    dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, W * dpr); cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    draw();
  }
  function gridStep(p) {
    let st = 1;
    while (st * p.zoom < 14) st *= 2;
    while (st * p.zoom > 56 && st > 0.125) st /= 2;
    return st;
  }

  function draw() {
    const p = P(), z = p.zoom, sx = wrap.scrollLeft, c = theme(), s = spb(p);
    const X = (b) => b * z - sx;
    const b0 = sx / z, b1 = (sx + W) / z;
    const sel = h.selection();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = c.bg; g.fillRect(0, 0, W, H);
    // compassos alternados, como no FL
    for (let bar = Math.floor(b0 / p.sig); bar * p.sig < b1; bar++) if (bar % 2) { g.fillStyle = c.alt; g.fillRect(X(bar * p.sig), RH, p.sig * z, H - RH); }
    const st = gridStep(p);
    for (let b = Math.floor(b0 / st) * st; b < b1 + st; b += st) {
      const x = Math.round(X(b)) + 0.5;
      g.strokeStyle = Math.abs(b % p.sig) < 1e-6 ? c.bar : Math.abs(b % 1) < 1e-6 ? c.beat : c.sub;
      g.beginPath(); g.moveTo(x, RH); g.lineTo(x, H); g.stroke();
    }
    p.playlist.tracks.forEach((t, i) => { g.strokeStyle = c.beat; g.beginPath(); g.moveTo(0, RH + (i + 1) * TH + 0.5); g.lineTo(W, RH + (i + 1) * TH + 0.5); g.stroke(); });
    const lx0 = X(p.loop.start), lx1 = X(p.loop.end);
    if (p.loop.on && p.mode === 'song') { g.fillStyle = c.loop; g.fillRect(lx0, RH, lx1 - lx0, H - RH); }
    const rowOf = new Map(p.playlist.tracks.map((t, i) => [t.id, i]));
    for (const cl of p.playlist.clips) {
      const i = rowOf.get(cl.track);
      if (i == null) continue;
      const x0 = X(cl.start), x1 = X(clipEnd(p, cl));
      if (x1 < 0 || x0 > W) continue;
      const y = RH + i * TH + 2, hh = TH - 4, w = Math.max(3, x1 - x0);
      const muted = p.playlist.tracks[i].mute;
      const pat = cl.kind === 'pattern' ? patternOf(p, cl.pattern) : null;
      const color = pat?.color || cl.color || (cl.kind === 'audio' ? '#58a6ff' : '#e3b341');
      g.globalAlpha = muted ? 0.4 : 1;
      g.fillStyle = color + '40'; roundRect(g, x0, y, w, hh, 3); g.fill();
      g.fillStyle = color; roundRect(g, x0, y, w, 13, [3, 3, 0, 0]); g.fill();
      g.save(); g.beginPath(); g.rect(x0, y, w, hh); g.clip();
      g.fillStyle = c.clipText; g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle';
      const label = pat ? pat.name : cl.kind === 'audio' ? cl.name || 'Áudio' : cl.label || 'Automação';
      g.fillText(label, Math.max(x0, 0) + 4, y + 7);
      if (pat) drawPattern(p, pat, cl, x0, y + 15, hh - 17, color, z);
      else if (cl.kind === 'audio') drawWave(cl, x0, y + 14, w, hh - 15, color, p, s);
      else drawAuto(cl, x0, y + 15, w, hh - 17, color, z);
      g.restore();
      // repetições do padrão marcadas com tracinhos
      if (pat) { const len = patternLength(p, pat); g.strokeStyle = color; for (let k = len - ((cl.offset || 0) % len); k < cl.len - 1e-6; k += len) { if (k <= 0) continue; const xx = X(cl.start + k) + 0.5; g.beginPath(); g.moveTo(xx, y + 13); g.lineTo(xx, y + hh); g.stroke(); } }
      if (cl.id === sel?.id) { g.strokeStyle = c.outline; g.lineWidth = 2; roundRect(g, x0 + 1, y + 1, w - 2, hh - 2, 3); g.stroke(); g.lineWidth = 1; }
      g.globalAlpha = 1;
    }
    const rf = h.recordingFrom();
    if (rf != null && p.mode === 'song') { const xa = X(rf), xb = X(Math.max(rf, h.position())); g.fillStyle = c.rec; g.fillRect(xa, RH, xb - xa, H - RH); }
    // régua
    g.fillStyle = c.ruler; g.fillRect(0, 0, W, RH);
    g.fillStyle = p.loop.on ? c.loop.replace(/[\d.]+\)$/, '.55)') : c.loopOff; g.fillRect(lx0, 0, lx1 - lx0, RH / 2 - 2);
    g.fillStyle = c.text; g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle';
    let every = 1; while (every * p.sig * z < 34) every *= 2;
    for (let bar = Math.max(0, Math.floor(b0 / p.sig / every) * every); bar * p.sig < b1; bar += every) {
      const x = Math.round(X(bar * p.sig)) + 0.5;
      g.strokeStyle = c.bar; g.beginPath(); g.moveTo(x, RH / 2); g.lineTo(x, RH); g.stroke();
      g.fillText(String(bar + 1), x + 3, RH * 0.72);
    }
    g.strokeStyle = c.bar; g.beginPath(); g.moveTo(0, RH - 0.5); g.lineTo(W, RH - 0.5); g.stroke();
    if (p.mode === 'song') {
      const px = X(h.position());
      if (px >= -2 && px <= W + 2) {
        g.strokeStyle = c.head; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); g.lineWidth = 1;
        g.fillStyle = c.head; g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 7); g.fill();
      }
    }
  }
  function drawPattern(p, pat, cl, x0, y, hh, color, z) {
    const all = Object.values(pat.notes).flat();
    if (!all.length) return;
    let lo = 127, hi = 0;
    for (const n of all) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
    lo -= 1; hi += 1;
    const len = patternLength(p, pat), rh = Math.max(1.5, Math.min(4, hh / (hi - lo + 1))), off = cl.offset || 0;
    g.fillStyle = document.documentElement.dataset.bsTheme === 'dark' ? '#fff' : '#1f2328';
    g.globalAlpha *= 0.75;
    for (let k = 0; k * len < cl.len + off; k++) for (const n of all) {
      const t = k * len + n.t - off;
      if (t < 0 || t >= cl.len || n.t >= len) continue;
      g.fillRect(x0 + t * z, y + ((hi - n.p) / (hi - lo + 1)) * hh, Math.max(1.5, Math.min(n.d, cl.len - t) * z - 1), rh);
    }
  }
  function drawWave(cl, x0, y, w, hh, color, p, s) {
    const a = cachedAudio(cl.audioId);
    if (!a) return;
    const { data, step } = a.peaks;
    const z = p.zoom, mid = y + hh / 2, gain = 10 ** ((cl.gain || 0) / 20);
    g.fillStyle = color;
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x0 + w)); x++) {
      const t0 = (cl.offset || 0) + ((x - x0) / z) * s, t1 = (cl.offset || 0) + ((x + 1 - x0) / z) * s;
      let m = 0;
      for (let k = Math.floor(t0 / step), e = Math.max(k + 1, Math.floor(t1 / step)); k < e && k < data.length; k++) if (data[k] > m) m = data[k];
      const v = (Math.min(1, m * gain) * hh) / 2;
      g.fillRect(x, mid - v, 1, Math.max(1, v * 2));
    }
  }
  function drawAuto(cl, x0, y, w, hh, color, z) {
    g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath();
    for (let x = 0; x <= w; x += 2) { const v = valueAt(cl.points, x / z); const yy = y + (1 - v) * hh; if (x === 0) g.moveTo(x0 + x, yy); else g.lineTo(x0 + x, yy); }
    g.stroke(); g.lineWidth = 1;
    g.fillStyle = '#fff';
    for (const pt of cl.points) { g.beginPath(); g.arc(x0 + pt.t * z, y + (1 - pt.v) * hh, 2.5, 0, Math.PI * 2); g.fill(); }
  }

  // ---------------------------------------------------------------- mouse/toque
  const posOf = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const beatAt = (x) => (x + wrap.scrollLeft) / P().zoom;
  const snapB = (b, e, floor = false) => { const p = P(); return p.snap && !e.altKey ? (floor ? Math.floor(b / p.snap) : Math.round(b / p.snap)) * p.snap : b; };
  const trackAt = (y) => P().playlist.tracks[Math.floor((y - RH) / TH)] || null;
  function hit(x, y, touch) {
    const p = P(), t = trackAt(y);
    if (y < RH || !t) return { t };
    const edge = touch ? 14 : 7;
    const list = p.playlist.clips.filter((c) => c.track === t.id);
    for (let k = list.length - 1; k >= 0; k--) {
      const c = list[k], xa = c.start * p.zoom - wrap.scrollLeft, xb = clipEnd(p, c) * p.zoom - wrap.scrollLeft;
      if (x >= xa - 2 && x <= xb + 2) {
        const e = xb - xa > edge * 3 ? (x > xb - edge ? 'r' : x < xa + edge ? 'l' : null) : x > xb - edge / 2 ? 'r' : null;
        return { t, clip: c, edge: e };
      }
    }
    return { t };
  }

  cv.addEventListener('pointerdown', (e) => {
    const p = P(), { x, y } = posOf(e), b = beatAt(x), touch = e.pointerType === 'touch';
    cv.setPointerCapture(e.pointerId);
    if (y < RH) {
      if (y < RH / 2 && p.mode === 'song') drag = { kind: 'loop', a: snapB(b, e), started: false };
      else { drag = { kind: 'seek' }; h.seek(Math.max(0, snapB(b, e))); }
      return;
    }
    const r = hit(x, y, touch);
    if (e.button === 2) { // botão direito apaga (arrastando, apaga o que passar por baixo)
      drag = { kind: 'erase', began: false };
      if (r.clip) { h.begin(); drag.began = true; h.remove(r.clip); draw(); }
      return;
    }
    if (!r.clip) {
      if (touch && !e.isPrimary) return;
      if (!r.t) { h.select(null); return; }
      h.begin();
      const c = h.place(r.t, Math.max(0, snapB(b, e, true)));
      if (!c) { h.cancel(); drag = touch ? { kind: 'pan', x: e.clientX, sl: wrap.scrollLeft } : null; return; }
      h.select(c);
      drag = { kind: 'move', clip: c, b0: b, orig: structuredClone(c), moved: true, x0: e.clientX, y0: e.clientY };
      draw();
      return;
    }
    let clip = r.clip;
    h.begin();
    if (e.shiftKey && !r.edge) { clip = { ...structuredClone(clip), id: crypto.randomUUID() }; p.playlist.clips.push(clip); }
    h.select(clip);
    drag = { kind: r.edge === 'r' ? 'trimR' : r.edge === 'l' ? 'trimL' : 'move', clip, b0: b, orig: structuredClone(clip), moved: e.shiftKey && !r.edge, x0: e.clientX, y0: e.clientY };
  });
  cv.addEventListener('pointermove', (e) => {
    const p = P(), { x, y } = posOf(e);
    if (!drag) {
      const r = y >= RH ? hit(x, y, e.pointerType === 'touch') : {};
      cv.style.cursor = r.edge ? 'ew-resize' : r.clip ? 'grab' : y < RH / 2 && p.mode === 'song' ? 'col-resize' : y < RH ? 'pointer' : 'copy';
      return;
    }
    const b = beatAt(x);
    if (drag.kind === 'pan') { wrap.scrollLeft = drag.sl - (e.clientX - drag.x); return; }
    if (drag.kind === 'seek') { h.seek(Math.max(0, snapB(b, e))); return; }
    if (drag.kind === 'erase') {
      const r = hit(x, y);
      if (r.clip) { if (!drag.began) { h.begin(); drag.began = true; } h.remove(r.clip); draw(); }
      return;
    }
    if (drag.kind === 'loop') {
      const nb = snapB(b, e);
      if (!drag.started && Math.abs(nb - drag.a) < (p.snap || 0.25)) return;
      if (!drag.started) { h.begin(); drag.started = true; }
      const a = Math.max(0, Math.min(drag.a, nb)), z = Math.max(drag.a, nb);
      p.loop = { on: true, start: a, end: Math.max(a + (p.snap || 0.25), z) };
      draw(); return;
    }
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 3) return;
    drag.moved = true;
    const { clip: c, orig: o } = drag, s = spb(p), d = b - drag.b0, unit = p.snap || 0.0625;
    if (drag.kind === 'move') {
      c.start = Math.max(0, snapB(o.start + d, e));
      const t2 = trackAt(y);
      if (t2) c.track = t2.id;
    } else if (drag.kind === 'trimR') {
      const end = snapB(clipEnd(p, o) + d, e);
      if (c.kind === 'audio') { const buf = cachedAudio(c.audioId); const max = (buf ? buf.buffer.duration : (o.offset || 0) + o.dur) - (c.offset || 0); c.dur = Math.max(0.05, Math.min(max, (end - c.start) * s)); }
      else c.len = Math.max(unit, end - c.start);
    } else if (drag.kind === 'trimL') {
      let ns = Math.max(0, snapB(o.start + d, e));
      if (c.kind === 'audio') {
        ns = Math.max(ns, o.start - (o.offset || 0) / s);
        ns = Math.min(ns, o.start + (o.dur - 0.05) / s);
        const ds = (ns - o.start) * s;
        c.start = ns; c.offset = (o.offset || 0) + ds; c.dur = o.dur - ds;
      } else {
        ns = Math.min(ns, o.start + o.len - unit);
        if (c.kind === 'pattern') ns = Math.max(ns, o.start - (o.offset || 0)); // não antes do começo do padrão
        c.start = ns; c.len = o.len - (ns - o.start);
        if (c.kind === 'pattern') c.offset = Math.max(0, (o.offset || 0) + (ns - o.start));
        if (c.kind === 'auto') c.points = o.points.map((pt) => ({ ...pt, t: pt.t - (ns - o.start) })).filter((pt) => pt.t >= 0);
      }
    }
    draw();
  });
  const up = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'loop') { if (d.started) h.end(); else h.seek(Math.max(0, d.a)); return; }
    if (d.kind === 'erase') { if (d.began) h.end(); return; }
    if (d.kind === 'seek' || d.kind === 'pan') return;
    if (d.moved) h.end(); else h.cancel();
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('dblclick', (e) => {
    const p = P(), { x, y } = posOf(e);
    if (y < RH) { if (p.mode === 'song') { h.begin(); p.loop.on = !p.loop.on; h.end(); } return; }
    const r = hit(x, y);
    if (r.clip) h.open(r.clip);
  });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  wrap.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const { x } = posOf(e);
    h.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, beatAt(x), x);
  }, { passive: false });
  wrap.addEventListener('scroll', () => { if (wrap.scrollLeft + W > spacer.offsetWidth - 200) layout(); else draw(); });
  const ro = new ResizeObserver(() => layout());
  ro.observe(wrap);
  layout();

  return {
    layout, draw,
    /** Mantém o cursor visível enquanto toca. */
    follow() {
      const x = h.position() * P().zoom - wrap.scrollLeft;
      if (x > W * 0.92 || x < 0) wrap.scrollLeft = Math.max(0, h.position() * P().zoom - W * 0.1);
    },
    destroy() { ro.disconnect(); },
  };
}
