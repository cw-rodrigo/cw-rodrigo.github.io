// Entrada e saída de áudio: ouvir a aba (player embutido), microfone/entradas, arquivos,
// gravação, reamostragem, tocar e exportar WAV.
import { audioCtx } from './context.js';

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
 * Grava um MediaStream em estéreo (AudioWorklet no AudioContext do site: o áudio é copiado fora
 * da thread da página, sem os cortes do antigo ScriptProcessor).
 * shouldKeep(): o bloco entra na gravação?  onLevel(rms)  onBlock(L, R) a cada bloco guardado (~85 ms).
 * getTime(): tempo da música (para converter a posição da gravação em tempo da música depois).
 */
export class Recorder {
  async start(stream, { shouldKeep = () => true, onLevel = null, onBlock = null, getTime = null, keep = true } = {}) {
    this.stream = stream;
    const ctx = (this.ctx = audioCtx());
    await ctx.resume?.();
    ctx.__recReady ||= ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url).href);
    await ctx.__recReady;
    this.sampleRate = ctx.sampleRate;
    this.src = ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(ctx, 'estudio-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    this.L = []; this.R = []; this.timeline = [];
    this.kept = 0;
    this.node.port.onmessage = (e) => {
      if (e.data.type !== 'data' || this.stopped) return;
      const { L: a, R: b } = e.data;
      if (onLevel) { let s = 0; for (let i = 0; i < a.length; i += 8) s += a[i] * a[i]; onLevel(Math.sqrt(s / (a.length / 8))); }
      if (!shouldKeep()) return;
      if (getTime) this.timeline.push({ at: this.kept / this.sampleRate, t: getTime() });
      if (keep) { this.L.push(a); this.R.push(b); }
      this.kept += a.length;
      onBlock?.(a, b);
    };
    this.src.connect(this.node);
    this.node.port.postMessage('start');
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
    this.stopped = true;
    try { this.node?.port.postMessage('stop'); this.src?.disconnect(); } catch { /* ok */ }
    this.stream?.getTracks().forEach((t) => t.stop());
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

/**
 * Lê um arquivo de áudio (ou vídeo). Com start/end, devolve só o trecho.
 * `min`: duração mínima em segundos (as análises precisam de alguns segundos; amostras não).
 */
export async function decodeFile(file, start = 0, end = Infinity, { min = 2 } = {}) {
  const ctx = new (AC())();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const sr = buf.sampleRate;
    const a = Math.max(0, Math.floor((start || 0) * sr));
    const b = Math.min(buf.length, Number.isFinite(end) && end != null ? Math.floor(end * sr) : buf.length);
    if (b - a < sr * min) {
      const msg = start > 0 || Number.isFinite(end) ? `O arquivo tem ${Math.round(buf.duration)} s; o trecho escolhido fica fora dele.` : `O arquivo é curto demais (${buf.duration.toFixed(1)} s).`;
      throw Object.assign(new Error(msg), { name: 'OutOfRange', duration: buf.duration });
    }
    const L = buf.getChannelData(0).slice(a, b);
    const R = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice(a, b);
    return { channels: [L, R], sampleRate: sr, duration: buf.duration, offset: a / sr };
  } finally { ctx.close(); }
}

/** Toca canais de áudio no contexto do site. Retorna { stop() }; `onEnd` ao terminar. */
export function playSamples(channels, sampleRate, { onEnd = null, offset = 0 } = {}) {
  const ctx = audioCtx();
  const buf = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
  channels.forEach((c, i) => buf.copyToChannel(c, i));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0, offset);
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; try { src.stop(); src.disconnect(); } catch { /* ok */ } onEnd?.(); };
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
