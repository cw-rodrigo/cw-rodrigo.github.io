// AM e ring: uma moduladora controla o volume da portadora (AM soma, ring multiplica).
import { Env, SVF, osc } from '../dsp.js';
import { Voice, PolyEngine } from './poly.js';

class AMVoice extends Voice {
  constructor(eng) {
    super(eng);
    this.ae = new Env(this.sr); this.me = new Env(this.sr); this.f = new SVF(this.sr);
    this.pc = 0; this.pm = 0; this.n = 0;
  }
  update() { const p = this.p; this.ae.set(p.aeA, p.aeD, p.aeS, p.aeR); this.me.set(p.meA, p.meD, p.meS, p.meR); }
  onStart(legato) { this.update(); this.ae.trigger(legato); this.me.trigger(legato); if (!legato) { this.pc = 0; this.pm = 0; this.f.reset(); } }
  onRelease() { this.ae.release(); this.me.release(); }
  renderVoice(L, R, a, b) {
    const p = this.p, sr = this.sr, vg = this.velGain * 0.45;
    const ratio = p.modRatio * 2 ** ((p.modFine || 0) / 1200);
    const ring = (p.amMode | 0) === 1;
    for (let i = a; i < b; i++) {
      const f = this.stepFreq();
      const dc = f / sr, dm = (f * ratio) / sr;
      const c = osc(p.carWave | 0, this.pc, dc);
      const m = osc(p.modWave | 0, this.pm, dm);
      this.pc = (this.pc + dc) % 1; this.pm = (this.pm + dm) % 1;
      const d = p.depth * this.me.next();
      const s = ring ? c * ((1 - d) + d * m) : c * (1 - d + d * (0.5 + 0.5 * m));
      if ((this.n++ & 15) === 0) this.f.set(p.cutoff * 2 ** ((p.fEnv || 0) * this.ae.v + (p.keyTrack || 0) * ((this.note - 60) / 12)), p.res);
      const v = this.f.run(s, p.fType | 0) * this.ae.next() * vg;
      L[i] += v; R[i] += v;
    }
    return this.ae.active;
  }
}

export default (sr, shared) => new PolyEngine(sr, AMVoice, shared);
