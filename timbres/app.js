// Timbres: ouve um trecho de música, sugere um timbre e manda para a Sonicake Pocket Master.
import * as P from '../cifras/player.js?v=11';
import { extractYouTube } from '../cifras/music.js?v=11';
import { toast } from '../cifras/util.js?v=11';
import { analyzeTone, tempoEstimate, BANDS } from './analyze.js?v=1';
import * as T from './tone.js?v=1';
import { PocketMaster, loadMap, midiSupported, slotLabel, cleanName, LABELS, MODULES, USER_PRESETS, modelByName } from './pm.js?v=1';
import { canCaptureTab, captureThisTab, Recorder, mono, decodeFile, playSamples } from './capture.js?v=1';
import { startRefine, listInputs, guessPedalInput } from './refine.js?v=1';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const parseTime = (v) => {
  const s = String(v || '').trim();
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some((x) => Number.isNaN(x))) return null;
  return parts.reduce((a, b) => a * 60 + b, 0);
};

// ---------------------------------------------------------------- dados guardados
const KEY = 'timbres.v1';
function load() {
  try { return { tones: [], backups: [], prefs: {}, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { tones: [], backups: [], prefs: {} }; }
}
const db = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { toast('Não consegui guardar no navegador (espaço cheio?).'); }
}

const st = {
  map: null, pm: null,
  song: null, audio: null, stems: null, features: null,
  instrument: db.prefs.instrument || 'guitar',
  macros: null, suggested: null, overrides: { blocks: {} },
  lastSent: null, live: !!db.prefs.live, toneId: null,
  refine: null, refineInfo: null, stopPlay: null,
};

function spec() { return T.withOverrides(T.buildSpec(st.macros, st.map), st.overrides); }

// ---------------------------------------------------------------- 1. música
function initSong() {
  const url = $('#yt-url');
  $('#yt-load').onclick = () => loadSong(url.value);
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadSong(url.value); });
  url.addEventListener('paste', () => setTimeout(() => loadSong(url.value, true), 0));
  document.querySelectorAll('[data-now]').forEach((b) => {
    b.onclick = () => {
      const t = P.api()?.getCurrentTime?.();
      if (t == null) { toast('Carregue o vídeo primeiro.'); return; }
      $('#' + b.dataset.now).value = mmss(t);
    };
  });
  document.querySelectorAll('input[name=inst]').forEach((r) => {
    r.checked = r.value === st.instrument;
    r.onchange = () => { st.instrument = r.value; db.prefs.instrument = r.value; save(); if (st.features) reanalyze(); };
  });
  const sep = $('#opt-sep');
  sep.checked = db.prefs.separate !== false;
  sep.onchange = () => { db.prefs.separate = sep.checked; save(); };
  if (!canCaptureTab()) { $('#go-tab').hidden = true; $('#tab-note').hidden = false; }
  $('#go-tab').onclick = analyzeFromTab;
  $('#go-file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) analyzeFromFile(f); };
}

async function loadSong(text, quiet = false) {
  const items = extractYouTube(text || '');
  if (!items.length) { if (!quiet) toast('Não achei um link do YouTube aí.'); return; }
  const it = items[0];
  const t = /[?&#](?:t|start)=(\d+)/.exec(String(text).split(/\s+/).find((w) => w.includes(it.id)) || '');
  if (t) { $('#t-start').value = mmss(+t[1]); $('#t-end').value = mmss(+t[1] + 30); }
  st.song = { ytId: it.id, title: 'Vídeo do YouTube', url: `https://www.youtube.com/watch?v=${it.id}` };
  $('#yt-title').textContent = 'Carregando…';
  await P.play({ id: 'timbre', ytId: it.id, title: st.song.title }, { autoplay: false });
  const meta = await fetchTitle(it.id);
  if (meta) {
    st.song.title = meta;
    P.play({ id: 'timbre', ytId: it.id, title: meta }, { autoplay: false });
  }
  $('#yt-title').textContent = `🎵 ${st.song.title}`;
}

async function fetchTitle(id) {
  const watch = `https://www.youtube.com/watch?v=${id}`;
  for (const u of [`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, `https://noembed.com/embed?url=${encodeURIComponent(watch)}`]) {
    try { const r = await fetch(u); if (r.ok) { const j = await r.json(); if (j.title) return j.title; } } catch { /* próximo */ }
  }
  return null;
}

function range() {
  const a = parseTime($('#t-start').value) ?? 0;
  let b = parseTime($('#t-end').value);
  if (b == null || b <= a) b = a + 30;
  return [a, b];
}

let work = null;
function showWork(msg, frac = null, stoppable = false) {
  $('#work').hidden = false;
  $('#work-msg').textContent = msg;
  if (frac != null) $('#work-bar').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  $('#work-stop').hidden = !stoppable;
}
function hideWork() { $('#work').hidden = true; work = null; }
function busy(on) { $('#go-tab').disabled = on; $('label[for=go-file]').classList.toggle('disabled', on); $('#go-file').disabled = on; }

async function analyzeFromTab() {
  if (!st.song) { toast('Cole o link do YouTube e carregue o vídeo primeiro.'); $('#yt-url').focus(); return; }
  let [a, b] = range();
  let stream;
  try {
    await P.play({ id: 'timbre', ytId: st.song.ytId, title: st.song.title }, { autoplay: false });
    stream = await captureThisTab();
  } catch (err) {
    toast(err.name === 'NoAudio' ? 'O áudio não foi compartilhado. Tente de novo e deixe marcado "compartilhar o áudio da guia".'
      : err.name === 'NotAllowedError' ? 'Compartilhamento cancelado.' : 'Não foi possível ouvir a aba.');
    return;
  }
  const p = P.api();
  const dur = p.getDuration?.() || 0;
  if (dur && a >= dur - 3) { stream.getTracks().forEach((t) => t.stop()); toast(`O vídeo tem ${mmss(dur)}. Escolha um trecho dentro dele.`); return; }
  if (dur) b = Math.min(b, dur);
  busy(true);
  const rec = new Recorder();
  let done = false;
  const finish = async (early) => {
    if (done) return;
    done = true;
    clearInterval(timer);
    try { p.pauseVideo(); } catch { /* ok */ }
    rec.stop();
    if (rec.seconds < 5) { hideWork(); busy(false); toast(early ? 'Ouvi muito pouco. Deixe tocar pelo menos uns 10 segundos.' : 'Não ouvi o vídeo. Confira se o áudio da guia foi compartilhado.'); return; }
    await processAudio(rec.result());
  };
  work = { stop: () => finish(true) };
  $('#work-stop').onclick = () => work?.stop();
  await rec.start(stream, {
    shouldKeep: () => {
      try { const t = p.getCurrentTime(); return p.getPlayerState() === 1 && t >= a - 0.05 && t <= b; } catch { return false; }
    },
  });
  stream.getAudioTracks()[0].addEventListener('ended', () => finish(true));
  p.seekTo(a, true);
  p.playVideo();
  showWork(`Ouvindo ${mmss(a)} a ${mmss(b)}…`, 0, true);
  const timer = setInterval(() => {
    let t = 0;
    try { t = p.getCurrentTime(); } catch { /* ok */ }
    showWork(`Ouvindo ${mmss(a)} a ${mmss(b)}… ${mmss(Math.max(0, t - a))} de ${mmss(b - a)}`, (t - a) / (b - a), true);
    if (t >= b - 0.05 || p.getPlayerState?.() === 0) finish(false);
  }, 250);
}

async function analyzeFromFile(file) {
  const [a, b] = range();
  busy(true);
  showWork('Lendo o arquivo…', 0);
  try {
    let audio;
    try { audio = await decodeFile(file, a, b); } catch (err) {
      if (err.name !== 'TooShort') throw err;
      // trecho fora do arquivo: usa o começo
      audio = await decodeFile(file, 0, Math.min(err.duration, b - a));
      toast(`O arquivo tem ${mmss(err.duration)}; usei o começo dele.`);
    }
    if (!st.song || st.song.file !== file.name) st.song = { title: file.name.replace(/\.[^.]+$/, ''), file: file.name };
    $('#yt-title').textContent = `🎵 ${st.song.title}`;
    await processAudio(audio);
  } catch {
    hideWork(); busy(false);
    toast('Não consegui ler esse arquivo. Tente MP3, WAV ou M4A.');
  }
}

async function processAudio(audio) {
  st.audio = audio;
  st.stems = null;
  const mix = mono(audio.channels);
  showWork('Medindo o andamento…', 0);
  const bpm = await tempoEstimate(mix, audio.sampleRate);
  if ($('#opt-sep').checked) {
    try {
      const { separate } = await import('../cifras/separate.js?v=11');
      st.stems = await separate(audio.channels, audio.sampleRate, (msg, frac) => showWork(msg, frac));
    } catch (err) {
      toast('A separação falhou; vou analisar a música inteira. (' + (err.message || err) + ')');
    }
  }
  await analyzeSource(bpm);
}

async function analyzeSource(bpm = st.features?.bpm) {
  const src = st.stems ? (st.instrument === 'bass' ? st.stems.bass : st.stems.other) : mono(st.audio.channels);
  const sr = st.stems ? 44100 : st.audio.sampleRate;
  try {
    showWork('Analisando o timbre…', 0);
    const f = await analyzeTone(src, sr, (x) => showWork('Analisando o timbre…', x));
    f.bpm = bpm || 100;
    f.separated = !!st.stems;
    st.features = f;
    st.macros = T.macrosFromFeatures(f, st.instrument);
    st.suggested = structuredClone(st.macros);
    st.overrides = { blocks: {} };
    st.toneId = null;
    st.lastSent = null;
    hideWork(); busy(false);
    renderTone();
    $('#s-tone').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (st.live && st.pm?.connected) sendNow();
  } catch (err) {
    hideWork(); busy(false);
    toast(err.message || 'Não consegui analisar esse trecho.');
  }
}
function reanalyze() {
  if (st.audio) { busy(true); analyzeSource(); return; }
  if (st.features) { st.macros = { ...st.macros, ...T.macrosFromFeatures(st.features, st.instrument), instrument: st.instrument }; renderTone(); changed(); }
}

// ---------------------------------------------------------------- 2. timbre
function renderTone() {
  $('#s-tone').hidden = false;
  $('#s-pedal').hidden = false;
  $('#tone-desc').textContent = T.describe(st.macros) + (st.features.separated ? '' : ' (analisado com a música inteira)');
  renderChart();
  const lr = $('#listen-row');
  lr.innerHTML = st.audio ? `<button class="btn small" data-l="mix" type="button">▶ Ouvir o trecho</button>${st.stems ? `<button class="btn small" data-l="inst" type="button">▶ Ouvir só ${st.instrument === 'bass' ? 'o baixo' : 'a guitarra e a harmonia'} separadas</button>` : ''}<button class="btn small" data-l="stop" type="button" hidden>■ Parar</button>` : '';
  lr.onclick = (e) => {
    const l = e.target.closest('[data-l]')?.dataset.l;
    if (!l) return;
    st.stopPlay?.(); st.stopPlay = null;
    lr.querySelector('[data-l=stop]').hidden = true;
    if (l === 'stop') return;
    const ch = l === 'mix' ? st.audio.channels : [st.instrument === 'bass' ? st.stems.bass : st.stems.other];
    st.stopPlay = playSamples(ch, l === 'mix' ? st.audio.sampleRate : 44100);
    lr.querySelector('[data-l=stop]').hidden = false;
  };
  renderMacros();
  renderSpec();
  renderPedal();
}

function renderChart(pedalCurve = null) {
  const svg = $('#chart');
  const W = 640, H = 220, L = 34, R = 8, Tp = 10, B = 24;
  const x = (f) => L + ((Math.log10(f) - Math.log10(60)) / (Math.log10(11000) - Math.log10(60))) * (W - L - R);
  const y = (d) => Tp + ((12 - d) / 42) * (H - Tp - B);
  const line = (c) => c.map((v, i) => `${i ? 'L' : 'M'}${x(BANDS[i]).toFixed(1)},${y(Math.max(-30, Math.min(12, v))).toFixed(1)}`).join('');
  let g = '';
  for (const d of [12, 0, -12, -24]) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(d)}" y2="${y(d)}"/><text class="lbl" x="${L - 6}" y="${y(d) + 4}" text-anchor="end">${d > 0 ? '+' : ''}${d}</text>`;
  for (const [f, t] of [[100, '100'], [300, '300'], [1000, '1k'], [3000, '3k'], [10000, '10k']]) g += `<line class="grid" x1="${x(f)}" x2="${x(f)}" y1="${Tp}" y2="${H - B}"/><text class="lbl" x="${x(f)}" y="${H - 6}" text-anchor="middle">${t} Hz</text>`;
  const ref = T.referenceCurve(st.instrument);
  g += `<path class="c-ref" d="${line(ref)}"/>`;
  g += `<path class="c-song" d="${line(st.features.curve)}"/>`;
  if (pedalCurve) g += `<path class="c-pedal" d="${line(pedalCurve)}"/>`;
  svg.innerHTML = g;
  $('#chart-legend').innerHTML = `<span><i style="border-color:var(--chord)"></i>Música</span><span><i style="border-color:var(--muted);border-top-style:dotted"></i>${st.instrument === 'bass' ? 'Baixo' : 'Guitarra'} típica</span>${pedalCurve ? '<span><i style="border-color:var(--warn);border-top-style:dashed"></i>Sua pedaleira agora</span>' : ''}`;
}

function knob(id, label, min, max, step, value, fmt) {
  return `<label class="knob"><span>${label}</span><input type="range" id="m-${id}" data-m="${id}" min="${min}" max="${max}" step="${step}" value="${value}"><output for="m-${id}">${fmt(value)}</output></label>`;
}
const fmtDb = (v) => `${v > 0 ? '+' : ''}${v} dB`;
const gainLabel = (v) => ['limpo', 'quase saturando', 'crunch', 'distorcido', 'alto ganho'][T.tierOf(v / 100)];
const FMT = { gain: (v) => `${v} · ${gainLabel(v)}`, bass: fmtDb, mid: fmtDb, treble: fmtDb, presence: fmtDb, reverb: (v) => (v < 8 ? 'sem' : v), delayMix: (v) => v, rt: (v) => `${v} s` };
const opts = (list, v) => list.map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${l}</option>`).join('');

function renderMacros() {
  const m = st.macros;
  const f = $('#macros');
  f.innerHTML = `
    <div class="col"><h3>Som</h3>
    ${knob('gain', 'Ganho', 0, 100, 1, m.gain, FMT.gain)}
    ${knob('bass', 'Graves', -12, 12, 0.5, m.bass, fmtDb)}
    ${knob('mid', 'Médios', -12, 12, 0.5, m.mid, fmtDb)}
    ${knob('treble', 'Agudos', -12, 12, 0.5, m.treble, fmtDb)}
    ${knob('presence', 'Presença', -12, 12, 0.5, m.presence, fmtDb)}
    <label class="check"><input type="checkbox" data-m="comp"${m.comp ? ' checked' : ''}> <span>Compressor (notas mais niveladas e sustentadas)</span></label></div>
    <div class="col"><h3>Efeitos</h3>
    ${knob('reverb', 'Reverb', 0, 100, 1, m.reverb, FMT.reverb)}
    ${knob('rt', 'Duração do reverb', 0.2, 5, 0.1, m.rt, FMT.rt)}
    <label class="knob"><span>Tipo de reverb</span><select data-m="reverbType">${opts(T.REVERB_OPTIONS, m.reverbType)}</select></label>
    <label class="knob"><span>Delay</span><select data-m="delay">${opts(T.DELAY_OPTIONS, m.delay)}</select></label>
    ${knob('delayMix', 'Volume do delay', 0, 60, 1, m.delayMix, FMT.delayMix)}
    <label class="knob"><span>Andamento (BPM)</span><input type="number" data-m="bpm" min="40" max="240" step="1" value="${m.bpm}" class="sub2"></label>
    <label class="knob"><span>Modulação</span><select data-m="mod">${opts(T.MOD_OPTIONS, m.mod)}</select></label></div>`;
  f.oninput = (e) => {
    const el = e.target.closest('[data-m]');
    if (!el) return;
    const k = el.dataset.m;
    let v = el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? Number(el.value) : el.value;
    if (k === 'bpm' && !(v >= 40 && v <= 240)) return;
    st.macros[k] = v;
    // mudou um controle geral: os ajustes finos daquele assunto deixam de valer
    if (['bass', 'mid', 'treble', 'presence'].includes(k)) { st.macros.dev = null; delete st.overrides.blocks.eq; }
    if (k === 'gain') { delete st.overrides.blocks.amp; delete st.overrides.blocks.ir; delete st.overrides.blocks.drv; }
    const out = el.parentElement.querySelector('output');
    if (out) out.textContent = (FMT[k] || String)(v);
    $('#tone-desc').textContent = T.describe(st.macros);
    changed();
  };
}

function renderSpec(withAdvanced = true) {
  const s = spec();
  const chips = s.chain.map((key) => {
    const b = s.blocks[key];
    if (!b) return '';
    if (!b.on) return `<span class="chip off">${LABELS[key]}: desligado</span>`;
    const main = Object.entries(b.params || {}).filter(([n]) => !/^Vol$/.test(n)).slice(0, 4).map(([n, v]) => `${n} ${v}`).join(' · ');
    return `<span class="chip"><b>${LABELS[key]}:</b>${esc(b.model)}${main ? ' · ' + esc(main) : ''}</span>`;
  });
  $('#spec-summary').innerHTML = chips.join('');
  if (withAdvanced && $('#adv').open) renderAdvanced(s);
}

function paramInput(key, p, v) {
  const id = `p-${key}-${p.alg}`;
  if (p.type === 'switch') return `<label class="check knob"><input type="checkbox" id="${id}" data-p="${key}" data-n="${esc(p.name)}"${v ? ' checked' : ''}> <span>${esc(p.name)}</span></label>`;
  if (p.type === 'select') return `<label class="knob"><span>${esc(p.name)}</span><select id="${id}" data-p="${key}" data-n="${esc(p.name)}">${p.options.map((o, i) => `<option value="${i}"${i === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
  return `<label class="knob"><span>${esc(p.name)}</span><input type="range" id="${id}" data-p="${key}" data-n="${esc(p.name)}" min="${p.min}" max="${p.max}" step="${p.step || 1}" value="${v}"><output for="${id}">${v}${p.unit ? ' ' + p.unit : ''}</output></label>`;
}

function renderAdvanced(s = spec()) {
  const body = $('#adv-body');
  body.innerHTML = s.chain.map((key) => {
    const b = s.blocks[key];
    const pool = key === 'amp' && s.amp_mode === 'clone' ? 'clone' : key;
    const m = modelByName(st.map, pool, b.model);
    const models = st.map.models[pool] || [];
    return `<fieldset class="blk${b.on ? '' : ' is-off'}">
      <legend><label class="check"><input type="checkbox" data-on="${key}"${b.on ? ' checked' : ''}> <strong>${LABELS[key]}</strong></label>
      ${models.length > 1 ? `<select data-model="${key}" aria-label="Modelo de ${LABELS[key]}">${models.map((x) => `<option${x.name === b.model ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : `<span>${esc(b.model)}</span>`}</legend>
      <div class="prms">${m ? m.params.map((p) => paramInput(key, p, b.params?.[p.name] ?? p.default)).join('') : ''}</div>
    </fieldset>`;
  }).join('');
}

function initAdvanced() {
  const adv = $('#adv');
  adv.addEventListener('toggle', () => { if (adv.open && st.macros) renderAdvanced(); });
  const ov = (key) => (st.overrides.blocks[key] ||= {});
  $('#adv-body').addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.p) {
      const key = el.dataset.p, name = el.dataset.n;
      const v = el.type === 'checkbox' ? (el.checked ? 1 : 0) : Number(el.value);
      const o = ov(key);
      o.params = { ...(o.params || {}), [name]: v };
      if (!o.model) o.model = spec().blocks[key].model;
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = v + (out.textContent.match(/ [a-zA-Z]+$/)?.[0] || '');
      changed(false);
    }
  });
  $('#adv-body').addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.on) { ov(el.dataset.on).on = el.checked; el.closest('.blk').classList.toggle('is-off', !el.checked); changed(false); }
    if (el.dataset.model) {
      const key = el.dataset.model;
      const m = modelByName(st.map, key, el.value);
      st.overrides.blocks[key] = { ...ov(key), model: el.value, params: Object.fromEntries(m.params.map((p) => [p.name, p.default])), on: true };
      changed();
    }
  });
}

let sendTimer = null;
/** Algo mudou no timbre: atualiza o resumo e, se estiver "ao vivo", manda para a pedaleira. */
function changed(rerenderAdvanced = true) {
  const s = spec();
  renderSpec(rerenderAdvanced);
  if (st.toneId) markDirty();
  if (st.live && st.pm?.connected) {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => sendDiff(), 180);
  }
  return s;
}
function markDirty() { const b = $('#keep'); if (b) b.textContent = '☆ Guardar as mudanças'; }

function initToneButtons() {
  $('#reset').onclick = () => {
    if (!st.suggested) return;
    st.macros = structuredClone(st.suggested);
    st.overrides = { blocks: {} };
    renderMacros(); renderSpec(); $('#tone-desc').textContent = T.describe(st.macros); changed();
  };
  $('#keep').onclick = keepTone;
  $('#export').onclick = () => download(`timbre-${slug(st.song?.title || 'timbre')}.json`, toneRecord());
}

// ---------------------------------------------------------------- 3. pedaleira
function setPill() {
  const pill = $('#pm-pill');
  if (!st.pm?.connected) { pill.hidden = true; return; }
  pill.hidden = false;
  const i = st.pm.current;
  pill.textContent = `🎛 ${i != null ? slotLabel(i) + (st.pm.names[i] ? ' ' + st.pm.names[i] : '') : 'conectada'}`;
}

function renderPedal() {
  const box = $('#pedal');
  setPill();
  if (!midiSupported()) {
    box.innerHTML = `<div class="pedal-box"><p>Este navegador não conversa com aparelhos USB (MIDI). Use o Chrome ou o Edge, no computador ou no Android.</p><p class="hint">Enquanto isso, dá para montar o preset à mão com o resumo acima.</p></div>`;
    return;
  }
  const pm = st.pm;
  if (!pm?.connected) {
    box.innerHTML = `<div class="pedal-box"><p>Ligue a Pocket Master no USB (cabo USB-C para USB-C) e conecte.</p><div class="row"><button class="btn primary" id="pm-connect" type="button">🔌 Conectar a pedaleira</button></div><p class="hint">O navegador vai pedir permissão para usar aparelhos MIDI. Nada é gravado na pedaleira sem você pedir.</p></div>`;
    $('#pm-connect').onclick = connect;
    return;
  }
  const slot = db.prefs.slot ?? defaultSlot();
  const nm = cleanName(st.song?.title || 'Timbre');
  const slotOpts = Array.from({ length: USER_PRESETS }, (_, i) => `<option value="${i}"${i === slot ? ' selected' : ''}>${slotLabel(i)} · ${esc(pm.names[i] || '')}</option>`).join('');
  box.innerHTML = `
    <div class="pedal-box">
      <h3>Experimentar</h3>
      <p>Conectada: <strong>${esc(pm.name)}</strong>. Preset em edição: <strong>${pm.current != null ? slotLabel(pm.current) + ' ' + esc(pm.names[pm.current] || '') : '—'}</strong>.</p>
      <div class="row">
        <button class="btn primary" id="pm-send" type="button">Mandar o timbre para a pedaleira</button>
        <button class="btn" id="pm-undo" type="button" title="Descarta o que foi mandado e recarrega o preset como está salvo">Desfazer (voltar ao preset salvo)</button>
      </div>
      <div class="row"><label class="check"><input type="checkbox" id="pm-live"${st.live ? ' checked' : ''}> <span>Atualizar na hora enquanto mexo nos controles</span></label></div>
      <p class="hint">Isso muda só o preset em edição. Para manter, salve abaixo.</p>
    </div>
    <div class="pedal-box">
      <h3>Ajuste fino ouvindo a pedaleira</h3>
      <p>Toque algo parecido com o trecho (mesmos acordes ou riff). A página ouve a saída USB da pedaleira, compara com a música e corrige o equalizador e o ganho a cada 4 segundos.</p>
      <div class="row"><label for="pm-input">Entrada:</label><select id="pm-input"><option value="">Escolha a entrada de áudio…</option></select>
        <button class="btn" id="rf-go" type="button">${st.refine ? '■ Parar o ajuste' : '🎸 Começar o ajuste'}</button></div>
      <div class="meter lvl"><i id="rf-lvl"></i></div>
      <p class="metrics" id="rf-info">${st.refineInfo ? esc(st.refineInfo) : ''}</p>
    </div>
    <div class="pedal-box">
      <h3>Salvar na pedaleira</h3>
      <div class="row">
        <label for="pm-slot">Preset:</label><select id="pm-slot">${slotOpts}</select>
        <label for="pm-name">Nome:</label><input type="text" id="pm-name" maxlength="10" value="${esc(nm)}">
        <button class="btn" id="pm-save" type="button">Salvar</button>
      </div>
      <p class="hint">Até 10 letras, sem acentos. Uma cópia do preset que estava lá fica guardada em "Cópias de segurança".</p>
    </div>
    ${db.backups.length ? `<details class="pedal-box"><summary><strong>Cópias de segurança (${db.backups.length})</strong></summary><ul class="rows">${db.backups.map((b, i) => `<li><span class="main"><strong>${slotLabel(b.slot)} · ${esc(b.name)}</strong><small>guardada em ${new Date(b.date).toLocaleString('pt-BR')}</small></span><span class="ctrls"><button class="btn small" data-bk="restore" data-i="${i}" type="button">Restaurar</button><button class="btn small" data-bk="dl" data-i="${i}" type="button">Baixar</button><button class="btn small ghost" data-bk="del" data-i="${i}" type="button" aria-label="Apagar cópia">×</button></span></li>`).join('')}</ul></details>` : ''}`;
  $('#pm-send').onclick = sendNow;
  $('#pm-undo').onclick = async () => {
    try { await pm.select(pm.current ?? 0); st.lastSent = null; toast('Voltou ao preset salvo.'); setPill(); } catch (e) { toast(e.message); }
  };
  $('#pm-live').onchange = (e) => { st.live = e.target.checked; db.prefs.live = st.live; save(); if (st.live) sendNow(); };
  $('#pm-slot').onchange = (e) => { db.prefs.slot = Number(e.target.value); save(); };
  $('#pm-save').onclick = savePreset;
  $('#rf-go').onclick = toggleRefine;
  fillInputs();
  box.querySelectorAll('[data-bk]').forEach((b) => { b.onclick = () => backupAction(b.dataset.bk, Number(b.dataset.i)); });
}

function defaultSlot() {
  // primeiro preset do usuário com nome vazio ou padrão; senão o P50
  const names = st.pm?.names || {};
  for (let i = USER_PRESETS - 1; i >= 0; i--) if (!names[i]) return i;
  return USER_PRESETS - 1;
}

async function connect() {
  try {
    st.map ||= await loadMap();
    const pm = new PocketMaster(st.map);
    const name = await pm.connect();
    st.pm = pm;
    pm.on((type) => {
      if (type === 'disconnect') { toast('A pedaleira foi desconectada.'); stopRefine(); renderPedal(); }
      if (type === 'preset') { st.lastSent = null; setPill(); }
      if (type === 'knob') st.lastSent = null; // mexeram nos botões dela: na próxima vez manda tudo
    });
    toast(`Conectada: ${name}`);
    renderPedal();
    if (st.live) sendNow();
  } catch (err) {
    toast(err.name === 'SecurityError' || err.name === 'NotAllowedError' ? 'Permissão para MIDI negada. Libere nas configurações do site e tente de novo.' : (err.message || 'Não consegui conectar.'));
  }
}

async function sendNow() {
  if (!st.pm?.connected || !st.macros) return;
  try {
    const s = spec();
    await st.pm.apply(s);
    st.lastSent = s;
    toast('Timbre mandado. Toque para ouvir!');
  } catch (e) { toast(e.message || 'Falha ao mandar.'); }
}
let sending = null;
async function sendDiff() {
  if (!st.pm?.connected) return;
  if (sending) { await sending; }
  const s = spec();
  sending = st.pm.apply(s, st.lastSent).then(() => { st.lastSent = s; }).catch((e) => toast(e.message)).finally(() => { sending = null; });
  return sending;
}

async function savePreset() {
  const pm = st.pm;
  const slot = Number($('#pm-slot').value);
  const name = cleanName($('#pm-name').value) || 'Timbre';
  const old = pm.names[slot] || '';
  if (!confirm(`Salvar "${name}" no ${slotLabel(slot)}${old ? `, no lugar de "${old}"` : ''}? Uma cópia do que está lá fica guardada aqui.`)) return;
  const btn = $('#pm-save');
  btn.disabled = true; btn.textContent = 'Salvando…';
  try {
    const before = await pm.select(slot);
    db.backups.unshift({ slot, name: old || slotLabel(slot), state: before, date: Date.now() });
    db.backups = db.backups.slice(0, 30);
    save();
    const s = spec();
    await pm.apply(s);
    await pm.save(slot, name);
    st.lastSent = s;
    db.prefs.slot = slot; save();
    toast(`Salvo no ${slotLabel(slot)} como "${name}".`);
  } catch (e) {
    toast(e.message || 'Não consegui salvar.');
  }
  renderPedal();
}

async function backupAction(act, i) {
  const b = db.backups[i];
  if (!b) return;
  if (act === 'dl') { download(`preset-${slotLabel(b.slot)}-${slug(b.name)}.json`, b.state); return; }
  if (act === 'del') { if (confirm('Apagar esta cópia?')) { db.backups.splice(i, 1); save(); renderPedal(); } return; }
  if (act === 'restore') {
    if (!confirm(`Restaurar "${b.name}" no ${slotLabel(b.slot)}? O que estiver lá agora será substituído.`)) return;
    try {
      await st.pm.select(b.slot);
      await st.pm.apply(b.state);
      await st.pm.save(b.slot, b.name);
      st.lastSent = null;
      toast(`${slotLabel(b.slot)} restaurado.`);
    } catch (e) { toast(e.message || 'Não consegui restaurar.'); }
    renderPedal();
  }
}

// ajuste fino
async function fillInputs() {
  const sel = $('#pm-input');
  if (!sel) return;
  try {
    let inputs = await listInputs();
    if (inputs.length && !inputs.some((d) => d.label)) {
      // sem permissão os nomes vêm vazios: pede o microfone uma vez para ver os nomes
      sel.innerHTML = '<option value="">Toque em "Começar o ajuste" para listar as entradas</option>';
      return;
    }
    const want = db.prefs.inputId && inputs.find((d) => d.deviceId === db.prefs.inputId) ? db.prefs.inputId : guessPedalInput(inputs)?.deviceId || '';
    sel.innerHTML = '<option value="">Escolha a entrada de áudio…</option>' + inputs.map((d) => `<option value="${esc(d.deviceId)}"${d.deviceId === want ? ' selected' : ''}>${esc(d.label || 'Entrada sem nome')}</option>`).join('');
    sel.onchange = () => { db.prefs.inputId = sel.value; save(); };
  } catch { /* sem lista */ }
}

async function toggleRefine() {
  if (st.refine) { stopRefine(); renderPedal(); return; }
  const sel = $('#pm-input');
  if (!sel.value) {
    // primeira vez: pede permissão e lista as entradas
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); } catch { toast('Permita o uso do microfone/entrada de áudio para o ajuste fino.'); return; }
    await fillInputs();
    if (!$('#pm-input').value) { toast('Escolha a entrada de áudio da pedaleira (Pocket Master / USB) e toque em Começar de novo.'); return; }
  }
  const deviceId = $('#pm-input').value;
  db.prefs.inputId = deviceId; save();
  if (!st.lastSent) await sendNow();
  try {
    st.refine = await startRefine({
      deviceId,
      target: st.features,
      getSpec: spec,
      setParam: (block, name, value) => {
        const o = (st.overrides.blocks[block] ||= {});
        if (!o.model) o.model = spec().blocks[block].model;
        if (name === '__on') o.on = true;
        else o.params = { ...(o.params || {}), [name]: value };
      },
      send: () => sendDiff(),
      onUpdate: (info) => {
        if (info.level != null) { const lv = $('#rf-lvl'); if (lv) lv.style.width = Math.min(100, info.level * 400) + '%'; }
        if (info.round) {
          const close = info.eqError < 1.5 && Math.abs(info.gainError) < 0.06;
          st.refineInfo = `Rodada ${info.round}: diferença média de ${info.eqError.toFixed(1)} dB nas frequências; ganho ${Math.abs(info.gainError) < 0.06 ? 'parecido' : info.gainError > 0 ? 'abaixo da música' : 'acima da música'}. ${close ? '✓ Bem parecido!' : info.changed ? 'Ajustei e continuo ouvindo…' : ''}`;
          const el = $('#rf-info'); if (el) el.textContent = st.refineInfo;
          renderChart(info.curve);
          renderSpec();
        }
      },
    });
    st.refineInfo = 'Ouvindo… toque o trecho na guitarra.';
    renderPedal();
  } catch (e) {
    st.refine = null;
    toast(e.name === 'NotAllowedError' ? 'Permita o uso da entrada de áudio.' : 'Não consegui ouvir essa entrada.');
  }
}
function stopRefine() { st.refine?.stop(); st.refine = null; }

// ---------------------------------------------------------------- meus timbres
function slug(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'timbre'; }
function download(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function toneRecord() {
  const f = st.features;
  return {
    app: 'timbres', version: 1,
    name: st.song?.title || 'Timbre',
    song: st.song ? { title: st.song.title, ytId: st.song.ytId || null, start: range()[0], end: range()[1] } : null,
    instrument: st.instrument,
    macros: st.macros, overrides: st.overrides,
    features: { curve: f.curve, gain: f.gain, reverb: f.reverb, bpm: f.bpm, compression: f.compression, separated: f.separated },
    // mesmo formato dos arquivos de timbre do pocket-master-mcp
    ...spec(),
  };
}
function keepTone() {
  if (!st.macros) return;
  const rec = { id: st.toneId || 't' + Date.now().toString(36), date: Date.now(), ...toneRecord() };
  const i = db.tones.findIndex((t) => t.id === rec.id);
  if (i >= 0) db.tones[i] = rec; else db.tones.unshift(rec);
  st.toneId = rec.id;
  save();
  $('#keep').textContent = '★ Guardado';
  renderLib();
}
function openTone(t) {
  st.features = { ...t.features, curve: t.features.curve };
  st.instrument = t.instrument || 'guitar';
  document.querySelectorAll('input[name=inst]').forEach((r) => { r.checked = r.value === st.instrument; });
  st.macros = structuredClone(t.macros);
  st.suggested = structuredClone(t.macros);
  st.overrides = structuredClone(t.overrides || { blocks: {} });
  st.audio = null; st.stems = null; st.lastSent = null;
  st.toneId = t.id;
  st.song = t.song ? { ...t.song, url: t.song.ytId ? `https://www.youtube.com/watch?v=${t.song.ytId}` : null } : null;
  if (t.song) {
    $('#yt-title').textContent = `🎵 ${t.song.title}`;
    if (t.song.start != null) { $('#t-start').value = mmss(t.song.start); $('#t-end').value = mmss(t.song.end); }
    if (t.song.ytId) { $('#yt-url').value = st.song.url; P.play({ id: 'timbre', ytId: t.song.ytId, title: t.song.title }, { autoplay: false }); }
  }
  renderTone();
  $('#keep').textContent = '★ Guardado';
  $('#s-tone').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (st.live && st.pm?.connected) sendNow();
}
function renderLib() {
  const box = $('#lib');
  if (!db.tones.length) { box.innerHTML = '<p class="hint">Os timbres que você guardar aparecem aqui, para abrir e mandar para a pedaleira depois.</p>'; return; }
  box.innerHTML = `<ul class="rows">${db.tones.map((t) => `<li>
    <a class="main" href="#" data-t="open" data-id="${t.id}"><strong>${esc(t.name)}</strong><small>${esc(T.describe(t.macros))}</small></a>
    <span class="ctrls"><button class="btn small" data-t="dl" data-id="${t.id}" type="button">Baixar</button><button class="btn small ghost" data-t="del" data-id="${t.id}" type="button" aria-label="Apagar ${esc(t.name)}">×</button></span></li>`).join('')}</ul>`;
  box.onclick = (e) => {
    const el = e.target.closest('[data-t]');
    if (!el) return;
    e.preventDefault();
    const t = db.tones.find((x) => x.id === el.dataset.id);
    if (!t) return;
    if (el.dataset.t === 'open') openTone(t);
    if (el.dataset.t === 'dl') download(`timbre-${slug(t.name)}.json`, t);
    if (el.dataset.t === 'del' && confirm(`Apagar "${t.name}"?`)) { db.tones = db.tones.filter((x) => x.id !== t.id); save(); renderLib(); }
  };
}
function initImport() {
  $('#imp-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const d = JSON.parse(await file.text());
      if (d.app !== 'timbres' || !d.macros || !d.features) throw new Error();
      const rec = { ...d, id: 't' + Date.now().toString(36), date: Date.now() };
      db.tones.unshift(rec); save(); renderLib(); openTone(rec);
      toast('Timbre importado.');
    } catch { toast('Esse arquivo não é um timbre desta página.'); }
  };
}

// ---------------------------------------------------------------- início
async function main() {
  initSong();
  initAdvanced();
  initToneButtons();
  initImport();
  renderLib();
  st.map = await loadMap();
  window.addEventListener('beforeunload', () => stopRefine());
}
main();
// para testes
window.__timbres = { st, spec };
