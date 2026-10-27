// Gerenciamento de vozes (polifonia, roubo de vozes, modo mono com glide) comum aos motores.
import { mtof, clamp } from '../dsp.js';

/** Voz base: cada motor estende e implementa onStart/onRelease/renderVoice. */
export class Voice {
  constructor(eng) {
    this.eng = eng; this.sr = eng.sr; this.note = -1; this.vel = 0; this.gate = false; this.age = 0;
    this.freq = 440; this.target = 440; this.glideCoef = 1; this.alive = false;
  }
  get p() { return this.eng.p; }
  /** Força da nota (0..1) já com a sensibilidade escolhida. */
  get velGain() { const s = this.p.velSens ?? 0.6; return 1 - s + s * (this.vel / 127); }
  start(note, vel, legato = false) {
    this.note = note; this.vel = vel; this.gate = true; this.age = this.eng.clock++; this.alive = true;
    this.target = mtof(note);
    const g = this.p.glide || 0;
    if (!legato || g <= 0) this.freq = this.target;
    this.glideCoef = g > 0 ? 1 - Math.exp(-1 / (g * this.sr * 0.25)) : 1;
    this.onStart(legato);
  }
  release() { if (this.gate) { this.gate = false; this.onRelease(); } }
  kill() { this.gate = false; this.alive = false; this.onKill?.(); }
  /** Frequência atual com glide e pitch bend (chamar uma vez por amostra). */
  stepFreq() {
    if (this.freq !== this.target) {
      this.freq += (this.target - this.freq) * this.glideCoef;
      if (Math.abs(this.freq - this.target) < 0.001) this.freq = this.target;
    }
    return this.freq * this.eng.bendMul;
  }
  render(L, R, a, b) { this.alive = this.renderVoice(L, R, a, b); return this.alive; }
  onStart() {} onRelease() {}
}

/** Motor polifônico genérico. */
export class PolyEngine {
  constructor(sr, VoiceClass, shared = {}) {
    this.sr = sr; this.VoiceClass = VoiceClass; this.shared = shared;
    this.voices = []; this.held = []; this.clock = 0; this.p = {}; this.bend = 0; this.bendMul = 1; this.mod = 0;
  }
  setParams(p) { this.p = p; this.setBend(this.bend); for (const v of this.voices) v.update?.(); }
  setBend(semis) { this.bend = semis; this.bendMul = 2 ** ((semis * (this.p.bendRange ?? 2)) / 12); }
  setMod(v) { this.mod = v; }
  maxVoices() { return this.p.mono ? 1 : clamp(Math.round(this.p.voices || 8), 1, 32); }
  noteOn(note, vel) {
    if (this.p.mono) {
      this.held = this.held.filter((n) => n !== note);
      this.held.push(note);
      let v = this.voices[0];
      if (!v) { v = new this.VoiceClass(this); this.voices.push(v); }
      v.start(note, vel, v.alive && v.gate && (this.p.glide || 0) > 0);
      return;
    }
    // mesma nota ainda soando: reaproveita a voz
    let v = this.voices.find((x) => x.note === note && x.alive);
    if (!v) v = this.voices.find((x) => !x.alive);
    if (!v && this.voices.length < this.maxVoices()) { v = new this.VoiceClass(this); this.voices.push(v); }
    if (!v) {
      // rouba a voz mais antiga, de preferência uma que já foi solta
      const released = this.voices.filter((x) => !x.gate);
      v = (released.length ? released : this.voices).reduce((a, b) => (b.age < a.age ? b : a));
      v.kill();
    }
    v.start(note, vel);
  }
  noteOff(note) {
    if (this.p.mono) {
      this.held = this.held.filter((n) => n !== note);
      const v = this.voices[0];
      if (!v || v.note !== note) return;
      if (this.held.length) v.start(this.held[this.held.length - 1], v.vel, true);
      else v.release();
      return;
    }
    for (const v of this.voices) if (v.note === note && v.gate) v.release();
  }
  allOff() { this.held = []; for (const v of this.voices) v.release(); }
  panic() { this.held = []; for (const v of this.voices) v.kill(); }
  render(L, R, a, b) { for (const v of this.voices) if (v.alive) v.render(L, R, a, b); }
}
