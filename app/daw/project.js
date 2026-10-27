// Projeto da DAW: modelo de dados, gravação no IndexedDB, desfazer/refazer e áudio (gravações e arquivos).
import { idb } from '/lib/core/idb.js';
import { uid } from '/lib/core/ui.js';

export const COLORS = ['#4c8dff', '#f0883e', '#3fb950', '#d2a8ff', '#ff7b72', '#39c5cf', '#e3b341', '#a5d6ff', '#ffa198', '#7ee787'];

export function newProject(name = 'Projeto sem nome') {
  return {
    id: uid(), name, created: Date.now(), updated: Date.now(),
    bpm: 120, sig: 4, loop: { on: false, start: 0, end: 16 }, metro: true, countIn: false,
    snap: 0.25, zoom: 24, master: { vol: 0 }, latencyMs: null, recQuantize: 0,
    tracks: [],
  };
}

export function newTrack(p, kind, extra = {}) {
  const n = p.tracks.filter((t) => t.kind === kind).length + 1;
  return {
    id: uid(), kind, name: kind === 'audio' ? `Áudio ${n}` : `Instrumento ${n}`, color: COLORS[p.tracks.length % COLORS.length],
    vol: 0, pan: 0, mute: false, solo: false, arm: false, eq: { low: 0, mid: 0, high: 0 }, rev: 0,
    input: { deviceId: '', channel: 'stereo', monitor: false }, pm: { slot: null },
    synth: kind === 'inst' ? { engine: 'subtractive', params: {}, fx: { reverbMix: 0 } } : null,
    clips: [],
    ...extra,
  };
}

export const spb = (p) => 60 / p.bpm;
export const clipEnd = (p, c) => c.start + (c.len != null ? c.len : c.dur / spb(p));
export function songEnd(p) {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(p, c));
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

// ---------------------------------------------------------------- áudio
const bufCache = new Map(); // id -> { buffer, peaks }
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
  const entry = { buffer, peaks: peaksOf(rec.channels, rec.sampleRate), sampleRate: rec.sampleRate, channels: rec.channels };
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
  return all.map((p) => ({ id: p.id, name: p.name, updated: p.updated, tracks: p.tracks.length })).sort((a, b) => b.updated - a.updated);
}
export const loadProject = (id) => idb.get('projects', id);
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
  for (const t of p.tracks) {
    for (const c of t.clips) if (c.audioId) ids.push(c.audioId);
    if (t.synth?.source?.kind === 'sample' && t.synth.source.audioId) ids.push(t.synth.source.audioId);
  }
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
  return JSON.stringify({ app: 'estudio-daw', version: 1, project: p, audio });
}
export async function importProjectFile(text) {
  const d = JSON.parse(text);
  if (d.app !== 'estudio-daw' || !d.project) throw new Error('Esse arquivo não é um projeto da DAW.');
  for (const [id, a] of Object.entries(d.audio || {})) await idb.put('audio', { id, sampleRate: a.sampleRate, name: a.name, channels: a.channels.map(b64ToF32) });
  const p = { ...d.project, id: uid(), name: d.project.name + ' (importado)' };
  await saveProject(p);
  return p;
}

// ---------------------------------------------------------------- desfazer
export class History {
  constructor() { this.undo = []; this.redo = []; }
  /** Guarda o estado ANTES de uma mudança. */
  push(p) { this.undo.push(JSON.stringify(p)); if (this.undo.length > 80) this.undo.shift(); this.redo = []; }
  back(p) { if (!this.undo.length) return null; this.redo.push(JSON.stringify(p)); return JSON.parse(this.undo.pop()); }
  fwd(p) { if (!this.redo.length) return null; this.undo.push(JSON.stringify(p)); return JSON.parse(this.redo.pop()); }
}
