// Medidas do timbre a partir do áudio: curva de frequências, quanto de distorção,
// compressão, reverb e andamento. Tudo roda no navegador.
import { fft, hann } from './fft.js';

/** Centros de 1/3 de oitava usados na curva. */
export const BANDS = [63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000];
const db = (x) => 10 * Math.log10(x + 1e-20);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/** Espectro médio (potência por faixa de 1/3 de oitava, em dB, com 0 dB = média de 250 Hz a 4 kHz). */
export function spectrumCurve(power, binHz) {
  const out = BANDS.map((fc) => {
    const lo = Math.max(1, Math.floor(fc / 2 ** (1 / 6) / binHz)), hi = Math.max(lo, Math.ceil(fc * 2 ** (1 / 6) / binHz));
    let s = 0;
    for (let i = lo; i <= hi && i < power.length; i++) s += power[i];
    return db(s / (hi - lo + 1));
  });
  const ref = out.filter((_, i) => BANDS[i] >= 250 && BANDS[i] <= 4000);
  const m = ref.reduce((a, b) => a + b, 0) / ref.length;
  return out.map((v) => Math.max(-40, v - m));
}

/** Valor da curva numa frequência qualquer (interpolação em escala logarítmica). */
export function curveAt(curve, f) {
  if (f <= BANDS[0]) return curve[0];
  for (let i = 1; i < BANDS.length; i++) {
    if (f <= BANDS[i]) {
      const t = Math.log(f / BANDS[i - 1]) / Math.log(BANDS[i] / BANDS[i - 1]);
      return curve[i - 1] + t * (curve[i] - curve[i - 1]);
    }
  }
  return curve[curve.length - 1];
}
/** Média da curva entre duas frequências. */
export function curveMean(curve, lo, hi) {
  let s = 0, n = 0;
  for (let f = lo; f <= hi; f *= 2 ** (1 / 6)) { s += curveAt(curve, f); n++; }
  return s / Math.max(1, n);
}

/**
 * Analisa o áudio (mono). Retorna as medidas do timbre.
 * onProgress(fração)
 */
export async function analyzeTone(samples, sr, onProgress = () => {}) {
  const N = 4096, hop = 1024;
  const binHz = sr / N;
  const win = hann(N);
  const frames = Math.max(0, Math.floor((samples.length - N) / hop));
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0; i < N; i += 4) { const v = samples[f * hop + i]; e += v * v; }
    rms[f] = Math.sqrt(e / (N / 4));
  }
  const maxDb = db(pct(Array.from(rms, (r) => r * r), 0.98));
  const active = Array.from(rms, (r) => db(r * r) > Math.max(maxDb - 30, -70));
  const power = new Float64Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  const flat = [];
  let used = 0;
  const loF = Math.round(1000 / binHz), hiF = Math.round(5000 / binHz);
  // "planura" do espectro de 1 a 5 kHz, só na parte sustentada das notas (sem o ataque da palhetada)
  const actLevels = Array.from(rms).filter((_, f) => active[f]).map((r) => db(r * r));
  const loud = pct(actLevels, 0.4);
  let lastOnset = -99;
  for (let f = 0; f < frames; f++) {
    if (f > 0 && db(rms[f] * rms[f]) - db(rms[f - 1] * rms[f - 1]) > 3) lastOnset = f;
    if (!active[f]) continue;
    for (let i = 0; i < N; i++) { re[i] = samples[f * hop + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let lg = 0, ar = 0;
    for (let k = 0; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      power[k] += p;
      if (k >= loF && k <= hiF) { lg += Math.log(p + 1e-18); ar += p; }
    }
    const n = hiF - loF + 1;
    if (f - lastOnset > Math.ceil((0.07 * sr) / hop) && db(rms[f] * rms[f]) >= loud) flat.push(10 * (lg / n - Math.log(ar / n + 1e-18)) / Math.LN10);
    used++;
    if (f % 200 === 0) { onProgress(0.6 * (f / frames)); await new Promise((r) => setTimeout(r)); }
  }
  if (used < 8) throw new Error('Quase não há som nesse trecho.');
  for (let k = 0; k < power.length; k++) power[k] /= used;
  const curve = spectrumCurve(power, binHz);

  // dinâmica: picos e variação de volume em janelas curtas
  const W = Math.round(sr * 0.05);
  const crest = [], levels = [];
  for (let o = 0; o + W <= samples.length; o += W) {
    let e = 0, pk = 0;
    for (let i = o; i < o + W; i++) { const v = samples[i]; e += v * v; const a = Math.abs(v); if (a > pk) pk = a; }
    const r = Math.sqrt(e / W);
    const l = 20 * Math.log10(r + 1e-9);
    if (l > maxDb - 30 && l > -70) { levels.push(l); crest.push(20 * Math.log10((pk + 1e-9) / (r + 1e-9))); }
  }
  const crestDb = median(crest);
  const spread = pct(levels, 0.9) - pct(levels, 0.3);
  const flatDb = median(flat);
  onProgress(0.7);
  const rv = reverbEstimate(envelope(samples, sr));

  onProgress(1);

  // quanto de distorção (0 = limpo, 1 = muito saturado). A distorção deixa o espectro "cheio" entre
  // as notas e achata os picos da onda; o reverb também enche o espectro, então é descontado.
  const sFlat = clamp01((flatDb - 5 * rv.amount + 18) / 10);
  const sCrest = clamp01((11.5 - crestDb) / 5);
  const gain = clamp01(0.6 * sFlat + 0.4 * sCrest);
  return {
    curve, gain,
    parts: { flatness: flatDb, crest: crestDb, spread },
    compression: clamp01(((6 - spread) / 4) * (1 - gain)),
    reverb: rv,
    seconds: samples.length / sr,
  };
}

/** Envelope de volume em dB, quadros de 10 ms. */
function envelope(x, sr) {
  const W = Math.round(sr * 0.01);
  const out = new Float32Array(Math.floor(x.length / W));
  for (let f = 0; f < out.length; f++) {
    let e = 0;
    for (let i = f * W; i < (f + 1) * W; i++) e += x[i] * x[i];
    out[f] = 10 * Math.log10(e / W + 1e-12);
  }
  return out;
}

/**
 * Reverb: as quedas de volume mais rápidas do trecho mostram quanto o som "demora a morrer".
 * Retorna { rt (segundos para cair 60 dB), amount 0..1 }.
 */
function reverbEstimate(env) {
  const top = pct(Array.from(env), 0.97);
  const slopes = [];
  const L = 12; // 120 ms
  for (let i = 0; i + L < env.length; i++) {
    if (env[i] < top - 28 || env[i] > top - 3) continue;
    if (env[i + L] >= env[i] - 4) continue; // só trechos caindo
    // regressão linear do volume nos próximos 120 ms
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let k = 0; k <= L; k++) { sx += k; sy += env[i + k]; sxy += k * env[i + k]; sxx += k * k; }
    const n = L + 1;
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx); // dB por quadro
    slopes.push(slope * 100); // dB por segundo
  }
  if (slopes.length < 5) return { rt: 0.3, amount: 0.2, confidence: 0 };
  const fast = -pct(slopes, 0.1); // queda rápida típica (dB/s)
  const rt = Math.max(0.05, Math.min(6, 60 / Math.max(fast, 10)));
  return { rt, amount: clamp01((rt - 0.25) / 2.2), confidence: clamp01(slopes.length / 60) };
}

/**
 * Andamento (BPM) pela autocorrelação dos ataques. Usado para acertar o tempo do delay.
 * (Detectar o eco sozinho não ficou confiável: o próprio ritmo da palhetada se parece com eco.)
 */
export async function tempoEstimate(x, sr) {
  const hop = Math.round(sr * 0.0058), N = 512;
  const n = Math.floor((x.length - N) / hop);
  if (n < 400) return null;
  const e = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const o = f * hop;
    for (let i = 1; i < N; i++) { const d = x[o + i] - x[o + i - 1]; s += d * d; }
    e[f] = Math.sqrt(s / N);
  }
  const on = new Float32Array(n);
  for (let f = 1; f < n; f++) on[f] = Math.max(0, e[f] - e[f - 1]);
  const dt = hop / sr;
  await new Promise((r) => setTimeout(r));
  let bestLag = 0, bestV = -1;
  for (let lag = Math.round(0.3 / dt); lag <= Math.round(1.0 / dt); lag++) {
    let s = 0;
    for (let f = 0; f + lag < n; f++) s += on[f] * on[f + lag];
    const w = Math.exp(-0.5 * (Math.log2((lag * dt) / 0.5) / 0.9) ** 2);
    if (s * w > bestV) { bestV = s * w; bestLag = lag; }
  }
  return bestLag ? Math.round(60 / (bestLag * dt)) : null;
}
