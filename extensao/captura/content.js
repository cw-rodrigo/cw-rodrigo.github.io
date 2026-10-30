// Liga o seletor (picker.js) com a captura feita pela extensão.
(() => {
  // data URL <-> Blob sem fetch (alguns sites bloqueiam fetch de data: pelo CSP)
  const toBlob = async (dataUrl) => {
    const [head, b64] = dataUrl.split(',');
    const bin = atob(b64), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return new Blob([out], { type: (/data:([^;]+)/.exec(head) || [])[1] || 'image/png' });
  };
  const toDataUrl = (b) => new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); });
  const call = async (op, args) => { const r = await chrome.runtime.sendMessage({ type: 'estudio-store', op, args }); if (r && r.__error) throw new Error(r.__error); return r; };
  // histórico guardado na extensão: o mesmo para todos os sites
  const store = {
    prefs: () => call('prefs'),
    setPrefs: (p) => call('setPrefs', p),
    async add(rec) { const { blob, ...rest } = rec; return call('add', { ...rest, data: await toDataUrl(blob) }); },
    async list() { return Promise.all((await call('list')).map(async ({ data, ...r }) => ({ ...r, blob: await toBlob(data) }))); },
    remove: (ids) => call('remove', ids),
    clear: () => call('clear'),
  };
  async function capture(el, info) {
    const p = info.padding || 0;
    const r = el.getBoundingClientRect();
    const rect = { x: r.left + scrollX - p, y: r.top + scrollY - p, width: r.width + 2 * p, height: r.height + 2 * p };
    const res = await chrome.runtime.sendMessage({ type: 'estudio-capture', rect });
    if (!res || res.error) throw new Error(res?.error || 'a extensão não respondeu');
    if (!res.visibleOnly) return { blob: await toBlob(res.dataUrl), note: res.note || '' };
    // só a parte visível: recorta aqui
    const img = await createImageBitmap(await toBlob(res.dataUrl));
    const s = img.width / innerWidth;
    const x0 = Math.max(0, r.left - p), y0 = Math.max(0, r.top - p), x1 = Math.min(innerWidth, r.right + p), y1 = Math.min(innerHeight, r.bottom + p);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((x1 - x0) * s)); c.height = Math.max(1, Math.round((y1 - y0) * s));
    c.getContext('2d').drawImage(img, x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s, 0, 0, c.width, c.height);
    return { blob: await new Promise((ok) => c.toBlob(ok, 'image/png')), note: res.note };
  }
  window.__estudioPicker({ capture, store, mode: 'extensão' });
})();
