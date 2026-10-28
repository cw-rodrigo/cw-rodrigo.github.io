// Timbres: ouve um trecho de música, sugere um timbre e monta o preset na Pocket Master.
import * as T from './tone.js';
import { startRefine, listInputs, guessPedalInput } from './refine.js';
import { analyzeTone, tempoEstimate } from '/lib/audio/tone.js';
import { mono, playSamples, getInput } from '/lib/audio/io.js';
import { audioSource } from '/lib/widgets/source.js';
import { drawCurves } from '/lib/widgets/chart.js';
import * as PM from '/lib/pocketmaster/session.js';
import { LABELS, USER_PRESETS, NAME_LEN, cleanName, slotLabel } from '/lib/pocketmaster/pm.js';
import { blockEditor, applyEdit } from '/lib/pocketmaster/editor.js';
import { S, db, deleteTone, getTone } from './store.js';
import { setLive } from '/lib/agent/live.js';
import { $, esc, toast, download, slug, confirmBox, progressHtml, setProgress, busyButton, debounce } from '/lib/core/ui.js';


const st = {
  map: null, audio: null, stems: null, features: null, song: null,
  instrument: db.prefs.instrument || 'guitar',
  macros: null, suggested: null, overrides: { blocks: {} },
  lastSent: null, toneId: null, dirty: false,
  refine: null, refineInfo: '', refineCurve: null, stopPlay: null,
};
let view = null, active = false, editor = null;
const spec = () => T.withOverrides(T.buildSpec(st.macros, st.map), st.overrides);

S.onRemote(() => { if (active) renderLib(); });
PM.onDevice((type) => {
  if (type === 'knob' || type === 'preset') st.lastSent = null; // mexeram na pedaleira: na próxima vez manda tudo
  if (type === 'disconnect') stopRefine();
  if (active && ['connect', 'disconnect', 'names', 'preset'].includes(type)) renderPedal();
});

export default {
  title: 'Timbres',
  async render(el, { q = {} } = {}) {
    view = el; active = true;
    st.map ||= await PM.map();
    el.innerHTML = `
      <h1 class="h2 mb-1">Timbre a partir de uma música</h1>
      <p class="text-body-secondary">Ouve um trecho, sugere um timbre e monta o preset na sua Pocket Master pelo USB ou Bluetooth.</p>
      <section class="card mb-4" aria-labelledby="h-song"><div class="card-body">
        <h2 class="h5" id="h-song"><span class="badge rounded-pill text-bg-primary me-1">1</span> A música</h2>
        <div class="d-flex flex-wrap gap-4 mb-3">
          <div><div class="small fw-bold mb-1">Instrumento</div>
            <div class="btn-group btn-group-sm" role="group" aria-label="Instrumento">
              <input type="radio" class="btn-check" name="t-inst" id="t-guitar" value="guitar"${st.instrument === 'guitar' ? ' checked' : ''}><label class="btn btn-outline-secondary" for="t-guitar">Guitarra</label>
              <input type="radio" class="btn-check" name="t-inst" id="t-bass" value="bass"${st.instrument === 'bass' ? ' checked' : ''}><label class="btn btn-outline-secondary" for="t-bass">Baixo</label>
            </div></div>
          <div class="form-check form-switch align-self-end"><input class="form-check-input" type="checkbox" role="switch" id="t-sep"${db.prefs.separate !== false ? ' checked' : ''}>
            <label class="form-check-label" for="t-sep">Separar o instrumento com IA <span class="small text-body-secondary">(bem mais preciso; baixa 84 MB na primeira vez e leva alguns minutos)</span></label></div>
        </div>
        <div id="t-source"></div>
        <div id="t-work" class="work mt-3" hidden aria-live="polite"><p class="small mb-2" id="t-msg"></p>${progressHtml('t-bar')}</div>
      </div></section>
      <section class="card mb-4" id="s-tone" aria-labelledby="h-tone" hidden><div class="card-body" id="tone-body"></div></section>
      <section class="card mb-4" id="s-pedal" aria-labelledby="h-pedal" hidden><div class="card-body">
        <h2 class="h5" id="h-pedal"><span class="badge rounded-pill text-bg-primary me-1">3</span> Na pedaleira</h2><div id="pedal"></div></div></section>
      <section aria-labelledby="h-lib" class="mb-4">
        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2"><h2 class="h5 mb-0" id="h-lib">Meus timbres</h2>
          <label class="btn btn-sm btn-outline-secondary mb-0"><i class="bi bi-upload"></i> Importar (.json)<input type="file" id="imp-file" accept="application/json,.json" hidden></label></div>
        <div id="lib" class="mt-2"></div>
      </section>
      <details class="small text-body-secondary">
        <summary class="text-primary">Como funciona e cuidados</summary>
        <p class="mt-2">A análise mede a curva de frequências do trecho, quanto de distorção há, a compressão e o reverb, e escolhe amplificador, caixa, equalizador e efeitos parecidos. É um ponto de partida: ajuste pelos controles e, para chegar mais perto, use o <strong>ajuste fino ouvindo a pedaleira</strong>, que compara o som que sai dela com a música enquanto você toca.</p>
        <p>Delay e modulação não são detectados sozinhos (o ritmo da palhetada se confunde com eco); escolha nos controles. O tempo do delay usa o andamento detectado.</p>
        <p>Conexão: cabo USB-C para USB-C ou Bluetooth (escolha "Sonic Master BLE"), no Chrome ou Edge (computador ou Android). O ajuste fino precisa do cabo, que leva o som da pedaleira ao computador. Mandar para a pedaleira muda só o preset em edição; nada é gravado até você salvar, e antes de salvar por cima de um preset uma cópia dele é guardada. Projeto não oficial; o protocolo vem do <a href="https://github.com/suckyble/PocketEdit" target="_blank" rel="noopener">PocketEdit</a> e do <a href="https://github.com/voronkovd/pocket-master-mcp" target="_blank" rel="noopener">pocket-master-mcp</a>.</p>
      </details>`;
    const src = audioSource($('#t-source'), {
      range: 'required', defaultRange: [30, 60], modes: ['youtube', 'file'],
      action: 'Ouvir o trecho e analisar',
      hint: 'Escolha 20 a 40 segundos em que o instrumento aparece bem, com o timbre que você quer (por exemplo, o riff do refrão).',
      onVideo: (v) => { st.song = { title: v.title, ytId: v.ytId }; },
      onAudio: (a) => processAudio(a),
    });
    if (st.song?.ytId) src.prefill(st.song);
    if (st.song?.start != null) src.setRange(st.song.start, st.song.end);
    el.onchange = (e) => {
      if (e.target.name === 't-inst') { st.instrument = e.target.value; db.prefs.instrument = st.instrument; S.save(); if (st.features) reanalyze(); }
      if (e.target.id === 't-sep') { db.prefs.separate = e.target.checked; S.save(); }
      if (e.target.id === 'imp-file') importTone(e.target);
    };
    const ask = q.abrir && getTone(q.abrir);
    if (ask) openTone(ask);
    else if (st.features) renderTone();
    renderLib();
    // agente editou o timbre que está aberto: mostra a versão nova
    const unLive = setLive('timbres', { reload(id) { const t = getTone(id); if (t && st.toneId === id) openTone(t); } });
    return () => { active = false; unLive(); st.stopPlay?.(); };
  },
  dirty: () => !!st.refine,
};

// ---------------------------------------------------------------- análise
function work(msg, frac = null) { const w = $('#t-work'); if (!w) return; w.hidden = false; $('#t-msg').textContent = msg; if (frac != null) setProgress($('#t-bar'), frac); }
function workDone() { const w = $('#t-work'); if (w) w.hidden = true; }

async function processAudio(audio) {
  st.audio = audio; st.stems = null;
  st.song = { ...(st.song || {}), title: audio.label, ytId: audio.ytId || st.song?.ytId || null, start: audio.start, end: audio.end };
  work('Medindo o andamento…', 0);
  const bpm = await tempoEstimate(mono(audio.channels), audio.sampleRate);
  if ($('#t-sep')?.checked ?? db.prefs.separate !== false) {
    try {
      const { separate } = await import('/lib/ai/separate.js');
      st.stems = await separate(audio.channels, audio.sampleRate, (msg, frac) => work(msg, frac));
    } catch (err) { toast('A separação falhou; vou analisar a música inteira. (' + (err.message || err) + ')', 'warning'); }
  }
  await analyzeSource(bpm);
}

async function analyzeSource(bpm = st.features?.bpm) {
  const src = st.stems ? (st.instrument === 'bass' ? st.stems.bass : st.stems.other) : mono(st.audio.channels);
  const sr = st.stems ? 44100 : st.audio.sampleRate;
  try {
    work('Analisando o timbre…', 0);
    const f = await analyzeTone(src, sr, (x) => work('Analisando o timbre…', x));
    f.bpm = bpm || 100;
    f.separated = !!st.stems;
    st.features = f;
    st.macros = T.macrosFromFeatures(f, st.instrument);
    st.suggested = structuredClone(st.macros);
    st.overrides = { blocks: {} };
    st.toneId = null; st.lastSent = null; st.refineCurve = null; st.dirty = true;
    workDone();
    if (!active) return;
    renderTone();
    $('#s-tone').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (db.prefs.live && PM.device()) sendNow();
  } catch (err) {
    workDone();
    toast(err.message || 'Não consegui analisar esse trecho.', 'danger');
  }
}
function reanalyze() {
  if (st.audio) { analyzeSource(); return; }
  st.macros = { ...st.macros, ...T.macrosFromFeatures(st.features, st.instrument), instrument: st.instrument };
  renderTone(); changed();
}

// ---------------------------------------------------------------- timbre
const fmtDb = (v) => `${v > 0 ? '+' : ''}${v} dB`;
const gainLabel = (v) => ['limpo', 'quase saturando', 'crunch', 'distorcido', 'alto ganho'][T.tierOf(v / 100)];
const FMT = { gain: (v) => `${v} · ${gainLabel(v)}`, reverb: (v) => (v < 8 ? 'sem' : v), rt: (v) => `${v} s`, delayMix: (v) => v, bass: fmtDb, mid: fmtDb, treble: fmtDb, presence: fmtDb };
const opts = (list, v) => list.map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${l}</option>`).join('');
const knob = (id, label, min, max, step, value) => `<label class="macro" for="m-${id}"><span>${label}</span><input class="form-range" type="range" id="m-${id}" data-m="${id}" min="${min}" max="${max}" step="${step}" value="${value}"><output>${(FMT[id] || String)(value)}</output></label>`;

function renderTone() {
  $('#s-tone').hidden = false;
  $('#s-pedal').hidden = false;
  const m = st.macros;
  $('#tone-body').innerHTML = `
    <h2 class="h5" id="h-tone"><span class="badge rounded-pill text-bg-primary me-1">2</span> O timbre</h2>
    <p class="fs-5 fw-bold mb-2" id="tone-desc"></p>
    <figure class="chart-box border rounded p-2 mb-2"><svg id="chart" role="img" aria-label="Curva de frequências"></svg><figcaption class="small text-body-secondary pt-1" id="chart-legend"></figcaption></figure>
    <div class="d-flex flex-wrap gap-2 mb-3" id="listen-row">${st.audio ? `<button class="btn btn-sm btn-outline-secondary" type="button" data-l="mix"><i class="bi bi-play-fill"></i> Ouvir o trecho</button>${st.stems ? `<button class="btn btn-sm btn-outline-secondary" type="button" data-l="inst"><i class="bi bi-play-fill"></i> Ouvir só ${st.instrument === 'bass' ? 'o baixo' : 'a guitarra e a harmonia'}</button>` : ''}<button class="btn btn-sm btn-outline-secondary" type="button" data-l="stop" hidden><i class="bi bi-stop-fill"></i> Parar</button>` : ''}</div>
    <form class="row g-4" id="macros" onsubmit="return false">
      <div class="col-md-6"><h3 class="h6 text-body-secondary text-uppercase small">Som</h3>
        ${knob('gain', 'Ganho', 0, 100, 1, m.gain)}${knob('bass', 'Graves', -12, 12, 0.5, m.bass)}${knob('mid', 'Médios', -12, 12, 0.5, m.mid)}${knob('treble', 'Agudos', -12, 12, 0.5, m.treble)}${knob('presence', 'Presença', -12, 12, 0.5, m.presence)}
        <div class="form-check form-switch mt-2"><input class="form-check-input" type="checkbox" role="switch" id="m-comp" data-m="comp"${m.comp ? ' checked' : ''}><label class="form-check-label" for="m-comp">Compressor (notas mais niveladas e sustentadas)</label></div></div>
      <div class="col-md-6"><h3 class="h6 text-body-secondary text-uppercase small">Efeitos</h3>
        ${knob('reverb', 'Reverb', 0, 100, 1, m.reverb)}${knob('rt', 'Duração do reverb', 0.2, 5, 0.1, m.rt)}
        <label class="macro"><span>Tipo de reverb</span><select class="form-select form-select-sm" data-m="reverbType">${opts(T.REVERB_OPTIONS, m.reverbType)}</select></label>
        <label class="macro"><span>Delay</span><select class="form-select form-select-sm" data-m="delay">${opts(T.DELAY_OPTIONS, m.delay)}</select></label>
        ${knob('delayMix', 'Volume do delay', 0, 60, 1, m.delayMix)}
        <label class="macro"><span>Andamento (BPM)</span><input class="form-control form-control-sm" type="number" data-m="bpm" min="40" max="240" step="1" value="${m.bpm}"></label>
        <label class="macro"><span>Modulação</span><select class="form-select form-select-sm" data-m="mod">${opts(T.MOD_OPTIONS, m.mod)}</select></label></div>
    </form>
    <div class="chip-list my-3" id="spec-summary" aria-label="Resumo do preset"></div>
    <details class="border rounded mb-3" id="adv"><summary class="p-2 fw-bold">Ver e ajustar cada bloco do preset</summary><div class="p-2" id="adv-body"></div></details>
    <div class="d-flex flex-wrap gap-2">
      <button class="btn btn-sm btn-outline-secondary" type="button" data-t="reset"><i class="bi bi-arrow-counterclockwise"></i> Voltar à sugestão da análise</button>
      <button class="btn btn-sm btn-primary" type="button" data-t="keep"><i class="bi bi-star"></i> ${st.toneId && !st.dirty ? 'Guardado' : 'Guardar em Meus timbres'}</button>
      <button class="btn btn-sm btn-outline-secondary" type="button" data-t="export"><i class="bi bi-download"></i> Baixar (.json)</button>
    </div>`;
  $('#tone-desc').textContent = T.describe(m) + (st.features.separated ? '' : ' (analisado com a música inteira)');
  renderChart();
  editor = blockEditor($('#adv-body'), {
    map: st.map, compact: true,
    onChange: (ch) => {
      const cur = spec();
      const next = applyEdit(st.map, cur, ch);
      const o = (st.overrides.blocks[ch.key] ||= {});
      const b = next.blocks[ch.key];
      if (ch.type === 'model') st.overrides.blocks[ch.key] = { model: b.model, params: { ...b.params }, on: true };
      else { o.model ||= b.model; if (ch.type === 'param') o.params = { ...(o.params || {}), [ch.name]: ch.value }; if (ch.type === 'on') o.on = ch.value; }
      changed(ch.type === 'model');
    },
  });
  $('#adv').addEventListener('toggle', () => { if ($('#adv').open) editor.render(spec()); });
  const tb = $('#tone-body');
  tb.oninput = (e) => {
    const el = e.target.closest('[data-m]');
    if (!el) return;
    const k = el.dataset.m;
    const v = el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? Number(el.value) : el.value;
    if (k === 'bpm' && !(v >= 40 && v <= 240)) return;
    st.macros[k] = v;
    // mudou um controle geral: os ajustes finos daquele assunto deixam de valer
    if (['bass', 'mid', 'treble', 'presence'].includes(k)) { st.macros.dev = null; delete st.overrides.blocks.eq; }
    if (k === 'gain') { delete st.overrides.blocks.amp; delete st.overrides.blocks.ir; delete st.overrides.blocks.drv; }
    const out = el.parentElement.querySelector('output');
    if (out) out.textContent = (FMT[k] || String)(v);
    $('#tone-desc').textContent = T.describe(st.macros);
    changed(true);
  };
  tb.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.l) listen(b.dataset.l);
    if (b.dataset.t === 'reset') { st.macros = structuredClone(st.suggested); st.overrides = { blocks: {} }; renderTone(); changed(true); }
    if (b.dataset.t === 'keep') keepTone();
    if (b.dataset.t === 'export') download(`timbre-${slug(st.song?.title || 'timbre')}.json`, toneRecord());
  };
  renderSpec();
  renderPedal();
}

function listen(kind) {
  st.stopPlay?.(); st.stopPlay = null;
  const stopBtn = $('[data-l="stop"]');
  if (stopBtn) stopBtn.hidden = true;
  if (kind === 'stop') return;
  const ch = kind === 'mix' ? st.audio.channels : [st.instrument === 'bass' ? st.stems.bass : st.stems.other];
  const p = playSamples(ch, kind === 'mix' ? st.audio.sampleRate : 44100, { onEnd: () => { const sb = $('[data-l="stop"]'); if (sb) sb.hidden = true; } });
  st.stopPlay = p.stop;
  if (stopBtn) stopBtn.hidden = false;
}

function renderChart() {
  const svg = $('#chart');
  if (!svg) return;
  const legend = drawCurves(svg, [
    { curve: T.referenceCurve(st.instrument), kind: 'ref', label: st.instrument === 'bass' ? 'Baixo típico' : 'Guitarra típica' },
    { curve: st.features.curve, kind: 'a', label: 'Música' },
    st.refineCurve && { curve: st.refineCurve, kind: 'b', label: 'Sua pedaleira agora' },
  ].filter(Boolean));
  $('#chart-legend').innerHTML = legend;
}

function renderSpec(withEditor = false) {
  const s = spec();
  $('#spec-summary').innerHTML = (s.chain || []).map((key) => {
    const b = s.blocks[key];
    if (!b) return '';
    if (!b.on) return `<span class="badge rounded-pill text-bg-light border text-body-secondary fw-normal">${LABELS[key]}: desligado</span>`;
    const main = Object.entries(b.params || {}).filter(([n]) => n !== 'Vol').slice(0, 4).map(([n, v]) => `${n} ${v}`).join(' · ');
    return `<span class="badge rounded-pill text-bg-primary bg-opacity-75 fw-normal text-wrap text-start"><b>${LABELS[key]}:</b> ${esc(b.model)}${main ? ' · ' + esc(main) : ''}</span>`;
  }).join('');
  if (withEditor && $('#adv')?.open) editor.render(s);
}

const sendSoon = debounce(() => sendDiff(), 180);
/** Algo mudou no timbre: atualiza o resumo e, se estiver "ao vivo", manda para a pedaleira. */
function changed(rerenderEditor = false) {
  st.dirty = true;
  renderSpec(rerenderEditor);
  const kb = $('[data-t="keep"]');
  if (kb && st.toneId) kb.innerHTML = '<i class="bi bi-star"></i> Guardar as mudanças';
  if (db.prefs.live && PM.device()) sendSoon();
}

// ---------------------------------------------------------------- pedaleira
function renderPedal() {
  const box = $('#pedal');
  if (!box) return;
  if (!PM.canConnect()) {
    box.innerHTML = `${PM.connectButtonsHtml()}<p class="small text-body-secondary mt-2 mb-0">Enquanto isso, dá para montar o preset à mão com o resumo acima.</p>`;
    return;
  }
  const pm = PM.device();
  if (!pm) {
    box.innerHTML = `<p>Conecte a Pocket Master:</p>${PM.connectButtonsHtml()}`;
    box.onclick = async (e) => {
      const b = e.target.closest('[data-connect]');
      if (!b) return;
      busyButton(b, true, 'Conectando…');
      try { await PM.connect(b.dataset.connect); toast('Pedaleira conectada.', 'success'); if (db.prefs.live) sendNow(); } catch (err) { toast(PM.connectError(err), 'danger'); renderPedal(); }
    };
    box.onchange = null;
    return;
  }
  const slot = db.prefs.slot ?? defaultSlot(pm);
  const nm = cleanName(st.song?.title || 'Timbre');
  box.innerHTML = `
    <div class="row g-3">
      <div class="col-lg-6"><div class="border rounded p-3 h-100">
        <h3 class="h6">Experimentar</h3>
        <p class="small mb-2">Conectada pelo ${pm.via === 'ble' ? '<i class="bi bi-bluetooth"></i> Bluetooth' : '<i class="bi bi-usb-symbol"></i> USB'}: <strong>${esc(pm.name)}</strong> · em edição: <strong>${esc(PM.currentLabel())}</strong> <button class="btn btn-link btn-sm p-0 align-baseline" type="button" data-p="disconnect">desconectar</button></p>
        <div class="d-flex flex-wrap gap-2 mb-2">
          <button class="btn btn-primary btn-sm" type="button" data-p="send"><i class="bi bi-send"></i> Mandar o timbre</button>
          <button class="btn btn-outline-secondary btn-sm" type="button" data-p="undo" title="Descarta o que foi mandado e recarrega o preset salvo">Desfazer</button>
        </div>
        <div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="pm-live"${db.prefs.live ? ' checked' : ''}><label class="form-check-label" for="pm-live">Atualizar na hora enquanto mexo nos controles</label></div>
        <p class="small text-body-secondary mt-2 mb-0">Muda só o preset em edição. Para manter, salve.</p>
      </div></div>
      <div class="col-lg-6"><div class="border rounded p-3 h-100">
        <h3 class="h6">Salvar na pedaleira</h3>
        <div class="row g-2">
          <div class="col-sm-7"><label class="form-label small mb-0" for="pm-slot">Preset</label><select class="form-select form-select-sm" id="pm-slot">${Array.from({ length: USER_PRESETS }, (_, i) => `<option value="${i}"${i === slot ? ' selected' : ''}>${slotLabel(i)} · ${esc(pm.names[i] || '')}</option>`).join('')}</select></div>
          <div class="col-sm-5"><label class="form-label small mb-0" for="pm-name">Nome</label><input class="form-control form-control-sm" type="text" id="pm-name" maxlength="${NAME_LEN}" value="${esc(nm)}"></div>
        </div>
        <button class="btn btn-outline-primary btn-sm mt-2" type="button" data-p="save"><i class="bi bi-save"></i> Salvar</button>
        <p class="small text-body-secondary mt-2 mb-0">Até 10 letras, sem acentos. Uma cópia do preset que estava lá fica em <a href="#/ferramentas/pedaleira">Pocket Master → cópias de segurança</a>.</p>
      </div></div>
      <div class="col-12"><div class="border rounded p-3">
        <h3 class="h6">Ajuste fino ouvindo a pedaleira</h3>
        <p class="small">Toque algo parecido com o trecho (mesmos acordes ou riff). A página ouve a saída de áudio USB da pedaleira, compara com a música e corrige o equalizador e o ganho a cada 4 segundos.${pm.via === 'ble' ? ' <strong>Pelo Bluetooth o som da pedaleira não chega ao computador:</strong> para o ajuste fino, ligue também o cabo USB (o controle pode continuar pelo Bluetooth).' : ''}</p>
        <div class="row g-2 align-items-end">
          <div class="col-sm"><label class="form-label small mb-0" for="pm-input">Entrada de áudio</label><select class="form-select form-select-sm" id="pm-input"><option value="">Escolha a entrada da pedaleira…</option></select></div>
          <div class="col-sm-auto"><button class="btn btn-sm ${st.refine ? 'btn-danger' : 'btn-outline-primary'}" type="button" data-p="refine">${st.refine ? '<i class="bi bi-stop-fill"></i> Parar o ajuste' : '<i class="bi bi-soundwave"></i> Começar o ajuste'}</button></div>
        </div>
        <div class="progress mt-2" style="height:6px" aria-label="Volume da entrada"><div class="progress-bar bg-success" id="rf-lvl" style="width:0%"></div></div>
        <p class="small mt-2 mb-0" id="rf-info">${esc(st.refineInfo)}</p>
      </div></div>
    </div>`;
  fillInputs();
  box.onchange = (e) => {
    if (e.target.id === 'pm-live') { db.prefs.live = e.target.checked; S.save(); if (db.prefs.live) sendNow(); }
    if (e.target.id === 'pm-slot') { db.prefs.slot = Number(e.target.value); S.save(); }
    if (e.target.id === 'pm-input') { db.prefs.inputId = e.target.value; S.save(); }
  };
  box.onclick = async (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    if (b.dataset.p === 'send') sendNow(true);
    if (b.dataset.p === 'undo') { try { await pm.select(pm.current ?? 0); st.lastSent = null; toast('Voltou ao preset salvo.'); } catch (err) { toast(err.message, 'danger'); } }
    if (b.dataset.p === 'save') savePreset(b);
    if (b.dataset.p === 'refine') toggleRefine();
    if (b.dataset.p === 'disconnect') { stopRefine(); PM.disconnect(); }
  };
}

function defaultSlot(pm) {
  for (let i = USER_PRESETS - 1; i >= 0; i--) if (!pm.names[i]) return i;
  return USER_PRESETS - 1;
}

async function sendNow(announce = false) {
  const pm = PM.device();
  if (!pm || !st.macros) return;
  try { const s = spec(); await pm.apply(s); st.lastSent = s; if (announce) toast('Timbre mandado. Toque para ouvir!', 'success'); } catch (e) { toast(e.message || 'Falha ao mandar.', 'danger'); }
}
let sending = null;
async function sendDiff() {
  const pm = PM.device();
  if (!pm) return;
  if (sending) await sending;
  const s = spec();
  sending = pm.apply(s, st.lastSent).then(() => { st.lastSent = s; }).catch((e) => toast(e.message, 'danger')).finally(() => { sending = null; });
  return sending;
}

async function savePreset(btn) {
  const slot = Number($('#pm-slot').value);
  const name = cleanName($('#pm-name').value) || 'Timbre';
  const old = PM.device().names[slot] || '';
  if (!(await confirmBox(`Salvar "${name}" no ${slotLabel(slot)}${old ? `, no lugar de "${old}"` : ''}? Uma cópia do que está lá fica guardada.`, { ok: 'Salvar' }))) return;
  busyButton(btn, true, 'Salvando…');
  try {
    const s = spec();
    await PM.saveWithBackup(slot, name, s);
    st.lastSent = s;
    db.prefs.slot = slot; S.save();
    toast(`Salvo no ${slotLabel(slot)} como "${name}".`, 'success');
  } catch (e) { toast(e.message || 'Não consegui salvar.', 'danger'); }
  renderPedal();
}

async function fillInputs() {
  const sel = $('#pm-input');
  if (!sel) return;
  try {
    const inputs = await listInputs();
    if (!inputs.some((d) => d.label)) { sel.innerHTML = '<option value="">Toque em "Começar o ajuste" para listar as entradas</option>'; return; }
    const want = db.prefs.inputId && inputs.find((d) => d.deviceId === db.prefs.inputId) ? db.prefs.inputId : guessPedalInput(inputs)?.deviceId || '';
    sel.innerHTML = '<option value="">Escolha a entrada da pedaleira…</option>' + inputs.map((d) => `<option value="${esc(d.deviceId)}"${d.deviceId === want ? ' selected' : ''}>${esc(d.label || 'Entrada sem nome')}</option>`).join('');
  } catch { /* sem lista */ }
}

async function toggleRefine() {
  if (st.refine) { stopRefine(); renderPedal(); return; }
  if (!$('#pm-input').value) {
    try { const s = await getInput(); s.getTracks().forEach((t) => t.stop()); } catch { toast('Permita o uso da entrada de áudio para o ajuste fino.', 'warning'); return; }
    await fillInputs();
    if (!$('#pm-input').value) { toast('Escolha a entrada de áudio da pedaleira (Pocket Master / USB) e toque em Começar de novo.'); return; }
  }
  const deviceId = $('#pm-input').value;
  db.prefs.inputId = deviceId; S.save();
  if (!st.lastSent) await sendNow();
  try {
    st.refine = await startRefine({
      deviceId, target: st.features, getSpec: spec,
      setParam: (block, name, value) => {
        const o = (st.overrides.blocks[block] ||= {});
        o.model ||= spec().blocks[block].model;
        if (name === '__on') o.on = true; else o.params = { ...(o.params || {}), [name]: value };
      },
      send: () => sendDiff(),
      onUpdate: (info) => {
        if (info.level != null) { const lv = $('#rf-lvl'); if (lv) lv.style.width = Math.min(100, info.level * 400) + '%'; }
        if (info.round) {
          const close = info.eqError < 1.5 && Math.abs(info.gainError) < 0.06;
          st.refineInfo = `Rodada ${info.round}: diferença média de ${info.eqError.toFixed(1)} dB nas frequências; ganho ${Math.abs(info.gainError) < 0.06 ? 'parecido' : info.gainError > 0 ? 'abaixo da música' : 'acima da música'}. ${close ? '✓ Bem parecido!' : info.changed ? 'Ajustei e continuo ouvindo…' : ''}`;
          st.refineCurve = info.curve;
          st.dirty = true;
          if (!active) return;
          const el = $('#rf-info'); if (el) el.textContent = st.refineInfo;
          renderChart(); renderSpec(true);
        }
      },
    });
    st.refineInfo = 'Ouvindo… toque o trecho no instrumento.';
    renderPedal();
  } catch (e) {
    st.refine = null;
    toast(e.name === 'NotAllowedError' ? 'Permita o uso da entrada de áudio.' : 'Não consegui ouvir essa entrada.', 'danger');
  }
}
function stopRefine() { st.refine?.stop(); st.refine = null; }

// ---------------------------------------------------------------- meus timbres
function toneRecord() {
  const f = st.features;
  return {
    app: 'timbres', version: 1,
    name: st.song?.title || 'Timbre',
    song: st.song ? { title: st.song.title, ytId: st.song.ytId || null, start: st.song.start ?? null, end: st.song.end ?? null } : null,
    instrument: st.instrument, macros: st.macros, overrides: st.overrides,
    features: { curve: f.curve, gain: f.gain, reverb: f.reverb, bpm: f.bpm, compression: f.compression, separated: f.separated },
    ...spec(), // mesmo formato dos arquivos de timbre do pocket-master-mcp
  };
}
function keepTone() {
  if (!st.macros) return;
  const now = Date.now();
  const old = db.tones.find((t) => t.id === st.toneId);
  const rec = { id: st.toneId || 't' + now.toString(36), date: old?.date || now, updatedAt: now, ...toneRecord() };
  if (old) Object.assign(old, rec); else db.tones.unshift(rec);
  st.toneId = rec.id; st.dirty = false;
  S.save();
  const kb = $('[data-t="keep"]'); if (kb) kb.innerHTML = '<i class="bi bi-star-fill"></i> Guardado';
  renderLib();
  toast('Timbre guardado.', 'success');
}
function openTone(t) {
  st.features = structuredClone(t.features);
  st.instrument = t.instrument || 'guitar';
  st.macros = structuredClone(t.macros);
  st.suggested = structuredClone(t.macros);
  st.overrides = structuredClone(t.overrides || { blocks: {} });
  st.audio = null; st.stems = null; st.lastSent = null; st.refineCurve = null;
  st.toneId = t.id; st.dirty = false;
  st.song = t.song ? { ...t.song } : null;
  view.querySelectorAll('input[name=t-inst]').forEach((r) => { r.checked = r.value === st.instrument; });
  renderTone();
  $('#s-tone').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (db.prefs.live && PM.device()) sendNow();
}
function renderLib() {
  const box = $('#lib');
  if (!box) return;
  if (!db.tones.length) { box.innerHTML = '<p class="small text-body-secondary">Os timbres que você guardar aparecem aqui (e na sua conta, se tiver entrado), para abrir e mandar para a pedaleira depois.</p>'; return; }
  box.innerHTML = `<div class="list-group song-rows plain">${db.tones.map((t) => `
    <div class="list-group-item"><a class="main" href="#" data-x="open" data-id="${t.id}"><strong>${esc(t.name)}</strong><small>${esc(T.describe(t.macros))}</small></a>
    <span class="ctrls"><button class="btn btn-sm btn-outline-secondary" type="button" data-x="dl" data-id="${t.id}" title="Baixar"><i class="bi bi-download"></i></button><button class="btn btn-sm btn-link text-body" type="button" data-x="del" data-id="${t.id}" aria-label="Apagar ${esc(t.name)}"><i class="bi bi-trash"></i></button></span></div>`).join('')}</div>`;
  box.onclick = async (e) => {
    const el = e.target.closest('[data-x]');
    if (!el) return;
    e.preventDefault();
    const t = db.tones.find((x) => x.id === el.dataset.id);
    if (!t) return;
    if (el.dataset.x === 'open') openTone(t);
    if (el.dataset.x === 'dl') download(`timbre-${slug(t.name)}.json`, t);
    if (el.dataset.x === 'del' && await confirmBox(`Apagar "${t.name}"?`, { ok: 'Apagar', danger: true })) {
      deleteTone(t.id);
      if (st.toneId === t.id) st.toneId = null;
      S.save(); renderLib();
    }
  };
}
async function importTone(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'timbres' || !d.macros || !d.features) throw new Error();
    const now = Date.now();
    const rec = { ...d, id: 't' + now.toString(36), date: now, updatedAt: now };
    db.tones.unshift(rec); S.save(); renderLib(); openTone(rec);
    toast('Timbre importado.', 'success');
  } catch { toast('Esse arquivo não é um timbre desta página.', 'danger'); }
}
