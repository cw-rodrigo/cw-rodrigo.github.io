// Bateria sintetizada no estilo 808/909, com o mapa de notas do General MIDI.
import { SVF, Delay, clamp } from '../dsp.js';
import { Voice, PolyEngine } from './poly.js';

const KIND = { 35: 'kick', 36: 'kick', 37: 'rim', 38: 'snare', 40: 'snare', 39: 'clap', 42: 'hat', 44: 'hat', 46: 'ohat', 49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash', 51: 'ride', 59: 'ride', 53: 'bell', 56: 'cowbell', 54: 'tamb', 75: 'clave', 41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom' };
const TOM_HZ = { 41: 80, 43: 98, 45: 118, 47: 142, 48: 168, 50: 200 };
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];

/** Nome da peça para uma nota (para a interface). */
export function drumName(n) {
  return { kick: 'Bumbo', rim: 'Aro', snare: 'Caixa', clap: 'Palmas', hat: 'Chimbal fechado', ohat: 'Chimbal aberto', crash: 'Prato de ataque', ride: 'Prato de condução', bell: 'Cúpula', cowbell: 'Cowbell', tamb: 'Pandeirola', clave: 'Clave', tom: 'Tom' }[KIND[n]] || 'Percussão';
}

class DrumVoice extends Voice {
  constructor(eng) { super(eng); this.f1 = new SVF(this.sr); this.f2 = new SVF(this.sr); this.ph = new Float64Array(6); this.t = 0; }
  onStart() {
    const n = this.note;
    this.kind = KIND[n] || 'perc';
    this.t = 0; this.ph.fill(0); this.f1.reset(); this.f2.reset(); this.kph = 0;
    const p = this.p, sr = this.sr;
    if (this.kind === 'ohat' || this.kind === 'hat') this.eng.choke?.(this);
    if (this.kind === 'snare') this.f1.set(3000 + p.sSnap * 3000, 0.2);
    if (this.kind === 'clap') this.f1.set(1200, 0.5);
    if (['hat', 'ohat', 'crash', 'ride', 'bell', 'tamb'].includes(this.kind)) { this.f1.set(this.kind === 'ride' || this.kind === 'bell' ? 4500 : 7000 + p.hTone * 3000, 0.25); this.f2.set(11000, 0.1); }
    if (this.kind === 'cowbell') this.f1.set(2640, 0.6);
    if (this.kind === 'clave') this.f1.set(2500, 0.9);
    this.dur = { kick: p.kDecay * 1.5, snare: Math.max(p.sDecay, 0.15) * 1.5, clap: p.cDecay * 1.5, hat: p.hDecay * 2, ohat: p.ohDecay * 1.5, crash: p.cyDecay * 1.4, ride: p.cyDecay * 1.2, bell: 1.2, cowbell: 0.6, tamb: 0.4, clave: 0.15, rim: 0.12, tom: p.tDecay * 1.6, perc: 0.3 }[this.kind];
    this.sr1 = 1 / sr;
  }
  onRelease() {}
  renderVoice(L, R, a, b) {
    const p = this.p, sr = this.sr, k = this.kind, vg = (0.3 + 0.7 * (this.vel / 127)) * 0.8;
    for (let i = a; i < b; i++) {
      const t = this.t; this.t += this.sr1;
      let s = 0;
      const noise = Math.random() * 2 - 1;
      switch (k) {
        case 'kick': {
          const f = p.kTune * (1 + p.kPunch * 3.5 * Math.exp(-t / 0.025));
          this.kph += f / sr;
          s = Math.sin(2 * Math.PI * this.kph) * Math.exp(-t / (p.kDecay * 0.35));
          if (t < 0.003) s += noise * p.kPunch * 0.5;
          s = Math.tanh(s * (1 + p.kDrive * 4)) / Math.tanh(1 + p.kDrive * 4) ;
          break;
        }
        case 'snare': {
          this.kph += p.sTune / sr; this.ph[1] += (p.sTune * 1.47) / sr;
          const tone = (Math.sin(2 * Math.PI * this.kph) + 0.6 * Math.sin(2 * Math.PI * this.ph[1])) * Math.exp(-t / 0.06) * (1 - p.sSnap * 0.6);
          s = tone * 0.7 + this.f1.run(noise, 1) * Math.exp(-t / (p.sDecay * 0.4)) * p.sSnap * 1.2;
          break;
        }
        case 'clap': {
          const burst = t < 0.03 ? Math.exp(-((t % 0.01) / 0.003)) : 0;
          s = this.f1.run(noise, 2) * (burst + Math.exp(-t / (p.cDecay * 0.35)) * 0.8) * 2;
          break;
        }
        case 'hat': case 'ohat': case 'crash': case 'ride': case 'bell': case 'tamb': {
          const tone = 0.8 + p.hTone * 0.6;
          let m = 0;
          for (let j = 0; j < 6; j++) { this.ph[j] = (this.ph[j] + (METAL[j] * tone * (k === 'bell' ? 0.5 : 1)) / sr) % 1; m += this.ph[j] < 0.5 ? 1 : -1; }
          const mix = k === 'crash' ? m * 0.08 + noise * 0.9 : k === 'tamb' ? noise : m * 0.15 + noise * (k === 'ride' ? 0.3 : 0.4);
          const dec = { hat: p.hDecay, ohat: p.ohDecay, crash: p.cyDecay, ride: p.cyDecay * 0.8, bell: 0.6, tamb: 0.12 }[k];
          s = this.f2.run(this.f1.run(mix, k === 'bell' ? 2 : 1), 0) * Math.exp(-t / (dec * 0.35)) * (k === 'bell' ? 1.5 : 0.9);
          break;
        }
        case 'cowbell': {
          this.ph[0] = (this.ph[0] + 540 / sr) % 1; this.ph[1] = (this.ph[1] + 800 / sr) % 1;
          const sq = (this.ph[0] < 0.5 ? 1 : -1) + (this.ph[1] < 0.5 ? 1 : -1);
          s = this.f1.run(sq, 2) * (0.6 * Math.exp(-t / 0.015) + 0.4 * Math.exp(-t / 0.12));
          break;
        }
        case 'clave': this.kph += 2500 / sr; s = Math.sin(2 * Math.PI * this.kph) * Math.exp(-t / 0.025); break;
        case 'rim': this.kph += 1700 / sr; s = (Math.sin(2 * Math.PI * this.kph) * 0.8 + noise * 0.4) * Math.exp(-t / 0.012); break;
        case 'tom': {
          const base = (TOM_HZ[this.note] || 120) * p.tTune;
          this.kph += (base * (1 + 0.5 * Math.exp(-t / 0.05))) / sr;
          s = (Math.sin(2 * Math.PI * this.kph) + noise * 0.05 * Math.exp(-t / 0.02)) * Math.exp(-t / (p.tDecay * 0.35));
          break;
        }
        default: { // percussão genérica afinada pela nota
          this.kph += (220 * 2 ** ((this.note - 60) / 12)) / sr;
          s = Math.sin(2 * Math.PI * this.kph) * Math.exp(-t / 0.08);
        }
      }
      const v = clamp(s * vg, -1.5, 1.5);
      L[i] += v; R[i] += v;
    }
    return this.t < this.dur;
  }
}

export default (sr, shared) => {
  const eng = new PolyEngine(sr, DrumVoice, shared);
  // chimbal fechado corta o aberto, como na bateria de verdade
  eng.choke = (v) => { for (const o of eng.voices) if (o !== v && o.alive && (o.kind === 'ohat') && v.kind === 'hat') o.kill(); };
  // notas de bateria não dependem de soltar a tecla; a mesma peça pode soar sobreposta
  const on = eng.noteOn.bind(eng);
  eng.noteOn = (note, vel) => {
    let v = eng.voices.find((x) => !x.alive);
    if (!v && eng.voices.length < 24) { v = new DrumVoice(eng); eng.voices.push(v); }
    if (!v) { v = eng.voices.reduce((a, b) => (b.age < a.age ? b : a)); v.kill(); }
    v.start(note, vel);
    return on;
  };
  eng.noteOff = () => {};
  return eng;
};
