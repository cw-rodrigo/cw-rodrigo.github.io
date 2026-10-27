// Metrônomo com agendamento preciso pelo relógio do áudio. onBeat(tempo do compasso, ou -1 ao parar).
import { audioCtx } from './context.js';

export class Metronome {
  constructor(onBeat, beatsPerBar = 4) { this.onBeat = onBeat; this.bpm = 80; this.bar = beatsPerBar; this.running = false; }
  start(bpm) {
    if (this.running) this.stop();
    this.bpm = bpm;
    this.ctx = audioCtx();
    this.next = this.ctx.currentTime + 0.1;
    this.beat = 0;
    this.running = true;
    this.timer = setInterval(() => this.tick(), 25);
  }
  tick() {
    while (this.next < this.ctx.currentTime + 0.12) {
      const accent = this.beat % this.bar === 0;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.frequency.value = accent ? 1500 : 1000;
      g.gain.setValueAtTime(0.0001, this.next);
      g.gain.exponentialRampToValueAtTime(accent ? 0.6 : 0.35, this.next + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, this.next + 0.05);
      o.connect(g).connect(this.ctx.destination);
      o.start(this.next); o.stop(this.next + 0.06);
      const b = this.beat % this.bar;
      const delay = Math.max(0, (this.next - this.ctx.currentTime) * 1000);
      setTimeout(() => this.running && this.onBeat(b), delay);
      this.next += 60 / this.bpm;
      this.beat++;
    }
  }
  stop() { this.running = false; clearInterval(this.timer); this.onBeat(-1); }
  close() { this.stop(); }
}
