// "Ouvidos" do agente: transforma um trecho de áudio num relatório que dá para ler (volume, distorção,
// graves/médios/agudos, reverb…) e, se pedido, compara com um timbre guardado e sugere o que mexer.
import { mono } from '/lib/audio/io.js';
import { analyzeTone, BANDS } from '/lib/audio/tone.js';
import * as T from '/app/timbres/tone.js';

const db = (x) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -120);
const r1 = (v) => Math.round(v * 10) / 10;
const TIERS = ['limpo', 'quase saturando', 'crunch', 'distorcido', 'alto ganho'];

/** Volume: pico, RMS das partes com som, quanto tempo teve som e se saturou a entrada. */
export function levels(channels, sr) {
  let peak = 0, clip = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; if (a > 0.985) clip++; }
  const x = mono(channels), W = Math.round(sr * 0.05);
  let sum = 0, n = 0, active = 0;
  for (let f = 0; f + W <= x.length; f += W) {
    let e = 0;
    for (let i = f; i < f + W; i++) e += x[i] * x[i];
    e /= W;
    if (e > 1e-6) { sum += e; n++; active++; } // acima de -60 dBFS
  }
  return { duracao: r1(x.length / sr), segundosComSom: r1((active * W) / sr), picoDb: db(peak), rmsDb: n ? db(Math.sqrt(sum / n)) : -120, saturou: clip > sr * 0.002 };
}

/** Relatório completo. compare: um timbre guardado (registro de app/timbres/store.js). */
export async function hear(channels, sr, { instrument = 'guitar', compare = null, mix = false } = {}) {
  const lv = levels(channels, sr);
  if (mix) { // mixagem inteira: volume e equilíbrio de frequências, sem "timbre de instrumento"
    if (lv.segundosComSom < 0.3) return { ...lv, sinal: false, dica: 'A mixagem saiu em silêncio.' };
    const f = await analyzeTone(mono(channels), sr);
    return { ...lv, sinal: true, ...(lv.saturou ? { aviso: 'A mixagem chegou a 0 dB (pode ter distorção digital): baixe volumes no mixer.' } : {}), compressao: Math.round(f.compression * 100), curva: Object.fromEntries(BANDS.map((b, i) => [b >= 1000 ? `${b / 1000}k` : String(b), r1(f.curve[i])])) };
  }
  if (lv.segundosComSom < 0.8) return { ...lv, sinal: false, dica: 'Quase nada de som chegou. Confira se o instrumento está tocando e o volume da pedaleira.' };
  const f = await analyzeTone(mono(channels), sr);
  const m = T.macrosFromFeatures(f, instrument);
  const tier = T.tierOf(m.gain / 100);
  const out = {
    ...lv, sinal: true,
    descricao: T.describe(m),
    distorcao: { valor: m.gain, faixa: TIERS[tier] },
    equalizacao: { graves: m.bass, medios: m.mid, agudos: m.treble, presenca: m.presence, unidade: 'dB em relação a um(a) ' + (instrument === 'bass' ? 'baixo' : 'guitarra') + ' típico(a) numa mixagem' },
    reverb: { quantidade: m.reverb, duracaoSegundos: r1(f.reverb.rt) },
    compressao: Math.round(f.compression * 100),
    curva: Object.fromEntries(BANDS.map((b, i) => [b >= 1000 ? `${b / 1000}k` : String(b), r1(f.curve[i])])),
  };
  if (lv.saturou) out.aviso = 'O sinal saturou a entrada do computador (pico perto de 0 dB): baixe o volume do preset para medir melhor.';
  else if (lv.rmsDb < -40) out.aviso = 'O sinal está bem baixo; a análise de distorção e reverb fica menos confiável.';
  if (compare) {
    const want = compare.features?.curve ? T.macrosFromFeatures(compare.features, compare.instrument || instrument) : compare.macros;
    const d = (a, b) => r1(a - b);
    const diff = { distorcao: d(m.gain, want.gain), graves: d(m.bass, want.bass), medios: d(m.mid, want.mid), agudos: d(m.treble, want.treble), presenca: d(m.presence, want.presence), reverb: d(m.reverb, want.reverb) };
    const tips = [];
    if (Math.abs(diff.distorcao) >= 8) tips.push(diff.distorcao > 0 ? 'mais distorcido que o alvo: baixe o Gain do amp (ou desligue o drive)' : 'mais limpo que o alvo: suba o Gain do amp');
    for (const [k, label, knob] of [['graves', 'graves', 'Bass'], ['medios', 'médios', 'Middle'], ['agudos', 'agudos', 'Treble'], ['presenca', 'presença', 'Pres/EQ 4 kHz']]) {
      if (Math.abs(diff[k]) >= 2.5) tips.push(`${label} ${Math.abs(diff[k])} dB ${diff[k] > 0 ? 'acima' : 'abaixo'} do alvo (${knob})`);
    }
    if (Math.abs(diff.reverb) >= 15) tips.push(diff.reverb > 0 ? 'reverb demais: baixe o Mix do reverb' : 'reverb de menos: suba o Mix do reverb');
    out.comparacao = { timbre: compare.name, diferenca: diff, sugestoes: tips.length ? tips : ['Bem parecido com o alvo.'], positivo: 'positivo = acima do alvo' };
  }
  return out;
}
