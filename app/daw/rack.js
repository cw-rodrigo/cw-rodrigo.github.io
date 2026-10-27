// Channel Rack (como no FL): escolha do padrão e, para cada canal, mudo, volume, pan, insert do mixer
// e os passos do sequenciador. Quando o canal tem notas livres (do piano roll), aparece a miniatura delas.
import { esc } from '/lib/core/ui.js';
import { STEP, patternLength, curPattern, isStepPattern } from './project.js';

/**
 * h: { project(), selected(), select(chId), begin(), end(opts), cancel(), change(fn, opts), openRoll(chId),
 *      openSettings(chId), preview(chId), live() (volume/pan mexendo), patternMenu(acao, id), addChannel(tipo), channelMenu(acao, chId) }
 */
export function channelRack(el, h) {
  function render() {
    const p = h.project(), pat = curPattern(p), sel = h.selected();
    const steps = Math.round(patternLength(p, pat) / STEP);
    const insOpts = (ch) => p.mixer.inserts.map((ins, i) => `<option value="${ins.id}"${ins.id === ch.insert ? ' selected' : ''}>${i === 0 ? 'Master' : `${i} · ${esc(ins.name)}`}</option>`).join('');
    el.innerHTML = `
      <div class="rack-head d-flex flex-wrap align-items-center gap-1 mb-2">
        <select class="form-select form-select-sm w-auto rack-pat" data-k="pattern" aria-label="Padrão" style="max-width:11rem">${p.patterns.map((x) => `<option value="${x.id}"${x.id === pat.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <div class="btn-group btn-group-sm" role="group" aria-label="Padrões">
          <button class="btn btn-outline-secondary" type="button" data-pm="new" title="Padrão novo"><i class="bi bi-plus-lg"></i><span class="visually-hidden">Padrão novo</span></button>
          <button class="btn btn-outline-secondary" type="button" data-pm="clone" title="Duplicar padrão"><i class="bi bi-copy"></i><span class="visually-hidden">Duplicar padrão</span></button>
          <button class="btn btn-outline-secondary" type="button" data-pm="rename" title="Renomear padrão"><i class="bi bi-pencil"></i><span class="visually-hidden">Renomear padrão</span></button>
          <button class="btn btn-outline-secondary" type="button" data-pm="delete" title="Apagar padrão"><i class="bi bi-trash"></i><span class="visually-hidden">Apagar padrão</span></button>
        </div>
        <select class="form-select form-select-sm w-auto" data-k="steps" aria-label="Passos">${[16, 32, 48, 64].map((n) => `<option value="${n}"${n === steps ? ' selected' : ''}>${n} passos</option>`).join('')}${[16, 32, 48, 64].includes(steps) ? '' : `<option selected>${steps} passos</option>`}</select>
        <div class="dropdown ms-auto">
          <button class="btn btn-sm btn-primary dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false"><i class="bi bi-plus-lg"></i> Canal</button>
          <ul class="dropdown-menu dropdown-menu-end">
            <li><h6 class="dropdown-header">Sintetizador</h6></li>
            <li><button class="dropdown-item" type="button" data-add="synth:subtractive">Subtrativo (leads, baixos)</button></li>
            <li><button class="dropdown-item" type="button" data-add="synth:fm">FM (pianos, sinos)</button></li>
            <li><button class="dropdown-item" type="button" data-add="synth:wavetable">Wavetable (pads)</button></li>
            <li><button class="dropdown-item" type="button" data-add="synth:physical">Corda / percussão física</button></li>
            <li><button class="dropdown-item" type="button" data-add="synth:sampler">Sampler (General MIDI ou amostra)</button></li>
            <li><button class="dropdown-item" type="button" data-add="synth:nes">NES (chiptune)</button></li>
            <li><h6 class="dropdown-header">Bateria (uma peça por canal)</h6></li>
            ${[['Bumbo', 36], ['Caixa', 38], ['Palmas', 39], ['Chimbal', 42], ['Chimbal aberto', 46], ['Prato', 49], ['Tom', 45], ['Aro', 37], ['Cowbell', 56]].map(([n, k]) => `<li><button class="dropdown-item" type="button" data-add="drum:${k}:${n}">${n}</button></li>`).join('')}
          </ul>
        </div>
      </div>
      <div class="rack-rows">${p.channels.map((ch) => {
        const list = pat.notes[ch.id] || [];
        const asSteps = isStepPattern(ch, list);
        const on = new Set(list.map((n) => Math.round(n.t / STEP)));
        return `<div class="rack-row${ch.id === sel ? ' sel' : ''}" data-ch="${ch.id}" style="--c:${ch.color}">
          <button class="rack-led${ch.mute ? '' : ' on'}" type="button" data-a="mute" title="${ch.mute ? 'Ligar' : 'Silenciar'} o canal" aria-pressed="${!ch.mute}"><span class="visually-hidden">Mudo</span></button>
          <input type="range" class="rack-knob" data-a="pan" min="-1" max="1" step="0.01" value="${ch.pan}" title="Pan" aria-label="Pan de ${esc(ch.name)}">
          <input type="range" class="rack-knob" data-a="vol" min="-40" max="6" step="0.5" value="${ch.vol}" title="Volume" aria-label="Volume de ${esc(ch.name)}">
          <select class="rack-ins" data-a="insert" title="Insert do mixer" aria-label="Insert do mixer de ${esc(ch.name)}">${insOpts(ch)}</select>
          <button class="rack-name" type="button" data-a="select" title="Clique: selecionar · duplo clique: configurar o instrumento">${esc(ch.name)}</button>
          ${asSteps ? `<div class="rack-steps" style="--n:${steps}">${Array.from({ length: steps }, (_, i) => `<button type="button" class="step${on.has(i) ? ' on' : ''}${Math.floor(i / 4) % 2 ? ' odd' : ''}" data-step="${i}" aria-label="Passo ${i + 1}" aria-pressed="${on.has(i)}"></button>`).join('')}</div>`
    : `<canvas class="rack-mini" data-a="roll" height="22" title="Notas do piano roll: clique para editar"></canvas>`}
          <button class="btn btn-sm btn-link rack-roll" type="button" data-a="roll" title="Piano roll"><i class="bi bi-music-note-list"></i><span class="visually-hidden">Abrir no piano roll</span></button>
          <div class="dropdown">
            <button class="btn btn-sm btn-link text-body px-1" type="button" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Mais opções do canal"><i class="bi bi-three-dots-vertical"></i></button>
            <ul class="dropdown-menu dropdown-menu-end">
              <li><button class="dropdown-item" type="button" data-cm="settings">Configurar o instrumento</button></li>
              <li><button class="dropdown-item" type="button" data-cm="rename">Renomear</button></li>
              <li><button class="dropdown-item" type="button" data-cm="clone">Duplicar canal</button></li>
              <li><button class="dropdown-item" type="button" data-cm="clear">Limpar as notas deste padrão</button></li>
              <li><button class="dropdown-item" type="button" data-cm="up">Subir</button></li>
              <li><button class="dropdown-item" type="button" data-cm="down">Descer</button></li>
              <li><hr class="dropdown-divider"></li>
              <li><button class="dropdown-item text-danger" type="button" data-cm="delete">Apagar canal</button></li>
            </ul>
          </div>
        </div>`;
      }).join('') || '<p class="small text-body-secondary p-2 mb-0">Nenhum canal. Use “+ Canal”.</p>'}</div>`;
    el.querySelectorAll('canvas.rack-mini').forEach((c) => drawMini(c, p, pat, p.channels.find((x) => x.id === c.closest('[data-ch]').dataset.ch)));
  }
  function drawMini(c, p, pat, ch) {
    const w = (c.width = c.clientWidth || 200), hh = c.height;
    const g = c.getContext('2d'), list = pat.notes[ch.id] || [], len = patternLength(p, pat);
    g.clearRect(0, 0, w, hh);
    if (!list.length) return;
    let lo = 127, hi = 0;
    for (const n of list) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
    g.fillStyle = ch.color;
    for (const n of list) g.fillRect((n.t / len) * w, hh - 3 - ((n.p - lo) / Math.max(1, hi - lo)) * (hh - 6), Math.max(2, (n.d / len) * w - 1), 3);
  }
  /** Acende o passo que está tocando. */
  function highlight(step) {
    el.querySelectorAll('.step.now').forEach((b) => b.classList.remove('now'));
    if (step == null) return;
    el.querySelectorAll(`.step[data-step="${step}"]`).forEach((b) => b.classList.add('now'));
  }

  el.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]')?.dataset.add;
    if (add) { h.addChannel(add); return; }
    const pm = e.target.closest('[data-pm]')?.dataset.pm;
    if (pm) { h.patternMenu(pm); return; }
    const row = e.target.closest('[data-ch]');
    if (!row) return;
    const chId = row.dataset.ch;
    const cm = e.target.closest('[data-cm]')?.dataset.cm;
    if (cm) { h.channelMenu(cm, chId); return; }
    const stepB = e.target.closest('[data-step]');
    const p = h.project();
    if (stepB) {
      const ch = p.channels.find((x) => x.id === chId), pat = curPattern(p), i = Number(stepB.dataset.step);
      h.change(() => {
        const list = (pat.notes[ch.id] ||= []);
        const k = list.findIndex((n) => Math.round(n.t / STEP) === i);
        if (k >= 0) list.splice(k, 1); else { list.push({ p: ch.stepNote, t: i * STEP, d: STEP, v: 100 }); h.preview(ch.id); }
      }, { structure: false });
      h.select(chId);
      return;
    }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'mute') { const ch = p.channels.find((x) => x.id === chId); h.change(() => { ch.mute = !ch.mute; }, { structure: false }); }
    else if (a === 'select') h.select(chId);
    else if (a === 'roll') h.openRoll(chId);
  });
  el.addEventListener('dblclick', (e) => { const row = e.target.closest('[data-ch]'); if (row && e.target.closest('[data-a="select"]')) h.openSettings(row.dataset.ch); });
  // volume e pan: um passo de desfazer por gesto
  let gesture = false;
  el.addEventListener('input', (e) => {
    const a = e.target.dataset.a, row = e.target.closest('[data-ch]');
    if (!row || (a !== 'vol' && a !== 'pan')) return;
    const ch = h.project().channels.find((x) => x.id === row.dataset.ch);
    if (!gesture) { h.begin(); gesture = true; }
    ch[a] = Number(e.target.value);
    h.live();
  });
  el.addEventListener('change', (e) => {
    const k = e.target.dataset.k, a = e.target.dataset.a;
    if (a === 'vol' || a === 'pan') { gesture = false; h.end({ structure: false }); return; }
    const p = h.project();
    if (k === 'pattern') { h.patternMenu('select', e.target.value); return; }
    if (k === 'steps') { const n = Number(e.target.value); h.change(() => { curPattern(p).len = (n * STEP); }, { structure: false }); return; }
    if (a === 'insert') { const ch = p.channels.find((x) => x.id === e.target.closest('[data-ch]').dataset.ch); h.change(() => { ch.insert = e.target.value; }); }
  });
  return { render, highlight };
}
