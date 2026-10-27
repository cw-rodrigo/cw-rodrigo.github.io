// Clipes de automação (como no FL): uma curva de 0 a 1 ao longo do clipe controlando um parâmetro —
// volume ou pan de um canal ou insert, um parâmetro do sintetizador ou de um efeito do mixer.
// Alvos: 'ch:<id>:vol' | 'ch:<id>:pan' | 'ch:<id>:p:<param>' | 'ins:<id>:vol' | 'ins:<id>:pan' | 'ins:<id>:fx:<n>:<param>'
import { ENGINES, COMMON } from '/lib/synth/schemas.js';
import { FX } from './fx.js';

/** Volume: 0..1 -> ganho (0,707 = 0 dB, 1 = +6 dB), como o fader. */
export const normToGain = (v) => 2 * v * v;
export const gainToNorm = (g) => Math.sqrt(Math.max(0, g) / 2);
const dbToNorm = (db) => (db <= -60 ? 0 : gainToNorm(10 ** (db / 20)));

function rangeMap(def) {
  if (def.curve === 'log') return { to: (v) => def.min * (def.max / def.min) ** v, from: (x) => Math.log(x / def.min) / Math.log(def.max / def.min) };
  return { to: (v) => def.min + v * (def.max - def.min), from: (x) => (x - def.min) / (def.max - def.min) };
}
const synthParam = (engine, id) => [COMMON, ...(ENGINES[engine]?.groups || [])].flatMap((g) => g.params).find((x) => x.id === id && x.type === 'range');

/** Tudo o que dá para automatizar no projeto, agrupado (para o menu). */
export function targetsOf(p) {
  const out = [];
  for (const ch of p.channels) {
    const g = `Canal: ${ch.name}`;
    out.push({ id: `ch:${ch.id}:vol`, label: 'Volume', group: g }, { id: `ch:${ch.id}:pan`, label: 'Pan', group: g });
    for (const grp of ENGINES[ch.synth.engine]?.groups || []) for (const prm of grp.params) if (prm.type === 'range') out.push({ id: `ch:${ch.id}:p:${prm.id}`, label: `${grp.name} › ${prm.label}`, group: g });
  }
  for (const ins of p.mixer.inserts) {
    const g = `Mixer: ${ins.name}`;
    out.push({ id: `ins:${ins.id}:vol`, label: 'Volume', group: g }, { id: `ins:${ins.id}:pan`, label: 'Pan', group: g });
    ins.fx.forEach((f, n) => { for (const prm of FX[f.type].params) if (prm.type === 'range') out.push({ id: `ins:${ins.id}:fx:${n}:${prm.id}`, label: `${FX[f.type].name} › ${prm.label}`, group: g }); });
  }
  return out;
}

/**
 * Detalhes de um alvo: { kind, id (canal/insert), param, label, to(v 0..1) -> valor real, from(valor) -> 0..1, initial }.
 * null se o alvo não existe mais (canal ou efeito apagado).
 */
export function resolveTarget(p, target) {
  const [scope, id, what, a, b] = String(target).split(':');
  if (scope === 'ch') {
    const ch = p.channels.find((c) => c.id === id);
    if (!ch) return null;
    if (what === 'vol') return { kind: 'chVol', id, label: `${ch.name} › Volume`, to: normToGain, from: gainToNorm, initial: dbToNorm(ch.vol) };
    if (what === 'pan') return { kind: 'chPan', id, label: `${ch.name} › Pan`, to: (v) => v * 2 - 1, from: (x) => (x + 1) / 2, initial: (ch.pan + 1) / 2 };
    const def = what === 'p' && synthParam(ch.synth.engine, a);
    if (!def) return null;
    const m = rangeMap(def);
    return { kind: 'chParam', id, param: a, label: `${ch.name} › ${def.label}`, to: m.to, from: m.from, initial: m.from(ch.synth.params[a] ?? def.def) };
  }
  if (scope === 'ins') {
    const ins = p.mixer.inserts.find((i) => i.id === id);
    if (!ins) return null;
    if (what === 'vol') return { kind: 'insVol', id, label: `${ins.name} › Volume`, to: normToGain, from: gainToNorm, initial: dbToNorm(ins.vol) };
    if (what === 'pan') return { kind: 'insPan', id, label: `${ins.name} › Pan`, to: (v) => v * 2 - 1, from: (x) => (x + 1) / 2, initial: (ins.pan + 1) / 2 };
    const f = what === 'fx' && ins.fx[Number(a)];
    const def = f && FX[f.type].params.find((x) => x.id === b && x.type === 'range');
    if (!def) return null;
    const m = rangeMap(def);
    return { kind: 'insFx', id, fx: Number(a), param: b, label: `${ins.name} › ${FX[f.type].name} › ${def.label}`, to: m.to, from: m.from, initial: m.from(f.params?.[b] ?? def.def) };
  }
  return null;
}

/** Valor da curva (0..1) num instante do clipe (em tempos), ligando os pontos em linha reta. */
export function valueAt(points, t) {
  if (!points.length) return 0.5;
  if (t <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].t) {
      const a = points[i - 1], b = points[i];
      return b.t === a.t ? b.v : a.v + ((t - a.t) / (b.t - a.t)) * (b.v - a.v);
    }
  }
  return points[points.length - 1].v;
}
