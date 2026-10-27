// FM de 4 operadores (modulação de fase, como os Yamaha DX/TX), 8 algoritmos e realimentação no operador 4.
import { Env, fsin } from '../dsp.js';
import { Voice, PolyEngine } from './poly.js';

// mods[k]: operadores que modulam o operador k (1..4); out: portadoras
export const ALGOS = [
  { mods: { 1: [2], 2: [3], 3: [4] }, out: [1] },
  { mods: { 1: [2], 2: [3, 4] }, out: [1] },
  { mods: { 1: [4, 2], 2: [3] }, out: [1] },
  { mods: { 1: [3, 2], 3: [4] }, out: [1] },
  { mods: { 1: [2], 3: [4] }, out: [1, 3] },
  { mods: { 1: [4], 2: [4], 3: [4] }, out: [1, 2, 3] },
  { mods: { 3: [4] }, out: [1, 2, 3] },
  { mods: {}, out: [1, 2, 3, 4] },
];
const MOD_SCALE = 0.75; // índice de modulação máximo ≈ 4,7 rad

class FMVoice extends Voice {
  constructor(eng) {
    super(eng);
    this.env = [0, 1, 2, 3, 4].map(() => new Env(this.sr));
    this.ph = new Float64Array(5); this.out = new Float64Array(5); this.fb1 = 0; this.fb2 = 0;
  }
  update() { const p = this.p; for (let k = 1; k <= 4; k++) this.env[k].set(p[`op${k}A`], p[`op${k}D`], p[`op${k}S`], p[`op${k}R`]); }
  onStart(legato) {
    this.update();
    for (let k = 1; k <= 4; k++) { this.env[k].trigger(legato); if (!legato) this.ph[k] = 0; }
    if (!legato) { this.fb1 = this.fb2 = 0; }
  }
  onRelease() { for (let k = 1; k <= 4; k++) this.env[k].release(); }
  renderVoice(L, R, a, b) {
    const p = this.p, sr = this.sr;
    const algo = ALGOS[p.algo | 0] || ALGOS[0];
    const isCar = [false, ...[1, 2, 3, 4].map((k) => algo.out.includes(k))];
    const ratio = [0, 1, 2, 3, 4].map((k) => (k ? p[`op${k}Ratio`] * 2 ** (p[`op${k}Det`] / 1200) : 0));
    // a força da nota deixa o som mais brilhante (mais modulação) e mais alto
    const velMod = 0.4 + 0.6 * this.velGain;
    const lvl = [0, 1, 2, 3, 4].map((k) => (k ? p[`op${k}Lvl`] * (isCar[k] ? 1 : velMod) : 0));
    const carNorm = this.velGain * 0.45 / Math.sqrt(algo.out.length);
    const fb = (p.feedback || 0) * 0.35;
    const mods = algo.mods;
    for (let i = a; i < b; i++) {
      const f = this.stepFreq();
      let sum = 0;
      for (let k = 4; k >= 1; k--) {
        let m = 0;
        const ms = mods[k];
        if (ms) for (const j of ms) m += this.out[j];
        if (k === 4 && fb) m += fb * (this.fb1 + this.fb2) * 0.5 / MOD_SCALE;
        const e = this.env[k].next();
        const o = fsin(this.ph[k] + m * MOD_SCALE) * e * lvl[k];
        this.out[k] = o;
        if (k === 4) { this.fb2 = this.fb1; this.fb1 = o; }
        this.ph[k] += (f * ratio[k]) / sr;
        if (this.ph[k] > 1e6) this.ph[k] -= Math.floor(this.ph[k]);
        if (isCar[k]) sum += o;
      }
      const v = sum * carNorm;
      L[i] += v; R[i] += v;
    }
    return algo.out.some((k) => this.env[k].active);
  }
}

export default (sr, shared) => new PolyEngine(sr, FMVoice, shared);
