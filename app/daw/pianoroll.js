// Piano roll de um canal dentro do padrão (como no FL): clique cria nota (ou um acorde inteiro, com o
// carimbo de acordes), arraste move, a borda direita alonga, botão direito ou duplo clique apaga.
// As notas dos outros canais do padrão aparecem apagadas por trás ("ghost notes"); embaixo, a faixa de
// força (velocity) de cada nota. Teclas à esquerda tocam a nota. Alt desliga a grade.
import { noteLabel } from '/lib/synth/keyboard.js';
import { drumName } from '/lib/synth/engines/drums.js';
import { patternLength, STEP } from './project.js';

const KW = 52, RH = 12, VH = 64, BLACK = [1, 3, 6, 8, 10];
/** Carimbos de acorde (intervalos a partir da nota clicada). */
export const STAMPS = [['Nota', [0]], ['Maior', [0, 4, 7]], ['Menor', [0, 3, 7]], ['Sétima (7)', [0, 4, 7, 10]], ['Menor com 7', [0, 3, 7, 10]], ['Maior com 7M', [0, 4, 7, 11]], ['Sus4', [0, 5, 7]], ['Power chord', [0, 7, 12]], ['Oitava', [0, 12]]];

function theme() {
  const dark = document.documentElement.dataset.bsTheme === 'dark';
  return dark
    ? { bg: '#1b1f24', blackRow: '#171a1f', line: '#262b31', cLine: '#3a3f48', bar: '#4a505a', beat: '#2e333a', out: 'rgba(0,0,0,.35)', white: '#d8dce2', black: '#2a2d33', head: '#7ee787', sel: '#fff', ghost: 'rgba(200,210,220,.18)', vbg: '#16191d' }
    : { bg: '#ffffff', blackRow: '#f1f3f5', line: '#eceef1', cLine: '#c4c9d0', bar: '#9aa1aa', beat: '#d5d9de', out: 'rgba(0,0,0,.06)', white: '#fafafa', black: '#3a3d42', head: '#1f883d', sel: '#111', ghost: 'rgba(60,70,80,.14)', vbg: '#f4f5f7' };
}

/**
 * h: { project(), pattern(), channel(), begin(), end(), cancel(), preview(note, vel), position() -> batida no padrão ou null }
 */
export function pianoRoll(el, h) {
  el.innerHTML = `
    <div class="d-flex flex-wrap align-items-center gap-2 mb-2 small">
      <strong class="text-truncate" style="max-width:16rem" data-r="name"></strong>
      <label class="d-flex align-items-center gap-1">Compassos <input type="number" class="form-control form-control-sm" style="width:4.2rem" min="1" max="64" data-pr="bars"></label>
      <label class="d-flex align-items-center gap-1">Carimbo <select class="form-select form-select-sm w-auto" data-pr="stamp" aria-label="Carimbo de acorde">${STAMPS.map(([n], i) => `<option value="${i}">${n}</option>`).join('')}</select></label>
      <div class="btn-group btn-group-sm" role="group" aria-label="Transpor">
        <button class="btn btn-outline-secondary" type="button" data-pr="t-12" title="Oitava abaixo">−8ª</button>
        <button class="btn btn-outline-secondary" type="button" data-pr="t-1" title="Meio tom abaixo">−½</button>
        <button class="btn btn-outline-secondary" type="button" data-pr="t1" title="Meio tom acima">+½</button>
        <button class="btn btn-outline-secondary" type="button" data-pr="t12" title="Oitava acima">+8ª</button>
      </div>
      <button class="btn btn-sm btn-outline-secondary" type="button" data-pr="quant" title="Alinhar as notas à grade"><i class="bi bi-grid-3x3"></i> Quantizar</button>
      <button class="btn btn-sm btn-outline-danger" type="button" data-pr="del" title="Apagar notas selecionadas (Delete)"><i class="bi bi-trash"></i></button>
      <span class="text-body-secondary ms-auto d-none d-xl-inline">Clique cria · arraste move · borda alonga · botão direito apaga · Ctrl+A tudo · ↑↓ transpõe · Alt sem grade</span>
    </div>
    <div class="pr-scroll border rounded-top"><div class="pr-spacer"><canvas class="pr-canvas" aria-label="Piano roll"></canvas></div></div>
    <canvas class="pr-vel border border-top-0 rounded-bottom w-100" height="${VH}" aria-label="Força das notas"></canvas>`;
  const scroll = el.querySelector('.pr-scroll'), spacer = el.querySelector('.pr-spacer'), cv = el.querySelector('.pr-canvas'), g = cv.getContext('2d');
  const vcv = el.querySelector('.pr-vel'), vg = vcv.getContext('2d');
  let zx = 48, W = 0, Hh = 0, dpr = 1, drag = null, sel = new Set(), lastLen = STEP * 2, lastVel = 100, stamp = 0;
  const P = () => h.project(), PAT = () => h.pattern(), CH = () => h.channel();
  const notes = () => { const pat = PAT(), ch = CH(); if (!pat || !ch) return []; return (pat.notes[ch.id] ||= []); };
  const len = () => patternLength(P(), PAT());
  const isDrums = () => CH()?.synth.engine === 'drums';

  function layout() {
    if (!PAT() || !CH()) return;
    W = scroll.clientWidth; Hh = scroll.clientHeight;
    spacer.style.width = KW + Math.max(W - KW, (len() + P().sig) * zx) + 'px';
    spacer.style.height = 128 * RH + 'px';
    dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, W * dpr); cv.height = Math.max(1, Hh * dpr);
    cv.style.width = W + 'px'; cv.style.height = Hh + 'px';
    vcv.width = Math.max(1, vcv.clientWidth * dpr); vcv.height = VH * dpr;
    draw();
  }
  const yOf = (p) => (127 - p) * RH - scroll.scrollTop;
  const xOf = (b) => KW + b * zx - scroll.scrollLeft;
  const beatAt = (x) => (x - KW + scroll.scrollLeft) / zx;
  const pitchAt = (y) => 127 - Math.floor((y + scroll.scrollTop) / RH);
  const snapB = (b, e, floor = false) => { const s = P().snap; if (!s || e?.altKey) return b; return (floor ? Math.floor(b / s) : Math.round(b / s)) * s; };

  function draw() {
    const pat = PAT(), ch = CH(), p = P(), th = theme();
    if (!pat || !ch) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = th.bg; g.fillRect(0, 0, W, Hh);
    const p0 = Math.min(127, pitchAt(0) + 1), p1 = Math.max(0, pitchAt(Hh) - 1);
    for (let n = p0; n >= p1; n--) {
      const y = yOf(n);
      if (BLACK.includes(n % 12)) { g.fillStyle = th.blackRow; g.fillRect(KW, y, W, RH); }
      g.strokeStyle = n % 12 === 0 ? th.cLine : th.line;
      g.beginPath(); g.moveTo(KW, y + RH + 0.5); g.lineTo(W, y + RH + 0.5); g.stroke();
    }
    let st = p.snap || STEP; while (st * zx < 10) st *= 2;
    const b0 = beatAt(KW), b1 = beatAt(W);
    for (let b = Math.max(0, Math.floor(b0 / st) * st); b < b1; b += st) {
      const x = Math.round(xOf(b)) + 0.5;
      g.strokeStyle = Math.abs(b % p.sig) < 1e-6 ? th.bar : Math.abs(b % 1) < 1e-6 ? th.beat : th.line;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, Hh); g.stroke();
    }
    const xe = xOf(len());
    if (xe < W) { g.fillStyle = th.out; g.fillRect(Math.max(KW, xe), 0, W, Hh); }
    // notas dos outros canais do padrão, apagadas
    g.fillStyle = th.ghost;
    for (const [id, list] of Object.entries(pat.notes)) if (id !== ch.id) for (const n of list) g.fillRect(xOf(n.t), yOf(n.p) + 2, Math.max(3, n.d * zx - 1), RH - 4);
    for (const n of notes()) {
      const x = xOf(n.t), y = yOf(n.p), w = Math.max(3, n.d * zx - 1);
      if (x > W || x + w < KW || y > Hh || y + RH < 0) continue;
      g.globalAlpha = 0.45 + 0.55 * ((n.v ?? 100) / 127);
      g.fillStyle = ch.color; g.fillRect(x, y + 1, w, RH - 2);
      g.globalAlpha = 1;
      if (sel.has(n)) { g.strokeStyle = th.sel; g.lineWidth = 1.5; g.strokeRect(x + 0.5, y + 1.5, w - 1, RH - 3); g.lineWidth = 1; }
    }
    const pos = h.position();
    if (pos != null && pos >= 0 && pos <= len()) { const x = xOf(pos); if (x >= KW) { g.strokeStyle = th.head; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, Hh); g.stroke(); } }
    // teclas (na bateria, o nome da peça)
    g.fillStyle = th.white; g.fillRect(0, 0, KW, Hh);
    g.font = '9px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (let n = p0; n >= p1; n--) {
      const y = yOf(n);
      if (BLACK.includes(n % 12)) { g.fillStyle = th.black; g.fillRect(0, y, KW * 0.6, RH); }
      g.strokeStyle = '#b9bec5'; g.beginPath(); g.moveTo(0, y + RH + 0.5); g.lineTo(KW, y + RH + 0.5); g.stroke();
      if (isDrums() && n >= 35 && n <= 81) { g.fillStyle = BLACK.includes(n % 12) ? '#eee' : '#555'; g.fillText(drumName(n).slice(0, 9), 2, y + RH / 2); }
      else if (n % 12 === 0) { g.fillStyle = '#555'; g.fillText(noteLabel(n), KW - 26, y + RH / 2); }
    }
    g.strokeStyle = '#9aa0a6'; g.beginPath(); g.moveTo(KW + 0.5, 0); g.lineTo(KW + 0.5, Hh); g.stroke();
    drawVel(th);
  }
  function drawVel(th) {
    const w = vcv.clientWidth;
    vg.setTransform(dpr, 0, 0, dpr, 0, 0);
    vg.fillStyle = th.vbg; vg.fillRect(0, 0, w, VH);
    vg.fillStyle = '#888'; vg.font = '10px system-ui, sans-serif'; vg.textBaseline = 'top'; vg.fillText('Força', 4, 4);
    for (const n of notes()) {
      const x = xOf(n.t);
      if (x < KW || x > w) continue;
      const hh = ((n.v ?? 100) / 127) * (VH - 8);
      vg.fillStyle = CH().color; vg.globalAlpha = sel.has(n) ? 1 : 0.7;
      vg.fillRect(x, VH - hh, 3, hh); vg.beginPath(); vg.arc(x + 1.5, VH - hh, 3, 0, Math.PI * 2); vg.fill();
      vg.globalAlpha = 1;
    }
  }

  function refreshBar() {
    const pat = PAT(), ch = CH();
    if (!pat || !ch) return;
    el.querySelector('[data-r="name"]').textContent = `${ch.name} · ${pat.name}`;
    el.querySelector('[data-pr="bars"]').value = Math.round((len() / P().sig) * 100) / 100;
  }
  const noteAt = (x, y) => {
    const b = beatAt(x), pt = pitchAt(y), list = notes();
    for (let i = list.length - 1; i >= 0; i--) { const n = list[i]; if (n.p === pt && b >= n.t && b <= n.t + n.d) return n; }
    return null;
  };
  const removeNotes = (set) => { const pat = PAT(), ch = CH(); pat.notes[ch.id] = notes().filter((n) => !set.has(n)); set.forEach((n) => sel.delete(n)); };

  cv.addEventListener('pointerdown', (e) => {
    if (!PAT() || !CH()) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    cv.setPointerCapture(e.pointerId);
    if (x < KW) { h.preview(pitchAt(y), 100); return; }
    if (e.button === 2) { drag = { kind: 'erase', began: false }; const n = noteAt(x, y); if (n) { h.begin(); drag.began = true; removeNotes(new Set([n])); draw(); } return; }
    let n = noteAt(x, y);
    h.begin();
    let created = false;
    if (!n) {
      const t = Math.max(0, snapB(beatAt(x), e, true));
      const d = isDrums() ? STEP : lastLen;
      const made = STAMPS[stamp][1].map((iv) => ({ p: Math.min(127, pitchAt(y) + iv), t, d, v: lastVel }));
      notes().push(...made); created = true;
      n = made[0];
      sel = new Set(made);
      made.forEach((m) => h.preview(m.p, m.v));
    } else if (!sel.has(n)) { sel = e.shiftKey ? new Set([...sel, n]) : new Set([n]); h.preview(n.p, n.v); }
    else if (e.shiftKey) sel.delete(n);
    const right = xOf(n.t + n.d);
    drag = { kind: !created && x > right - 7 ? 'len' : 'move', n, b0: beatAt(x), p0: pitchAt(y), orig: [...sel].map((k) => [k, { ...k }]), moved: created };
    draw();
  });
  cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (!drag) {
      const n = x > KW ? noteAt(x, y) : null;
      cv.style.cursor = x < KW ? 'pointer' : n && x > xOf(n.t + n.d) - 7 ? 'ew-resize' : n ? 'grab' : 'crosshair';
      return;
    }
    if (drag.kind === 'erase') { const n = noteAt(x, y); if (n) { if (!drag.began) { h.begin(); drag.began = true; } removeNotes(new Set([n])); draw(); } return; }
    const db = beatAt(x) - drag.b0, dp = pitchAt(y) - drag.p0;
    drag.moved = true;
    if (drag.kind === 'len') {
      for (const [k, o] of drag.orig) k.d = Math.max(P().snap || 0.0625, snapB(o.t + o.d + db, e) - o.t);
      lastLen = drag.n.d;
    } else {
      const base = drag.orig.find(([k]) => k === drag.n)[1];
      const shift = Math.max(0, snapB(base.t + db, e)) - base.t;
      const before = drag.n.p;
      for (const [k, o] of drag.orig) { k.t = Math.max(0, o.t + shift); k.p = Math.max(0, Math.min(127, o.p + dp)); }
      if (drag.n.p !== before) h.preview(drag.n.p, drag.n.v);
    }
    draw();
  });
  const up = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'erase') { if (d.began) h.end(); return; }
    if (d.moved) { h.end(); refreshBar(); layout(); } else h.cancel();
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('dblclick', (e) => {
    const r = cv.getBoundingClientRect(), n = noteAt(e.clientX - r.left, e.clientY - r.top);
    if (!n) return;
    h.begin(); removeNotes(new Set([n])); h.end(); draw();
  });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  // faixa de força: arraste para desenhar a força das notas por onde passar
  vcv.addEventListener('pointerdown', (e) => {
    vcv.setPointerCapture(e.pointerId);
    h.begin();
    let changed = false;
    const paint = (ev) => {
      const r = vcv.getBoundingClientRect(), x = ev.clientX - r.left, v = Math.round(Math.max(1, Math.min(127, (1 - (ev.clientY - r.top) / VH) * 127)));
      const targets = sel.size ? [...sel] : notes();
      for (const n of targets) if (Math.abs(xOf(n.t) - x) < 6) { n.v = v; changed = true; lastVel = v; }
      draw();
    };
    paint(e);
    const move = (ev) => paint(ev);
    const stop = () => { vcv.removeEventListener('pointermove', move); vcv.removeEventListener('pointerup', stop); if (changed) h.end(); else h.cancel(); };
    vcv.addEventListener('pointermove', move); vcv.addEventListener('pointerup', stop);
  });
  scroll.addEventListener('scroll', draw);
  scroll.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, b = beatAt(x);
    zx = Math.max(8, Math.min(400, zx * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    layout();
    scroll.scrollLeft = Math.max(0, KW + b * zx - x);
  }, { passive: false });

  const edit = (fn) => { h.begin(); fn(); h.end(); refreshBar(); layout(); };
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-pr]')?.dataset.pr;
    if (!a || !PAT() || !CH() || a === 'bars' || a === 'stamp') return;
    const targets = () => (sel.size ? [...sel] : notes());
    if (a[0] === 't' && a !== 'quant') { const k = Number(a.slice(1)); edit(() => targets().forEach((n) => { n.p = Math.max(0, Math.min(127, n.p + k)); })); }
    if (a === 'quant') { const q = P().snap || STEP; edit(() => targets().forEach((n) => { n.t = Math.round(n.t / q) * q; n.d = Math.max(q, Math.round(n.d / q) * q); })); }
    if (a === 'del') edit(() => removeNotes(new Set(targets())));
  });
  el.addEventListener('change', (e) => {
    const a = e.target.dataset.pr;
    if (a === 'bars') { const v = Math.max(1, Math.min(64, Math.round(Number(e.target.value) || 1))); edit(() => { PAT().len = v * P().sig; }); }
    if (a === 'stamp') stamp = Number(e.target.value);
  });

  const ro = new ResizeObserver(() => layout());
  ro.observe(scroll);

  return {
    /** Mostra o canal/padrão atual (keepSel: depois de desfazer, mantém a seleção pelas posições). */
    show(keepSel = false) {
      if (!keepSel) sel = new Set();
      else sel = new Set(notes().filter((n) => [...sel].some((s) => s.p === n.p && s.t === n.t)));
      layout(); refreshBar();
      if (!keepSel) {
        const ps = notes().map((n) => n.p);
        const mid = ps.length ? (Math.min(...ps) + Math.max(...ps)) / 2 : (CH()?.stepNote ?? 60);
        scroll.scrollTop = Math.max(0, (127 - mid) * RH - scroll.clientHeight / 2);
        scroll.scrollLeft = 0;
      }
    },
    draw,
    /** Atalhos quando o piano roll está em foco. Retorna true se tratou. */
    key(e) {
      if (!PAT() || !CH()) return false;
      if (e.key === 'Delete' || e.key === 'Backspace') { if (!sel.size) return false; edit(() => removeNotes(new Set(sel))); return true; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { sel = new Set(notes()); draw(); return true; }
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && sel.size) { const k = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1); edit(() => sel.forEach((n) => { n.p = Math.max(0, Math.min(127, n.p + k)); })); return true; }
      return false;
    },
    destroy() { ro.disconnect(); },
  };
}
