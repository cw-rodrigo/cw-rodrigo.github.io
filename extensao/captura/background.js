// Captura de elemento: o clique no ícone (ou Alt+Shift+S) liga o seletor na aba; a foto é tirada pelo
// mesmo comando que o DevTools usa ("Capturar screenshot do nó"): pega o elemento inteiro, mesmo a parte
// fora da tela, na resolução da tela. Sem o depurador (negado ou outra ferramenta usando), cai para a
// captura da parte visível da aba.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['picker.js', 'content.js'] });
  } catch (e) {
    // páginas do próprio navegador (chrome://, loja de extensões) não aceitam scripts
    chrome.action.setBadgeText({ tabId: tab.id, text: '×' });
    chrome.action.setTitle({ tabId: tab.id, title: 'Esta página não permite captura por extensões.' });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'estudio-store') { storeOp(msg.op, msg.args).then(reply, (e) => reply({ __error: e.message || String(e) })); return true; }
  if (msg?.type !== 'estudio-capture' || !sender.tab) return;
  capture(sender.tab, msg.rect).then(reply, (e) => reply({ error: e.message || String(e) }));
  return true; // resposta assíncrona
});

async function capture(tab, r) {
  const target = { tabId: tab.id };
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
  } catch (e) {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { dataUrl, visibleOnly: true, note: 'Captura só da parte visível (o modo completo precisa do depurador: ' + (e.message || e) + ').' };
  }
  try {
    const res = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, fromSurface: true,
      clip: { x: r.x, y: r.y, width: Math.max(1, r.width), height: Math.max(1, r.height), scale: 1 },
    });
    return { dataUrl: 'data:image/png;base64,' + res.data };
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

// ---------------------------------------------------------------- histórico de capturas (de todos os sites)
// Guardado no IndexedDB da extensão; as imagens vão e voltam como data URL nas mensagens.
const DEFAULT_PREFS = { limit: 10, quick: false, copyMode: 'auto', layout: 'vertical', transparent: false, fmt: 'png', scale: 100, maxMB: 0, per: 'file' };
let dbp = null;
const openDb = () => dbp || (dbp = new Promise((ok, no) => {
  const r = indexedDB.open('estudio-capturas', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('shots', { keyPath: 'id' }); r.result.createObjectStore('meta'); };
  r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
}));
async function run(name, mode, fn) {
  const db = await openDb();
  return new Promise((ok, no) => { const t = db.transaction(name, mode); const req = fn(t.objectStore(name)); t.oncomplete = () => ok(req && 'result' in req ? req.result : undefined); t.onerror = () => no(t.error); });
}
const prefs = async () => ({ ...DEFAULT_PREFS, ...((await run('meta', 'readonly', (st) => st.get('prefs'))) || {}) });
const list = async () => (await run('shots', 'readonly', (st) => st.getAll())).sort((a, b) => b.at - a.at);
async function trim(limit) { const l = await list(); const old = l.slice(limit).map((r) => r.id); if (old.length) await run('shots', 'readwrite', (st) => old.forEach((id) => st.delete(id))); return Math.min(l.length, limit); }
async function storeOp(op, a) {
  if (op === 'prefs') return prefs();
  if (op === 'setPrefs') { const p = { ...(await prefs()), ...a }; await run('meta', 'readwrite', (st) => st.put(p, 'prefs')); await trim(p.limit); return p; }
  if (op === 'list') return list();
  if (op === 'add') { await run('shots', 'readwrite', (st) => st.put(a)); return trim((await prefs()).limit); }
  if (op === 'remove') { await run('shots', 'readwrite', (st) => a.forEach((id) => st.delete(id))); return true; }
  if (op === 'clear') { await run('shots', 'readwrite', (st) => st.clear()); return true; }
  throw new Error('operação desconhecida: ' + op);
}
