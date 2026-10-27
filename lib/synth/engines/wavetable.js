// Wavetable: tabelas de formas de onda geradas por espectro, com versões por oitava (sem aliasing) e
// leitura interpolada entre quadros (posição) com envelope e LFO.
import { Env, SVF, LFO, panGains } from '../dsp.js';
import { Voice, PolyEngine } from './poly.js';
import { fft } from '../../audio/fft.js';

const N = 1024;        // amostras por ciclo
const FRAMES = 32;     // quadros por tabela
const LEVELS = 9;      // versões por oitava (harmônicos: 512, 256, … 2)
const MAXH = 512;
const cache = new Map();

/** Amplitude do harmônico h (1..) no quadro de posição x (0..1). */
function spectrum(set, x, h) {
  switch (set) {
    case 0: { // seno → triângulo → serra → quadrada
      const sine = h === 1 ? 1 : 0;
      const tri = h % 2 ? (((h - 1) / 2) % 2 ? -1 : 1) / (h * h) : 0;
      const saw = 1 / h;
      const sq = h % 2 ? 1 / h : 0;
      const seg = x * 3, i = Math.min(2, Math.floor(seg)), t = seg - i;
      const k = [sine, tri, saw, sq];
      return k[i] + (k[i + 1] - k[i]) * t;
    }
    case 1: { const d = 0.5 - x * 0.46; return (2 / (h * Math.PI)) * Math.sin(Math.PI * h * d) * 1.6; } // pulso cada vez mais estreito
    case 2: { // formantes de vogais (a → e → i → o → u) sobre fundamental de 110 Hz
      const V = [[730, 1090, 2440], [530, 1840, 2480], [270, 2290, 3010], [570, 840, 2410], [300, 870, 2240]];
      const seg = x * 4, i = Math.min(3, Math.floor(seg)), t = seg - i;
      const fq = V[i].map((f, j) => f + (V[i + 1][j] - f) * t);
      const fh = h * 110;
      let a = 0;
      fq.forEach((f, j) => { a += [1, 0.5, 0.25][j] * Math.exp(-(((fh - f) / (60 + f * 0.08)) ** 2)); });
      return a / Math.sqrt(h) + (h === 1 ? 0.3 : 0);
    }
    case 3: { const c = 2 + x * 40; return Math.exp(-(((h - c) / (2 + x * 6)) ** 2)) + 0.5 / (h * h); } // aglomerado de harmônicos que sobe
    case 4: { const n = 1 + x * 63; return h <= n ? 1 / h : h <= n + 1 ? (n + 1 - h) / h : 0; } // cada vez mais harmônicos
    default: { // órgão: tubos ligados aos poucos
      const bars = { 1: 1, 2: 0.8 * Math.min(1, x * 3), 3: 0.6 * Math.min(1, Math.max(0, x * 3 - 0.5)), 4: 0.5 * Math.max(0, x * 2 - 0.6), 6: 0.4 * Math.max(0, x * 2 - 1), 8: 0.3 * Math.max(0, x * 2 - 1.2) };
      return bars[h] || 0;
    }
  }
}

export function getTable(set) {
  if (cache.has(set)) return cache.get(set);
  // cada quadro é montado pelo espectro com uma FFT inversa (rápido o bastante para o áudio não engasgar)
  const re = new Float64Array(N), im = new Float64Array(N);
  const levels = [];
  for (let l = 0; l < LEVELS; l++) {
    const maxH = MAXH >> l;
    const frames = [];
    for (let fi = 0; fi < FRAMES; fi++) {
      const x = fi / (FRAMES - 1);
      re.fill(0); im.fill(0);
      for (let h = 1; h <= Math.min(maxH, N / 2 - 1); h++) {
        const a = spectrum(set, x, h);
        if (!a) continue;
        im[h] = -a / 2; im[N - h] = a / 2; // seno de amplitude a
      }
      fft(re, im, true);
      const tab = new Float32Array(N + 1);
      let pk = 0;
      for (let i = 0; i < N; i++) { tab[i] = re[i]; pk = Math.max(pk, Math.abs(re[i])); }
      if (pk > 0) for (let i = 0; i < N; i++) tab[i] /= pk;
      tab[N] = tab[0];
      frames.push(tab);
    }
    levels.push(frames);
  }
  cache.set(set, levels);
  return levels;
}

function read(tab, ph) {
  const p = ph * N, i = p | 0, f = p - i;
  return tab[i] + (tab[i + 1] - tab[i]) * f;
}

class WTVoice extends Voice {
  constructor(eng) {
    super(eng);
    this.ae = new Env(this.sr); this.fe = new Env(this.sr); this.pe = new Env(this.sr);
    this.fL = new SVF(this.sr); this.fR = new SVF(this.sr); this.lfo = new LFO(this.sr);
    this.ph = new Float64Array(7).map(() => Math.random()); this.n = 0;
  }
  update() { const p = this.p; this.ae.set(p.aeA, p.aeD, p.aeS, p.aeR); this.fe.set(p.feA, p.feD, p.feS, p.feR); this.pe.set(p.peA, p.peD, p.peS, p.peR); }
  onStart(legato) { this.update(); this.ae.trigger(legato); this.fe.trigger(legato); this.pe.trigger(legato); }
  onRelease() { this.ae.release(); this.fe.release(); this.pe.release(); }
  renderVoice(L, R, a, b) {
    const p = this.p, sr = this.sr;
    const levels = getTable(p.table | 0);
    const uni = Math.max(1, Math.min(7, Math.round(p.uni || 1)));
    const det = (p.uniDetune || 0) * 40;
    const offs = Array.from({ length: uni }, (_, k) => (uni === 1 ? 0 : (k / (uni - 1)) * 2 - 1));
    const pans = offs.map((o) => panGains(o * (p.uniSpread ?? 0.5)));
    const norm = 0.5 / Math.sqrt(uni) * this.velGain;
    let frameA = levels[0][0], frameB = frameA, ft = 0, level = 0;
    for (let i = a; i < b; i++) {
      const f = this.stepFreq();
      if ((this.n & 15) === 0) {
        // versão da tabela sem harmônicos acima de metade da taxa de amostragem
        const allowed = sr / 2 / Math.max(20, f * 2 ** (det / 1200));
        level = 0;
        while (level < LEVELS - 1 && (MAXH >> level) > allowed) level++;
        let pos = p.pos + (p.posEnv || 0) * this.pe.next() * 16 / 16;
        if (p.posLfo) pos += this.lfo.next(p.posLfoRate || 0.5, 0) * p.posLfo * 0.5;
        pos = Math.max(0, Math.min(1, pos)) * (FRAMES - 1);
        const fi = Math.min(FRAMES - 2, Math.floor(pos));
        ft = pos - fi;
        frameA = levels[level][fi]; frameB = levels[level][fi + 1];
        const fc = p.cutoff * 2 ** ((p.fEnv || 0) * this.fe.v + (p.keyTrack || 0) * ((this.note - 60) / 12));
        this.fL.set(fc, p.res); this.fR.set(fc, p.res);
      } else if (p.posEnv) this.pe.next();
      this.n++;
      this.fe.next();
      let l = 0, r = 0;
      for (let k = 0; k < uni; k++) {
        const ph = this.ph[k];
        const s = read(frameA, ph) * (1 - ft) + read(frameB, ph) * ft;
        this.ph[k] = (ph + (f * 2 ** ((offs[k] * det) / 1200)) / sr) % 1;
        l += s * pans[k][0]; r += s * pans[k][1];
      }
      const g = this.ae.next() * norm;
      L[i] += this.fL.run(l, p.fType | 0) * g;
      R[i] += this.fR.run(r, p.fType | 0) * g;
    }
    return this.ae.active;
  }
}

export default (sr, shared) => new PolyEngine(sr, WTVoice, shared);
