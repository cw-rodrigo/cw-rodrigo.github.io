// Phase distortion (Casio CZ): um cosseno lido com a fase deformada. O DCW controla quanto a fase é
// deformada (0 = seno puro), com envelope próprio. Formas ressonantes simulam um filtro ressonante.
import { Env, TAU } from '../dsp.js';
import { Voice, PolyEngine } from './poly.js';

const cosc = (x) => Math.cos(TAU * x);
/** Fase deformada: a primeira metade do ciclo é comprimida até o ponto x. */
const warp = (t, x) => (t < x ? (0.5 * t) / x : 0.5 + (0.5 * (t - x)) / (1 - x));

/** Uma amostra da forma `w` na fase t (0..1) com distorção d (0..1). */
export function pdWave(w, t, d) {
  d = Math.max(0, Math.min(0.995, d));
  switch (w) {
    case 0: return -cosc(warp(t, 0.5 - 0.49 * d)); // serra
    case 1: { // quadrada: duas meias ondas íngremes
      const x = 0.5 - 0.49 * d;
      const u = (t * 2) % 1;
      const wv = warp(u, x);
      return t < 0.5 ? -cosc(wv / 2) : cosc(wv / 2);
    }
    case 2: { const portion = 1 - 0.95 * d, start = 1 - portion; return -cosc(t < start ? 0 : (t - start) / portion); } // pulso
    case 3: { const u = (t * 2) % 1; return -cosc(warp(u, 0.5 - 0.49 * d)) * (t < 0.5 ? 1 : 0.6); } // seno duplo
    case 4: { const x = 0.5 - 0.49 * d; return t < 0.5 ? -cosc(warp(t * 2, x) / 2) : -cosc(0.5 + (t - 0.5)); } // serra-pulso
    default: { // ressonantes: cosseno de frequência crescente dentro de uma janela
      const k = 1 + d * 15;
      const win = w === 5 ? 1 - t : w === 6 ? 1 - Math.abs(2 * t - 1) : Math.min(1, 2 * (1 - t));
      return win * (1 - cosc(t * k)) - win;
    }
  }
}

class PDVoice extends Voice {
  constructor(eng) { super(eng); this.ae = new Env(this.sr); this.de = new Env(this.sr); this.p1 = 0; this.p2 = 0; }
  update() { const p = this.p; this.ae.set(p.aeA, p.aeD, p.aeS, p.aeR); this.de.set(p.deA, p.deD, p.deS, p.deR); }
  onStart(legato) { this.update(); this.ae.trigger(legato); this.de.trigger(legato); if (!legato) { this.p1 = 0; this.p2 = 0; } }
  onRelease() { this.ae.release(); this.de.release(); }
  renderVoice(L, R, a, b) {
    const p = this.p, sr = this.sr;
    const w1 = p.pdWave | 0, w2 = (p.pd2Wave | 0) - 1;
    const mul2 = 2 ** ((p.pd2Oct || 0) + (p.pd2Fine || 0) / 1200);
    const key = (p.dcwKey || 0) * ((this.note - 60) / 48);
    const vg = this.velGain * 0.4;
    for (let i = a; i < b; i++) {
      const f = this.stepFreq();
      const d = Math.max(0, Math.min(1, p.dcw * this.de.next() * (0.6 + 0.4 * this.velGain) + key));
      let s = pdWave(w1, this.p1, d);
      this.p1 = (this.p1 + f / sr) % 1;
      if (w2 >= 0) { s += (p.pd2Lvl || 0) * pdWave(w2, this.p2, d); this.p2 = (this.p2 + (f * mul2) / sr) % 1; }
      const v = s * this.ae.next() * vg;
      L[i] += v; R[i] += v;
    }
    return this.ae.active;
  }
}

export default (sr, shared) => new PolyEngine(sr, PDVoice, shared);
