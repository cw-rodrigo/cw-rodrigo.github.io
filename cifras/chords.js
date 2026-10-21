// Reconhecimento de acordes a partir de áudio (arquivo ou microfone), todo no navegador.
// Carregado só quando o usuário pede.
import * as M from './music.js?v=10';
import * as LY from './lyrics.js?v=10';

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
export function chromaFromMags(mags, binHz, loHz = 55, hiHz = 2000) {
  const chroma = new Array(12).fill(0);
  const lo = Math.max(1, Math.ceil(loHz / binHz));
  const hi = Math.min(mags.length - 2, Math.floor(hiHz / binHz));
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
/** Nota mais forte do baixo (ou -1 se o baixo estiver fraco/indefinido). */
function bassNote(bass) {
  if (!bass) return -1;
  let total = 0, top = 0, pc = -1;
  for (let i = 0; i < 12; i++) { total += bass[i]; if (bass[i] > top) { top = bass[i]; pc = i; } }
  return total && top / total > 0.3 ? pc : -1;
}

/** Melhor acorde para um cromagrama. Com o cromagrama do baixo, a nota do baixo ajuda a decidir a fundamental. */
export function classify(chroma, key, bass = null) {
  const n = Math.hypot(...chroma);
  if (!n) return { label: 'N', score: 0 };
  const c = chroma.map((x) => x / n);
  const dia = diatonicSet(key);
  const bn = bassNote(bass);
  let best = null;
  for (const t of TEMPLATES) {
    let s = 0;
    for (let i = 0; i < 12; i++) s += c[i] * t.v[i];
    s *= t.bias;
    if (dia && dia.has(t.root + t.type)) s += 0.04;
    if (bn >= 0) {
      if (bn === t.root) s += 0.1;
      else if (t.v[bn] > 0) s += 0.02; // baixo numa nota do acorde (inversão)
      else s -= 0.05;
    }
    if (!best || s > best.score) best = { root: t.root, type: t.type, score: s };
  }
  // inversão: baixo firme numa nota do acorde que não é a fundamental -> acorde com baixo (ex.: D/F#)
  const tpl = TEMPLATES.find((t) => t.root === best.root && t.type === best.type);
  const slash = bn >= 0 && bn !== best.root && tpl.v[bn] > 0 ? '/' + bn : '';
  return { ...best, label: best.root + ':' + best.type + slash };
}

export function chordName(label, key) {
  if (label === 'N') return 'N';
  const [r, rest] = label.split(':');
  const [t, b] = rest.split('/');
  const k = key && M.parseKey(key);
  const names = k && M.usesFlats(k.root, k.minor) ? M.FLATS : M.SHARPS;
  return names[Number(r)] + t + (b !== undefined ? '/' + names[Number(b)] : '');
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
    const bass = f.bass ? new Array(12).fill(0) : null;
    for (let j = Math.max(0, i - W); j <= Math.min(frames.length - 1, i + W); j++) {
      if (frames[j].energy > silent) {
        frames[j].chroma.forEach((v, k) => { avg[k] += v; });
        if (bass && frames[j].bass) frames[j].bass.forEach((v, k) => { bass[k] += v; });
      }
    }
    return classify(avg, key, bass).label;
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

function decimate(samples, factor) {
  const len = Math.floor(samples.length / factor);
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += samples[i * factor + k];
    x[i] = s / factor;
  }
  return x;
}

/**
 * Analisa amostras mono. `onProgress(0..1)`; cede o processador de tempos em tempos.
 * Com `bassSamples` (faixa do baixo separada), cada quadro ganha também o cromagrama do baixo.
 */
export async function analyzeSamples(samples, sampleRate, onProgress = () => {}, bassSamples = null) {
  const factor = Math.max(1, Math.round(sampleRate / 22050));
  const sr = sampleRate / factor;
  const x = decimate(samples, factor);
  const xb = bassSamples ? decimate(bassSamples, factor) : null;
  const len = x.length;
  const bre = xb ? new Float64Array(8192) : null, bim = xb ? new Float64Array(8192) : null;
  const bmags = xb ? new Float64Array(4096) : null;
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
    const frame = { t: (start + N / 2) / sr, chroma: chromaFromMags(mags, binHz), energy: Math.sqrt(e / N) };
    if (xb) {
      for (let i = 0; i < N; i++) { bre[i] = xb[start + i] * win[i]; bim[i] = 0; }
      fft(bre, bim);
      for (let i = 0; i < N / 2; i++) bmags[i] = Math.hypot(bre[i], bim[i]);
      frame.bass = chromaFromMags(bmags, binHz, 30, 330);
    }
    frames.push(frame);
    if (n % 40 === 0) { onProgress(start / len); await new Promise((r) => setTimeout(r, 0)); }
  }
  onProgress(1);
  return { frames, hop: hopN / sr };
}

// ---------------- interface (navegador) ----------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class StreamChords {
  /**
   * Analisa um MediaStream em tempo real. `getTime()` dá o tempo da música (padrão: tempo decorrido).
   * Com `record`, guarda também o áudio bruto (para transcrever a letra depois).
   */
  async start(stream, onFrame, getTime = null, { record = false } = {}) {
    this.stream = stream;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(stream);
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = 16384;
    this.an.smoothingTimeConstant = 0;
    src.connect(this.an);
    this.pcm = [];
    this.pcmStart = null;
    this.timeline = [];
    if (record) {
      const sp = this.ctx.createScriptProcessor(4096, 2, 2);
      this.pcmR = [];
      sp.onaudioprocess = (e) => {
        if (this.pcmStart === null) this.pcmStart = e.playbackTime;
        const ib = e.inputBuffer;
        this.pcm.push(new Float32Array(ib.getChannelData(0)));
        this.pcmR.push(new Float32Array(ib.numberOfChannels > 1 ? ib.getChannelData(1) : ib.getChannelData(0)));
      };
      src.connect(sp);
      sp.connect(this.ctx.destination); // a saída fica em silêncio; só precisa estar ligada
      this.sp = sp;
    }
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
      this.timeline.push({ ctx: this.ctx.currentTime, t });
      const frame = { t, chroma: chromaFromMags(mags, binHz), energy: Math.sqrt(e / time.length) };
      this.frames.push(frame);
      onFrame(frame, this.frames);
    }, 100);
  }
  /** Áudio gravado + conversão do tempo da gravação para o tempo da música. */
  recording() {
    if (!this.pcm.length) return null;
    const n = this.pcm.reduce((k, c) => k + c.length, 0);
    const L = new Float32Array(n), R = new Float32Array(n);
    let o = 0;
    this.pcm.forEach((c, k) => { L.set(c, o); R.set(this.pcmR[k], o); o += c.length; });
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = (L[i] + R[i]) / 2;
    const tl = this.timeline;
    const start = this.pcmStart || 0;
    const toMusicTime = (w) => {
      const c = start + w;
      if (!tl.length) return w;
      const i = tl.findIndex((p) => p.ctx >= c);
      if (i === -1) { const z = tl[tl.length - 1]; return z.t + (c - z.ctx); }
      if (i === 0) return tl[0].t + (c - tl[0].ctx);
      const a = tl[i - 1], b = tl[i];
      return a.t + ((c - a.ctx) / (b.ctx - a.ctx || 1)) * (b.t - a.t);
    };
    return { samples, channels: [L, R], sampleRate: this.sampleRate || 48000, toMusicTime };
  }
  stop() {
    clearInterval(this.timer);
    this.sampleRate = this.ctx?.sampleRate;
    this.sp?.disconnect();
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
 * Abre o gerador de rascunho (acordes + letra).
 * ctx: { mode: 'file'|'mic'|'tab', song:{title,artist,ytId}, player, bpm, title, hasContent,
 *        renderSheet(text), onApply({ text, key, bpm, append }), toast }
 */
export function openChordGenerator(ctx) {
  const d = document.createElement('dialog');
  d.className = 'wide';
  document.body.append(d);
  let mic = null;
  let audioUrl = null;
  let result = null; // { key, segments }
  let audio = null; // { samples, sampleRate, toMusicTime, rate } para transcrever a letra
  let rec = null; // áudio original (estéreo) para separar as faixas depois
  let duration = 0;
  let bpm = ctx.bpm || 80;
  let follow = null;
  let tabRun = null;
  const song = ctx.song || { title: ctx.title || '', artist: '' };
  const lyr = { status: 'idle', lines: [], plain: '', source: '', info: '', offset: 0, include: true, msg: '', title: song.title || '', artist: song.artist || '', model: 0, lang: 'portuguese' };
  const cleanup = () => {
    mic?.stop(); mic = null; clearInterval(follow);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    if (tabRun) tabRun.finish(true);
  };
  d.addEventListener('close', () => { cleanup(); d.remove(); });

  const intro = ctx.mode === 'file'
    ? `<p>Escolha um arquivo de áudio (MP3, M4A, WAV…) de <strong>${esc(song.title || 'a música')}</strong>. A análise acontece no seu aparelho; o arquivo não é enviado para lugar nenhum.</p>
       <label class="check" style="margin:8px 0"><input type="checkbox" id="cg-sep"> Separar as faixas com IA para acordes mais precisos (sem voz, bateria e com o baixo ajudando). A letra continua vindo do banco quando ela existir. Mais lento: cerca de 85 MB na primeira vez e alguns minutos por música.</label>
       <label class="btn primary">Escolher arquivo de áudio<input type="file" accept="audio/*,video/mp4" data-x="file" hidden></label>`
    : ctx.mode === 'tab'
      ? `<p>O vídeo de <strong>${esc(song.title || 'a música')}</strong> toca no player do site e o app escuta o áudio desta aba. Nada é baixado.</p>
         <p id="cg-prelyr" class="hint">Procurando a letra no LRCLIB…</p>
         <label class="check" style="margin:8px 0"><input type="checkbox" id="cg-slow"> Analisar em velocidade normal, para transcrever a letra com IA (leva o tempo da música)</label>
         <label class="check" style="margin:8px 0"><input type="checkbox" id="cg-sep"> Separar as faixas com IA para acordes mais precisos (sem voz, bateria e com o baixo ajudando). A letra continua vindo do banco quando ela existir. Mais lento: cerca de 85 MB na primeira vez e alguns minutos por música.</label>
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
    <p class="hint" style="margin-top:14px">O resultado é um rascunho: os acordes vêm do áudio e a letra vem do banco de letras LRCLIB ou, se ela não estiver lá, da transcrição por IA. Confira e corrija no editor.</p>
    <div class="row end" style="margin-top:10px"><button class="btn" data-x="close">Fechar</button></div>`;

  const show = (id) => ['cg-start', 'cg-work', 'cg-result'].forEach((x) => { d.querySelector('#' + x).hidden = x !== id; });

  // ---------- letra ----------
  async function searchLyrics() {
    lyr.status = 'searching'; renderLyrics();
    try {
      const found = await LY.findLyrics({ title: lyr.title, artist: lyr.artist, duration });
      if (found && (found.lines.length || found.plain)) {
        Object.assign(lyr, { status: 'found', lines: found.lines, plain: found.plain, source: 'do LRCLIB', include: true, offset: 0,
          info: `“${found.track}” — ${found.artist}${found.lines.length ? '' : ' (sem tempo)'}` });
        // vídeo com introdução diferente da gravação do banco: sugere um ajuste inicial
        if (found.lines.length && duration && found.duration && Math.abs(duration - found.duration) > 3) lyr.offset = Math.round((duration - found.duration) * 2) / 2;
      } else Object.assign(lyr, { status: 'notfound', lines: [], plain: '' });
    } catch (err) {
      Object.assign(lyr, { status: 'error', lines: [], plain: '', msg: err.message });
    }
    renderLyrics(); renderPreview(); updatePreLyrics();
  }

  async function runWhisper() {
    if (!audio) return;
    lyr.status = 'transcribing'; lyr.msg = 'Preparando o áudio…'; renderLyrics();
    try {
      const W = await import('./whisper.js?v=10');
      const a16 = await W.to16k(audio.samples, audio.sampleRate);
      const chunks = await W.transcribe(a16, {
        model: W.MODELS[lyr.model].id, language: lyr.lang,
        onStatus: (m) => { lyr.msg = m; const el = d.querySelector('#ly-msg'); if (el) el.textContent = m; },
      });
      const lines = LY.whisperToLines(chunks).map((l) => ({ ...l, t: audio.toMusicTime(l.t), end: audio.toMusicTime(l.end) }));
      if (!lines.length) throw new Error('vazio');
      const aligned = lyr.plain && lyr.source === 'do LRCLIB' ? LY.alignPlainToTimed(lyr.plain, lines) : [];
      if (aligned.length) Object.assign(lyr, { status: 'found', lines: aligned, include: true, offset: 0, info: lyr.info.replace(' (sem tempo)', '') + ' — tempo das linhas encontrado pela IA' });
      else Object.assign(lyr, { status: 'found', lines, plain: '', source: 'transcrita por IA', include: true, offset: 0, info: 'Transcrita por IA — confira as palavras.' });
    } catch (err) {
      lyr.status = 'whisper-error';
      lyr.msg = err.message === 'vazio' ? 'A IA não reconheceu nenhuma letra.' : 'Não foi possível transcrever: ' + err.message;
    }
    renderLyrics(); renderPreview();
  }

  const W_MODELS = ['Rápido (download menor)', 'Mais preciso (download maior, mais lento)'];
  function whisperControls() {
    if (!audio || audio.rate > 1) {
      return ctx.mode === 'tab'
        ? '<p class="hint">Para transcrever a letra com IA, analise de novo marcando “velocidade normal”.</p>'
        : '';
    }
    return `<div class="row" style="margin-top:8px">
      <select id="ly-model" style="width:auto">${W_MODELS.map((m, i) => `<option value="${i}" ${i === lyr.model ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <select id="ly-lang" style="width:auto">${[['portuguese', 'Português'], ['english', 'Inglês'], ['spanish', 'Espanhol']].map(([v, l]) => `<option value="${v}" ${v === lyr.lang ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn" data-x="whisper" ${lyr.status === 'transcribing' ? 'disabled' : ''}>${lyr.plain && !lyr.lines.length ? 'Encaixar a letra com IA' : 'Transcrever a letra com IA'}</button></div>
      <p class="hint">A IA roda no seu aparelho${audio.vocals ? ' e vai ouvir só a faixa da voz' : '. Voz com muitos instrumentos atrás gera erros; separar as faixas antes ajuda'}. No celular pode demorar bastante.</p>`;
  }

  function renderLyrics() {
    const box = d.querySelector('#cg-lyrics');
    if (!box) return;
    let html = '<h3 style="margin:0 0 6px">Letra</h3>';
    if (lyr.status === 'searching' || lyr.status === 'idle') html += '<p class="hint">Procurando a letra no LRCLIB…</p>';
    else if (lyr.status === 'transcribing') html += `<p id="ly-msg">${esc(lyr.msg)}</p><div class="meter"><i style="width:100%;opacity:.4"></i></div>`;
    else if (lyr.status === 'found') {
      html += `<p>${lyr.source === 'do LRCLIB' ? 'Encontrada no LRCLIB: ' : ''}${esc(lyr.info)}</p>
        <label class="check"><input type="checkbox" id="ly-inc" ${lyr.include ? 'checked' : ''}> Incluir a letra na cifra</label>`;
      if (lyr.lines.length && lyr.include) {
        html += `<div class="row" style="margin-top:8px"><span>Sincronia da letra</span>
          <button class="btn small icon" data-x="ly-minus" aria-label="Letra meio segundo antes">−</button>
          <span style="min-width:4.5em;text-align:center;font-variant-numeric:tabular-nums">${lyr.offset > 0 ? '+' : ''}${lyr.offset.toFixed(1).replace('.', ',')} s</span>
          <button class="btn small icon" data-x="ly-plus" aria-label="Letra meio segundo depois">+</button>
          <span class="hint" style="flex:1 1 220px">Se os acordes caírem cedo ou tarde demais nas palavras, ajuste aqui.</span></div>`;
      } else if (!lyr.lines.length && lyr.plain) html += `<p class="hint">Essa letra não tem tempo marcado: ela vai abaixo dos acordes. A IA pode ouvir a música e encaixar cada linha no tempo certo, mantendo o texto correto.</p>${whisperControls()}`;
      if (lyr.source === 'do LRCLIB') html += `<details style="margin-top:8px"><summary class="hint" style="cursor:pointer">Não é essa a letra?</summary>${whisperControls()}</details>`;
    } else {
      const why = lyr.status === 'error' && /503/.test(lyr.msg) ? 'A consulta direta pelo nome não achou a letra, e a busca geral do LRCLIB está sobrecarregada agora. Tente “Buscar com outro nome” (o nome exato da música e do artista) ou mais tarde, ou use a IA.'
        : lyr.status === 'error' ? `Não consegui consultar o LRCLIB: ${lyr.msg}.`
        : lyr.status === 'whisper-error' ? lyr.msg : 'A letra não está no LRCLIB.';
      html += `<p>${esc(why)}</p>${whisperControls()}`;
    }
    html += `<details style="margin-top:8px"><summary class="hint" style="cursor:pointer">Buscar com outro nome</summary>
      <div class="row" style="margin-top:6px"><input type="text" id="ly-title" placeholder="Música" value="${esc(lyr.title)}" style="flex:1 1 160px">
      <input type="text" id="ly-artist" placeholder="Artista" value="${esc(lyr.artist)}" style="flex:1 1 160px">
      <button class="btn small" data-x="ly-search">Buscar letra</button></div></details>`;
    box.innerHTML = html;
  }

  function updatePreLyrics() {
    const el = d.querySelector('#cg-prelyr');
    if (!el) return;
    const slow = d.querySelector('#cg-slow');
    if (lyr.status === 'found') { el.textContent = `Letra encontrada no LRCLIB: ${lyr.info}. A análise pode ser em 2x.`; if (slow) slow.checked = false; }
    else if (lyr.status === 'searching') el.textContent = 'Procurando a letra no LRCLIB…';
    else { el.textContent = lyr.status === 'error' ? `Não consegui consultar o LRCLIB (${lyr.msg}). Marque a opção abaixo para transcrever a letra com IA.` : 'A letra não está no LRCLIB. Para transcrevê-la com IA, a análise precisa ser em velocidade normal.'; if (slow) slow.checked = true; }
  }

  // ---------- resultado ----------
  function buildText() {
    const base = segmentsToChordPro(result.segments, bpm);
    if (lyr.status === 'found' && lyr.include) {
      if (lyr.lines.length) return LY.alignLyrics(lyr.lines, result.segments, { offset: lyr.offset, source: lyr.source }) || base;
      if (lyr.plain) return LY.appendPlainLyrics(base, lyr.plain);
    }
    return base;
  }

  function renderPreview() {
    const el = d.querySelector('#cg-preview');
    if (el && result) el.innerHTML = ctx.renderSheet(buildText());
  }

  const drawResult = () => {
    show('cg-result');
    const out = d.querySelector('#cg-result');
    if (!segmentsToChordPro(result.segments, bpm)) {
      out.innerHTML = '<p>Não consegui reconhecer acordes. Tente um trecho com o som mais alto ou mais limpo.</p>';
      return;
    }
    const distinct = [...new Set(result.segments.filter((s) => s.chord !== 'N').map((s) => s.chord))];
    out.innerHTML = `
      <div class="row" style="align-items:flex-end;gap:18px">
        <div><span class="hint">Tom provável</span><div class="detected" style="font-size:2.2rem;margin:0">${esc(result.key)}</div></div>
        <label class="field" style="margin:0"><span>Andamento (BPM)</span><input type="number" id="cg-bpm" min="30" max="260" value="${bpm}" style="width:100px"></label>
        <p class="hint" style="margin:0;flex:1 1 200px">Acordes encontrados: ${distinct.map(esc).join(', ')}.${result.separated ? ' Analisados nas faixas separadas (baixo e harmonia, sem voz e bateria).' : ''}</p>
      </div>
      ${audioUrl ? `<div style="margin:14px 0"><audio controls src="${audioUrl}" style="width:100%" id="cg-audio"></audio></div>` : ''}
      ${audioUrl || ctx.mode === 'tab' ? `<p>Acorde agora: <strong id="cg-follow" style="color:var(--chord);font-size:1.4rem">—</strong>
        ${ctx.mode === 'tab' ? '<span class="hint"> — dê play no vídeo do player para conferir de ouvido.</span>' : ''}</p>` : ''}
      <section id="cg-lyrics" style="margin:14px 0;padding:12px 14px;border:1px solid var(--line);border-radius:var(--radius-s)"></section>
      <div class="sheet" id="cg-preview" style="max-height:40vh;overflow:auto;margin:12px 0"></div>
      <div class="row">
        ${!result.separated && rec ? '<button class="btn" data-x="resep">Melhorar os acordes separando as faixas</button>' : ''}
        <button class="btn primary" data-x="apply">${ctx.hasContent ? 'Substituir a cifra atual' : 'Usar esta cifra'}</button>
        ${ctx.hasContent ? '<button class="btn" data-x="append">Adicionar ao fim da cifra</button>' : ''}
      </div>`;
    renderLyrics();
    renderPreview();
    if (lyr.status === 'idle') searchLyrics();
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
    const au = d.querySelector('#cg-audio');
    if (au) {
      au.ontimeupdate = () => {
        const s = segAt(au.currentTime);
        d.querySelector('#cg-follow').textContent = s && s.chord !== 'N' ? s.chord : '—';
      };
    }
  };

  /** Separa as faixas, refaz os acordes com baixo + harmonia e deixa a voz para a IA da letra. */
  async function analyzeSeparated(rec, fallback = () => {}) {
    show('cg-work');
    d.querySelector('#cg-live').hidden = true;
    const msg = d.querySelector('#cg-msg');
    const bar = d.querySelector('#cg-bar');
    try {
      const S = await import('./separate.js?v=10');
      const stems = await S.separate(rec.channels, rec.sampleRate, (text, p) => { msg.textContent = text; bar.style.width = (p * 100) + '%'; });
      msg.textContent = 'Encontrando os acordes nas faixas separadas…';
      const { frames, hop } = await analyzeSamples(stems.other, 44100, (p) => { bar.style.width = (p * 100) + '%'; }, stems.bass);
      const r = framesToChords(frames, { hop });
      r.segments = r.segments.map((x) => ({ ...x, start: rec.toMusicTime(x.start), end: rec.toMusicTime(x.end) }));
      r.separated = true;
      result = r;
      audio = { samples: stems.vocals, sampleRate: 44100, toMusicTime: rec.toMusicTime, vocals: true, rate: rec.rate || 1 };
      if (lyr.status !== 'found') lyr.model = 1;
    } catch (err) {
      ctx.toast('Não foi possível separar as faixas (' + err.message + '). Usei a análise normal.');
      fallback();
    }
    if (result) drawResult();
  }

  d.onchange = async (e) => {
    const id = e.target.id;
    if (id === 'cg-bpm') { bpm = Math.min(260, Math.max(30, Number(e.target.value) || 80)); renderPreview(); return; }
    if (id === 'ly-inc') { lyr.include = e.target.checked; renderLyrics(); renderPreview(); return; }
    if (id === 'ly-model') { lyr.model = Number(e.target.value); return; }
    if (id === 'ly-lang') { lyr.lang = e.target.value; return; }
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
      duration = buf.duration;
      audioUrl = URL.createObjectURL(file);
      rec = { channels: [buf.getChannelData(0), buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)], sampleRate: buf.sampleRate, toMusicTime: (w) => w, rate: 1 };
      if (d.querySelector('#cg-sep')?.checked) {
        await analyzeSeparated(rec, () => {});
        if (result) return;
      }
      msg.textContent = `Analisando ${mmss(buf.duration)} de áudio…`;
      const { frames, hop } = await analyzeSamples(mono, buf.sampleRate, (p) => { bar.style.width = (p * 100) + '%'; });
      result = framesToChords(frames, { hop });
      audio = { samples: mono, sampleRate: buf.sampleRate, toMusicTime: (w) => w };
      drawResult();
    } catch {
      show('cg-start');
      ctx.toast('Não consegui ler esse arquivo. Tente outro formato, como MP3 ou WAV.');
    }
  };

  async function startTab() {
    if (!canCaptureTab()) { ctx.toast('Capturar o áudio da aba só funciona no Chrome ou Edge do computador.'); return; }
    const sep = d.querySelector('#cg-sep')?.checked;
    const slow = d.querySelector('#cg-slow')?.checked;
    let stream;
    try {
      // abre o vídeo no player do site (parado) antes de pedir a captura
      await ctx.player.play(song, { autoplay: false });
      stream = await captureThisTab();
    } catch (err) {
      ctx.toast(err.name === 'NoAudio' ? 'O áudio não foi compartilhado. Tente de novo e deixe marcada a opção de compartilhar o áudio da guia.'
        : err.name === 'NotAllowedError' ? 'Compartilhamento cancelado.' : (err.message || 'Não foi possível capturar o áudio da aba.'));
      return;
    }
    const p = ctx.player.api();
    const rates = p.getAvailablePlaybackRates?.() || [1];
    const rate = slow ? 1 : rates.includes(2) ? 2 : Math.max(...rates);
    show('cg-work');
    d.querySelector('#cg-live').hidden = false;
    d.querySelector('#cg-msg').textContent = rate > 1 ? `Analisando o vídeo em ${rate}x… pode deixar esta janela aberta.` : 'Analisando o vídeo em velocidade normal… pode deixar esta janela aberta.';
    const bar = d.querySelector('#cg-bar');
    mic = new StreamChords();
    let done = false;
    tabRun = {
      finish: (aborted) => {
        if (done) return;
        done = true;
        ctx.player.setOnEnded(null);
        try { p.pauseVideo(); p.setPlaybackRate(1); } catch { /* ok */ }
        const m = mic;
        const frames = m ? m.stop() : [];
        mic = null; tabRun = null;
        if (aborted || !d.open) return;
        if (frames.length < 20) { show('cg-start'); ctx.toast('Ouvi muito pouco do vídeo. Confira se o áudio da guia foi compartilhado.'); return; }
        rec = m.recording();
        if (rec) rec.rate = rate;
        audio = rec;
        const quick = () => { result = framesToChords(frames, { hop: 0.1 * rate }); };
        if (sep && rec) { analyzeSeparated(rec, () => { quick(); }); return; }
        quick();
        drawResult();
      },
    };
    stream.getAudioTracks()[0].addEventListener('ended', () => tabRun?.finish(false));
    ctx.player.setOnEnded(() => tabRun?.finish(false));
    const dur = p.getDuration?.() || 0;
    duration = dur;
    await mic.start(stream, (frame, frames) => {
      if (dur) bar.style.width = Math.min(100, (frame.t / dur) * 100) + '%';
      d.querySelector('#cg-time').textContent = `${mmss(frame.t)}${dur ? ' de ' + mmss(dur) : ''}`;
      if (frame.energy < 0.004) return;
      const avg = new Array(12).fill(0);
      frames.slice(-4).forEach((f) => f.chroma.forEach((v, i) => { avg[i] += v; }));
      d.querySelector('#cg-now').textContent = chordName(classify(avg).label);
    }, () => p.getCurrentTime?.() || 0, { record: true });
    p.seekTo(0, true);
    p.setPlaybackRate(rate);
    p.playVideo();
  }

  d.onclick = async (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'close') d.close();
    if (x === 'ly-minus' || x === 'ly-plus') { lyr.offset = Math.round((lyr.offset + (x === 'ly-plus' ? 0.5 : -0.5)) * 2) / 2; renderLyrics(); renderPreview(); }
    if (x === 'ly-search') { lyr.title = d.querySelector('#ly-title').value.trim(); lyr.artist = d.querySelector('#ly-artist').value.trim(); searchLyrics(); }
    if (x === 'whisper') runWhisper();
    if (x === 'resep' && rec) analyzeSeparated(rec);
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
        }, null, { record: true });
      } catch (err) {
        mic = null; show('cg-start');
        ctx.toast(err.name === 'NotAllowedError' ? 'Permita o uso do microfone para gerar a cifra.' : 'Não foi possível usar o microfone.');
      }
    }
    if (x === 'tab-start') await startTab();
    if (x === 'tab-stop' && tabRun) tabRun.finish(false);
    if (x === 'mic-stop' && mic) {
      const m = mic;
      const frames = m.stop();
      mic = null;
      if (frames.length < 20) { show('cg-start'); ctx.toast('Ouvi muito pouco. Deixe tocar por mais tempo.'); return; }
      audio = m.recording();
      if (audio) { audio.rate = 1; rec = audio; }
      result = framesToChords(frames, { hop: 0.1 });
      drawResult();
    }
    if (x === 'apply' || x === 'append') {
      ctx.onApply({ text: buildText(), key: result.key, bpm, append: x === 'append' });
      d.close();
    }
  };
  // No modo vídeo a janela não pode cobrir o player do YouTube: abre ao lado, sem fundo escuro.
  if (ctx.mode === 'tab') {
    d.classList.add('side'); d.show();
    searchLyrics().then(updatePreLyrics);
  } else d.showModal();
}
