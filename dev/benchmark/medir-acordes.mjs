// Mede a cifragem automática nas músicas sintéticas. uso: node bench.mjs [modulo-harmony] [a-b]
import fs from 'fs';
import * as M from '../../lib/music/theory.js';
const modPath = process.argv[2] || new URL('../../lib/audio/harmony.js', import.meta.url).href;
const [a, b] = (process.argv[3] || '1-60').split('-').map(Number);
const H = await import(modPath);

const pc = (n) => M.noteIndex(n);
function parse(name) {
  if (!name || name === 'N') return null;
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(name);
  if (!m) return null;
  const q = m[2];
  const minor = /^m(?!aj)/.test(q);
  const seventh = /7/.test(q);
  return { root: pc(m[1]), minor, seventh, q, bass: m[3] ? pc(m[3]) : pc(m[1]) };
}
const tot = { mm: 0, root: 0, exact: 0, bass: 0, n: 0, key: 0, keyRel: 0, songs: 0 };
const rows = [];
for (let s = a; s <= b; s++) {
  if (!fs.existsSync(`songs/${s}.f32`)) continue;
  const buf = fs.readFileSync(`songs/${s}.f32`);
  const x = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const T = JSON.parse(fs.readFileSync(`songs/${s}.json`));
  const { frames, hop } = await H.analyzeSamples(x, T.sr);
  const res = H.framesToChords(frames, { hop });
  const k = M.parseKey(res.key);
  const keyOk = k && k.root === T.tonic && k.minor === T.minor;
  const rel = k && !keyOk && ((k.minor && !T.minor && M.mod12(k.root + 3) === T.tonic) || (!k.minor && T.minor && M.mod12(T.tonic + 3) === k.root));
  let mm = 0, root = 0, ex = 0, bs = 0, n = 0; globalThis.CONF ||= {};
  for (const c of T.segments) {
    for (let t = c.start + 0.05; t < c.end; t += 0.1) {
      const seg = res.segments.find((g) => t >= g.start && t < g.end);
      const p = parse(seg?.chord);
      n++;
      if (!p) continue;
      const tm = c.type === 'm' || c.type === 'm7', t7 = c.type.includes('7');
      { const tm2 = c.type === 'm' || c.type === 'm7'; const key = !p ? 'N' : `${M.mod12(p.root - c.root)}${tm2 ? 'm' : 'M'}->${p.minor ? 'm' : 'M'}${c.bass !== c.root ? ' inv' : ''}`; if (!p || p.root !== c.root || p.minor !== tm2) CONF[key] = (CONF[key] || 0) + 1; }
      if (p.root === c.root) { root++; if (p.minor === tm) { mm++; if (p.seventh === t7) ex++; } }
      if (p.bass === c.bass) bs++;
    }
  }
  tot.mm += mm; tot.root += root; tot.exact += ex; tot.bass += bs; tot.n += n; tot.key += keyOk ? 1 : 0; tot.keyRel += rel ? 1 : 0; tot.songs++;
  rows.push(`${String(s).padStart(2)} ${(100 * mm / n).toFixed(0).padStart(3)}% key ${keyOk ? 'ok ' : rel ? 'rel' : 'NO '} ${res.key.padEnd(4)} truth ${M.keyName(T.tonic, T.minor).padEnd(4)} ${T.tuning}c | ${T.desc}`);
}
if (process.env.V) console.log(rows.join('\n'));
if (process.env.C) console.log(Object.entries(CONF).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k}:${v}`).join('  '));
const p = (v) => (100 * v / tot.n).toFixed(1) + '%';
console.log(`songs ${tot.songs} | maj/min ${p(tot.mm)} | root ${p(tot.root)} | exact(7ths) ${p(tot.exact)} | bass ${p(tot.bass)} | key ${tot.key}/${tot.songs} (+${tot.keyRel} relative)`);
