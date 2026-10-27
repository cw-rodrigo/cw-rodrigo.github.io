// Ajuste fino com a pedaleira no circuito: ouve a saída USB da Pocket Master enquanto você toca,
// compara com a música e corrige o equalizador e o ganho aos poucos.
import { Recorder, mono, getInput, listInputs } from '/lib/audio/io.js';
import { analyzeTone, curveMean } from '/lib/audio/tone.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const bandFreq = (name) => { const m = /([\d.]+)\s*(k?)hz/i.exec(name); return m ? parseFloat(m[1]) * (m[2] ? 1000 : 1) : null; };

export { listInputs };
export function guessPedalInput(inputs) {
  return inputs.find((d) => /pocket|sonicake|qme/i.test(d.label)) || inputs.find((d) => /usb/i.test(d.label)) || null;
}

/**
 * opts: { deviceId, target (medidas da música), getSpec(), setParam(block, name, value), send(), onUpdate(info) }
 * Retorna { stop() }.
 */
export async function startRefine(opts) {
  const stream = await getInput(opts.deviceId);
  const rec = new Recorder();
  let level = 0, skip = 0, busy = false, stopped = false, rounds = 0;
  let chunk = [];
  const STEP_SECONDS = 4;
  await rec.start(stream, {
    onLevel: (l) => { level = l; opts.onUpdate({ level }); },
    shouldKeep: () => level > 0.003,
    keep: false,
    onBlock: (L, R) => {
      if (stopped) return;
      if (skip > 0) { skip--; return; }
      chunk.push(mono([L, R]));
      const n = chunk.reduce((k, c) => k + c.length, 0);
      if (n >= STEP_SECONDS * rec.sampleRate && !busy) {
        const all = new Float32Array(n);
        let o = 0;
        for (const c of chunk) { all.set(c, o); o += c.length; }
        chunk = [];
        busy = true;
        step(all).finally(() => { busy = false; });
      }
    },
  });

  async function step(samples) {
    let f;
    try { f = await analyzeTone(samples, rec.sampleRate); } catch { return; }
    if (stopped) return;
    const spec = opts.getSpec();
    const t = opts.target;
    const eq = spec.blocks.eq;
    const diffs = [];
    const changes = [];
    for (const [name, val] of Object.entries(eq.params)) {
      const fc = bandFreq(name);
      if (!fc) continue;
      const d = curveMean(t.curve, fc / 1.41, fc * 1.41) - curveMean(f.curve, fc / 1.41, fc * 1.41);
      diffs.push({ fc, d });
      const next = Math.round(clamp(val + clamp(0.6 * d * 3, -12, 12), -50, 50));
      if (next !== val) changes.push(['eq', name, next]);
    }
    if (!eq.on) changes.push(['eq', '__on', 1]);
    const dG = t.gain - f.gain;
    const amp = spec.blocks.amp;
    const gName = Object.keys(amp.params).find((n) => n === 'Gain' || n === 'Gain 1');
    if (gName && Math.abs(dG) > 0.06) changes.push(['amp', gName, Math.round(clamp(amp.params[gName] + clamp(dG * 50, -10, 10), 0, 100))]);
    for (const [b, n, v] of changes) opts.setParam(b, n, v);
    if (changes.length) { await opts.send(); skip = Math.ceil((0.5 * rec.sampleRate) / 4096); }
    rounds++;
    const err = diffs.reduce((s, x) => s + Math.abs(x.d), 0) / Math.max(1, diffs.length);
    opts.onUpdate({ round: rounds, curve: f.curve, gain: f.gain, eqError: err, gainError: dG, changed: changes.length });
  }

  return {
    stop() { stopped = true; rec.stop(); },
  };
}
