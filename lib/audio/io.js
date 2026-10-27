// Entrada e saída de áudio: ouvir a aba (player embutido), microfone/entradas, arquivos,
// gravação, reamostragem, tocar e exportar WAV.

const AC = () => window.AudioContext || window.webkitAudioContext;
export const isMobile = () => /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

/** O navegador consegue ouvir o áudio da própria aba? (Chrome/Edge no computador) */
export function canCaptureTab() {
  return !!navigator.mediaDevices?.getDisplayMedia && !isMobile();
}

/**
 * Pede para compartilhar o áudio desta aba. Com `silent`, o som não sai nos alto-falantes
 * enquanto é capturado (bom para analisar em 2x sem incomodar).
 */
export async function captureThisTab({ silent = false } = {}) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' },
    audio: { suppressLocalAudioPlayback: silent, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    preferCurrentTab: true, selfBrowserSurface: 'include', systemAudio: 'include', surfaceSwitching: 'exclude',
  });
  stream.getVideoTracks().forEach((t) => t.stop());
  const audio = stream.getAudioTracks();
  if (!audio.length) throw Object.assign(new Error('sem áudio'), { name: 'NoAudio' });
  return new MediaStream(audio);
}

/** Mensagem amigável para erros de captura/microfone. */
export function captureError(err, what = 'o áudio') {
  if (err?.name === 'NoAudio') return 'O áudio não foi compartilhado. Tente de novo e deixe marcado "compartilhar o áudio da guia".';
  if (err?.name === 'NotAllowedError') return `Permissão negada para usar ${what}.`;
  if (err?.name === 'NotFoundError') return 'Nenhuma entrada de áudio encontrada.';
  return err?.message || `Não foi possível usar ${what}.`;
}

/** Microfone ou outra entrada de áudio, sem processamento de voz. */
export function getInput(deviceId = null) {
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(Object.assign(new Error('Este navegador não dá acesso ao microfone.'), { name: 'Unsupported' }));
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
  });
}
export async function listInputs() {
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
}

/**
 * Grava um MediaStream em estéreo.
 * shouldKeep(): o bloco entra na gravação?  onLevel(rms)  onBlock(L, R) a cada bloco guardado.
 * getTime(): tempo da música (para converter a posição da gravação em tempo da música depois).
 */
export class Recorder {
  async start(stream, { shouldKeep = () => true, onLevel = null, onBlock = null, getTime = null, keep = true } = {}) {
    this.stream = stream;
    this.ctx = new (AC())();
    await this.ctx.resume?.();
    this.sampleRate = this.ctx.sampleRate;
    this.src = this.ctx.createMediaStreamSource(stream);
    const sp = this.ctx.createScriptProcessor(4096, 2, 2);
    this.L = []; this.R = []; this.timeline = [];
    this.kept = 0;
    sp.onaudioprocess = (e) => {
      const ib = e.inputBuffer;
      const l = ib.getChannelData(0), r = ib.numberOfChannels > 1 ? ib.getChannelData(1) : l;
      if (onLevel) { let s = 0; for (let i = 0; i < l.length; i += 8) s += l[i] * l[i]; onLevel(Math.sqrt(s / (l.length / 8))); }
      if (!shouldKeep()) return;
      if (getTime) this.timeline.push({ at: this.kept / this.sampleRate, t: getTime() });
      const a = new Float32Array(l), b = new Float32Array(r);
      if (keep) { this.L.push(a); this.R.push(b); }
      this.kept += a.length;
      onBlock?.(a, b);
    };
    this.src.connect(sp);
    sp.connect(this.ctx.destination); // sai em silêncio: o processador só precisa estar ligado
    this.sp = sp;
  }
  get seconds() { return this.kept / (this.sampleRate || 48000); }
  /** { channels:[L,R], sampleRate, toMusicTime(segundos da gravação) } */
  result() {
    const n = this.L.reduce((k, c) => k + c.length, 0);
    const L = new Float32Array(n), R = new Float32Array(n);
    let o = 0;
    this.L.forEach((c, k) => { L.set(c, o); R.set(this.R[k], o); o += c.length; });
    const tl = this.timeline;
    const toMusicTime = (w) => {
      if (!tl.length) return w;
      let i = tl.findIndex((p) => p.at > w);
      if (i === -1) i = tl.length;
      const a = tl[Math.max(0, i - 1)];
      return a.t + (w - a.at) * (this.rate || 1);
    };
    return { channels: [L, R], sampleRate: this.sampleRate, toMusicTime };
  }
  stop() {
    try { this.sp?.disconnect(); this.src?.disconnect(); } catch { /* ok */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
  }
}

export function mono(channels) {
  const [L, R] = channels;
  if (!R || R === L) return L;
  const m = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) m[i] = (L[i] + R[i]) / 2;
  return m;
}

/** Reamostra (e ajusta o número de canais). Retorna um array de canais. */
export async function resample(channels, fromRate, toRate, outChannels = channels.length) {
  const src = channels.slice(0, outChannels);
  while (src.length < outChannels) src.push(channels[0]);
  if (fromRate === toRate) return src;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const len = Math.ceil((src[0].length * toRate) / fromRate);
  const off = new OAC(outChannels, len, toRate);
  const buf = off.createBuffer(outChannels, src[0].length, fromRate);
  src.forEach((c, i) => buf.copyToChannel(c, i));
  const node = off.createBufferSource();
  node.buffer = buf;
  node.connect(off.destination);
  node.start();
  const out = await off.startRendering();
  return Array.from({ length: outChannels }, (_, i) => out.getChannelData(i));
}

/** Lê um arquivo de áudio (ou vídeo). Com start/end, devolve só o trecho. */
export async function decodeFile(file, start = 0, end = Infinity) {
  const ctx = new (AC())();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const sr = buf.sampleRate;
    const a = Math.max(0, Math.floor((start || 0) * sr));
    const b = Math.min(buf.length, Number.isFinite(end) && end != null ? Math.floor(end * sr) : buf.length);
    if (b - a < sr * 2) throw Object.assign(new Error(`O arquivo tem ${Math.round(buf.duration)} s; o trecho escolhido fica fora dele.`), { name: 'OutOfRange', duration: buf.duration });
    const L = buf.getChannelData(0).slice(a, b);
    const R = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice(a, b);
    return { channels: [L, R], sampleRate: sr, duration: buf.duration, offset: a / sr };
  } finally { ctx.close(); }
}

/**
 * Toca canais de áudio. Retorna { stop(), ctx, startedAt } . `onEnd` ao terminar.
 */
export function playSamples(channels, sampleRate, { onEnd = null, offset = 0 } = {}) {
  const ctx = new (AC())();
  const buf = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
  channels.forEach((c, i) => buf.copyToChannel(c, i));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0, offset);
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; try { src.stop(); } catch { /* ok */ } ctx.close(); onEnd?.(); };
  src.onended = stop;
  return { stop };
}

/** WAV 16 bits (mono ou estéreo) para baixar. */
export function encodeWav(channels, sampleRate) {
  const nch = channels.length, n = channels[0].length;
  const buf = new ArrayBuffer(44 + n * nch * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * nch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nch * 2, true);
  v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * nch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
