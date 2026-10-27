// Transforma as medidas do áudio em ajustes "de músico" (ganho, graves, médios…)
// e esses ajustes num preset completo da Pocket Master.
import { BANDS, curveMean, curveAt } from './analyze.js?v=1';
import { DEFAULT_CHAIN } from './pm.js?v=1';

// Curvas típicas (dB por faixa de BANDS) de uma guitarra e de um baixo numa mixagem.
const REF = {
  guitar: [-14, -9, -6, -4, -2.5, -1.5, -0.5, 0.5, 1, 1.5, 1.5, 1.5, 1, 0.5, -0.5, -1.5, -3, -4.5, -6.5, -9, -12, -16, -22],
  bass: [4, 5, 5, 4, 3, 2, 1.5, 1, 0.5, 0, -0.5, -1, -2, -3, -4, -5, -6.5, -8, -10, -13, -16, -20, -26],
};
function normRef(r) {
  const ref = r.filter((_, i) => BANDS[i] >= 250 && BANDS[i] <= 4000);
  const m = ref.reduce((a, b) => a + b, 0) / ref.length;
  return r.map((v) => v - m);
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);

/** Diferença entre a curva da música e a curva típica do instrumento (dB por faixa). */
export function deviation(curve, instrument = 'guitar') {
  const ref = normRef(REF[instrument] || REF.guitar);
  return curve.map((v, i) => clamp(v - ref[i], -18, 18));
}
export function referenceCurve(instrument = 'guitar') { return normRef(REF[instrument] || REF.guitar); }

/** Ajustes iniciais a partir da análise. */
export function macrosFromFeatures(f, instrument = 'guitar') {
  const dev = deviation(f.curve, instrument);
  const r1 = (v) => Math.round(clamp(v, -12, 12) * 2) / 2;
  let reverb = f.reverb.rt < 0.22 ? 0 : Math.round(clamp(f.reverb.amount * 100 + 10, 0, 100));
  if (instrument === 'bass') reverb = reverb > 50 ? Math.round(reverb / 3) : 0; // baixo quase sempre vai seco
  return {
    instrument,
    gain: Math.round(f.gain * 100),
    bass: r1(curveMean(dev, 80, 250)),
    mid: r1(curveMean(dev, 400, 1200)),
    treble: r1(curveMean(dev, 1800, 4500)),
    presence: r1(curveMean(dev, 4500, 8000)),
    reverb,
    reverbType: 'auto',
    rt: Math.round(f.reverb.rt * 10) / 10,
    delay: 'off',
    delayMix: 20,
    bpm: f.bpm || 100,
    mod: 'off',
    comp: instrument === 'bass' ? f.compression > 0.3 : f.compression > 0.5 && f.gain < 0.42,
    dev,
  };
}

// faixas de ganho -> amplificadores
const TIERS = [
  { max: 0.22, name: 'limpo', knob: [10, 30] },
  { max: 0.42, name: 'quase saturando', knob: [35, 60] },
  { max: 0.62, name: 'crunch', knob: [45, 70] },
  { max: 0.8, name: 'distorcido', knob: [50, 75] },
  { max: 1.01, name: 'alto ganho', knob: [55, 82] },
];
export function tierOf(g) { return TIERS.findIndex((t) => g < t.max); }

function pickAmp(m) {
  const g = m.gain / 100;
  if (m.instrument === 'bass') return g < 0.45 ? { amp: 'A BassVT', ir: null } : { amp: 'A BassVT', ir: null, drive: 'Bass Drive' };
  const t = tierOf(g);
  const bright = m.treble + m.presence / 2;
  if (t === 0) return bright < -2 ? { amp: 'Jazz 120', ir: 'Jazz 2x12' } : { amp: 'Dark Twin', ir: 'TWD 2x12' };
  if (t === 1) return bright > 1 ? { amp: 'Voks 30TB', ir: 'Voks 1x12' } : { amp: 'TWD Deluxe', ir: 'TWD-P 1x10' };
  if (t === 2) return m.bass > 2 ? { amp: 'Brit 50JP', ir: 'BritGN 4x12' } : { amp: 'Brit 45', ir: 'BritGN 2x12' };
  if (t === 3) return { amp: 'Brit 800', ir: 'BritGN 4x12', drive: g > 0.72 ? 'Scream' : null };
  if (m.mid < -2) return { amp: 'Calif DualM', ir: 'Dual 4x12', drive: 'Scream' };
  if (bright > 2) return { amp: 'Dizzy VH', ir: 'Dizzy 4x12', drive: 'Scream' };
  return { amp: 'Eng 120', ir: 'Bog 4x12', drive: 'Scream' };
}

function reverbModel(m) {
  if (m.reverbType && m.reverbType !== 'auto') return m.reverbType;
  const rt = m.rt || 0.8;
  if (m.instrument !== 'bass' && m.gain < 30 && rt < 1.2 && rt > 0.5) return 'Spring';
  return rt < 0.5 ? 'Room' : rt < 1.2 ? 'Plate 1' : rt < 2.5 ? 'Hall' : 'Church';
}

const MOD = {
  chorus: { model: 'A-Chorus', params: { Depth: 45, Rate: 0.8, Tone: 50 } },
  phaser: { model: 'Phaser', params: { Rate: 0.6 } },
  flanger: { model: 'Flanger', params: { Depth: 50, Rate: 0.3, 'P.Delay': 50, 'F.Back': 40 } },
  tremolo: { model: 'Tremolo', params: { Depth: 60, Rate: 4 } },
  vibe: { model: 'Vibe', params: { Depth: 50, Rate: 1.2 } },
  vibrato: { model: 'Vibrato', params: { Depth: 30, Rate: 4 } },
  octave: { model: 'Octave', params: { Low: 50, High: 0, Dry: 60 } },
};
export const MOD_OPTIONS = [['off', 'Nenhuma'], ['chorus', 'Chorus'], ['phaser', 'Phaser'], ['flanger', 'Flanger'], ['tremolo', 'Tremolo'], ['vibe', 'Vibe'], ['vibrato', 'Vibrato'], ['octave', 'Oitavador']];
export const DELAY_OPTIONS = [['off', 'Desligado'], ['slap', 'Curto (slapback)'], ['tempo', 'No tempo: colcheia pontuada'], ['quarter', 'No tempo: semínima'], ['long', 'Longo e ambiente']];
export const REVERB_OPTIONS = [['auto', 'Automático'], ['Room', 'Sala (Room)'], ['Spring', 'Mola (Spring)'], ['Plate 1', 'Placa (Plate)'], ['Hall', 'Salão (Hall)'], ['Church', 'Igreja (Church)'], ['Air', 'Air'], ['Dream', 'Dream']];

/** Ajustes -> preset completo (formato dos arquivos de timbre do pocket-master-mcp). */
export function buildSpec(m, map) {
  const g = m.gain / 100;
  const t = tierOf(g);
  const pick = pickAmp(m);
  const knob = (dev, k = 2) => Math.round(clamp(50 + k * dev, 10, 90));
  const blocks = {};
  const model = (key, name) => (map.models[key] || []).find((x) => x.name === name);

  // amplificador: ganho dentro da faixa e os controles de tom
  const amp = model('amp', pick.amp);
  const tier = m.instrument === 'bass' ? { knob: [15, 70] } : TIERS[t];
  const lo = t > 0 ? TIERS[t - 1].max : 0;
  const local = m.instrument === 'bass' ? g : (g - lo) / (TIERS[t].max - lo);
  const gainKnob = Math.round(lerp(tier.knob[0], tier.knob[1], local));
  const ap = {};
  for (const p of amp.params) {
    const n = p.name;
    if (n === 'Gain' || n === 'Gain 1') ap[n] = gainKnob;
    else if (n === 'Gain 2') ap[n] = Math.round(gainKnob * 0.8);
    else if (n === 'Bass') ap[n] = knob(m.bass);
    else if (n === 'Middle') ap[n] = knob(m.mid);
    else if (n === 'Treble') ap[n] = knob(m.treble);
    else if (n === 'Pres') ap[n] = knob(m.presence);
    else if (n === 'Tone') ap[n] = knob(m.treble, 3);
    else if (n === 'Tone Cut') ap[n] = knob(-m.treble, 3);
    else if (n === 'Bright') ap[n] = m.treble > 1 ? 1 : 0;
    else if (n === 'Char') ap[n] = g > 0.3 ? 1 : 0;
    else if (n === 'Vol') ap[n] = 50;
    else ap[n] = p.default;
  }
  blocks.amp = { model: amp.name, on: true, params: ap };
  blocks.ir = pick.ir ? { model: pick.ir, on: true, params: { Vol: 50 } } : { model: 'Dual 4x12', on: false, params: { Vol: 50 } };

  // o resto da curva vai para o equalizador gráfico
  const dev = m.dev || [];
  const fixDev = (f, base) => (dev.length ? curveAt(dev, f) : 0) * 0.5 + base * 0.5;
  if (m.instrument === 'bass') {
    const bands = { '50Hz': fixDev(50, m.bass), '120Hz': fixDev(120, m.bass), '400Hz': fixDev(400, m.mid), '800Hz': fixDev(800, m.mid), '4.5kHz': fixDev(4500, m.treble) };
    const eq = Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, Math.round(clamp(v * 2.1, -40, 40))]));
    blocks.eq = { model: 'Bass EQ', on: Object.values(eq).some((v) => Math.abs(v) >= 6), params: { ...eq, Vol: 50 } };
  } else {
    const bands = { '125Hz': fixDev(125, m.bass), '400Hz': fixDev(400, m.mid), '800Hz': fixDev(800, m.mid), '1.6kHz': fixDev(1600, (m.mid + m.treble) / 2), '4kHz': fixDev(4000, m.presence) };
    const eq = Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, Math.round(clamp(v * 2.1, -40, 40))]));
    blocks.eq = { model: 'GT EQ 1', on: Object.values(eq).some((v) => Math.abs(v) >= 6), params: { ...eq, Vol: 50 } };
  }

  // pedal de drive (só para apertar o som nos ganhos altos)
  if (pick.drive === 'Scream') blocks.drv = { model: 'Scream', on: true, params: { Gain: t >= 4 ? 10 : 25, Tone: knob(m.treble), Vol: 75 } };
  else if (pick.drive === 'Bass Drive') blocks.drv = { model: 'Bass Drive', on: true, params: { Gain: Math.round(lerp(20, 80, (g - 0.45) / 0.55)), Blend: 50, Vol: 50, Bass: knob(m.bass), Treble: knob(m.treble) } };
  else blocks.drv = { model: 'Scream', on: false, params: { Gain: 40, Tone: 70, Vol: 50 } };

  blocks.nr = { model: 'Gate', on: g > 0.6, params: { THRE: Math.round(lerp(25, 55, (g - 0.6) / 0.4)) } };
  blocks.fx1 = m.comp ? { model: 'COMP 1', on: true, params: { Sustain: 40, Vol: 55 } } : { model: 'COMP 1', on: false, params: { Sustain: 20, Vol: 50 } };
  const mod = MOD[m.mod];
  blocks.fx2 = mod ? { model: mod.model, on: true, params: { ...mod.params } } : { model: 'A-Chorus', on: false, params: { Depth: 50, Rate: 0.5, Tone: 50 } };

  // delay
  const beat = 60000 / (m.bpm || 100);
  const mix = Math.round(m.delayMix ?? 20);
  const dly = {
    slap: { model: 'Slap', params: { Mix: mix + 5, Time: 110, 'F.Back': 5 } },
    tempo: { model: 'Analog', params: { Mix: mix, Time: Math.round(clamp(beat * 0.75, 20, 1000)), 'F.Back': 30 } },
    quarter: { model: 'Analog', params: { Mix: mix, Time: Math.round(clamp(beat, 20, 1000)), 'F.Back': 30 } },
    long: { model: 'Pure', params: { Mix: mix, Time: Math.round(clamp(beat * 1.5, 20, 1000)), 'F.Back': 45 } },
  }[m.delay];
  blocks.dly = dly ? { ...dly, on: true } : { model: 'Pure', on: false, params: { Mix: 20, Time: 500, 'F.Back': 30 } };

  // reverb
  const rvName = reverbModel(m);
  const rvm = model('rvb', rvName) || model('rvb', 'Room');
  const rp = {};
  for (const p of rvm.params) {
    if (p.name === 'Mix') rp.Mix = Math.round(lerp(8, 45, m.reverb / 100));
    else if (p.name === 'Decay') rp.Decay = Math.round(clamp(20 + 25 * (m.rt || 0.8), 15, 90));
    else rp[p.name] = p.default;
  }
  blocks.rvb = { model: rvm.name, on: m.reverb >= 8, params: rp };

  return { chain: [...DEFAULT_CHAIN], amp_mode: 'normal', preset_volume: 60, blocks };
}

/** Aplica ajustes manuais (parâmetro a parâmetro) por cima do preset gerado. */
export function withOverrides(spec, ov = {}) {
  const out = structuredClone(spec);
  for (const [key, o] of Object.entries(ov.blocks || {})) {
    const b = out.blocks[key] || (out.blocks[key] = { params: {} });
    if (o.model && o.model !== b.model) { b.model = o.model; b.params = { ...(o.params || {}) }; }
    else if (o.params) b.params = { ...b.params, ...o.params };
    if (o.on != null) b.on = o.on;
  }
  if (ov.preset_volume != null) out.preset_volume = ov.preset_volume;
  return out;
}

/** Frase curta descrevendo o timbre. */
export function describe(m) {
  const t = m.instrument === 'bass' ? (m.gain < 45 ? 'Baixo limpo' : 'Baixo com drive') : ['Timbre limpo', 'Timbre quase saturando', 'Timbre crunch', 'Timbre distorcido', 'Timbre de alto ganho'][tierOf(m.gain / 100)];
  const w = (v, low, high) => (v <= -3 ? low : v >= 3 ? high : null);
  const bits = [w(m.bass, 'poucos graves', 'graves cheios'), w(m.mid, 'médios cavados', 'médios na frente'), w(m.treble, 'agudos suaves', 'agudos brilhantes')].filter(Boolean);
  const rv = m.reverb < 8 ? 'quase sem reverb' : m.reverb < 35 ? 'reverb discreto' : m.reverb < 65 ? 'reverb médio' : 'bastante reverb';
  return `${t}${bits.length ? ', com ' + bits.join(', ') : ''}; ${rv}${m.comp ? ', comprimido' : ''}.`;
}
