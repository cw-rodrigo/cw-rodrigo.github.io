// Piano roll de um clipe MIDI: clique para criar nota, arraste para mover, puxe a borda direita
// para alongar, duplo clique (ou botão direito) apaga. Teclas à esquerda tocam a nota.
import { noteLabel } from '/lib/synth/keyboard.js';

const KW = 46, RH = 12, BLACK = [1, 3, 6, 8, 10];

function theme() {
  const dark = document.documentElement.dataset.bsTheme === 'dark';
  return dark
    ? { bg: '#16181c', blackRow: '#121417', line: '#22252b', cLine: '#3a3f48', bar: '#4a505a', beat: '#2c3037', out: 'rgba(0,0,0,.35)', text: '#c9d1d9', white: '#d8dce2', black: '#2a2d33', head: '#ff5f56', sel: '#fff' }
    : { bg: '#ffffff', blackRow: '#f1f3f5', line: '#eceef1', cLine: '#c4c9d0', bar: '#9aa1aa', beat: '#d5d9de', out: 'rgba(0,0,0,.06)', text: '#333', white: '#fafafa', black: '#3a3d42', head: '#e5383b', sel: '#111' };
}

/**
 * h: { project(), track(), clip(), begin(), end(), cancel(), preview(note, vel), position() }
 */
export function pianoRoll(el, h) {
  el.innerHTML = `
    <div class="d-flex flex-wrap align-items-center gap-2 mb-2 small">
      <strong class="text-truncate" style="max-width:12rem" data-r="name"></strong>
      <label class="d-flex align-items-center gap-1">Compassos <input type="number" class="form-control form-control-sm" style="width:4.5rem" min="1" max="256" data-pr="bars"></label>
      <div class="btn-group btn-group-sm" role="group" aria-label="Transpor">
        <button class="btn btn-outline-secondary" type="button" data-pr="t-12" title="Oitava abaixo">−8ª</button>
        <button class="btn btn-outline-secondary" type="button" data-pr="t-1" title="Meio tom abaixo">−½</button>
        <button class="btn btn-outline-secondary" type="button" data-pr="t1" title="Meio tom acima">+½</button>
        <button class="btn btn-outline-secondary" type="button" data-pr="t12" title="Oitava acima">+8ª</button>
      </div>
      <button class="btn btn-sm btn-outline-secondary" type="button" data-pr="quant" title="Alinhar as notas à grade"><i class="bi bi-grid-3x3"></i> Quantizar</button>
      <label class="d-flex align-items-center gap-1">Força <input type="range" class="form-range" style="width:90px" min="1" max="127" data-pr="vel" aria-label="Força das notas selecionadas"></label>
      <button class="btn btn-sm btn-outline-danger" type="button" data-pr="del" title="Apagar notas selecionadas"><i class="bi bi-trash"></i></button>
      <span class="text-body-secondary ms-auto d-none d-lg-inline">Clique cria · arraste move · borda direita alonga · duplo clique apaga · Shift sem grade · Ctrl+roda zoom</span>
    </div>
    <div class="pr-scroll border rounded"><div class="pr-spacer"><canvas class="pr-canvas" aria-label="Piano roll"></canvas></div></div>`;
  const scroll = el.querySelector('.pr-scroll'), spacer = el.querySelector('.pr-spacer'), cv = el.querySelector('canvas'), g = cv.getContext('2d');
  let zx = 48, W = 0, Hh = 0, dpr = 1, drag = null, sel = new Set(), lastLen = 1, lastVel = 100;
  const P = () => h.project(), C = () => h.clip();

  function layout() {
    const c = C();
    if (!c) return;
    W = scroll.clientWidth; Hh = scroll.clientHeight;
    spacer.style.width = KW + Math.max(W - KW, (c.len + P().sig) * zx) + 'px';
    spacer.style.height = 128 * RH + 'px';
    dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, W * dpr); cv.height = Math.max(1, Hh * dpr);
    cv.style.width = W + 'px'; cv.style.height = Hh + 'px';
    draw();
  }
  const yOf = (p) => (127 - p) * RH - scroll.scrollTop;
  const xOf = (b) => KW + b * zx - scroll.scrollLeft;
  const beatAt = (x) => (x - KW + scroll.scrollLeft) / zx;
  const pitchAt = (y) => 127 - Math.floor((y + scroll.scrollTop) / RH);
  const snapB = (b, e, floor = false) => { const s = P().snap; if (!s || e?.shiftKey) return b; return (floor ? Math.floor(b / s) : Math.round(b / s)) * s; };

  function draw() {
    const c = C(), p = P(), t = h.track(), th = theme();
    if (!c) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = th.bg; g.fillRect(0, 0, W, Hh);
    const p0 = Math.min(127, pitchAt(0) + 1), p1 = Math.max(0, pitchAt(Hh) - 1);
    for (let n = p0; n >= p1; n--) {
      const y = yOf(n);
      if (BLACK.includes(n % 12)) { g.fillStyle = th.blackRow; g.fillRect(KW, y, W, RH); }
      g.strokeStyle = n % 12 === 0 ? th.cLine : th.line;
      g.beginPath(); g.moveTo(KW, y + RH + 0.5); g.lineTo(W, y + RH + 0.5); g.stroke();
    }
    let st = p.snap || 0.25; while (st * zx < 10) st *= 2;
    const b0 = beatAt(KW), b1 = beatAt(W);
    for (let b = Math.max(0, Math.floor(b0 / st) * st); b < b1; b += st) {
      const x = Math.round(xOf(b)) + 0.5;
      g.strokeStyle = Math.abs(b % p.sig) < 1e-6 ? th.bar : Math.abs(b % 1) < 1e-6 ? th.beat : th.line;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, Hh); g.stroke();
    }
    const xe = xOf(c.len);
    if (xe < W) { g.fillStyle = th.out; g.fillRect(Math.max(KW, xe), 0, W, Hh); }
    for (const n of c.notes) {
      const x = xOf(n.t), y = yOf(n.p), w = Math.max(3, n.d * zx - 1);
      if (x > W || x + w < KW || y > Hh || y + RH < 0) continue;
      g.globalAlpha = 0.45 + 0.55 * ((n.v ?? 100) / 127);
      g.fillStyle = t.color; g.fillRect(x, y + 1, w, RH - 2);
      g.globalAlpha = 1;
      if (sel.has(n)) { g.strokeStyle = th.sel; g.lineWidth = 1.5; g.strokeRect(x + 0.5, y + 1.5, w - 1, RH - 3); g.lineWidth = 1; }
    }
    const pos = h.position() - c.start;
    if (pos >= 0 && pos <= c.len) { const x = xOf(pos); if (x >= KW) { g.strokeStyle = th.head; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, Hh); g.stroke(); } }
    // teclas
    g.fillStyle = th.white; g.fillRect(0, 0, KW, Hh);
    for (let n = p0; n >= p1; n--) {
      const y = yOf(n);
      if (BLACK.includes(n % 12)) { g.fillStyle = th.black; g.fillRect(0, y, KW * 0.62, RH); }
      g.strokeStyle = '#b9bec5'; g.beginPath(); g.moveTo(0, y + RH + 0.5); g.lineTo(KW, y + RH + 0.5); g.stroke();
      if (n % 12 === 0) { g.fillStyle = '#555'; g.font = '9px system-ui, sans-serif'; g.textBaseline = 'middle'; g.fillText(noteLabel(n), KW - 24, y + RH / 2); }
    }
    g.strokeStyle = '#9aa0a6'; g.beginPath(); g.moveTo(KW + 0.5, 0); g.lineTo(KW + 0.5, Hh); g.stroke();
  }

  function refreshBar() {
    const c = C();
    if (!c) return;
    el.querySelector('[data-r="name"]').textContent = c.name || 'Clipe MIDI';
    el.querySelector('[data-pr="bars"]').value = Math.round((c.len / P().sig) * 100) / 100;
    const first = [...sel][0];
    el.querySelector('[data-pr="vel"]').value = first?.v ?? lastVel;
  }
  const noteAt = (x, y) => {
    const c = C(), b = beatAt(x), pt = pitchAt(y);
    for (let i = c.notes.length - 1; i >= 0; i--) { const n = c.notes[i]; if (n.p === pt && b >= n.t && b <= n.t + n.d) return n; }
    return null;
  };

  cv.addEventListener('pointerdown', (e) => {
    const c = C();
    if (!c) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    cv.setPointerCapture(e.pointerId);
    if (x < KW) { const n = pitchAt(y); h.preview(n, 100); drag = { kind: 'key', n }; return; }
    if (e.button === 2) { const n = noteAt(x, y); if (n) { h.begin(); c.notes = c.notes.filter((k) => k !== n); sel.delete(n); h.end(); draw(); } return; }
    let n = noteAt(x, y);
    h.begin();
    let created = false;
    if (!n) {
      const t = Math.max(0, snapB(beatAt(x), e, true));
      if (t >= c.len) { h.cancel(); return; }
      n = { p: pitchAt(y), t, d: Math.min(lastLen, c.len - t), v: lastVel };
      c.notes.push(n); created = true;
      sel = new Set([n]);
      h.preview(n.p, n.v);
    } else if (!sel.has(n)) { sel = e.shiftKey ? new Set([...sel, n]) : new Set([n]); h.preview(n.p, n.v); }
    else if (e.shiftKey) { sel.delete(n); }
    const right = xOf(n.t + n.d);
    drag = { kind: !created && x > right - 7 ? 'len' : 'move', n, b0: beatAt(x), p0: pitchAt(y), orig: [...sel].map((k) => [k, { ...k }]), moved: created };
    refreshBar(); draw();
  });
  cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (!drag) {
      const n = x > KW ? noteAt(x, y) : null;
      cv.style.cursor = x < KW ? 'pointer' : n && x > xOf(n.t + n.d) - 7 ? 'ew-resize' : n ? 'grab' : 'crosshair';
      return;
    }
    if (drag.kind === 'key') return;
    const c = C(), db = beatAt(x) - drag.b0, dp = pitchAt(y) - drag.p0;
    drag.moved = true;
    if (drag.kind === 'len') {
      for (const [k, o] of drag.orig) k.d = Math.max(P().snap || 0.0625, snapB(o.t + o.d + db, e) - o.t);
      lastLen = drag.n.d;
    } else {
      const base = drag.orig.find(([k]) => k === drag.n)[1];
      const nt = Math.max(0, snapB(base.t + db, e)), shift = nt - base.t;
      const before = drag.n.p;
      for (const [k, o] of drag.orig) { k.t = Math.max(0, Math.min(c.len - 0.0625, o.t + shift)); k.p = Math.max(0, Math.min(127, o.p + dp)); }
      if (drag.n.p !== before) h.preview(drag.n.p, drag.n.v);
    }
    draw();
  });
  const up = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'key') return;
    if (d.moved) h.end(); else h.cancel();
    draw();
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('dblclick', (e) => {
    const r = cv.getBoundingClientRect(), n = noteAt(e.clientX - r.left, e.clientY - r.top);
    if (!n) return;
    h.begin(); C().notes = C().notes.filter((k) => k !== n); sel.delete(n); h.end(); draw();
  });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  scroll.addEventListener('scroll', draw);
  scroll.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, b = beatAt(x);
    zx = Math.max(8, Math.min(400, zx * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    layout();
    scroll.scrollLeft = Math.max(0, KW + b * zx - x);
  }, { passive: false });

  const edit = (fn) => { h.begin(); fn(C()); h.end(); refreshBar(); layout(); };
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-pr]')?.dataset.pr;
    if (!a || !C()) return;
    const targets = () => (sel.size ? [...sel] : C().notes);
    if (a[0] === 't' && a !== 'quant') { const k = Number(a.slice(1)); edit(() => targets().forEach((n) => { n.p = Math.max(0, Math.min(127, n.p + k)); })); }
    if (a === 'quant') { const q = P().snap || 0.25; edit(() => targets().forEach((n) => { n.t = Math.round(n.t / q) * q; n.d = Math.max(q, Math.round(n.d / q) * q); })); }
    if (a === 'del') { edit((c) => { const s = new Set(targets()); c.notes = c.notes.filter((n) => !s.has(n)); sel.clear(); }); }
  });
  el.addEventListener('change', (e) => {
    const a = e.target.dataset.pr;
    if (a === 'bars') { const v = Math.max(0.25, Number(e.target.value) || 1); edit((c) => { c.len = v * P().sig; }); }
    if (a === 'vel') { lastVel = Number(e.target.value); if (sel.size) edit(() => sel.forEach((n) => { n.v = lastVel; })); }
  });

  const ro = new ResizeObserver(() => layout());
  ro.observe(scroll);

  return {
    /** Abre outro clipe (ou o mesmo, depois de desfazer). */
    show(keepSel = false) {
      if (!keepSel) sel = new Set();
      else { const c = C(); sel = new Set(c ? c.notes.filter((n) => [...sel].some((s) => s.p === n.p && s.t === n.t)) : []); }
      layout(); refreshBar();
      const c = C();
      if (c && !keepSel) {
        const ps = c.notes.map((n) => n.p);
        const mid = ps.length ? (Math.min(...ps) + Math.max(...ps)) / 2 : 60;
        scroll.scrollTop = Math.max(0, (127 - mid) * RH - scroll.clientHeight / 2);
        scroll.scrollLeft = 0;
      }
    },
    draw,
    /** Atalhos quando o piano roll está em foco. Retorna true se tratou. */
    key(e) {
      const c = C();
      if (!c) return false;
      if (e.key === 'Delete' || e.key === 'Backspace') { if (!sel.size) return false; edit((cl) => { cl.notes = cl.notes.filter((n) => !sel.has(n)); sel.clear(); }); return true; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { sel = new Set(c.notes); draw(); refreshBar(); return true; }
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && sel.size) { const k = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1); edit(() => sel.forEach((n) => { n.p = Math.max(0, Math.min(127, n.p + k)); })); return true; }
      return false;
    },
    destroy() { ro.disconnect(); },
  };
}
