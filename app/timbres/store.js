// Timbres guardados: usados pela seção Timbres e pelos agentes de IA.
import { syncedStore, mergeArrays, mergeTombs } from '/lib/core/sync.js';

export const S = syncedStore('timbres', 'timbres.v1', { tones: [], prefs: {}, deleted: {} }, (a, b) => {
  const deleted = mergeTombs(a.deleted, b.deleted);
  return { tones: mergeArrays(a.tones, b.tones, deleted, (t) => t.updatedAt || t.date || 0), prefs: { ...b.prefs, ...a.prefs }, deleted };
});
export const db = S.data;
export const getTone = (id) => db.tones.find((t) => t.id === id);
export function deleteTone(id) {
  db.tones = db.tones.filter((t) => t.id !== id);
  db.deleted[id] = Date.now();
}
