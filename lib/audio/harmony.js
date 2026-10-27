// Harmonia a partir do áudio: cromagrama, tom, acordes (arquivo, gravação ou ao vivo).
// A parte de análise não depende do navegador (dá para testar no Node).
import * as M from '../music/theory.js';
import { fft, hann } from './fft.js';
import { Recorder, mono } from './io.js';
import { mmss } from '../core/ui.js';


/** Picos do espectro (55–2000 Hz por padrão) com a altura em semitons MIDI (fracionária). */
export function spectralPeaks(mags, binHz, loHz = 55, hiHz = 2000) {
  const out = [];
  const lo = Math.max(1, Math.ceil(loHz / binHz));
  const hi = Math.min(mags.length - 2, Math.floor(hiHz / binHz));
  let max = 0;
  for (let i = lo; i <= hi; i++) if (mags[i] > max) max = mags[i];
  if (!max) return out;
  const floor = max * 0.02;
  for (let i = lo; i <= hi; i++) {
    const m = mags[i];
    if (m < floor || m < mags[i - 1] || m < mags[i + 1]) continue;
    // interpolação parabólica para achar a frequência real do pico
    const a = mags[i - 1], b = m, c = mags[i + 1];
    const den = a - 2 * b + c;
    const off = den ? 0.5 * (a - c) / den : 0;
    const f = (i + off) * binHz;
    out.push({ f, m, midi: 69 + 12 * Math.log2(f / 440) });
  }
  return out;
}

/**
 * Afinação da gravação em semitons (−0,5..0,5) em relação ao Lá 440: média circular do
 * desvio dos picos. Músicas gravadas com o instrumento um pouco fora (ou com o áudio acelerado)
 * jogariam metade das notas no semitom vizinho sem esta correção.
 */
export class TuningMeter {
  constructor() { this.x = 0; this.y = 0; this.w = 0; }
  add(peaks) {
    for (const p of peaks) {
      const d = p.midi - Math.round(p.midi);
      const w = Math.sqrt(p.m);
      this.x += w * Math.cos(2 * Math.PI * d); this.y += w * Math.sin(2 * Math.PI * d); this.w += w;
    }
  }
  /** Desvio em semitons (0 se não há dados suficientes ou se a medida é dispersa). */
  get value() {
    if (!this.w) return 0;
    const r = Math.hypot(this.x, this.y) / this.w;
    if (r < 0.15) return 0;
    return Math.atan2(this.y, this.x) / (2 * Math.PI);
  }
}

/** Cromagrama a partir de magnitudes lineares do espectro (só picos, 55–2000 Hz). `tune` em semitons. */
export function chromaFromMags(mags, binHz, loHz = 55, hiHz = 2000, tune = 0, peaks = null) {
  const chroma = new Array(12).fill(0);
  for (const p of peaks || spectralPeaks(mags, binHz, loHz, hiHz)) {
    const midi = p.midi - tune;
    const dev = Math.abs(midi - Math.round(midi));
    if (dev > 0.4) continue;
    // graves pesam um pouco mais (a fundamental do acorde costuma estar lá)
    const w = p.f < 260 ? 1.4 : 1;
    chroma[M.mod12(Math.round(midi))] += Math.sqrt(p.m) * (1 - dev) * w;
  }
  return chroma;
}

// Modelos de acorde. Além das notas do acorde, o cromagrama real tem os harmônicos de cada nota
// (o 3º harmônico da fundamental cai na quinta, o da quinta cai na nona…). Os modelos abaixo vêm
// de acordes renderizados com o sintetizador (vários timbres e aberturas) e medidos com esta mesma
// análise; o segundo conjunto é de guitarra com distorção, que cria notas de intermodulação e
// "enche" o cromagrama. Pesos e custos foram escolhidos medindo em músicas sintéticas com a
// resposta conhecida (dev/benchmark).
const LEARNED = {7: [0.538, 0.009, 0.223, 0.009, 0.435, 0.163, 0.017, 0.475, 0.08, 0.015, 0.422, 0.185], '': [0.598, 0.009, 0.213, 0.009, 0.5, 0.033, 0.02, 0.537, 0.078, 0.016, 0.078, 0.213], m: [0.596, 0.039, 0.191, 0.438, 0.153, 0.048, 0.004, 0.572, 0.004, 0.017, 0.233, 0.088], m7: [0.537, 0.034, 0.207, 0.383, 0.14, 0.17, 0.005, 0.507, 0.029, 0.016, 0.457, 0.076]};
const LEARNED_DIST = {7: [0.339, 0.136, 0.346, 0.146, 0.42, 0.248, 0.16, 0.384, 0.213, 0.141, 0.375, 0.329], '': [0.436, 0.129, 0.325, 0.139, 0.48, 0.145, 0.156, 0.427, 0.203, 0.122, 0.196, 0.34], m: [0.417, 0.184, 0.29, 0.399, 0.241, 0.184, 0.136, 0.482, 0.123, 0.135, 0.367, 0.194], m7: [0.351, 0.182, 0.308, 0.387, 0.223, 0.259, 0.138, 0.44, 0.138, 0.141, 0.441, 0.188]};
const DIST_WEIGHT = 0.95; // o modelo com distorção só vence quando encaixa bem melhor
const SWITCH_COST = 0.3; // quanto custa trocar de acorde no caminho mais provável
const AVG_SECONDS = 0.1; // média do cromagrama em volta de cada quadro
const TYPES = [
  { suffix: '', iv: [0, 4, 7], bias: 1 },
  { suffix: 'm', iv: [0, 3, 7], bias: 1 },
  { suffix: '7', iv: [0, 4, 7, 10], bias: 0.94 },
  { suffix: 'm7', iv: [0, 3, 7, 10], bias: 0.94 },
];
const rotate = (v, r) => { const n = Math.hypot(...v); const out = new Array(12); for (let i = 0; i < 12; i++) out[M.mod12(r + i)] = v[i] / n; return out; };
const TEMPLATES = [];
for (let r = 0; r < 12; r++) {
  for (const t of TYPES) {
    TEMPLATES.push({ root: r, type: t.suffix, v: rotate(LEARNED[t.suffix], r), vd: rotate(LEARNED_DIST[t.suffix], r), tones: new Set(t.iv.map((i) => M.mod12(r + i))), bias: t.bias });
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

/** Pontuação de cada modelo de acorde (mesma ordem de TEMPLATES) para um cromagrama. */
function scoreAll(chroma, dia, bn) {
  const n = Math.hypot(...chroma);
  const out = new Float64Array(TEMPLATES.length);
  if (!n) return out;
  for (let k = 0; k < TEMPLATES.length; k++) {
    const t = TEMPLATES[k];
    let s = 0, sd = 0;
    for (let i = 0; i < 12; i++) { s += (chroma[i] / n) * t.v[i]; sd += (chroma[i] / n) * t.vd[i]; }
    s = Math.max(s, sd * DIST_WEIGHT);
    s *= t.bias;
    if (dia && dia.has(t.root + t.type)) s += 0.04;
    if (bn >= 0) {
      if (bn === t.root) s += 0.1;
      else if (t.tones.has(bn)) s += 0.02; // baixo numa nota do acorde (inversão)
      else s -= 0.05;
    }
    out[k] = s;
  }
  return out;
}
const labelOf = (t, bn) => t.root + ':' + t.type + (bn >= 0 && bn !== t.root && t.tones.has(bn) ? '/' + bn : '');

/** Melhor acorde para um cromagrama. Com o cromagrama do baixo, a nota do baixo ajuda a decidir a fundamental. */
export function classify(chroma, key, bass = null) {
  if (!Math.hypot(...chroma)) return { label: 'N', score: 0 };
  const bn = bassNote(bass);
  const sc = scoreAll(chroma, diatonicSet(key), bn);
  let bi = 0;
  for (let k = 1; k < sc.length; k++) if (sc[k] > sc[bi]) bi = k;
  const t = TEMPLATES[bi];
  // inversão: baixo firme numa nota do acorde que não é a fundamental -> acorde com baixo (ex.: D/F#)
  return { root: t.root, type: t.type, score: sc[bi], label: labelOf(t, bn) };
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
 * Caminho mais provável (Viterbi): cada quadro "vota" em todos os acordes e trocar de acorde custa
 * caro, então só troca quando a evidência compensa. Devolve um rótulo por quadro ('N' = sem acorde).
 */
function chordPath(frames, silent, avgOf, dia) {
  const K = TEMPLATES.length, NS = K + 1; // último estado = sem acorde
  const cost = SWITCH_COST;
  let prev = new Float64Array(NS);
  const back = [];
  const bns = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const silentF = f.energy <= silent;
    const bn = f.bass ? bassNote(avgOf(i, 'bass')) : -1;
    bns.push(bn);
    const em = new Float64Array(NS);
    if (silentF) { em.fill(-1); em[K] = 0.5; } else { em.set(scoreAll(avgOf(i, 'chroma'), dia, bn)); em[K] = 0.2; }
    let bestPrev = 0;
    for (let k = 1; k < NS; k++) if (prev[k] > prev[bestPrev]) bestPrev = k;
    const cur = new Float64Array(NS), bk = new Int16Array(NS);
    for (let k = 0; k < NS; k++) {
      const stay = prev[k], sw = prev[bestPrev] - cost;
      if (stay >= sw) { cur[k] = stay + em[k]; bk[k] = k; } else { cur[k] = sw + em[k]; bk[k] = bestPrev; }
    }
    back.push(bk); prev = cur;
  }
  let k = 0;
  for (let j = 1; j < NS; j++) if (prev[j] > prev[k]) k = j;
  const path = new Array(frames.length);
  for (let i = frames.length - 1; i >= 0; i--) { path[i] = k; k = back[i][k]; }
  // baixo (inversão) decidido por trecho
  const smooth = new Array(frames.length);
  for (let i = 0; i < frames.length;) {
    let j = i;
    while (j < frames.length && path[j] === path[i]) j++;
    if (path[i] === K) { for (let q = i; q < j; q++) smooth[q] = 'N'; }
    else {
      const t = TEMPLATES[path[i]];
      const votes = new Map();
      for (let q = i; q < j; q++) if (bns[q] >= 0) votes.set(bns[q], (votes.get(bns[q]) || 0) + 1);
      let bn = -1, bc = 0;
      for (const [n, c] of votes) if (c > bc) { bc = c; bn = n; }
      if (bc < (j - i) * 0.5) bn = -1;
      const lab = labelOf(t, bn);
      for (let q = i; q < j; q++) smooth[q] = lab;
    }
    i = j;
  }
  return smooth;
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

  const dia = diatonicSet(key);
  const W = Math.max(0, Math.round(AVG_SECONDS / hop));
  const avgOf = (i, field) => {
    const avg = new Array(12).fill(0);
    for (let j = Math.max(0, i - W); j <= Math.min(frames.length - 1, i + W); j++) {
      if (frames[j].energy > silent && frames[j][field]) frames[j][field].forEach((v, k) => { avg[k] += v; });
    }
    return avg;
  };
  const smooth = chordPath(frames, silent, avgOf, dia);

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
  const finalKey = keyFromChords(segs, total) || key;
  return { key: finalKey, segments: segs.map((s) => ({ start: s.start, end: s.end, chord: chordName(s.label, finalKey) })) };
}


/**
 * Tom a partir dos acordes reconhecidos, junto com o perfil de notas. O perfil sozinho erra muito
 * para a dominante ou para o relativo (os harmônicos de cada nota reforçam a quinta acima);
 * os acordes dizem bem mais: quais cabem no tom, quanto tempo a tônica soa e se a música
 * começa/termina nela. Os pesos foram escolhidos medindo em músicas sintéticas.
 */
const KEY_W = { profile: 1, diatonic: 0.6, tonic: 0.5, ends: 0.15, dominant: 0.1 };
function keyFromChords(segs, total) {
  const chords = segs.filter((s) => s.label !== 'N').map((s) => {
    const [r, rest] = s.label.split(':');
    const type = rest.split('/')[0];
    return { root: Number(r), minor: type === 'm' || type === 'm7', dom: type === '7', dur: s.end - s.start };
  });
  const totalDur = chords.reduce((a, c) => a + c.dur, 0);
  if (!totalDur) return null;
  const prof = new Map(M.estimateKey(total).map((x) => [x.key, x.score]));
  let best = null;
  for (let r = 0; r < 12; r++) for (const minor of [false, true]) {
    const name = M.keyName(r, minor);
    // tríades do campo harmônico: [intervalo, menor?]
    const dia = minor ? [[0, true], [5, true], [7, true], [7, false], [3, false], [8, false], [10, false]] : [[0, false], [2, true], [4, true], [5, false], [7, false], [9, true]];
    let d = 0, tonic = 0, dominant = 0;
    for (const c of chords) {
      const iv = M.mod12(c.root - r);
      if (dia.some(([i, m]) => i === iv && m === c.minor)) d += c.dur;
      if (iv === 0 && c.minor === minor) tonic += c.dur;
      if (iv === 7 && !c.minor) dominant += c.dur;
    }
    const first = chords[0], last = chords[chords.length - 1];
    const isTonic = (c) => M.mod12(c.root - r) === 0 && c.minor === minor;
    const score = KEY_W.profile * (prof.get(name) || 0) + KEY_W.diatonic * (d / totalDur) + KEY_W.tonic * (tonic / totalDur)
      + KEY_W.ends * ((isTonic(first) ? 1 : 0) + (isTonic(last) ? 1 : 0)) + KEY_W.dominant * (dominant / totalDur);
    if (!best || score > best.score) best = { name, score };
  }
  return best.name;
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
  const N = 8192;
  const hopN = 2048;
  const win = hann(N, false);
  const re = new Float64Array(N), im = new Float64Array(N);
  const binHz = sr / N;
  const spectrum = (src, start) => {
    for (let i = 0; i < N; i++) { re[i] = src[start + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const mags = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++) mags[i] = Math.hypot(re[i], im[i]);
    return mags;
  };
  // 1ª passada: espectro, picos e afinação
  const raw = [];
  const tuning = new TuningMeter();
  for (let start = 0, n = 0; start + N <= len; start += hopN, n++) {
    let e = 0;
    for (let i = 0; i < N; i++) e += x[start + i] * x[start + i];
    const mags = spectrum(x, start);
    const peaks = spectralPeaks(mags, binHz);
    tuning.add(peaks);
    const fr = { t: (start + N / 2) / sr, peaks, energy: Math.sqrt(e / N) };
    if (xb) fr.bassPeaks = spectralPeaks(spectrum(xb, start), binHz, 30, 330);
    raw.push(fr);
    if (n % 40 === 0) { onProgress(0.95 * start / len); await new Promise((r) => setTimeout(r, 0)); }
  }
  // 2ª passada: cromagramas já com a afinação corrigida
  const tune = tuning.value;
  const frames = raw.map((r) => {
    const f = { t: r.t, chroma: chromaFromMags(null, binHz, 55, 2000, tune, r.peaks), energy: r.energy };
    if (r.bassPeaks) f.bass = chromaFromMags(null, binHz, 30, 330, tune, r.bassPeaks);
    return f;
  });
  onProgress(1);
  return { frames, hop: hopN / sr, tuning: tune };
}


/**
 * Tom de um trecho de áudio: [{ key, score }] do mais provável para o menos.
 * O primeiro vem da análise com os acordes; a lista tem também `tuning` (cents em relação ao Lá 440).
 */
export async function keyOfSamples(samples, sampleRate, onProgress = () => {}) {
  const { frames, hop, tuning } = await analyzeSamples(samples, sampleRate, onProgress);
  if (!frames.length) return null;
  const total = new Array(12).fill(0);
  const energies = frames.map((f) => f.energy).sort((a, b) => a - b);
  const silent = (energies[Math.floor(energies.length * 0.5)] || 0) * 0.12;
  for (const f of frames) if (f.energy > silent) f.chroma.forEach((v, i) => { total[i] += v; });
  const prof = M.estimateKey(total);
  const best = framesToChords(frames, { hop }).key;
  const list = best ? [{ key: best, score: prof[0].score }, ...prof.filter((x) => x.key !== best)] : prof;
  list.tuning = Math.round(tuning * 100);
  return list;
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
    this.tuning = new TuningMeter();
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
        const peaks = spectralPeaks(mags, sr / N);
        this.tuning.add(peaks);
        const frame = { t, chroma: chromaFromMags(null, sr / N, 55, 2000, this.tuning.value, peaks), energy: Math.sqrt(e / m.length) };
        this.frames.push(frame);
        onFrame?.(frame, this.frames);
      },
    });
  }
  /** Áudio gravado: { channels, sampleRate, toMusicTime } */
  recording() { const r = this.rec?.result(); return r && r.channels[0].length ? r : null; }
  stop() { this.rec?.stop(); return this.frames || []; }
}
