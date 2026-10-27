import { makeSong } from './songgen.js';
import fs from 'fs';
fs.mkdirSync('songs', { recursive: true });
const [a, b] = process.argv.slice(2).map(Number);
for (let seed = a; seed <= b; seed++) {
  const t0 = Date.now();
  const s = makeSong({ seed, ...(process.env.DETUNE ? { detune: (seed % 2 ? 1 : -1) * (25 + (seed * 7) % 21) } : {}) });
  const mono = new Float32Array(s.L.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (s.L[i] + s.R[i]) / 2;
  fs.writeFileSync(`songs/${seed}.f32`, Buffer.from(mono.buffer));
  fs.writeFileSync(`songs/${seed}.json`, JSON.stringify({ ...s.truth, desc: s.desc, sr: s.sampleRate }));
  let pk = 0, nan = 0; for (const v of mono) { if (Number.isNaN(v)) nan++; pk = Math.max(pk, Math.abs(v)); }
  console.log(seed, s.desc, ((Date.now() - t0) / 1000).toFixed(1) + 's', 'len', (mono.length / 44100).toFixed(1), 'nan', nan);
}
