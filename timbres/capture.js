// Gravação de áudio: da própria aba (player do YouTube embutido) ou de uma entrada (pedaleira pelo USB).

export function canCaptureTab() {
  return !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
}

/** Pede para compartilhar o áudio desta aba, sem tocar o som nos alto-falantes. */
export async function captureThisTab() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' },
    audio: { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    preferCurrentTab: true, selfBrowserSurface: 'include', systemAudio: 'include', surfaceSwitching: 'exclude',
  });
  stream.getVideoTracks().forEach((t) => t.stop());
  const audio = stream.getAudioTracks();
  if (!audio.length) throw Object.assign(new Error('sem áudio'), { name: 'NoAudio' });
  return new MediaStream(audio);
}

/** Grava um MediaStream em estéreo. `shouldKeep()` decide, a cada bloco, se o bloco entra na gravação. */
export class Recorder {
  async start(stream, { shouldKeep = () => true, onLevel = () => {}, onBlock = null } = {}) {
    this.stream = stream;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume?.();
    this.sampleRate = this.ctx.sampleRate;
    const src = this.ctx.createMediaStreamSource(stream);
    const sp = this.ctx.createScriptProcessor(4096, 2, 2);
    this.L = []; this.R = [];
    sp.onaudioprocess = (e) => {
      const ib = e.inputBuffer;
      const l = ib.getChannelData(0), r = ib.numberOfChannels > 1 ? ib.getChannelData(1) : l;
      let s = 0;
      for (let i = 0; i < l.length; i += 8) s += l[i] * l[i];
      onLevel(Math.sqrt(s / (l.length / 8)));
      if (!shouldKeep()) return;
      const a = new Float32Array(l), b = new Float32Array(r);
      this.L.push(a); this.R.push(b);
      onBlock?.(a, b);
    };
    src.connect(sp);
    sp.connect(this.ctx.destination); // sem som: o processador só precisa estar ligado
    this.sp = sp;
  }
  get seconds() { return (this.L.reduce((n, c) => n + c.length, 0)) / (this.sampleRate || 48000); }
  result() {
    const n = this.L.reduce((k, c) => k + c.length, 0);
    const L = new Float32Array(n), R = new Float32Array(n);
    let o = 0;
    this.L.forEach((c, k) => { L.set(c, o); R.set(this.R[k], o); o += c.length; });
    return { channels: [L, R], sampleRate: this.sampleRate };
  }
  stop() {
    this.sp?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
  }
}

export function mono([L, R]) {
  const m = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) m[i] = (L[i] + (R || L)[i]) / 2;
  return m;
}

/** Lê um arquivo de áudio e devolve só o trecho pedido. */
export async function decodeFile(file, start = 0, end = Infinity) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const sr = buf.sampleRate;
    const a = Math.max(0, Math.floor(start * sr));
    const b = Math.min(buf.length, Number.isFinite(end) ? Math.floor(end * sr) : buf.length);
    if (b - a < sr * 3) throw Object.assign(new Error('curto'), { name: 'TooShort', duration: buf.duration });
    const L = buf.getChannelData(0).slice(a, b);
    const R = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice(a, b);
    return { channels: [L, R], sampleRate: sr, duration: buf.duration };
  } finally { ctx.close(); }
}

/** Toca amostras (para comparar). Retorna uma função que para o som. */
export function playSamples(channels, sampleRate) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
  channels.forEach((c, i) => buf.copyToChannel(c, i));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; try { src.stop(); } catch { /* ok */ } ctx.close(); };
  src.onended = stop;
  return stop;
}
