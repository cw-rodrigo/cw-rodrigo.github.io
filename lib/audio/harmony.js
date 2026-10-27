// Harmonia a partir do áudio: cromagrama, tom, acordes (arquivo, gravação ou ao vivo).
// A parte de análise não depende do navegador (dá para testar no Node).
import * as M from '../music/theory.js';
import { fft, hann } from './fft.js';
import { Recorder, mono } from './io.js';

const mmss = (t) => { const s = Math.max(0, Math.floor(t)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

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
  const win = hann(N, false);
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


/** Tom de um trecho de áudio: [{ key, score }] do mais provável para o menos. */
export async function keyOfSamples(samples, sampleRate, onProgress = () => {}) {
  const { frames } = await analyzeSamples(samples, sampleRate, onProgress);
  const total = new Array(12).fill(0);
  const energies = frames.map((f) => f.energy).sort((a, b) => a - b);
  const silent = (energies[Math.floor(energies.length * 0.5)] || 0) * 0.12;
  for (const f of frames) if (f.energy > silent) f.chroma.forEach((v, i) => { total[i] += v; });
  return frames.length ? M.estimateKey(total) : null;
}

/** Cromagrama somado de vários quadros (para o "acorde agora"). */
export function sumChroma(frames) {
  const avg = new Array(12).fill(0);
  for (const f of frames) f.chroma.forEach((v, i) => { avg[i] += v; });
  return avg;
}

/**
 * Análise ao vivo de um MediaStream (microfone ou aba): um quadro de cromagrama por bloco de áudio
 * (~90 ms) e, opcionalmente, a gravação do áudio.
 * opts: { getTime() -> tempo da música, shouldKeep() -> considerar este bloco?, record, rate }
 */
export class LiveChords {
  async start(stream, onFrame, { getTime = null, shouldKeep = () => true, record = true, rate = 1 } = {}) {
    const N = 16384;
    const ring = new Float32Array(N);
    const win = hann(N);
    const re = new Float64Array(N), im = new Float64Array(N), mags = new Float64Array(N / 2);
    this.frames = [];
    this.rec = new Recorder();
    this.rec.rate = rate;
    this.hop = (4096 / 48000) * rate;
    await this.rec.start(stream, {
      shouldKeep, keep: record, getTime,
      onBlock: (L, R) => {
        const m = mono([L, R]);
        ring.copyWithin(0, m.length);
        ring.set(m, N - m.length);
        let e = 0;
        for (let i = 0; i < m.length; i++) e += m[i] * m[i];
        for (let i = 0; i < N; i++) { re[i] = ring[i] * win[i]; im[i] = 0; }
        fft(re, im);
        for (let i = 0; i < N / 2; i++) mags[i] = Math.hypot(re[i], im[i]);
        const sr = this.rec.sampleRate;
        this.hop = (m.length / sr) * rate;
        const t = getTime ? getTime() : this.rec.seconds;
        const frame = { t, chroma: chromaFromMags(mags, sr / N), energy: Math.sqrt(e / m.length) };
        this.frames.push(frame);
        onFrame?.(frame, this.frames);
      },
    });
  }
  /** Áudio gravado: { channels, sampleRate, toMusicTime } */
  recording() { const r = this.rec?.result(); return r && r.channels[0].length ? r : null; }
  stop() { this.rec?.stop(); return this.frames || []; }
}
