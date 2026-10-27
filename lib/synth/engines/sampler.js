// Sampler/rompler: toca zonas de amostras (instrumentos General MIDI ou uma gravação sua),
// reafinando pela nota, com loop, ao contrário, filtro e envelopes.
import { Env, SVF } from '../dsp.js';
import { Voice, PolyEngine } from './poly.js';

class SampVoice extends Voice {
  constructor(eng) { super(eng); this.ae = new Env(this.sr); this.fe = new Env(this.sr); this.fL = new SVF(this.sr); this.fR = new SVF(this.sr); this.n = 0; }
  update() { const p = this.p; this.ae.set(p.aeA, p.aeD, p.aeS, p.aeR); this.fe.set(p.feA, p.feD, p.feS, p.feR); }
  onStart(legato) {
    this.update(); this.ae.trigger(legato); this.fe.trigger(legato);
    if (legato) return;
    const zones = this.eng.shared.zones || [];
    const n = this.note;
    this.zone = zones.find((z) => n >= z.lo && n <= z.hi) || zones.reduce((best, z) => (!best || Math.abs(z.root - n) < Math.abs(best.root - n) ? z : best), null);
    const z = this.zone;
    if (!z) return;
    const len = z.L.length;
    this.pos = this.p.reverse ? len - 1 - this.p.start * len : this.p.start * len;
    this.fL.reset(); this.fR.reset();
  }
  onRelease() { this.ae.release(); this.fe.release(); }
  renderVoice(L, R, a, b) {
    const z = this.zone;
    if (!z) return false;
    const p = this.p, sr = this.sr, len = z.L.length, Rch = z.R || z.L;
    const root = z.user ? p.root : z.root;
    const rev = !!p.reverse;
    const ls = Math.floor(p.loopStart * len), le = Math.max(ls + 32, Math.floor(p.loopEnd * len));
    const vg = this.velGain * 0.8;
    const mode = p.fType | 0;
    for (let i = a; i < b; i++) {
      const f = this.stepFreq();
      const rate = (f / (440 * 2 ** ((root - 69) / 12))) * 2 ** ((p.tune || 0) / 1200) * (z.sr / sr);
      const idx = this.pos;
      if (idx < 0 || idx >= len - 1) { if (!p.loop) return false; }
      const i0 = Math.max(0, Math.min(len - 2, idx | 0)), fr = idx - i0;
      let l = z.L[i0] + (z.L[i0 + 1] - z.L[i0]) * fr;
      let r = Rch[i0] + (Rch[i0 + 1] - Rch[i0]) * fr;
      this.pos += rev ? -rate : rate;
      if (p.loop) {
        if (!rev && this.pos >= le) this.pos = ls + (this.pos - le);
        if (rev && this.pos <= ls) this.pos = le - (ls - this.pos);
      }
      if ((this.n++ & 15) === 0) {
        const fc = p.cutoff * 2 ** ((p.fEnv || 0) * this.fe.next() + (p.keyTrack || 0) * ((this.note - 60) / 12));
        this.fL.set(fc, p.res); this.fR.set(fc, p.res);
      } else this.fe.next();
      if (p.cutoff < 19000 || p.fEnv) { l = this.fL.run(l, mode); r = this.fR.run(r, mode); }
      const g = this.ae.next() * vg;
      L[i] += l * g; R[i] += r * g;
    }
    return this.ae.active;
  }
}

export default (sr, shared) => new PolyEngine(sr, SampVoice, shared);
