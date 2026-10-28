// Dados do Cifras (músicas, listas, rascunhos de edição em lote): usados pela seção e pelos agentes de IA.
import * as M from '/lib/music/theory.js';
import { syncedStore, mergeMaps, mergeArrays, mergeTombs } from '/lib/core/sync.js';
import { uid } from '/lib/core/ui.js';

export const DEF = { songs: {}, lists: [], drafts: {}, prefs: {}, deleted: {} };
export const S = syncedStore('cifras', 'cifras.v1', DEF, (a, b) => {
  const deleted = mergeTombs(a.deleted, b.deleted);
  const lists = mergeArrays(a.lists, b.lists, deleted, (l) => l.updatedAt || l.createdAt || 0);
  const drafts = Object.fromEntries(Object.entries({ ...b.drafts, ...a.drafts }).filter(([id]) => lists.some((l) => l.id === id)));
  return { songs: mergeMaps(a.songs, b.songs, deleted), lists, drafts, prefs: { ...b.prefs, ...a.prefs }, deleted };
});
export const db = S.data;
export const save = () => S.save();
export const touch = (list) => { list.updatedAt = Date.now(); };

export const getList = (id) => db.lists.find((l) => l.id === id);
export const getSong = (id) => db.songs[id];
export const songKey = (s) => (s ? M.normalizeKey(s.key) || '' : '');
export const shiftedKey = (s, shift) => (songKey(s) ? M.transposeKey(songKey(s), shift) : '');
export function keyLabel(s, shift) {
  const k = shiftedKey(s, shift);
  if (k) return k;
  return shift ? (shift > 0 ? `+${shift}` : `${shift}`) : '?';
}
export const transposedContent = (song, shift) => M.transposeChordPro(song.content || '', shift, shiftedKey(song, shift));
export const wrap = (n) => ((((n + 6) % 12) + 12) % 12) - 6;

export function newSong(data) {
  const s = { id: uid(), title: '', artist: '', ytId: '', key: '', bpm: 80, content: '', melody: '', createdAt: Date.now(), ...data };
  s.updatedAt = Date.now();
  db.songs[s.id] = s;
  return s;
}
export function newList(name) {
  const l = { id: uid(), name: name || 'Nova lista', items: [], createdAt: Date.now(), updatedAt: Date.now() };
  db.lists.unshift(l);
  return l;
}
/** Itens da lista considerando o rascunho da edição em lote, se houver. */
export const itemsOf = (list) => (db.drafts[list.id] ? db.drafts[list.id].items : list.items);
export function deleteSong(id) {
  delete db.songs[id];
  db.deleted[id] = Date.now();
  for (const l of db.lists) if (l.items.some((x) => x.songId === id)) { l.items = l.items.filter((x) => x.songId !== id); touch(l); }
  for (const d of Object.values(db.drafts)) d.items = d.items.filter((x) => x.songId !== id);
}

