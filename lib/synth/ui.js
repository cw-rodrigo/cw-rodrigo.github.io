// Painel do sintetizador: escolha do motor, presets, controles gerados pelos esquemas de parâmetros,
// editor de harmônicos, sequências do NES, amostras (GM, arquivo ou gravação) e efeitos.
import { ENGINES, COMMON, ENGINE_IDS, defaults } from './schemas.js';
import { PRESETS } from './presets.js';
import { GM } from './gm.js';
import { syncedStore, mergeArrays, mergeTombs } from '../core/sync.js';
import { PEDAL_NAME } from '../pocketmaster/pm.js';
import { decodeFile, getInput, listInputs, Recorder, captureError } from '../audio/io.js';
import { $, esc, uid, toast, promptBox, confirmBox, busyButton } from '../core/ui.js';

export const presetStore = syncedStore('synth', 'synth.v1', { presets: [], deleted: {} }, (a, b) => {
  const deleted = mergeTombs(a.deleted, b.deleted);
  return { ...a, deleted, presets: mergeArrays(a.presets, b.presets, deleted) };
});

const FX = { name: 'Efeitos', fx: true, params: [
  { id: 'delayMix', label: 'Delay', type: 'range', min: 0, max: 0.8, step: 0.01 }, { id: 'delayTime', label: 'Tempo do delay', type: 'range', min: 0.03, max: 1.5, step: 0.01, unit: 's' },
  { id: 'delayFb', label: 'Repetições', type: 'range', min: 0, max: 0.9, step: 0.01 }, { id: 'reverbMix', label: 'Reverb', type: 'range', min: 0, max: 1, step: 0.01 },
  { id: 'reverbSize', label: 'Tamanho do reverb', type: 'range', min: 0.3, max: 6, step: 0.1, unit: 's' }] };

const toSlider = (p, v) => (p.curve === 'log' ? Math.round((Math.log(v / p.min) / Math.log(p.max / p.min)) * 1000) : v);
const fromSlider = (p, x) => (p.curve === 'log' ? +(p.min * (p.max / p.min) ** (x / 1000)).toPrecision(4) : Number(x));
function fmt(p, v) {
  if (p.type === 'toggle') return v ? 'ligado' : 'desligado';
  const n = Number(v);
  const s = Math.abs(n) >= 100 || Number.isInteger(n) && (p.step || 1) >= 1 ? Math.round(n) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2);
  return `${s}${p.unit ? ' ' + p.unit : ''}`;
}

function control(p, v, prefix) {
  const id = `${prefix}-${p.id}`;
  if (p.type === 'select') return `<div class="col"><label class="form-label small mb-0" for="${id}">${esc(p.label)}</label><select class="form-select form-select-sm" id="${id}" data-param="${p.id}">${p.options.map((o, i) => `<option value="${i}"${i === Number(v) ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
  if (p.type === 'toggle') return `<div class="col d-flex align-items-end"><div class="form-check form-switch mb-1"><input class="form-check-input" type="checkbox" role="switch" id="${id}" data-param="${p.id}"${v ? ' checked' : ''}><label class="form-check-label small" for="${id}">${esc(p.label)}</label></div></div>`;
  if (p.type === 'text') return `<div class="col-12"><label class="form-label small mb-0" for="${id}">${esc(p.label)}</label><input class="form-control form-control-sm font-monospace" id="${id}" data-param="${p.id}" value="${esc(v ?? '')}" placeholder="vazio = sem sequência" spellcheck="false">${p.hint ? `<div class="form-text">${esc(p.hint)}</div>` : ''}</div>`;
  if (p.type === 'harmonics') return `<div class="col-12"><div class="small mb-1">${esc(p.label)} <span class="text-body-secondary">(arraste para desenhar)</span></div><canvas class="harm-canvas w-100 border rounded" height="120" data-harm="${p.id}" aria-label="Volumes dos harmônicos"></canvas></div>`;
  return `<div class="col"><label class="form-label small mb-0 d-flex justify-content-between gap-2" for="${id}"><span class="text-truncate">${esc(p.label)}</span><output class="text-body-secondary text-nowrap">${fmt(p, v)}</output></label>
    <input type="range" class="form-range" id="${id}" data-param="${p.id}" min="${p.curve === 'log' ? 0 : p.min}" max="${p.curve === 'log' ? 1000 : p.max}" step="${p.curve === 'log' ? 1 : p.step || 0.01}" value="${toSlider(p, v)}"></div>`;
}

/**
 * Painel completo em `el` controlando `synth`.
 * opts: { lockEngine: bool, onEngine(engine) }
 */
export function synthPanel(el, synth, opts = {}) {
  const prefix = 'sp' + uid();
  const allParams = () => [COMMON, ...ENGINES[synth.state.engine].groups].flatMap((g) => g.params);

  function presetOptions() {
    const eng = synth.state.engine;
    const mine = presetStore.data.presets.filter((p) => p.engine === eng);
    return `<optgroup label="Fábrica">${(PRESETS[eng] || []).map((p, i) => `<option value="f${i}">${esc(p.name)}</option>`).join('')}</optgroup>${mine.length ? `<optgroup label="Meus presets">${mine.map((p) => `<option value="u${p.id}">${esc(p.name)}</option>`).join('')}</optgroup>` : ''}`;
  }

  function sourceSection() {
    const eng = synth.state.engine;
    if (eng !== 'sampler' && eng !== 'granular') return '';
    const src = synth.state.source;
    const label = src?.kind === 'gm' ? `General MIDI: ${GM[src.program]?.name}` : src?.kind === 'sample' ? `Amostra: ${src.name || 'gravação'}` : eng === 'granular' ? 'Usando uma textura gerada (escolha em "Áudio de origem")' : 'Nenhuma amostra carregada';
    return `<section class="card mb-3"><div class="card-body">
      <h3 class="h6">Amostra</h3><p class="small text-body-secondary mb-2" data-r="srcLabel">${esc(label)}</p>
      ${eng === 'sampler' ? `<div class="input-group input-group-sm mb-2"><label class="input-group-text" for="${prefix}-gm">Instrumento GM</label>
        <select class="form-select" id="${prefix}-gm">${GM.map((g) => `<option value="${g.program}"${src?.kind === 'gm' && src.program === g.program ? ' selected' : ''}>${g.program + 1}. ${esc(g.name)}</option>`).join('')}</select>
        <button class="btn btn-outline-primary" type="button" data-a="gm">Carregar</button></div>` : ''}
      <div class="d-flex flex-wrap gap-2 align-items-center">
        <label class="btn btn-sm btn-outline-secondary mb-0"><i class="bi bi-file-earmark-music"></i> Usar um arquivo<input type="file" accept="audio/*,video/*" data-a="file" hidden></label>
        <select class="form-select form-select-sm w-auto" data-r="input" aria-label="Entrada para gravar"><option value="">Microfone padrão</option></select>
        <button class="btn btn-sm btn-outline-danger" type="button" data-a="rec"><i class="bi bi-record-circle"></i> Gravar amostra</button>
      </div>
      <div class="form-text">Grave da sua Pocket Master escolhendo a entrada USB dela. Na amostra sua, ajuste a "Nota original".</div>
    </div></section>`;
  }

  function render() {
    const eng = synth.state.engine, info = ENGINES[eng], vals = synth.params();
    el.innerHTML = `
      <div class="synth-panel">
        <div class="row g-2 align-items-end mb-3">
          ${opts.lockEngine ? '' : `<div class="col-sm-5 col-lg-4"><label class="form-label small mb-0" for="${prefix}-eng">Tipo de síntese</label>
            <select class="form-select" id="${prefix}-eng">${ENGINE_IDS.map((id) => `<option value="${id}"${id === eng ? ' selected' : ''}>${esc(ENGINES[id].name)}</option>`).join('')}</select></div>`}
          <div class="col-sm"><label class="form-label small mb-0" for="${prefix}-preset">Preset</label>
            <div class="input-group"><select class="form-select" id="${prefix}-preset"><option value="">Escolha…</option>${presetOptions()}</select>
            <button class="btn btn-outline-secondary" type="button" data-a="save" title="Guardar como preset"><i class="bi bi-bookmark-plus"></i><span class="visually-hidden">Guardar preset</span></button>
            <button class="btn btn-outline-secondary" type="button" data-a="delpreset" title="Apagar preset meu" hidden><i class="bi bi-trash"></i><span class="visually-hidden">Apagar preset</span></button></div></div>
          <div class="col-auto"><div class="progress" style="width:90px;height:8px" title="Nível de saída" aria-label="Nível"><div class="progress-bar" data-r="meter" style="width:0%"></div></div></div>
        </div>
        <p class="small text-body-secondary">${esc(info.desc)}</p>
        ${sourceSection()}
        <div class="row row-cols-1 row-cols-lg-2 g-3">${[...info.groups, COMMON, FX].map((g) => `
          <div class="col"><section class="card h-100"><div class="card-body py-2">
            <h3 class="h6 mb-2">${esc(g.name)}</h3>
            <div class="row row-cols-1 row-cols-sm-2 g-2">${g.params.map((p) => control(p, g.fx ? synth.state.fx[p.id] : vals[p.id], prefix + (g.fx ? 'fx' : ''))).join('')}</div>
          </div></section></div>`).join('')}</div>
      </div>`;
    el.querySelectorAll('[data-harm]').forEach((c) => drawHarm(c));
    fillInputs();
  }

  function drawHarm(c) {
    const h = synth.params().harm || [];
    const w = c.clientWidth || 600;
    c.width = w;
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, c.height);
    const bw = w / h.length;
    const col = getComputedStyle(document.body).getPropertyValue('--bs-primary') || '#0d6efd';
    g.fillStyle = col;
    h.forEach((v, i) => { const hh = Math.max(0, Math.min(1, v)) * (c.height - 4); g.fillRect(i * bw + 1, c.height - hh, bw - 2, hh); });
  }

  async function fillInputs() {
    const sel = el.querySelector('[data-r="input"]');
    if (!sel) return;
    try {
      const list = await listInputs();
      if (!list.some((d) => d.label)) return;
      sel.innerHTML = '<option value="">Microfone padrão</option>' + list.map((d) => `<option value="${esc(d.deviceId)}"${PEDAL_NAME.test(d.label) ? ' selected' : ''}>${esc(d.label)}</option>`).join('');
    } catch { /* sem lista */ }
  }

  const setFromInput = (t) => {
    const id = t.dataset.param;
    const isFx = FX.params.some((p) => p.id === id) && t.id.includes('fx-');
    const p = isFx ? FX.params.find((x) => x.id === id) : allParams().find((x) => x.id === id);
    if (!p) return;
    let v;
    if (p.type === 'toggle') v = t.checked;
    else if (p.type === 'select') v = Number(t.value);
    else if (p.type === 'text') v = t.value;
    else v = fromSlider(p, t.value);
    const out = t.parentElement.querySelector('output');
    if (out) out.textContent = fmt(p, v);
    if (isFx) synth.setFx({ [id]: v }); else synth.setParams({ [id]: v });
  };

  let recording = null;
  el.addEventListener('input', (e) => { if (e.target.dataset.param && e.target.type !== 'text') setFromInput(e.target); });
  el.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.param) { setFromInput(t); return; }
    if (t.id === `${prefix}-eng`) { synth.setEngine(t.value, {}); opts.onEngine?.(t.value); render(); return; }
    if (t.id === `${prefix}-preset`) { applyPreset(t.value); return; }
    if (t.dataset.a === 'file' && t.files[0]) {
      try { const a = await decodeFile(t.files[0], 0, Infinity, { min: 0.02 }); synth.useSample(a, { name: t.files[0].name }); toast('Amostra carregada.', 'success'); render(); } catch { toast('Não consegui ler esse arquivo.', 'danger'); }
    }
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'save') {
      const name = await promptBox('Nome do preset', '', { ok: 'Guardar' });
      if (!name) return;
      presetStore.data.presets.push({ id: uid(), name, engine: synth.state.engine, params: structuredClone(synth.state.params), fx: structuredClone(synth.state.fx), updatedAt: Date.now() });
      presetStore.save(); render(); toast('Preset guardado.', 'success');
    }
    if (b.dataset.a === 'delpreset') {
      const sel = el.querySelector(`#${prefix}-preset`).value;
      const p = presetStore.data.presets.find((x) => 'u' + x.id === sel);
      if (p && await confirmBox(`Apagar o preset "${p.name}"?`, { ok: 'Apagar', danger: true })) {
        presetStore.data.presets = presetStore.data.presets.filter((x) => x !== p);
        presetStore.data.deleted[p.id] = Date.now(); presetStore.save(); render();
      }
    }
    if (b.dataset.a === 'gm') {
      const prog = Number(el.querySelector(`#${prefix}-gm`).value);
      busyButton(b, true, 'Baixando…');
      try { await synth.loadGM(prog, (f) => { b.innerHTML = `<span class="spinner-border spinner-border-sm"></span> ${Math.round(f * 100)}%`; }); toast(`${GM[prog].name} carregado.`, 'success'); render(); } catch (err) { toast(err.message, 'danger'); busyButton(b, false); }
    }
    if (b.dataset.a === 'rec') {
      if (recording) {
        const r = recording; recording = null;
        r.rec.stop();
        if (r.rec.seconds < 0.3) { toast('Gravação curta demais.'); render(); return; }
        synth.useSample(r.rec.result(), { name: 'gravação' }); toast('Amostra gravada.', 'success'); render(); return;
      }
      try {
        const stream = await getInput(el.querySelector('[data-r="input"]').value || null);
        const rec = new Recorder();
        await rec.start(stream);
        recording = { rec };
        b.innerHTML = '<i class="bi bi-stop-fill"></i> Parar e usar';
        fillInputs();
      } catch (err) { toast(captureError(err, 'a entrada de áudio'), 'danger'); }
    }
  });
  // editor de harmônicos: arrastar desenha os volumes
  el.addEventListener('pointerdown', (e) => {
    const c = e.target.closest('[data-harm]');
    if (!c) return;
    c.setPointerCapture(e.pointerId);
    const paint = (ev) => {
      const r = c.getBoundingClientRect();
      const h = [...(synth.params().harm || [])];
      const i = Math.floor(((ev.clientX - r.left) / r.width) * h.length);
      if (i < 0 || i >= h.length) return;
      h[i] = +Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height)).toFixed(3);
      synth.setParams({ harm: h });
      drawHarm(c);
    };
    paint(e);
    const move = (ev) => paint(ev);
    const up = () => { c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); };
    c.addEventListener('pointermove', move); c.addEventListener('pointerup', up);
  });

  function applyPreset(v) {
    if (!v) return;
    const eng = synth.state.engine;
    let preset = null;
    if (v[0] === 'f') preset = PRESETS[eng]?.[Number(v.slice(1))];
    else preset = presetStore.data.presets.find((x) => 'u' + x.id === v);
    if (!preset) return;
    synth.setEngine(eng, structuredClone(preset.params));
    if (preset.fx) synth.setFx(preset.fx);
    render();
    const sel = el.querySelector(`#${prefix}-preset`);
    sel.value = v;
    el.querySelector('[data-a="delpreset"]').hidden = v[0] !== 'u';
  }

  let raf = 0;
  const meter = () => { const m = el.querySelector('[data-r="meter"]'); if (m) { m.style.width = Math.min(100, synth.meter * 100) + '%'; m.classList.toggle('bg-danger', synth.meter > 0.98); } raf = requestAnimationFrame(meter); };
  render();
  meter();
  return { render, destroy() { cancelAnimationFrame(raf); recording?.rec.stop(); } };
}

export { defaults };
