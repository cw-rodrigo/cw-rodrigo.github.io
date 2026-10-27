// Separação de faixas com IA (HTDemucs) num worker: bateria, baixo, voz e "outros" (harmonia).
import { resample } from '../audio/io.js';

export const STEMS = { drums: 'Bateria', bass: 'Baixo', other: 'Harmonia e outros', vocals: 'Voz' };

let worker = null;

/**
 * Separa as faixas. Retorna { [nome]: Float32Array } em mono 44,1 kHz, só com as faixas pedidas
 * (padrão: baixo, outros e voz). onStatus(texto, fração 0..1)
 */
export async function separate(channels, sampleRate, onStatus = () => {}, { stems = ['bass', 'other', 'vocals'] } = {}) {
  onStatus('Preparando o áudio…', 0);
  const [left, right] = await resample(channels, sampleRate, 44100, 2);
  worker ||= new Worker(new URL('./separate-worker.js', import.meta.url), { type: 'module' });
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'download') onStatus(`Baixando o modelo de separação (só na primeira vez): ${Math.round((m.loaded / m.total) * 100)}% de ${Math.round(m.total / 1e6)} MB`, m.loaded / m.total);
      if (m.type === 'status') onStatus(m.text, 0);
      if (m.type === 'progress') onStatus(`Separando as faixas: parte ${m.done} de ${m.total}${m.done < m.total ? ` · falta cerca de ${mmss(m.eta)}` : ''}`, m.done / m.total);
      if (m.type === 'done') resolve(m.stems);
      if (m.type === 'error') { worker.terminate(); worker = null; reject(new Error(m.message)); }
    };
    worker.onerror = (err) => { worker?.terminate(); worker = null; reject(new Error(err.message || 'não consegui carregar a IA de separação; confira a conexão com a internet')); };
    worker.postMessage({ left: new Float32Array(left), right: new Float32Array(right), overlap: 0.1, stems });
  });
}
