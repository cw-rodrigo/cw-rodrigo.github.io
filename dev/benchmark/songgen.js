// Gerador de músicas de teste com a "resposta" conhecida (tom, acordes, afinação, andamento).
// Serve para medir e calibrar a cifragem automática: o som sai dos mesmos motores do sintetizador.
import { renderNotes, presetParams } from '../../lib/synth/render.js';

export function rng(seed) {
  let s = (Math.imul((seed >>> 0) + 0x9e3779b9, 2654435761) >>> 0) || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = 0; i < 8; i++) next();
  return next;
}
const pick = (r, a) => a[Math.floor(r() * a.length)];

// graus -> [intervalo da fundamental a partir da tônica, tipo]
const MAJOR_DEG = { I: [0, ''], ii: [2, 'm'], iii: [4, 'm'], IV: [5, ''], V: [7, ''], V7: [7, '7'], vi: [9, 'm'], ii7: [2, 'm7'], vi7: [9, 'm7'], 'I/3': [0, '', 4], 'V/7': [7, '', 11], IV7: [5, ''], bVII: [10, ''] };
const MINOR_DEG = { i: [0, 'm'], iv: [5, 'm'], v: [7, 'm'], V7: [7, '7'], III: [3, ''], VI: [8, ''], VII: [10, ''], iv7: [5, 'm7'], i7: [0, 'm7'], ii0: [2, 'm'] };
const MAJOR_PROGS = [['I', 'V', 'vi', 'IV'], ['I', 'vi', 'IV', 'V'], ['ii7', 'V7', 'I', 'I'], ['I', 'IV', 'I', 'V7'], ['vi', 'IV', 'I', 'V'], ['I', 'iii', 'IV', 'V'], ['I', 'V/7', 'vi', 'IV'], ['I', 'I/3', 'IV', 'V'], ['IV', 'V', 'iii', 'vi'], ['I', 'bVII', 'IV', 'I'], ['I', 'vi7', 'ii7', 'V7']];
const MINOR_PROGS = [['i', 'VI', 'III', 'VII'], ['i', 'iv', 'v', 'i'], ['i', 'VII', 'VI', 'V7'], ['i', 'iv', 'VII', 'III'], ['VI', 'VII', 'i', 'i'], ['i7', 'iv7', 'VII', 'III']];
const TYPE_IV = { '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10] };

/** Instrumentos de harmonia: [motor, preset, como toca]. */
export const HARMONY = [
  ['physical', 'Violão de náilon', 'strum'], ['physical', 'Guitarra de aço', 'strum'], ['fm', 'Piano elétrico (DX)', 'comp'],
  ['subtractive', 'Pad quente', 'pad'], ['additive', 'Órgão de tubos', 'pad'], ['pd', 'Strings CZ', 'pad'], ['fm', 'Órgão FM', 'comp'],
  ['wavetable', 'PWM pad', 'pad'], ['subtractive', 'Pluck', 'arp'], ['physical', 'Guitarra de aço', 'dist'], ['physical', 'Guitarra de aço', 'dist'], ['fm', 'Piano elétrico (DX)', 'arp'],
];
const BASS = [['subtractive', 'Baixo analógico'], ['fm', 'Baixo FM'], ['pd', 'Baixo CZ']];
const LEAD = [['subtractive', 'Lead serra'], ['formant', 'Coro "aah"'], ['physical', 'Flauta'], ['additive', 'Clarinete']];

/** Nota MIDI de uma classe de altura perto de `near`. */
const nearPc = (pc, near) => { let n = near - ((((near - pc) % 12) + 12) % 12); if (near - n > 6) n += 12; return n; };

function voicing(root, type, style, r) {
  const iv = TYPE_IV[type];
  if (style === 'strum' || style === 'dist') {
    // violão: fundamental grave e as notas subindo até ~E4
    const base = nearPc(root, 45);
    const notes = [base];
    let n = base;
    for (let k = 0; k < 5; k++) { const pcs = iv.map((i) => (root + i) % 12); let next = n + 3; while (!pcs.includes(((next % 12) + 12) % 12)) next++; if (next > 66) break; notes.push(next); n = next; }
    return notes;
  }
  const center = style === 'pad' ? 60 + Math.floor(r() * 5) : 62;
  const out = iv.map((i) => nearPc((root + i) % 12, center));
  if (style === 'comp' && r() < 0.6) out.push(nearPc(root, 48));
  return out.sort((a, b) => a - b);
}

// ---------------------------------------------------------------- distorção (guitarra de rock)
function biquad(x, type, fc, sr, q = 0.707) {
  const w = (2 * Math.PI * fc) / sr, a = Math.sin(w) / (2 * q), c = Math.cos(w);
  const [b0, b1, b2] = type === 'lp' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
/** Pedal de distorção simples + caixa de guitarra: corta graves, satura (tanh) e abafa os agudos. */
export function distort(x, gain, sr) {
  let pk = 0;
  for (const v of x) pk = Math.max(pk, Math.abs(v));
  const hp = biquad(x, 'hp', 250, sr);
  const g = gain / (pk || 1);
  const y = hp.map((v) => Math.tanh(v * g));
  return biquad(biquad(biquad(y, 'lp', 4500, sr), 'lp', 5000, sr), 'hp', 90, sr);
}

/**
 * Gera uma música. opts: { seed, bars (por volta), loops, minor?, detune? }
 * Retorna { L, R, sampleRate, truth: { key, minor, tonic, bpm, tuning (cents), segments: [{start, end, root, type, bass}] }, desc }
 */
export function makeSong(opts = {}) {
  const r = rng(opts.seed ?? 1);
  const sr = opts.sampleRate || 44100;
  const minor = opts.minor ?? r() < 0.35;
  const tonic = Math.floor(r() * 12);
  const bpm = Math.round(68 + r() * 64);
  const beat = 60 / bpm;
  const prog = pick(r, minor ? MINOR_PROGS : MAJOR_PROGS);
  const DEG = minor ? MINOR_DEG : MAJOR_DEG;
  const barsPer = opts.barsPer ?? pick(r, [0.5, 1, 1, 2]);
  const loops = opts.loops ?? 2;
  const tuning = opts.detune ?? (r() < 0.4 ? Math.round((r() * 2 - 1) * 45) : Math.round((r() * 2 - 1) * 8));
  const chords = [];
  let t = 0.5;
  for (let l = 0; l < loops; l++) for (const d of prog) {
    const [iv, type, bassIv] = DEG[d];
    const root = (tonic + iv) % 12;
    const dur = barsPer * 4 * beat;
    chords.push({ start: t, end: t + dur, root, type, bass: bassIv != null ? (tonic + bassIv) % 12 : root });
    t += dur;
  }
  const seconds = t + 2;
  const parts = [];
  const bend = { type: 'bend', value: tuning / 100, at: 0 };
  // harmonia (1 ou 2 instrumentos)
  const nh = r() < 0.4 ? 2 : 1;
  const used = [];
  for (let k = 0; k < nh; k++) {
    const [engine, preset, style] = pick(r, HARMONY);
    used.push(preset);
    const ev = [bend];
    for (const c of chords) {
      const notes = voicing(c.root, c.type, style, r);
      if (c.bass !== c.root && style !== 'strum') { /* a inversão fica no baixo */ }
      if (style === 'pad') {
        notes.forEach((n) => { ev.push({ type: 'note', note: n, vel: 80, at: c.start }, { type: 'off', note: n, at: c.end - 0.02 }); });
      } else if (style === 'strum' || style === 'dist') {
        const step = r() < 0.5 ? 1 : 0.5;
        for (let b = c.start; b < c.end - 0.01; b += step * beat) {
          const down = Math.round((b - c.start) / beat / step) % 2 === 0;
          const ord = down ? notes : [...notes].reverse().slice(0, 4);
          ord.forEach((n, i) => ev.push({ type: 'note', note: n, vel: down ? 90 + r() * 20 : 60 + r() * 20, at: b + i * 0.012 }, { type: 'off', note: n, at: Math.min(c.end, b + step * beat) - 0.01 }));
        }
      } else if (style === 'comp') {
        for (let b = c.start; b < c.end - 0.01; b += 2 * beat) notes.forEach((n) => ev.push({ type: 'note', note: n, vel: 85, at: b }, { type: 'off', note: n, at: b + 1.8 * beat }));
      } else {
        // arpejo em colcheias
        let i = 0;
        for (let b = c.start; b < c.end - 0.01; b += beat / 2, i++) { const n = notes[i % notes.length] + (Math.floor(i / notes.length) % 2) * 12; ev.push({ type: 'note', note: n, vel: 90, at: b }, { type: 'off', note: n, at: b + beat * 0.45 }); }
      }
    }
    parts.push({ engine, params: { ...presetParams(engine, preset), bendRange: 1 }, ev, gain: style === 'pad' ? 0.8 : 1, drive: style === 'dist' ? 4 + r() * 36 : 0 });
    if (style === 'dist') used[used.length - 1] += ' com distorção';
  }
  // baixo
  if (opts.bass !== false && r() < 0.85) {
    const [engine, preset] = pick(r, BASS);
    used.push(preset);
    const ev = [bend];
    for (const c of chords) {
      const n = nearPc(c.bass, 38);
      for (let b = c.start; b < c.end - 0.01; b += 2 * beat) {
        const note = r() < 0.2 && c.bass === c.root ? n + 7 : n;
        ev.push({ type: 'note', note, vel: 100, at: b }, { type: 'off', note, at: b + 1.6 * beat });
      }
    }
    parts.push({ engine, params: { ...presetParams(engine, preset), bendRange: 1, mono: true }, ev, gain: 0.9 });
  }
  // melodia com notas de passagem
  if (opts.lead !== false && r() < 0.6) {
    const [engine, preset] = pick(r, LEAD);
    used.push(preset);
    const scale = (minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map((i) => (tonic + i) % 12);
    const ev = [bend];
    for (const c of chords) {
      for (let b = c.start; b < c.end - 0.01; b += beat * (r() < 0.5 ? 1 : 0.5)) {
        if (r() < 0.25) continue;
        const ct = TYPE_IV[c.type].map((i) => (c.root + i) % 12);
        const pc = r() < 0.65 ? pick(r, ct) : pick(r, scale);
        const note = nearPc(pc, 72);
        ev.push({ type: 'note', note, vel: 90, at: b }, { type: 'off', note, at: b + beat * 0.45 });
      }
    }
    parts.push({ engine, params: { ...presetParams(engine, preset), bendRange: 1, mono: true }, ev, gain: 0.7 });
  }
  // bateria
  if (opts.drums !== false && r() < 0.75) {
    const preset = pick(r, ['808', '909', 'Acústica seca']);
    used.push('bateria ' + preset);
    const ev = [];
    for (let b = 0.5; b < t - 0.01; b += beat / 2) {
      const k = Math.round((b - 0.5) / (beat / 2)) % 8;
      ev.push({ type: 'note', note: 42, vel: 70, at: b }, { type: 'off', note: 42, at: b + 0.05 });
      if (k === 0 || k === 5) ev.push({ type: 'note', note: 36, vel: 110, at: b }, { type: 'off', note: 36, at: b + 0.1 });
      if (k === 2 || k === 6) ev.push({ type: 'note', note: 38, vel: 100, at: b }, { type: 'off', note: 38, at: b + 0.1 });
    }
    parts.push({ engine: 'drums', params: presetParams('drums', preset), ev, gain: 0.8 });
  }
  const L = new Float32Array(Math.ceil(seconds * sr)), R = new Float32Array(L.length);
  for (const part of parts) {
    const o = renderNotes({ engine: part.engine, params: part.params, events: part.ev, seconds, sampleRate: sr });
    if (part.drive) { o.L = distort(o.L, part.drive, sr); o.R = distort(o.R, part.drive, sr); }
    let pk = 0;
    for (let i = 0; i < o.L.length; i++) pk = Math.max(pk, Math.abs(o.L[i]), Math.abs(o.R[i]));
    const g = pk ? (part.gain * 0.5) / pk : 0;
    for (let i = 0; i < L.length; i++) { L[i] += o.L[i] * g; R[i] += o.R[i] * g; }
  }
  let pk = 0;
  for (let i = 0; i < L.length; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  if (pk) for (let i = 0; i < L.length; i++) { L[i] *= 0.85 / pk; R[i] *= 0.85 / pk; }
  return {
    L, R, sampleRate: sr,
    truth: { tonic, minor, bpm, tuning, segments: chords },
    desc: `${used.join(' + ')} · ${bpm} BPM · ${tuning > 0 ? '+' : ''}${tuning} cents`,
  };
}
