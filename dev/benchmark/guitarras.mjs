// Guitarras sintéticas com distorção e reverb conhecidos, para calibrar a análise de timbre.
import { renderNotes, presetParams } from '../../lib/synth/render.js';
import { distort, rng } from './songgen.js';
import { fft } from '../../lib/audio/fft.js';
export const SR = 44100;
const CH = [[40, 47, 52, 56, 59, 64], [45, 52, 57, 61, 64], [43, 50, 55, 59, 62, 67], [50, 57, 62, 66]];
export function playing(style, seed = 1, seconds = 16, preset = 'Guitarra de aço') {
  const r = rng(seed); const ev = []; const beat = 60 / (90 + 30 * r());
  let t = 0.2, k = 0;
  while (t < seconds - 1.5) {
    const ch = CH[Math.floor(k / 4) % 4];
    if (style === 'strum') { ch.forEach((n, i) => ev.push({ type: 'note', note: n, vel: 100, at: t + i * 0.01 }, { type: 'off', note: n, at: t + beat * 1.9 })); t += beat * 2; k += 2; }
    else if (style === 'muted') { ch.slice(0, 3).forEach((n, i) => ev.push({ type: 'note', note: n, vel: 100, at: t + i * 0.006 }, { type: 'off', note: n, at: t + beat * 0.3 })); t += beat / 2; k += 0.5; }
    else { const n = ch[Math.floor(r() * ch.length)] + 12; ev.push({ type: 'note', note: n, vel: 100, at: t }, { type: 'off', note: n, at: t + beat * 0.9 }); t += beat; k += 1; }
  }
  const o = renderNotes({ engine: 'physical', params: presetParams('physical', preset), events: ev, seconds, sampleRate: SR });
  return o.L.map((v, i) => v + o.R[i]);
}
function biquad(x, type, fc, q = 0.707) {
  const w = (2 * Math.PI * fc) / SR, a = Math.sin(w) / (2 * q), c = Math.cos(w);
  const [b0, b1, b2] = type === 'lp' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a; const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y;
}
export const cab = (x) => biquad(biquad(x, 'hp', 80), 'lp', 6000);
/** convolução por FFT (sobreposição e soma) */
function convolve(x, h) {
  const B = 16384, N = 2 * B; let M = 1; while (M < B + h.length) M *= 2;
  const L = M - h.length + 1; const y = new Float32Array(x.length + h.length);
  const hr = new Float64Array(M), hi = new Float64Array(M); hr.set(h); fft(hr, hi);
  for (let o = 0; o < x.length; o += L) {
    const xr = new Float64Array(M), xi = new Float64Array(M); xr.set(x.subarray(o, Math.min(x.length, o + L)));
    fft(xr, xi);
    for (let k = 0; k < M; k++) { const a = xr[k] * hr[k] - xi[k] * hi[k], b = xr[k] * hi[k] + xi[k] * hr[k]; xr[k] = a; xi[k] = b; }
    fft(xr, xi, true);
    for (let k = 0; k < M && o + k < y.length; k++) y[o + k] += xr[k];
  }
  return y.subarray(0, x.length);
}
export function reverb(x, rt, mix, seed = 3) {
  if (!rt) return x;
  const r = rng(seed); const len = Math.round(rt * 1.2 * SR); const h = new Float32Array(len);
  for (let i = 0; i < len; i++) h[i] = (r() * 2 - 1) * Math.exp(-6.91 * i / (rt * SR));
  const y = convolve(x, h);
  let ex = 0, ey = 0; for (let i = 0; i < x.length; i++) { ex += x[i] * x[i]; ey += y[i] * y[i]; }
  const g = Math.sqrt(ex / (ey || 1));
  return x.map((v, i) => v * (1 - mix) + y[i] * g * mix);
}
export const drive = (x, g) => (g ? distort(x, g, SR) : x);
