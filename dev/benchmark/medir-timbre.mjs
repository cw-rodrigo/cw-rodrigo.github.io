import { analyzeTone } from '../../lib/audio/tone.js';
import * as G from './guitarras.mjs';
const rows = [];
function lp(x, fc) { const w = 2 * Math.PI * fc / G.SR, a = Math.sin(w) / 1.414, c = Math.cos(w); const b0 = (1 - c) / 2, b1 = 1 - c, b2 = b0, a0 = 1 + a, a1 = -2 * c, a2 = 1 - a; const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; }
for (const seed of [Number(process.argv[2])]) for (const st of ['strum', 'muted', 'lead']) for (const pre of ['Guitarra de aço', 'Violão de náilon']) {
  const dry = G.playing(st, seed, 12, pre);
  for (const g of [0, 1.5, 3, 6, 12, 25, 50, 80]) {
    const d = G.drive(dry, g);
    for (const [rt, mix] of [[0, 0], [1, 0.3], [2.5, 0.35]]) for (const eq of [6000, 3500]) {
      const x = G.reverb(lp(G.cab(d), eq), rt, mix);
      const f = await analyzeTone(x, G.SR);
      rows.push({ seed, st, pre, g, rt, eq, flat: f.parts.flatness, crest: f.parts.crest, spread: f.parts.spread, rvAmt: f.reverb.amount, rvRt: f.reverb.rt, hiCrest: f.parts.hiCrest, sustain: f.parts.sustain });
    }
  }
  console.error(seed, st, pre);
}
console.log(JSON.stringify(rows));
