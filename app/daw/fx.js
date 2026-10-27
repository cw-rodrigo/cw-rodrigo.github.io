// Efeitos dos slots do mixer (como os plugins "Fruity" do FL): cada um vira um pedaço do grafo do
// Web Audio. Os mesmos construtores servem para tocar e para exportar (OfflineAudioContext).

const r = (id, label, min, max, def, unit = '', extra = {}) => ({ id, label, type: 'range', min, max, def, step: extra.step ?? (max - min > 50 ? 1 : 0.01), unit, ...extra });
const sel = (id, label, options, def = 0) => ({ id, label, type: 'select', options, def });
const DELAY_TIMES = [['1/16', 0.25], ['1/8', 0.5], ['1/8 pontuada', 0.75], ['1/4', 1], ['1/4 pontuada', 1.5], ['1/2', 2]];

export const FX = {
  eq: { name: 'Equalizador', params: [r('low', 'Graves', -18, 18, 0, 'dB', { step: 0.5 }), r('lowF', 'Freq. dos graves', 40, 500, 120, 'Hz', { curve: 'log' }), r('mid', 'Médios', -18, 18, 0, 'dB', { step: 0.5 }), r('midF', 'Freq. dos médios', 200, 8000, 1000, 'Hz', { curve: 'log' }), r('q', 'Largura dos médios', 0.3, 6, 1), r('high', 'Agudos', -18, 18, 0, 'dB', { step: 0.5 }), r('highF', 'Freq. dos agudos', 2000, 16000, 6000, 'Hz', { curve: 'log' })] },
  filter: { name: 'Filtro', params: [sel('type', 'Tipo', ['Passa-baixa', 'Passa-alta', 'Passa-banda']), r('cutoff', 'Corte', 20, 20000, 2000, 'Hz', { curve: 'log' }), r('q', 'Ressonância', 0.1, 20, 0.7, '', { curve: 'log' })] },
  comp: { name: 'Compressor', params: [r('threshold', 'Limiar', -60, 0, -18, 'dB', { step: 0.5 }), r('ratio', 'Razão', 1, 20, 4, ':1', { step: 0.1 }), r('attack', 'Ataque', 0.001, 0.3, 0.01, 's', { curve: 'log', step: 0.001 }), r('release', 'Soltura', 0.02, 1, 0.2, 's', { curve: 'log', step: 0.01 }), r('makeup', 'Ganho', 0, 24, 3, 'dB', { step: 0.5 })] },
  dist: { name: 'Distorção', params: [r('drive', 'Drive', 0, 1, 0.4), r('tone', 'Tom', 500, 12000, 4000, 'Hz', { curve: 'log' }), r('mix', 'Mistura', 0, 1, 1)] },
  delay: { name: 'Delay', params: [sel('time', 'Tempo', DELAY_TIMES.map(([l]) => l), 2), r('feedback', 'Repetições', 0, 0.9, 0.35), r('tone', 'Tom', 800, 12000, 5000, 'Hz', { curve: 'log' }), r('mix', 'Mistura', 0, 1, 0.25)] },
  reverb: { name: 'Reverb', params: [r('size', 'Tamanho', 0.3, 8, 2, 's', { step: 0.1 }), r('predelay', 'Pré-atraso', 0, 0.2, 0.01, 's', { step: 0.005 }), r('tone', 'Tom', 1000, 16000, 7000, 'Hz', { curve: 'log' }), r('mix', 'Mistura', 0, 1, 0.25)] },
  chorus: { name: 'Chorus', params: [r('rate', 'Velocidade', 0.05, 5, 0.8, 'Hz', { curve: 'log' }), r('depth', 'Profundidade', 0, 1, 0.4), r('mix', 'Mistura', 0, 1, 0.5)] },
  limiter: { name: 'Limitador', params: [r('gain', 'Ganho', 0, 24, 0, 'dB', { step: 0.5 }), r('ceiling', 'Teto', -12, 0, -0.3, 'dB', { step: 0.1 })] },
};
export const FX_IDS = Object.keys(FX);
export const fxDefaults = (type) => Object.fromEntries(FX[type].params.map((p) => [p.id, p.def]));
const dbg = (db) => 10 ** (db / 20);

const irCache = new WeakMap();
/** Resposta de impulso sintética (ruído com queda exponencial), guardada por contexto e tamanho. */
function impulse(ctx, seconds) {
  let m = irCache.get(ctx);
  if (!m) irCache.set(ctx, (m = new Map()));
  const key = Math.round(seconds * 10);
  if (m.has(key)) return m.get(key);
  const len = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-6.9 * i) / len); }
  m.set(key, ir);
  return ir;
}
function shaperCurve(drive) {
  const k = 1 + drive * 60, n = 2048, c = new Float32Array(n), norm = Math.tanh(k);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
  return c;
}

/**
 * Cria o efeito. Retorna { input, output, set(params, bpm), at(paramId, valor, tempo, primeiro), dispose() }.
 * `at` agenda uma mudança suave (automação); parâmetros que não são AudioParam mudam na hora.
 */
export function makeFx(ctx, type, params0, bpm) {
  const params = { ...fxDefaults(type), ...params0 };
  const input = ctx.createGain(), output = ctx.createGain();
  const nodes = [];
  const mk = (n) => { nodes.push(n); return n; };
  let tempo = bpm || 120, jump = false;
  // t == null: muda agora (suave); com t: rampa até lá (automação); `jump` = começa um trecho novo
  const ramp = (param, v, t) => {
    if (t == null) param.setTargetAtTime(v, ctx.currentTime, 0.01);
    else if (jump) { param.cancelScheduledValues(t); param.setValueAtTime(v, t); } else param.linearRampToValueAtTime(v, t);
  };
  // mistura seco/molhado comum
  let dry = null, wet = null;
  const withMix = (proc, procOut) => {
    dry = mk(ctx.createGain()); wet = mk(ctx.createGain());
    input.connect(dry).connect(output);
    input.connect(proc); procOut.connect(wet).connect(output);
  };
  const setMix = (v, t) => { if (!dry) return; ramp(dry.gain, Math.cos((v * Math.PI) / 2), t); ramp(wet.gain, Math.sin((v * Math.PI) / 2), t); };
  let setters = {};

  if (type === 'eq') {
    const lo = mk(ctx.createBiquadFilter()), mid = mk(ctx.createBiquadFilter()), hi = mk(ctx.createBiquadFilter());
    lo.type = 'lowshelf'; mid.type = 'peaking'; hi.type = 'highshelf';
    input.connect(lo).connect(mid).connect(hi).connect(output);
    setters = { low: (v, t) => ramp(lo.gain, v, t), lowF: (v, t) => ramp(lo.frequency, v, t), mid: (v, t) => ramp(mid.gain, v, t), midF: (v, t) => ramp(mid.frequency, v, t), q: (v, t) => ramp(mid.Q, v, t), high: (v, t) => ramp(hi.gain, v, t), highF: (v, t) => ramp(hi.frequency, v, t) };
  } else if (type === 'filter') {
    const f = mk(ctx.createBiquadFilter());
    input.connect(f).connect(output);
    setters = { type: (v) => { f.type = ['lowpass', 'highpass', 'bandpass'][v] || 'lowpass'; }, cutoff: (v, t) => ramp(f.frequency, v, t), q: (v, t) => ramp(f.Q, v, t) };
  } else if (type === 'comp') {
    const c = mk(ctx.createDynamicsCompressor()), g = mk(ctx.createGain());
    input.connect(c).connect(g).connect(output);
    setters = { threshold: (v, t) => ramp(c.threshold, v, t), ratio: (v, t) => ramp(c.ratio, v, t), attack: (v) => { c.attack.value = v; }, release: (v) => { c.release.value = v; }, makeup: (v, t) => ramp(g.gain, dbg(v), t) };
  } else if (type === 'dist') {
    const pre = mk(ctx.createGain()), sh = mk(ctx.createWaveShaper()), lp = mk(ctx.createBiquadFilter()), post = mk(ctx.createGain());
    sh.oversample = '4x'; lp.type = 'lowpass'; post.gain.value = 0.7;
    pre.connect(sh).connect(lp).connect(post);
    withMix(pre, post);
    setters = { drive: (v) => { sh.curve = shaperCurve(v); }, tone: (v, t) => ramp(lp.frequency, v, t), mix: setMix };
  } else if (type === 'delay') {
    const d = mk(ctx.createDelay(4)), fb = mk(ctx.createGain()), lp = mk(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    d.connect(lp).connect(fb).connect(d);
    withMix(d, lp);
    setters = { time: (v) => { d.delayTime.setTargetAtTime((DELAY_TIMES[v]?.[1] || 1) * (60 / tempo), ctx.currentTime, 0.02); }, feedback: (v, t) => ramp(fb.gain, v, t), tone: (v, t) => ramp(lp.frequency, v, t), mix: setMix };
  } else if (type === 'reverb') {
    const pd = mk(ctx.createDelay(1)), conv = mk(ctx.createConvolver()), lp = mk(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    pd.connect(conv).connect(lp);
    withMix(pd, lp);
    let size = null;
    setters = { size: (v) => { if (v !== size) { size = v; conv.buffer = impulse(ctx, v); } }, predelay: (v, t) => ramp(pd.delayTime, v, t), tone: (v, t) => ramp(lp.frequency, v, t), mix: setMix };
  } else if (type === 'chorus') {
    const d = mk(ctx.createDelay(0.1)), lfo = mk(ctx.createOscillator()), depth = mk(ctx.createGain());
    d.delayTime.value = 0.015;
    lfo.connect(depth).connect(d.delayTime);
    lfo.start();
    withMix(d, d);
    setters = { rate: (v, t) => ramp(lfo.frequency, v, t), depth: (v, t) => ramp(depth.gain, v * 0.008, t), mix: setMix };
  } else if (type === 'limiter') {
    const g = mk(ctx.createGain()), c = mk(ctx.createDynamicsCompressor()), ceil = mk(ctx.createGain());
    c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.002; c.release.value = 0.08;
    input.connect(g).connect(c).connect(ceil).connect(output);
    setters = { gain: (v, t) => ramp(g.gain, dbg(v), t), ceiling: (v) => { c.threshold.value = v - 0.5; ceil.gain.value = 1; } };
  } else input.connect(output);

  const fx = {
    input, output,
    set(ps, newBpm) {
      if (newBpm) tempo = newBpm;
      for (const [k, v] of Object.entries({ ...fxDefaults(type), ...ps })) setters[k]?.(v);
    },
    /** Automação: valor `v` no instante `t`; first = primeiro ponto do trecho agendado. */
    at(id, v, t, first = false) { jump = first; setters[id]?.(v, t); jump = false; },
    dispose() { try { input.disconnect(); output.disconnect(); nodes.forEach((n) => { n.disconnect(); n.stop?.(); }); } catch { /* ok */ } },
  };
  fx.set(params, bpm);
  return fx;
}
