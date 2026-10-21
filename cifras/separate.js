// Ponte para o worker de separação de faixas (HTDemucs).

let worker = null;

/** Converte para 44,1 kHz estéreo, o formato do modelo. */
export async function to44kStereo(channels, sampleRate) {
  const L = channels[0];
  const R = channels[1] || channels[0];
  if (sampleRate === 44100) return [L, R];
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const len = Math.ceil((L.length * 44100) / sampleRate);
  const off = new OAC(2, len, 44100);
  const buf = off.createBuffer(2, L.length, sampleRate);
  buf.copyToChannel(L, 0);
  buf.copyToChannel(R, 1);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}

/**
 * Separa voz, baixo e "outros" (harmonia). Retorna { vocals, bass, other } em mono 44,1 kHz.
 * onStatus(texto, fração 0..1)
 */
export async function separate(channels, sampleRate, onStatus = () => {}) {
  onStatus('Preparando o áudio…', 0);
  const [left, right] = await to44kStereo(channels, sampleRate);
  worker ||= new Worker(new URL('./separate-worker.js?v=11', import.meta.url), { type: 'module' });
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
    worker.onerror = (err) => { worker?.terminate(); worker = null; reject(new Error(err.message || 'Falha ao iniciar a separação.')); };
    worker.postMessage({ left: new Float32Array(left), right: new Float32Array(right), overlap: 0.1 });
  });
}
