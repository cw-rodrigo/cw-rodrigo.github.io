// Aditivo: soma de senos (harmônicos) com volume próprio, inarmonicidade e queda mais rápida nos agudos.
import { Env, LFO, fsin } from '../dsp.js';
import { Voice, PolyEngine } from './poly.js';

class AddVoice extends Voice {
  constructor(eng) {
    super(eng);
    this.ae = new Env(this.sr); this.lfo = new LFO(this.sr);
    this.ph = new Float64Array(32); this.amp = new Float32Array(32); this.ratio = new Float32Array(32); this.decay = new Float32Array(32); this.cur = new Float32Array(32);
    this.count = 0;
  }
  update() {
    const p = this.p;
    this.ae.set(p.aeA, p.aeD, p.aeS, p.aeR);
    const h = p.harm || [];
    const n = Math.max(1, Math.min(32, Math.round(p.partials || 32)));
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const num = k + 1;
      let a = h[k] ?? 0;
      a *= 10 ** (((p.tilt || 0) * Math.log2(num)) / 20);
      // positivo tira os pares (som oco, de clarinete); negativo tira os ímpares (menos o fundamental)
      const oe = p.oddEven || 0;
      if (num % 2 === 0 && oe > 0) a *= 1 - oe;
      if (num % 2 === 1 && num > 1 && oe < 0) a *= 1 + oe;
      this.amp[k] = Math.max(0, a);
      this.ratio[k] = num * Math.sqrt(1 + (p.stretch || 0) * num * num);
      this.decay[k] = Math.exp(-((p.decayTilt || 0) * 6 * (k / 31)) / this.sr);
      sum += this.amp[k];
    }
    this.count = n;
    const norm = sum > 0 ? 1 / Math.max(1, sum * 0.6) : 0;
    for (let k = 0; k < n; k++) this.amp[k] *= norm;
  }
  onStart(legato) { this.update(); this.ae.trigger(legato); if (!legato) { this.cur.fill(1); for (let k = 0; k < 32; k++) this.ph[k] = Math.random(); } }
  onRelease() { this.ae.release(); }
  renderVoice(L, R, a, b) {
    const p = this.p, sr = this.sr, n = this.count, vg = this.velGain * 0.5;
    const vibD = (p.vibDepth || 0) / 1200;
    for (let i = a; i < b; i++) {
      let f = this.stepFreq();
      if (vibD) f *= 2 ** (this.lfo.next(p.vibRate || 5, 0) * vibD);
      const nyq = sr * 0.45;
      let s = 0;
      for (let k = 0; k < n; k++) {
        const fk = f * this.ratio[k];
        if (fk > nyq) break;
        this.cur[k] *= this.decay[k];
        s += this.amp[k] * this.cur[k] * fsin(this.ph[k]);
        this.ph[k] += fk / sr;
        if (this.ph[k] > 1e6) this.ph[k] -= Math.floor(this.ph[k]);
      }
      const v = s * this.ae.next() * vg;
      L[i] += v; R[i] += v;
    }
    return this.ae.active;
  }
}

export default (sr, shared) => new PolyEngine(sr, AddVoice, shared);
