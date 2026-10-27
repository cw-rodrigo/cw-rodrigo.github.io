// DAW: faixas de áudio (grave a Pocket Master pela entrada USB dela, ou qualquer microfone) e de
// instrumento (o sintetizador tudo em um), arranjo com loop, piano roll, mixer e exportação em WAV.
// Projetos ficam no navegador (IndexedDB), com desfazer/refazer.
import { DawEngine } from './engine.js';
import { timeline } from './timeline.js';
import { pianoRoll } from './pianoroll.js';
import {
  newProject, newTrack, spb, clipEnd, fmtPos, fmtTime, saveAudio, loadAudio, cachedAudio,
  listProjects, loadProject, saveProject, deleteProject, exportProjectFile, importProjectFile, History, COLORS,
} from './project.js';
import { synthPanel } from '/lib/synth/ui.js';
import { pianoKeyboard, qwertyKeys, midiKeyboards, noteLabel } from '/lib/synth/keyboard.js';
import { audioCtx, resumeAudio } from '/lib/audio/context.js';
import { getInput, listInputs, encodeWav, captureError } from '/lib/audio/io.js';
import * as PM from '/lib/pocketmaster/session.js';
import { $, esc, uid, toast, modal, confirmBox, promptBox, busyButton, debounce, download, clamp, progressHtml, setProgress } from '/lib/core/ui.js';

const LAST = 'daw.last';
const PEDAL = /pocket|sonicake|qme|sonic master/i;
const SNAPS = [[0, 'Livre'], ['bar', 'Compasso'], [1, '1/4'], [0.5, '1/8'], [0.25, '1/16'], [0.125, '1/32']];

let active = null; // sessão aberta (para canLeave)

function demoProject() {
  const p = newProject('Meu projeto');
  p.tracks.push(newTrack(p, 'audio', { name: 'Pocket Master', input: { deviceId: '', channel: 'stereo', monitor: false, match: 'pocket' } }));
  const t = newTrack(p, 'inst', { name: 'Sintetizador' });
  t.synth = { engine: 'subtractive', params: {}, fx: { reverbMix: 0.1 } };
  p.tracks.push(t);
  return p;
}
function fixProject(p) {
  const base = newProject(p.name);
  const q = { ...base, ...p, loop: { ...base.loop, ...(p.loop || {}) }, master: { ...base.master, ...(p.master || {}) } };
  q.tracks = (q.tracks || []).map((t) => ({ ...newTrack(q, t.kind), ...t, eq: { low: 0, mid: 0, high: 0, ...(t.eq || {}) }, input: { deviceId: '', channel: 'stereo', monitor: false, ...(t.input || {}) }, pm: { slot: null, ...(t.pm || {}) }, clips: t.clips || [] }));
  return q;
}

export default {
  title: 'DAW',
  wide: () => true,
  async canLeave() {
    if (!active?.engine.recording) return true;
    if (!(await confirmBox('A gravação está em andamento. Parar e sair?', { ok: 'Parar e sair', danger: true }))) return false;
    await active.toggleRecord();
    return true;
  },
  dirty: () => !!active?.engine.recording,
  async render(el) {
    el.innerHTML = '<div class="text-center p-5"><div class="spinner-border"></div></div>';
    const ctx = audioCtx();
    let p;
    try {
      const last = localStorage.getItem(LAST);
      p = last ? await loadProject(last) : null;
    } catch { p = null; }
    p = p ? fixProject(p) : demoProject();
    if (!el.isConnected) return null;
    const S = session(el, ctx, p);
    active = S;
    await S.ready;
    return () => { S.destroy(); if (active === S) active = null; };
  },
};

function session(el, ctx, p0) {
  let p = p0;
  const hist = new History();
  let sel = { trackId: p.tracks[0]?.id || null, clipId: null };
  let tab = 'faixa', focus = 'tl', paneKey = '', panel = null, pr = null, kb = null, gesture = false, raf = 0, destroyed = false;
  const synthHooked = new WeakSet();
  const engine = new DawEngine(ctx, { onStop: () => { updateTransport(); tl.draw(); } });

  const persist = debounce(() => { saveProject(p).catch(() => toast('Não consegui salvar o projeto no navegador.', 'danger')); }, 700);
  try { localStorage.setItem(LAST, p.id); } catch { /* ok */ }

  el.innerHTML = `
  <div class="daw">
    <div class="daw-bar d-flex flex-wrap align-items-center gap-2 mb-2">
      <div class="dropdown">
        <button class="btn btn-sm btn-outline-secondary dropdown-toggle text-truncate" style="max-width:14rem" type="button" data-bs-toggle="dropdown" aria-expanded="false" data-r="pname"></button>
        <ul class="dropdown-menu">
          <li><button class="dropdown-item" type="button" data-a="new"><i class="bi bi-file-earmark-plus"></i> Novo projeto</button></li>
          <li><button class="dropdown-item" type="button" data-a="open"><i class="bi bi-folder2-open"></i> Abrir…</button></li>
          <li><button class="dropdown-item" type="button" data-a="rename"><i class="bi bi-pencil"></i> Renomear</button></li>
          <li><button class="dropdown-item" type="button" data-a="dup"><i class="bi bi-files"></i> Duplicar projeto</button></li>
          <li><hr class="dropdown-divider"></li>
          <li><button class="dropdown-item" type="button" data-a="settings"><i class="bi bi-sliders"></i> Gravação e latência…</button></li>
          <li><hr class="dropdown-divider"></li>
          <li><button class="dropdown-item" type="button" data-a="wav"><i class="bi bi-filetype-wav"></i> Exportar música (WAV)</button></li>
          <li><button class="dropdown-item" type="button" data-a="wavloop"><i class="bi bi-arrow-repeat"></i> Exportar só o loop (WAV)</button></li>
          <li><button class="dropdown-item" type="button" data-a="pfile"><i class="bi bi-box-arrow-up"></i> Salvar arquivo do projeto</button></li>
          <li><label class="dropdown-item mb-0" role="button"><i class="bi bi-box-arrow-in-down"></i> Abrir arquivo de projeto<input type="file" accept=".json,.estudio,application/json" data-a="pimport" hidden></label></li>
          <li><hr class="dropdown-divider"></li>
          <li><button class="dropdown-item text-danger" type="button" data-a="delproj"><i class="bi bi-trash"></i> Apagar este projeto</button></li>
        </ul>
      </div>
      <div class="btn-group btn-group-sm" role="group" aria-label="Desfazer">
        <button class="btn btn-outline-secondary" type="button" data-a="undo" title="Desfazer (Ctrl+Z)"><i class="bi bi-arrow-counterclockwise"></i><span class="visually-hidden">Desfazer</span></button>
        <button class="btn btn-outline-secondary" type="button" data-a="redo" title="Refazer (Ctrl+Shift+Z)"><i class="bi bi-arrow-clockwise"></i><span class="visually-hidden">Refazer</span></button>
      </div>
      <div class="btn-group" role="group" aria-label="Transporte">
        <button class="btn btn-outline-secondary" type="button" data-a="home" title="Voltar ao início (Home)"><i class="bi bi-skip-start-fill"></i><span class="visually-hidden">Início</span></button>
        <button class="btn btn-outline-success" type="button" data-a="play" title="Tocar / parar (Espaço)"><i class="bi bi-play-fill"></i><span class="visually-hidden">Tocar</span></button>
        <button class="btn btn-outline-danger" type="button" data-a="rec" title="Gravar as faixas armadas (R)"><i class="bi bi-record-fill"></i><span class="visually-hidden">Gravar</span></button>
      </div>
      <div class="daw-pos font-monospace small border rounded px-2 py-1 text-center" data-r="pos">1.1.00 · 0:00.0</div>
      <div class="input-group input-group-sm" style="width:auto">
        <input type="number" class="form-control" style="width:4.6rem" min="30" max="300" step="1" data-p="bpm" aria-label="Andamento (BPM)">
        <span class="input-group-text">BPM</span>
        <select class="form-select" style="width:5.2rem" data-p="sig" aria-label="Compasso">${[2, 3, 4, 5, 6, 7].map((n) => `<option value="${n}">${n}/4</option>`).join('')}</select>
      </div>
      <div class="btn-group btn-group-sm" role="group" aria-label="Opções">
        <input type="checkbox" class="btn-check" id="daw-metro" data-p="metro" autocomplete="off"><label class="btn btn-outline-secondary" for="daw-metro" title="Metrônomo"><i class="bi bi-stopwatch"></i><span class="visually-hidden">Metrônomo</span></label>
        <input type="checkbox" class="btn-check" id="daw-count" data-p="countIn" autocomplete="off"><label class="btn btn-outline-secondary" for="daw-count" title="Contagem de 1 compasso antes de gravar"><i class="bi bi-hourglass-split"></i><span class="visually-hidden">Contagem</span></label>
        <input type="checkbox" class="btn-check" id="daw-loop" data-p="loop" autocomplete="off"><label class="btn btn-outline-secondary" for="daw-loop" title="Loop (arraste na metade de cima da régua para marcar)"><i class="bi bi-arrow-repeat"></i><span class="visually-hidden">Loop</span></label>
      </div>
      <select class="form-select form-select-sm" style="width:auto" data-p="snap" aria-label="Grade">${SNAPS.map(([v, l]) => `<option value="${v}">Grade ${l}</option>`).join('')}</select>
      <div class="btn-group btn-group-sm" role="group" aria-label="Zoom">
        <button class="btn btn-outline-secondary" type="button" data-a="zout" title="Afastar"><i class="bi bi-zoom-out"></i><span class="visually-hidden">Afastar</span></button>
        <button class="btn btn-outline-secondary" type="button" data-a="zin" title="Aproximar"><i class="bi bi-zoom-in"></i><span class="visually-hidden">Aproximar</span></button>
      </div>
      <div class="dropdown">
        <button class="btn btn-sm btn-primary dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false"><i class="bi bi-plus-lg"></i> Faixa</button>
        <ul class="dropdown-menu">
          <li><button class="dropdown-item" type="button" data-a="add-pm"><i class="bi bi-usb-symbol"></i> Pocket Master (entrada USB)</button></li>
          <li><button class="dropdown-item" type="button" data-a="add-audio"><i class="bi bi-mic"></i> Áudio (microfone ou outra entrada)</button></li>
          <li><button class="dropdown-item" type="button" data-a="add-inst"><i class="bi bi-keyboard"></i> Instrumento (sintetizador)</button></li>
        </ul>
      </div>
      <label class="btn btn-sm btn-outline-secondary mb-0" title="Trazer um arquivo de áudio para a faixa selecionada"><i class="bi bi-file-earmark-music"></i><span class="d-none d-xxl-inline"> Importar áudio</span><span class="visually-hidden d-xxl-none">Importar áudio</span><input type="file" accept="audio/*,video/*" data-a="importaudio" hidden></label>
      <div class="btn-group btn-group-sm" role="group" aria-label="Clipe">
        <button class="btn btn-outline-secondary" type="button" data-a="split" title="Dividir o clipe no cursor"><i class="bi bi-scissors"></i><span class="visually-hidden">Dividir</span></button>
        <button class="btn btn-outline-secondary" type="button" data-a="dupclip" title="Duplicar clipe (Ctrl+D)"><i class="bi bi-copy"></i><span class="visually-hidden">Duplicar clipe</span></button>
        <button class="btn btn-outline-secondary" type="button" data-a="delclip" title="Apagar clipe (Delete)"><i class="bi bi-trash"></i><span class="visually-hidden">Apagar clipe</span></button>
      </div>
      <div class="ms-auto d-flex align-items-center gap-1 small" title="Nível da saída"><i class="bi bi-volume-up"></i><div class="daw-meter" style="width:80px;height:8px"><div data-r="mmeter"></div></div></div>
    </div>
    <div class="daw-arrange border rounded">
      <div class="daw-heads" data-r="heads"></div>
      <div class="daw-tl" data-r="tl"></div>
    </div>
    <ul class="nav nav-tabs mt-3" role="tablist">
      <li class="nav-item"><button class="nav-link" type="button" data-tab="faixa">Faixa</button></li>
      <li class="nav-item"><button class="nav-link" type="button" data-tab="editor">Editor</button></li>
      <li class="nav-item"><button class="nav-link" type="button" data-tab="mixer">Mixer</button></li>
      <li class="nav-item"><button class="nav-link" type="button" data-tab="teclado">Teclado</button></li>
    </ul>
    <div class="daw-pane border border-top-0 rounded-bottom p-3" data-r="pane"></div>
    <p class="small text-body-secondary mt-2">Dica: duplo clique numa faixa de instrumento cria um clipe MIDI; duplo clique na régua liga o loop. Alt + arrastar duplica um clipe. Os projetos ficam guardados neste navegador; use "Salvar arquivo do projeto" para levar a outro aparelho.</p>
  </div>`;

  const R = (n) => el.querySelector(`[data-r="${n}"]`);
  const track = (id = sel.trackId) => p.tracks.find((t) => t.id === id) || null;
  const clip = () => { const t = track(); return t?.clips.find((c) => c.id === sel.clipId) || null; };
  const findClip = (id) => { for (const t of p.tracks) { const c = t.clips.find((k) => k.id === id); if (c) return { t, c }; } return null; };

  // ---------------------------------------------------------------- mudanças, desfazer
  function begin() { hist.push(p); }
  function cancel() { hist.undo.pop(); }
  async function end({ structure = true } = {}) {
    persist();
    if (structure) await engine.sync(p); else engine.mix(p);
    hookSynths();
    renderHeads(); tl.layout(); renderBar(); refreshPane();
  }
  async function change(fn, opts) { begin(); await fn(); await end(opts); }
  async function replaceProject(q, { keepSynths = true } = {}) {
    if (keepSynths) for (const t of q.tracks) { const cur = p.tracks.find((x) => x.id === t.id); if (cur?.synth) t.synth = cur.synth; } // o som do instrumento fica fora do desfazer
    p = fixProject(q);
    if (!track()) sel = { trackId: p.tracks[0]?.id || null, clipId: null };
    if (sel.clipId && !clip()) sel.clipId = null;
    persist();
    await engine.sync(p);
    hookSynths();
    renderHeads(); tl.layout(); renderBar(); paneKey = ''; refreshPane();
  }
  async function undo() { const q = hist.back(p); if (q) await replaceProject(q); }
  async function redo() { const q = hist.fwd(p); if (q) await replaceProject(q); }

  // o painel do sintetizador muda o instrumento direto: copia o estado para a faixa
  function hookSynths() {
    for (const t of p.tracks) {
      const syn = engine.synthOf(t.id);
      if (!syn || synthHooked.has(syn)) continue;
      synthHooked.add(syn);
      const id = t.id;
      syn.on(async (st) => {
        const tr = p.tracks.find((x) => x.id === id);
        if (!tr) return;
        tr.synth = { engine: st.engine, params: structuredClone(st.params), fx: structuredClone(st.fx), source: st.source ? { ...st.source } : null };
        if (st.source?.kind === 'sample' && !st.source.audioId && syn.zones[0]?.user && !syn.__saving) {
          syn.__saving = true;
          const z = syn.zones[0];
          try {
            const aid = await saveAudio(z.R ? [z.L, z.R] : [z.L], z.sr, st.source.name || 'amostra');
            st.source.audioId = aid;
            tr.synth.source = { ...st.source };
          } finally { syn.__saving = false; }
        }
        persist();
      });
    }
  }

  // ---------------------------------------------------------------- barra
  function renderBar() {
    R('pname').textContent = p.name;
    el.querySelector('[data-p="bpm"]').value = p.bpm;
    el.querySelector('[data-p="sig"]').value = p.sig;
    el.querySelector('[data-p="metro"]').checked = p.metro;
    el.querySelector('[data-p="countIn"]').checked = p.countIn;
    el.querySelector('[data-p="loop"]').checked = p.loop.on;
    el.querySelector('[data-p="snap"]').value = p.snap === p.sig && p.snapBar ? 'bar' : String(p.snap);
    el.querySelector('[data-a="undo"]').disabled = !hist.undo.length;
    el.querySelector('[data-a="redo"]').disabled = !hist.redo.length;
    const c = clip();
    for (const a of ['split', 'dupclip', 'delclip']) el.querySelector(`[data-a="${a}"]`).disabled = !c;
    updateTransport();
  }
  function updateTransport() {
    const play = el.querySelector('[data-a="play"]'), rec = el.querySelector('[data-a="rec"]');
    if (!play) return;
    play.innerHTML = engine.playing ? '<i class="bi bi-stop-fill"></i><span class="visually-hidden">Parar</span>' : '<i class="bi bi-play-fill"></i><span class="visually-hidden">Tocar</span>';
    play.classList.toggle('active', engine.playing && !engine.recording);
    rec.classList.toggle('active', !!engine.recording);
    rec.classList.toggle('daw-recording', !!engine.recording);
  }

  // ---------------------------------------------------------------- cabeçalhos das faixas
  function renderHeads() {
    const solo = p.tracks.some((t) => t.solo);
    R('heads').innerHTML = `<div class="daw-ruler-cell small text-body-secondary px-2">${p.tracks.length} faixa${p.tracks.length === 1 ? '' : 's'}</div>` + p.tracks.map((t) => `
      <div class="daw-head${t.id === sel.trackId ? ' sel' : ''}${solo && !t.solo ? ' dim' : ''}" data-t="${t.id}" style="--c:${t.color}">
        <div class="d-flex align-items-center gap-1 small"><i class="bi ${t.kind === 'audio' ? (t.input.match === 'pocket' ? 'bi-usb-symbol' : 'bi-soundwave') : 'bi-keyboard'}"></i><span class="text-truncate fw-semibold">${esc(t.name)}</span></div>
        <div class="d-flex gap-1">
          <button class="btn ${t.mute ? 'btn-warning' : 'btn-outline-secondary'}" type="button" data-h="mute" title="Mudo" aria-pressed="${t.mute}">M</button>
          <button class="btn ${t.solo ? 'btn-info' : 'btn-outline-secondary'}" type="button" data-h="solo" title="Solo" aria-pressed="${t.solo}">S</button>
          <button class="btn ${t.arm ? 'btn-danger' : 'btn-outline-secondary'}" type="button" data-h="arm" title="Armar para gravar" aria-pressed="${t.arm}"><i class="bi bi-record-fill"></i><span class="visually-hidden">Armar</span></button>
          ${t.kind === 'audio' ? `<button class="btn ${t.input.monitor ? 'btn-primary' : 'btn-outline-secondary'}" type="button" data-h="monitor" title="Ouvir a entrada" aria-pressed="${t.input.monitor}"><i class="bi bi-headphones"></i><span class="visually-hidden">Ouvir</span></button>` : ''}
        </div>
        <div class="daw-meter"><div data-meter="${t.id}"></div></div>
      </div>`).join('') + `<div class="daw-head-add"><button class="btn btn-sm btn-link" type="button" data-a="add-inst">+ instrumento</button><button class="btn btn-sm btn-link" type="button" data-a="add-pm">+ Pocket Master</button></div>`;
  }
  R('heads').addEventListener('click', async (e) => {
    const head = e.target.closest('[data-t]');
    if (!head) return;
    const t = track(head.dataset.t), hb = e.target.closest('[data-h]')?.dataset.h;
    if (!hb) { select(t.id, null); return; }
    await resumeAudio();
    if (hb === 'arm') {
      await change(() => { t.arm = !t.arm; }, { structure: false });
      if (t.arm && t.kind === 'audio' && t.pm.slot != null && PM.device()) PM.device().select(t.pm.slot).then(() => toast(`Pedaleira no preset ${PM.slotLabel(t.pm.slot)}.`)).catch(() => {});
      if (t.arm && t.input.monitor) applyMonitor(t);
      if (!t.arm) engine.setMonitor(t, false);
      return;
    }
    if (hb === 'monitor') { await change(() => { t.input.monitor = !t.input.monitor; }, { structure: false }); applyMonitor(t); return; }
    await change(() => { t[hb] = !t[hb]; }, { structure: false });
  });
  async function applyMonitor(t) {
    try { await resolveInput(t); await engine.setMonitor(t, t.input.monitor); } catch (err) { toast(captureError(err, 'a entrada de áudio'), 'danger'); }
  }

  function select(trackId, clipId) {
    const changed = trackId !== sel.trackId || clipId !== sel.clipId;
    sel = { trackId, clipId };
    if (!changed) return;
    renderHeads(); tl.draw(); renderBar();
    if (clipId && tab === 'faixa' && clip()?.notes == null) { /* clipe de áudio: continua na faixa */ }
    refreshPane();
  }

  // ---------------------------------------------------------------- linha do tempo
  const tl = timeline(R('tl'), {
    project: () => p,
    position: () => engine.position,
    recordingFrom: () => (engine.recording ? engine.recording.fromBeat : null),
    selection: () => sel,
    select: (t, c) => { focus = 'tl'; select(t, c); },
    seek: (b) => { engine.seek(b); tl.draw(); pr?.draw(); showPos(); },
    begin, cancel, end: () => end(),
    open: (t, c) => { sel = { trackId: t.id, clipId: c.id }; tab = c.notes ? 'editor' : tab === 'faixa' ? 'editor' : tab; renderHeads(); tl.draw(); renderBar(); refreshPane(); },
    create: (t, beat) => change(() => {
      const c = { id: uid(), name: 'MIDI', start: beat, len: p.sig, notes: [] };
      t.clips.push(c); sel = { trackId: t.id, clipId: c.id }; tab = 'editor';
    }),
    zoom: (f, beat, x) => zoomTo(p.zoom * f, beat, x),
  });
  function zoomTo(z, beat = engine.position, x = R('tl').clientWidth / 2) {
    p.zoom = clamp(z, 4, 240);
    tl.layout();
    R('tl').scrollLeft = Math.max(0, beat * p.zoom - x);
    tl.draw(); persist();
  }

  // ---------------------------------------------------------------- painel de baixo
  function refreshPane() {
    el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    const t = track(), c = clip();
    const key = `${tab}|${t?.id}|${t?.kind}|${tab === 'editor' ? c?.id : ''}|${p.tracks.length}`;
    if (key === paneKey) { lightRefresh(); return; }
    paneKey = key;
    panel?.destroy(); panel = null; pr?.destroy(); pr = null; kb = null;
    const pane = R('pane');
    if (tab === 'faixa') renderTrackPane(pane, t);
    else if (tab === 'editor') renderEditor(pane, t, c);
    else if (tab === 'mixer') renderMixer(pane);
    else renderKeys(pane);
  }
  function lightRefresh() {
    if (tab === 'mixer') updateMixerValues();
    if (tab === 'editor' && pr) pr.show(true);
    if (tab === 'editor' && !pr) renderEditor(R('pane'), track(), clip());
  }
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) { tab = b.dataset.tab; refreshPane(); }
  });

  function renderTrackPane(pane, t) {
    if (!t) { pane.innerHTML = '<p class="text-body-secondary mb-0">Nenhuma faixa. Use o botão "+ Faixa".</p>'; return; }
    const common = `<div class="row g-2 align-items-end mb-3">
      <div class="col-sm-5 col-lg-4"><label class="form-label small mb-0" for="daw-tname">Nome da faixa</label><input class="form-control form-control-sm" id="daw-tname" data-tr="name" value="${esc(t.name)}"></div>
      <div class="col-auto"><label class="form-label small mb-0" for="daw-tcolor">Cor</label><select class="form-select form-select-sm" id="daw-tcolor" data-tr="color" style="color:${t.color}">${COLORS.map((c) => `<option value="${c}" style="color:${c}"${c === t.color ? ' selected' : ''}>■ ${c}</option>`).join('')}</select></div>
      <div class="col-auto d-flex gap-1">
        <button class="btn btn-sm btn-outline-secondary" type="button" data-ta="up" title="Subir"><i class="bi bi-arrow-up"></i><span class="visually-hidden">Subir</span></button>
        <button class="btn btn-sm btn-outline-secondary" type="button" data-ta="down" title="Descer"><i class="bi bi-arrow-down"></i><span class="visually-hidden">Descer</span></button>
        <button class="btn btn-sm btn-outline-secondary" type="button" data-ta="dup"><i class="bi bi-files"></i> Duplicar</button>
        <button class="btn btn-sm btn-outline-danger" type="button" data-ta="del"><i class="bi bi-trash"></i> Apagar faixa</button>
      </div></div>`;
    if (t.kind === 'inst') {
      pane.innerHTML = common + '<div data-r="synth"></div>';
      const syn = engine.synthOf(t.id);
      if (syn) panel = synthPanel(pane.querySelector('[data-r="synth"]'), syn, {});
      return;
    }
    const dev = PM.device();
    const auto = Math.round(((ctx.outputLatency || ctx.baseLatency || 0) + 0.01) * 1000);
    pane.innerHTML = common + `
      <div class="row g-3">
        <div class="col-lg-6"><section class="card h-100"><div class="card-body">
          <h3 class="h6">Entrada</h3>
          <div class="row g-2">
            <div class="col-sm-7"><label class="form-label small mb-0" for="daw-in">Gravar de</label><select class="form-select form-select-sm" id="daw-in" data-tr="deviceId"><option value="">${t.input.match === 'pocket' ? 'Pocket Master (procurar automaticamente)' : 'Entrada padrão'}</option></select></div>
            <div class="col-sm-5"><label class="form-label small mb-0" for="daw-ch">Canais</label><select class="form-select form-select-sm" id="daw-ch" data-tr="channel">
              <option value="stereo"${t.input.channel === 'stereo' ? ' selected' : ''}>Estéreo</option><option value="left"${t.input.channel === 'left' ? ' selected' : ''}>Só o esquerdo (mono)</option><option value="right"${t.input.channel === 'right' ? ' selected' : ''}>Só o direito (mono)</option></select></div>
          </div>
          <button class="btn btn-sm btn-link px-0" type="button" data-ta="perm" hidden>Mostrar os nomes das entradas (pede permissão)</button>
          <div class="form-check form-switch mt-2"><input class="form-check-input" type="checkbox" role="switch" id="daw-mon" data-tr="monitor"${t.input.monitor ? ' checked' : ''}><label class="form-check-label small" for="daw-mon">Ouvir a entrada pelo site quando armada (deixe desligado se já ouve pelo fone da pedaleira)</label></div>
          <p class="small text-body-secondary mb-0 mt-2">Compensação de atraso: ${p.latencyMs != null ? `manual, ${p.latencyMs} ms` : `automática (~${auto} ms)`}. <button class="btn btn-sm btn-link p-0 align-baseline" type="button" data-a="settings">Ajustar</button></p>
        </div></section></div>
        <div class="col-lg-6"><section class="card h-100"><div class="card-body">
          <h3 class="h6"><i class="bi bi-usb-symbol"></i> Pocket Master</h3>
          <p class="small text-body-secondary">Ligue a pedaleira no computador com cabo USB-C: ela aparece como placa de som (entrada de áudio). Arme a faixa e aperte gravar. Para trocar o timbre sozinho ao armar, conecte o controle da pedaleira abaixo e escolha o preset.</p>
          ${dev ? `<div class="input-group input-group-sm"><label class="input-group-text" for="daw-slot">Preset ao armar</label>
              <select class="form-select" id="daw-slot" data-tr="slot"><option value="">Não trocar</option>${Array.from({ length: 70 }, (_, i) => i).map((i) => `<option value="${i}"${t.pm.slot === i ? ' selected' : ''}>${PM.slotLabel(i)} ${esc(dev.names?.[i] || '')}</option>`).join('')}</select>
              <button class="btn btn-outline-primary" type="button" data-ta="pmnow">Trocar agora</button></div>
              <div class="form-text">Conectada pelo ${PM.via() === 'ble' ? 'Bluetooth' : 'USB'}. Preset atual: ${esc(PM.currentLabel())}</div>`
    : `${t.pm.slot != null ? `<p class="small">Preset escolhido: ${PM.slotLabel(t.pm.slot)} (conecte para trocar ao armar).</p>` : ''}${PM.connectButtonsHtml()}`}
        </div></section></div>
      </div>`;
    fillInputs(pane, t);
  }
  async function fillInputs(pane, t) {
    const sel2 = pane.querySelector('#daw-in');
    if (!sel2) return;
    try {
      const list = await listInputs();
      if (!list.some((d) => d.label)) { pane.querySelector('[data-ta="perm"]').hidden = false; return; }
      sel2.innerHTML = `<option value="">${t.input.match === 'pocket' ? 'Pocket Master (procurar automaticamente)' : 'Entrada padrão'}</option>` + list.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => `<option value="${esc(d.deviceId)}"${d.deviceId === t.input.deviceId ? ' selected' : ''}>${esc(d.label || 'Entrada')}${PEDAL.test(d.label) ? ' ★' : ''}</option>`).join('');
    } catch { /* sem lista */ }
  }
  /** Faixa da Pocket Master: acha a entrada USB dela pelo nome. */
  async function resolveInput(t) {
    if (t.kind !== 'audio' || t.input.deviceId || t.input.match !== 'pocket') return;
    let list = await listInputs().catch(() => []);
    if (!list.some((d) => d.label)) { const s = await getInput(); s.getTracks().forEach((x) => x.stop()); list = await listInputs().catch(() => []); }
    const d = list.find((x) => PEDAL.test(x.label));
    if (d) t.input.deviceId = d.deviceId;
    else toast('Não achei a entrada USB da Pocket Master; vou usar a entrada padrão. Escolha a entrada na aba Faixa.', 'warning');
  }

  const paneEl = R('pane');
  paneEl.addEventListener('input', (e) => {
    const k = e.target.dataset.tr, m = e.target.dataset.m;
    if (k === 'name') { const t = track(); if (!gesture) { begin(); gesture = true; } t.name = e.target.value; renderHeads(); tl.draw(); return; }
    if (m) mixerInput(e.target);
    if (e.target.dataset.cl) clipInput(e.target);
  });
  paneEl.addEventListener('change', async (e) => {
    const t = track(), k = e.target.dataset.tr;
    if (e.target.dataset.m || e.target.dataset.cl || k === 'name') { gesture = false; await end({ structure: false }); return; }
    if (!t || !k) return;
    if (k === 'color') { await change(() => { t.color = e.target.value; }, { structure: false }); paneKey = ''; refreshPane(); return; }
    if (k === 'deviceId') { await change(() => { t.input.deviceId = e.target.value; }, { structure: false }); if (t.arm && t.input.monitor) applyMonitor(t); return; }
    if (k === 'channel') { await change(() => { t.input.channel = e.target.value; }, { structure: false }); if (t.arm && t.input.monitor) applyMonitor(t); return; }
    if (k === 'monitor') { await change(() => { t.input.monitor = e.target.checked; }, { structure: false }); if (t.arm) applyMonitor(t); return; }
    if (k === 'slot') { await change(() => { t.pm.slot = e.target.value === '' ? null : Number(e.target.value); }, { structure: false }); }
  });
  paneEl.addEventListener('click', async (e) => {
    const conn = e.target.closest('[data-connect]');
    if (conn) {
      busyButton(conn, true, 'Conectando…');
      try { await PM.connect(conn.dataset.connect); paneKey = ''; refreshPane(); } catch (err) { toast(PM.connectError(err), 'danger'); busyButton(conn, false); }
      return;
    }
    const a = e.target.closest('[data-ta]')?.dataset.ta;
    const t = track();
    if (!a || !t) return;
    if (a === 'perm') { try { const s = await getInput(); s.getTracks().forEach((x) => x.stop()); paneKey = ''; refreshPane(); } catch (err) { toast(captureError(err, 'a entrada de áudio'), 'danger'); } }
    if (a === 'pmnow' && t.pm.slot != null) PM.device()?.select(t.pm.slot).then(() => toast(`Pedaleira no preset ${PM.slotLabel(t.pm.slot)}.`)).catch((err) => toast(err.message, 'danger'));
    if (a === 'up' || a === 'down') {
      const i = p.tracks.indexOf(t), j = i + (a === 'up' ? -1 : 1);
      if (j < 0 || j >= p.tracks.length) return;
      await change(() => { p.tracks.splice(i, 1); p.tracks.splice(j, 0, t); }, { structure: false });
    }
    if (a === 'dup') {
      await change(() => {
        const c = { ...structuredClone(t), id: uid(), name: t.name + ' (cópia)', arm: false, clips: t.clips.map((k) => ({ ...structuredClone(k), id: uid() })) };
        p.tracks.splice(p.tracks.indexOf(t) + 1, 0, c); sel = { trackId: c.id, clipId: null };
      });
    }
    if (a === 'del') {
      if (t.clips.length && !(await confirmBox(`Apagar a faixa "${t.name}" e seus ${t.clips.length} clipe(s)?`, { ok: 'Apagar', danger: true }))) return;
      await change(() => { const i = p.tracks.indexOf(t); p.tracks.splice(i, 1); sel = { trackId: p.tracks[Math.min(i, p.tracks.length - 1)]?.id || null, clipId: null }; });
    }
    if (a === 'clipsplit') splitClip();
    if (a === 'clipdup') dupClip();
    if (a === 'clipdel') delClip();
  });

  function renderEditor(pane, t, c) {
    if (!c) { pane.innerHTML = `<p class="text-body-secondary mb-0">${t?.kind === 'inst' ? 'Dê duplo clique na faixa de instrumento (na linha do tempo) para criar um clipe MIDI, ou grave tocando o teclado.' : 'Selecione um clipe na linha do tempo.'}</p>`; return; }
    if (c.notes) {
      pane.innerHTML = '<div data-r="pr"></div>';
      pr = pianoRoll(pane.querySelector('[data-r="pr"]'), {
        project: () => p, track: () => track(), clip: () => clip(),
        begin, cancel, end: () => end({ structure: false }),
        preview: (n, v) => { resumeAudio(); const syn = engine.synthOf(sel.trackId); if (syn) { syn.noteOn(n, v); setTimeout(() => syn.noteOff(n), 250); } },
        position: () => engine.position,
      });
      pr.show();
      pane.querySelector('[data-r="pr"]').addEventListener('pointerdown', () => { focus = 'pr'; });
      return;
    }
    const a = cachedAudio(c.audioId);
    pane.innerHTML = `<div class="row g-2 align-items-end">
      <div class="col-sm-4"><label class="form-label small mb-0" for="daw-cname">Nome do clipe</label><input class="form-control form-control-sm" id="daw-cname" data-cl="name" value="${esc(c.name || '')}"></div>
      <div class="col-sm-4"><label class="form-label small mb-0 d-flex justify-content-between" for="daw-cgain"><span>Ganho</span><output>${(c.gain || 0).toFixed(1)} dB</output></label><input type="range" class="form-range" id="daw-cgain" data-cl="gain" min="-24" max="12" step="0.5" value="${c.gain || 0}"></div>
      <div class="col-sm-4 small text-body-secondary">Começa em ${fmtPos(p, c.start)} · dura ${fmtTime(c.dur)}${a ? ` · ${a.channels.length === 1 ? 'mono' : 'estéreo'}, ${a.sampleRate} Hz` : ''}</div>
      <div class="col-12 d-flex flex-wrap gap-2">
        <button class="btn btn-sm btn-outline-secondary" type="button" data-ta="clipsplit"><i class="bi bi-scissors"></i> Dividir no cursor</button>
        <button class="btn btn-sm btn-outline-secondary" type="button" data-ta="clipdup"><i class="bi bi-copy"></i> Duplicar</button>
        <button class="btn btn-sm btn-outline-secondary" type="button" data-ta="clipwav"><i class="bi bi-download"></i> Baixar este clipe (WAV)</button>
        <button class="btn btn-sm btn-outline-danger" type="button" data-ta="clipdel"><i class="bi bi-trash"></i> Apagar</button>
      </div></div>
      <p class="small text-body-secondary mt-2 mb-0">Puxe as bordas do clipe na linha do tempo para cortar o começo ou o fim.</p>`;
    pane.querySelector('[data-ta="clipwav"]').onclick = () => {
      const s = a.sampleRate, from = Math.round(c.offset * s), to = Math.round((c.offset + c.dur) * s);
      download(`${c.name || 'clipe'}.wav`, encodeWav(a.channels.map((ch) => ch.subarray(from, to)), s));
    };
  }
  function clipInput(inp) {
    const c = clip();
    if (!c) return;
    if (!gesture) { begin(); gesture = true; }
    if (inp.dataset.cl === 'name') c.name = inp.value;
    if (inp.dataset.cl === 'gain') { c.gain = Number(inp.value); inp.parentElement.querySelector('output').textContent = `${c.gain.toFixed(1)} dB`; }
    tl.draw();
  }

  // ---------------------------------------------------------------- mixer
  function strip(t) {
    const r = (m, min, max, step, v, label) => `<label class="d-block small mb-1"><span class="d-flex justify-content-between"><span>${label}</span><output>${m === 'pan' ? (v === 0 ? 'C' : v < 0 ? `E${Math.round(-v * 100)}` : `D${Math.round(v * 100)}`) : m === 'rev' ? Math.round(v * 100) + '%' : `${v > 0 ? '+' : ''}${v}`}</output></span><input type="range" class="form-range" data-m="${m}" min="${min}" max="${max}" step="${step}" value="${v}"></label>`;
    return `<div class="card mix-strip" data-t="${t.id}" style="--c:${t.color}"><div class="card-body p-2">
      <div class="text-truncate fw-semibold small mb-1 mix-name">${esc(t.name)}</div>
      ${r('eq.high', -12, 12, 0.5, t.eq.high, 'Agudo')}${r('eq.mid', -12, 12, 0.5, t.eq.mid, 'Médio')}${r('eq.low', -12, 12, 0.5, t.eq.low, 'Grave')}
      ${r('rev', 0, 1, 0.01, t.rev, 'Reverb')}${r('pan', -1, 1, 0.01, t.pan, 'Pan')}
      <div class="d-flex justify-content-center gap-2 my-1"><input type="range" class="vfader" data-m="vol" min="-60" max="6" step="0.5" value="${t.vol}" aria-label="Volume de ${esc(t.name)}"><div class="vmeter"><div data-meter="${t.id}"></div></div></div>
      <div class="text-center small font-monospace" data-r="vol">${t.vol <= -60 ? '−∞' : t.vol.toFixed(1)} dB</div>
      <div class="d-flex justify-content-center gap-1 mt-1">
        <button class="btn btn-sm ${t.mute ? 'btn-warning' : 'btn-outline-secondary'}" type="button" data-mx="mute">M</button>
        <button class="btn btn-sm ${t.solo ? 'btn-info' : 'btn-outline-secondary'}" type="button" data-mx="solo">S</button>
      </div></div></div>`;
  }
  function renderMixer(pane) {
    pane.innerHTML = `<div class="d-flex gap-2 overflow-auto pb-2">${p.tracks.map(strip).join('')}
      <div class="card mix-strip mix-master" data-t="master"><div class="card-body p-2">
        <div class="fw-semibold small mb-1">Saída</div>
        <p class="small text-body-secondary">Limitador no fim para não distorcer.</p>
        <div class="d-flex justify-content-center gap-2 my-1"><input type="range" class="vfader" data-m="master" min="-60" max="6" step="0.5" value="${p.master.vol}" aria-label="Volume geral"><div class="vmeter"><div data-meter="master"></div></div></div>
        <div class="text-center small font-monospace" data-r="vol">${p.master.vol.toFixed(1)} dB</div>
      </div></div></div>`;
    pane.querySelectorAll('[data-mx]').forEach((b) => { b.onclick = () => { const t = track(b.closest('[data-t]').dataset.t); change(() => { t[b.dataset.mx] = !t[b.dataset.mx]; }, { structure: false }).then(() => { paneKey = ''; refreshPane(); }); }; });
  }
  function updateMixerValues() {
    const pane = R('pane');
    for (const t of p.tracks) { const n = pane.querySelector(`.mix-strip[data-t="${t.id}"] .mix-name`); if (n) n.textContent = t.name; }
    if (pane.querySelectorAll('.mix-strip').length !== p.tracks.length + 1) { paneKey = ''; refreshPane(); }
  }
  function mixerInput(inp) {
    const id = inp.closest('[data-t]').dataset.t, m = inp.dataset.m, v = Number(inp.value);
    if (!gesture) { begin(); gesture = true; }
    if (id === 'master') { p.master.vol = v; inp.closest('.card-body').querySelector('[data-r="vol"]').textContent = `${v.toFixed(1)} dB`; engine.mix(p); return; }
    const t = track(id);
    if (m.startsWith('eq.')) t.eq[m.slice(3)] = v; else t[m] = v;
    const out = inp.parentElement.querySelector('output');
    if (out) out.textContent = m === 'pan' ? (v === 0 ? 'C' : v < 0 ? `E${Math.round(-v * 100)}` : `D${Math.round(v * 100)}`) : m === 'rev' ? Math.round(v * 100) + '%' : `${v > 0 ? '+' : ''}${v}`;
    if (m === 'vol') inp.closest('.card-body').querySelector('[data-r="vol"]').textContent = `${v <= -60 ? '−∞' : v.toFixed(1)} dB`;
    engine.mix(p);
  }

  // ---------------------------------------------------------------- tocar ao vivo
  const liveTargets = () => { const armed = p.tracks.filter((t) => t.kind === 'inst' && t.arm); if (armed.length) return armed; const t = track(); return t?.kind === 'inst' ? [t] : []; };
  function liveOn(n, v) { const ts = liveTargets(); if (!ts.length) return; resumeAudio(); ts.forEach((t) => engine.liveOn(t.id, n, v)); kb?.light(n, true); }
  function liveOff(n) { liveTargets().forEach((t) => engine.liveOff(t.id, n)); kb?.light(n, false); }
  let kbBase = 48;
  function renderKeys(pane) {
    const ts = liveTargets();
    pane.innerHTML = `<div class="d-flex flex-wrap align-items-center gap-2 mb-2 small">
        <div class="btn-group btn-group-sm" role="group" aria-label="Oitava"><button class="btn btn-outline-secondary" type="button" data-k="down" aria-label="Oitava abaixo">−</button><span class="btn btn-outline-secondary disabled" data-r="oct">${noteLabel(kbBase)}</span><button class="btn btn-outline-secondary" type="button" data-k="up" aria-label="Oitava acima">+</button></div>
        <span class="text-body-secondary">${ts.length ? `Tocando: ${ts.map((t) => esc(t.name)).join(', ')}` : 'Selecione (ou arme) uma faixa de instrumento.'} · Teclado do computador: A W S E D F T G Y H U J K · Z/X oitava</span>
      </div><div data-r="kb"></div>`;
    const wide = () => (window.innerWidth >= 992 ? 4 : window.innerWidth >= 576 ? 3 : 2);
    kb = pianoKeyboard(pane.querySelector('[data-r="kb"]'), { from: kbBase, octaves: wide(), onOn: liveOn, onOff: liveOff });
    pane.querySelector('.btn-group').onclick = (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (!k) return;
      kbBase = clamp(kbBase + (k === 'up' ? 12 : -12), 12, 96); qk.state.base = kbBase + 12;
      kb.setRange(kbBase, wide()); pane.querySelector('[data-r="oct"]').textContent = noteLabel(kbBase);
    };
  }
  const qk = qwertyKeys({ base: kbBase + 12, onOn: liveOn, onOff: liveOff, onOctave: (b) => { kbBase = b - 12; if (tab === 'teclado') { paneKey = ''; refreshPane(); } } });
  let midi = null;
  midiKeyboards({ onOn: liveOn, onOff: liveOff, onBend: (v) => liveTargets().forEach((t) => engine.synthOf(t.id)?.bend(v)), onMod: (v) => liveTargets().forEach((t) => engine.synthOf(t.id)?.mod(v)), onAllOff: () => liveTargets().forEach((t) => engine.synthOf(t.id)?.allOff()) })
    .then((m) => { if (destroyed) m.detach(); else midi = m; }).catch(() => {});

  // ---------------------------------------------------------------- transporte e gravação
  async function togglePlay() {
    await resumeAudio();
    if (engine.recording) { await toggleRecord(); return; }
    if (engine.playing) engine.stop(); else engine.play(engine.position);
    updateTransport();
  }
  async function toggleRecord() {
    await resumeAudio();
    if (engine.recording) {
      const btn = el.querySelector('[data-a="rec"]');
      busyButton(btn, true, '');
      let out = [];
      try { out = await engine.stopRecording(); } finally { busyButton(btn, false); }
      if (out.length) {
        await change(() => {
          for (const { trackId, clip: c } of out) {
            const t = track(trackId);
            if (!t) continue;
            if (c.notes) c.name = `Gravação ${t.clips.filter((k) => k.notes).length + 1}`;
            t.clips.push(c); sel = { trackId, clipId: c.id };
          }
        });
        toast(out.length === 1 ? 'Gravação adicionada.' : `${out.length} gravações adicionadas.`, 'success');
      } else toast('Nada foi gravado.');
      updateTransport(); tl.draw();
      return;
    }
    const armed = p.tracks.filter((t) => t.arm);
    if (!armed.length) {
      const t = track();
      if (!t) { toast('Crie uma faixa para gravar.'); return; }
      await change(() => { t.arm = true; }, { structure: false });
      toast(`Faixa "${t.name}" armada.`);
    }
    try {
      for (const t of p.tracks.filter((x) => x.arm && x.kind === 'audio')) await resolveInput(t);
      if (engine.playing) engine.stop(false);
      await engine.record(engine.position);
      persist();
    } catch (err) { toast(err.name ? captureError(err, 'a entrada de áudio') : err.message, 'danger'); }
    updateTransport();
  }

  // ---------------------------------------------------------------- clipes
  function delClip() { const c = clip(); if (!c) return; change(() => { const t = track(); t.clips = t.clips.filter((k) => k !== c); sel.clipId = null; }); }
  function dupClip() {
    const c = clip(); if (!c) return;
    change(() => { const n = { ...structuredClone(c), id: uid(), start: clipEnd(p, c) }; track().clips.push(n); sel.clipId = n.id; });
  }
  function splitClip() {
    const c = clip(), b = engine.position;
    if (!c) return;
    if (b <= c.start + 0.01 || b >= clipEnd(p, c) - 0.01) { toast('Coloque o cursor no meio do clipe para dividir.'); return; }
    change(() => {
      const t = track(), cut = b - c.start;
      let n;
      if (c.notes) {
        n = { ...structuredClone(c), id: uid(), start: b, len: c.len - cut, notes: c.notes.filter((k) => k.t >= cut).map((k) => ({ ...k, t: k.t - cut })) };
        c.notes = c.notes.filter((k) => k.t < cut).map((k) => ({ ...k, d: Math.min(k.d, cut - k.t) }));
        c.len = cut;
      } else {
        const s = cut * spb(p);
        n = { ...structuredClone(c), id: uid(), start: b, offset: c.offset + s, dur: c.dur - s };
        c.dur = s;
      }
      t.clips.push(n); sel.clipId = n.id;
    });
  }
  async function importAudio(file) {
    try {
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const chans = [buf.getChannelData(0).slice()];
      if (buf.numberOfChannels > 1) chans.push(buf.getChannelData(1).slice());
      const id = await saveAudio(chans, buf.sampleRate, file.name);
      await loadAudio(ctx, id);
      await change(() => {
        let t = track();
        if (!t || t.kind !== 'audio') { t = newTrack(p, 'audio', { name: file.name.replace(/\.[^.]+$/, '').slice(0, 30) }); p.tracks.push(t); }
        const c = { id: uid(), name: file.name.replace(/\.[^.]+$/, ''), start: engine.position, offset: 0, dur: buf.duration, audioId: id, gain: 0 };
        t.clips.push(c); sel = { trackId: t.id, clipId: c.id };
      });
    } catch { toast('Não consegui ler esse arquivo de áudio.', 'danger'); }
  }
  function addTrack(kind) {
    change(() => {
      const t = kind === 'pm' ? newTrack(p, 'audio', { name: 'Pocket Master', input: { deviceId: '', channel: 'stereo', monitor: false, match: 'pocket' } }) : newTrack(p, kind);
      p.tracks.push(t); sel = { trackId: t.id, clipId: null };
    });
  }

  // ---------------------------------------------------------------- projetos
  async function openProject(q) {
    if (engine.recording) return;
    engine.stop(false);
    hist.undo = []; hist.redo = [];
    try { localStorage.setItem(LAST, q.id); } catch { /* ok */ }
    sel = { trackId: q.tracks[0]?.id || null, clipId: null };
    engine.pos = 0;
    await replaceProject(q, { keepSynths: false });
    R('tl').scrollLeft = 0;
  }
  async function projectsDialog() {
    const list = await listProjects();
    const m = modal({ title: 'Projetos', body: list.length ? `<div class="list-group">${list.map((x) => `
      <div class="list-group-item d-flex align-items-center gap-2"><button class="btn btn-link text-start flex-grow-1 p-0 text-decoration-none" type="button" data-open="${x.id}"><strong>${esc(x.name)}</strong><br><span class="small text-body-secondary">${x.tracks} faixa(s) · ${new Date(x.updated).toLocaleString('pt-BR')}</span></button>
      ${x.id === p.id ? '<span class="badge text-bg-secondary">aberto</span>' : `<button class="btn btn-sm btn-outline-danger" type="button" data-del="${x.id}" title="Apagar"><i class="bi bi-trash"></i><span class="visually-hidden">Apagar</span></button>`}</div>`).join('')}</div>` : '<p class="mb-0">Nenhum projeto ainda.</p>' });
    m.body.onclick = async (e) => {
      const o = e.target.closest('[data-open]')?.dataset.open, d = e.target.closest('[data-del]')?.dataset.del;
      if (o) { if (o !== p.id) { const q = await loadProject(o); if (q) await openProject(q); } m.close(); }
      if (d && await confirmBox('Apagar esse projeto e suas gravações?', { ok: 'Apagar', danger: true })) { await deleteProject(d); m.close(); projectsDialog(); }
    };
  }
  function settingsDialog() {
    const auto = Math.round(((ctx.outputLatency || ctx.baseLatency || 0) + 0.01) * 1000);
    const m = modal({ title: 'Gravação e latência', body: `
      <p class="small">O som que você toca chega ao site um pouco atrasado (saída de áudio + entrada). A DAW adianta a gravação por esse tempo para ela cair no lugar certo.</p>
      <div class="form-check"><input class="form-check-input" type="radio" name="lat" id="lat-auto" value="auto"${p.latencyMs == null ? ' checked' : ''}><label class="form-check-label" for="lat-auto">Automática (o navegador informa ~${auto} ms)</label></div>
      <div class="form-check mb-2"><input class="form-check-input" type="radio" name="lat" id="lat-man" value="man"${p.latencyMs != null ? ' checked' : ''}><label class="form-check-label" for="lat-man">Manual</label></div>
      <div class="input-group input-group-sm mb-3" style="max-width:14rem"><input type="number" class="form-control" id="lat-ms" min="0" max="1000" step="1" value="${p.latencyMs ?? auto}"><span class="input-group-text">ms</span></div>
      <p class="small text-body-secondary">Se a gravação ficar atrasada em relação ao metrônomo, aumente; se ficar adiantada, diminua.</p>
      <label class="form-label" for="rq">Ao gravar notas (MIDI), alinhar à grade</label>
      <select class="form-select form-select-sm" id="rq" style="max-width:14rem">${[[0, 'Não alinhar'], [1, '1/4'], [0.5, '1/8'], [0.25, '1/16'], [0.125, '1/32']].map(([v, l]) => `<option value="${v}"${p.recQuantize === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`,
    footer: '<button class="btn btn-primary" type="button" data-ok>Salvar</button>' });
    m.footer.querySelector('[data-ok]').onclick = () => {
      const man = m.body.querySelector('#lat-man').checked;
      change(() => { p.latencyMs = man ? clamp(Number(m.body.querySelector('#lat-ms').value) || 0, 0, 1000) : null; p.recQuantize = Number(m.body.querySelector('#rq').value); }, { structure: false });
      paneKey = ''; refreshPane();
      m.close();
    };
  }
  async function exportWav(loopOnly) {
    if (!p.tracks.some((t) => t.clips.length)) { toast('Ainda não há nada para exportar.'); return; }
    if (engine.playing) engine.stop();
    const m = modal({ title: 'Exportando', body: `<p class="small mb-2">Mixando ${loopOnly ? 'o loop' : 'a música'}…</p>${progressHtml('daw-exp')}` });
    try {
      const out = await engine.render({ from: loopOnly ? p.loop.start : 0, to: loopOnly ? p.loop.end : null, onProgress: (f) => setProgress(m.body.querySelector('#daw-exp'), f) });
      download(`${p.name}${loopOnly ? ' (loop)' : ''}.wav`, encodeWav(out.channels, out.sampleRate));
      m.close();
    } catch (err) { m.body.innerHTML = `<div class="alert alert-danger mb-0">Não consegui exportar: ${esc(err.message)}</div>`; }
  }

  // ---------------------------------------------------------------- eventos da barra
  el.querySelector('.daw-bar').addEventListener('change', async (e) => {
    const k = e.target.dataset.p, a = e.target.dataset.a;
    if (a === 'importaudio' && e.target.files[0]) { await importAudio(e.target.files[0]); e.target.value = ''; return; }
    if (a === 'pimport' && e.target.files[0]) {
      try { const q = await importProjectFile(await e.target.files[0].text()); await openProject(fixProject(q)); toast('Projeto aberto.', 'success'); } catch (err) { toast(err.message || 'Arquivo inválido.', 'danger'); }
      e.target.value = ''; return;
    }
    if (!k) return;
    if (k === 'bpm') { const v = clamp(Math.round(Number(e.target.value) || 120), 30, 300); const was = engine.playing; if (was) engine.stop(false); await change(() => { p.bpm = v; }, { structure: false }); if (was) engine.play(engine.position); }
    if (k === 'sig') await change(() => { p.sig = Number(e.target.value); }, { structure: false });
    if (k === 'metro' || k === 'countIn') await change(() => { p[k] = e.target.checked; }, { structure: false });
    if (k === 'loop') await change(() => { p.loop.on = e.target.checked; if (p.loop.end <= p.loop.start) p.loop = { on: p.loop.on, start: 0, end: p.sig * 4 }; }, { structure: false });
    if (k === 'snap') { const v = e.target.value; p.snapBar = v === 'bar'; p.snap = v === 'bar' ? p.sig : Number(v); persist(); tl.draw(); pr?.draw(); }
  });
  el.querySelector('.daw-bar').addEventListener('click', async (e) => {
    const a = e.target.closest('button[data-a]')?.dataset.a;
    if (a) await action(a);
  });
  R('heads').addEventListener('click', (e) => { const a = e.target.closest('button[data-a]')?.dataset.a; if (a) action(a); });
  paneEl.addEventListener('click', (e) => { const a = e.target.closest('button[data-a]')?.dataset.a; if (a) action(a); });
  async function action(a) {
    if (a === 'play') return togglePlay();
    if (a === 'rec') return toggleRecord();
    if (a === 'home') { engine.seek(p.loop.on ? p.loop.start : 0); R('tl').scrollLeft = 0; tl.draw(); showPos(); return; }
    if (a === 'undo') return undo();
    if (a === 'redo') return redo();
    if (a === 'zin') return zoomTo(p.zoom * 1.4);
    if (a === 'zout') return zoomTo(p.zoom / 1.4);
    if (a === 'add-pm') return addTrack('pm');
    if (a === 'add-audio') return addTrack('audio');
    if (a === 'add-inst') return addTrack('inst');
    if (a === 'split') return splitClip();
    if (a === 'dupclip') return dupClip();
    if (a === 'delclip') return delClip();
    if (a === 'settings') return settingsDialog();
    if (a === 'wav') return exportWav(false);
    if (a === 'wavloop') return exportWav(true);
    if (a === 'open') return projectsDialog();
    if (a === 'new') { await saveProject(p); const q = demoProject(); await saveProject(q); return openProject(q); }
    if (a === 'dup') { const q = { ...structuredClone(p), id: uid(), name: p.name + ' (cópia)', created: Date.now() }; await saveProject(q); await openProject(q); toast('Projeto duplicado.', 'success'); return; }
    if (a === 'rename') { const n = await promptBox('Nome do projeto', p.name, { ok: 'Renomear' }); if (n?.trim()) { await change(() => { p.name = n.trim().slice(0, 80); }, { structure: false }); } return; }
    if (a === 'pfile') { download(`${p.name}.estudio.json`, await exportProjectFile(p), 'application/json'); return; }
    if (a === 'delproj') {
      if (!(await confirmBox(`Apagar o projeto "${p.name}" e suas gravações? Não dá para desfazer.`, { ok: 'Apagar', danger: true }))) return;
      const id = p.id; engine.stop(false);
      await deleteProject(id);
      const rest = await listProjects();
      const q = rest[0] ? await loadProject(rest[0].id) : demoProject();
      if (!rest[0]) await saveProject(q);
      await openProject(fixProject(q));
    }
  }

  // ---------------------------------------------------------------- atalhos
  const onKey = (e) => {
    if (/input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable || document.querySelector('.modal.show')) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (focus === 'pr' && pr && pr.key(e)) { e.preventDefault(); return; }
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 'd') { e.preventDefault(); dupClip(); return; }
    if (!mod && k === 'r' && !e.repeat) { e.preventDefault(); toggleRecord(); return; }
    if (e.key === 'Home') { e.preventDefault(); action('home'); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && clip()) { e.preventDefault(); delClip(); }
  };
  window.addEventListener('keydown', onKey);
  R('tl').addEventListener('pointerdown', () => { focus = 'tl'; });

  // ---------------------------------------------------------------- animação: cursor e medidores
  const showPos = () => { const b = engine.position; R('pos').textContent = `${fmtPos(p, b)} · ${fmtTime(Math.max(0, b) * spb(p))}`; };
  let wasPlaying = false;
  function frame() {
    if (destroyed) return;
    if (engine.playing) { tl.follow(); tl.draw(); pr?.draw(); showPos(); }
    else if (wasPlaying) { tl.draw(); pr?.draw(); showPos(); updateTransport(); }
    wasPlaying = engine.playing;
    for (const m of el.querySelectorAll('[data-meter]')) {
      const id = m.dataset.meter, v = engine.level(id === 'master' ? null : id);
      const pct = Math.min(100, v * 100);
      if (m.parentElement.classList.contains('vmeter')) m.style.height = pct + '%'; else m.style.width = pct + '%';
      m.classList.toggle('clip', v > 0.98);
    }
    const mm = R('mmeter'); const v = engine.level(null); mm.style.width = Math.min(100, v * 100) + '%'; mm.classList.toggle('clip', v > 0.98);
    raf = requestAnimationFrame(frame);
  }

  const ready = (async () => {
    await engine.sync(p);
    hookSynths();
    renderHeads(); renderBar(); refreshPane(); showPos(); tl.layout();
    raf = requestAnimationFrame(frame);
    if (!hist.undo.length) saveProject(p).catch(() => {});
  })();

  const S = {
    ready, engine, toggleRecord,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      qk.detach(); midi?.detach();
      panel?.destroy(); pr?.destroy(); tl.destroy();
      saveProject(p).catch(() => {});
      engine.destroy();
    },
  };
  return S;
}
