// Recursos do Cifras carregados só quando pedidos: modo rolagem (com metrônomo) e partitura/tab.
import * as M from '/lib/music/theory.js';
import { Metronome } from '/lib/audio/metronome.js';
import { esc, toast, loadScript, modal } from '/lib/core/ui.js';

const ABCJS_URL = '/lib/vendor/abcjs/abcjs-basic-min.js';

// ================= Modo rolagem =================

export function openStage(ctx) {
  const { song, prefs } = ctx;
  let bpm = song.bpm || 80;
  let speed = prefs.scrollSpeed || 1;
  let size = prefs.stageSize || 1.5;
  let playing = false;
  let raf = 0;
  let last = 0;
  let acc = 0;
  let wake = null;

  const el = document.createElement('div');
  el.className = 'stage';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Modo rolagem');
  el.innerHTML = `
    <div class="scroller"><div class="sheet" style="--lyric-size:${size}rem">
      <h1 style="margin:0">${esc(song.title)}</h1><p class="text-body-secondary" style="margin:0 0 1.2em">${[song.artist, 'Tom ' + ctx.keyLabel].filter(Boolean).map(esc).join(' · ')}</p>
      ${ctx.html}</div></div>
    <div class="guide" aria-hidden="true"></div>
    <div class="controls">
      <button class="btn btn-primary" data-x="play" style="min-width:110px">▶ Rolar</button>
      <span class="btn-group"><button class="btn btn-outline-secondary" data-x="slower" aria-label="Mais devagar">−</button><span class="btn btn-outline-secondary disabled font-monospace" id="spd"></span><button class="btn btn-outline-secondary" data-x="faster" aria-label="Mais rápido">+</button></span>
      <span class="input-group w-auto"><label for="bpm" class="input-group-text">BPM</label><input class="form-control" id="bpm" type="number" min="30" max="260" value="${bpm}" style="width:80px"></span>
      <span class="d-inline-flex align-items-center gap-1"><button class="btn btn-outline-secondary" data-x="metro" aria-pressed="false">Metrônomo</button>
        <span class="beat" data-b="0"></span><span class="beat" data-b="1"></span><span class="beat" data-b="2"></span><span class="beat" data-b="3"></span></span>
      ${song.ytId ? '<button class="btn btn-outline-secondary" data-x="video">Vídeo</button>' : ''}
      <span class="btn-group"><button class="btn btn-outline-secondary" data-x="small" aria-label="Diminuir letra">A−</button><button class="btn btn-outline-secondary" data-x="big" aria-label="Aumentar letra">A+</button></span>
      <button class="btn btn-outline-secondary" data-x="close">Fechar</button>
    </div>`;
  document.body.append(el);
  document.body.style.overflow = 'hidden';
  document.body.classList.add('stage-open');
  const sc = el.querySelector('.scroller');
  const sheet = el.querySelector('.sheet');
  const lines = [...sheet.querySelectorAll('.ln, .section, .chords-only, .tab')];
  const metro = new Metronome((b) => {
    el.querySelectorAll('.beat').forEach((d) => d.classList.toggle('on', Number(d.dataset.b) === b));
    el.querySelector('.beat[data-b="0"]').classList.add('accent');
  });

  const showSpeed = () => { el.querySelector('#spd').textContent = speed.toFixed(2).replace(/0$/, '') + '×'; };
  showSpeed();
  // velocidade base: cerca de uma linha de cifra a cada 2 compassos (8 tempos)
  const pxPerSec = () => {
    const fs = parseFloat(getComputedStyle(sheet).fontSize) || 18;
    return (fs * 2.7 * bpm) / (8 * 60) * speed;
  };

  const highlight = () => {
    const y = el.querySelector('.guide').getBoundingClientRect().top;
    let now = null;
    for (const l of lines) {
      const r = l.getBoundingClientRect();
      if (r.top <= y && r.bottom >= y - 4) { now = l; break; }
      if (r.top > y) { now = now || l; break; }
      now = l;
    }
    lines.forEach((l) => l.classList.toggle('now', l === now));
  };
  sc.addEventListener('scroll', () => requestAnimationFrame(highlight), { passive: true });
  highlight();

  const step = (t) => {
    if (!playing) return;
    const dt = last ? (t - last) / 1000 : 0;
    last = t;
    acc += pxPerSec() * dt;
    if (acc >= 1) { const px = Math.floor(acc); sc.scrollTop += px; acc -= px; }
    if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) { setPlaying(false); return; }
    raf = requestAnimationFrame(step);
  };
  const setPlaying = async (v) => {
    playing = v;
    el.querySelector('[data-x="play"]').textContent = v ? '❚❚ Pausar' : '▶ Rolar';
    if (v) {
      last = 0; raf = requestAnimationFrame(step);
      try { wake = await navigator.wakeLock?.request('screen'); } catch { /* sem wake lock */ }
    } else { cancelAnimationFrame(raf); }
  };
  const persist = () => { prefs.scrollSpeed = speed; prefs.stageSize = size; ctx.savePrefs(); };
  const close = () => {
    setPlaying(false); metro.close(); wake?.release?.();
    document.body.style.overflow = '';
    document.body.classList.remove('stage-open');
    document.removeEventListener('keydown', onKey);
    el.remove();
  };
  const onKey = (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') close();
    if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
    if (e.key === 'ArrowUp') { speed = Math.min(4, speed + 0.1); showSpeed(); persist(); }
    if (e.key === 'ArrowDown') { speed = Math.max(0.2, speed - 0.1); showSpeed(); persist(); }
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', () => { if (el.isConnected) close(); }, { once: true });
  el.querySelector('[data-x="play"]').focus();

  el.querySelector('#bpm').onchange = (e) => {
    bpm = Math.min(260, Math.max(30, Number(e.target.value) || 80));
    e.target.value = bpm; ctx.saveBpm(bpm);
    if (metro.running) { metro.stop(); metro.start(bpm); }
  };
  el.onclick = (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'play') setPlaying(!playing);
    if (x === 'faster') { speed = Math.min(4, speed + 0.1); showSpeed(); persist(); }
    if (x === 'slower') { speed = Math.max(0.2, speed - 0.1); showSpeed(); persist(); }
    if (x === 'metro') {
      const b = e.target.closest('[data-x]');
      if (metro.running) { metro.stop(); b.setAttribute('aria-pressed', 'false'); } else { metro.start(bpm); b.setAttribute('aria-pressed', 'true'); }
    }
    if (x === 'video') ctx.playVideo();
    if (x === 'big' || x === 'small') {
      size = Math.min(3, Math.max(0.9, size + (x === 'big' ? 0.15 : -0.15)));
      sheet.style.setProperty('--lyric-size', size + 'rem'); persist(); highlight();
    }
    if (x === 'close') close();
  };
}

// ================= Partitura e tablatura =================

export function openNotation(ctx) {
  const { song } = ctx;
  let player = null; // { synths, timer }
  const stop = () => {
    if (player) { clearTimeout(player.timer); player.synths.forEach((x) => x.destroy()); }
    player = null;
    const b = m.body.querySelector('[data-x="play"]'); if (b) b.textContent = '▶ Tocar melodia (piano)';
  };
  const m = modal({ title: `Partitura e tab · ${song.title}`, size: 'xl', onClose: stop });
  const d = m.body;

  const draw = () => {
    const has = !!(song.melody && song.melody.trim());
    d.innerHTML = `
      <p class="small text-body-secondary">Tom ${esc(ctx.keyLabel)}</p>
      <div data-r="edit" ${has ? 'hidden' : ''}>
        <p>${has ? 'Edite a melodia principal.' : 'Esta música ainda não tem melodia. Escreva a melodia principal (introdução, solo ou a voz) para gerar a partitura e a tablatura.'}</p>
        <textarea class="form-control code" data-r="mel" rows="4" placeholder="E4 G4 A4:2 | B4:0.5 A4:0.5 G4 R:1" aria-label="Melodia">${esc(song.melody || '')}</textarea>
        <p class="small text-body-secondary mt-1">Nota + oitava (C4 = dó central), duração em tempos após “:” (A4:2 = mínima, B4:0.5 = colcheia), R = pausa, | = barra. Escreva no tom original da cifra; a transposição é automática.</p>
        <div class="d-flex gap-2"><button class="btn btn-primary" data-x="savemel">Gerar partitura</button>${has ? '<button class="btn btn-outline-secondary" data-x="canceledit">Cancelar</button>' : ''}</div>
      </div>
      <div data-r="view" ${has ? '' : 'hidden'}>
        <div class="d-flex flex-wrap gap-2 align-items-center mb-2">
          <select class="form-select w-auto" data-r="inst" aria-label="Instrumento"><option value="guitar">Partitura + tab de violão/guitarra</option><option value="none">Só partitura</option></select>
          <button class="btn btn-primary" data-x="play">▶ Tocar melodia (piano)</button>
          <div class="form-check"><input class="form-check-input" type="checkbox" id="nt-click"><label class="form-check-label" for="nt-click">com metrônomo</label></div>
          <button class="btn btn-outline-secondary" data-x="edit">Editar melodia</button>
        </div>
        <div class="notation" data-r="paper"><p class="p-2">Carregando partitura…</p></div>
        <p class="small text-body-secondary mt-2">O nome de cada nota aparece acima dela, para quem não lê partitura ou tablatura.</p>
      </div>`;
    if (has) render();
  };

  const render = async () => {
    const paper = d.querySelector('[data-r="paper"]');
    try {
      await loadScript(ABCJS_URL);
      const notes = M.transposeMelody(M.parseMelody(song.melody), ctx.shift);
      const abc = M.melodyToAbc(notes, { title: '', bpm: song.bpm || 80, key: ctx.keyLabel });
      const opts = { responsive: 'resize', add_classes: true, paddingtop: 10, paddingbottom: 10 };
      if (d.querySelector('[data-r="inst"]').value === 'guitar') opts.tablature = [{ instrument: 'guitar', label: 'Violão', tuning: ['E,', 'A,', 'D', 'G', 'B', 'e'], highestNote: "a'" }];
      paper.innerHTML = '';
      window.ABCJS.renderAbc(paper, abc, opts);
    } catch (err) {
      paper.innerHTML = `<p class="p-2">${esc(err.message || 'Não foi possível desenhar a partitura.')}</p>`;
    }
  };

  d.onchange = (e) => { if (e.target.dataset.r === 'inst') { stop(); render(); } };
  d.onclick = async (e) => {
    const x = e.target.dataset.x;
    if (x === 'edit') { stop(); d.querySelector('[data-r="edit"]').hidden = false; d.querySelector('[data-r="view"]').hidden = true; }
    if (x === 'canceledit') draw();
    if (x === 'savemel') {
      const txt = d.querySelector('[data-r="mel"]').value.trim();
      if (!txt) { toast('Escreva ao menos uma nota.'); return; }
      try { M.parseMelody(txt); } catch (err) { toast(err.message, 'danger'); return; }
      ctx.saveMelody(txt); draw();
    }
    if (x === 'play') {
      if (player) { stop(); return; }
      e.target.textContent = 'Carregando som…';
      try { player = await playMelody(M.transposeMelody(M.parseMelody(song.melody), ctx.shift), song.bpm || 80, d.querySelector('#nt-click').checked, stop); } catch { stop(); toast('Este navegador não consegue tocar a melodia.'); return; }
      e.target.textContent = '■ Parar';
    }
  };
  draw();
}

/**
 * Toca a melodia com o sintetizador do site (piano elétrico FM) e, se pedido, um compasso de
 * contagem e o metrônomo. Retorna { synths, timer } para parar.
 */
async function playMelody(notes, bpm, click, onEnd) {
  const [{ Synth }, { PRESETS }, { resumeAudio }] = await Promise.all([import('/lib/synth/synth.js'), import('/lib/synth/presets.js'), import('/lib/audio/context.js')]);
  const ctx = await resumeAudio();
  const spb = 60 / bpm;
  const piano = await Synth.create(ctx, { engine: 'fm', params: { ...PRESETS.fm.find((p) => p.name === 'Piano elétrico (DX)').params }, fx: { reverbMix: 0.15 } });
  piano.connect(ctx.destination);
  const synths = [piano];
  const t0 = ctx.currentTime + 0.15 + (click ? 4 * spb : 0);
  const evs = [];
  let t = 0;
  for (const n of notes) {
    if (n.bar) continue;
    if (!n.rest) evs.push({ type: 'note', note: n.midi, vel: 95, at: t0 + t * spb }, { type: 'off', note: n.midi, at: t0 + (t + n.dur * 0.95) * spb });
    t += n.dur;
  }
  piano.events(evs);
  if (click) {
    const drums = await Synth.create(ctx, { engine: 'drums', params: {}, fx: { reverbMix: 0 } });
    drums.connect(ctx.destination);
    synths.push(drums);
    const clicks = [];
    for (let b = -4; b < Math.ceil(t); b++) {
      const at = t0 + b * spb, note = ((b % 4) + 4) % 4 === 0 ? 75 : 37; // clave no 1, aro nos outros
      clicks.push({ type: 'note', note, vel: note === 75 ? 110 : 90, at }, { type: 'off', note, at: at + 0.05 });
    }
    drums.events(clicks);
  }
  return { synths, timer: setTimeout(onEnd, (t0 - ctx.currentTime + t * spb + 1) * 1000) };
}
