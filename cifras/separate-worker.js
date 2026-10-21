// Separação de faixas com HTDemucs (ONNX, versão int8 para processador) rodando num worker.
// Pesos: Meta (licença CC BY-NC 4.0, uso não comercial). Exportação ONNX: HRSadeghi/demucs-onnx (MIT).
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.wasm.min.mjs';
import { Spectrogram, transitionWeight, planChunks } from './demucs-dsp.js?v=9';

const MODEL_URL = 'https://huggingface.co/HRSadeghi/demucs-onnx/resolve/main/htdemucs_int8.onnx';
const SEGMENT = 343980;
const SOURCES = ['drums', 'bass', 'other', 'vocals'];

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
ort.env.wasm.numThreads = 1; // sem isolamento entre origens, o navegador não permite threads

let session = null;

async function loadModel() {
  if (session) return session;
  let buf = null;
  let cache = null;
  try { cache = await caches.open('cifras-modelos'); const hit = await cache.match(MODEL_URL); if (hit) buf = await hit.arrayBuffer(); } catch { /* sem cache */ }
  if (!buf) {
    const r = await fetch(MODEL_URL);
    if (!r.ok) throw new Error('não foi possível baixar o modelo (' + r.status + ')');
    const total = Number(r.headers.get('content-length')) || 84e6;
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      self.postMessage({ type: 'download', loaded: got, total });
    }
    const all = new Uint8Array(got);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    buf = all.buffer;
    try { await cache?.put(MODEL_URL, new Response(all, { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* cache cheio: segue sem guardar */ }
  }
  self.postMessage({ type: 'status', text: 'Preparando o modelo…' });
  session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return session;
}

self.onmessage = async (e) => {
  const { left, right, overlap = 0.1 } = e.data;
  try {
    const sess = await loadModel();
    const total = left.length;
    // normalização global (média e desvio da mistura mono), como no demucs
    let mean = 0;
    for (let i = 0; i < total; i++) mean += (left[i] + right[i]) / 2;
    mean /= total;
    let v = 0;
    for (let i = 0; i < total; i++) { const d = (left[i] + right[i]) / 2 - mean; v += d * d; }
    const gain = Math.sqrt(v / total) + 1e-8;

    const spectro = new Spectrogram(4096, 1024, SEGMENT);
    const weight = transitionWeight(SEGMENT);
    const chunks = planChunks(total, SEGMENT, overlap);
    // guardamos só o necessário, em mono: voz, baixo e "outros" (harmonia)
    const acc = { bass: new Float32Array(total), other: new Float32Array(total), vocals: new Float32Array(total) };
    const wsum = new Float32Array(total);
    const [inMix, inMag] = sess.inputNames.length === 2 && /mag|spec/i.test(sess.inputNames[0]) ? [sess.inputNames[1], sess.inputNames[0]] : sess.inputNames;
    const FT = spectro.F * spectro.T;
    const started = Date.now();

    for (let ci = 0; ci < chunks.length; ci++) {
      const ch = chunks[ci];
      const mixL = new Float32Array(SEGMENT), mixR = new Float32Array(SEGMENT);
      const lo = Math.max(0, ch.start), hi = Math.min(total, ch.start + SEGMENT);
      for (let i = lo; i < hi; i++) { mixL[i - ch.start] = (left[i] - mean) / gain; mixR[i - ch.start] = (right[i] - mean) / gain; }
      const mix = new Float32Array(2 * SEGMENT);
      mix.set(mixL, 0); mix.set(mixR, SEGMENT);
      const mag = spectro.forward([mixL, mixR]);
      const out = await sess.run({
        [inMix]: new ort.Tensor('float32', mix, [1, 2, SEGMENT]),
        [inMag]: new ort.Tensor('float32', mag, [1, 4, spectro.F, spectro.T]),
      });
      const tensors = Object.values(out);
      const specT = tensors.find((t) => t.dims.length === 5);
      const wavT = tensors.find((t) => t.dims.length === 4);
      const spec = specT.data, wav = wavT.data;
      for (const name of ['bass', 'other', 'vocals']) {
        const s = SOURCES.indexOf(name);
        const mono = new Float32Array(SEGMENT);
        for (let c = 0; c < 2; c++) {
          const base = ((s * 4) + 2 * c) * FT;
          const y = spectro.inverseChannel(spec, spec, base, base + FT);
          const wbase = (s * 2 + c) * SEGMENT;
          for (let i = 0; i < SEGMENT; i++) mono[i] += (y[i] + wav[wbase + i]) / 2;
        }
        const a = acc[name];
        for (let i = 0; i < ch.length; i++) a[ch.offset + i] += mono[ch.trim + i] * weight[i];
      }
      for (let i = 0; i < ch.length; i++) wsum[ch.offset + i] += weight[i];
      const elapsed = (Date.now() - started) / 1000;
      self.postMessage({ type: 'progress', done: ci + 1, total: chunks.length, eta: (elapsed / (ci + 1)) * (chunks.length - ci - 1) });
    }
    for (const name of Object.keys(acc)) {
      const a = acc[name];
      for (let i = 0; i < total; i++) a[i] = (a[i] / (wsum[i] || 1)) * gain;
    }
    self.postMessage({ type: 'done', stems: acc }, [acc.bass.buffer, acc.other.buffer, acc.vocals.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
