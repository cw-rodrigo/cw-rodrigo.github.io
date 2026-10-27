// Parte "complexa" do HTDemucs que fica fora do grafo ONNX: STFT/ISTFT, janelas e divisão em trechos.
// Portado de demucs-onnx (Hamidreza Sadeghi, licença MIT), que reproduz HTDemucs._spec/_ispec.
import { fft as fftInPlace } from '../audio/fft.js';

/** Índice "reflect" do numpy (sem repetir a borda). */
function reflectIndex(i, n) {
  if (n === 1) return 0;
  const period = 2 * (n - 1);
  i = ((i % period) + period) % period;
  return i < n ? i : period - i;
}

export class Spectrogram {
  constructor(nfft, hop, length) {
    this.nfft = nfft; this.hop = hop; this.length = length;
    this.F = nfft / 2;
    this.T = Math.ceil(length / hop);
    this.pad = (hop / 2) * 3;
    this.right = this.pad + this.T * hop - length;
    this.padded = length + this.pad + this.right;
    this.totalFrames = 1 + Math.floor(this.padded / hop); // T + 4
    this.window = new Float64Array(nfft).map((_, i) => 0.5 * (1 - Math.cos((2 * Math.PI * i) / nfft)));
    this.scale = 1 / Math.sqrt(nfft);
    this.offset = nfft / 2 + this.pad;
    this.outLen = nfft + hop * (this.totalFrames - 1);
    const env = new Float64Array(this.outLen);
    for (let t = 0; t < this.totalFrames; t++) for (let k = 0; k < nfft; k++) env[t * hop + k] += this.window[k] * this.window[k];
    this.env = env;
    this.re = new Float64Array(nfft);
    this.im = new Float64Array(nfft);
  }

  /** x: Float32Array (um canal, `length` amostras) -> escreve real/imag em out (planos pr, pi de [F*T]). */
  forwardChannel(x, outRe, outIm) {
    const { nfft, hop, length, pad, F, T, re, im, window: w, scale } = this;
    // posição p no sinal duplamente acolchoado -> índice no original
    const half = nfft / 2;
    const padded1 = length + pad + this.right;
    const src = (p) => {
      const q = reflectIndex(p - half, padded1); // desfaz o 2º acolchoamento
      return x[reflectIndex(q - pad, length)]; // desfaz o 1º
    };
    const start = 2 * hop;
    for (let t = 0; t < T; t++) {
      const s0 = start + t * hop;
      for (let k = 0; k < nfft; k++) { re[k] = src(s0 + k) * w[k]; im[k] = 0; }
      fftInPlace(re, im);
      for (let f = 0; f < F; f++) { outRe[f * T + t] = re[f] * scale; outIm[f * T + t] = im[f] * scale; }
    }
  }

  /** Espectrograma CaC [2C, F, T] para os canais dados. */
  forward(channels) {
    const { F, T } = this;
    const out = new Float32Array(channels.length * 2 * F * T);
    const pr = new Float32Array(F * T), pi = new Float32Array(F * T);
    channels.forEach((x, c) => {
      this.forwardChannel(x, pr, pi);
      out.set(pr, (2 * c) * F * T);
      out.set(pi, (2 * c + 1) * F * T);
    });
    return out;
  }

  /** De volta para onda: planos real/imag [F*T] -> Float32Array(length). */
  inverseChannel(specRe, specIm, reOff = 0, imOff = 0) {
    const { nfft, hop, F, T, totalFrames, re, im, window: w, length, offset, env, outLen } = this;
    const out = new Float64Array(outLen);
    const isc = Math.sqrt(nfft) / nfft; // irfft (1/n) * sqrt(n)
    for (let tt = 0; tt < totalFrames; tt++) {
      const t = tt - 2;
      if (t < 0 || t >= T) continue; // quadros removidos são zero
      re.fill(0); im.fill(0);
      for (let f = 0; f < F; f++) { re[f] = specRe[reOff + f * T + t]; im[f] = specIm[imOff + f * T + t]; }
      im[0] = 0; // irfft ignora a parte imaginária do DC
      for (let f = 1; f < F; f++) { re[nfft - f] = re[f]; im[nfft - f] = -im[f]; }
      // IFFT via conjugado
      for (let k = 0; k < nfft; k++) im[k] = -im[k];
      fftInPlace(re, im);
      const base = tt * hop;
      for (let k = 0; k < nfft; k++) out[base + k] += re[k] * isc * w[k];
    }
    const wav = new Float32Array(length);
    for (let i = 0; i < length; i++) wav[i] = out[offset + i] / env[offset + i];
    return wav;
  }
}

/** Janela triangular de transição entre trechos (igual à do demucs). */
export function transitionWeight(segment) {
  const w = new Float32Array(segment);
  const h = Math.floor(segment / 2);
  let max = 0;
  for (let i = 0; i < segment; i++) { w[i] = i < h ? i + 1 : segment - i; if (w[i] > max) max = w[i]; }
  for (let i = 0; i < segment; i++) w[i] /= max;
  return w;
}

/** Trechos a processar: [{ offset, length, start, trim }]. */
export function planChunks(total, segment, overlap = 0.25) {
  const stride = Math.max(1, Math.floor((1 - overlap) * segment));
  const chunks = [];
  for (let offset = 0; offset < total; offset += stride) {
    const length = Math.min(total - offset, segment);
    const delta = segment - length;
    chunks.push({ offset, length, start: offset - Math.floor(delta / 2), trim: Math.floor(delta / 2) });
  }
  return chunks;
}
