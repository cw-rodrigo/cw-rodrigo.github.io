// Formante (voz): fonte parecida com a das cordas vocais + ressonâncias das vogais (5 formantes).
import { Env, Reson, OnePole, LFO, osc } from '../dsp.js';
import { Voice, PolyEngine } from './poly.js';

// [frequências], [ganhos em dB], [larguras de banda] para a, e, i, o, u — por tipo de voz (tabela clássica de formantes)
const T = {
  0: [[[600, 1040, 2250, 2450, 2750], [0, -7, -9, -9, -20], [60, 70, 110, 120, 130]], [[400, 1620, 2400, 2800, 3100], [0, -12, -9, -12, -18], [40, 80, 100, 120, 120]], [[250, 1750, 2600, 3050, 3340], [0, -30, -16, -22, -28], [60, 90, 100, 120, 120]], [[400, 750, 2400, 2600, 2900], [0, -11, -21, -20, -40], [40, 80, 100, 120, 120]], [[350, 600, 2400, 2675, 2950], [0, -20, -32, -28, -36], [40, 80, 100, 120, 120]]],
  1: [[[650, 1080, 2650, 2900, 3250], [0, -6, -7, -8, -22], [80, 90, 120, 130, 140]], [[400, 1700, 2600, 3200, 3580], [0, -14, -12, -14, -20], [70, 80, 100, 120, 120]], [[290, 1870, 2800, 3250, 3540], [0, -15, -18, -20, -30], [40, 90, 100, 120, 120]], [[400, 800, 2600, 2800, 3000], [0, -10, -12, -12, -26], [40, 80, 100, 120, 120]], [[350, 600, 2700, 2900, 3300], [0, -20, -17, -14, -26], [40, 60, 100, 120, 120]]],
  2: [[[800, 1150, 2800, 3500, 4950], [0, -4, -20, -36, -60], [80, 90, 120, 130, 140]], [[400, 1600, 2700, 3300, 4950], [0, -24, -30, -35, -60], [60, 80, 120, 150, 200]], [[350, 1700, 2700, 3700, 4950], [0, -20, -30, -36, -60], [50, 100, 120, 150, 200]], [[450, 800, 2830, 3500, 4950], [0, -9, -16, -28, -55], [70, 80, 100, 130, 135]], [[325, 700, 2530, 3500, 4950], [0, -12, -30, -40, -64], [50, 60, 170, 180, 200]]],
  3: [[[800, 1150, 2900, 3900, 4950], [0, -6, -32, -20, -50], [80, 90, 120, 130, 140]], [[350, 2000, 2800, 3600, 4950], [0, -20, -15, -40, -56], [60, 100, 120, 150, 200]], [[270, 2140, 2950, 3900, 4950], [0, -12, -26, -26, -44], [60, 90, 100, 120, 120]], [[450, 800, 2830, 3800, 4950], [0, -11, -22, -22, -50], [40, 80, 100, 120, 120]], [[325, 700, 2700, 3800, 4950], [0, -16, -35, -40, -60], [50, 60, 170, 180, 200]]],
};

class FormantVoice extends Voice {
  constructor(eng) {
    super(eng);
    this.ae = new Env(this.sr); this.res = [0, 1, 2, 3, 4].map(() => new Reson()); this.lp = new OnePole();
    this.vib = new LFO(this.sr); this.vow = new LFO(this.sr); this.ph = 0; this.n = 0; this.t = 0;
  }
  update() { const p = this.p; this.ae.set(p.aeA, p.aeD, p.aeS, p.aeR); }
  onStart(legato) { this.update(); this.ae.trigger(legato); if (!legato) this.t = 0; }
  onRelease() { this.ae.release(); }
  setFormants(v) {
    const tab = T[this.p.voiceType | 0] || T[1];
    const i = Math.min(3, Math.max(0, Math.floor(v))), x = Math.min(1, Math.max(0, v - i));
    for (let k = 0; k < 5; k++) {
      const f = tab[i][0][k] + (tab[i + 1][0][k] - tab[i][0][k]) * x;
      const g = tab[i][1][k] + (tab[i + 1][1][k] - tab[i][1][k]) * x;
      const bw = tab[i][2][k] + (tab[i + 1][2][k] - tab[i][2][k]) * x;
      this.res[k].setBw(Math.min(f, this.sr * 0.45), bw, this.sr, 10 ** (g / 20));
    }
  }
  renderVoice(L, R, a, b) {
    const p = this.p, sr = this.sr, vg = this.velGain * 0.14;
    this.lp.setFreq(800 + (p.bright || 0.5) * 6000, sr);
    for (let i = a; i < b; i++) {
      this.t += 1 / sr;
      const vibAmt = Math.min(1, Math.max(0, (this.t - (p.vibDelay || 0)) / 0.3));
      let f = this.stepFreq() * 2 ** ((this.vib.next(p.vibRate || 5, 0) * (p.vibDepth || 0) * vibAmt) / 1200);
      const dt = f / sr;
      // fonte glotal: serra suavizada + sopro
      let src = this.lp.run(osc(0, this.ph, dt));
      this.ph = (this.ph + dt) % 1;
      src += (Math.random() * 2 - 1) * (p.breath || 0) * 0.6;
      if ((this.n++ & 31) === 0) {
        let v = p.vowel || 0;
        if (p.vowelLfo) v += this.vow.next(p.vowelRate || 0.3, 0) * p.vowelLfo * 2;
        this.setFormants(Math.min(4, Math.max(0, v)));
      }
      let s = 0;
      for (let k = 0; k < 5; k++) s += this.res[k].run(src);
      const v = s * this.ae.next() * vg;
      L[i] += v; R[i] += v;
    }
    return this.ae.active;
  }
}

export default (sr, shared) => new PolyEngine(sr, FormantVoice, shared);
