// Motor de áudio da DAW: grafo por faixa, agendamento com antecedência (com loop), metrônomo,
// gravação de áudio (entrada USB da Pocket Master, microfone…) e de notas, e exportação em WAV.
import { Synth } from '/lib/synth/synth.js';
import { getInput } from '/lib/audio/io.js';
import { spb, clipEnd, songEnd, loadAudio, cachedAudio, saveAudio } from './project.js';

const LOOKAHEAD = 0.15, TICK_MS = 25;
const dbg = (db) => (db <= -60 ? 0 : 10 ** (db / 20));

function makeIR(ctx, seconds = 2.4) {
  const len = Math.round(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3; }
  return ir;
}
function clickBuffer(ctx, freq) {
  const len = Math.round(ctx.sampleRate * 0.04);
  const b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.sin((2 * Math.PI * freq * i) / ctx.sampleRate) * Math.exp(-i / (len / 6));
  return b;
}

/** Cadeia de uma faixa: entrada → EQ (3 bandas) → pan → volume → saída; envio de reverb; medidor. */
function makeStrip(ctx, dest, reverbIn) {
  const s = {};
  s.input = ctx.createGain();
  s.low = ctx.createBiquadFilter(); s.low.type = 'lowshelf'; s.low.frequency.value = 200;
  s.mid = ctx.createBiquadFilter(); s.mid.type = 'peaking'; s.mid.frequency.value = 1000; s.mid.Q.value = 0.8;
  s.high = ctx.createBiquadFilter(); s.high.type = 'highshelf'; s.high.frequency.value = 5000;
  s.pan = ctx.createStereoPanner();
  s.vol = ctx.createGain();
  s.send = ctx.createGain();
  s.meter = ctx.createAnalyser(); s.meter.fftSize = 512;
  s.input.connect(s.low).connect(s.mid).connect(s.high).connect(s.pan).connect(s.vol).connect(dest);
  s.vol.connect(s.meter);
  s.vol.connect(s.send).connect(reverbIn);
  return s;
}
function applyStrip(s, t, audible, ctx) {
  const now = ctx.currentTime;
  s.low.gain.setTargetAtTime(t.eq.low, now, 0.02);
  s.mid.gain.setTargetAtTime(t.eq.mid, now, 0.02);
  s.high.gain.setTargetAtTime(t.eq.high, now, 0.02);
  s.pan.pan.setTargetAtTime(t.pan, now, 0.02);
  s.vol.gain.setTargetAtTime(audible ? dbg(t.vol) : 0, now, 0.015);
  s.send.gain.setTargetAtTime(t.rev, now, 0.02);
}
const audibleOf = (p, t) => !t.mute && (!p.tracks.some((x) => x.solo) || t.solo);

export class DawEngine {
  constructor(ctx, { onStop = () => {}, onRecorded = () => {} } = {}) {
    this.ctx = ctx; this.p = null; this.onStop = onStop; this.onRecorded = onRecorded;
    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1; this.limiter.knee.value = 0; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.002; this.limiter.release.value = 0.1;
    this.masterMeter = ctx.createAnalyser(); this.masterMeter.fftSize = 512;
    this.master.connect(this.limiter).connect(ctx.destination);
    this.limiter.connect(this.masterMeter);
    this.reverb = ctx.createConvolver(); this.reverb.buffer = makeIR(ctx);
    this.reverb.connect(this.master);
    this.metro = ctx.createGain(); this.metro.gain.value = 0.5; this.metro.connect(ctx.destination);
    this.clicks = [clickBuffer(ctx, 1000), clickBuffer(ctx, 1600)];
    this.strips = new Map(); // id da faixa -> { strip, synth, synthKey }
    this.sources = new Set();
    this.playing = false; this.recording = null; this.timer = 0;
  }

  // ---------------------------------------------------------------- faixas
  /** Cria/remove/atualiza os nós para combinar com o projeto. */
  async sync(p) {
    this.p = p;
    for (const [id, e] of this.strips) {
      if (!p.tracks.some((t) => t.id === id)) { e.synth?.destroy(); e.strip.vol.disconnect(); this.strips.delete(id); const m = this.monitors?.get(id); if (m) { m.src.disconnect(); m.raw.disconnect(); m.stream.getTracks().forEach((x) => x.stop()); this.monitors.delete(id); } }
    }
    for (const t of p.tracks) {
      let e = this.strips.get(t.id);
      if (!e) { e = { strip: makeStrip(this.ctx, this.master, this.reverb) }; this.strips.set(t.id, e); }
      if (t.kind === 'inst') await this.ensureSynth(t, e);
      applyStrip(e.strip, t, audibleOf(p, t), this.ctx);
    }
    this.master.gain.setTargetAtTime(dbg(p.master.vol), this.ctx.currentTime, 0.02);
    // carrega os áudios usados (para tocar e desenhar)
    await Promise.all(p.tracks.flatMap((t) => t.clips.filter((c) => c.audioId).map((c) => loadAudio(this.ctx, c.audioId))));
  }
  async ensureSynth(t, e) {
    const key = t.synth.engine;
    if (!e.synth) {
      e.synth = await Synth.create(this.ctx, t.synth);
      e.synth.connect(e.strip.input);
      e.synthKey = key;
      await this.loadSynthSource(t, e.synth);
    } else if (e.synth.state.engine !== key) {
      e.synth.setEngine(key, t.synth.params);
    }
  }
  async loadSynthSource(t, synth) {
    const src = t.synth.source;
    try {
      if (src?.kind === 'gm') await synth.loadGM(src.program);
      else if (src?.kind === 'sample' && src.audioId) { const a = await loadAudio(this.ctx, src.audioId); if (a) synth.useSample({ channels: a.channels, sampleRate: a.sampleRate }, src); }
    } catch { /* sem a amostra: o instrumento fica mudo até carregar de novo */ }
  }
  synthOf(trackId) { return this.strips.get(trackId)?.synth || null; }
  /** Volume, pan, mudo, solo… sem recriar nada. */
  mix(p) { this.p = p; for (const t of p.tracks) { const e = this.strips.get(t.id); if (e) applyStrip(e.strip, t, audibleOf(p, t), this.ctx); } this.master.gain.setTargetAtTime(dbg(p.master.vol), this.ctx.currentTime, 0.02); }
  level(trackId) {
    const an = trackId ? this.strips.get(trackId)?.strip.meter : this.masterMeter;
    if (!an) return 0;
    const d = an.__buf || (an.__buf = new Float32Array(an.fftSize));
    an.getFloatTimeDomainData(d);
    let pk = 0;
    for (const v of d) { const a = Math.abs(v); if (a > pk) pk = a; }
    return pk;
  }

  // ---------------------------------------------------------------- transporte
  get position() {
    if (!this.playing) return this.pos ?? 0;
    return this.songBeatAt(this.ctx.currentTime);
  }
  /** Tempo do AudioContext -> batida da música (com o loop). */
  songBeatAt(time) {
    const p = this.p, s = spb(p);
    let b = this.start.beat + (time - this.start.time) / s;
    const lp = p.loop;
    if (lp.on && !this.recording && this.start.beat < lp.end && b >= lp.end && lp.end > lp.start) b = lp.start + ((b - lp.end) % (lp.end - lp.start));
    return b;
  }
  play(fromBeat = this.pos ?? 0, { countIn = 0 } = {}) {
    if (this.playing) this.stop(false);
    const p = this.p;
    if (p.loop.on && !this.recording && fromBeat >= p.loop.end) fromBeat = p.loop.start;
    const t0 = this.ctx.currentTime + 0.08;
    this.start = { beat: fromBeat - countIn, time: t0 };
    this.sched = { beat: fromBeat - countIn, time: t0 };
    this.playing = true;
    this.startMid(fromBeat - countIn, t0);
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }
  stop(notify = true) {
    if (!this.playing) return;
    this.pos = Math.max(0, this.songBeatAt(this.ctx.currentTime));
    this.playing = false;
    clearInterval(this.timer);
    for (const src of this.sources) { try { src.stop(); } catch { /* ok */ } }
    this.sources.clear();
    for (const e of this.strips.values()) if (e.synth) { e.synth.clearScheduled(); e.synth.allOff(); }
    if (notify) this.onStop(this.pos);
  }
  seek(beat) {
    const was = this.playing;
    if (was) this.stop(false);
    this.pos = Math.max(0, beat);
    if (was) this.play(this.pos);
  }

  tick() {
    const p = this.p, s = spb(p), horizon = this.ctx.currentTime + LOOKAHEAD;
    let guard = 0;
    while (this.sched.time < horizon && guard++ < 50) {
      const lp = p.loop;
      const looping = lp.on && !this.recording && lp.end > lp.start && this.sched.beat < lp.end;
      const segEndBeat = looping ? lp.end : Infinity;
      const endTime = Math.min(horizon, this.sched.time + (segEndBeat - this.sched.beat) * s);
      const endBeat = this.sched.beat + (endTime - this.sched.time) / s;
      this.scheduleRange(this.sched.beat, endBeat, this.sched.time, looping ? lp.end : Infinity);
      this.sched = { beat: endBeat, time: endTime };
      if (looping && endBeat >= lp.end - 1e-9) {
        this.sched = { beat: lp.start, time: endTime };
        this.startMid(lp.start, endTime, lp.end);
      }
    }
    // chegou ao fim da música (sem loop e sem gravar): para sozinho
    if (!p.loop.on && !this.recording && this.position > songEnd(p) + p.sig * 2 && songEnd(p) > 0) this.stop();
  }
  /** Agenda tudo que começa entre as batidas a e b (a acontece no instante tA). */
  scheduleRange(a, b, tA, loopEnd) {
    const p = this.p, s = spb(p), ctx = this.ctx;
    const at = (beat) => tA + (beat - a) * s;
    // metrônomo (sempre na contagem; tocando, só se ligado)
    for (let k = Math.ceil(a - 1e-9); k < b; k++) {
      if (!p.metro && !(this.recording && k < this.recording.fromBeat)) continue;
      const src = ctx.createBufferSource();
      src.buffer = this.clicks[((k % p.sig) + p.sig) % p.sig === 0 ? 1 : 0];
      src.connect(this.metro);
      src.start(Math.max(ctx.currentTime, at(k)));
      this.track(src);
    }
    for (const t of p.tracks) {
      const e = this.strips.get(t.id);
      if (!e) continue;
      for (const c of t.clips) {
        if (t.kind === 'inst' && c.notes && e.synth) {
          const evs = [];
          for (const n of c.notes) {
            if (n.t >= c.len) continue;
            const nb = c.start + n.t;
            if (nb < a || nb >= b) continue;
            const off = Math.min(nb + n.d, c.start + c.len, loopEnd);
            evs.push({ type: 'note', note: n.p, vel: n.v ?? 100, at: at(nb) }, { type: 'off', note: n.p, at: at(off) - 0.0005 });
          }
          if (evs.length) e.synth.events(evs);
        } else if (c.audioId && c.start >= a && c.start < b) {
          this.startAudio(c, e, at(c.start), 0, loopEnd === Infinity ? null : at(loopEnd));
        }
      }
    }
  }
  /** Ao começar a tocar (ou voltar ao início do loop) no meio de um clipe de áudio, ele toca a partir dali. */
  startMid(beat, time, loopEnd = null) {
    const p = this.p, s = spb(p);
    const lp = p.loop;
    const stopAt = lp.on && !this.recording && beat < lp.end ? time + (lp.end - beat) * s : null;
    for (const t of p.tracks) {
      const e = this.strips.get(t.id);
      if (!e) continue;
      for (const c of t.clips) if (c.audioId && c.start < beat && clipEnd(p, c) > beat) this.startAudio(c, e, time, (beat - c.start) * s, stopAt);
    }
  }
  startAudio(c, e, when, into = 0, stopAt = null) {
    const a = cachedAudio(c.audioId);
    if (!a) return;
    const src = this.ctx.createBufferSource();
    src.buffer = a.buffer;
    const g = this.ctx.createGain();
    g.gain.value = dbg(c.gain || 0);
    src.connect(g).connect(e.strip.input);
    const dur = c.dur - into;
    if (dur <= 0) return;
    const now = this.ctx.currentTime;
    const late = Math.max(0, now - when);
    src.start(Math.max(now, when), c.offset + into + late, Math.max(0.001, dur - late));
    if (stopAt) src.stop(stopAt);
    this.track(src);
  }
  track(src) { this.sources.add(src); src.onended = () => this.sources.delete(src); }

  // ---------------------------------------------------------------- ouvir a entrada (faixa armada com "ouvir")
  async setMonitor(t, on) {
    this.monitors ||= new Map();
    const cur = this.monitors.get(t.id);
    if (cur && (!on || cur.deviceId !== t.input.deviceId || cur.channel !== t.input.channel)) { cur.src.disconnect(); cur.raw.disconnect(); cur.stream.getTracks().forEach((x) => x.stop()); this.monitors.delete(t.id); }
    if (!on || this.monitors.has(t.id)) return;
    const e = this.strips.get(t.id);
    if (!e) return;
    const stream = await getInput(t.input.deviceId || null);
    const src = this.ctx.createMediaStreamSource(stream);
    let node = src;
    if (t.input.channel !== 'stereo') {
      const split = this.ctx.createChannelSplitter(2), merge = this.ctx.createChannelMerger(2);
      const k = t.input.channel === 'right' ? 1 : 0;
      src.connect(split); split.connect(merge, k, 0); split.connect(merge, k, 1); node = merge;
    }
    node.connect(e.strip.input);
    this.monitors.set(t.id, { stream, src: node === src ? src : node, deviceId: t.input.deviceId, channel: t.input.channel, raw: src });
  }
  stopMonitors() { for (const [id, m] of this.monitors || []) { m.src.disconnect(); m.raw.disconnect(); m.stream.getTracks().forEach((x) => x.stop()); this.monitors.delete(id); } }

  // ---------------------------------------------------------------- tocar ao vivo e gravar
  liveOn(trackId, note, vel) {
    const syn = this.synthOf(trackId);
    if (!syn) return;
    syn.noteOn(note, vel);
    const r = this.recording;
    if (r && r.midi.has(trackId)) r.midi.get(trackId).push({ type: 'on', note, vel, beat: this.songBeatAt(this.ctx.currentTime) });
  }
  liveOff(trackId, note) {
    const syn = this.synthOf(trackId);
    if (!syn) return;
    syn.noteOff(note);
    const r = this.recording;
    if (r && r.midi.has(trackId)) r.midi.get(trackId).push({ type: 'off', note, beat: this.songBeatAt(this.ctx.currentTime) });
  }

  /** Começa a gravar as faixas armadas a partir de `fromBeat`. */
  async record(fromBeat) {
    const p = this.p;
    const armed = p.tracks.filter((t) => t.arm);
    if (!armed.length) throw new Error('Arme uma faixa para gravar (botão vermelho na faixa).');
    this.ctx.__recReady ||= this.ctx.audioWorklet.addModule(new URL('/lib/audio/recorder-worklet.js', location.href).href);
    await this.ctx.__recReady;
    const rec = { fromBeat, audio: [], midi: new Map(), devices: new Map() };
    for (const t of armed.filter((x) => x.kind === 'audio')) {
      const key = t.input.deviceId || 'default';
      let dev = rec.devices.get(key);
      if (!dev) {
        const stream = await getInput(t.input.deviceId || null);
        const src = this.ctx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(this.ctx, 'estudio-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
        src.connect(node);
        dev = { stream, src, node, chunks: [], latency: stream.getAudioTracks()[0]?.getSettings?.().latency || 0.01 };
        node.port.onmessage = (e) => { if (e.data.type === 'data') dev.chunks.push(e.data); };
        rec.devices.set(key, dev);
      }
      rec.audio.push({ track: t, dev });
    }
    for (const t of armed.filter((x) => x.kind === 'inst')) rec.midi.set(t.id, []);
    this.recording = rec;
    const countIn = p.countIn ? p.sig : 0;
    for (const dev of rec.devices.values()) dev.node.port.postMessage('start');
    this.play(fromBeat, { countIn });
  }
  /** Para a gravação e devolve os clipes novos: [{ trackId, clip }]. */
  async stopRecording() {
    const rec = this.recording;
    if (!rec) return [];
    const p = this.p, s = spb(p);
    const endBeat = this.songBeatAt(this.ctx.currentTime);
    this.stop(false);
    // espera os últimos blocos chegarem
    await Promise.all([...rec.devices.values()].map((dev) => new Promise((resolve) => {
      const prev = dev.node.port.onmessage;
      dev.node.port.onmessage = (e) => { prev(e); if (e.data.type === 'stopped') resolve(); };
      dev.node.port.postMessage('stop');
      setTimeout(resolve, 600);
    })));
    this.recording = null;
    const out = [];
    const comp = p.latencyMs != null ? p.latencyMs / 1000 : null;
    for (const dev of rec.devices.values()) {
      dev.src.disconnect(); dev.stream.getTracks().forEach((tr) => tr.stop());
      if (!dev.chunks.length) continue;
      const total = dev.chunks.reduce((n, c) => n + c.L.length, 0);
      const L = new Float32Array(total), R = new Float32Array(total);
      let o = 0;
      for (const c of dev.chunks) { L.set(c.L, o); R.set(c.R, o); o += c.L.length; }
      // o que você tocou chega atrasado (saída + entrada): compensa
      const lat = comp != null ? comp : (this.ctx.outputLatency || this.ctx.baseLatency || 0) + dev.latency;
      const firstBeat = (dev.chunks[0].t - lat - this.start.time) / s + this.start.beat;
      const skip = Math.max(0, Math.round((rec.fromBeat - firstBeat) * s * this.ctx.sampleRate)); // corta a contagem
      dev.L = L.subarray(skip); dev.R = R.subarray(skip);
      dev.firstBeat = Math.max(firstBeat, rec.fromBeat);
    }
    for (const { track, dev } of rec.audio) {
      if (!dev.L || dev.L.length < 1000) continue;
      const chans = track.input.channel === 'left' ? [dev.L.slice()] : track.input.channel === 'right' ? [dev.R.slice()] : [dev.L.slice(), dev.R.slice()];
      const audioId = await saveAudio(chans, this.ctx.sampleRate, track.name);
      await loadAudio(this.ctx, audioId);
      out.push({ trackId: track.id, clip: { id: crypto.randomUUID?.() || String(Date.now()), name: `Gravação ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`, start: dev.firstBeat, offset: 0, dur: chans[0].length / this.ctx.sampleRate, audioId, gain: 0 } });
    }
    for (const [trackId, evs] of rec.midi) {
      const open = new Map(), notes = [];
      for (const ev of evs) {
        if (ev.beat < rec.fromBeat - 0.5) continue; // tocou um pouco antes: entra no começo
        if (ev.type === 'on') open.set(ev.note, { ...ev, beat: Math.max(ev.beat, rec.fromBeat) });
        else if (open.has(ev.note)) { const on = open.get(ev.note); open.delete(ev.note); notes.push({ p: ev.note, t: on.beat, d: Math.max(0.05, ev.beat - on.beat), v: on.vel }); }
      }
      for (const on of open.values()) notes.push({ p: on.note, t: on.beat, d: Math.max(0.05, endBeat - on.beat), v: on.vel });
      if (!notes.length) continue;
      const start = Math.floor(rec.fromBeat / p.sig) * p.sig;
      const q = p.recQuantize || 0;
      notes.forEach((n) => { n.t -= start; if (q) { n.t = Math.round(n.t / q) * q; n.d = Math.max(q, Math.round(n.d / q) * q); } });
      const len = Math.max(p.sig, Math.ceil((endBeat - start) / p.sig) * p.sig);
      out.push({ trackId, clip: { id: crypto.randomUUID?.() || String(Date.now()), name: 'Gravação', start, len, notes } });
    }
    this.onRecorded(out);
    return out;
  }

  // ---------------------------------------------------------------- exportar
  /** Mixagem do projeto inteiro (ou do loop) num OfflineAudioContext. Retorna { channels, sampleRate }. */
  async render({ from = 0, to = null, sampleRate = this.ctx.sampleRate, onProgress = () => {} } = {}) {
    const p = this.p, s = spb(p);
    const end = to ?? songEnd(p) + p.sig;
    const seconds = (end - from) * s + 2.5;
    const off = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const master = off.createGain(); master.gain.value = dbg(p.master.vol);
    const lim = off.createDynamicsCompressor(); lim.threshold.value = -1; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
    master.connect(lim).connect(off.destination);
    const reverb = off.createConvolver(); reverb.buffer = makeIR(off); reverb.connect(master);
    const at = (beat) => (beat - from) * s;
    for (const t of p.tracks) {
      const strip = makeStrip(off, master, reverb);
      applyStrip(strip, t, audibleOf(p, t), off);
      if (t.kind === 'inst') {
        const live = this.synthOf(t.id);
        if (!live) continue;
        const evs = [];
        for (const c of t.clips) for (const n of c.notes || []) {
          if (n.t >= c.len) continue;
          const nb = c.start + n.t;
          if (nb < from || nb >= end) continue;
          evs.push({ type: 'note', note: n.p, vel: n.v ?? 100, at: at(nb) }, { type: 'off', note: n.p, at: at(Math.min(nb + n.d, c.start + c.len)) });
        }
        const copy = await live.offlineCopy(off, evs.sort((x, y) => x.at - y.at));
        copy.connect(strip.input);
      } else {
        for (const c of t.clips) {
          const a = c.audioId && await loadAudio(this.ctx, c.audioId);
          if (!a) continue;
          const cEnd = clipEnd(p, c);
          if (cEnd <= from || c.start >= end) continue;
          const buf = off.createBuffer(a.channels.length, a.channels[0].length, a.sampleRate);
          a.channels.forEach((ch, i) => buf.copyToChannel(ch, i));
          const src = off.createBufferSource(); src.buffer = buf;
          const g = off.createGain(); g.gain.value = dbg(c.gain || 0);
          src.connect(g).connect(strip.input);
          const into = Math.max(0, (from - c.start) * s);
          src.start(Math.max(0, at(c.start)), c.offset + into, Math.max(0.001, Math.min(c.dur - into, (end - Math.max(from, c.start)) * s)));
        }
      }
    }
    const timer = setInterval(() => onProgress(Math.min(0.99, off.currentTime / seconds)), 200);
    try {
      const out = await off.startRendering();
      onProgress(1);
      return { channels: [out.getChannelData(0), out.getChannelData(1)], sampleRate };
    } finally { clearInterval(timer); }
  }

  destroy() {
    this.stop(false);
    this.stopMonitors();
    for (const e of this.strips.values()) e.synth?.destroy();
    this.strips.clear();
    try { this.master.disconnect(); this.metro.disconnect(); this.limiter.disconnect(); } catch { /* ok */ }
  }
}
