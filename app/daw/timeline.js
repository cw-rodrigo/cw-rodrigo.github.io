// Linha do tempo (arranjo) num canvas: régua com loop, faixas, clipes com forma de onda/notas,
// arrastar para mover, puxar as bordas para cortar, Alt+arrastar duplica, cursor de reprodução.
import { spb, clipEnd, songEnd, cachedAudio } from './project.js';

export const TH = 64, RH = 28;

function theme() {
  const dark = document.documentElement.dataset.bsTheme === 'dark';
  return dark
    ? { bg: '#16181c', alt: '#1b1e23', sel: '#232833', bar: '#3a3f48', beat: '#2a2e35', sub: '#22252b', ruler: '#20232a', text: '#c9d1d9', loop: 'rgba(88,166,255,.18)', loopOff: 'rgba(140,150,160,.15)', head: '#ff5f56', rec: 'rgba(255,80,80,.18)', outline: '#fff' }
    : { bg: '#ffffff', alt: '#f6f7f9', sel: '#e8f0fe', bar: '#b8bec6', beat: '#dde1e6', sub: '#eef0f3', ruler: '#eef0f3', text: '#333', loop: 'rgba(13,110,253,.16)', loopOff: 'rgba(120,120,120,.12)', head: '#e5383b', rec: 'rgba(229,56,59,.12)', outline: '#111' };
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); }

/**
 * h: { project(), position(), playing(), recordingFrom(), selection() -> {trackId, clipId},
 *      select(trackId, clipId), seek(beat), begin(), end(), cancel(), open(track, clip), create(track, beat), zoom(factor, beat) }
 */
export function timeline(wrap, h) {
  wrap.innerHTML = '<div class="tl-spacer"><canvas class="tl-canvas" aria-label="Linha do tempo"></canvas></div>';
  const spacer = wrap.firstElementChild, cv = spacer.firstElementChild, g = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1, drag = null;
  const P = () => h.project();

  function layout() {
    const p = P();
    W = wrap.clientWidth;
    const beats = Math.max(songEnd(p) + p.sig * 8, p.sig * 32, (W + wrap.scrollLeft) / p.zoom + p.sig * 4, p.loop.end + p.sig * 4);
    spacer.style.width = Math.ceil(beats * p.zoom) + 'px';
    H = RH + (p.tracks.length + 1) * TH;
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
    p.tracks.forEach((t, i) => { g.fillStyle = t.id === sel.trackId ? c.sel : i % 2 ? c.alt : c.bg; g.fillRect(0, RH + i * TH, W, TH); });
    // grade
    const st = gridStep(p);
    for (let b = Math.floor(b0 / st) * st; b < b1 + st; b += st) {
      const x = Math.round(X(b)) + 0.5;
      g.strokeStyle = Math.abs(b % p.sig) < 1e-6 ? c.bar : Math.abs(b % 1) < 1e-6 ? c.beat : c.sub;
      g.beginPath(); g.moveTo(x, RH); g.lineTo(x, H); g.stroke();
    }
    p.tracks.forEach((t, i) => { g.strokeStyle = c.beat; g.beginPath(); g.moveTo(0, RH + (i + 1) * TH + 0.5); g.lineTo(W, RH + (i + 1) * TH + 0.5); g.stroke(); });
    // loop
    const lx0 = X(p.loop.start), lx1 = X(p.loop.end);
    if (p.loop.on) { g.fillStyle = c.loop; g.fillRect(lx0, RH, lx1 - lx0, H - RH); }
    // clipes
    p.tracks.forEach((t, i) => {
      const audible = !t.mute && (!p.tracks.some((x) => x.solo) || t.solo);
      for (const cl of t.clips) {
        const x0 = X(cl.start), x1 = X(clipEnd(p, cl));
        if (x1 < 0 || x0 > W) continue;
        const y = RH + i * TH + 3, hh = TH - 6, w = Math.max(3, x1 - x0);
        g.globalAlpha = audible ? 1 : 0.45;
        g.fillStyle = t.color + '33'; roundRect(g, x0, y, w, hh, 4); g.fill();
        g.fillStyle = t.color; roundRect(g, x0, y, w, 14, [4, 4, 0, 0]); g.fill();
        g.save(); g.beginPath(); g.rect(x0, y, w, hh); g.clip();
        g.fillStyle = '#fff'; g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle';
        g.fillText(cl.name || (cl.notes ? 'MIDI' : 'Áudio'), Math.max(x0, 0) + 4, y + 7);
        if (cl.audioId) drawWave(cl, x0, y + 15, w, hh - 16, t.color, p, s);
        else if (cl.notes) drawNotes(cl, x0, y + 16, hh - 18, t.color, z);
        g.restore();
        if (cl.id === sel.clipId) { g.strokeStyle = c.outline; g.lineWidth = 2; roundRect(g, x0 + 1, y + 1, w - 2, hh - 2, 4); g.stroke(); g.lineWidth = 1; }
        g.globalAlpha = 1;
      }
    });
    // gravando
    const rf = h.recordingFrom();
    if (rf != null) { const xa = X(rf), xb = X(Math.max(rf, h.position())); g.fillStyle = c.rec; g.fillRect(xa, RH, xb - xa, H - RH); }
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
    // cursor
    const px = X(h.position());
    if (px >= -2 && px <= W + 2) {
      g.strokeStyle = c.head; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); g.lineWidth = 1;
      g.fillStyle = c.head; g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 7); g.fill();
    }
  }

  function drawWave(cl, x0, y, w, hh, color, p, s) {
    const a = cachedAudio(cl.audioId);
    if (!a) return;
    const { data, step } = a.peaks;
    const z = p.zoom, mid = y + hh / 2;
    g.fillStyle = color;
    const xa = Math.max(0, Math.floor(x0)), xb = Math.min(W, Math.ceil(x0 + w));
    const gain = 10 ** ((cl.gain || 0) / 20);
    for (let x = xa; x < xb; x++) {
      const t0 = cl.offset + ((x - x0) / z) * s, t1 = cl.offset + ((x + 1 - x0) / z) * s;
      let m = 0;
      for (let k = Math.floor(t0 / step), e = Math.max(k + 1, Math.floor(t1 / step)); k < e && k < data.length; k++) if (data[k] > m) m = data[k];
      const v = Math.min(1, m * gain) * hh / 2;
      g.fillRect(x, mid - v, 1, Math.max(1, v * 2));
    }
  }
  function drawNotes(cl, x0, y, hh, color, z) {
    if (!cl.notes.length) return;
    let lo = 127, hi = 0;
    for (const n of cl.notes) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
    lo -= 2; hi += 2;
    const rh = Math.max(1.5, Math.min(5, hh / (hi - lo + 1)));
    g.fillStyle = color;
    for (const n of cl.notes) {
      if (n.t >= cl.len) continue;
      const x = x0 + n.t * z, w = Math.max(1.5, Math.min(n.d, cl.len - n.t) * z - 1);
      g.fillRect(x, y + (hi - n.p) / (hi - lo + 1) * hh, w, rh);
    }
  }

  // ---------------------------------------------------------------- mouse/toque
  const posOf = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const beatAt = (x) => (x + wrap.scrollLeft) / P().zoom;
  const snapB = (b, e) => { const p = P(); return p.snap && !e.shiftKey ? Math.round(b / p.snap) * p.snap : b; };
  function hit(x, y, touch) {
    const p = P(), ti = Math.floor((y - RH) / TH), t = p.tracks[ti];
    if (y < RH || !t) return { ti, t };
    const b = beatAt(x), edge = touch ? 14 : 7;
    for (let k = t.clips.length - 1; k >= 0; k--) {
      const c = t.clips[k], xa = c.start * p.zoom - wrap.scrollLeft, xb = clipEnd(p, c) * p.zoom - wrap.scrollLeft;
      if (x >= xa - 2 && x <= xb + 2 && b >= c.start - edge / p.zoom && b <= clipEnd(p, c) + edge / p.zoom) {
        const e = xb - xa > edge * 3 ? (x > xb - edge ? 'r' : x < xa + edge ? 'l' : null) : x > xb - edge / 2 ? 'r' : null;
        return { ti, t, clip: c, edge: e };
      }
    }
    return { ti, t };
  }

  cv.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    const p = P(), { x, y } = posOf(e), b = beatAt(x), touch = e.pointerType === 'touch';
    cv.setPointerCapture(e.pointerId);
    if (y < RH) {
      if (y < RH / 2) drag = { kind: 'loop', a: snapB(b, e), started: false };
      else { drag = { kind: 'seek' }; h.seek(Math.max(0, snapB(b, e))); }
      return;
    }
    const r = hit(x, y, touch);
    if (!r.clip) {
      h.select(r.t?.id ?? null, null);
      drag = touch ? { kind: 'pan', x: e.clientX, sl: wrap.scrollLeft } : null;
      return;
    }
    let clip = r.clip;
    h.begin();
    if (e.altKey && !r.edge) { clip = { ...structuredClone(clip), id: crypto.randomUUID?.() || String(Math.random()) }; r.t.clips.push(clip); }
    h.select(r.t.id, clip.id);
    drag = { kind: r.edge === 'r' ? 'trimR' : r.edge === 'l' ? 'trimL' : 'move', clip, track: r.t, b0: b, orig: structuredClone(clip), moved: !!e.altKey && !r.edge, x0: e.clientX, y0: e.clientY };
  });
  cv.addEventListener('pointermove', (e) => {
    const p = P(), { x, y } = posOf(e);
    if (!drag) {
      const r = y >= RH ? hit(x, y, e.pointerType === 'touch') : {};
      cv.style.cursor = r.edge ? 'ew-resize' : r.clip ? 'grab' : y < RH / 2 ? 'col-resize' : y < RH ? 'pointer' : 'default';
      return;
    }
    const b = beatAt(x);
    if (drag.kind === 'pan') { wrap.scrollLeft = drag.sl - (e.clientX - drag.x); return; }
    if (drag.kind === 'seek') { h.seek(Math.max(0, snapB(b, e))); return; }
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
      const t2 = p.tracks[Math.floor((y - RH) / TH)];
      if (t2 && t2 !== drag.track && t2.kind === drag.track.kind) {
        drag.track.clips = drag.track.clips.filter((k) => k !== c);
        t2.clips.push(c); drag.track = t2; h.select(t2.id, c.id);
      }
    } else if (drag.kind === 'trimR') {
      const end = snapB(clipEnd(p, o) + d, e);
      if (c.notes) c.len = Math.max(unit, end - c.start);
      else { const buf = cachedAudio(c.audioId); const max = (buf ? buf.buffer.duration : o.offset + o.dur) - c.offset; c.dur = Math.max(0.05, Math.min(max, (end - c.start) * s)); }
    } else if (drag.kind === 'trimL') {
      let ns = Math.max(0, snapB(o.start + d, e));
      if (c.notes) {
        ns = Math.min(ns, o.start + o.len - unit);
        const db = ns - o.start;
        c.start = ns; c.len = o.len - db;
        c.notes = o.notes.map((n) => ({ ...n, t: n.t - db })).filter((n) => n.t >= 0);
      } else {
        ns = Math.max(ns, o.start - o.offset / s);
        ns = Math.min(ns, o.start + (o.dur - 0.05) / s);
        const ds = (ns - o.start) * s;
        c.start = ns; c.offset = o.offset + ds; c.dur = o.dur - ds;
      }
    }
    draw();
  });
  const up = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'loop') { if (d.started) h.end(); else h.seek(Math.max(0, d.a)); return; }
    if (d.kind === 'seek' || d.kind === 'pan') return;
    if (d.moved) h.end(); else h.cancel();
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('dblclick', (e) => {
    const p = P(), { x, y } = posOf(e);
    if (y < RH) { h.begin(); p.loop.on = !p.loop.on; h.end(); return; }
    const r = hit(x, y);
    if (r.clip) h.open(r.t, r.clip);
    else if (r.t?.kind === 'inst') h.create(r.t, Math.floor(beatAt(x) / p.sig) * p.sig);
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
