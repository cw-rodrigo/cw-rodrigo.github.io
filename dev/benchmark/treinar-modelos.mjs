// Aprende modelos de acorde (cromagrama esperado) renderizando acordes com o sintetizador.
import { renderNotes, presetParams } from '../../lib/synth/render.js';
import * as H from '../../lib/audio/harmony.js';
const ENGS = process.env.ENGS === 'other'
  ? [['subtractive', 'Supersaw'], ['wavetable', 'Órgão que cresce'], ['am', 'Tremolo vintage'], ['additive', 'Coral de senos'], ['pd', 'Ressonante'], ['fm', 'Brass FM'], ['subtractive', 'Metais sintéticos'], ['physical', 'Guitarra de aço']]
  : [['physical', 'Violão de náilon'], ['physical', 'Guitarra de aço'], ['fm', 'Piano elétrico (DX)'], ['subtractive', 'Pad quente'], ['additive', 'Órgão de tubos'], ['pd', 'Strings CZ'], ['fm', 'Órgão FM'], ['wavetable', 'PWM pad'], ['subtractive', 'Supersaw'], ['additive', 'Coral de senos']];
const TYPES = { '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10] };
const near = (pc, c) => { let n = c - ((((c - pc) % 12) + 12) % 12); if (c - n > 6) n += 12; return n; };
const acc = Object.fromEntries(Object.keys(TYPES).map((t) => [t, new Array(12).fill(0)]));
const SR = 44100;
for (const [eng, pre] of ENGS) for (const [t, iv] of Object.entries(TYPES)) for (let root = 0; root < 12; root++) for (const style of ['close', 'spread', 'bass']) {
  const center = style === 'close' ? 60 + (root % 5) : 52 + (root % 7);
  let notes = iv.map((i) => near((root + i) % 12, center));
  if (style !== 'close') notes.push(near(root, 45));
  const ev = notes.flatMap((n) => [{ type: 'note', note: n, vel: 90, at: 0.05 }, { type: 'off', note: n, at: 1.3 }]);
  const o = renderNotes({ engine: eng, params: presetParams(eng, pre), events: ev, seconds: 1.4, sampleRate: SR });
  const x = o.L.map((v, i) => v + o.R[i]);
  if (style === 'bass') {
    const b = renderNotes({ engine: 'subtractive', params: { ...presetParams('subtractive', 'Baixo analógico'), mono: true }, events: [{ type: 'note', note: near(root, 38), vel: 100, at: 0.05 }, { type: 'off', note: near(root, 38), at: 1.3 }], seconds: 1.4, sampleRate: SR });
    let pa = 0, pb = 0; for (let i = 0; i < x.length; i++) { pa = Math.max(pa, Math.abs(x[i])); pb = Math.max(pb, Math.abs(b.L[i])); }
    for (let i = 0; i < x.length; i++) x[i] += b.L[i] * (pa / pb) * 0.8;
  }
  const { frames } = await H.analyzeSamples(x, SR);
  const c = new Array(12).fill(0);
  for (const f of frames) f.chroma.forEach((v, i) => { c[i] += v; });
  const n = Math.hypot(...c) || 1;
  for (let i = 0; i < 12; i++) acc[t][i] += c[(i + root) % 12] / n;
}
const out = {};
for (const [t, v] of Object.entries(acc)) { const n = Math.hypot(...v); out[t] = v.map((x) => +(x / n).toFixed(3)); }
console.log(JSON.stringify(out));
