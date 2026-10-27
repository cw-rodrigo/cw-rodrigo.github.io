// Motor de áudio da DAW: canais (sintetizador) -> inserts do mixer (efeitos, pan, volume, envios) -> master.
// Toca o padrão atual em loop (modo Pattern) ou a playlist (modo Song), com agendamento antecipado,
// metrônomo, automação, gravação de áudio (entrada USB da Pocket Master, microfone…) e de notas,
// e exporta em WAV pelo mesmo grafo num OfflineAudioContext.
import { Synth } from '/lib/synth/synth.js';
import { getInput } from '/lib/audio/io.js';
import { makeFx } from './fx.js';
import { resolveTarget, valueAt } from './automation.js';
import { spb, clipEnd, songEnd, patternLength, curPattern, patternOf, loadAudio, cachedAudio, saveAudio } from './project.js';

const LOOKAHEAD = 0.15, TICK_MS = 25, AUTO_STEP = 0.125; // automação amostrada a cada 1/32
const dbg = (db) => (db <= -60 ? 0 : 10 ** (db / 20));

function clickBuffer(ctx, freq) {
  const len = Math.round(ctx.sampleRate * 0.04);
  const b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.sin((2 * Math.PI * freq * i) / ctx.sampleRate) * Math.exp(-i / (len / 6));
  return b;
}

// ---------------------------------------------------------------- grafo (ao vivo e na exportação)
/** Estrutura que, se mudar, exige refazer o grafo do mixer (efeitos, envios, roteamento). */
export function structureKey(p) {
  return JSON.stringify([p.mixer.inserts.map((i) => [i.id, i.fx.map((f) => [f.type, !!f.on]), i.sends.map((s) => s.to)]), p.channels.map((c) => [c.id, c.insert])]);
}
/** Mixer: um nó de entrada por insert, efeitos ligados em série, pan, volume, medidor e envios. */
function buildMixer(ctx, p, dest) {
  const map = new Map();
  for (const ins of p.mixer.inserts) {
    const input = ctx.createGain();
    const fx = ins.fx.map((def) => (def.on ? { def, node: makeFx(ctx, def.type, def.params, p.bpm) } : { def, node: null }));
    let last = input;
    for (const f of fx) if (f.node) { last.connect(f.node.input); last = f.node.output; }
    const pan = ctx.createStereoPanner(), vol = ctx.createGain(), meter = ctx.createAnalyser();
    meter.fftSize = 512;
    last.connect(pan).connect(vol);
    vol.connect(meter);
    map.set(ins.id, { ins, input, fx, pan, vol, meter, sends: [] });
  }
  const master = map.get(p.mixer.inserts[0].id);
  for (const [, m] of map) {
    m.vol.connect(m === master ? dest : master.input);
    for (const s of m.ins.sends) {
      const t = map.get(s.to);
      if (!t || t === m || t === master) continue;
      const g = ctx.createGain();
      g.gain.value = s.amount;
      m.vol.connect(g).connect(t.input);
      m.sends.push({ s, g });
    }
  }
  return map;
}
function applyMixer(map, p, ctx) {
  const now = ctx.currentTime;
  const soloing = p.mixer.inserts.some((i, k) => k > 0 && i.solo);
  for (const [, m] of map) {
    const ins = m.ins, isMaster = ins === p.mixer.inserts[0];
    const audible = !ins.mute && (isMaster || !soloing || ins.solo);
    m.vol.gain.cancelScheduledValues(now); m.pan.pan.cancelScheduledValues(now);
    m.vol.gain.setTargetAtTime(audible ? dbg(ins.vol) : 0, now, 0.015);
    m.pan.pan.setTargetAtTime(ins.pan, now, 0.02);
    for (const f of m.fx) f.node?.set(f.def.params, p.bpm);
    for (const { s, g } of m.sends) g.gain.setTargetAtTime(s.amount, now, 0.02);
  }
}
function disposeMixer(map) {
  for (const [, m] of map) { try { m.input.disconnect(); m.pan.disconnect(); m.vol.disconnect(); } catch { /* ok */ } m.fx.forEach((f) => f.node?.dispose()); m.sends.forEach(({ g }) => g.disconnect()); }
}

// ---------------------------------------------------------------- o que tocar entre duas batidas
/** Região que repete: o padrão (modo Pattern) ou o loop da playlist (modo Song). */
export function regionOf(p) {
  if (p.mode === 'pattern') { const pat = curPattern(p); return pat ? { start: 0, end: patternLength(p, pat) } : null; }
  return p.loop.on && p.loop.end > p.loop.start ? { start: p.loop.start, end: p.loop.end } : null;
}
/** Notas que começam em [a, b): [{ ch, note, vel, on, off }] (em batidas). offLimit = fim do loop. */
export function notesIn(p, a, b, offLimit = Infinity) {
  const out = [];
  // notas do padrão começando em `base` (pode ser antes do clipe, se ele começa no meio do padrão), só dentro de [from, end)
  const add = (pat, base, len, from, end) => {
    for (const [chId, list] of Object.entries(pat.notes)) for (const n of list) {
      if (n.t >= len) continue;
      const on = base + n.t;
      if (on < a || on >= b || on < from || on >= end) continue;
      out.push({ ch: chId, note: n.p, vel: n.v ?? 100, on, off: Math.min(on + n.d, base + len, end, offLimit) });
    }
  };
  if (p.mode === 'pattern') {
    const pat = curPattern(p);
    if (pat) { const len = patternLength(p, pat); for (let k = Math.floor(a / len); k * len < b; k++) add(pat, k * len, len, -Infinity, Infinity); }
    return out;
  }
  const muted = new Set(p.playlist.tracks.filter((t) => t.mute).map((t) => t.id));
  for (const c of p.playlist.clips) {
    if (c.kind !== 'pattern' || muted.has(c.track)) continue;
    const pat = patternOf(p, c.pattern);
    if (!pat) continue;
    const end = clipEnd(p, c);
    if (end <= a || c.start >= b) continue;
    const len = patternLength(p, pat);
    // o padrão repete enquanto o clipe for mais longo que ele; `offset` = clipe começando no meio do padrão
    const origin = c.start - (c.offset || 0);
    for (let k = Math.max(0, Math.floor((Math.max(a, c.start) - origin) / len)); origin + k * len < Math.min(b, end); k++) add(pat, origin + k * len, len, c.start, end);
  }
  return out;
}
/** Pontos de automação em [a, b): [{ target, beat, value (0..1), first }]. */
export function autoIn(p, a, b) {
  if (p.mode !== 'song') return [];
  const out = [];
  const muted = new Set(p.playlist.tracks.filter((t) => t.mute).map((t) => t.id));
  for (const c of p.playlist.clips) {
    if (c.kind !== 'auto' || muted.has(c.track)) continue;
    const s = Math.max(a, c.start), e = Math.min(b, clipEnd(p, c));
    if (e <= s) continue;
    let first = true;
    for (let t = Math.ceil(s / AUTO_STEP) * AUTO_STEP; t < e; t += AUTO_STEP) {
      out.push({ target: c.target, beat: t, value: valueAt(c.points, t - c.start), first: first && t === c.start });
      first = false;
    }
  }
  return out;
}

export class DawEngine {
  constructor(ctx, { onStop = () => {} } = {}) {
    this.ctx = ctx; this.p = null; this.onStop = onStop;
    this.out = ctx.createGain(); this.out.connect(ctx.destination);
    this.metro = ctx.createGain(); this.metro.gain.value = 0.5; this.metro.connect(ctx.destination);
    this.clicks = [clickBuffer(ctx, 1000), clickBuffer(ctx, 1600)];
    this.mixer = null; this.mixKey = '';
    this.chans = new Map(); // id do canal -> { synth, vol, pan }
    this.sources = new Set();
    this.monitors = new Map();
    this.playing = false; this.recording = null; this.timer = 0; this.pos = 0;
  }

  // ---------------------------------------------------------------- estrutura
  /** Cria/remove/atualiza instrumentos e mixer para combinar com o projeto. */
  async sync(p) {
    this.p = p;
    const key = structureKey(p);
    if (key !== this.mixKey) {
      const old = this.mixer;
      this.mixer = buildMixer(this.ctx, p, this.out);
      this.mixKey = key;
      if (old) disposeMixer(old);
      for (const [, c] of this.chans) c.pan.disconnect();
      for (const [id, m] of this.monitors) { const ins = this.mixer.get(id); m.node.disconnect(); if (ins) m.node.connect(ins.input); }
    }
    for (const [id, c] of this.chans) if (!p.channels.some((x) => x.id === id)) { c.synth.destroy(); c.pan.disconnect(); this.chans.delete(id); }
    for (const ch of p.channels) {
      let c = this.chans.get(ch.id);
      if (!c) {
        const synth = await Synth.create(this.ctx, ch.synth);
        const vol = this.ctx.createGain(), pan = this.ctx.createStereoPanner();
        synth.connect(vol); vol.connect(pan);
        c = { synth, vol, pan };
        this.chans.set(ch.id, c);
        await this.loadSource(ch, synth);
      } else if (c.synth.state.engine !== ch.synth.engine) c.synth.setEngine(ch.synth.engine, ch.synth.params);
      try { c.pan.disconnect(); } catch { /* ok */ }
      c.pan.connect((this.mixer.get(ch.insert) || this.mixer.get(p.mixer.inserts[0].id)).input);
    }
    this.mix(p);
    await Promise.all(p.playlist.clips.filter((c) => c.audioId).map((c) => loadAudio(this.ctx, c.audioId)));
  }
  async loadSource(ch, synth) {
    const src = ch.synth.source;
    try {
      if (src?.kind === 'gm') await synth.loadGM(src.program);
      else if (src?.kind === 'sample' && src.audioId) { const a = await loadAudio(this.ctx, src.audioId); if (a) synth.useSample({ channels: a.channels, sampleRate: a.sampleRate }, src); }
    } catch { /* sem a amostra: o instrumento fica mudo até carregar de novo */ }
  }
  synthOf(chId) { return this.chans.get(chId)?.synth || null; }
  /** Volumes, pans, mudo/solo e parâmetros de efeitos, sem refazer nada. */
  mix(p) {
    this.p = p;
    const now = this.ctx.currentTime;
    if (this.mixer) applyMixer(this.mixer, p, this.ctx);
    for (const ch of p.channels) {
      const c = this.chans.get(ch.id);
      if (!c) continue;
      c.vol.gain.cancelScheduledValues(now); c.pan.pan.cancelScheduledValues(now);
      c.vol.gain.setTargetAtTime(ch.mute ? 0 : dbg(ch.vol), now, 0.015);
      c.pan.pan.setTargetAtTime(ch.pan, now, 0.02);
    }
  }
  /** Pico do sinal (0..1) no insert (ou no master). */
  level(insId) {
    const an = (insId && this.mixer?.get(insId)) || this.mixer?.get(this.p?.mixer.inserts[0].id);
    if (!an) return 0;
    const m = an.meter;
    const d = m.__buf || (m.__buf = new Float32Array(m.fftSize));
    m.getFloatTimeDomainData(d);
    let pk = 0;
    for (const v of d) { const x = Math.abs(v); if (x > pk) pk = x; }
    return pk;
  }

  // ---------------------------------------------------------------- transporte
  get position() { return this.playing ? this.songBeatAt(this.ctx.currentTime) : this.pos; }
  /** Tempo do AudioContext -> batida (dentro do loop, se houver). */
  songBeatAt(time) {
    let b = this.start.beat + (time - this.start.time) / spb(this.p);
    const r = this.region;
    if (r && this.start.beat < r.end && b >= r.end) b = r.start + ((b - r.end) % (r.end - r.start));
    return b;
  }
  play(fromBeat = this.pos, { countIn = 0 } = {}) {
    if (this.playing) this.stop(false);
    const p = this.p;
    this.region = this.recording && p.mode === 'song' ? null : regionOf(p);
    if (this.region && (fromBeat >= this.region.end || fromBeat < this.region.start)) fromBeat = this.region.start;
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
    for (const [, c] of this.chans) { c.synth.clearScheduled(); c.synth.allOff(); c.synth.setParams({}); }
    this.mix(this.p); // desfaz o que a automação mudou (volumes, pans, efeitos e parâmetros do sintetizador)
    if (notify) this.onStop(this.pos);
  }
  seek(beat) {
    const was = this.playing;
    if (was) this.stop(false);
    this.pos = Math.max(0, beat);
    if (was) this.play(this.pos);
  }
  /** Mudou o modo ou o padrão tocando: recomeça do lugar certo. */
  restart() { if (this.playing && !this.recording) { this.stop(false); this.pos = 0; this.play(0); } }

  tick() {
    const p = this.p, s = spb(p), horizon = this.ctx.currentTime + LOOKAHEAD;
    let guard = 0;
    while (this.sched.time < horizon && guard++ < 50) {
      const r = this.region;
      const looping = r && this.sched.beat < r.end;
      const endBeatMax = looping ? r.end : Infinity;
      const endTime = Math.min(horizon, this.sched.time + (endBeatMax - this.sched.beat) * s);
      const endBeat = this.sched.beat + (endTime - this.sched.time) / s;
      this.scheduleRange(this.sched.beat, endBeat, this.sched.time, looping ? r.end : Infinity);
      this.sched = { beat: endBeat, time: endTime };
      if (looping && endBeat >= r.end - 1e-9) {
        this.sched = { beat: r.start, time: endTime };
        this.startMid(r.start, endTime);
      }
    }
    // acabou a música (modo Song, sem loop e sem gravar): para sozinho
    if (p.mode === 'song' && !this.region && !this.recording && songEnd(p) > 0 && this.position > songEnd(p) + p.sig) this.stop();
  }
  /** Agenda tudo que começa entre as batidas a e b (a acontece no instante tA). */
  scheduleRange(a, b, tA, loopEnd) {
    const p = this.p, s = spb(p), ctx = this.ctx;
    const at = (beat) => tA + (beat - a) * s;
    for (let k = Math.ceil(a - 1e-9); k < b; k++) {
      if (!p.metro && !(this.recording && k < this.recording.fromBeat)) continue; // na contagem, sempre
      const src = ctx.createBufferSource();
      src.buffer = this.clicks[((k % p.sig) + p.sig) % p.sig === 0 ? 1 : 0];
      src.connect(this.metro);
      src.start(Math.max(ctx.currentTime, at(k)));
      this.track(src);
    }
    const byCh = new Map();
    for (const n of notesIn(p, a, b, loopEnd)) {
      if (!byCh.has(n.ch)) byCh.set(n.ch, []);
      byCh.get(n.ch).push({ type: 'note', note: n.note, vel: n.vel, at: at(n.on) }, { type: 'off', note: n.note, at: at(n.off) - 0.0005 });
    }
    for (const [id, evs] of byCh) this.synthOf(id)?.events(evs);
    if (p.mode === 'song') {
      for (const c of p.playlist.clips) if (c.kind === 'audio' && c.start >= a && c.start < b) this.startAudio(c, at(c.start), 0, loopEnd === Infinity ? null : at(loopEnd));
      this.applyAuto(autoIn(p, a, b), at, this);
    }
  }
  /** Aplica pontos de automação. `env` dá os nós (ao vivo ou na exportação). */
  applyAuto(points, at, env) {
    const p = this.p;
    const synthEv = new Map();
    for (const pt of points) {
      const tg = resolveTarget(p, pt.target);
      if (!tg) continue;
      const v = tg.to(pt.value), t = at(pt.beat);
      const set = (param) => { if (pt.first) { param.cancelScheduledValues(t); param.setValueAtTime(v, t); } else param.linearRampToValueAtTime(v, t); };
      if (tg.kind === 'chVol') { const c = env.chans.get(tg.id); if (c) set(c.vol.gain); }
      else if (tg.kind === 'chPan') { const c = env.chans.get(tg.id); if (c) set(c.pan.pan); }
      else if (tg.kind === 'chParam') { if (!synthEv.has(tg.id)) synthEv.set(tg.id, []); synthEv.get(tg.id).push({ type: 'param', id: tg.param, value: v, at: t }); }
      else {
        const m = env.mixer.get(tg.id);
        if (!m) continue;
        if (tg.kind === 'insVol') set(m.vol.gain);
        else if (tg.kind === 'insPan') set(m.pan.pan);
        else m.fx[tg.fx]?.node?.at(tg.param, v, t, pt.first);
      }
    }
    if (env === this) for (const [id, evs] of synthEv) this.synthOf(id)?.events(evs);
    return synthEv;
  }
  /** Ao começar a tocar (ou voltar ao início do loop) no meio de um clipe de áudio, ele toca a partir dali. */
  startMid(beat, time) {
    const p = this.p, s = spb(p), r = this.region;
    if (p.mode !== 'song') return;
    const stopAt = r && beat < r.end ? time + (r.end - beat) * s : null;
    for (const c of p.playlist.clips) if (c.kind === 'audio' && c.start < beat && clipEnd(p, c) > beat) this.startAudio(c, time, (beat - c.start) * s, stopAt);
    // automação: valor do ponto onde começou
    const inside = p.playlist.clips.filter((c) => c.kind === 'auto' && c.start < beat && clipEnd(p, c) > beat);
    this.applyAuto(inside.map((c) => ({ target: c.target, beat, value: valueAt(c.points, beat - c.start), first: true })), () => time, this);
  }
  startAudio(c, when, into = 0, stopAt = null) {
    const a = cachedAudio(c.audioId);
    const m = this.mixer.get(c.insert) || this.mixer.get(this.p.mixer.inserts[0].id);
    if (!a || !m || this.p.playlist.tracks.find((t) => t.id === c.track)?.mute) return;
    const dur = c.dur - into;
    if (dur <= 0) return;
    const src = this.ctx.createBufferSource();
    src.buffer = a.buffer;
    const g = this.ctx.createGain();
    g.gain.value = dbg(c.gain || 0);
    src.connect(g).connect(m.input);
    const now = this.ctx.currentTime, late = Math.max(0, now - when);
    src.start(Math.max(now, when), (c.offset || 0) + into + late, Math.max(0.001, dur - late));
    if (stopAt) src.stop(stopAt);
    this.track(src);
  }
  track(src) { this.sources.add(src); src.onended = () => this.sources.delete(src); }

  // ---------------------------------------------------------------- tocar ao vivo, ouvir a entrada e gravar
  liveOn(chId, note, vel) {
    const syn = this.synthOf(chId);
    if (!syn) return;
    syn.noteOn(note, vel);
    this.recording?.notes.push({ ch: chId, type: 'on', note, vel, beat: this.position });
  }
  liveOff(chId, note) {
    const syn = this.synthOf(chId);
    if (!syn) return;
    syn.noteOff(note);
    this.recording?.notes.push({ ch: chId, type: 'off', note, beat: this.position });
  }
  /** Liga/desliga ouvir a entrada do insert pelo site. */
  async setMonitor(ins, on) {
    const cur = this.monitors.get(ins.id);
    if (cur) { cur.node.disconnect(); cur.src.disconnect(); cur.stream.getTracks().forEach((t) => t.stop()); this.monitors.delete(ins.id); }
    if (!on) return;
    const m = this.mixer.get(ins.id);
    if (!m) return;
    const stream = await getInput(ins.input.deviceId || null);
    const src = this.ctx.createMediaStreamSource(stream);
    let node = src;
    if (ins.input.channel !== 'stereo') {
      const split = this.ctx.createChannelSplitter(2), merge = this.ctx.createChannelMerger(2), k = ins.input.channel === 'right' ? 1 : 0;
      src.connect(split); split.connect(merge, k, 0); split.connect(merge, k, 1); node = merge;
    }
    node.connect(m.input);
    this.monitors.set(ins.id, { stream, src, node });
  }
  stopMonitors() { for (const [id] of this.monitors) this.setMonitor({ id }, false); }

  /** Grava as entradas dos inserts armados e as notas tocadas, a partir de `fromBeat`. */
  async record(fromBeat, { countIn = 0 } = {}) {
    const p = this.p;
    this.ctx.__recReady ||= this.ctx.audioWorklet.addModule(new URL('/lib/audio/recorder-worklet.js', location.href).href);
    await this.ctx.__recReady;
    const rec = { fromBeat, mode: p.mode, audio: [], notes: [], devices: new Map() };
    for (const ins of p.mixer.inserts.filter((i) => i.arm)) {
      const key = ins.input.deviceId || 'default';
      let dev = rec.devices.get(key);
      if (!dev) {
        const stream = await getInput(ins.input.deviceId || null);
        const src = this.ctx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(this.ctx, 'estudio-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
        src.connect(node);
        dev = { stream, src, node, chunks: [], latency: stream.getAudioTracks()[0]?.getSettings?.().latency || 0.01 };
        node.port.onmessage = (e) => { if (e.data.type === 'data') dev.chunks.push(e.data); };
        rec.devices.set(key, dev);
      }
      rec.audio.push({ ins, dev });
    }
    this.recording = rec;
    for (const dev of rec.devices.values()) dev.node.port.postMessage('start');
    this.play(fromBeat, { countIn });
  }
  /**
   * Para a gravação. Devolve { audio: [{ insert, start (batida), dur (s), audioId, name }], notes: [{ ch, p, t, d, v }] }
   * (no modo Pattern as notas já vêm dentro do padrão; no Song, em batidas da música).
   */
  async stopRecording() {
    const rec = this.recording;
    if (!rec) return { audio: [], notes: [] };
    const p = this.p, s = spb(p);
    const endBeat = this.position;
    const startInfo = this.start;
    this.stop(false);
    await Promise.all([...rec.devices.values()].map((dev) => new Promise((resolve) => {
      const prev = dev.node.port.onmessage;
      dev.node.port.onmessage = (e) => { prev(e); if (e.data.type === 'stopped') resolve(); };
      dev.node.port.postMessage('stop');
      setTimeout(resolve, 600); // se a mensagem não vier, segue com o que chegou
    })));
    this.recording = null;
    const comp = p.latencyMs != null ? p.latencyMs / 1000 : null;
    const out = { audio: [], notes: [] };
    for (const dev of rec.devices.values()) {
      dev.src.disconnect(); dev.stream.getTracks().forEach((t) => t.stop());
      if (!dev.chunks.length) continue;
      const total = dev.chunks.reduce((n, c) => n + c.L.length, 0);
      const L = new Float32Array(total), R = new Float32Array(total);
      let o = 0;
      for (const c of dev.chunks) { L.set(c.L, o); R.set(c.R, o); o += c.L.length; }
      // o que você tocou chega atrasado (saída + entrada): compensa
      const lat = comp != null ? comp : (this.ctx.outputLatency || this.ctx.baseLatency || 0) + dev.latency;
      const firstBeat = (dev.chunks[0].t - lat - startInfo.time) / s + startInfo.beat;
      const skip = Math.max(0, Math.round((rec.fromBeat - firstBeat) * s * this.ctx.sampleRate)); // corta a contagem
      dev.L = L.subarray(skip); dev.R = R.subarray(skip);
      dev.firstBeat = Math.max(firstBeat, rec.fromBeat);
    }
    for (const { ins, dev } of rec.audio) {
      if (!dev.L || dev.L.length < 1000) continue;
      const ch = ins.input.channel;
      const chans = ch === 'left' ? [dev.L.slice()] : ch === 'right' ? [dev.R.slice()] : [dev.L.slice(), dev.R.slice()];
      const audioId = await saveAudio(chans, this.ctx.sampleRate, ins.name);
      await loadAudio(this.ctx, audioId);
      out.audio.push({ insert: ins.id, start: dev.firstBeat, dur: chans[0].length / this.ctx.sampleRate, audioId, name: `${ins.name} ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` });
    }
    // notas: junta liga/desliga
    const len = rec.mode === 'pattern' ? patternLength(p, curPattern(p)) : null;
    const open = new Map();
    for (const ev of rec.notes) {
      if (ev.beat < rec.fromBeat - 0.5 && rec.mode === 'song') continue;
      const k = ev.ch + ':' + ev.note;
      if (ev.type === 'on') open.set(k, { ...ev, beat: rec.mode === 'song' ? Math.max(ev.beat, rec.fromBeat) : Math.max(0, ev.beat) });
      else if (open.has(k)) { const on = open.get(k); open.delete(k); out.notes.push(noteOf(on, ev.beat)); }
    }
    for (const on of open.values()) out.notes.push(noteOf(on, endBeat));
    function noteOf(on, offBeat) {
      let d = offBeat - on.beat;
      if (len && d <= 0) d += len; // passou pelo fim do padrão e voltou
      return { ch: on.ch, p: on.note, t: on.beat, d: Math.max(0.05, d), v: on.vel };
    }
    return out;
  }

  // ---------------------------------------------------------------- exportar
  /** Mixagem num OfflineAudioContext: a música (ou o loop, ou o padrão atual). Retorna { channels, sampleRate }. */
  async render({ from = 0, to = null, mode = null, sampleRate = this.ctx.sampleRate, onProgress = () => {} } = {}) {
    const p = mode ? { ...this.p, mode } : this.p, s = spb(p);
    const end = to ?? (p.mode === 'pattern' ? patternLength(p, curPattern(p)) : songEnd(p) + p.sig);
    const seconds = (end - from) * s + 2.5;
    const off = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const env = { mixer: buildMixer(off, p, off.destination), chans: new Map() };
    applyMixer(env.mixer, p, off);
    const at = (beat) => (beat - from) * s;
    const notes = notesIn(p, from, end, end);
    const autos = this.applyAuto(autoIn(p, from, end), at, env);
    for (const ch of p.channels) {
      const live = this.synthOf(ch.id);
      if (!live) continue;
      const evs = notes.filter((n) => n.ch === ch.id).flatMap((n) => [{ type: 'note', note: n.note, vel: n.vel, at: at(n.on) }, { type: 'off', note: n.note, at: at(n.off) }]);
      evs.push(...(autos.get(ch.id) || []));
      const copy = await live.offlineCopy(off, evs.sort((x, y) => x.at - y.at));
      const vol = off.createGain(), pan = off.createStereoPanner();
      vol.gain.value = ch.mute ? 0 : dbg(ch.vol); pan.pan.value = ch.pan;
      copy.connect(vol); vol.connect(pan).connect((env.mixer.get(ch.insert) || env.mixer.get(p.mixer.inserts[0].id)).input);
      env.chans.set(ch.id, { vol, pan });
    }
    // automação de volume/pan dos canais depende dos nós acima: aplica de novo agora que existem
    this.applyAuto(autoIn(p, from, end).filter((x) => /^ch:[^:]+:(vol|pan)$/.test(x.target)), at, env);
    if (p.mode === 'song') {
      const muted = new Set(p.playlist.tracks.filter((t) => t.mute).map((t) => t.id));
      for (const c of p.playlist.clips) {
        if (c.kind !== 'audio' || muted.has(c.track)) continue;
        const a = await loadAudio(this.ctx, c.audioId);
        const cEnd = clipEnd(p, c);
        if (!a || cEnd <= from || c.start >= end) continue;
        const buf = off.createBuffer(a.channels.length, a.channels[0].length, a.sampleRate);
        a.channels.forEach((ch, i) => buf.copyToChannel(ch, i));
        const src = off.createBufferSource(); src.buffer = buf;
        const g = off.createGain(); g.gain.value = dbg(c.gain || 0);
        src.connect(g).connect((env.mixer.get(c.insert) || env.mixer.get(p.mixer.inserts[0].id)).input);
        const into = Math.max(0, (from - c.start) * s);
        src.start(Math.max(0, at(c.start)), (c.offset || 0) + into, Math.max(0.001, Math.min(c.dur - into, (end - Math.max(from, c.start)) * s)));
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
    for (const [, c] of this.chans) { c.synth.destroy(); c.pan.disconnect(); }
    this.chans.clear();
    if (this.mixer) disposeMixer(this.mixer);
    try { this.out.disconnect(); this.metro.disconnect(); } catch { /* ok */ }
  }
}
