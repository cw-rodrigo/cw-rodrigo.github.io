// Editor do clipe de automação: escolher o que ele controla e desenhar a curva
// (clique cria ponto, arraste move, botão direito ou duplo clique apaga; Alt desliga a grade).
import { esc } from '/lib/core/ui.js';
import { targetsOf, resolveTarget, valueAt } from './automation.js';

/** h: { project(), clip(), begin(), end(), cancel(), change(fn) } */
export function autoEditor(el, h) {
  let W = 0, H = 180, dpr = 1, drag = null;
  function render() {
    const p = h.project(), c = h.clip();
    if (!c) { el.innerHTML = '<p class="text-body-secondary mb-0">Dê duplo clique num clipe de automação da playlist (ou crie um em “+ Automação”).</p>'; return; }
    const groups = new Map();
    for (const t of targetsOf(p)) { if (!groups.has(t.group)) groups.set(t.group, []); groups.get(t.group).push(t); }
    const tg = resolveTarget(p, c.target);
    el.innerHTML = `
      <div class="d-flex flex-wrap align-items-center gap-2 mb-2 small">
        <label class="d-flex align-items-center gap-1">Controla <select class="form-select form-select-sm" data-ae="target" style="max-width:24rem">${[...groups].map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((t) => `<option value="${esc(t.id)}"${t.id === c.target ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</optgroup>`).join('')}</select></label>
        ${tg ? '' : '<span class="text-danger">O que este clipe controlava foi apagado.</span>'}
        <button class="btn btn-sm btn-outline-secondary" type="button" data-ae="flat">Linha reta</button>
        <button class="btn btn-sm btn-outline-secondary" type="button" data-ae="up">Subida</button>
        <button class="btn btn-sm btn-outline-secondary" type="button" data-ae="down">Descida</button>
        <span class="text-body-secondary ms-auto">Clique cria ponto · arraste move · botão direito apaga</span>
      </div>
      <canvas class="ae-canvas border rounded w-100" style="height:${H}px;touch-action:none" aria-label="Curva da automação"></canvas>`;
    layout();
  }
  function layout() {
    const cv = el.querySelector('canvas');
    if (!cv) return;
    W = cv.clientWidth; dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    draw();
  }
  const X = (t) => 8 + (t / h.clip().len) * (W - 16);
  const Y = (v) => 8 + (1 - v) * (H - 16);
  const T = (x) => Math.max(0, Math.min(h.clip().len, ((x - 8) / (W - 16)) * h.clip().len));
  const V = (y) => Math.max(0, Math.min(1, 1 - (y - 8) / (H - 16)));
  function draw() {
    const cv = el.querySelector('canvas'), c = h.clip(), p = h.project();
    if (!cv || !c) return;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dark = document.documentElement.dataset.bsTheme === 'dark';
    g.fillStyle = dark ? '#1b1f24' : '#fafbfc'; g.fillRect(0, 0, W, H);
    g.strokeStyle = dark ? '#2e333a' : '#e1e4e8';
    for (let b = 0; b <= c.len; b += 1) { const x = Math.round(X(b)) + 0.5; g.lineWidth = b % p.sig === 0 ? 1.5 : 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    g.lineWidth = 2; g.strokeStyle = '#e3b341'; g.beginPath();
    for (let x = 8; x <= W - 8; x += 2) { const y = Y(valueAt(c.points, T(x))); if (x === 8) g.moveTo(x, y); else g.lineTo(x, y); }
    g.stroke();
    g.fillStyle = '#e3b341';
    for (const pt of c.points) { g.beginPath(); g.arc(X(pt.t), Y(pt.v), 5, 0, Math.PI * 2); g.fill(); }
    const tg = resolveTarget(p, c.target);
    if (tg) { g.fillStyle = dark ? '#c9d1d9' : '#333'; g.font = '11px system-ui'; g.fillText(tg.label, 12, 18); }
  }
  const sort = (c) => c.points.sort((a, b) => a.t - b.t);
  const near = (x, y) => h.clip().points.find((pt) => Math.hypot(X(pt.t) - x, Y(pt.v) - y) < 9);
  const snapT = (t, e) => { const s = h.project().snap; return s && !e.altKey ? Math.round(t / s) * s : t; };

  el.addEventListener('pointerdown', (e) => {
    const cv = e.target.closest('canvas');
    if (!cv) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, c = h.clip();
    cv.setPointerCapture(e.pointerId);
    let pt = near(x, y);
    if (e.button === 2) { if (pt && c.points.length > 1) h.change(() => { c.points = c.points.filter((q) => q !== pt); }); return; }
    h.begin();
    if (!pt) { pt = { t: snapT(T(x), e), v: V(y) }; c.points.push(pt); sort(c); }
    drag = { pt };
    draw();
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const cv = el.querySelector('canvas'), r = cv.getBoundingClientRect();
    drag.pt.t = snapT(T(e.clientX - r.left), e); drag.pt.v = V(e.clientY - r.top);
    sort(h.clip()); draw();
  });
  el.addEventListener('pointerup', () => { if (drag) { drag = null; h.end(); } });
  el.addEventListener('dblclick', (e) => {
    const cv = e.target.closest('canvas'); if (!cv) return;
    const r = cv.getBoundingClientRect(), pt = near(e.clientX - r.left, e.clientY - r.top), c = h.clip();
    if (pt && c.points.length > 1) h.change(() => { c.points = c.points.filter((q) => q !== pt); });
  });
  el.addEventListener('contextmenu', (e) => { if (e.target.closest('canvas')) e.preventDefault(); });
  el.addEventListener('change', (e) => {
    if (e.target.dataset.ae !== 'target') return;
    const c = h.clip(), tg = resolveTarget(h.project(), e.target.value);
    h.change(() => { c.target = e.target.value; c.label = tg?.label || ''; if (tg) c.points = [{ t: 0, v: tg.initial }, { t: c.len, v: tg.initial }]; });
  });
  el.addEventListener('click', (e) => {
    const a = e.target.closest('button[data-ae]')?.dataset.ae, c = h.clip();
    if (!a || !c) return;
    const tg = resolveTarget(h.project(), c.target), v0 = tg?.initial ?? 0.5;
    h.change(() => { c.points = a === 'flat' ? [{ t: 0, v: v0 }, { t: c.len, v: v0 }] : a === 'up' ? [{ t: 0, v: 0 }, { t: c.len, v: 1 }] : [{ t: 0, v: 1 }, { t: c.len, v: 0 }]; });
  });
  const ro = new ResizeObserver(() => layout());
  ro.observe(el);
  return { render, draw, destroy() { ro.disconnect(); } };
}
