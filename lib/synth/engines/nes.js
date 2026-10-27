// NES (Ricoh 2A03): emulação dos canais de pulso, triângulo e ruído, com temporizadores no relógio
// da CPU, misturador não linear e filtros da saída do aparelho, mais instrumentos no estilo do
// FamiTracker (sequências de volume, arpejo, afinação e duty rodando a 60 Hz).
// Implementado a partir da documentação pública do APU (NESdev); nenhum código do FamiTracker foi copiado.
import { mtof } from '../dsp.js';

const CLOCK = [1789773, 1662607];                       // NTSC, PAL
const FRAME_HZ = [1789773 / 29780.5, 1662607 / 33247.5]; // ≈ 60,1 e 50,0 Hz
const NOISE = [
  [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068],
  [4, 8, 14, 30, 60, 88, 118, 148, 188, 236, 354, 472, 708, 944, 1890, 3778],
];
const DUTY = [[0, 1, 0, 0, 0, 0, 0, 0], [0, 1, 1, 0, 0, 0, 0, 0], [0, 1, 1, 1, 1, 0, 0, 0], [1, 0, 0, 1, 1, 1, 1, 1]];
const TRI = [...Array.from({ length: 16 }, (_, i) => 15 - i), ...Array.from({ length: 16 }, (_, i) => i)];
const VIB_DEPTH = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32];

/** "15 12 | 10 8 / 4 0" -> { v, loop, rel }  ( | = ponto de loop, / = ponto de soltura ) */
export function parseSeq(str) {
  const v = []; let loop = -1, rel = -1;
  for (const tok of String(str || '').trim().split(/\s+/)) {
    if (!tok) continue;
    if (tok === '|') { loop = v.length; continue; }
    if (tok === '/') { rel = v.length; continue; }
    const n = parseInt(tok, 10);
    if (Number.isFinite(n)) v.push(n);
  }
  if (loop >= v.length) loop = -1;
  if (rel >= v.length) rel = -1;
  return v.length ? { v, loop, rel } : null;
}

class Seq {
  constructor(def) { this.def = def; this.pos = 0; this.released = false; }
  reset() { this.pos = 0; this.released = false; }
  release() { this.released = true; if (this.def && this.def.rel >= 0) this.pos = this.def.rel; }
  tick() {
    const d = this.def;
    if (!d) return null;
    const val = d.v[Math.min(this.pos, d.v.length - 1)];
    let next = this.pos + 1;
    if (!this.released && d.rel >= 0 && next >= d.rel) next = d.loop >= 0 && d.loop < d.rel ? d.loop : d.rel - 1;
    else if (next >= d.v.length) next = d.loop >= 0 && (!this.released || d.loop >= d.rel) ? d.loop : d.v.length - 1;
    this.pos = Math.max(0, next);
    return val;
  }
}

/** Um canal do APU: temporizador + sequenciador + saída digital (0..15). */
class Channel {
  constructor(type) { this.type = type; this.period = 0; this.step = 0; this.toNext = 1; this.vol = 0; this.duty = 2; this.lfsr = 1; this.mode = 0; this.noiseIdx = 0; this.on = false; }
  stepLen(region) {
    if (this.type === 'pulse') return 2 * (this.period + 1);
    if (this.type === 'tri') return this.period + 1;
    return NOISE[region][this.noiseIdx];
  }
  out() {
    if (!this.on) return this.type === 'tri' ? TRI[this.step] : 0;
    if (this.type === 'pulse') return this.period < 8 || this.period > 0x7ff ? 0 : DUTY[this.duty][this.step] ? this.vol : 0;
    if (this.type === 'tri') return TRI[this.step];
    return this.lfsr & 1 ? 0 : this.vol;
  }
  advance() {
    if (this.type === 'pulse') this.step = (this.step + 1) & 7;
    else if (this.type === 'tri') { if (this.on && this.period >= 2) this.step = (this.step + 1) & 31; }
    else { const fb = (this.lfsr & 1) ^ ((this.lfsr >> (this.mode ? 6 : 1)) & 1); this.lfsr = (this.lfsr >> 1) | (fb << 14); }
  }
  /** Saída média ao longo de `cycles` ciclos da CPU (filtra o que passaria da metade da taxa de amostragem). */
  integrate(cycles, region) {
    let acc = 0, rem = cycles;
    const len = this.stepLen(region);
    if (this.type === 'tri' && (!this.on || this.period < 2)) return this.out(); // parado: segura o nível
    while (rem > 0) {
      const d = Math.min(rem, this.toNext);
      acc += this.out() * d;
      rem -= d; this.toNext -= d;
      if (this.toNext <= 0) { this.advance(); this.toNext += len; }
    }
    return acc / cycles;
  }
}

/** O que está tocando num canal: nota + sequências do instrumento (como uma faixa do FamiTracker). */
class Track {
  constructor(ch) { this.ch = ch; this.note = -1; this.gate = false; this.active = false; this.age = 0; this.seq = {}; this.pitchAcc = 0; this.vibPh = 0; this.vel = 127; }
}

class NesEngine {
  constructor(sr) {
    this.sr = sr; this.p = {}; this.bend = 0; this.bendMul = 1; this.clock = 0;
    this.ch = { p1: new Channel('pulse'), p2: new Channel('pulse'), tri: new Channel('tri'), noise: new Channel('noise') };
    this.tracks = { p1: new Track(this.ch.p1), p2: new Track(this.ch.p2), tri: new Track(this.ch.tri), noise: new Track(this.ch.noise) };
    this.frameAcc = 0; this.defs = {}; this.seqSrc = {};
    this.hp1 = { x: 0, y: 0 }; this.hp2 = { x: 0, y: 0 }; this.lp = 0;
  }
  setParams(p) {
    this.p = p;
    for (const k of ['seqVol', 'seqArp', 'seqPitch', 'seqDuty']) if (this.seqSrc[k] !== p[k]) { this.seqSrc[k] = p[k]; this.defs[k] = parseSeq(p[k]); }
    this.setBend(this.bend);
  }
  setBend(s) { this.bend = s; this.bendMul = 2 ** ((s * (this.p.bendRange ?? 2)) / 12); }
  setMod() {}
  get region() { return (this.p.region | 0) === 1 ? 1 : 0; }
  keysFor() {
    const c = this.p.chan | 0;
    return c === 0 ? ['p1'] : c === 1 ? ['tri'] : c === 2 ? ['noise'] : ['p1', 'p2', 'tri'];
  }
  noteOn(note, vel) {
    const keys = this.keysFor();
    let key = keys.find((k) => this.tracks[k].note === note && this.tracks[k].active) || keys.find((k) => !this.tracks[k].active) || keys.find((k) => !this.tracks[k].gate);
    if (!key) key = keys.reduce((a, b) => (this.tracks[b].age < this.tracks[a].age ? b : a));
    const t = this.tracks[key];
    t.note = note; t.vel = vel; t.gate = true; t.active = true; t.age = this.clock++; t.pitchAcc = 0; t.vibPh = 0;
    t.seq = { vol: new Seq(this.defs.seqVol), arp: new Seq(this.defs.seqArp), pitch: new Seq(this.defs.seqPitch), duty: new Seq(this.defs.seqDuty) };
    t.ch.on = true;
    if (key === 'noise') t.ch.mode = this.p.noiseMode | 0;
    this.frame(t, key); // primeiro quadro já na hora da nota
  }
  noteOff(note) {
    for (const [, t] of Object.entries(this.tracks)) {
      if (t.note !== note || !t.gate) continue;
      t.gate = false;
      Object.values(t.seq).forEach((s) => s.release());
      // sem ponto de soltura no volume, soltar a tecla corta a nota (como um "note cut")
      if (!this.defs.seqVol || this.defs.seqVol.rel < 0) { t.active = false; t.ch.on = false; }
    }
  }
  allOff() { for (const t of Object.values(this.tracks)) if (t.gate) this.noteOff(t.note); }
  panic() { for (const t of Object.values(this.tracks)) { t.gate = false; t.active = false; t.ch.on = false; } }
  /** Um quadro (1/60 s): avança as sequências e escreve os "registradores" do canal. */
  frame(t, key) {
    if (!t.active) return;
    const p = this.p, ch = t.ch, region = this.region;
    const sv = t.seq.vol.tick(), av = t.seq.arp.tick(), pv = t.seq.pitch.tick(), dv = t.seq.duty.tick();
    const velScale = 1 - (p.velSens ?? 0) + (p.velSens ?? 0) * (t.vel / 127);
    const chanVol = Math.max(0, Math.min(15, Math.round((p.chVol ?? 15) * velScale)));
    const seqVol = sv == null ? 15 : Math.max(0, Math.min(15, sv));
    let vol = Math.floor((seqVol * chanVol) / 15);
    if (seqVol > 0 && chanVol > 0 && vol === 0) vol = 1;
    if (pv != null) t.pitchAcc += pv;
    const note = t.note + (av || 0);
    if (key === 'noise') {
      ch.noiseIdx = Math.max(0, Math.min(15, 15 - (((note % 16) + 16) % 16)));
      ch.vol = vol;
      if (dv != null) ch.mode = dv ? 1 : 0;
      return;
    }
    if (dv != null && ch.type === 'pulse') ch.duty = dv & 3; else if (ch.type === 'pulse') ch.duty = (p.duty ?? 2) & 3;
    const f = mtof(note) * this.bendMul;
    let period = Math.round(CLOCK[region] / ((ch.type === 'tri' ? 32 : 16) * f) - 1) - t.pitchAcc;
    if (p.vibSpeed && p.vibDepthN) { t.vibPh = (t.vibPh + p.vibSpeed) & 63; period += Math.round(Math.sin((t.vibPh / 64) * 2 * Math.PI) * VIB_DEPTH[p.vibDepthN | 0]); }
    ch.period = Math.max(0, Math.min(0x7ff, period));
    if (ch.type === 'tri') ch.on = vol > 0; // o triângulo não tem volume: 0 para o canal
    else ch.vol = vol;
  }
  render(L, R, a, b) {
    const p = this.p, sr = this.sr, region = this.region;
    const cyc = CLOCK[region] / sr;
    const fstep = FRAME_HZ[region] / sr;
    const filt = p.nesFilter !== false;
    const dt = 1 / sr;
    const hpA1 = (1 / (2 * Math.PI * (filt ? 90 : 10))) / (1 / (2 * Math.PI * (filt ? 90 : 10)) + dt);
    const hpA2 = (1 / (2 * Math.PI * 440)) / (1 / (2 * Math.PI * 440) + dt);
    const lpB = dt / (1 / (2 * Math.PI * 14000) + dt);
    const gain = 2.6;
    const anyActive = Object.values(this.tracks).some((t) => t.active);
    for (let i = a; i < b; i++) {
      this.frameAcc += fstep;
      if (this.frameAcc >= 1) { this.frameAcc -= 1; for (const [k, t] of Object.entries(this.tracks)) this.frame(t, k); }
      const p1 = this.ch.p1.integrate(cyc, region), p2 = this.ch.p2.integrate(cyc, region);
      const tr = this.ch.tri.integrate(cyc, region), nz = this.ch.noise.integrate(cyc, region);
      const pulse = p1 + p2 > 0 ? 95.88 / (8128 / (p1 + p2) + 100) : 0;
      const tndIn = tr / 8227 + nz / 12241;
      const tnd = tndIn > 0 ? 159.79 / (1 / tndIn + 100) : 0;
      let x = pulse + tnd;
      // filtros da saída do NES: dois passa-altas (90 e 440 Hz) e um passa-baixa (14 kHz)
      let y = hpA1 * (this.hp1.y + x - this.hp1.x); this.hp1.x = x; this.hp1.y = y; x = y;
      if (filt) { y = hpA2 * (this.hp2.y + x - this.hp2.x); this.hp2.x = x; this.hp2.y = y; x = y; this.lp += (x - this.lp) * lpB; x = this.lp; }
      L[i] += x * gain; R[i] += x * gain;
    }
    return anyActive;
  }
}

export default (sr) => new NesEngine(sr);
