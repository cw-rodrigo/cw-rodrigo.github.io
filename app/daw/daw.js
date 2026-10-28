// DAW no modelo do FL Studio: Channel Rack (sequenciador de passos e padrões), Playlist (padrões, áudio e
// automação em faixas livres), Piano roll, Mixer com efeitos e envios, modo Pattern/Song e gravação da
// Pocket Master (ou de qualquer entrada) direto na playlist. Projetos no navegador, com desfazer/refazer.
import { DawEngine } from './engine.js';
import { playlist, TH, RH } from './playlist.js';
import { pianoRoll } from './pianoroll.js';
import { channelRack } from './rack.js';
import { mixerView } from './mixer.js';
import { autoEditor } from './autoedit.js';
import { targetsOf, resolveTarget } from './automation.js';
import * as D from './project.js';
import { setLive } from '/lib/agent/live.js';
import { synthPanel } from '/lib/synth/ui.js';
import { ENGINES } from '/lib/synth/schemas.js';
import { pianoKeyboard, qwertyKeys, midiKeyboards, noteLabel } from '/lib/synth/keyboard.js';
import { audioCtx, resumeAudio } from '/lib/audio/context.js';
import { getInput, listInputs, encodeWav, captureError } from '/lib/audio/io.js';
import * as PM from '/lib/pocketmaster/session.js';
import { PEDAL_NAME, TOTAL_PRESETS } from '/lib/pocketmaster/pm.js';
import { esc, uid, toast, modal, confirmBox, promptBox, busyButton, debounce, download, clamp, progressHtml, setProgress } from '/lib/core/ui.js';

const LAST = 'daw.last';
const SNAPS = [[0, 'Livre'], ['bar', 'Compasso'], [1, '1/4'], [0.5, '1/8'], [0.25, '1/16'], [0.125, '1/32']];
const TABS = [['roll', 'Piano roll', 'bi-music-note-list'], ['mixer', 'Mixer', 'bi-sliders'], ['inst', 'Instrumento', 'bi-keyboard'], ['auto', 'Automação', 'bi-bezier2'], ['keys', 'Teclado', 'bi-grid-3x2']];

let active = null; // sessão aberta (para canLeave)

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
    let p = null;
    try { const last = localStorage.getItem(LAST); p = last ? await D.loadProject(last) : null; } catch { p = null; }
    p ||= D.newProject();
    if (!el.isConnected) return null;
    const S = session(el, audioCtx(), p);
    active = S;
    await S.ready;
    return () => { S.destroy(); if (active === S) active = null; };
  },
};

function session(el, ctx, p0) {
  let p = p0;
  const hist = new D.History();
  const ui = { ch: p.channels[0]?.id || null, clip: null, ins: p.mixer.inserts[0].id, tab: 'roll', focus: 'pl', brush: null, kbBase: 48 };
  let paneKey = '', panel = null, pr = null, kb = null, ae = null, raf = 0, destroyed = false, gesture = false;
  const synthHooked = new WeakSet();
  const engine = new DawEngine(ctx, { onStop: () => { updateTransport(); pl.draw(); } });
  const persist = debounce(() => { D.saveProject(p).catch(() => toast('Não consegui salvar o projeto no navegador.', 'danger')); }, 700);
  try { localStorage.setItem(LAST, p.id); } catch { /* ok */ }

  el.innerHTML = `
  <div class="daw">
    <div class="daw-bar d-flex flex-wrap align-items-center gap-2 mb-2">
      <div class="dropdown">
        <button class="btn btn-sm btn-outline-secondary dropdown-toggle text-truncate" style="max-width:13rem" type="button" data-bs-toggle="dropdown" aria-expanded="false" data-r="pname"></button>
        <ul class="dropdown-menu">
          <li><button class="dropdown-item" type="button" data-a="new"><i class="bi bi-file-earmark-plus"></i> Novo projeto</button></li>
          <li><button class="dropdown-item" type="button" data-a="open"><i class="bi bi-folder2-open"></i> Abrir…</button></li>
          <li><button class="dropdown-item" type="button" data-a="rename"><i class="bi bi-pencil"></i> Renomear</button></li>
          <li><button class="dropdown-item" type="button" data-a="dup"><i class="bi bi-files"></i> Duplicar projeto</button></li>
          <li><hr class="dropdown-divider"></li>
          <li><button class="dropdown-item" type="button" data-a="settings"><i class="bi bi-sliders"></i> Gravação e latência…</button></li>
          <li><hr class="dropdown-divider"></li>
          <li><button class="dropdown-item" type="button" data-a="wav"><i class="bi bi-filetype-wav"></i> Exportar a música (WAV)</button></li>
          <li><button class="dropdown-item" type="button" data-a="wavpat"><i class="bi bi-grid-3x3-gap"></i> Exportar o padrão atual (WAV)</button></li>
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
      <div class="btn-group btn-group-sm daw-mode" role="group" aria-label="Modo (L troca)">
        <input type="radio" class="btn-check" name="daw-mode" id="daw-pat" value="pattern" autocomplete="off"><label class="btn btn-outline-warning" for="daw-pat" title="Toca só o padrão atual, em loop (L)">PAT</label>
        <input type="radio" class="btn-check" name="daw-mode" id="daw-song" value="song" autocomplete="off"><label class="btn btn-outline-success" for="daw-song" title="Toca a playlist (L)">SONG</label>
      </div>
      <div class="btn-group" role="group" aria-label="Transporte">
        <button class="btn btn-outline-secondary" type="button" data-a="home" title="Voltar ao início (Home)"><i class="bi bi-skip-start-fill"></i><span class="visually-hidden">Início</span></button>
        <button class="btn btn-outline-success" type="button" data-a="play" title="Tocar / parar (Espaço)"><i class="bi bi-play-fill"></i><span class="visually-hidden">Tocar</span></button>
        <button class="btn btn-outline-danger" type="button" data-a="rec" title="Gravar (R)"><i class="bi bi-record-fill"></i><span class="visually-hidden">Gravar</span></button>
        <div class="btn-group" role="group">
          <button class="btn btn-outline-danger dropdown-toggle dropdown-toggle-split" type="button" data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-expanded="false" data-r="recsrc" title="De onde gravar"><span class="small" data-r="srcname"></span></button>
          <div class="dropdown-menu p-3 rec-menu" data-r="recmenu"></div>
        </div>
      </div>
      <div class="daw-pos font-monospace small border rounded px-2 py-1 text-center" data-r="pos">1.1.00 · 0:00.0</div>
      <div class="input-group input-group-sm" style="width:auto">
        <input type="number" class="form-control" style="width:4.6rem" min="30" max="300" step="1" data-p="bpm" aria-label="Andamento (BPM)">
        <span class="input-group-text">BPM</span>
        <select class="form-select" style="width:5.2rem" data-p="sig" aria-label="Compasso">${[2, 3, 4, 5, 6, 7].map((n) => `<option value="${n}">${n}/4</option>`).join('')}</select>
      </div>
      <div class="btn-group btn-group-sm" role="group" aria-label="Opções">
        <input type="checkbox" class="btn-check" id="daw-metro" data-p="metro" autocomplete="off"><label class="btn btn-outline-secondary" for="daw-metro" title="Metrônomo"><i class="bi bi-stopwatch"></i><span class="visually-hidden">Metrônomo</span></label>
        <input type="checkbox" class="btn-check" id="daw-loop" data-p="loop" autocomplete="off"><label class="btn btn-outline-secondary" for="daw-loop" title="Loop na playlist (arraste na metade de cima da régua)"><i class="bi bi-arrow-repeat"></i><span class="visually-hidden">Loop</span></label>
      </div>
      <select class="form-select form-select-sm" style="width:auto" data-p="snap" aria-label="Grade">${SNAPS.map(([v, l]) => `<option value="${v}">Grade ${l}</option>`).join('')}</select>
      <div class="btn-group btn-group-sm" role="group" aria-label="Zoom">
        <button class="btn btn-outline-secondary" type="button" data-a="zout" title="Afastar"><i class="bi bi-zoom-out"></i><span class="visually-hidden">Afastar</span></button>
        <button class="btn btn-outline-secondary" type="button" data-a="zin" title="Aproximar"><i class="bi bi-zoom-in"></i><span class="visually-hidden">Aproximar</span></button>
      </div>
      <div class="ms-auto d-flex align-items-center gap-1 small" title="Nível da saída"><i class="bi bi-volume-up"></i><div class="daw-meter" style="width:80px;height:8px"><div data-meter="master"></div></div></div>
    </div>
    <div class="daw-main">
      <section class="daw-rack border rounded p-2" aria-label="Channel Rack" data-r="rack"></section>
      <section class="daw-pl border rounded" aria-label="Playlist">
        <div class="pl-bar d-flex flex-wrap align-items-center gap-2 px-2 py-1 border-bottom small">
          <strong>Playlist</strong>
          <span class="text-body-secondary" data-r="brush"></span>
          <div class="dropdown ms-auto">
            <button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false"><i class="bi bi-plus-lg"></i> Clipe</button>
            <ul class="dropdown-menu dropdown-menu-end">
              <li><button class="dropdown-item" type="button" data-a="auto"><i class="bi bi-bezier2"></i> Automação…</button></li>
              <li><label class="dropdown-item mb-0" role="button"><i class="bi bi-file-earmark-music"></i> Áudio de um arquivo…<input type="file" accept="audio/*,video/*" data-a="importaudio" hidden></label></li>
              <li><button class="dropdown-item" type="button" data-a="addtrack"><i class="bi bi-plus-square"></i> Faixa nova</button></li>
            </ul>
          </div>
          <div class="btn-group btn-group-sm" role="group" aria-label="Clipe selecionado">
            <button class="btn btn-outline-secondary" type="button" data-a="split" title="Dividir o clipe no cursor"><i class="bi bi-scissors"></i><span class="visually-hidden">Dividir</span></button>
            <button class="btn btn-outline-secondary" type="button" data-a="dupclip" title="Duplicar clipe (Ctrl+D)"><i class="bi bi-copy"></i><span class="visually-hidden">Duplicar clipe</span></button>
            <button class="btn btn-outline-secondary" type="button" data-a="delclip" title="Apagar clipe (Delete)"><i class="bi bi-trash"></i><span class="visually-hidden">Apagar clipe</span></button>
          </div>
        </div>
        <div class="daw-arrange">
          <div class="daw-heads" data-r="heads"></div>
          <div class="daw-tl" data-r="tl"></div>
        </div>
      </section>
    </div>
    <ul class="nav nav-tabs mt-2" role="tablist">${TABS.map(([k, l, i]) => `<li class="nav-item"><button class="nav-link" type="button" data-tab="${k}"><i class="bi ${i}"></i> ${l}</button></li>`).join('')}</ul>
    <div class="daw-pane border border-top-0 rounded-bottom p-2 p-md-3" data-r="pane"></div>
    <details class="small text-body-secondary mt-2"><summary>Como usar (parecido com o FL Studio)</summary>
      <p class="mt-2 mb-1"><strong>Channel Rack:</strong> cada canal é um instrumento; clique nos passos para montar a batida do padrão. Notas livres e acordes vão no piano roll (botão de notas do canal). Cada canal manda o som para um insert do mixer.</p>
      <p class="mb-1"><strong>Playlist:</strong> no modo SONG, clique num espaço vazio para pintar o padrão atual (ou o último clipe escolhido); arraste para mover, puxe as bordas, Shift+arrastar duplica, botão direito apaga, Alt desliga a grade. Duplo clique abre o clipe.</p>
      <p class="mb-1"><strong>Gravar a Pocket Master:</strong> ligue-a no computador pelo USB-C e aperte o botão vermelho de gravar (ou R). O áudio entra na playlist, onde está o cursor. Na setinha ao lado do botão dá para trocar a fonte (microfone, outra entrada ou só notas) e conferir o nível.</p>
      <p class="mb-0"><strong>Atalhos:</strong> Espaço toca/para · R grava · L troca PAT/SONG · Ctrl+Z desfaz · Delete apaga o clipe · teclado do computador (A W S E D…) toca o canal selecionado.</p>
    </details>
  </div>`;

  const R = (n) => el.querySelector(`[data-r="${n}"]`);
  const chan = (id = ui.ch) => D.channelOf(p, id);
  const clip = () => p.playlist.clips.find((c) => c.id === ui.clip) || null;

  // ---------------------------------------------------------------- mudanças e desfazer
  function begin() { hist.push(p); }
  function cancel() { hist.undo.pop(); }
  async function end({ structure = true } = {}) {
    persist();
    if (structure) { await engine.sync(p); hookSynths(); } else engine.mix(p);
    refresh();
  }
  async function change(fn, opts) { begin(); await fn(); await end(opts); }
  const live = () => engine.mix(p);
  async function replaceProject(q, { keepSynths = true } = {}) {
    if (keepSynths) for (const c of q.channels) { const cur = D.channelOf(p, c.id); if (cur) c.synth = cur.synth; } // o som do instrumento fica fora do desfazer
    p = D.upgrade(q);
    if (!chan()) ui.ch = p.channels[0]?.id || null;
    if (!clip()) ui.clip = null;
    if (!D.insertOf(p, ui.ins)) ui.ins = p.mixer.inserts[0].id;
    persist();
    await engine.sync(p);
    hookSynths();
    paneKey = '';
    refresh();
  }
  async function undo() { const q = hist.back(p); if (q) await replaceProject(q); }
  async function redo() { const q = hist.fwd(p); if (q) await replaceProject(q); }
  function refresh() { renderBar(); rack.render(); renderHeads(); pl.layout(); refreshPane(); }

  // o painel do sintetizador muda o instrumento direto: copia o estado para o canal
  function hookSynths() {
    for (const ch of p.channels) {
      const syn = engine.synthOf(ch.id);
      if (!syn || synthHooked.has(syn)) continue;
      synthHooked.add(syn);
      const id = ch.id;
      syn.on(async (st) => {
        const c = D.channelOf(p, id);
        if (!c) return;
        c.synth = { engine: st.engine, params: structuredClone(st.params), fx: structuredClone(st.fx), source: st.source ? { ...st.source } : null };
        if (st.source?.kind === 'sample' && !st.source.audioId && syn.zones[0]?.user && !syn.saving) {
          syn.saving = true;
          const z = syn.zones[0];
          try { st.source.audioId = await D.saveAudio(z.R ? [z.L, z.R] : [z.L], z.sr, st.source.name || 'amostra'); c.synth.source = { ...st.source }; } finally { syn.saving = false; }
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
    el.querySelector('[data-p="loop"]').checked = p.loop.on;
    el.querySelector('[data-p="snap"]').value = p.snapBar ? 'bar' : String(p.snap);
    el.querySelector(`#daw-${p.mode === 'song' ? 'song' : 'pat'}`).checked = true;
    el.querySelector('[data-a="undo"]').disabled = !hist.undo.length;
    el.querySelector('[data-a="redo"]').disabled = !hist.redo.length;
    for (const a of ['split', 'dupclip', 'delclip']) el.querySelector(`[data-a="${a}"]`).disabled = !clip();
    const b = brush();
    R('brush').textContent = b ? `Pincel: ${b.kind === 'pattern' ? D.patternOf(p, b.pattern)?.name : b.kind === 'audio' ? b.name || 'áudio' : 'automação'}` : '';
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

  // ---------------------------------------------------------------- Channel Rack
  const rack = channelRack(R('rack'), {
    project: () => p, selected: () => ui.ch,
    select: (id) => { ui.ch = id; ui.focus = 'rack'; rack.render(); paneKey = ''; refreshPane(); },
    begin, end, cancel, change, live,
    openRoll: (id) => { ui.ch = id; ui.tab = 'roll'; rack.render(); paneKey = ''; refreshPane(); },
    openSettings: (id) => { ui.ch = id; ui.tab = 'inst'; rack.render(); paneKey = ''; refreshPane(); },
    preview: (id) => { const ch = chan(id); const s = engine.synthOf(id); if (ch && s) { resumeAudio(); s.noteOn(ch.stepNote, 100); setTimeout(() => s.noteOff(ch.stepNote), 150); } },
    patternMenu, channelMenu, addChannel,
  });
  async function patternMenu(a, id) {
    const pat = D.curPattern(p);
    if (a === 'select') { p.curPattern = id; ui.brush = null; persist(); engine.restart(); refresh(); return; }
    if (a === 'new') await change(() => { const n = D.newPattern(p); p.patterns.push(n); p.curPattern = n.id; ui.brush = null; }, { structure: false });
    if (a === 'clone') await change(() => { const n = { ...structuredClone(pat), id: uid(), name: pat.name + ' (cópia)' }; p.patterns.push(n); p.curPattern = n.id; ui.brush = null; }, { structure: false });
    if (a === 'rename') { const n = await promptBox('Nome do padrão', pat.name, { ok: 'Renomear' }); if (n?.trim()) await change(() => { pat.name = n.trim(); }, { structure: false }); }
    if (a === 'delete') {
      if (p.patterns.length < 2) { toast('O projeto precisa de pelo menos um padrão.'); return; }
      const used = p.playlist.clips.filter((c) => c.pattern === pat.id).length;
      if (!(await confirmBox(`Apagar “${pat.name}”${used ? ` e os ${used} clipe(s) dele na playlist` : ''}?`, { ok: 'Apagar', danger: true }))) return;
      await change(() => { p.patterns = p.patterns.filter((x) => x !== pat); p.playlist.clips = p.playlist.clips.filter((c) => c.pattern !== pat.id); p.curPattern = p.patterns[0].id; ui.brush = null; }, { structure: false });
    }
    engine.restart();
  }
  async function channelMenu(a, id) {
    const ch = chan(id), i = p.channels.indexOf(ch);
    if (a === 'settings') { ui.ch = id; ui.tab = 'inst'; paneKey = ''; refresh(); }
    if (a === 'rename') { const n = await promptBox('Nome do canal', ch.name, { ok: 'Renomear' }); if (n?.trim()) await change(() => { ch.name = n.trim().slice(0, 40); }, { structure: false }); }
    if (a === 'clear') await change(() => { delete D.curPattern(p).notes[ch.id]; }, { structure: false });
    if ((a === 'up' && i > 0) || (a === 'down' && i < p.channels.length - 1)) await change(() => { const j = a === 'up' ? i - 1 : i + 1; [p.channels[i], p.channels[j]] = [p.channels[j], p.channels[i]]; }, { structure: false });
    if (a === 'clone') {
      await change(() => {
        const c = D.newChannel(p, ch.name + ' (cópia)', structuredClone(ch.synth), { stepNote: ch.stepNote, vol: ch.vol, pan: ch.pan });
        p.channels.splice(i + 1, 0, c);
        for (const pat of p.patterns) if (pat.notes[ch.id]) pat.notes[c.id] = structuredClone(pat.notes[ch.id]);
        ui.ch = c.id;
      });
    }
    if (a === 'delete') {
      if (!(await confirmBox(`Apagar o canal “${ch.name}” e as notas dele em todos os padrões?`, { ok: 'Apagar', danger: true }))) return;
      await change(() => {
        p.channels.splice(i, 1);
        for (const pat of p.patterns) delete pat.notes[ch.id];
        // o insert criado para ele sai junto se ninguém mais usa
        const ins = D.insertOf(p, ch.insert);
        if (ins && ins !== p.mixer.inserts[0] && ins.id !== p.rec.insert && !p.channels.some((c) => c.insert === ins.id) && !p.playlist.clips.some((c) => c.insert === ins.id)) {
          p.mixer.inserts = p.mixer.inserts.filter((x) => x !== ins);
          for (const x of p.mixer.inserts) x.sends = x.sends.filter((s) => s.to !== ins.id);
        }
        ui.ch = p.channels[Math.min(i, p.channels.length - 1)]?.id || null;
      });
    }
  }
  async function addChannel(kind) {
    await change(() => {
      let ch;
      if (kind.startsWith('drum:')) { const [, note, name] = kind.split(':'); ch = D.newChannel(p, name, { engine: 'drums', params: {} }, { stepNote: Number(note) }); }
      else { const engine = kind.split(':')[1]; ch = D.newChannel(p, ENGINES[engine].name, { engine, params: {} }, { stepNote: 60 }); }
      p.channels.push(ch); ui.ch = ch.id;
    });
  }

  // ---------------------------------------------------------------- playlist
  const brush = () => {
    if (ui.brush && (ui.brush.kind !== 'pattern' || D.patternOf(p, ui.brush.pattern))) return ui.brush;
    const pat = D.curPattern(p);
    return pat ? { kind: 'pattern', pattern: pat.id } : null;
  };
  const pl = playlist(R('tl'), {
    project: () => p,
    position: () => (p.mode === 'song' ? engine.position : 0),
    recordingFrom: () => (engine.recording ? engine.recording.fromBeat : null),
    selection: () => clip(),
    select: (c) => {
      ui.clip = c?.id || null; ui.focus = 'pl';
      if (c) { ui.brush = c.kind === 'pattern' ? { kind: 'pattern', pattern: c.pattern } : { ...structuredClone(c), id: null }; if (c.kind === 'pattern') p.curPattern = c.pattern; }
      renderBar(); rack.render(); pl.draw(); paneKey = ''; refreshPane();
    },
    seek: (b) => { engine.seek(b); pl.draw(); showPos(); },
    begin, cancel, end: () => end({ structure: false }),
    remove: (c) => { p.playlist.clips = p.playlist.clips.filter((x) => x !== c); if (ui.clip === c.id) ui.clip = null; },
    place: (track, beat) => {
      const b = brush();
      if (!b) return null;
      if (p.mode !== 'song') { p.mode = 'song'; engine.restart(); }
      let c;
      if (b.kind === 'pattern') c = { id: uid(), kind: 'pattern', track: track.id, start: beat, len: D.patternLength(p, D.patternOf(p, b.pattern)), pattern: b.pattern };
      else c = { ...structuredClone(b), id: uid(), track: track.id, start: beat };
      p.playlist.clips.push(c);
      return c;
    },
    open: (c) => {
      ui.clip = c.id;
      if (c.kind === 'pattern') { p.curPattern = c.pattern; ui.tab = 'roll'; }
      else if (c.kind === 'auto') ui.tab = 'auto';
      else ui.tab = 'inst';
      paneKey = ''; refresh();
    },
    zoom: (f, beat, x) => zoomTo(p.zoom * f, beat, x),
  });
  function zoomTo(z, beat = engine.position, x = R('tl').clientWidth / 2) {
    p.zoom = clamp(z, 4, 240);
    pl.layout();
    R('tl').scrollLeft = Math.max(0, beat * p.zoom - x);
    pl.draw(); persist();
  }
  function renderHeads() {
    R('heads').innerHTML = `<div class="daw-ruler-cell" style="height:${RH}px"></div>` + p.playlist.tracks.map((t) => `
      <div class="pl-head${t.mute ? ' muted' : ''}" data-t="${t.id}" style="height:${TH}px">
        <button class="rack-led${t.mute ? '' : ' on'}" type="button" data-h="mute" title="${t.mute ? 'Ligar' : 'Silenciar'} a faixa" aria-pressed="${!t.mute}"><span class="visually-hidden">Mudo</span></button>
        <span class="text-truncate small" data-h="name" title="Duplo clique: renomear">${esc(t.name)}</span>
      </div>`).join('');
  }
  R('heads').addEventListener('click', (e) => {
    const t = p.playlist.tracks.find((x) => x.id === e.target.closest('[data-t]')?.dataset.t);
    if (t && e.target.closest('[data-h="mute"]')) change(() => { t.mute = !t.mute; }, { structure: false });
  });
  R('heads').addEventListener('dblclick', async (e) => {
    const t = p.playlist.tracks.find((x) => x.id === e.target.closest('[data-t]')?.dataset.t);
    if (!t) return;
    const n = await promptBox('Nome da faixa', t.name, { ok: 'Renomear' });
    if (n?.trim()) change(() => { t.name = n.trim().slice(0, 30); }, { structure: false });
  });

  // ---------------------------------------------------------------- painel de baixo
  function refreshPane() {
    el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
    const c = clip();
    const key = `${ui.tab}|${ui.ch}|${chan()?.synth.engine}|${p.curPattern}|${ui.tab === 'auto' || ui.tab === 'inst' ? c?.id : ''}|${p.channels.length}|${p.mixer.inserts.length}`;
    if (key === paneKey) { light(); return; }
    paneKey = key;
    panel?.destroy(); panel = null; pr?.destroy(); pr = null; ae?.destroy(); ae = null; kb = null;
    const pane = R('pane');
    if (ui.tab === 'roll') renderRoll(pane);
    else if (ui.tab === 'mixer') { pane.replaceChildren(mixHost); mixer.render(); }
    else if (ui.tab === 'inst') renderInst(pane);
    else if (ui.tab === 'auto') renderAuto(pane);
    else renderKeys(pane);
  }
  function light() {
    if (ui.tab === 'roll') pr?.show(true);
    if (ui.tab === 'mixer') mixer.render();
    if (ui.tab === 'auto') ae?.render();
  }
  el.querySelector('.nav-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { ui.tab = b.dataset.tab; refreshPane(); } });

  function renderRoll(pane) {
    if (!chan()) { pane.innerHTML = '<p class="text-body-secondary mb-0">Escolha um canal no Channel Rack.</p>'; return; }
    pane.innerHTML = '<div data-r="pr"></div>';
    pr = pianoRoll(pane.firstElementChild, {
      project: () => p, pattern: () => D.curPattern(p), channel: () => chan(),
      begin, cancel, end: () => end({ structure: false }),
      preview: (n, v) => { resumeAudio(); const s = engine.synthOf(ui.ch); if (s) { s.noteOn(n, v); setTimeout(() => s.noteOff(n), 220); } },
      position: () => patternPos(),
    });
    pr.show();
    pane.firstElementChild.addEventListener('pointerdown', () => { ui.focus = 'roll'; });
  }
  /** Onde o padrão atual está tocando (em batidas dentro dele), ou null. */
  function patternPos() {
    if (!engine.playing) return null;
    const pos = engine.position, pat = D.curPattern(p);
    if (p.mode === 'pattern') return pos;
    const c = p.playlist.clips.find((x) => x.pattern === pat.id && pos >= x.start && pos < D.clipEnd(p, x));
    return c ? (pos - c.start) % D.patternLength(p, pat) : null;
  }

  function renderInst(pane) {
    const c = clip();
    if (c && c.kind === 'audio') { renderAudioClip(pane, c); return; }
    const ch = chan();
    if (!ch) { pane.innerHTML = '<p class="text-body-secondary mb-0">Escolha um canal no Channel Rack.</p>'; return; }
    const notes = Array.from({ length: 61 }, (_, i) => 24 + i);
    pane.innerHTML = `<div class="row g-2 align-items-end mb-3">
        <div class="col-sm-4 col-lg-3"><label class="form-label small mb-0" for="ch-name">Canal</label><input class="form-control form-control-sm" id="ch-name" data-c="name" value="${esc(ch.name)}"></div>
        <div class="col-auto"><label class="form-label small mb-0" for="ch-step">Nota dos passos</label><select class="form-select form-select-sm" id="ch-step" data-c="stepNote">${notes.map((n) => `<option value="${n}"${n === ch.stepNote ? ' selected' : ''}>${noteLabel(n)}</option>`).join('')}</select></div>
        <div class="col-auto"><label class="form-label small mb-0" for="ch-ins">Insert do mixer</label><select class="form-select form-select-sm" id="ch-ins" data-c="insert">${p.mixer.inserts.map((i, k) => `<option value="${i.id}"${i.id === ch.insert ? ' selected' : ''}>${k === 0 ? 'Master' : `${k} · ${esc(i.name)}`}</option>`).join('')}</select></div>
      </div><div data-r="synth"></div>`;
    const syn = engine.synthOf(ch.id);
    if (syn) panel = synthPanel(pane.querySelector('[data-r="synth"]'), syn, {});
  }
  function renderAudioClip(pane, c) {
    const a = D.cachedAudio(c.audioId);
    pane.innerHTML = `<div class="row g-2 align-items-end">
      <div class="col-sm-4"><label class="form-label small mb-0" for="ac-name">Clipe de áudio</label><input class="form-control form-control-sm" id="ac-name" data-cl="name" value="${esc(c.name || '')}"></div>
      <div class="col-sm-3"><label class="form-label small mb-0 d-flex justify-content-between" for="ac-gain"><span>Ganho</span><output>${(c.gain || 0).toFixed(1)} dB</output></label><input type="range" class="form-range" id="ac-gain" data-cl="gain" min="-24" max="12" step="0.5" value="${c.gain || 0}"></div>
      <div class="col-sm-3"><label class="form-label small mb-0" for="ac-ins">Insert do mixer</label><select class="form-select form-select-sm" id="ac-ins" data-cl="insert">${p.mixer.inserts.map((i, k) => `<option value="${i.id}"${i.id === c.insert ? ' selected' : ''}>${k === 0 ? 'Master' : `${k} · ${esc(i.name)}`}</option>`).join('')}</select></div>
      <div class="col-sm-2 small text-body-secondary">${D.fmtTime(c.dur)}${a ? ` · ${a.channels.length === 1 ? 'mono' : 'estéreo'}` : ''}</div>
      <div class="col-12 d-flex flex-wrap gap-2">
        <button class="btn btn-sm btn-outline-secondary" type="button" data-a="split"><i class="bi bi-scissors"></i> Dividir no cursor</button>
        <button class="btn btn-sm btn-outline-secondary" type="button" data-cl="wav"><i class="bi bi-download"></i> Baixar este clipe (WAV)</button>
        <button class="btn btn-sm btn-outline-secondary" type="button" data-cl="sample"><i class="bi bi-vinyl"></i> Usar como amostra num canal novo</button>
        <button class="btn btn-sm btn-outline-danger" type="button" data-a="delclip"><i class="bi bi-trash"></i> Apagar</button>
      </div></div>`;
  }
  function renderAuto(pane) {
    pane.innerHTML = '<div></div>';
    ae = autoEditor(pane.firstElementChild, { project: () => p, clip: () => (clip()?.kind === 'auto' ? clip() : null), begin, cancel, end: () => end({ structure: false }), change: (fn) => change(fn, { structure: false }) });
    ae.render();
  }

  // mixer
  const mixHost = document.createElement('div'); // o mixer guarda seus elementos (e eventos) entre as abas
  const mixer = mixerView(mixHost, {
    project: () => p, selected: () => ui.ins, select: (id) => { ui.ins = id; mixer.render(); },
    begin, end, change, live,
    add: () => change(() => { const ins = D.newInsert(p); p.mixer.inserts.push(ins); ui.ins = ins.id; }),
    remove: async (id) => {
      const ins = D.insertOf(p, id);
      if (!(await confirmBox(`Apagar o insert “${ins.name}”? O que mandava para ele passa a ir para o master.`, { ok: 'Apagar', danger: true }))) return;
      await engine.setMonitor(id, null);
      change(() => {
        p.mixer.inserts = p.mixer.inserts.filter((x) => x !== ins);
        for (const x of p.mixer.inserts) x.sends = x.sends.filter((s) => s.to !== id);
        for (const c of p.channels) if (c.insert === id) c.insert = p.mixer.inserts[0].id;
        for (const c of p.playlist.clips) if (c.insert === id) c.insert = p.mixer.inserts[0].id;
        ui.ins = p.mixer.inserts[0].id;
      });
    },
  });

  // ---------------------------------------------------------------- de onde gravar (um lugar só, ao lado do botão)
  const recState = { inputs: [], stream: null, an: null, raf: 0 };
  const SRC_NAMES = { pocket: 'Pocket Master', default: 'Microfone', notes: 'Só notas' };
  const srcName = () => SRC_NAMES[p.rec.source] || recState.inputs.find((d) => d.deviceId === p.rec.source)?.label || 'Entrada';
  async function loadInputs(ask = false) {
    try {
      let list = await listInputs();
      if (ask && !list.some((d) => d.label)) { const s = await getInput(); s.getTracks().forEach((t) => t.stop()); list = await listInputs(); }
      recState.inputs = list.filter((d) => d.label && d.deviceId && d.deviceId !== 'default');
    } catch { recState.inputs = []; }
  }
  /** Entrada para gravar: { deviceId, channel } (null = só notas). A Pocket Master é achada pelo nome. */
  async function recInput() {
    const r = p.rec;
    if (r.source === 'notes') return null;
    if (r.source === 'pocket') {
      await loadInputs(true);
      const d = recState.inputs.find((x) => PEDAL_NAME.test(x.label));
      if (!d) toast('Não achei a Pocket Master entre as entradas de áudio (ela precisa estar ligada no USB). Gravando do microfone.', 'warning');
      return { deviceId: d?.deviceId || '', channel: r.channel };
    }
    return { deviceId: r.source === 'default' ? '' : r.source, channel: r.channel };
  }
  /** Insert por onde a gravação passa (criado na primeira vez). */
  function recInsert() {
    let ins = D.insertOf(p, p.rec.insert) || p.mixer.inserts.find((i) => i.name === 'Gravações');
    if (!ins) { ins = D.newInsert(p, 'Gravações'); p.mixer.inserts.push(ins); }
    p.rec.insert = ins.id;
    return ins;
  }
  function renderRecMenu() {
    const r = p.rec, dev = PM.device();
    const opt = (v, l) => `<option value="${esc(v)}"${r.source === v ? ' selected' : ''}>${esc(l)}</option>`;
    R('recmenu').innerHTML = `
      <label class="form-label small mb-0" for="rec-src">Gravar de</label>
      <select class="form-select form-select-sm mb-2" id="rec-src" data-rec="source">
        ${opt('pocket', 'Pocket Master (entrada USB)')}${opt('default', 'Microfone padrão')}
        ${recState.inputs.map((d) => opt(d.deviceId, d.label)).join('')}
        ${opt('notes', 'Só as notas do teclado')}
      </select>
      ${r.source === 'notes' ? '' : `<div class="d-flex align-items-center gap-2 mb-2 small"><span>Nível</span><div class="daw-meter flex-grow-1" style="height:8px"><div data-r="reclvl"></div></div></div>
      <div class="row g-2 mb-2"><div class="col-7"><select class="form-select form-select-sm" data-rec="channel" aria-label="Canais">${[['stereo', 'Estéreo'], ['left', 'Só o esquerdo'], ['right', 'Só o direito']].map(([v, l]) => `<option value="${v}"${r.channel === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="col-5 d-flex align-items-center"><div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" role="switch" id="rec-mon" data-rec="monitor"${r.monitor ? ' checked' : ''}><label class="form-check-label small" for="rec-mon">Ouvir</label></div></div></div>`}
      <div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" role="switch" id="rec-count" data-rec="countIn"${p.countIn ? ' checked' : ''}><label class="form-check-label small" for="rec-count">Contar 1 compasso antes</label></div>
      ${r.source === 'pocket' ? (dev ? `<label class="form-label small mb-0" for="rec-pm">Preset da pedaleira ao gravar</label><select class="form-select form-select-sm" id="rec-pm" data-rec="pmSlot"><option value="">Não trocar</option>${Array.from({ length: TOTAL_PRESETS }, (_, i) => `<option value="${i}"${r.pmSlot === i ? ' selected' : ''}>${PM.slotLabel(i)} ${esc(dev.names?.[i] || '')}</option>`).join('')}</select>`
    : '<p class="small text-body-secondary mb-1">Ligue a pedaleira no computador com cabo USB-C: o som dela entra como uma placa de som.</p><button class="btn btn-sm btn-link px-0" type="button" data-rec="connect">Conectar o controle dela (para trocar o preset ao gravar)</button>') : ''}
      <p class="small text-body-secondary mt-2 mb-0">O que tocar no teclado durante a gravação vira notas do canal selecionado.</p>`;
    R('srcname').textContent = srcName();
  }
  /** Medidor da entrada enquanto o menu está aberto (para conferir se o som está chegando). */
  async function startLevel() {
    stopLevel();
    const input = p.rec.source === 'notes' ? null : await recInput().catch(() => null);
    if (!input) return;
    try {
      recState.stream = await getInput(input.deviceId || null);
      const src = ctx.createMediaStreamSource(recState.stream);
      recState.an = ctx.createAnalyser(); recState.an.fftSize = 1024;
      src.connect(recState.an);
      const buf = new Float32Array(1024);
      const tick = () => {
        recState.an.getFloatTimeDomainData(buf);
        let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v));
        const m = R('recmenu').querySelector('[data-r="reclvl"]');
        if (m) { m.style.width = Math.min(100, pk * 100) + '%'; m.classList.toggle('clip', pk > 0.98); }
        recState.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) { toast(captureError(err, 'a entrada de áudio'), 'danger'); }
  }
  function stopLevel() { cancelAnimationFrame(recState.raf); recState.stream?.getTracks().forEach((t) => t.stop()); recState.stream = null; recState.an = null; }
  async function applyMonitor() {
    try { await engine.setMonitor(recInsert().id, p.rec.monitor && p.rec.source !== 'notes' ? await recInput() : null); } catch (err) { toast(captureError(err, 'a entrada de áudio'), 'danger'); }
  }
  const recDrop = R('recsrc').parentElement;
  recDrop.addEventListener('show.bs.dropdown', async () => { await loadInputs(); renderRecMenu(); startLevel(); });
  recDrop.addEventListener('hide.bs.dropdown', stopLevel);
  R('recmenu').addEventListener('change', async (e) => {
    const k = e.target.dataset.rec;
    if (!k) return;
    if (k === 'countIn') { p.countIn = e.target.checked; persist(); renderBar(); return; }
    if (k === 'monitor') { p.rec.monitor = e.target.checked; persist(); applyMonitor(); return; }
    if (k === 'pmSlot') { p.rec.pmSlot = e.target.value === '' ? null : Number(e.target.value); persist(); if (p.rec.pmSlot != null) PM.device()?.select(p.rec.pmSlot).catch(() => {}); return; }
    p.rec[k] = e.target.value;
    persist(); renderRecMenu(); startLevel(); applyMonitor();
  });
  R('recmenu').addEventListener('click', async (e) => {
    if (e.target.closest('[data-rec="connect"]')) {
      try { await PM.connect('usb'); renderRecMenu(); } catch (err) { toast(PM.connectError(err), 'danger'); }
    }
  });

  // campos do painel (instrumento e clipe de áudio)
  R('pane').addEventListener('input', (e) => {
    const c = clip(), k = e.target.dataset.cl;
    if (k && c) { if (!gesture) { begin(); gesture = true; } if (k === 'name') c.name = e.target.value; if (k === 'gain') { c.gain = Number(e.target.value); e.target.parentElement.querySelector('output').textContent = `${c.gain.toFixed(1)} dB`; } pl.draw(); }
    const ck = e.target.dataset.c, ch = chan();
    if (ck === 'name' && ch) { if (!gesture) { begin(); gesture = true; } ch.name = e.target.value; rack.render(); }
  });
  R('pane').addEventListener('change', (e) => {
    const k = e.target.dataset.cl, ck = e.target.dataset.c;
    if ((k === 'name' || k === 'gain' || ck === 'name') && gesture) { gesture = false; end({ structure: false }); return; }
    if (k === 'insert') { const c = clip(); change(() => { c.insert = e.target.value; }, { structure: false }); }
    if (ck === 'stepNote') { const ch = chan(), v = Number(e.target.value); change(() => { for (const pat of p.patterns) for (const n of pat.notes[ch.id] || []) if (n.p === ch.stepNote) n.p = v; ch.stepNote = v; }, { structure: false }); }
    if (ck === 'insert') { const ch = chan(); change(() => { ch.insert = e.target.value; }); }
  });
  R('pane').addEventListener('click', async (e) => {
    const k = e.target.closest('button[data-cl]')?.dataset.cl, c = clip();
    if (!k || !c) return;
    const a = D.cachedAudio(c.audioId);
    if (k === 'wav' && a) { const s = a.sampleRate, from = Math.round((c.offset || 0) * s), to = Math.round(((c.offset || 0) + c.dur) * s); download(`${c.name || 'clipe'}.wav`, encodeWav(a.channels.map((x) => x.subarray(from, to)), s)); }
    if (k === 'sample' && a) {
      const s = a.sampleRate, from = Math.round((c.offset || 0) * s), to = Math.round(((c.offset || 0) + c.dur) * s);
      const chans = a.channels.map((x) => x.slice(from, to));
      const audioId = await D.saveAudio(chans, s, c.name || 'amostra');
      await change(() => { const ch = D.newChannel(p, c.name || 'Amostra', { engine: 'sampler', params: {}, source: { kind: 'sample', name: c.name || 'amostra', audioId } }); p.channels.push(ch); ui.ch = ch.id; ui.tab = 'inst'; ui.clip = null; });
      toast('Canal criado com a amostra (nota original: C4).', 'success');
    }
  });

  // ---------------------------------------------------------------- teclado (tocar ao vivo)
  function liveOn(n, v) { if (!ui.ch) return; resumeAudio(); engine.liveOn(ui.ch, n, v); kb?.light(n, true); }
  function liveOff(n) { if (!ui.ch) return; engine.liveOff(ui.ch, n); kb?.light(n, false); }
  function renderKeys(pane) {
    const ch = chan();
    pane.innerHTML = `<div class="d-flex flex-wrap align-items-center gap-2 mb-2 small">
        <div class="btn-group btn-group-sm" role="group" aria-label="Oitava"><button class="btn btn-outline-secondary" type="button" data-k="down" aria-label="Oitava abaixo">−</button><span class="btn btn-outline-secondary disabled" data-r="oct">${noteLabel(ui.kbBase)}</span><button class="btn btn-outline-secondary" type="button" data-k="up" aria-label="Oitava acima">+</button></div>
        <span class="text-body-secondary">${ch ? `Tocando: <strong>${esc(ch.name)}</strong> (o canal selecionado)` : 'Selecione um canal.'} · Teclado do computador: A W S E D F T G Y H U J K · Z/X oitava</span>
      </div><div data-r="kb"></div>`;
    const wide = () => (window.innerWidth >= 992 ? 4 : window.innerWidth >= 576 ? 3 : 2);
    kb = pianoKeyboard(pane.querySelector('[data-r="kb"]'), { from: ui.kbBase, octaves: wide(), onOn: liveOn, onOff: liveOff });
    pane.querySelector('.btn-group').onclick = (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (!k) return;
      ui.kbBase = clamp(ui.kbBase + (k === 'up' ? 12 : -12), 12, 96); qk.state.base = ui.kbBase + 12;
      kb.setRange(ui.kbBase, wide()); pane.querySelector('[data-r="oct"]').textContent = noteLabel(ui.kbBase);
    };
  }
  const qk = qwertyKeys({ base: ui.kbBase + 12, onOn: liveOn, onOff: liveOff, onOctave: (b) => { ui.kbBase = b - 12; if (ui.tab === 'keys') { paneKey = ''; refreshPane(); } } });
  let midi = null;
  midiKeyboards({ onOn: liveOn, onOff: liveOff, onBend: (v) => engine.synthOf(ui.ch)?.bend(v), onMod: (v) => engine.synthOf(ui.ch)?.mod(v), onAllOff: () => engine.synthOf(ui.ch)?.allOff() })
    .then((m) => { if (destroyed) m.detach(); else midi = m; }).catch(() => {});

  // ---------------------------------------------------------------- transporte e gravação
  async function togglePlay() {
    await resumeAudio();
    if (engine.recording) { await toggleRecord(); return; }
    if (engine.playing) engine.stop(); else engine.play(p.mode === 'song' ? engine.position : 0);
    updateTransport();
  }
  async function toggleRecord() {
    await resumeAudio();
    if (engine.recording) {
      const btn = el.querySelector('[data-a="rec"]');
      busyButton(btn, true, '');
      let out = { audio: [], notes: [] };
      const mode = engine.recording.mode, from = engine.recording.fromBeat;
      try { out = await engine.stopRecording(); } finally { busyButton(btn, false); }
      if (out.audio.length || out.notes.length) {
        await change(() => {
          for (const a of out.audio) {
            const len = a.dur / D.spb(p);
            const t = D.freeTrack(p, a.start, a.start + len);
            const c = { id: uid(), kind: 'audio', track: t.id, start: a.start, dur: a.dur, offset: 0, audioId: a.audioId, gain: 0, insert: a.insert, name: a.name };
            p.playlist.clips.push(c); ui.clip = c.id;
          }
          if (out.notes.length) placeNotes(out.notes, mode, from);
        });
        toast([out.audio.length && `${out.audio.length} gravação(ões) de áudio na playlist`, out.notes.length && `${out.notes.length} nota(s)`].filter(Boolean).join(' e ') + '.', 'success');
      } else toast('Nada foi gravado.');
      updateTransport(); pl.draw();
      return;
    }
    try {
      const input = await recInput();
      const ins = input ? recInsert() : null;
      if (input && p.mode === 'pattern') { p.mode = 'song'; renderBar(); } // áudio vai para a playlist
      if (ins) await engine.sync(p);
      if (input && p.rec.source === 'pocket' && p.rec.pmSlot != null) await PM.device()?.select(p.rec.pmSlot).catch(() => {});
      if (engine.playing) engine.stop(false);
      await engine.record(p.mode === 'song' ? engine.position : 0, { countIn: p.countIn ? p.sig : 0, sources: input ? [{ ins, input }] : [] });
      persist();
      R('srcname').textContent = srcName();
    } catch (err) { toast(err.name ? captureError(err, 'a entrada de áudio') : err.message, 'danger'); }
    updateTransport();
  }
  /** Notas gravadas: no modo Pattern entram no padrão atual; no Song viram um padrão novo na playlist. */
  function placeNotes(notes, mode, from) {
    const q = p.recQuantize || 0;
    const fix = (n) => (q ? { ...n, t: Math.round(n.t / q) * q, d: Math.max(q, Math.round(n.d / q) * q) } : n);
    if (mode === 'pattern') {
      const pat = D.curPattern(p);
      for (const n of notes) (pat.notes[n.ch] ||= []).push(fix({ p: n.p, t: n.t, d: n.d, v: n.v }));
      return;
    }
    const start = Math.floor(from / p.sig) * p.sig;
    const end = Math.max(...notes.map((n) => n.t + n.d));
    const pat = D.newPattern(p, `Gravação ${p.patterns.length + 1}`);
    pat.len = Math.max(p.sig, Math.ceil((end - start) / p.sig) * p.sig);
    for (const n of notes) (pat.notes[n.ch] ||= []).push(fix({ p: n.p, t: n.t - start, d: n.d, v: n.v }));
    p.patterns.push(pat);
    const t = D.freeTrack(p, start, start + pat.len);
    p.playlist.clips.push({ id: uid(), kind: 'pattern', track: t.id, start, len: pat.len, pattern: pat.id });
    p.curPattern = pat.id;
  }

  // ---------------------------------------------------------------- clipes da playlist
  function delClip() { const c = clip(); if (!c) return; change(() => { p.playlist.clips = p.playlist.clips.filter((x) => x !== c); ui.clip = null; }, { structure: false }); }
  function dupClip() { const c = clip(); if (!c) return; change(() => { const n = { ...structuredClone(c), id: uid(), start: D.clipEnd(p, c) }; p.playlist.clips.push(n); ui.clip = n.id; }, { structure: false }); }
  function splitClip() {
    const c = clip(), b = engine.position;
    if (!c) return;
    if (b <= c.start + 0.01 || b >= D.clipEnd(p, c) - 0.01) { toast('Coloque o cursor no meio do clipe para dividir.'); return; }
    change(() => {
      const cut = b - c.start;
      let n;
      if (c.kind === 'audio') { const s = cut * D.spb(p); n = { ...structuredClone(c), id: uid(), start: b, offset: (c.offset || 0) + s, dur: c.dur - s }; c.dur = s; }
      else if (c.kind === 'auto') { n = { ...structuredClone(c), id: uid(), start: b, len: c.len - cut, points: c.points.filter((x) => x.t >= cut).map((x) => ({ ...x, t: x.t - cut })) }; c.points = c.points.filter((x) => x.t <= cut); c.len = cut; }
      else { n = { ...structuredClone(c), id: uid(), start: b, len: c.len - cut, offset: (c.offset || 0) + cut }; c.len = cut; } // padrão: o pedaço novo continua de onde o corte ficou
      p.playlist.clips.push(n); ui.clip = n.id;
    }, { structure: false });
  }
  async function importAudio(file) {
    try {
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const chans = [buf.getChannelData(0).slice()];
      if (buf.numberOfChannels > 1) chans.push(buf.getChannelData(1).slice());
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 40);
      const audioId = await D.saveAudio(chans, buf.sampleRate, name);
      await D.loadAudio(ctx, audioId);
      await change(() => {
        p.mode = 'song';
        const start = engine.position, t = D.freeTrack(p, start, start + buf.duration / D.spb(p));
        const c = { id: uid(), kind: 'audio', track: t.id, start, dur: buf.duration, offset: 0, audioId, gain: 0, insert: p.mixer.inserts[0].id, name };
        p.playlist.clips.push(c); ui.clip = c.id; ui.brush = { ...structuredClone(c), id: null };
      });
    } catch { toast('Não consegui ler esse arquivo de áudio.', 'danger'); }
  }
  function automationDialog() {
    const groups = new Map();
    for (const t of targetsOf(p)) { if (!groups.has(t.group)) groups.set(t.group, []); groups.get(t.group).push(t); }
    const m = modal({
      title: 'Clipe de automação',
      body: `<p class="small text-body-secondary">Escolha o que o clipe vai controlar. Ele entra na playlist na posição do cursor, com 4 compassos; depois é só desenhar a curva.</p>
        <select class="form-select" size="12" data-r="target" aria-label="O que automatizar">${[...groups].map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('')}</optgroup>`).join('')}</select>`,
      footer: '<button class="btn btn-primary" type="button" data-ok>Criar</button>',
    });
    m.footer.querySelector('[data-ok]').onclick = () => {
      const target = m.body.querySelector('[data-r="target"]').value;
      const tg = target && resolveTarget(p, target);
      if (!tg) { toast('Escolha um item da lista.'); return; }
      const start = Math.floor(engine.position / p.sig) * p.sig, len = p.sig * 4;
      change(() => {
        p.mode = 'song';
        const t = D.freeTrack(p, start, start + len);
        const c = { id: uid(), kind: 'auto', track: t.id, start, len, target, label: tg.label, color: '#e3b341', points: [{ t: 0, v: tg.initial }, { t: len, v: tg.initial }] };
        p.playlist.clips.push(c); ui.clip = c.id; ui.tab = 'auto'; ui.brush = { ...structuredClone(c), id: null };
      }, { structure: false });
      m.close();
    };
  }

  // ---------------------------------------------------------------- projetos
  async function openProject(q) {
    if (engine.recording) return;
    engine.stop(false);
    engine.stopMonitors();
    hist.undo = []; hist.redo = [];
    try { localStorage.setItem(LAST, q.id); } catch { /* ok */ }
    ui.ch = q.channels[0]?.id || null; ui.clip = null; ui.brush = null; ui.ins = q.mixer.inserts[0].id;
    engine.pos = 0;
    await replaceProject(q, { keepSynths: false });
    R('tl').scrollLeft = 0;
  }
  async function projectsDialog() {
    const list = await D.listProjects();
    const m = modal({ title: 'Projetos', body: list.length ? `<div class="list-group">${list.map((x) => `
      <div class="list-group-item d-flex align-items-center gap-2"><button class="btn btn-link text-start flex-grow-1 p-0 text-decoration-none" type="button" data-open="${x.id}"><strong>${esc(x.name)}</strong><br><span class="small text-body-secondary">${new Date(x.updated).toLocaleString('pt-BR')}</span></button>
      ${x.id === p.id ? '<span class="badge text-bg-secondary">aberto</span>' : `<button class="btn btn-sm btn-outline-danger" type="button" data-del="${x.id}" title="Apagar"><i class="bi bi-trash"></i><span class="visually-hidden">Apagar</span></button>`}</div>`).join('')}</div>` : '<p class="mb-0">Nenhum projeto ainda.</p>' });
    m.body.onclick = async (e) => {
      const o = e.target.closest('[data-open]')?.dataset.open, d = e.target.closest('[data-del]')?.dataset.del;
      if (o) { if (o !== p.id) { const q = await D.loadProject(o); if (q) await openProject(q); } m.close(); }
      if (d && await confirmBox('Apagar esse projeto e suas gravações?', { ok: 'Apagar', danger: true })) { await D.deleteProject(d); m.close(); projectsDialog(); }
    };
  }
  function settingsDialog() {
    const auto = Math.round(((ctx.outputLatency || ctx.baseLatency || 0) + 0.01) * 1000);
    const m = modal({ title: 'Gravação e latência', body: `
      <p class="small">O som que você toca chega ao site um pouco atrasado (saída de áudio + entrada). A DAW adianta a gravação por esse tempo para ela cair no lugar certo.</p>
      <div class="form-check"><input class="form-check-input" type="radio" name="lat" id="lat-auto"${p.latencyMs == null ? ' checked' : ''}><label class="form-check-label" for="lat-auto">Automática (o navegador informa ~${auto} ms)</label></div>
      <div class="form-check mb-2"><input class="form-check-input" type="radio" name="lat" id="lat-man"${p.latencyMs != null ? ' checked' : ''}><label class="form-check-label" for="lat-man">Manual</label></div>
      <div class="input-group input-group-sm mb-3" style="max-width:14rem"><input type="number" class="form-control" id="lat-ms" min="0" max="1000" step="1" value="${p.latencyMs ?? auto}"><span class="input-group-text">ms</span></div>
      <p class="small text-body-secondary">Se a gravação ficar atrasada em relação ao metrônomo, aumente; se ficar adiantada, diminua.</p>
      <label class="form-label" for="rq">Notas gravadas: alinhar à grade</label>
      <select class="form-select form-select-sm" id="rq" style="max-width:14rem">${[[0, 'Não alinhar'], [1, '1/4'], [0.5, '1/8'], [0.25, '1/16'], [0.125, '1/32']].map(([v, l]) => `<option value="${v}"${p.recQuantize === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`,
    footer: '<button class="btn btn-primary" type="button" data-ok>Salvar</button>' });
    m.footer.querySelector('[data-ok]').onclick = () => {
      const man = m.body.querySelector('#lat-man').checked;
      change(() => { p.latencyMs = man ? clamp(Number(m.body.querySelector('#lat-ms').value) || 0, 0, 1000) : null; p.recQuantize = Number(m.body.querySelector('#rq').value); }, { structure: false });
      m.close();
    };
  }
  async function exportWav(kind) {
    if (kind === 'song' && !p.playlist.clips.length) { toast('A playlist está vazia: exporte o padrão ou monte a música no modo SONG.'); return; }
    if (engine.playing) engine.stop();
    const m = modal({ title: 'Exportando', body: `<p class="small mb-2">Mixando…</p>${progressHtml('daw-exp')}` });
    try {
      const opts = kind === 'pattern' ? { mode: 'pattern' } : kind === 'loop' ? { mode: 'song', from: p.loop.start, to: p.loop.end } : { mode: 'song' };
      const out = await engine.render({ ...opts, onProgress: (f) => setProgress(m.body.querySelector('#daw-exp'), f) });
      download(`${p.name}${kind === 'song' ? '' : kind === 'pattern' ? ` (${D.curPattern(p).name})` : ' (loop)'}.wav`, encodeWav(out.channels, out.sampleRate));
      m.close();
    } catch (err) { m.body.innerHTML = `<div class="alert alert-danger mb-0">Não consegui exportar: ${esc(err.message)}</div>`; }
  }

  // ---------------------------------------------------------------- eventos da barra
  el.addEventListener('change', async (e) => {
    const t = e.target, k = t.dataset.p, a = t.dataset.a;
    if (!t.closest('.daw-bar') && !t.closest('.pl-bar')) return;
    if (a === 'importaudio' && t.files[0]) { await importAudio(t.files[0]); t.value = ''; return; }
    if (a === 'pimport' && t.files[0]) {
      try { await openProject(await D.importProjectFile(await t.files[0].text())); toast('Projeto aberto.', 'success'); } catch (err) { toast(err.message || 'Arquivo inválido.', 'danger'); }
      t.value = ''; return;
    }
    if (t.name === 'daw-mode') { p.mode = t.value; persist(); engine.restart(); refresh(); return; }
    if (!k) return;
    if (k === 'bpm') { const v = clamp(Math.round(Number(t.value) || 120), 30, 300); const was = engine.playing; if (was) engine.stop(false); await change(() => { p.bpm = v; }, { structure: false }); if (was) engine.play(engine.pos); }
    if (k === 'sig') await change(() => { p.sig = Number(t.value); });
    if (k === 'metro' || k === 'countIn') await change(() => { p[k] = t.checked; }, { structure: false });
    if (k === 'loop') await change(() => { p.loop.on = t.checked; if (p.loop.end <= p.loop.start) p.loop = { on: p.loop.on, start: 0, end: p.sig * 4 }; }, { structure: false });
    if (k === 'snap') { const v = t.value; p.snapBar = v === 'bar'; p.snap = v === 'bar' ? p.sig : Number(v); persist(); pl.draw(); pr?.draw(); }
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b || !(b.closest('.daw-bar') || b.closest('.pl-bar') || b.closest('[data-r="pane"]'))) return;
    await action(b.dataset.a);
  });
  async function action(a) {
    if (a === 'play') return togglePlay();
    if (a === 'rec') return toggleRecord();
    if (a === 'home') { engine.seek(p.mode === 'song' && p.loop.on ? p.loop.start : 0); R('tl').scrollLeft = 0; pl.draw(); showPos(); return; }
    if (a === 'undo') return undo();
    if (a === 'redo') return redo();
    if (a === 'zin') return zoomTo(p.zoom * 1.4);
    if (a === 'zout') return zoomTo(p.zoom / 1.4);
    if (a === 'split') return splitClip();
    if (a === 'dupclip') return dupClip();
    if (a === 'delclip') return delClip();
    if (a === 'auto') return automationDialog();
    if (a === 'addtrack') return change(() => { p.playlist.tracks.push(D.newPlaylistTrack(p)); }, { structure: false });
    if (a === 'settings') return settingsDialog();
    if (a === 'wav') return exportWav('song');
    if (a === 'wavpat') return exportWav('pattern');
    if (a === 'wavloop') return exportWav('loop');
    if (a === 'open') return projectsDialog();
    if (a === 'new') { await D.saveProject(p); const q = D.newProject(); await D.saveProject(q); return openProject(q); }
    if (a === 'dup') { const q = { ...structuredClone(p), id: uid(), name: p.name + ' (cópia)', created: Date.now() }; await D.saveProject(q); await openProject(q); toast('Projeto duplicado.', 'success'); return; }
    if (a === 'rename') { const n = await promptBox('Nome do projeto', p.name, { ok: 'Renomear' }); if (n?.trim()) await change(() => { p.name = n.trim().slice(0, 80); }, { structure: false }); return; }
    if (a === 'pfile') { download(`${p.name}.estudio.json`, await D.exportProjectFile(p), 'application/json'); return; }
    if (a === 'delproj') {
      if (!(await confirmBox(`Apagar o projeto "${p.name}" e suas gravações? Não dá para desfazer.`, { ok: 'Apagar', danger: true }))) return;
      engine.stop(false);
      await D.deleteProject(p.id);
      const rest = await D.listProjects();
      const q = rest[0] ? await D.loadProject(rest[0].id) : D.newProject();
      if (!rest[0]) await D.saveProject(q);
      await openProject(q);
    }
  }

  // ---------------------------------------------------------------- atalhos
  const onKey = (e) => {
    if (/input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable || document.querySelector('.modal.show')) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (ui.focus === 'roll' && pr && pr.key(e)) { e.preventDefault(); return; }
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 'd') { e.preventDefault(); dupClip(); return; }
    if (!mod && k === 'r' && !e.repeat) { e.preventDefault(); toggleRecord(); return; }
    if (!mod && k === 'l' && !e.repeat) { e.preventDefault(); p.mode = p.mode === 'song' ? 'pattern' : 'song'; persist(); engine.restart(); refresh(); return; }
    if (e.key === 'Home') { e.preventDefault(); action('home'); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && clip() && ui.focus === 'pl') { e.preventDefault(); delClip(); }
  };
  window.addEventListener('keydown', onKey);
  R('tl').addEventListener('pointerdown', () => { ui.focus = 'pl'; });

  // ---------------------------------------------------------------- animação: cursor, passos e medidores
  const showPos = () => { const b = p.mode === 'song' ? engine.position : (engine.playing ? engine.position : 0); R('pos').textContent = `${D.fmtPos(p, b)} · ${D.fmtTime(Math.max(0, b) * D.spb(p))}`; };
  let wasPlaying = false, lastStep = null;
  function frame() {
    if (destroyed) return;
    if (engine.playing) {
      if (p.mode === 'song') { pl.follow(); pl.draw(); }
      pr?.draw(); showPos();
      const pp = patternPos(), st = pp == null ? null : Math.floor(pp / D.STEP);
      if (st !== lastStep) { rack.highlight(st); lastStep = st; }
    } else if (wasPlaying) { pl.draw(); pr?.draw(); showPos(); updateTransport(); rack.highlight(null); lastStep = null; }
    wasPlaying = engine.playing;
    for (const m of el.querySelectorAll('[data-meter]')) {
      const id = m.dataset.meter, v = engine.level(id === 'master' ? null : id), pct = Math.min(100, v * 100);
      if (m.parentElement.classList.contains('vmeter')) m.style.height = pct + '%'; else m.style.width = pct + '%';
      m.classList.toggle('clip', v > 0.98);
    }
    raf = requestAnimationFrame(frame);
  }

  // agentes de IA (lib/agent/tools.js) mexem no projeto aberto por aqui, com desfazer
  const unLive = setLive('daw', {
    project: () => p,
    async edit(fn) {
      if (engine.recording) throw new Error('A DAW está gravando; espere a gravação terminar.');
      const before = new Map(p.channels.map((c) => [c.id, JSON.stringify(c.synth.params)]));
      begin();
      try { await fn(p); } catch (e) { cancel(); throw e; }
      for (const c of p.channels) if (before.has(c.id) && before.get(c.id) !== JSON.stringify(c.synth.params)) engine.synthOf(c.id)?.setEngine(c.synth.engine, c.synth.params);
      paneKey = '';
      await end();
    },
    async open(id) { const q = await D.loadProject(id); if (q) await openProject(q); },
    async transport(a) {
      if (a === 'inicio') return action('home');
      if ((a === 'tocar') !== engine.playing) await togglePlay();
    },
    playing: () => engine.playing,
  });

  const ready = (async () => {
    await engine.sync(p);
    hookSynths();
    refresh(); showPos();
    raf = requestAnimationFrame(frame);
    D.saveProject(p).catch(() => {});
    R('srcname').textContent = srcName();
    if (p.rec.monitor) applyMonitor();
  })();

  return {
    ready, engine, toggleRecord,
    destroy() {
      destroyed = true;
      unLive();
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      qk.detach(); midi?.detach();
      panel?.destroy(); pr?.destroy(); ae?.destroy(); pl.destroy();
      D.saveProject(p).catch(() => {});
      engine.destroy();
    },
  };
}

