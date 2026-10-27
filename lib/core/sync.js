// Dados salvos no navegador que, com a conta conectada, também sincronizam com a nuvem.
// Cada app guarda um documento (JSON) por usuário; mudanças em aparelhos diferentes são mescladas
// item a item pelo horário da última alteração, e itens apagados viram "lápides" para não voltarem.
import * as C from './cloud.js';
import { toast } from './ui.js';

const stores = new Map();
const statusListeners = new Set();
let status = { state: C.user() ? 'idle' : 'off', at: null, error: null };
function setStatus(s) { status = { ...status, ...s }; statusListeners.forEach((fn) => fn(status)); }
export function syncStatus() { return status; }
export function onSyncStatus(fn) { statusListeners.add(fn); fn(status); return () => statusListeners.delete(fn); }

const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function replaceInPlace(target, src) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, structuredClone(src));
}

/**
 * Cria (ou devolve) o armazenamento de um app.
 * merge(local, remoto) -> mesclado. Os dois têm o mesmo formato de `defaults`.
 */
export function syncedStore(app, key, defaults, merge) {
  if (stores.has(app)) return stores.get(app);
  const metaKey = key + '.sync';
  const data = { ...structuredClone(defaults), ...(readJSON(key) || {}) };
  let meta = readJSON(metaKey) || { user: null, syncedAt: null, dirty: false };
  const listeners = new Set();
  let timer = null, chain = Promise.resolve(), warned = false;

  const s = {
    app, key, data,
    /** Grava no navegador e agenda o envio para a nuvem. */
    save() {
      if (!writeJSON(key, data)) { toast('Não foi possível salvar: o armazenamento do navegador está cheio ou bloqueado.', 'danger'); return false; }
      meta.dirty = true;
      writeJSON(metaKey, meta);
      if (C.user()) { clearTimeout(timer); timer = setTimeout(() => s.sync(), 1200); }
      return true;
    },
    /** Avisa quando chegam dados de outro aparelho (para redesenhar a tela). */
    onRemote(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    sync() {
      chain = chain.then(async () => {
        const u = C.user();
        if (!u) return;
        setStatus({ state: 'syncing' });
        try {
          const remote = await C.pull(app);
          const before = structuredClone(data);
          let next;
          if (meta.user && meta.user !== u.id) next = remote?.data ? { ...structuredClone(defaults), ...remote.data } : structuredClone(defaults); // dados de outra conta: não mistura
          else next = remote?.data ? merge(structuredClone(data), { ...structuredClone(defaults), ...remote.data }) : structuredClone(data);
          if (!same(before, next)) { replaceInPlace(data, next); writeJSON(key, data); listeners.forEach((fn) => fn(data)); }
          if (!remote || meta.dirty || !same(next, remote.data)) meta.syncedAt = await C.push(app, data);
          else meta.syncedAt = remote.updated_at;
          meta = { ...meta, user: u.id, dirty: false };
          writeJSON(metaKey, meta);
          warned = false;
          setStatus({ state: 'ok', at: Date.now(), error: null });
        } catch (err) {
          setStatus({ state: 'error', error: err.message });
          if (!warned && !err.offline) toast('Não consegui sincronizar: ' + err.message, 'warning');
          warned = true;
        }
      });
      return chain;
    },
    /** Saiu da conta: tira os dados dela deste aparelho. */
    clear() {
      replaceInPlace(data, defaults);
      meta = { user: null, syncedAt: null, dirty: false };
      writeJSON(key, data);
      writeJSON(metaKey, meta);
      listeners.forEach((fn) => fn(data));
    },
  };
  stores.set(app, s);
  if (C.user()) s.sync();
  return s;
}

export function syncAll() { return Promise.all([...stores.values()].map((s) => s.sync())); }

/** Todos os documentos do site (mesmo os de seções ainda não abertas). */
const KNOWN_KEYS = ['cifras.v1', 'timbres.v1', 'pocketmaster.v1', 'synth.v1'];
C.onAuth((u) => {
  if (u) { syncAll(); return; }
  stores.forEach((s) => s.clear());
  // seções que não foram abertas nesta visita: tira os dados que eram da conta
  for (const key of KNOWN_KEYS) {
    if ([...stores.values()].some((s) => s.key === key)) continue;
    if (readJSON(key + '.sync')?.user) { localStorage.removeItem(key); localStorage.removeItem(key + '.sync'); }
  }
  setStatus({ state: 'off', at: null, error: null });
});
let lastFocusSync = 0;
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && C.user() && Date.now() - lastFocusSync > 20000) { lastFocusSync = Date.now(); syncAll(); }
  });
  window.addEventListener('online', () => { if (C.user()) syncAll(); });
}

// ---------------------------------------------------------------- mescla
/** Lápides (id -> momento em que foi apagado): fica a mais recente. */
export function mergeTombs(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] || 0, v);
  return out;
}
/**
 * Mescla dois mapas id -> item. Fica a versão alterada por último (`ts(item)`);
 * itens apagados depois da última alteração somem.
 */
export function mergeMaps(a = {}, b = {}, tombs = {}, ts = (x) => x?.updatedAt || 0) {
  const out = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id], y = b[id];
    const pick = !x ? y : !y ? x : ts(y) > ts(x) ? y : x;
    if (tombs[id] && tombs[id] >= ts(pick)) continue;
    out[id] = pick;
  }
  return out;
}
/** O mesmo para listas com `id`, mantendo a ordem local e acrescentando as novas do outro lado. */
export function mergeArrays(a = [], b = [], tombs = {}, ts = (x) => x?.updatedAt || 0) {
  const m = mergeMaps(Object.fromEntries(a.map((x) => [x.id, x])), Object.fromEntries(b.map((x) => [x.id, x])), tombs, ts);
  const order = [...a.map((x) => x.id), ...b.map((x) => x.id).filter((id) => !a.some((x) => x.id === id))];
  return order.filter((id, i) => m[id] && order.indexOf(id) === i).map((id) => m[id]);
}
