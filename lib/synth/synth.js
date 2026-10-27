// Sintetizador no lado da página: cria o nó do AudioWorklet, manda notas e parâmetros,
// carrega amostras (General MIDI ou suas) e aplica delay e reverb na saída.
import { defaults, ENGINES } from './schemas.js';
import { loadGMZones } from './gm.js';

export const FX_DEFAULTS = { delayMix: 0, delayTime: 0.32, delayFb: 0.35, reverbMix: 0.12, reverbSize: 2.2 };

export function ensureWorklet(ctx) {
  ctx.__synthReady ||= ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url).href);
  return ctx.__synthReady;
}

/** Resposta de impulso sintética (ruído com queda exponencial) para o reverb. */
function makeIR(ctx, seconds) {
  const len = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.5 * Math.exp((-3 * i) / len);
  }
  return ir;
}

export class Synth {
  /** state: { engine, params, fx, source: { kind: 'gm', program } | { kind: 'sample', id } } */
  static async create(ctx, state = {}) { await ensureWorklet(ctx); return new Synth(ctx, state); }

  constructor(ctx, state = {}) {
    this.ctx = ctx;
    this.state = { engine: 'subtractive', params: {}, fx: { ...FX_DEFAULTS }, source: null, ...structuredClone(state) };
    this.state.fx = { ...FX_DEFAULTS, ...(this.state.fx || {}) };
    if (!ENGINES[this.state.engine]) this.state.engine = 'subtractive';
    this.zones = []; this.grain = null; this.meter = 0; this.listeners = new Set();
    this.node = this.makeNode(ctx);
    this.node.port.onmessage = (e) => { if (e.data.type === 'meter') this.meter = e.data.peak; };
    this.buildFx(ctx);
  }
  makeNode(ctx, extra = {}) {
    return new AudioWorkletNode(ctx, 'estudio-synth', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { engine: this.state.engine, params: this.params(), zones: this.zones, grain: this.grain, ...extra },
    });
  }
  buildFx(ctx) {
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.delay = ctx.createDelay(2);
    this.delayFb = ctx.createGain();
    this.delayWet = ctx.createGain();
    this.reverb = ctx.createConvolver();
    this.reverbWet = ctx.createGain();
    this.node.connect(this.dry).connect(this.output);
    this.node.connect(this.delay);
    this.delay.connect(this.delayFb).connect(this.delay);
    this.delay.connect(this.delayWet).connect(this.output);
    this.node.connect(this.reverb).connect(this.reverbWet).connect(this.output);
    this.irSize = null;
    this.applyFx();
  }
  applyFx() {
    const fx = this.state.fx, t = this.ctx.currentTime;
    this.delay.delayTime.setTargetAtTime(fx.delayTime, t, 0.02);
    this.delayFb.gain.setTargetAtTime(Math.min(0.92, fx.delayFb), t, 0.02);
    this.delayWet.gain.setTargetAtTime(fx.delayMix, t, 0.02);
    this.reverbWet.gain.setTargetAtTime(fx.reverbMix, t, 0.02);
    if (this.irSize !== fx.reverbSize) { this.irSize = fx.reverbSize; this.reverb.buffer = makeIR(this.ctx, fx.reverbSize); }
  }
  params() { return { ...defaults(this.state.engine), ...this.state.params }; }
  connect(dest) { this.output.connect(dest); return dest; }
  disconnect() { try { this.output.disconnect(); } catch { /* ok */ } }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach((fn) => fn(this.state)); }

  setEngine(engine, params = {}) {
    this.state.engine = engine; this.state.params = { ...params };
    this.node.port.postMessage({ type: 'engine', engine, params: this.params() });
    this.emit();
  }
  setParams(partial) {
    Object.assign(this.state.params, partial);
    this.node.port.postMessage({ type: 'params', params: this.params() });
    this.emit();
  }
  setFx(partial) { Object.assign(this.state.fx, partial); this.applyFx(); this.emit(); }

  // horários no relógio do AudioContext; 0 = agora
  noteOn(note, vel = 100, at = 0) { this.node.port.postMessage({ type: 'note', note, vel, at }); }
  noteOff(note, at = 0) { this.node.port.postMessage({ type: 'off', note, at }); }
  events(list) { this.node.port.postMessage({ type: 'events', events: list }); }
  allOff(at = 0) { this.node.port.postMessage({ type: 'allOff', at }); }
  panic() { this.node.port.postMessage({ type: 'panic' }); }
  /** Apaga as notas agendadas a partir de agora (ao parar/reposicionar a reprodução). */
  clearScheduled() { this.node.port.postMessage({ type: 'clear', after: 0 }); }
  bend(semis) { this.node.port.postMessage({ type: 'bend', value: semis }); }
  mod(v) { this.node.port.postMessage({ type: 'mod', value: v }); }

  setZones(zones) { this.zones = zones; this.node.port.postMessage({ type: 'zones', zones }); }
  setGrain(g) { this.grain = g; this.node.port.postMessage({ type: 'grain', grain: g }); }
  /** Instrumento General MIDI (amostras FluidR3, baixadas na primeira vez). */
  async loadGM(program, onProgress) {
    const zones = await loadGMZones(program, this.ctx, onProgress);
    this.state.source = { kind: 'gm', program };
    this.setZones(zones);
    this.emit();
    return zones.length;
  }
  /** Uma amostra sua: vira zona do sampler e fonte do granular. */
  useSample({ channels, sampleRate }, meta = {}) {
    const L = channels[0], R = channels[1] && channels[1] !== channels[0] ? channels[1] : null;
    this.setZones([{ L, R, sr: sampleRate, root: 60, lo: 0, hi: 127, user: true }]);
    const mono = R ? L.map((v, i) => (v + R[i]) / 2) : L;
    this.setGrain({ data: mono, sr: sampleRate, root: 60 });
    this.state.source = { kind: 'sample', ...meta };
    this.emit();
  }
  toJSON() { return structuredClone(this.state); }
  destroy() { this.panic(); this.disconnect(); try { this.node.disconnect(); } catch { /* ok */ } }

  /**
   * Cópia deste instrumento num OfflineAudioContext (para exportar), já com as notas agendadas.
   * events: [{ type:'note'|'off', note, vel, at }]
   */
  async offlineCopy(off, events) {
    await ensureWorklet(off);
    const copy = Object.create(Synth.prototype);
    copy.ctx = off; copy.state = structuredClone(this.state); copy.zones = this.zones; copy.grain = this.grain; copy.listeners = new Set();
    copy.node = copy.makeNode(off, { events });
    copy.buildFx(off);
    return copy;
  }
}
