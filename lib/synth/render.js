// Renderização do sintetizador fora do AudioWorklet (JavaScript puro: roda no navegador e no Node).
// Usa exatamente os mesmos motores do instrumento, então o som é o mesmo da página.
import { FACTORIES } from './engines/index.js';
import { defaults } from './schemas.js';
import { dbToGain } from './dsp.js';
import { PRESETS } from './presets.js';

/** Parâmetros de um preset de fábrica pelo nome (ou {} se não existir). */
export function presetParams(engine, name) {
  return structuredClone((PRESETS[engine] || []).find((p) => p.name === name)?.params || {});
}

/**
 * Renderiza notas. events: [{ type: 'note'|'off', note, vel, at (segundos) }].
 * Retorna { L, R } (Float32Array) com `seconds` de duração.
 */
export function renderNotes({ engine, params = {}, events, seconds, sampleRate = 44100, shared = {} }) {
  const eng = (FACTORIES[engine] || FACTORIES.subtractive)(sampleRate, { zones: [], grain: null, ...shared });
  const p = { ...defaults(engine), ...params };
  eng.setParams(p);
  const n = Math.ceil(seconds * sampleRate);
  const L = new Float32Array(n), R = new Float32Array(n);
  const evs = [...events].sort((a, b) => a.at - b.at);
  let pos = 0;
  const BLOCK = 128;
  for (const ev of evs) {
    const f = Math.min(n, Math.max(pos, Math.round(ev.at * sampleRate)));
    while (pos < f) { const e = Math.min(f, pos + BLOCK); eng.render(L, R, pos, e); pos = e; }
    if (ev.type === 'note') eng.noteOn(ev.note, ev.vel ?? 100);
    else if (ev.type === 'off') eng.noteOff(ev.note);
    else if (ev.type === 'bend') eng.setBend(ev.value);
  }
  while (pos < n) { const e = Math.min(n, pos + BLOCK); eng.render(L, R, pos, e); pos = e; }
  const g = dbToGain(p.vol ?? -8);
  for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  return { L, R };
}
