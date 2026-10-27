// Subtrativo: 2 osciladores (com uníssono), sub-oscilador e ruído → filtro com envelope → amplificador.
import { Env, SVF, LFO, osc, panGains } from '../dsp.js';
import { Voice, PolyEngine } from './poly.js';

const UNI_OFFSETS = [[0], [-1, 1], [-1, 0, 1], [-1, -0.33, 0.33, 1], [-1, -0.5, 0, 0.5, 1], [-1, -0.6, -0.2, 0.2, 0.6, 1], [-1, -0.66, -0.33, 0, 0.33, 0.66, 1]];

class SubVoice extends Voice {
  constructor(eng) {
    super(eng);
    this.ae = new Env(this.sr); this.fe = new Env(this.sr);
    this.fL = new SVF(this.sr); this.fR = new SVF(this.sr);
    this.lfo = new LFO(this.sr);
    this.ph1 = new Float64Array(7).map(() => Math.random()); this.ph2 = new Float64Array(7).map(() => Math.random());
    this.subPh = 0; this.n = 0;
  }
  update() {
    const p = this.p;
    this.ae.set(p.aeA, p.aeD, p.aeS, p.aeR); this.fe.set(p.feA, p.feD, p.feS, p.feR);
  }
  onStart(legato) { this.update(); this.ae.trigger(legato); this.fe.trigger(legato); if (!legato) { this.fL.reset(); this.fR.reset(); } }
  onRelease() { this.ae.release(); this.fe.release(); }
  renderVoice(L, R, a, b) {
    const p = this.p, sr = this.sr;
    const uni = Math.max(1, Math.min(7, Math.round(p.uni || 1)));
    const offs = UNI_OFFSETS[uni - 1];
    const pans = offs.map((o) => panGains(o * (p.uniSpread ?? 0.5)));
    const det = (p.uniDetune || 0) * 50; // cents
    const o2mul = 2 ** ((p.o2Oct || 0) + (p.o2Semi || 0) / 12 + (p.o2Fine || 0) / 1200);
    const o1mul = 2 ** (p.o1Oct || 0);
    const w1 = p.o1Wave | 0, w2 = p.o2Wave | 0;
    const norm = 1 / Math.sqrt(uni);
    const mode = p.fType | 0;
    const vg = this.velGain;
    const lfoD = p.lfoDepth || 0, lfoDest = p.lfoDest | 0;
    for (let i = a; i < b; i++) {
      const lv = lfoD ? this.lfo.next(p.lfoRate, p.lfoShape | 0) * lfoD : 0;
      let f = this.stepFreq();
      if (lfoDest === 0 && lv) f *= 2 ** (lv * 2 / 12);
      const pwMod = lfoDest === 3 ? lv * 0.4 : 0;
      const env = this.ae.next();
      const fenv = this.fe.next();
      let l = 0, r = 0;
      for (let k = 0; k < uni; k++) {
        const dm = 2 ** ((offs[k] * det) / 1200);
        const dt1 = (f * o1mul * dm) / sr, dt2 = (f * o2mul * dm) / sr;
        let s = 0;
        if (p.o1Lvl) s += p.o1Lvl * osc(w1, this.ph1[k], dt1, Math.min(0.95, Math.max(0.05, p.o1Pw + pwMod)));
        if (p.o2Lvl) s += p.o2Lvl * osc(w2, this.ph2[k], dt2, Math.min(0.95, Math.max(0.05, p.o2Pw + pwMod)));
        this.ph1[k] = (this.ph1[k] + dt1) % 1; this.ph2[k] = (this.ph2[k] + dt2) % 1;
        l += s * pans[k][0]; r += s * pans[k][1];
      }
      l *= norm; r *= norm;
      if (p.sub) { const sdt = (f * o1mul) / (2 * sr); const s = (this.subPh < 0.5 ? 1 : -1) * p.sub * 0.7; this.subPh = (this.subPh + sdt) % 1; l += s; r += s; }
      if (p.noise) { const nz = (Math.random() * 2 - 1) * p.noise * 0.5; l += nz; r += nz; }
      if ((this.n++ & 15) === 0) {
        let oct = (p.fEnv || 0) * fenv + (p.keyTrack || 0) * ((this.note - 60) / 12);
        if (lfoDest === 1) oct += lv * 2;
        const fc = p.cutoff * 2 ** oct;
        this.fL.set(fc, p.res); this.fR.set(fc, p.res);
      }
      l = this.fL.run(l, mode); r = this.fR.run(r, mode);
      let g = env * vg * 0.5;
      if (lfoDest === 2) g *= 1 - 0.5 * (lfoD + lv); // tremolo
      L[i] += l * g; R[i] += r * g;
    }
    return this.ae.active;
  }
}

export default (sr, shared) => new PolyEngine(sr, SubVoice, shared);
