// Transcrição da letra com Whisper (open source), rodando no navegador num worker.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

let asr = null;
let loaded = '';

async function load(model, device) {
  const opts = {
    device,
    dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) self.postMessage({ type: 'download', file: p.file, loaded: p.loaded, total: p.total });
    },
  };
  return pipeline('automatic-speech-recognition', model, opts);
}

self.onmessage = async (e) => {
  const { audio, model, language } = e.data;
  try {
    if (!asr || loaded !== model) {
      self.postMessage({ type: 'status', text: 'Baixando o modelo de IA (só na primeira vez)…' });
      try {
        asr = await load(model, self.navigator.gpu ? 'webgpu' : 'wasm');
      } catch {
        asr = await load(model, 'wasm');
      }
      loaded = model;
    }
    self.postMessage({ type: 'status', text: 'Transcrevendo a letra… isso pode levar alguns minutos.' });
    const out = await asr(audio, {
      language, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, return_timestamps: true,
    });
    self.postMessage({ type: 'done', chunks: out.chunks || [{ timestamp: [0, null], text: out.text }] });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
