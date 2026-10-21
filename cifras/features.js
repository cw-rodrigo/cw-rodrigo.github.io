// Recursos pesados, carregados só quando o usuário pede (microfone, modo rolagem, partitura/tab).
import * as M from './music.js?v=3';
import { toast, loadScript } from './util.js?v=3';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ABCJS_URL = 'https://cdn.jsdelivr.net/npm/abcjs@6/dist/abcjs-basic-min.js';

function makeDialog(cls = '') {
  const d = document.createElement('dialog');
  if (cls) d.className = cls;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  return d;
}

// ================= Descobrir tom pelo microfone =================

function relativeOf(key) {
  const k = M.parseKey(key);
  return k.minor ? M.keyName(k.root + 3, false) : M.keyName(k.root + 9, true);
}
const sameKey = (a, b) => a && b && M.normalizeKey(a) === M.normalizeKey(b);

async function listenForKey({ seconds = 10, onLevel, onUpdate, signal }) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 16384;
  an.smoothingTimeConstant = 0.2;
  src.connect(an);
  const freq = new Float32Array(an.frequencyBinCount);
  const time = new Float32Array(an.fftSize);
  const binHz = ctx.sampleRate / an.fftSize;
  const lo = Math.ceil(55 / binHz);
  const hi = Math.floor(2000 / binHz);
  const chroma = new Array(12).fill(0);
  const started = performance.now();
  let frames = 0;

  try {
    while (!signal.aborted) {
      await new Promise((r) => setTimeout(r, 90));
      an.getFloatTimeDomainData(time);
      let rms = 0;
      for (const v of time) rms += v * v;
      rms = Math.sqrt(rms / time.length);
      onLevel(Math.min(1, rms * 8));
      if (rms > 0.008) {
        an.getFloatFrequencyData(freq);
        for (let i = lo; i <= hi; i++) {
          const db = freq[i];
          if (db < -85 || db < freq[i - 1] || db < freq[i + 1]) continue; // só picos
          const mag = 10 ** (db / 20);
          const f = i * binHz;
          const midi = 69 + 12 * Math.log2(f / 440);
          const dev = Math.abs(midi - Math.round(midi));
          if (dev > 0.35) continue;
          chroma[M.mod12(Math.round(midi))] += mag * (1 - dev);
        }
        frames++;
      }
      const elapsed = (performance.now() - started) / 1000;
      onUpdate(frames > 5 ? M.estimateKey(chroma) : null, Math.min(1, elapsed / seconds), frames);
      if (elapsed >= seconds) break;
    }
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
  }
  return frames > 5 ? M.estimateKey(chroma) : null;
}

export function openMic(ctx) {
  const d = makeDialog();
  let ctrl = null;
  const intro = ctx.song
    ? `Toque ou cante <strong>${esc(ctx.song.title)}</strong> perto do microfone por uns 10 segundos. Vou comparar com o tom da cifra aberta${ctx.shownKey ? ` (${esc(ctx.shownKey)})` : ''}.`
    : 'Toque ou cante perto do microfone por uns 10 segundos para descobrir o tom.';
  d.innerHTML = `
    <h2>Descobrir o tom</h2>
    <p>${intro}</p>
    <div id="mic-run">
      <div class="row"><button class="btn primary" data-x="start">Começar a ouvir</button><button class="btn" data-x="close">Fechar</button></div>
    </div>
    <div id="mic-live" hidden>
      <p class="hint">Volume</p><div class="meter"><i id="lvl"></i></div>
      <p class="hint">Progresso</p><div class="meter"><i id="prog"></i></div>
      <p>Palpite agora: <strong id="guess">—</strong></p>
      <div class="row"><button class="btn" data-x="stop">Parar</button></div>
    </div>
    <div id="mic-result" hidden></div>
    <p class="hint" style="margin-top:18px">Reconhecer <em>qual</em> música está tocando precisa de um serviço externo e fica para a próxima fase.</p>`;

  const showResult = (res) => {
    const out = d.querySelector('#mic-result');
    d.querySelector('#mic-live').hidden = true;
    out.hidden = false;
    if (!res) {
      out.innerHTML = `<p>Não ouvi som suficiente. Aproxime o instrumento do microfone e tente de novo.</p>
        <div class="row"><button class="btn primary" data-x="start">Ouvir de novo</button><button class="btn" data-x="close">Fechar</button></div>`;
      return;
    }
    const best = res[0].key;
    const alt = res.slice(1, 3).map((r) => r.key).join(' ou ');
    let html = `<div class="detected">${esc(best)}</div><p class="alts">Também pode ser ${esc(alt)}.</p>`;

    if (ctx.song && ctx.originalKey) {
      const shown = ctx.shownKey;
      const origMinor = M.parseKey(ctx.originalKey).minor;
      const target = M.parseKey(best).minor === origMinor ? best : relativeOf(best);
      if (sameKey(target, shown)) {
        html += `<p><strong>Vocês estão no tom da cifra (${esc(shown)}).</strong></p>`;
      } else {
        html += `<p>Estão tocando em <strong>${esc(target)}</strong>, e a cifra aberta está em <strong>${esc(shown)}</strong>. A cifra continua aberta: escolha o que fazer.</p>
          <div class="row">
            <button class="btn primary" data-x="apply" data-k="${esc(target)}">Mudar a cifra para ${esc(target)}</button>
            ${ctx.saveToCurrentList ? `<button class="btn" data-x="savelist" data-k="${esc(target)}">Usar ${esc(target)} em “${esc(ctx.currentList.name)}”</button>` : ''}
          </div>
          <div class="row" style="margin-top:10px">
            <select id="mic-list" style="flex:1"><option value="__new">Nova lista…</option>${ctx.lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
            <button class="btn" data-x="addlist" data-k="${esc(target)}">Adicionar nesta lista em ${esc(target)}</button>
          </div>
          <p class="hint">Se a música tocada for outra, abra a cifra certa e confira de novo: o tom detectado continua valendo.</p>`;
      }
    } else if (ctx.song) {
      html += '<p class="hint">Esta cifra não tem tom original definido. Defina no editor para poder transpor automaticamente.</p>';
    } else if (ctx.songs && ctx.songs.length) {
      html += `<p>Abrir uma cifra já neste tom:</p>
        <div class="row"><select id="mic-song" style="flex:1">${ctx.songs.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR')).map((s) => `<option value="${s.id}">${esc(s.title)}${s.artist ? ' — ' + esc(s.artist) : ''}</option>`).join('')}</select>
        <button class="btn primary" data-x="opensong" data-k="${esc(best)}">Abrir em ${esc(best)}</button></div>`;
    }
    html += '<div class="row" style="margin-top:14px"><button class="btn" data-x="start">Ouvir de novo</button><button class="btn" data-x="close">Fechar</button></div>';
    out.innerHTML = html;
  };

  d.onclick = async (e) => {
    const x = e.target.dataset.x;
    const k = e.target.dataset.k;
    if (x === 'close') { ctrl?.abort(); d.close(); }
    if (x === 'stop') ctrl?.abort();
    if (x === 'apply') { ctx.applyKey(k); d.close(); }
    if (x === 'savelist') { ctx.saveToCurrentList(k); d.close(); }
    if (x === 'addlist') ctx.addToList(d.querySelector('#mic-list').value, k);
    if (x === 'opensong') { d.close(); ctx.openSongInKey(d.querySelector('#mic-song').value, k); }
    if (x === 'start') {
      if (!navigator.mediaDevices?.getUserMedia) { toast('Este navegador não dá acesso ao microfone.'); return; }
      d.querySelector('#mic-run').hidden = true;
      d.querySelector('#mic-result').hidden = true;
      d.querySelector('#mic-live').hidden = false;
      ctrl = new AbortController();
      try {
        const res = await listenForKey({
          signal: ctrl.signal,
          onLevel: (v) => { d.querySelector('#lvl').style.width = (v * 100) + '%'; },
          onUpdate: (r, p) => { d.querySelector('#prog').style.width = (p * 100) + '%'; if (r) d.querySelector('#guess').textContent = r[0].key; },
        });
        if (d.open) showResult(res);
      } catch (err) {
        d.querySelector('#mic-live').hidden = true;
        d.querySelector('#mic-run').hidden = false;
        toast(err.name === 'NotAllowedError' ? 'Permita o uso do microfone para descobrir o tom.' : 'Não foi possível usar o microfone.');
      }
    }
  };
  d.addEventListener('close', () => ctrl?.abort());
  d.showModal();
}

// ================= Modo rolagem =================

class Metronome {
  constructor(onBeat) { this.onBeat = onBeat; this.bpm = 80; this.running = false; }
  start(bpm) {
    this.bpm = bpm;
    this.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    this.ctx.resume();
    this.next = this.ctx.currentTime + 0.1;
    this.beat = 0;
    this.running = true;
    this.timer = setInterval(() => this.tick(), 25);
  }
  tick() {
    while (this.next < this.ctx.currentTime + 0.12) {
      const accent = this.beat % 4 === 0;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.frequency.value = accent ? 1500 : 1000;
      g.gain.setValueAtTime(0.0001, this.next);
      g.gain.exponentialRampToValueAtTime(accent ? 0.6 : 0.35, this.next + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, this.next + 0.05);
      o.connect(g).connect(this.ctx.destination);
      o.start(this.next); o.stop(this.next + 0.06);
      const b = this.beat % 4;
      const delay = Math.max(0, (this.next - this.ctx.currentTime) * 1000);
      setTimeout(() => this.running && this.onBeat(b), delay);
      this.next += 60 / this.bpm;
      this.beat++;
    }
  }
  stop() { this.running = false; clearInterval(this.timer); this.onBeat(-1); }
  close() { this.stop(); this.ctx?.close(); }
}

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
      <h1 style="margin:0">${esc(song.title)}</h1><p class="artist" style="margin:0 0 1.2em;color:var(--muted)">${[song.artist, 'Tom ' + ctx.keyLabel].filter(Boolean).map(esc).join(' · ')}</p>
      ${ctx.html}</div></div>
    <div class="guide" aria-hidden="true"></div>
    ${song.ytId ? `<div class="mini-video" hidden><iframe src="https://www.youtube-nocookie.com/embed/${song.ytId}?rel=0" title="Vídeo" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>` : ''}
    <div class="controls">
      <button class="btn primary" data-x="play" style="min-width:110px">▶ Rolar</button>
      <span class="grp"><button class="btn icon" data-x="slower" aria-label="Mais devagar">−</button><span class="val" id="spd"></span><button class="btn icon" data-x="faster" aria-label="Mais rápido">+</button></span>
      <span class="grp"><label for="bpm" class="hint">BPM</label><input id="bpm" type="number" min="30" max="260" value="${bpm}" style="width:76px"></span>
      <span class="grp"><button class="btn" data-x="metro" aria-pressed="false">Metrônomo</button>
        <span class="beat" data-b="0"></span><span class="beat" data-b="1"></span><span class="beat" data-b="2"></span><span class="beat" data-b="3"></span></span>
      ${song.ytId ? '<button class="btn" data-x="video">Vídeo</button>' : ''}
      <span class="grp"><button class="btn icon ghost" data-x="small" aria-label="Diminuir letra">A−</button><button class="btn icon ghost" data-x="big" aria-label="Aumentar letra">A+</button></span>
      <button class="btn" data-x="close">Fechar</button>
    </div>`;
  document.body.append(el);
  document.body.style.overflow = 'hidden';
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
    if (x === 'video') { const v = el.querySelector('.mini-video'); v.hidden = !v.hidden; }
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
  const d = makeDialog('wide');
  let synth = null;
  let visual = null;

  const draw = () => {
    const has = !!(song.melody && song.melody.trim());
    d.innerHTML = `
      <h2>Partitura e tab · ${esc(song.title)} <span class="hint">(tom ${esc(ctx.keyLabel)})</span></h2>
      <div id="nt-edit" ${has ? 'hidden' : ''}>
        <p>${has ? 'Edite a melodia principal.' : 'Esta música ainda não tem melodia. Escreva a melodia principal (introdução, solo ou a voz) para gerar a partitura e a tablatura.'}</p>
        <textarea class="code" id="nt-mel" style="min-height:110px" placeholder="E4 G4 A4:2 | B4:0.5 A4:0.5 G4 R:1">${esc(song.melody || '')}</textarea>
        <p class="hint">Nota + oitava (C4 = dó central), duração em tempos após “:” (A4:2 = mínima, B4:0.5 = colcheia), R = pausa, | = barra. Escreva no tom original da cifra; a transposição é automática.</p>
        <div class="row"><button class="btn primary" data-x="savemel">Gerar partitura</button>${has ? '<button class="btn" data-x="canceledit">Cancelar</button>' : ''}</div>
      </div>
      <div id="nt-view" ${has ? '' : 'hidden'}>
        <div class="row" style="margin-bottom:10px">
          <select id="nt-inst" style="width:auto"><option value="guitar">Partitura + tab de violão/guitarra</option><option value="none">Só partitura</option></select>
          <button class="btn primary" data-x="play">▶ Tocar melodia (piano)</button>
          <label class="row" style="gap:6px"><input type="checkbox" id="nt-click"> com metrônomo</label>
          <button class="btn" data-x="edit">Editar melodia</button>
        </div>
        <div class="notation" id="nt-paper"><p class="hint" style="padding:10px">Carregando partitura…</p></div>
        <p class="hint">O nome de cada nota aparece acima dela, para quem não lê partitura ou tablatura.</p>
      </div>
      <div class="row end" style="margin-top:14px"><button class="btn" data-x="close">Fechar</button></div>`;
    if (has) render();
  };

  const render = async () => {
    const paper = d.querySelector('#nt-paper');
    try {
      await loadScript(ABCJS_URL);
      const notes = M.transposeMelody(M.parseMelody(song.melody), ctx.shift);
      const abc = M.melodyToAbc(notes, { title: '', bpm: song.bpm || 80, key: ctx.keyLabel });
      const inst = d.querySelector('#nt-inst').value;
      const opts = { responsive: 'resize', add_classes: true, paddingtop: 10, paddingbottom: 10 };
      if (inst === 'guitar') opts.tablature = [{ instrument: 'guitar', label: 'Violão', tuning: ['E,', 'A,', 'D', 'G', 'B', 'e'], highestNote: "a'" }];
      paper.innerHTML = '';
      visual = window.ABCJS.renderAbc(paper, abc, opts)[0];
    } catch (err) {
      paper.innerHTML = `<p style="padding:10px">${esc(err.message || 'Não foi possível desenhar a partitura.')}</p>`;
    }
  };

  const stop = () => { try { synth?.stop(); } catch { /* ok */ } synth = null; const b = d.querySelector('[data-x="play"]'); if (b) b.textContent = '▶ Tocar melodia (piano)'; };

  d.onchange = (e) => { if (e.target.id === 'nt-inst') { stop(); render(); } };
  d.onclick = async (e) => {
    const x = e.target.dataset.x;
    if (x === 'close') { stop(); d.close(); }
    if (x === 'edit') { stop(); d.querySelector('#nt-edit').hidden = false; d.querySelector('#nt-view').hidden = true; }
    if (x === 'canceledit') draw();
    if (x === 'savemel') {
      const txt = d.querySelector('#nt-mel').value.trim();
      try { M.parseMelody(txt); } catch (err) { toast(err.message); return; }
      if (!txt) { toast('Escreva ao menos uma nota.'); return; }
      ctx.saveMelody(txt); draw();
    }
    if (x === 'play') {
      if (synth) { stop(); return; }
      if (!visual || !window.ABCJS?.synth?.supportsAudio()) { toast('Este navegador não consegue tocar a melodia.'); return; }
      e.target.textContent = 'Carregando som…';
      try {
        synth = new window.ABCJS.synth.CreateSynth();
        const click = d.querySelector('#nt-click').checked;
        await synth.init({
          visualObj: visual,
          options: { program: 0, ...(click ? { drum: 'dddd 76 77 77 77 110 70 70 70', drumBars: 1, drumIntro: 1 } : {}) },
        });
        await synth.prime();
        e.target.textContent = '■ Parar';
        synth.start();
      } catch {
        stop(); toast('Não foi possível carregar o som do piano.');
      }
    }
  };
  d.addEventListener('close', stop);
  draw();
  d.showModal();
}
