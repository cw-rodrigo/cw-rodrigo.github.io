// Gravador de entrada no relógio do AudioContext: manda blocos de áudio com o horário exato do início.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false; this.bufL = []; this.bufR = []; this.t0 = 0; this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.bufL = []; this.bufR = []; this.n = 0; }
      if (e.data === 'stop') { this.flush(); this.on = false; this.ended = true; this.port.postMessage({ type: 'stopped' }); }
    };
  }
  flush() {
    if (!this.n) return;
    const L = new Float32Array(this.n), R = new Float32Array(this.n);
    let o = 0;
    for (let i = 0; i < this.bufL.length; i++) { L.set(this.bufL[i], o); R.set(this.bufR[i], o); o += this.bufL[i].length; }
    this.port.postMessage({ type: 'data', t: this.t0, L, R }, [L.buffer, R.buffer]);
    this.bufL = []; this.bufR = []; this.n = 0;
  }
  process(inputs, outputs) {
    const inp = inputs[0];
    if (inp && inp.length) {
      const l = inp[0], r = inp[1] || inp[0];
      if (this.on) {
        if (!this.n) this.t0 = currentTime;
        this.bufL.push(new Float32Array(l)); this.bufR.push(new Float32Array(r)); this.n += l.length;
        if (this.n >= 4096) this.flush();
      }
    }
    return !this.ended; // depois de parar, o nó pode ser descartado
  }
}
registerProcessor('estudio-recorder', RecorderProcessor);
