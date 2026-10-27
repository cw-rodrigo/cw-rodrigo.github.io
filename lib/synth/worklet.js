// Processador de áudio do sintetizador (roda na thread de áudio). Um nó = um instrumento com um motor.
// Recebe notas com horário (no relógio do AudioContext) e as aplica na amostra exata.
import { FACTORIES } from './engines/index.js';
import { defaults } from './schemas.js';
import { dbToGain } from './dsp.js';

class SynthProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.shared = { zones: o.zones || [], grain: o.grain || null };
    this.events = [];
    this.L = new Float32Array(128); this.R = new Float32Array(128);
    this.gain = 1; this.targetGain = 1;
    this.setEngine(o.engine || 'subtractive', o.params || {});
    if (o.events) this.addEvents(o.events);
    this.peak = 0; this.meterCount = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }
  setEngine(name, params) {
    const make = FACTORIES[name] || FACTORIES.subtractive;
    this.engineName = FACTORIES[name] ? name : 'subtractive';
    this.engine = make(sampleRate, this.shared);
    this.setParams(params);
  }
  setParams(params) {
    this.params = { ...defaults(this.engineName), ...params };
    this.engine.setParams(this.params);
    this.targetGain = dbToGain(this.params.vol ?? -8);
  }
  addEvents(list) {
    for (const ev of list) this.events.push(ev);
    this.events.sort((x, y) => x.at - y.at);
  }
  onMessage(m) {
    switch (m.type) {
      case 'engine': this.engine.panic?.(); this.setEngine(m.engine, m.params || {}); break;
      case 'params': this.setParams({ ...this.params, ...m.params }); break;
      case 'zones': this.shared.zones = m.zones || []; break;
      case 'grain': this.shared.grain = m.grain || null; break;
      case 'panic': this.events = []; this.engine.panic(); break;
      case 'clear': this.events = this.events.filter((e) => e.at < (m.after ?? 0)); break;
      default:
        if (m.type === 'events') this.addEvents(m.events);
        else this.addEvents([m]); // note / off / bend / mod / allOff com horário opcional
    }
  }
  apply(ev) {
    switch (ev.type) {
      case 'note': this.engine.noteOn(ev.note, ev.vel ?? 100); break;
      case 'off': this.engine.noteOff(ev.note); break;
      case 'allOff': this.engine.allOff(); break;
      case 'bend': this.engine.setBend(ev.value); break;
      case 'mod': this.engine.setMod?.(ev.value); break;
      default:
    }
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const n = oL.length;
    const L = this.L.length >= n ? this.L : (this.L = new Float32Array(n));
    const R = this.R.length >= n ? this.R : (this.R = new Float32Array(n));
    L.fill(0, 0, n); R.fill(0, 0, n);
    const t0 = currentTime;
    let pos = 0;
    while (this.events.length) {
      const ev = this.events[0];
      const at = ev.at == null ? 0 : Math.round((ev.at - t0) * sampleRate);
      if (at >= n) break;
      const frame = Math.max(pos, Math.min(n, at));
      if (frame > pos) { this.engine.render(L, R, pos, frame); pos = frame; }
      this.events.shift();
      this.apply(ev);
    }
    if (pos < n) this.engine.render(L, R, pos, n);
    let pk = 0;
    for (let i = 0; i < n; i++) {
      this.gain += (this.targetGain - this.gain) * 0.002;
      const l = L[i] * this.gain, r = R[i] * this.gain;
      oL[i] = l; oR[i] = r;
      const a = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
      if (a > pk) pk = a;
    }
    if (pk > this.peak) this.peak = pk;
    if (++this.meterCount >= 8) { this.port.postMessage({ type: 'meter', peak: this.peak }); this.peak = 0; this.meterCount = 0; }
    return true;
  }
}

registerProcessor('estudio-synth', SynthProcessor);
