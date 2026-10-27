// Blocos de DSP usados pelos motores de síntese (rodam dentro do AudioWorklet, amostra a amostra).

export const TAU = Math.PI * 2;
export const mtof = (n) => 440 * 2 ** ((n - 69) / 12);
export const dbToGain = (db) => (db <= -60 ? 0 : 10 ** (db / 20));
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- tabela de seno
const SIN_N = 4096;
const SIN = new Float32Array(SIN_N + 1);
for (let i = 0; i <= SIN_N; i++) SIN[i] = Math.sin((i / SIN_N) * TAU);
/** Seno rápido com fase em ciclos (0..1, aceita qualquer valor). */
export function fsin(phase) {
  let p = phase - Math.floor(phase);
  p *= SIN_N;
  const i = p | 0;
  const f = p - i;
  return SIN[i] + (SIN[i + 1] - SIN[i]) * f;
}

// ---------------------------------------------------------------- envelope ADSR
/** Ataque linear, queda e soltura exponenciais. Tempos em segundos. */
export class Env {
  constructor(sr) { this.sr = sr; this.v = 0; this.stage = 0; this.set(0.005, 0.2, 0.7, 0.3); }
  set(a, d, s, r) {
    this.a = Math.max(0.0005, a); this.d = Math.max(0.001, d); this.s = clamp(s, 0, 1); this.r = Math.max(0.001, r);
    this.aInc = 1 / (this.a * this.sr);
    this.dCoef = Math.exp(Math.log(0.001) / (this.d * this.sr));
    this.rCoef = Math.exp(Math.log(0.0001) / (this.r * this.sr));
  }
  trigger(legato = false) { if (!legato || this.stage === 0 || this.stage === 4) this.stage = 1; }
  release() { if (this.stage !== 0) this.stage = 4; }
  kill() { this.stage = 0; this.v = 0; }
  get active() { return this.stage !== 0; }
  next() {
    switch (this.stage) {
      case 1: this.v += this.aInc; if (this.v >= 1) { this.v = 1; this.stage = 2; } break;
      case 2: this.v = this.s + (this.v - this.s) * this.dCoef; if (this.v - this.s < 1e-4) { this.v = this.s; this.stage = 3; } break;
      case 3: this.v = this.s; if (this.s <= 0) this.stage = 0; break;
      case 4: this.v *= this.rCoef; if (this.v < 1e-4) { this.v = 0; this.stage = 0; } break;
      default: this.v = 0;
    }
    return this.v;
  }
}

// ---------------------------------------------------------------- osciladores com poucas distorções (polyBLEP)
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
/** Uma amostra da forma de onda na fase t (0..1) com incremento dt. wave: 0 serra, 1 quadrada/pulso, 2 triângulo, 3 seno */
export function osc(wave, t, dt, pw = 0.5) {
  switch (wave) {
    case 0: return 2 * t - 1 - blep(t, dt);
    case 1: { let v = t < pw ? 1 : -1; v += blep(t, dt); v -= blep((t + 1 - pw) % 1, dt); return v; }
    case 2: return 1 - 4 * Math.abs(t - 0.5);
    default: return fsin(t);
  }
}
export const WAVES = ['saw', 'square', 'triangle', 'sine'];

// ---------------------------------------------------------------- filtro de estado variável (TPT/SVF)
export class SVF {
  constructor(sr) { this.sr = sr; this.ic1 = 0; this.ic2 = 0; this.set(1000, 0.2); }
  /** res 0..1 (perto de 1 = bem ressonante) */
  set(fc, res) {
    fc = clamp(fc, 10, this.sr * 0.49);
    const g = Math.tan((Math.PI * fc) / this.sr);
    this.k = 2 - 1.98 * clamp(res, 0, 1);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  /** mode: 0 passa-baixa, 1 passa-alta, 2 passa-banda, 3 rejeita-faixa */
  run(x, mode = 0) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    if (mode === 0) return v2;
    if (mode === 2) return v1;
    const hp = x - this.k * v1 - v2;
    return mode === 1 ? hp : hp + v2;
  }
  reset() { this.ic1 = this.ic2 = 0; }
}

/** Filtro de um polo (suavização / perda nas cordas). */
export class OnePole {
  constructor() { this.y = 0; this.a = 0.5; }
  setCoef(a) { this.a = clamp(a, 0, 1); }
  setFreq(fc, sr) { this.a = 1 - Math.exp((-TAU * fc) / sr); }
  run(x) { this.y += this.a * (x - this.y); return this.y; }
}

/** Ressonador de dois polos (modos de vibração: sinos, marimba, formantes). */
export class Reson {
  constructor() { this.y1 = 0; this.y2 = 0; this.b1 = 0; this.b2 = 0; this.g = 0; }
  set(freq, decaySec, sr, gain = 1) {
    const r = Math.exp(-1 / Math.max(1e-4, decaySec * sr));
    this.b1 = 2 * r * Math.cos((TAU * freq) / sr);
    this.b2 = -r * r;
    this.g = gain * (1 - r);
  }
  setBw(freq, bwHz, sr, gain = 1) {
    const r = Math.exp((-Math.PI * bwHz) / sr);
    this.b1 = 2 * r * Math.cos((TAU * freq) / sr);
    this.b2 = -r * r;
    this.g = gain * (1 - r * r);
  }
  run(x) { const y = this.g * x + this.b1 * this.y1 + this.b2 * this.y2; this.y2 = this.y1; this.y1 = y; return y; }
}

// ---------------------------------------------------------------- LFO e ruído
export class LFO {
  constructor(sr) { this.sr = sr; this.ph = Math.random(); this.sh = 0; }
  /** shape: 0 seno, 1 triângulo, 2 quadrada, 3 serra, 4 aleatório (S&H) */
  next(rate, shape) {
    const prev = this.ph;
    this.ph += rate / this.sr;
    if (this.ph >= 1) { this.ph -= 1; this.sh = Math.random() * 2 - 1; }
    switch (shape) {
      case 1: return 1 - 4 * Math.abs(this.ph - 0.5);
      case 2: return this.ph < 0.5 ? 1 : -1;
      case 3: return 2 * this.ph - 1;
      case 4: return prev > this.ph ? this.sh : this.sh;
      default: return fsin(this.ph);
    }
  }
}
export class Pink {
  constructor() { this.b = [0, 0, 0, 0, 0, 0, 0]; }
  next() {
    const w = Math.random() * 2 - 1, b = this.b;
    b[0] = 0.99886 * b[0] + w * 0.0555179; b[1] = 0.99332 * b[1] + w * 0.0750759; b[2] = 0.969 * b[2] + w * 0.153852;
    b[3] = 0.8665 * b[3] + w * 0.3104856; b[4] = 0.55 * b[4] + w * 0.5329522; b[5] = -0.7616 * b[5] - w * 0.016898;
    const out = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
    b[6] = w * 0.115926;
    return out * 0.11;
  }
}

/** Linha de atraso com leitura fracionária. */
export class Delay {
  constructor(n) { this.buf = new Float32Array(n); this.w = 0; }
  write(x) { this.buf[this.w] = x; this.w = (this.w + 1) % this.buf.length; }
  /** lê `d` amostras atrás (fracionário) */
  read(d) {
    const n = this.buf.length;
    let r = this.w - d;
    while (r < 0) r += n;
    const i = Math.floor(r), f = r - i;
    const a = this.buf[i % n], b = this.buf[(i + 1) % n];
    return a + (b - a) * f;
  }
  clear() { this.buf.fill(0); }
}

/** Pan de potência constante: devolve [ganhoL, ganhoR] para pan -1..1. */
export function panGains(p) {
  const a = ((clamp(p, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}
