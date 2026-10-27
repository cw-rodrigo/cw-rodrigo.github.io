// Uma conexão com a Pocket Master para o site todo (continua conectada ao trocar de seção)
// e as cópias de segurança dos presets (salvas no navegador e na conta).
import { PocketMaster, loadMap, midiSupported, slotLabel, cleanName } from './pm.js';
import { syncedStore, mergeArrays, mergeTombs } from '../core/sync.js';
import { uid } from '../core/ui.js';

export { midiSupported, slotLabel };

export const backupStore = syncedStore('pocketmaster', 'pocketmaster.v1', { backups: [], deleted: {} }, (a, b) => {
  const deleted = mergeTombs(a.deleted, b.deleted);
  return { ...a, deleted, backups: mergeArrays(a.backups, b.backups, deleted, (x) => x.date || 0).sort((x, y) => y.date - x.date) };
});

// cópias que ficavam no Timbres antigo passam para cá
(() => {
  try {
    const old = JSON.parse(localStorage.getItem('timbres.v1') || 'null');
    if (old?.backups?.length && !backupStore.data.backups.length) {
      backupStore.data.backups = old.backups.map((b) => ({ id: uid(), ...b }));
      backupStore.save();
    }
  } catch { /* nada a migrar */ }
})();

let pm = null;
let connecting = null;
const listeners = new Set();
function emit(type, data) { listeners.forEach((fn) => fn(type, data)); }

/** Eventos: 'connect', 'disconnect', 'preset', 'knob', 'state', 'names'. */
export function onDevice(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function device() { return pm?.connected ? pm : null; }
export function map() { return loadMap(); }

export async function connect() {
  if (pm?.connected) return pm;
  connecting ||= (async () => {
    const m = await loadMap();
    const p = new PocketMaster(m);
    await p.connect();
    p.on((type, data) => {
      if (type === 'disconnect') { pm = null; emit('disconnect'); return; }
      emit(type, data);
    });
    pm = p;
    emit('connect', p);
    return p;
  })();
  try { return await connecting; } finally { connecting = null; }
}

export function connectError(err) {
  if (err?.name === 'SecurityError' || err?.name === 'NotAllowedError') return 'Permissão para aparelhos MIDI negada. Libere nas configurações do site e tente de novo.';
  return err?.message || 'Não consegui conectar à pedaleira.';
}

/** Rótulo curto do preset atual: "P07 Nome". */
export function currentLabel() {
  if (!pm?.connected) return '';
  const i = pm.current;
  return i != null ? `${slotLabel(i)}${pm.names[i] ? ' ' + pm.names[i] : ''}` : 'conectada';
}

export function addBackup(slot, name, state) {
  const b = { id: uid(), slot, name, state, date: Date.now() };
  backupStore.data.backups.unshift(b);
  backupStore.data.backups = backupStore.data.backups.slice(0, 40);
  backupStore.save();
  return b;
}
export function removeBackup(id) {
  backupStore.data.backups = backupStore.data.backups.filter((b) => b.id !== id);
  backupStore.data.deleted = { ...backupStore.data.deleted, [id]: Date.now() };
  backupStore.save();
}

/**
 * Salva um timbre num preset do usuário, guardando antes uma cópia do que estava lá.
 */
export async function saveWithBackup(slot, name, spec) {
  const p = device();
  if (!p) throw new Error('A pedaleira não está conectada.');
  const old = p.names[slot] || '';
  const before = await p.select(slot);
  addBackup(slot, old || slotLabel(slot), before);
  await p.apply(spec);
  await p.save(slot, cleanName(name) || 'Timbre');
  emit('names', p.names);
  emit('preset', slot);
  return p;
}

export async function restoreBackup(b) {
  const p = device();
  if (!p) throw new Error('A pedaleira não está conectada.');
  await p.select(b.slot);
  await p.apply(b.state);
  await p.save(b.slot, b.name);
  emit('names', p.names);
  emit('preset', b.slot);
}
