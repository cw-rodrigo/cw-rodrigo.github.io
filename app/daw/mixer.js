// Mixer (como o do FL): uma faixa por insert, com medidor, fader, pan, mudo/solo e armar para gravar.
// O insert selecionado mostra ao lado os slots de efeitos, os envios para outros inserts e a entrada
// de gravação (ex.: a entrada USB da Pocket Master).
import { esc } from '/lib/core/ui.js';
import { FX, FX_IDS, fxDefaults } from './fx.js';

const toSlider = (p, v) => (p.curve === 'log' ? Math.round((Math.log(v / p.min) / Math.log(p.max / p.min)) * 1000) : v);
const fromSlider = (p, x) => (p.curve === 'log' ? +(p.min * (p.max / p.min) ** (x / 1000)).toPrecision(4) : Number(x));
const fmt = (p, v) => { const n = Number(v); return `${Math.abs(n) >= 100 ? Math.round(n) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2)}${p.unit ? ' ' + p.unit : ''}`; };
const dbText = (v) => (v <= -60 ? '−∞' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`);
export const MAX_SLOTS = 8;

/**
 * h: { project(), selected(), select(insId), begin(), end(opts), change(fn, opts), live(), level(insId),
 *      inputs() -> Promise<[{deviceId,label}]>, pmHtml(ins) -> HTML da Pocket Master, onPm(e, ins), monitor(ins), arm(ins),
 *      remove(insId), add(), openSlot (slot aberto) }
 */
export function mixerView(el, h) {
  let gesture = false;
  function render() {
    const p = h.project(), sel = h.selected();
    const ins = p.mixer.inserts.find((i) => i.id === sel) || p.mixer.inserts[0];
    el.innerHTML = `
      <div class="mixer d-flex gap-3 flex-column flex-xl-row">
        <div class="mix-strips d-flex gap-1 overflow-auto pb-2">${p.mixer.inserts.map((i, n) => strip(p, i, n, i.id === ins.id)).join('')}
          <button class="btn btn-outline-secondary mix-add align-self-stretch" type="button" data-mx="add" title="Insert novo"><i class="bi bi-plus-lg"></i><span class="visually-hidden">Insert novo</span></button>
        </div>
        <div class="mix-detail flex-grow-1">${detail(p, ins)}</div>
      </div>`;
    fillInputs(ins);
  }
  function strip(p, i, n, selected) {
    const master = n === 0;
    return `<div class="mix-strip${selected ? ' sel' : ''}${i.mute ? ' muted' : ''}" data-ins="${i.id}" style="--c:${i.color}">
      <button class="mix-name" type="button" data-mx="select" title="${esc(i.name)}"><span class="mix-num">${master ? 'M' : n}</span> ${esc(i.name)}</button>
      <div class="d-flex justify-content-center gap-1 my-1">
        <div class="vmeter"><div data-meter="${i.id}"></div></div>
        <input type="range" class="vfader" data-m="vol" min="-60" max="6" step="0.5" value="${i.vol}" aria-label="Volume de ${esc(i.name)}">
      </div>
      <div class="text-center small font-monospace" data-r="db">${dbText(i.vol)}</div>
      <input type="range" class="form-range mix-pan" data-m="pan" min="-1" max="1" step="0.01" value="${i.pan}" title="Pan" aria-label="Pan de ${esc(i.name)}">
      <div class="d-flex justify-content-center gap-1">
        <button class="btn btn-sm ${i.mute ? 'btn-outline-secondary' : 'btn-success'} mix-btn" type="button" data-mx="mute" title="${i.mute ? 'Ligar' : 'Silenciar'}" aria-pressed="${!i.mute}"><i class="bi bi-power"></i></button>
        ${master ? '' : `<button class="btn btn-sm ${i.solo ? 'btn-info' : 'btn-outline-secondary'} mix-btn" type="button" data-mx="solo" title="Solo" aria-pressed="${i.solo}">S</button>
        <button class="btn btn-sm ${i.arm ? 'btn-danger' : 'btn-outline-secondary'} mix-btn" type="button" data-mx="arm" title="Armar para gravar a entrada" aria-pressed="${i.arm}"><i class="bi bi-record-fill"></i></button>`}
      </div>
      <div class="mix-fxdots" aria-hidden="true">${i.fx.map((f) => `<i class="${f.on ? 'on' : ''}" title="${esc(FX[f.type].name)}"></i>`).join('')}</div>
    </div>`;
  }
  function detail(p, ins) {
    const master = ins === p.mixer.inserts[0];
    const others = p.mixer.inserts.filter((x, k) => k > 0 && x.id !== ins.id);
    return `
      <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
        <input class="form-control form-control-sm w-auto" data-d="name" value="${esc(ins.name)}" aria-label="Nome do insert"${master ? ' disabled' : ''}>
        ${master ? '' : '<button class="btn btn-sm btn-outline-danger ms-auto" type="button" data-mx="remove"><i class="bi bi-trash"></i> Apagar insert</button>'}
      </div>
      <h3 class="h6 mt-2">Efeitos</h3>
      <div class="vstack gap-1 mb-2">${ins.fx.map((f, k) => `
        <details class="mix-slot border rounded" data-slot="${k}"${k === h.openSlot ? ' open' : ''}>
          <summary class="d-flex align-items-center gap-2 px-2 py-1">
            <span class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" role="switch" data-s="on"${f.on ? ' checked' : ''} aria-label="Ligar ${esc(FX[f.type].name)}"></span>
            <strong class="small">${k + 1}. ${esc(FX[f.type].name)}</strong>
            <span class="ms-auto btn-group btn-group-sm">
              <button class="btn btn-link btn-sm px-1" type="button" data-s="up" title="Subir"><i class="bi bi-arrow-up"></i></button>
              <button class="btn btn-link btn-sm px-1" type="button" data-s="down" title="Descer"><i class="bi bi-arrow-down"></i></button>
              <button class="btn btn-link btn-sm px-1 text-danger" type="button" data-s="del" title="Tirar o efeito"><i class="bi bi-x-lg"></i></button>
            </span>
          </summary>
          <div class="row row-cols-2 row-cols-md-3 g-2 p-2">${FX[f.type].params.map((prm) => {
            const v = f.params?.[prm.id] ?? prm.def;
            if (prm.type === 'select') return `<div class="col"><label class="form-label small mb-0">${esc(prm.label)}<select class="form-select form-select-sm" data-fp="${prm.id}">${prm.options.map((o, i) => `<option value="${i}"${i === Number(v) ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label></div>`;
            return `<div class="col"><label class="form-label small mb-0 d-block"><span class="d-flex justify-content-between"><span>${esc(prm.label)}</span><output>${fmt(prm, v)}</output></span>
              <input type="range" class="form-range" data-fp="${prm.id}" min="${prm.curve === 'log' ? 0 : prm.min}" max="${prm.curve === 'log' ? 1000 : prm.max}" step="${prm.curve === 'log' ? 1 : prm.step}" value="${toSlider(prm, v)}"></label></div>`;
          }).join('')}</div>
        </details>`).join('')}
      </div>
      ${ins.fx.length < MAX_SLOTS ? `<select class="form-select form-select-sm w-auto" data-d="addfx" aria-label="Pôr um efeito"><option value="">+ Pôr um efeito…</option>${FX_IDS.map((t) => `<option value="${t}">${esc(FX[t].name)}</option>`).join('')}</select>` : ''}
      ${master ? '' : `
        <h3 class="h6 mt-3">Envios</h3>
        <p class="small text-body-secondary mb-1">Além do master, manda uma parte do som para outro insert (por exemplo, um insert só com reverb).</p>
        ${ins.sends.map((s, k) => `<div class="d-flex align-items-center gap-2 mb-1" data-send="${k}"><span class="small text-nowrap">→ ${esc(p.mixer.inserts.find((x) => x.id === s.to)?.name || '?')}</span>
          <input type="range" class="form-range" data-send-amt min="0" max="1" step="0.01" value="${s.amount}" aria-label="Quantidade do envio"><button class="btn btn-sm btn-link text-danger" type="button" data-mx="unsend" aria-label="Tirar envio"><i class="bi bi-x-lg"></i></button></div>`).join('')}
        ${others.length ? `<select class="form-select form-select-sm w-auto" data-d="send" aria-label="Novo envio"><option value="">+ Enviar para…</option>${others.filter((x) => !ins.sends.some((s) => s.to === x.id)).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>` : ''}
        <h3 class="h6 mt-3">Entrada para gravar</h3>
        <div class="row g-2">
          <div class="col-sm-7"><label class="form-label small mb-0" for="mx-in">Gravar de</label><select class="form-select form-select-sm" id="mx-in" data-d="device"><option value="">${ins.input.match === 'pocket' ? 'Pocket Master (procurar sozinho)' : 'Entrada padrão'}</option></select></div>
          <div class="col-sm-5"><label class="form-label small mb-0" for="mx-ch">Canais</label><select class="form-select form-select-sm" id="mx-ch" data-d="channel">${[['stereo', 'Estéreo'], ['left', 'Só o esquerdo'], ['right', 'Só o direito']].map(([v, l]) => `<option value="${v}"${ins.input.channel === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        </div>
        <div class="form-check form-switch mt-2"><input class="form-check-input" type="checkbox" role="switch" id="mx-mon" data-d="monitor"${ins.input.monitor ? ' checked' : ''}><label class="form-check-label small" for="mx-mon">Ouvir a entrada pelo site quando armado (desligue se já ouve pelo fone da pedaleira)</label></div>
        <div class="mt-2" data-r="pm">${h.pmHtml(ins)}</div>`}`;
  }
  async function fillInputs(ins) {
    const s = el.querySelector('#mx-in');
    if (!s) return;
    const list = await h.inputs();
    if (!list.length) return;
    s.innerHTML = `<option value="">${ins.input.match === 'pocket' ? 'Pocket Master (procurar sozinho)' : 'Entrada padrão'}</option>` + list.map((d) => `<option value="${esc(d.deviceId)}"${d.deviceId === ins.input.deviceId ? ' selected' : ''}>${esc(d.label)}</option>`).join('');
  }
  const insOf = (t) => h.project().mixer.inserts.find((x) => x.id === (t.closest('[data-ins]')?.dataset.ins || h.selected())) || h.project().mixer.inserts[0];
  const slotOf = (t) => { const s = t.closest('[data-slot]'); return s ? Number(s.dataset.slot) : -1; };

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mx], [data-s]');
    if (!b) { if (e.target.closest('[data-r="pm"]')) h.onPm(e, insOf(e.target)); return; }
    const ins = insOf(b);
    if (b.dataset.s && b.tagName === 'BUTTON') {
      e.preventDefault();
      const k = slotOf(b), a = b.dataset.s;
      h.change(() => {
        if (a === 'del') ins.fx.splice(k, 1);
        if ((a === 'up' && k > 0) || (a === 'down' && k < ins.fx.length - 1)) { const j = a === 'up' ? k - 1 : k + 1; [ins.fx[k], ins.fx[j]] = [ins.fx[j], ins.fx[k]]; }
      });
      return;
    }
    const a = b.dataset.mx;
    if (a === 'select') { h.select(ins.id); return; }
    if (a === 'add') { h.add(); return; }
    if (a === 'remove') { h.remove(ins.id); return; }
    if (a === 'unsend') { const k = Number(b.closest('[data-send]').dataset.send); h.change(() => { ins.sends.splice(k, 1); }); return; }
    if (a === 'arm') { h.arm(ins); return; }
    if (a === 'mute' || a === 'solo') h.change(() => { ins[a] = !ins[a]; }, { structure: false });
  });
  el.addEventListener('toggle', (e) => { const s = e.target.closest?.('[data-slot]'); if (s && s.open) h.openSlot = Number(s.dataset.slot); }, true);
  el.addEventListener('input', (e) => {
    const t = e.target, ins = insOf(t);
    const m = t.dataset.m, fp = t.dataset.fp;
    if (!m && !fp && !('sendAmt' in t.dataset)) return;
    if (!gesture) { h.begin(); gesture = true; }
    if (m) {
      ins[m] = Number(t.value);
      if (m === 'vol') t.closest('.mix-strip').querySelector('[data-r="db"]').textContent = dbText(ins.vol);
    } else if (fp) {
      const f = ins.fx[slotOf(t)], prm = FX[f.type].params.find((x) => x.id === fp);
      f.params = { ...fxDefaults(f.type), ...f.params, [fp]: prm.type === 'select' ? Number(t.value) : fromSlider(prm, t.value) };
      const out = t.parentElement.querySelector('output');
      if (out) out.textContent = fmt(prm, f.params[fp]);
    } else ins.sends[Number(t.closest('[data-send]').dataset.send)].amount = Number(t.value);
    h.live();
  });
  el.addEventListener('change', (e) => {
    const t = e.target, ins = insOf(t);
    if (t.dataset.m || t.dataset.fp || 'sendAmt' in t.dataset) { if (gesture) { gesture = false; h.end({ structure: false }); } return; }
    if (t.dataset.s === 'on') { h.change(() => { ins.fx[slotOf(t)].on = t.checked; }); return; }
    const d = t.dataset.d;
    if (d === 'name') h.change(() => { ins.name = t.value.trim() || ins.name; }, { structure: false });
    if (d === 'addfx' && t.value) { const type = t.value; h.openSlot = ins.fx.length; h.change(() => { ins.fx.push({ type, on: true, params: fxDefaults(type) }); }); }
    if (d === 'send' && t.value) { const to = t.value; h.change(() => { ins.sends.push({ to, amount: 0.3 }); }); }
    if (d === 'device') h.change(() => { ins.input.deviceId = t.value; }, { structure: false }).then(() => h.monitor(ins));
    if (d === 'channel') h.change(() => { ins.input.channel = t.value; }, { structure: false }).then(() => h.monitor(ins));
    if (d === 'monitor') h.change(() => { ins.input.monitor = t.checked; }, { structure: false }).then(() => h.monitor(ins));
  });
  return { render };
}
