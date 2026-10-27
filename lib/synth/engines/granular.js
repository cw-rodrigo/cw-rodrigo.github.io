// Granular: dispara grãos curtos (com janela) de um áudio de origem, com variação de posição,
// afinação e lugar no estéreo. A origem pode ser uma amostra sua ou uma textura gerada aqui.
import { Env, Pink, panGains, fsin } from '../dsp.js';
import { Voice, PolyEngine } from './poly.js';

const gen = new Map();
/** Texturas geradas (2,5 s, nota C4). */
function generated(kind, sr) {
  const key = kind + ':' + sr;
  if (gen.has(key)) return gen.get(key);
  const n = Math.round(sr * 2.5), x = new Float32Array(n), f0 = 261.63;
  if (kind === 1) { // coro: vários "cantores" levemente desafinados
    const w = Array.from({ length: 13 }, (_, h) => (h ? Math.exp(-(((h * f0 - 700) / 500) ** 2)) / h : 0));
    for (let v = 0; v < 6; v++) {
      const det = 1 + (v - 2.5) * 0.004, vr = 4 + v * 0.7;
      let ph = v / 6;
      for (let i = 0; i < n; i++) {
        ph += (f0 * det * (1 + 0.004 * Math.sin((2 * Math.PI * vr * i) / sr))) / sr;
        let s = 0;
        for (let h = 1; h <= 12; h++) s += fsin(ph * h) * w[h];
        x[i] += s / 6;
      }
    }
  } else if (kind === 2) { // sino
    const parts = [[0.5, 1, 1.6], [1, 0.8, 1.2], [1.19, 0.6, 1], [1.5, 0.5, 0.8], [2, 0.6, 0.7], [2.74, 0.3, 0.5], [3.76, 0.2, 0.4], [5.4, 0.15, 0.3]];
    for (const [r, a, d] of parts) for (let i = 0; i < n; i++) x[i] += a * Math.sin(2 * Math.PI * f0 * r * (i / sr)) * Math.exp(-(i / sr) / d);
  } else if (kind === 3) { const pk = new Pink(); for (let i = 0; i < n; i++) x[i] = pk.next() * 2; }
  else { // cordas: serras desafinadas, suavizadas
    let y = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let v = 0; v < 5; v++) { const ph = (f0 * (1 + (v - 2) * 0.003) * i) / sr; s += 2 * (ph - Math.floor(ph)) - 1; }
      y += 0.15 * (s / 5 - y); x[i] = y * 1.8;
    }
  }
  let pk = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(x[i]));
  for (let i = 0; i < n; i++) x[i] /= pk || 1;
  const out = { data: x, sr, root: 60 };
  gen.set(key, out);
  return out;
}

class GrainVoice extends Voice {
  constructor(eng) { super(eng); this.ae = new Env(this.sr); this.grains = []; this.next = 0; this.scanPos = 0; }
  update() { const p = this.p; this.ae.set(p.aeA, p.aeD, p.aeS, p.aeR); }
  onStart(legato) { this.update(); this.ae.trigger(legato); if (!legato) { this.grains = []; this.next = 0; this.scanPos = 0; } }
  onRelease() { this.ae.release(); }
  source() {
    const p = this.p;
    if ((p.src | 0) === 0) return this.eng.shared.grain || generated(1, this.sr);
    return generated(p.src | 0, this.sr);
  }
  renderVoice(L, R, a, b) {
    const p = this.p, sr = this.sr, src = this.source();
    if (!src) return false;
    const data = src.data, len = data.length, rateBase = src.sr / sr;
    const root = (p.src | 0) === 0 && this.eng.shared.grain ? p.root : 60;
    const vg = this.velGain * 0.35;
    for (let i = a; i < b; i++) {
      const f = this.stepFreq();
      const ratio = (f / (440 * 2 ** ((root - 69) / 12))) * rateBase;
      if (--this.next <= 0) {
        this.next = Math.max(1, Math.round(sr / Math.max(1, p.density) * (0.7 + Math.random() * 0.6)));
        if (this.grains.length < 80) {
          const size = Math.max(64, Math.round(p.size * sr));
          let pos = p.pos + this.scanPos + (Math.random() * 2 - 1) * (p.jitter || 0) * 0.25;
          pos = ((pos % 1) + 1) % 1;
          const pr = ratio * 2 ** (((Math.random() * 2 - 1) * (p.pitchJitter || 0) * 2) / 12);
          const pan = panGains((Math.random() * 2 - 1) * (p.spread || 0));
          this.grains.push({ pos: pos * len, rate: pr, age: 0, size, pl: pan[0], pr: pan[1] });
        }
      }
      if (!p.freeze) this.scanPos += ((p.scan || 0) * 0.2) / sr;
      let l = 0, r = 0;
      for (let g = this.grains.length - 1; g >= 0; g--) {
        const gr = this.grains[g];
        const w = 0.5 - 0.5 * fsin(gr.age / gr.size + 0.25);
        let idx = gr.pos % len; if (idx < 0) idx += len;
        const i0 = idx | 0, fr = idx - i0;
        const s = (data[i0] + (data[(i0 + 1) % len] - data[i0]) * fr) * w;
        l += s * gr.pl; r += s * gr.pr;
        gr.pos += gr.rate; gr.age++;
        if (gr.age >= gr.size) this.grains.splice(g, 1);
      }
      const e = this.ae.next() * vg;
      L[i] += l * e; R[i] += r * e;
    }
    return this.ae.active || this.grains.length > 0 && this.ae.v > 0;
  }
}

export default (sr, shared) => new PolyEngine(sr, GrainVoice, shared);
