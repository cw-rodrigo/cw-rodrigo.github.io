// Ponte para o worker do Whisper e conversão de áudio para 16 kHz.

let worker = null;

export const MODELS = [
  { id: 'onnx-community/whisper-base', label: 'Rápido (download menor)' },
  { id: 'onnx-community/whisper-small', label: 'Mais preciso (download maior, mais lento)' },
];

/** Converte amostras mono para 16 kHz, o formato que o Whisper espera. */
export async function to16k(samples, sampleRate) {
  if (sampleRate === 16000) return samples;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const len = Math.ceil((samples.length * 16000) / sampleRate);
  const off = new OAC(1, len, 16000);
  const buf = off.createBuffer(1, samples.length, sampleRate);
  buf.copyToChannel(samples, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}

let wasmOnly = false;

/** Usa a placa de vídeo (WebGPU) só se o navegador realmente conseguir acessá-la. */
async function pickDevice() {
  if (wasmOnly || !navigator.gpu) return 'wasm';
  try { return (await navigator.gpu.requestAdapter()) ? 'webgpu' : 'wasm'; } catch { return 'wasm'; }
}

function run(audio16k, model, language, device, onStatus) {
  worker ||= new Worker(new URL('./whisper-worker.js?v=11', import.meta.url), { type: 'module' });
  const files = {};
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'status') onStatus(m.text);
      if (m.type === 'download') {
        files[m.file] = m;
        const loaded = Object.values(files).reduce((n, f) => n + f.loaded, 0);
        const total = Object.values(files).reduce((n, f) => n + f.total, 0);
        onStatus(`Baixando o modelo de IA (só na primeira vez): ${Math.round((loaded / total) * 100)}% de ${Math.round(total / 1e6)} MB`);
      }
      if (m.type === 'done') resolve(m.chunks);
      if (m.type === 'error') reject(new Error(m.message));
    };
    worker.onerror = (err) => reject(new Error(err.message || 'Falha ao iniciar a IA.'));
    worker.postMessage({ audio: audio16k, model, language, device });
  });
}

/** Transcreve a letra. Retorna os trechos do Whisper: [{ timestamp:[s,e], text }]. */
export async function transcribe(audio16k, { model, language = 'portuguese', onStatus = () => {} }) {
  const device = await pickDevice();
  try {
    return await run(audio16k, model, language, device, onStatus);
  } catch (err) {
    if (device !== 'webgpu') throw err;
    // a placa de vídeo falhou: recomeça do zero sem ela (o processador é mais lento, mas sempre funciona)
    worker?.terminate();
    worker = null;
    wasmOnly = true;
    onStatus('A placa de vídeo não pôde ser usada; continuando pelo processador…');
    return run(audio16k, model, language, 'wasm', onStatus);
  }
}
