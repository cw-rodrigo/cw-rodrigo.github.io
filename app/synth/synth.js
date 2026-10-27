// Sintetizador: o "tudo em um" (#/sintetizador) e cada tipo de síntese sozinho (#/sintetizador/fm etc.).
import { Synth } from '/lib/synth/synth.js';
import { ENGINES, ENGINE_IDS } from '/lib/synth/schemas.js';
import { synthPanel, presetStore } from '/lib/synth/ui.js';
import { pianoKeyboard, qwertyKeys, midiKeyboards, noteLabel } from '/lib/synth/keyboard.js';
import { audioCtx, resumeAudio } from '/lib/audio/context.js';
import { $, esc, debounce } from '/lib/core/ui.js';

const synths = {}; // um instrumento por página (o tudo-em-um e cada tipo), mantidos ao navegar
const lastKey = (eng) => (eng ? 'e:' + eng : 'all');

async function getSynth(locked) {
  const key = lastKey(locked);
  if (synths[key]) return synths[key];
  const saved = presetStore.data.last?.[key];
  const state = saved && (!locked || saved.engine === locked) ? saved : { engine: locked || 'subtractive' };
  const ctx = audioCtx();
  const s = await Synth.create(ctx, state);
  s.connect(ctx.destination);
  s.on(debounce((st) => { presetStore.data.last = { ...(presetStore.data.last || {}), [key]: { engine: st.engine, params: st.params, fx: st.fx } }; presetStore.save(); }, 800));
  synths[key] = s;
  return s;
}

export default {
  title: 'Sintetizador',
  wide: () => true,
  async render(el, { parts, setTitle }) {
    const locked = ENGINES[parts[0]] ? parts[0] : null;
    if (parts[0] && !locked) { location.replace('#/sintetizador'); return null; }
    if (locked) setTitle(`Sintetizador ${ENGINES[locked].name}`);
    el.innerHTML = `
      <div class="d-flex flex-wrap align-items-end justify-content-between gap-2 mb-2">
        <div><h1 class="h2 mb-1">${locked ? `Sintetizador ${esc(ENGINES[locked].name)}` : 'Sintetizador tudo em um'}</h1>
        <p class="text-body-secondary mb-0">${locked ? 'Este tipo de síntese sozinho. ' : 'Todos os tipos de síntese num instrumento só. '}Também pode ser usado como instrumento nas faixas da <a href="#/daw">DAW</a>.</p></div>
      </div>
      <nav class="nav nav-pills small flex-nowrap overflow-auto mb-3 pb-1" aria-label="Tipos de síntese">
        <a class="nav-link text-nowrap${locked ? '' : ' active'}" href="#/sintetizador"><i class="bi bi-boxes"></i> Tudo em um</a>
        ${ENGINE_IDS.map((id) => `<a class="nav-link text-nowrap${locked === id ? ' active' : ''}" href="#/sintetizador/${id}"><i class="bi ${ENGINES[id].icon}"></i> ${esc(ENGINES[id].name)}</a>`).join('')}
      </nav>
      <div id="sy-panel"><div class="text-center p-5"><div class="spinner-border"></div></div></div>
      <div class="kb-dock border-top bg-body" id="kb-dock">
        <div class="container-xl py-2">
          <div class="d-flex flex-wrap align-items-center gap-2 mb-2 small">
            <div class="btn-group btn-group-sm" role="group" aria-label="Oitava"><button class="btn btn-outline-secondary" type="button" data-k="down" aria-label="Oitava abaixo">−</button><span class="btn btn-outline-secondary disabled" data-r="oct">C3</span><button class="btn btn-outline-secondary" type="button" data-k="up" aria-label="Oitava acima">+</button></div>
            <label class="d-flex align-items-center gap-1">Bend <input type="range" class="form-range" style="width:90px" min="-1" max="1" step="0.01" value="0" data-k="bend" aria-label="Pitch bend"></label>
            <label class="d-flex align-items-center gap-1">Mod <input type="range" class="form-range" style="width:90px" min="0" max="1" step="0.01" value="0" data-k="mod" aria-label="Modulação"></label>
            <button class="btn btn-sm btn-outline-secondary" type="button" data-k="panic" title="Parar todas as notas"><i class="bi bi-stop-circle"></i> Pânico</button>
            <span class="text-body-secondary ms-auto d-none d-md-inline" data-r="midi">Teclado do computador: A W S E D F T G Y H U J K · Z/X oitava</span>
          </div>
          <div id="kb"></div>
        </div>
      </div>`;
    const synth = await getSynth(locked);
    if (!el.isConnected) return null;
    const panel = synthPanel($('#sy-panel'), synth, { lockEngine: !!locked });
    const wide = () => (window.innerWidth >= 992 ? 4 : window.innerWidth >= 576 ? 3 : 2);
    let base = presetStore.data.kbBase || 48;
    const kb = pianoKeyboard($('#kb'), {
      from: base, octaves: wide(),
      onOn: (n, v) => { resumeAudio(); synth.noteOn(n, v); },
      onOff: (n) => synth.noteOff(n),
    });
    const showOct = () => { $('[data-r="oct"]').textContent = noteLabel(base); };
    showOct();
    const qk = qwertyKeys({
      base: base + 12,
      onOn: (n, v) => { resumeAudio(); synth.noteOn(n, v); kb.light(n, true); },
      onOff: (n) => { synth.noteOff(n); kb.light(n, false); },
      onOctave: (b) => { base = b - 12; kb.setRange(base, wide()); showOct(); },
    });
    let midi = null;
    midiKeyboards({
      onOn: (n, v) => { resumeAudio(); synth.noteOn(n, v); kb.light(n, true); },
      onOff: (n) => { synth.noteOff(n); kb.light(n, false); },
      onBend: (v) => synth.bend(v), onMod: (v) => synth.mod(v), onAllOff: () => synth.allOff(),
      onChange: (names) => { const m = $('[data-r="midi"]'); if (m && names.length) m.textContent = `Teclado MIDI: ${names.join(', ')}`; },
    }).then((m) => { midi = m; }).catch(() => {});
    const resize = () => kb.setRange(base, wide());
    window.addEventListener('resize', resize);
    $('#kb-dock').onclick = (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (k === 'down' || k === 'up') { base = Math.max(12, Math.min(96, base + (k === 'up' ? 12 : -12))); qk.state.base = base + 12; presetStore.data.kbBase = base; kb.setRange(base, wide()); showOct(); }
      if (k === 'panic') synth.panic();
    };
    $('#kb-dock').oninput = (e) => {
      if (e.target.dataset.k === 'bend') synth.bend(Number(e.target.value));
      if (e.target.dataset.k === 'mod') synth.mod(Number(e.target.value));
    };
    $('#kb-dock').addEventListener('pointerup', (e) => { if (e.target.dataset.k === 'bend') { e.target.value = 0; synth.bend(0); } });
    document.body.classList.add('has-kb');
    return () => { panel.destroy(); qk.detach(); midi?.detach(); window.removeEventListener('resize', resize); synth.allOff(); document.body.classList.remove('has-kb'); };
  },
};
