// Projeto da DAW no modelo do FL Studio (e do LMMS):
//  - canais (Channel Rack): instrumentos do sintetizador, cada um mandando para um insert do mixer;
//  - padrões (patterns): as notas de cada canal, editadas no sequenciador de passos ou no piano roll;
//  - playlist: faixas livres com clipes de padrão, de áudio (gravações, arquivos) e de automação;
//  - mixer: inserts com efeitos em slots, envios e a entrada de gravação (ex.: a Pocket Master).
// Também: gravação no IndexedDB, áudio (gravações e arquivos), desfazer/refazer e projetos antigos.
import { idb } from '/lib/core/idb.js';
import { uid } from '/lib/core/ui.js';
import { defaults as synthDefaults } from '/lib/synth/schemas.js';

export const COLORS = ['#4c8dff', '#f0883e', '#3fb950', '#d2a8ff', '#ff7b72', '#39c5cf', '#e3b341', '#a5d6ff', '#ffa198', '#7ee787'];
export const VERSION = 2;
export const STEP = 0.25; // um passo do sequenciador = 1/16 (um quarto de tempo)
/** De onde grava: 'pocket' (acha a entrada USB da pedaleira), 'default' (microfone), um deviceId, ou 'notes' (só notas). */
export const REC_DEFAULT = { source: 'pocket', channel: 'stereo', monitor: false, pmSlot: null };

// ---------------------------------------------------------------- criação
export function newInsert(p, name, extra = {}) {
  const n = p.mixer.inserts.length;
  return {
    id: uid(), name: name || `Insert ${n}`, color: COLORS[(n + 3) % COLORS.length],
    vol: 0, pan: 0, mute: false, solo: false, fx: [], sends: [],
    ...extra,
  };
}

/** Canal do Channel Rack. kind: 'synth'. stepNote = a nota que os passos tocam. */
export function newChannel(p, name, synth = { engine: 'subtractive' }, extra = {}) {
  const ins = newInsert(p, name);
  p.mixer.inserts.push(ins);
  return {
    id: uid(), name, color: COLORS[p.channels.length % COLORS.length],
    synth: { params: {}, fx: { reverbMix: 0, delayMix: 0 }, source: null, ...synth },
    vol: 0, pan: 0, mute: false, insert: ins.id, stepNote: 60,
    ...extra,
  };
}

export function newPattern(p, name) {
  const n = p.patterns.length + 1;
  return { id: uid(), name: name || `Padrão ${n}`, color: COLORS[(n + 5) % COLORS.length], len: p.sig, notes: {} };
}

export function newPlaylistTrack(p) {
  return { id: uid(), name: `Faixa ${p.playlist.tracks.length + 1}`, mute: false };
}

/** Projeto novo, como o modelo básico do FL: bumbo, palmas, chimbal, caixa, baixo e um teclado. */
export function newProject(name = 'Meu projeto') {
  const p = {
    id: uid(), name, version: VERSION, created: Date.now(), updated: Date.now(),
    bpm: 120, sig: 4, mode: 'pattern', rec: { ...REC_DEFAULT }, snap: STEP, zoom: 24, metro: false, countIn: false,
    loop: { on: false, start: 0, end: 16 }, latencyMs: null, recQuantize: 0,
    channels: [], patterns: [], curPattern: null,
    playlist: { tracks: [], clips: [] },
    mixer: { inserts: [] },
  };
  p.mixer.inserts.push(newInsert(p, 'Master', { id: 'master', color: '#9aa0a6', fx: [{ type: 'limiter', on: true, params: {} }] })); // como o FL: limitador no master
  const drums = (nm, note) => newChannel(p, nm, { engine: 'drums', params: {} }, { stepNote: note });
  p.channels.push(drums('Bumbo', 36), drums('Palmas', 39), drums('Chimbal', 42), drums('Caixa', 38));
  p.channels.push(newChannel(p, 'Baixo', { engine: 'subtractive', params: { mono: true, o1Oct: -1, cutoff: 900, res: 0.3, aeS: 0.9 } }, { stepNote: 36 }));
  p.channels.push(newChannel(p, 'Teclado', { engine: 'fm', params: {} }, { stepNote: 60 }));
  // insert pronto para gravar a Pocket Master pela entrada USB dela
  p.mixer.inserts.push(newInsert(p, 'Gravações'));
  for (let i = 0; i < 6; i++) p.playlist.tracks.push(newPlaylistTrack(p));
  const pat = newPattern(p);
  p.patterns.push(pat);
  p.curPattern = pat.id;
  // um compasso de exemplo, como o FL abre: bumbo nos tempos e chimbal nos contratempos
  pat.notes[p.channels[0].id] = [0, 4, 8, 12].map((s) => ({ p: 36, t: s * STEP, d: STEP, v: 110 }));
  pat.notes[p.channels[2].id] = [2, 6, 10, 14].map((s) => ({ p: 42, t: s * STEP, d: STEP, v: 80 }));
  return p;
}

// ---------------------------------------------------------------- consultas
export const spb = (p) => 60 / p.bpm;
export const channelOf = (p, id) => p.channels.find((c) => c.id === id) || null;
export const patternOf = (p, id) => p.patterns.find((x) => x.id === id) || null;
export const insertOf = (p, id) => p.mixer.inserts.find((x) => x.id === id) || null;
export const masterOf = (p) => p.mixer.inserts[0];
export const curPattern = (p) => patternOf(p, p.curPattern) || p.patterns[0] || null;

/** Comprimento do padrão (em tempos): o definido, ou mais se houver notas depois dele (como o FL). */
export function patternLength(p, pat) {
  let end = 0;
  for (const list of Object.values(pat.notes)) for (const n of list) end = Math.max(end, n.t + n.d);
  return Math.max(pat.len || p.sig, Math.ceil(end / p.sig - 1e-6) * p.sig);
}
/** Comprimento do clipe em tempos (o de áudio guarda segundos: não muda de duração se o BPM mudar). */
export const clipLen = (p, c) => (c.kind === 'audio' ? c.dur / spb(p) : c.len);
export const clipEnd = (p, c) => c.start + clipLen(p, c);
export function songEnd(p) {
  let end = 0;
  for (const c of p.playlist.clips) end = Math.max(end, clipEnd(p, c));
  return end;
}

export function fmtPos(p, beat) {
  const neg = beat < 0;
  const b = Math.abs(beat);
  const bar = Math.floor(b / p.sig), bt = Math.floor(b % p.sig), tick = Math.floor((b % 1) * 100);
  return `${neg ? '-' : ''}${bar + 1}.${bt + 1}.${String(tick).padStart(2, '0')}`;
}
export function fmtTime(sec) {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor((s % 1) * 10))}`;
}

/** Notas do canal no padrão "são passos" (todas no tamanho de 1/16, na grade e na nota do passo)? */
export function isStepPattern(ch, notes = []) {
  return notes.every((n) => n.p === ch.stepNote && Math.abs(n.d - STEP) < 1e-6 && Math.abs(n.t / STEP - Math.round(n.t / STEP)) < 1e-6);
}

/** Primeira faixa da playlist livre entre as batidas a e b (cria uma nova se precisar). */
export function freeTrack(p, a, b, prefer = null) {
  const busy = (t) => p.playlist.clips.some((c) => c.track === t.id && c.start < b && clipEnd(p, c) > a);
  const tracks = prefer ? [p.playlist.tracks.find((t) => t.id === prefer), ...p.playlist.tracks].filter(Boolean) : p.playlist.tracks;
  let t = tracks.find((x) => !busy(x));
  if (!t) { t = newPlaylistTrack(p); p.playlist.tracks.push(t); }
  return t;
}

// ---------------------------------------------------------------- áudio
const bufCache = new Map(); // id -> { buffer, peaks, sampleRate, channels }
/** Guarda canais de áudio e devolve o id. */
export async function saveAudio(channels, sampleRate, name = '') {
  const id = uid();
  await idb.put('audio', { id, channels, sampleRate, name, created: Date.now() });
  return id;
}
/** AudioBuffer (no contexto dado) + picos para desenhar a forma de onda. */
export async function loadAudio(ctx, id) {
  if (bufCache.has(id)) return bufCache.get(id);
  const rec = await idb.get('audio', id);
  if (!rec) return null;
  const buffer = ctx.createBuffer(rec.channels.length, rec.channels[0].length, rec.sampleRate);
  rec.channels.forEach((c, i) => buffer.copyToChannel(c, i));
  const entry = { buffer, peaks: peaksOf(rec.channels, rec.sampleRate), sampleRate: rec.sampleRate, channels: rec.channels, name: rec.name };
  bufCache.set(id, entry);
  return entry;
}
export function cachedAudio(id) { return bufCache.get(id) || null; }
/** Picos a cada ~5 ms (máximo absoluto), para a forma de onda. */
function peaksOf(channels, sr) {
  const step = Math.max(1, Math.round(sr * 0.005));
  const n = Math.ceil(channels[0].length / step);
  const pk = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); const k = (i / step) | 0; if (a > pk[k]) pk[k] = a; }
  return { data: pk, step: step / sr };
}

// ---------------------------------------------------------------- projetos
export async function listProjects() {
  const all = await idb.all('projects');
  return all.map((p) => ({ id: p.id, name: p.name, updated: p.updated, size: (p.channels || p.tracks || []).length })).sort((a, b) => b.updated - a.updated);
}
export async function loadProject(id) { const p = await idb.get('projects', id); return p ? upgrade(p) : null; }
export async function saveProject(p) { p.updated = Date.now(); await idb.put('projects', structuredClone(p)); }
/** Apaga o projeto e os áudios que só ele usava. */
export async function deleteProject(id) {
  const all = await idb.all('projects');
  const used = new Set(all.filter((p) => p.id !== id).flatMap((p) => audioIdsOf(p)));
  const mine = all.find((p) => p.id === id);
  for (const a of mine ? audioIdsOf(mine) : []) if (!used.has(a)) await idb.del('audio', a);
  await idb.del('projects', id);
}
export function audioIdsOf(p) {
  const ids = [];
  for (const c of p.playlist?.clips || []) if (c.audioId) ids.push(c.audioId);
  for (const t of p.tracks || []) for (const c of t.clips) if (c.audioId) ids.push(c.audioId); // projeto antigo
  for (const ch of p.channels || []) if (ch.synth?.source?.kind === 'sample' && ch.synth.source.audioId) ids.push(ch.synth.source.audioId);
  return ids;
}

// arquivo do projeto (com os áudios dentro) para levar a outro aparelho
const f32ToB64 = (a) => { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const b64ToF32 = (b) => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new Float32Array(u.buffer); };
export async function exportProjectFile(p) {
  const audio = {};
  for (const id of new Set(audioIdsOf(p))) {
    const rec = await idb.get('audio', id);
    if (rec) audio[id] = { sampleRate: rec.sampleRate, name: rec.name, channels: rec.channels.map(f32ToB64) };
  }
  return JSON.stringify({ app: 'estudio-daw', version: VERSION, project: p, audio });
}
export async function importProjectFile(text) {
  const d = JSON.parse(text);
  if (d.app !== 'estudio-daw' || !d.project) throw new Error('Esse arquivo não é um projeto da DAW.');
  for (const [id, a] of Object.entries(d.audio || {})) await idb.put('audio', { id, sampleRate: a.sampleRate, name: a.name, channels: a.channels.map(b64ToF32) });
  const p = upgrade({ ...d.project, id: uid(), name: d.project.name + ' (importado)' });
  await saveProject(p);
  return p;
}

// ---------------------------------------------------------------- versões antigas
/**
 * Projeto da primeira versão (faixas com clipes) -> modelo novo:
 * faixa de instrumento vira canal (os clipes MIDI viram padrões na playlist);
 * faixa de áudio vira insert do mixer (com a entrada e o EQ/reverb dela) e os clipes vão para a playlist.
 */
export function upgrade(old) {
  if (old.version >= VERSION) return fill(old);
  const p = newProject(old.name);
  Object.assign(p, { id: old.id, created: old.created || Date.now(), bpm: old.bpm || 120, sig: old.sig || 4, mode: 'song', metro: !!old.metro, countIn: !!old.countIn, latencyMs: old.latencyMs ?? null, recQuantize: old.recQuantize || 0, zoom: old.zoom || 24, snap: old.snap || STEP });
  p.loop = { on: false, start: 0, end: 16, ...(old.loop || {}) };
  p.channels = []; p.patterns = []; p.playlist = { tracks: [], clips: [] };
  p.mixer.inserts = [p.mixer.inserts[0]];
  p.mixer.inserts[0].vol = old.master?.vol || 0;
  const eqFx = (t) => (t.eq && (t.eq.low || t.eq.mid || t.eq.high) ? [{ type: 'eq', on: true, params: { low: t.eq.low, mid: t.eq.mid, high: t.eq.high } }] : []);
  for (const t of old.tracks || []) {
    const track = { id: uid(), name: t.name, mute: false };
    p.playlist.tracks.push(track);
    if (t.kind === 'inst') {
      const ch = newChannel(p, t.name, { ...(t.synth || { engine: 'subtractive' }) }, { color: t.color });
      const ins = insertOf(p, ch.insert);
      Object.assign(ins, { vol: t.vol || 0, pan: t.pan || 0, mute: !!t.mute, solo: !!t.solo, fx: [...eqFx(t), ...(t.rev ? [{ type: 'reverb', on: true, params: { mix: t.rev } }] : [])] });
      p.channels.push(ch);
      for (const c of t.clips) {
        const pat = newPattern(p, `${t.name} ${p.patterns.length + 1}`);
        pat.len = c.len; pat.color = t.color;
        pat.notes[ch.id] = (c.notes || []).filter((n) => n.t < c.len).map((n) => ({ ...n }));
        p.patterns.push(pat);
        p.playlist.clips.push({ id: uid(), kind: 'pattern', track: track.id, start: c.start, len: c.len, pattern: pat.id });
      }
    } else {
      if (t.arm && t.input?.deviceId) p.rec = { ...p.rec, source: t.input.deviceId, channel: t.input.channel || 'stereo', pmSlot: t.pm?.slot ?? null };
      const ins = newInsert(p, t.name, { color: t.color, vol: t.vol || 0, pan: t.pan || 0, mute: !!t.mute, solo: !!t.solo, fx: [...eqFx(t), ...(t.rev ? [{ type: 'reverb', on: true, params: { mix: t.rev } }] : [])] });
      p.mixer.inserts.push(ins);
      for (const c of t.clips) p.playlist.clips.push({ id: uid(), kind: 'audio', track: track.id, start: c.start, dur: c.dur, audioId: c.audioId, offset: c.offset || 0, gain: c.gain || 0, insert: ins.id, name: c.name });
    }
  }
  while (p.playlist.tracks.length < 6) p.playlist.tracks.push(newPlaylistTrack(p));
  if (!p.patterns.length) p.patterns.push(newPattern(p));
  p.curPattern = p.patterns[0].id;
  return fill(p);
}
/** Completa campos que faltarem (projetos salvos por versões anteriores desta mesma estrutura). */
function fill(p) {
  const base = newProject(p.name);
  const q = { ...base, ...p, loop: { ...base.loop, ...(p.loop || {}) }, playlist: { tracks: [], clips: [], ...(p.playlist || {}) }, mixer: { inserts: [], ...(p.mixer || {}) } };
  if (!q.mixer.inserts.length) q.mixer.inserts = [base.mixer.inserts[0]];
  // versões anteriores armavam um insert com a entrada; agora a fonte de gravação é do projeto
  const armed = q.mixer.inserts.find((i) => i.arm && i.input);
  q.rec = { ...REC_DEFAULT, ...(p.rec || (armed ? { source: armed.input.match === 'pocket' && !armed.input.deviceId ? 'pocket' : armed.input.deviceId || 'default', channel: armed.input.channel || 'stereo', pmSlot: armed.pmSlot ?? null } : {})) };
  q.mixer.inserts = q.mixer.inserts.map(({ arm, input, pmSlot, ...i }) => ({ fx: [], sends: [], ...i }));
  q.channels = (q.channels || []).map((c) => ({ vol: 0, pan: 0, mute: false, stepNote: 60, ...c, synth: { params: {}, fx: {}, ...(c.synth || {}) } }));
  if (!q.patterns?.length) q.patterns = [newPattern(q)];
  if (!patternOf(q, q.curPattern)) q.curPattern = q.patterns[0].id;
  return q;
}
export const synthParamsOf = (ch) => ({ ...synthDefaults(ch.synth.engine), ...ch.synth.params });

// ---------------------------------------------------------------- desfazer
export class History {
  constructor() { this.undo = []; this.redo = []; }
  /** Guarda o estado ANTES de uma mudança. */
  push(p) { this.undo.push(JSON.stringify(p)); if (this.undo.length > 80) this.undo.shift(); this.redo = []; }
  back(p) { if (!this.undo.length) return null; this.redo.push(JSON.stringify(p)); return JSON.parse(this.undo.pop()); }
  fwd(p) { if (!this.redo.length) return null; this.undo.push(JSON.stringify(p)); return JSON.parse(this.redo.pop()); }
}
