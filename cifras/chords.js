// Reconhecimento de acordes a partir de áudio (arquivo ou microfone), todo no navegador.
// Carregado só quando o usuário pede.
import * as M from './music.js?v=4';

// ---------------- análise (sem dependência de navegador) ----------------

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Cromagrama a partir de magnitudes lineares do espectro (só picos, 55–2000 Hz). */
export function chromaFromMags(mags, binHz) {
  const chroma = new Array(12).fill(0);
  const lo = Math.max(1, Math.ceil(55 / binHz));
  const hi = Math.min(mags.length - 2, Math.floor(2000 / binHz));
  let max = 0;
  for (let i = lo; i <= hi; i++) if (mags[i] > max) max = mags[i];
  if (!max) return chroma;
  const floor = max * 0.02;
  for (let i = lo; i <= hi; i++) {
    const m = mags[i];
    if (m < floor || m < mags[i - 1] || m < mags[i + 1]) continue;
    // interpolação parabólica para achar a frequência real do pico
    const a = mags[i - 1], b = m, c = mags[i + 1];
    const den = a - 2 * b + c;
    const off = den ? 0.5 * (a - c) / den : 0;
    const f = (i + off) * binHz;
    const midi = 69 + 12 * Math.log2(f / 440);
    const dev = Math.abs(midi - Math.round(midi));
    if (dev > 0.4) continue;
    // graves pesam um pouco mais (a fundamental do acorde costuma estar lá)
    const w = f < 260 ? 1.4 : 1;
    chroma[M.mod12(Math.round(midi))] += Math.sqrt(m) * (1 - dev) * w;
  }
  return chroma;
}

const TYPES = [
  { suffix: '', iv: [[0, 1], [4, 0.85], [7, 0.8]], bias: 1 },
  { suffix: 'm', iv: [[0, 1], [3, 0.85], [7, 0.8]], bias: 1 },
  { suffix: '7', iv: [[0, 1], [4, 0.8], [7, 0.75], [10, 0.6]], bias: 0.94 },
  { suffix: 'm7', iv: [[0, 1], [3, 0.8], [7, 0.75], [10, 0.6]], bias: 0.94 },
];
const TEMPLATES = [];
for (let r = 0; r < 12; r++) {
  for (const t of TYPES) {
    const v = new Array(12).fill(0);
    for (const [i, w] of t.iv) v[M.mod12(r + i)] = w;
    const n = Math.hypot(...v);
    TEMPLATES.push({ root: r, type: t.suffix, v: v.map((x) => x / n), bias: t.bias });
  }
}

function diatonicSet(key) {
  const k = key && M.parseKey(key);
  if (!k) return null;
  const r = k.minor ? M.mod12(k.root + 3) : k.root; // relativo maior
  const set = new Set();
  [[0, ''], [2, 'm'], [4, 'm'], [5, ''], [7, ''], [7, '7'], [9, 'm'], [2, 'm7'], [9, 'm7'], [4, 'm7']]
    .forEach(([i, t]) => set.add(M.mod12(r + i) + t));
  return set;
}

/** Melhor acorde para um cromagrama. */
export function classify(chroma, key) {
  const n = Math.hypot(...chroma);
  if (!n) return { label: 'N', score: 0 };
  const c = chroma.map((x) => x / n);
  const dia = diatonicSet(key);
  let best = null;
  for (const t of TEMPLATES) {
    let s = 0;
    for (let i = 0; i < 12; i++) s += c[i] * t.v[i];
    s *= t.bias;
    if (dia && dia.has(t.root + t.type)) s += 0.04;
    if (!best || s > best.score) best = { root: t.root, type: t.type, score: s };
  }
  return { ...best, label: best.root + ':' + best.type };
}

export function chordName(label, key) {
  if (label === 'N') return 'N';
  const [r, t] = label.split(':');
  const k = key && M.parseKey(key);
  const flats = k ? M.usesFlats(k.root, k.minor) : false;
  return (flats ? M.FLATS : M.SHARPS)[Number(r)] + t;
}

/**
 * Converte quadros [{t, chroma, energy}] em segmentos de acordes [{start, end, chord}] e o tom.
 */
export function framesToChords(frames, { hop = 0.1, minDur = 0.45 } = {}) {
  if (!frames.length) return { key: '', segments: [] };
  const total = new Array(12).fill(0);
  const energies = frames.map((f) => f.energy).sort((a, b) => a - b);
  const loud = energies[Math.floor(energies.length * 0.5)] || 0;
  const silent = loud * 0.12;
  for (const f of frames) if (f.energy > silent) f.chroma.forEach((v, i) => { total[i] += v; });
  const key = M.estimateKey(total)[0].key;

  // média móvel do cromagrama (~0,5 s) antes de classificar
  const W = Math.max(1, Math.round(0.25 / hop));
  const labels = frames.map((f, i) => {
    if (f.energy <= silent) return 'N';
    const avg = new Array(12).fill(0);
    for (let j = Math.max(0, i - W); j <= Math.min(frames.length - 1, i + W); j++) {
      if (frames[j].energy > silent) frames[j].chroma.forEach((v, k) => { avg[k] += v; });
    }
    return classify(avg, key).label;
  });

  // filtro de moda para tirar oscilações rápidas
  const R = Math.max(1, Math.round(0.3 / hop));
  const smooth = labels.map((_, i) => {
    const count = {};
    let best = labels[i], bc = 0;
    for (let j = Math.max(0, i - R); j <= Math.min(labels.length - 1, i + R); j++) {
      const l = labels[j];
      count[l] = (count[l] || 0) + 1;
      if (count[l] > bc || (count[l] === bc && l === labels[i])) { bc = count[l]; best = l; }
    }
    return best;
  });

  let segs = [];
  for (let i = 0; i < smooth.length; i++) {
    const t = frames[i].t;
    const last = segs[segs.length - 1];
    if (last && last.label === smooth[i]) last.end = t + hop;
    else segs.push({ label: smooth[i], start: t, end: t + hop });
  }
  // junta segmentos curtos ao vizinho mais longo
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    let idx = -1, shortest = Infinity;
    segs.forEach((s, i) => { const d = s.end - s.start; if (d < minDur && d < shortest) { shortest = d; idx = i; } });
    if (idx >= 0) {
      const prev = segs[idx - 1], next = segs[idx + 1];
      const target = !prev ? next : !next ? prev : (prev.end - prev.start >= next.end - next.start ? prev : next);
      if (target === prev) prev.end = segs[idx].end; else next.start = segs[idx].start;
      segs.splice(idx, 1);
      // une vizinhos iguais
      segs = segs.reduce((acc, s) => { const l = acc[acc.length - 1]; if (l && l.label === s.label) l.end = s.end; else acc.push({ ...s }); return acc; }, []);
      changed = true;
    }
  }
  return { key, segments: segs.map((s) => ({ start: s.start, end: s.end, chord: chordName(s.label, key) })) };
}

function mmss(t) { const s = Math.max(0, Math.floor(t)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

/** Monta um rascunho ChordPro: uma linha a cada 4 compassos, com o tempo do trecho. */
export function segmentsToChordPro(segments, bpm = 80) {
  const segs = segments.filter((s) => s.chord !== 'N');
  if (!segs.length) return '';
  const line = (4 * 4 * 60) / (bpm || 80);
  const out = ['{comment: Rascunho gerado pelo áudio — confira os acordes}', ''];
  let cur = -1;
  let row = [];
  let block = 0;
  const flush = () => {
    if (!row.length) return;
    if (block % 4 === 0) { if (block) out.push(''); out.push(`{comment: ${mmss(cur * line)}}`); }
    out.push(row.map((c) => `[${c}]`).join(' '));
    row = []; block++;
  };
  for (const s of segs) {
    const li = Math.floor(s.start / line);
    if (li !== cur) { flush(); cur = li; }
    if (row[row.length - 1] !== s.chord) row.push(s.chord);
  }
  flush();
  return out.join('\n') + '\n';
}

/** Analisa amostras mono. `onProgress(0..1)`; cede o processador de tempos em tempos. */
export async function analyzeSamples(samples, sampleRate, onProgress = () => {}) {
  const factor = Math.max(1, Math.round(sampleRate / 22050));
  const sr = sampleRate / factor;
  const len = Math.floor(samples.length / factor);
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += samples[i * factor + k];
    x[i] = s / factor;
  }
  const N = 8192;
  const hopN = 2048;
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const re = new Float64Array(N), im = new Float64Array(N);
  const mags = new Float64Array(N / 2);
  const binHz = sr / N;
  const frames = [];
  for (let start = 0, n = 0; start + N <= len; start += hopN, n++) {
    let e = 0;
    for (let i = 0; i < N; i++) { const v = x[start + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    fft(re, im);
    for (let i = 0; i < N / 2; i++) mags[i] = Math.hypot(re[i], im[i]);
    frames.push({ t: (start + N / 2) / sr, chroma: chromaFromMags(mags, binHz), energy: Math.sqrt(e / N) });
    if (n % 40 === 0) { onProgress(start / len); await new Promise((r) => setTimeout(r, 0)); }
  }
  onProgress(1);
  return { frames, hop: hopN / sr };
}

// ---------------- interface (navegador) ----------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class StreamChords {
  /** Analisa um MediaStream em tempo real. `getTime()` dá o tempo da música (padrão: tempo decorrido). */
  async start(stream, onFrame, getTime = null) {
    this.stream = stream;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(stream);
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = 16384;
    this.an.smoothingTimeConstant = 0;
    src.connect(this.an);
    const db = new Float32Array(this.an.frequencyBinCount);
    const mags = new Float32Array(this.an.frequencyBinCount);
    const time = new Float32Array(this.an.fftSize);
    const binHz = this.ctx.sampleRate / this.an.fftSize;
    this.frames = [];
    this.t0 = performance.now();
    this.timer = setInterval(() => {
      this.an.getFloatFrequencyData(db);
      for (let i = 0; i < db.length; i++) mags[i] = 10 ** (db[i] / 20);
      this.an.getFloatTimeDomainData(time);
      let e = 0;
      for (const v of time) e += v * v;
      const t = getTime ? getTime() : (performance.now() - this.t0) / 1000;
      const frame = { t, chroma: chromaFromMags(mags, binHz), energy: Math.sqrt(e / time.length) };
      this.frames.push(frame);
      onFrame(frame, this.frames);
    }, 100);
  }
  stop() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    return this.frames || [];
  }
}

/** O navegador consegue capturar o áudio da própria aba? (Chrome/Edge no computador) */
export function canCaptureTab() {
  return !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
}

/** Pede para compartilhar o áudio desta aba, sem tocar o som nos alto-falantes. */
async function captureThisTab() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' },
    audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    preferCurrentTab: true, selfBrowserSurface: 'include', systemAudio: 'include', surfaceSwitching: 'exclude',
  });
  stream.getVideoTracks().forEach((t) => t.stop());
  const audio = stream.getAudioTracks();
  if (!audio.length) throw Object.assign(new Error('sem áudio'), { name: 'NoAudio' });
  return new MediaStream(audio);
}

/**
 * Abre o gerador de rascunho.
 * ctx: { mode: 'file'|'mic', bpm, title, hasContent, renderSheet(text), onApply({ text, key, bpm, append }), toast }
 */
export function openChordGenerator(ctx) {
  const d = document.createElement('dialog');
  d.className = 'wide';
  document.body.append(d);
  let mic = null;
  let audioUrl = null;
  let result = null; // { key, segments }
  let bpm = ctx.bpm || 80;
  let follow = null;
  const cleanup = () => {
    mic?.stop(); mic = null; clearInterval(follow);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    if (tabRun) tabRun.finish(true);
  };
  let tabRun = null;
  d.addEventListener('close', () => { cleanup(); d.remove(); });

  const intro = ctx.mode === 'file'
    ? `<p>Escolha um arquivo de áudio (MP3, M4A, WAV…) de <strong>${esc(ctx.title || 'a música')}</strong>. A análise acontece no seu aparelho; o arquivo não é enviado para lugar nenhum.</p>
       <label class="btn primary">Escolher arquivo de áudio<input type="file" accept="audio/*,video/mp4" data-x="file" hidden></label>`
    : ctx.mode === 'tab'
      ? `<p>O vídeo de <strong>${esc(ctx.title || 'a música')}</strong> toca no player do site em velocidade 2x (o tom não muda) e o app escuta o áudio desta aba. Nada é baixado.</p>
         <p class="hint">O navegador vai pedir para compartilhar esta aba: deixe marcada a opção de <strong>compartilhar o áudio da guia</strong>. O som fica mudo enquanto analisa.</p>
         <button class="btn primary" data-x="tab-start">Analisar o vídeo</button>`
      : `<p>Deixe a música tocar perto do microfone, ou toque você mesmo. Os acordes vão sendo anotados enquanto você ouve; pare quando a música acabar.</p>
       <button class="btn primary" data-x="mic-start">Começar a ouvir</button>`;

  d.innerHTML = `
    <h2>${{ file: 'Gerar cifra pelo arquivo de áudio', tab: 'Gerar cifra pelo vídeo', mic: 'Gerar cifra pelo microfone' }[ctx.mode]}</h2>
    <div id="cg-start">${intro}</div>
    <div id="cg-work" hidden>
      <p id="cg-msg" class="hint"></p>
      <div class="meter"><i id="cg-bar"></i></div>
      <div id="cg-live" hidden><div class="detected" id="cg-now">—</div><p class="hint">Tempo: <span id="cg-time">0:00</span></p>
        <button class="btn primary" data-x="${ctx.mode === 'tab' ? 'tab-stop' : 'mic-stop'}">Parar e gerar a cifra</button></div>
    </div>
    <div id="cg-result" hidden></div>
    <p class="hint" style="margin-top:14px">O resultado é um rascunho só com os acordes (sem a letra). Funciona melhor com gravações limpas, poucos instrumentos e sem muita distorção. Confira e corrija no editor.</p>
    <div class="row end" style="margin-top:10px"><button class="btn" data-x="close">Fechar</button></div>`;

  const show = (id) => ['cg-start', 'cg-work', 'cg-result'].forEach((x) => { d.querySelector('#' + x).hidden = x !== id; });

  const drawResult = () => {
    show('cg-result');
    const text = segmentsToChordPro(result.segments, bpm);
    const out = d.querySelector('#cg-result');
    if (!text) {
      out.innerHTML = '<p>Não consegui reconhecer acordes. Tente um trecho com o som mais alto ou mais limpo.</p>';
      return;
    }
    const distinct = [...new Set(result.segments.filter((s) => s.chord !== 'N').map((s) => s.chord))];
    out.innerHTML = `
      <div class="row" style="align-items:flex-end;gap:18px">
        <div><span class="hint">Tom provável</span><div class="detected" style="font-size:2.2rem;margin:0">${esc(result.key)}</div></div>
        <label class="field" style="margin:0"><span>Andamento (BPM)</span><input type="number" id="cg-bpm" min="30" max="260" value="${bpm}" style="width:100px"></label>
        <p class="hint" style="margin:0;flex:1 1 200px">Acordes encontrados: ${distinct.map(esc).join(', ')}. O BPM só define quantos acordes vão em cada linha.</p>
      </div>
      ${audioUrl ? `<div style="margin:14px 0"><audio controls src="${audioUrl}" style="width:100%" id="cg-audio"></audio></div>` : ''}
      ${audioUrl || ctx.mode === 'tab' ? `<p>Acorde agora: <strong id="cg-follow" style="color:var(--chord);font-size:1.4rem">—</strong>
        ${ctx.mode === 'tab' ? '<span class="hint"> — dê play no vídeo do player para conferir de ouvido.</span>' : ''}</p>` : ''}
      <div class="sheet" style="max-height:40vh;overflow:auto;margin:12px 0">${ctx.renderSheet(text)}</div>
      <div class="row">
        <button class="btn primary" data-x="apply">${ctx.hasContent ? 'Substituir a cifra atual' : 'Usar esta cifra'}</button>
        ${ctx.hasContent ? '<button class="btn" data-x="append">Adicionar ao fim da cifra</button>' : ''}
      </div>`;
    const segAt = (t) => result.segments.find((x) => t >= x.start && t < x.end);
    clearInterval(follow);
    if (ctx.mode === 'tab' && ctx.player) {
      follow = setInterval(() => {
        const el = d.querySelector('#cg-follow');
        const p = ctx.player.api();
        if (!el || !p?.getCurrentTime) return;
        const s = segAt(p.getCurrentTime());
        el.textContent = s && s.chord !== 'N' ? s.chord : '—';
      }, 200);
    }
    const audio = d.querySelector('#cg-audio');
    if (audio) {
      audio.ontimeupdate = () => {
        const s = result.segments.find((x) => audio.currentTime >= x.start && audio.currentTime < x.end);
        d.querySelector('#cg-follow').textContent = s && s.chord !== 'N' ? s.chord : '—';
      };
    }
  };

  d.onchange = async (e) => {
    if (e.target.id === 'cg-bpm') { bpm = Math.min(260, Math.max(30, Number(e.target.value) || 80)); drawResult(); return; }
    if (e.target.dataset.x !== 'file' || !e.target.files[0]) return;
    const file = e.target.files[0];
    show('cg-work');
    const msg = d.querySelector('#cg-msg');
    const bar = d.querySelector('#cg-bar');
    msg.textContent = 'Lendo o arquivo…';
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const buf = await ac.decodeAudioData(await file.arrayBuffer());
      ac.close();
      const mono = new Float32Array(buf.length);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
      }
      msg.textContent = `Analisando ${mmss(buf.duration)} de áudio…`;
      const { frames, hop } = await analyzeSamples(mono, buf.sampleRate, (p) => { bar.style.width = (p * 100) + '%'; });
      result = framesToChords(frames, { hop });
      audioUrl = URL.createObjectURL(file);
      drawResult();
    } catch {
      show('cg-start');
      ctx.toast('Não consegui ler esse arquivo. Tente outro formato, como MP3 ou WAV.');
    }
  };

  async function startTab() {
    if (!canCaptureTab()) { ctx.toast('Capturar o áudio da aba só funciona no Chrome ou Edge do computador.'); return; }
    let stream;
    try {
      // abre o vídeo no player do site (parado) antes de pedir a captura
      await ctx.player.play(ctx.song, { autoplay: false });
      stream = await captureThisTab();
    } catch (err) {
      ctx.toast(err.name === 'NoAudio' ? 'O áudio não foi compartilhado. Tente de novo e deixe marcada a opção de compartilhar o áudio da guia.'
        : err.name === 'NotAllowedError' ? 'Compartilhamento cancelado.' : (err.message || 'Não foi possível capturar o áudio da aba.'));
      return;
    }
    const p = ctx.player.api();
    show('cg-work');
    d.querySelector('#cg-live').hidden = false;
    d.querySelector('#cg-msg').textContent = 'Analisando o vídeo em 2x… pode deixar esta janela aberta.';
    const bar = d.querySelector('#cg-bar');
    const rates = p.getAvailablePlaybackRates?.() || [1];
    const rate = rates.includes(2) ? 2 : Math.max(...rates);
    mic = new StreamChords();
    let done = false;
    tabRun = {
      finish: (aborted) => {
        if (done) return;
        done = true;
        ctx.player.setOnEnded(null);
        try { p.pauseVideo(); p.setPlaybackRate(1); } catch { /* ok */ }
        const frames = mic ? mic.stop() : [];
        mic = null; tabRun = null;
        if (aborted || !d.open) return;
        if (frames.length < 20) { show('cg-start'); ctx.toast('Ouvi muito pouco do vídeo. Confira se o áudio da guia foi compartilhado.'); return; }
        result = framesToChords(frames, { hop: 0.1 * rate });
        drawResult();
      },
    };
    stream.getAudioTracks()[0].addEventListener('ended', () => tabRun?.finish(false));
    ctx.player.setOnEnded(() => tabRun?.finish(false));
    const dur = p.getDuration?.() || 0;
    await mic.start(stream, (frame, frames) => {
      if (dur) bar.style.width = Math.min(100, (frame.t / dur) * 100) + '%';
      d.querySelector('#cg-time').textContent = `${mmss(frame.t)}${dur ? ' de ' + mmss(dur) : ''}`;
      if (frame.energy < 0.004) return;
      const avg = new Array(12).fill(0);
      frames.slice(-4).forEach((f) => f.chroma.forEach((v, i) => { avg[i] += v; }));
      d.querySelector('#cg-now').textContent = chordName(classify(avg).label);
    }, () => p.getCurrentTime?.() || 0);
    p.seekTo(0, true);
    p.setPlaybackRate(rate);
    p.playVideo();
  }

  d.onclick = async (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'close') d.close();
    if (x === 'mic-start') {
      if (!navigator.mediaDevices?.getUserMedia) { ctx.toast('Este navegador não dá acesso ao microfone.'); return; }
      show('cg-work');
      d.querySelector('#cg-msg').textContent = 'Ouvindo… o acorde mostrado é o que está soando agora.';
      d.querySelector('#cg-live').hidden = false;
      const bar = d.querySelector('#cg-bar');
      mic = new StreamChords();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        await mic.start(stream, (frame, frames) => {
          bar.style.width = Math.min(100, frame.energy * 800) + '%';
          d.querySelector('#cg-time').textContent = mmss(frame.t);
          const recent = frames.slice(-6);
          if (frame.energy < 0.006) { d.querySelector('#cg-now').textContent = '—'; return; }
          const avg = new Array(12).fill(0);
          recent.forEach((f) => f.chroma.forEach((v, i) => { avg[i] += v; }));
          d.querySelector('#cg-now').textContent = chordName(classify(avg).label);
        });
      } catch (err) {
        mic = null; show('cg-start');
        ctx.toast(err.name === 'NotAllowedError' ? 'Permita o uso do microfone para gerar a cifra.' : 'Não foi possível usar o microfone.');
      }
    }
    if (x === 'tab-start') await startTab();
    if (x === 'tab-stop' && tabRun) tabRun.finish(false);
    if (x === 'mic-stop' && mic) {
      const frames = mic.stop();
      mic = null;
      if (frames.length < 20) { show('cg-start'); ctx.toast('Ouvi muito pouco. Deixe tocar por mais tempo.'); return; }
      result = framesToChords(frames, { hop: 0.1 });
      drawResult();
    }
    if (x === 'apply' || x === 'append') {
      ctx.onApply({ text: segmentsToChordPro(result.segments, bpm), key: result.key, bpm, append: x === 'append' });
      d.close();
    }
  };
  // No modo vídeo a janela não pode cobrir o player do YouTube: abre ao lado, sem fundo escuro.
  if (ctx.mode === 'tab') { d.classList.add('side'); d.show(); } else d.showModal();
}
