import { renderNotes, presetParams } from '../../lib/synth/render.js';
import { distort } from './songgen.js';
import * as H from '../../lib/audio/harmony.js';
const TYPES = { '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10] };
const near = (pc, c) => { let n = c - ((((c - pc) % 12) + 12) % 12); if (c - n > 6) n += 12; return n; };
const acc = Object.fromEntries(Object.keys(TYPES).map((t) => [t, new Array(12).fill(0)]));
const SR = 44100;
const seedSet = process.env.SET === 'b' ? [7, 25] : [5, 15, 35];
for (const pre of ['Guitarra de aço', 'Violão de náilon']) for (const [t, iv] of Object.entries(TYPES)) for (let root = 0; root < 12; root++) for (const g of seedSet) {
  // abertura de violão (como no gerador)
  const base = near(root, 45); const notes = [base]; let n = base; const pcs = iv.map((i) => (root + i) % 12);
  for (let k = 0; k < 5; k++) { let nx = n + 3; while (!pcs.includes(((nx % 12) + 12) % 12)) nx++; if (nx > 66) break; notes.push(nx); n = nx; }
  const ev = notes.flatMap((nn, i) => [{ type: 'note', note: nn, vel: 100, at: 0.05 + i * 0.012 }, { type: 'off', note: nn, at: 1.3 }]);
  const o = renderNotes({ engine: 'physical', params: presetParams('physical', pre), events: ev, seconds: 1.4, sampleRate: SR });
  const x = distort(o.L.map((v, i) => v + o.R[i]), g, SR);
  const { frames } = await H.analyzeSamples(x, SR);
  const c = new Array(12).fill(0);
  for (const f of frames) f.chroma.forEach((v, i) => { c[i] += v; });
  const nn = Math.hypot(...c) || 1;
  for (let i = 0; i < 12; i++) acc[t][i] += c[(i + root) % 12] / nn;
}
const out = {};
for (const [t, v] of Object.entries(acc)) { const n = Math.hypot(...v); out[t] = v.map((x) => +(x / n).toFixed(3)); }
console.log(JSON.stringify(out));
