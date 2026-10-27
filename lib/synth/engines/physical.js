// Modelagem física: corda dedilhada (Karplus-Strong estendido), barras e sinos (modos de vibração),
// flauta (guia de onda com jato de ar, inspirada no STK) e membrana de tambor.
import { Delay, OnePole, Reson, LFO, clamp } from '../dsp.js';
import { Voice, PolyEngine } from './poly.js';

// razões de frequência e durações relativas dos modos
const MODES = {
  1: { r: [1, 3.99, 10.65, 18.4], d: [1, 0.45, 0.18, 0.08], a: [1, 0.35, 0.15, 0.06] }, // marimba
  2: { r: [0.5, 1, 1.183, 1.506, 2, 2.514, 2.662, 3.011, 4.166, 5.433], d: [1.6, 1, 0.8, 0.7, 0.55, 0.4, 0.35, 0.3, 0.2, 0.12], a: [0.5, 1, 0.7, 0.4, 0.6, 0.3, 0.3, 0.25, 0.2, 0.15] }, // sino
  3: { r: [1, 4, 10.3], d: [1, 0.6, 0.3], a: [1, 0.3, 0.1] }, // vibrafone
  5: { r: [1, 1.594, 2.136, 2.296, 2.653, 2.918, 3.156, 3.501], d: [1, 0.7, 0.55, 0.5, 0.4, 0.35, 0.3, 0.25], a: [1, 0.8, 0.6, 0.55, 0.45, 0.4, 0.3, 0.25] }, // membrana
};

class PhysVoice extends Voice {
  constructor(eng) {
    super(eng);
    const sr = this.sr;
    this.dl = new Delay(Math.ceil(sr / 15)); this.jet = new Delay(Math.ceil(sr / 30));
    this.lp = new OnePole(); this.lp2 = new OnePole(); this.body = new Reson(); this.body2 = new Reson();
    this.modes = Array.from({ length: 10 }, () => new Reson());
    this.lfo = new LFO(sr); this.exc = null; this.excPos = 0; this.env = 0; this.relGain = 1; this.t = 0; this.dc = 0; this.dcIn = 0;
  }
  onStart() {
    const p = this.p, sr = this.sr, f = this.freq, model = p.model | 0;
    this.model = model; this.t = 0; this.relGain = 1; this.env = 1; this.dl.clear(); this.jet.clear();
    const hard = p.hardness ?? 0.5, vel = this.vel / 127;
    if (model === 0) {
      // ruído filtrado com "pente" no ponto de ataque (onde a corda é dedilhada)
      const L = sr / f, n = Math.max(2, Math.round(L));
      const lp = new OnePole(); lp.setFreq(400 + hard * 9000 * (0.4 + vel), sr);
      const raw = Float32Array.from({ length: n }, () => lp.run(Math.random() * 2 - 1));
      const off = Math.max(1, Math.round(n * (p.position || 0.2)));
      this.exc = raw.map((v, i) => v - (i >= off ? raw[i - off] : 0));
      this.excPos = 0;
      this.loopGain = 10 ** (-3 / (f * (0.3 + (p.decay || 0.6) * 9)));
      this.lp.setCoef(0.15 + (p.bright || 0.6) * 0.8);
      this.body.set(110, 0.08, sr, 1); this.body2.set(230, 0.05, sr, 1);
    } else if (model === 4) {
      this.lp.setCoef(0.6); this.breath = 0; this.loopGain = 1;
    } else {
      const m = MODES[model];
      const dur = 0.15 + (p.decay || 0.6) * (model === 2 ? 9 : model === 3 ? 6 : 2.5);
      m.r.forEach((r, k) => {
        const fr = f * r;
        // ponto de ataque muda quais modos aparecem; agudos somem acima do limite
        const pos = Math.abs(Math.sin(Math.PI * (k + 1) * (p.position || 0.2))) * 0.7 + 0.3;
        const bright = k === 0 ? 1 : 0.3 + (p.bright || 0.6) * 0.9;
        this.modes[k].set(fr < sr * 0.45 ? fr : 0, dur * m.d[k], sr, fr < sr * 0.45 ? m.a[k] * pos * bright : 0);
      });
      this.nModes = m.r.length;
      // baqueta: pulso curto, mais curto quanto mais dura
      const w = Math.max(2, Math.round(sr * (0.006 - hard * 0.0055)));
      this.exc = Float32Array.from({ length: w }, (_, i) => Math.sin((Math.PI * i) / w) * (0.6 + vel));
      this.excPos = 0;
    }
  }
  onRelease() { this.relGain = 1 - (this.p.damp ?? 0.7) * 0.6; }
  renderVoice(L, R, a, b) {
    const p = this.p, sr = this.sr, vg = this.velGain;
    const model = this.model;
    let quiet = 0;
    for (let i = a; i < b; i++) {
      const f = this.stepFreq();
      let out = 0;
      const ex = this.exc && this.excPos < this.exc.length ? this.exc[this.excPos++] : 0;
      if (model === 0) {
        const Ld = sr / f - 0.5;
        const y = this.dl.read(Math.max(2, Ld));
        const fl = this.lp.run(y);
        const g = this.loopGain * (this.gate ? 1 : this.relGain ** (1 / 200));
        this.dl.write(ex + fl * g);
        out = y + (p.body || 0) * (this.body.run(y) + this.body2.run(y)) * 0.6;
      } else if (model === 4) {
        // flauta: pressão do sopro → atraso do jato → não-linearidade → tubo
        const target = this.gate ? (p.breath || 0.8) : 0;
        this.breath += (target - this.breath) * (this.gate ? 0.0015 : 0.004);
        const vib = this.lfo.next(5, 0) * (p.vibDepth || 0);
        const bp = this.breath * (1 + vib) * (1 + (Math.random() * 2 - 1) * (p.noise || 0.1)) * (0.7 + 0.3 * vg);
        const boreLen = sr / f - 0.3;
        let tmp = this.lp.run(this.dl.read(Math.max(2, boreLen)));
        // bloqueio de DC
        const dcOut = tmp - this.dcIn + 0.995 * this.dc; this.dcIn = tmp; this.dc = dcOut; tmp = dcOut;
        this.jet.write(bp - 0.5 * tmp);
        let pd = this.jet.read(Math.max(1, boreLen * 0.32));
        pd = clamp(pd * (pd * pd - 1), -1, 1);
        this.dl.write(pd + 0.5 * tmp);
        out = tmp * 0.3;
        if (!this.gate && this.breath < 0.002) return false;
      } else {
        const trem = model === 3 ? 1 + 0.35 * this.lfo.next(5.5, 0) : 1;
        let s = 0;
        for (let k = 0; k < this.nModes; k++) s += this.modes[k].run(ex);
        if (!this.gate) { this.env *= this.relGain ** (1 / 400); }
        out = s * 6 * trem * this.env;
      }
      out *= 0.6;
      L[i] += out; R[i] += out;
      if (Math.abs(out) < 1e-5) quiet++; else quiet = 0;
    }
    this.t += (b - a) / sr;
    this.silent = (this.silent || 0) + (quiet === b - a ? b - a : -this.silent);
    return !(this.t > 0.05 && this.silent > sr * 0.2);
  }
}

export default (sr, shared) => new PolyEngine(sr, PhysVoice, shared);
