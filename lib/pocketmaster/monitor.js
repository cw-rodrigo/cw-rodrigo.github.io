// Ouvir a Pocket Master pelo computador: o som que sai dela pelo USB (ela aparece como uma placa de som)
// vai direto para os alto-falantes/fones, e também pode ser gravado por alguns segundos para análise.
import { getInput, listInputs, Recorder } from '/lib/audio/io.js';
import { audioCtx, resumeAudio } from '/lib/audio/context.js';
import { PEDAL_NAME } from './pm.js';

const KEY = 'pm.monitor';
const listeners = new Set();
let mon = null; // { stream, src, gain, meter, label }

function prefs() { try { return { volume: 0.8, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { volume: 0.8 }; } }
function savePrefs(p) { try { localStorage.setItem(KEY, JSON.stringify({ ...prefs(), ...p })); } catch { /* sem armazenamento */ } }
const emit = () => listeners.forEach((fn) => fn(monitorState()));

export function onMonitor(fn) { listeners.add(fn); fn(monitorState()); return () => listeners.delete(fn); }
export function monitorState() { return { on: !!mon, volume: prefs().volume, label: mon?.label || '' }; }

/** A entrada de áudio da pedaleira (pede a permissão do microfone uma vez para ver os nomes). */
export async function findPedalInput({ ask = true } = {}) {
  let list = await listInputs();
  if (ask && !list.some((d) => d.label)) {
    const s = await getInput();
    s.getTracks().forEach((t) => t.stop());
    list = await listInputs();
  }
  return list.find((d) => PEDAL_NAME.test(d.label)) || null;
}
const noPedal = () => Object.assign(new Error('Não achei a entrada de áudio da Pocket Master. Ligue a pedaleira no computador pelo cabo USB-C (ela aparece como uma placa de som).'), { name: 'NoPedal' });

/** Liga o retorno: o som da pedaleira sai no computador. */
export async function startMonitor({ deviceId = null, volume = null } = {}) {
  stopMonitor(false);
  const dev = deviceId ? { deviceId, label: '' } : await findPedalInput();
  if (!dev) throw noPedal();
  const stream = await getInput(dev.deviceId);
  const ctx = await resumeAudio();
  const src = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain(), meter = ctx.createAnalyser();
  meter.fftSize = 1024;
  if (volume != null) savePrefs({ volume });
  gain.gain.value = prefs().volume;
  src.connect(gain).connect(ctx.destination);
  src.connect(meter);
  mon = { stream, src, gain, meter, label: dev.label || stream.getAudioTracks()[0]?.label || '' };
  stream.getAudioTracks()[0]?.addEventListener('ended', () => stopMonitor());
  emit();
  return monitorState();
}
export function stopMonitor(notify = true) {
  if (!mon) return;
  try { mon.src.disconnect(); mon.gain.disconnect(); } catch { /* ok */ }
  mon.stream.getTracks().forEach((t) => t.stop());
  mon = null;
  if (notify) emit();
}
export function setMonitorVolume(v) {
  savePrefs({ volume: v });
  if (mon) mon.gain.gain.setTargetAtTime(v, audioCtx().currentTime, 0.02);
  emit();
}
/** Pico do sinal que está chegando (0..1), com o retorno ligado. */
export function monitorLevel() {
  if (!mon) return 0;
  const d = mon.buf || (mon.buf = new Float32Array(mon.meter.fftSize));
  mon.meter.getFloatTimeDomainData(d);
  let pk = 0;
  for (const v of d) { const a = Math.abs(v); if (a > pk) pk = a; }
  return pk;
}

/**
 * Grava `seconds` segundos de uma entrada (por padrão a pedaleira). Espera até `wait` segundos o som
 * começar (alguém tocar) e só conta a partir daí. Devolve { channels, sampleRate, waited, label } ou
 * { channels: null } se nada chegou.
 */
export async function captureInput(seconds, { deviceId = null, source = 'pedal', wait = 15, threshold = 0.004 } = {}) {
  let dev = deviceId ? { deviceId, label: '' } : null;
  if (!dev && source === 'pedal') { dev = await findPedalInput(); if (!dev) throw noPedal(); }
  const stream = await getInput(dev?.deviceId || null);
  const label = dev?.label || stream.getAudioTracks()[0]?.label || '';
  const rec = new Recorder();
  let started = false, level = 0;
  const t0 = performance.now();
  let startedAt = 0;
  await rec.start(stream, {
    onLevel: (l) => { level = l; if (!started && l > threshold) { started = true; startedAt = performance.now(); } },
    shouldKeep: () => started,
  });
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      const waited = (performance.now() - t0) / 1000;
      if ((started && rec.seconds >= seconds) || (!started && waited > wait)) { clearInterval(tick); resolve(); }
    }, 50);
  });
  rec.stop();
  if (!started) return { channels: null, label, waited: wait, level };
  const r = rec.result();
  return { channels: r.channels, sampleRate: r.sampleRate, waited: (startedAt - t0) / 1000, label };
}
