// Seletor de elemento no estilo do "inspecionar" do DevTools: passe o mouse para destacar,
// clique para capturar só aquele elemento. Arquivo sem módulos (vira favorito e entra na extensão).
// Uso: window.__estudioPicker({ capture: async (el, info) => Blob, mode: 'favorito' | 'extensão', target? })
// target = { name, sel, alt, padding, action: 'previa' | 'baixar' | 'copiar' }: captura direto um elemento
// lembrado (é o que os "favoritos de elemento" fazem). window.__estudioBookmarklet(target?) gera o favorito.
// Só usa DOM e CSSOM (nada de innerHTML nem <style>), para funcionar em sites com CSP e Trusted Types.
(function lib() {
  if (window.__estudioPicker) return;
  window.__estudioPickerLib = lib;
  const Z = '2147483647';
  const css = (el, s) => { Object.assign(el.style, s); return el; };
  const mk = (tag, s, text) => { const e = document.createElement(tag); if (s) css(e, s); if (text != null) e.textContent = text; return e; };
  const FONT = '13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const btn = (label, primary) => mk('button', { font: FONT, padding: '5px 10px', borderRadius: '6px', border: '1px solid ' + (primary ? '#2f6fde' : '#5b6370'), background: primary ? '#3b7cf0' : '#2b3038', color: '#fff', cursor: 'pointer', margin: '0' }, label);
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    if (cls.length) s += '.' + cls.join('.');
    return s;
  };
  const cssq = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/[^\w-]/g, (c) => '\\' + c));
  const okId = (id) => /^[a-z][\w-]{0,50}$/i.test(id) && !/\d{4,}/.test(id);
  const okClass = (c) => /^[a-z][\w-]{1,40}$/i.test(c) && !/\d{3,}|^(is|has)-|^(active|hover|focus|open|opened|selected|show|visible|hidden|current)$|^(css|sc|jsx|emotion)-|__[a-z0-9]{5,}$/i.test(c);
  /** Um passo do seletor: atributo de teste/aria, ou tag + classes estáveis (+ posição entre irmãos). */
  function step(n, nth) {
    let s = n.tagName.toLowerCase();
    for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'aria-label', 'name']) {
      const v = n.getAttribute(a);
      if (v && v.length <= 60) return s + '[' + a + '="' + v.replace(/["\\]/g, '\\$&') + '"]';
    }
    s += Array.from(n.classList).filter(okClass).slice(0, 2).map((c) => '.' + cssq(c)).join('');
    if (nth && n.parentElement) {
      const same = Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName);
      if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
    }
    return s;
  }
  /** Seletor CSS que acha de novo este elemento: { sel, alt } (alt = caminho só por posições, de reserva). */
  function selectorFor(el) {
    const is = (q) => { try { const m = document.querySelectorAll(q); return m.length === 1 && m[0] === el; } catch (e) { return false; } };
    const path = [];
    let n = el, nice = null;
    for (let depth = 0; n && n.nodeType === 1 && n !== document.documentElement && depth < 25; depth++, n = n.parentElement) {
      const id = n.id && okId(n.id) ? '#' + cssq(n.id) : null;
      path.unshift(id || step(n, false));
      if (is(path.join(' > '))) { nice = path.join(' > '); break; }
      if (!id) { path[0] = step(n, true); if (is(path.join(' > '))) { nice = path.join(' > '); break; } }
    }
    const pos = [];
    for (n = el; n && n !== document.body && n.parentElement; n = n.parentElement) pos.unshift(n.tagName.toLowerCase() + ':nth-child(' + (Array.from(n.parentElement.children).indexOf(n) + 1) + ')');
    const alt = 'body > ' + pos.join(' > ');
    return { sel: nice || alt, alt: nice && nice !== alt ? alt : null };
  }
  /** Acha o elemento lembrado (espera um pouco: a página pode ainda estar carregando). */
  async function findTarget(t, ms) {
    const t0 = Date.now();
    for (;;) {
      for (const q of [t.sel, t.alt]) {
        if (!q) continue;
        try { const el = document.querySelector(q); if (el && el.getClientRects().length) return el; } catch (e) { /* seletor inválido aqui */ }
      }
      if (Date.now() - t0 > ms) return null;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  /** Código do favorito (javascript:…) com o seletor inteiro dentro: sem carregar nada de fora (CSP). */
  window.__estudioBookmarklet = function (target) {
    const src = lib.toString().replace(/\/\*\*[\s\S]*?\*\//g, '').split('\n').filter((l) => l.trim() && !/^\s*\/\//.test(l)).map((l) => l.trim()).join('\n');
    const cfg = target ? ',target:' + JSON.stringify(target) : '';
    return 'javascript:' + encodeURIComponent('(()=>{if(!window.__estudioPicker)(' + src + ')();window.__estudioPicker({capture:window.__estudioCaptureDisplay,mode:"favorito"' + cfg + '});})();');
  };
  // ---------------------------------------------------------------- histórico de capturas
  /**
   * Histórico das últimas capturas. No favorito fica no IndexedDB do site em que você está (some se o site
   * limpar os dados); na extensão, no armazenamento da extensão (o mesmo para todos os sites).
   * Interface: prefs(), setPrefs(p), add(rec), list() (mais nova primeiro), remove(ids), clear().
   */
  const DEFAULT_PREFS = { limit: 10, quick: false, copyMode: 'auto', layout: 'vertical', transparent: false, fmt: 'png', scale: 100, maxMB: 0, per: 'file' };
  window.__estudioIdbStore = function (dbName) {
    let dbp = null, mem = null;
    const open = () => dbp || (dbp = new Promise((ok, no) => {
      const r = indexedDB.open(dbName || 'estudio-capturas', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('shots', { keyPath: 'id' }); r.result.createObjectStore('meta'); };
      r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
    }));
    const run = async (name, mode, fn) => {
      if (mem) return fn(null);
      let db;
      try { db = await open(); } catch (e) { mem = { shots: [], prefs: { ...DEFAULT_PREFS } }; return fn(null); } // sem IndexedDB: só na memória
      return new Promise((ok, no) => { const t = db.transaction(name, mode); const req = fn(t.objectStore(name)); t.oncomplete = () => ok(req && 'result' in req ? req.result : req); t.onerror = () => no(t.error); });
    };
    const all = () => run('shots', 'readonly', (st) => (st ? st.getAll() : mem.shots.slice()));
    const api = {
      async prefs() { const p = await run('meta', 'readonly', (st) => (st ? st.get('prefs') : mem.prefs)); return { ...DEFAULT_PREFS, ...(p || {}) }; },
      async setPrefs(p) { const cur = { ...(await api.prefs()), ...p }; await run('meta', 'readwrite', (st) => (st ? st.put(cur, 'prefs') : (mem.prefs = cur))); await api.trim(cur.limit); return cur; },
      async list() { return (await all()).sort((a, b) => b.at - a.at); },
      async add(rec) { await run('shots', 'readwrite', (st) => (st ? st.put(rec) : mem.shots.push(rec))); return api.trim((await api.prefs()).limit); },
      async trim(limit) { const l = await api.list(); const old = l.slice(limit).map((r) => r.id); if (old.length) await api.remove(old); return Math.min(l.length, limit); },
      async remove(ids) { await run('shots', 'readwrite', (st) => { if (!st) { mem.shots = mem.shots.filter((r) => !ids.includes(r.id)); return; } ids.forEach((id) => st.delete(id)); }); },
      async clear() { await run('shots', 'readwrite', (st) => (st ? st.clear() : (mem.shots = []))); },
    };
    return api;
  };

  // ---------------------------------------------------------------- .zip (sem compressão: PNG já é comprimido)
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  async function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const data = new Uint8Array(await f.blob.arrayBuffer()), name = enc.encode(f.name), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(h.buffer, name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(c.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const size = central.reduce((n, b) => n + b.byteLength, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, offset, true);
    return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
  }
  /** Nomes únicos dentro do lote. */
  const uniqueNames = (recs) => { const seen = {}; return recs.map((r) => { let n = r.name; const k = n.toLowerCase(); if (seen[k]) n = n.replace(/\.png$/i, '') + '-' + (++seen[k]) + '.png'; else seen[k] = 1; return n; }); };
  const blobToDataUrl = (b) => new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); });
  // ---------------------------------------------------------------- juntar numa imagem só
  const JOIN_GAP = 16, JOIN_MAX = 16000; // 16.000 px: limite seguro de largura/altura de imagem no navegador
  const NEAR = 0.85; // a partir de 85% do limite, avisa que está perto
  /** Arranjo com `cols` colunas: tamanho total e a escala para caber no limite (1 = sem redução). */
  function planCols(sizes, cols) {
    const colW = [], rowH = [];
    sizes.forEach((z, i) => { const c = i % cols, r = Math.floor(i / cols); colW[c] = Math.max(colW[c] || 0, z.w); rowH[r] = Math.max(rowH[r] || 0, z.h); });
    const w = colW.reduce((a, b) => a + b, 0) + JOIN_GAP * (colW.length - 1), h = rowH.reduce((a, b) => a + b, 0) + JOIN_GAP * (rowH.length - 1);
    return { cols, colW, rowH, w, h, k: Math.min(1, JOIN_MAX / w, JOIN_MAX / h) };
  }
  /**
   * Plano para o arranjo escolhido. A grade testa todas as quantidades de colunas e fica com a que
   * mantém mais qualidade (maior escala; empatando, a mais "quadrada") — por isso é a que mais demora a
   * chegar no limite com muitas capturas.
   */
  function planJoin(sizes, layout) {
    if (!sizes.length) return planCols([{ w: 1, h: 1 }], 1);
    if (layout === 'horizontal') return planCols(sizes, sizes.length);
    if (layout !== 'grade') return planCols(sizes, 1);
    let best = null;
    for (let c = 1; c <= sizes.length; c++) {
      const p = planCols(sizes, c);
      const score = p.k * 1e6 - Math.max(p.w, p.h);
      if (!best || score > best.score) best = { ...p, score };
    }
    return best;
  }
  const sizesOf = (recs) => recs.map((r) => ({ w: r.width || 1, h: r.height || 1 }));
  /** Divide em partes seguidas que cabem sem redução no arranjo escolhido. */
  function splitForLimit(recs, layout) {
    const parts = [];
    let cur = [];
    for (const r of recs) {
      if (cur.length && planJoin(sizesOf([...cur, r]), layout).k < 1) { parts.push(cur); cur = []; }
      cur.push(r);
    }
    if (cur.length) parts.push(cur);
    return parts;
  }
  /** Junta várias capturas numa imagem só, no arranjo escolhido, com fundo branco (ou transparente). */
  async function joinImages(recs, o) { const c = await joinCanvas(recs, o); return new Promise((ok) => c.toBlob(ok, 'image/png')); }
  async function joinCanvas(recs, { layout = 'vertical', transparent = false } = {}) {
    const bmps = await Promise.all(recs.map((r) => createImageBitmap(r.blob)));
    const p = planJoin(bmps.map((b) => ({ w: b.width, h: b.height })), layout), k = p.k;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(p.w * k)); c.height = Math.max(1, Math.round(p.h * k));
    const g = c.getContext('2d');
    if (!transparent) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
    bmps.forEach((b, i) => {
      const cc = i % p.cols, rr = Math.floor(i / p.cols);
      const x = p.colW.slice(0, cc).reduce((a, v) => a + v + JOIN_GAP, 0), y = p.rowH.slice(0, rr).reduce((a, v) => a + v + JOIN_GAP, 0);
      g.drawImage(b, x * k, y * k, b.width * k, b.height * k);
    });
    c.transparent = transparent;
    return c;
  }
  /**
   * Copia várias capturas de uma vez. A área de transferência só aceita uma imagem por vez, então:
   * mode 'auto': vai como HTML com todas as imagens (Docs, Word, Gmail, Notion colam cada uma) e também
   *   como uma imagem só, juntas (para quem só aceita imagem) — o programa de destino escolhe;
   * mode 'separadas': só o HTML (força imagens separadas onde o destino aceita);
   * mode 'juntas': só a imagem única (força um arquivo só, mesmo onde o destino aceitaria separadas).
   */
  async function copyMany(recs, opt) {
    const o = opt || {}, mode = o.mode || 'auto';
    if (recs.length === 1) { await navigator.clipboard.write([new ClipboardItem({ 'image/png': recs[0].blob })]); return 'imagem'; }
    const html = async () => new Blob(['<div>' + (await Promise.all(recs.map((r) => blobToDataUrl(r.blob)))).map((u) => '<p><img src="' + u + '"></p>').join('') + '</div>'], { type: 'text/html' });
    if (mode === 'juntas') { await navigator.clipboard.write([new ClipboardItem({ 'image/png': await joinImages(recs, o) })]); return 'juntas'; }
    if (mode === 'separadas') { await navigator.clipboard.write([new ClipboardItem({ 'text/html': await html() })]); return 'separadas'; }
    const joined = await joinImages(recs, o);
    try { await navigator.clipboard.write([new ClipboardItem({ 'text/html': await html(), 'image/png': joined })]); return 'lote'; }
    catch (e) { await navigator.clipboard.write([new ClipboardItem({ 'image/png': joined })]); return 'juntas'; }
  }

  // ---------------------------------------------------------------- saída: formato, escala e limite de tamanho
  const TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }, EXTS = { png: 'png', jpeg: 'jpg', webp: 'webp' };
  const MB = 1024 * 1024;
  const fmtMB = (n) => (n < MB / 10 ? (n / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' KB' : (n / MB).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' MB');
  function encodeAt(src, sc, type, q, transparent) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * sc)); c.height = Math.max(1, Math.round(src.height * sc));
    const g = c.getContext('2d');
    if (type === 'image/jpeg' || !transparent) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); } // JPEG não tem transparência
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    return new Promise((ok) => c.toBlob(ok, type, q));
  }
  /**
   * Gera os arquivos finais com a menor perda possível que caiba no limite.
   * o: { fmt: 'png'|'jpeg'|'webp', scale (0..1, redução manual), maxBytes (0 = sem limite), per: 'file'|'total', transparent }
   * JPEG/WebP: tenta qualidade 92%, 85% e 75% antes de reduzir as dimensões; PNG (sem perda) só reduz as dimensões.
   * Devolve { items: [{ blob, scale, q }], total }.
   */
  async function fitOutputs(srcs, o, onStep) {
    const type = TYPES[o.fmt] || 'image/png', max = o.maxBytes || 0, s0 = Math.max(0.01, Math.min(1, o.scale || 1));
    if (max && o.per !== 'total' && srcs.length > 1) { // cada arquivo no limite, cada um com a sua redução
      const items = [];
      for (let i = 0; i < srcs.length; i++) { onStep && onStep('Ajustando ' + (i + 1) + ' de ' + srcs.length + '…'); items.push((await fitOutputs([srcs[i]], { ...o, per: 'total' })).items[0]); }
      return { items, total: items.reduce((n, x) => n + x.blob.size, 0) };
    }
    const qs = type === 'image/png' ? [undefined] : [0.92, 0.85, 0.75];
    const sum = (bl) => bl.reduce((n, b) => n + b.size, 0);
    const encAll = (sc, q) => Promise.all(srcs.map((x) => encodeAt(x, sc, type, q, o.transparent)));
    const pack = (bl, sc, q) => ({ items: bl.map((b) => ({ blob: b, scale: sc, q })), total: sum(bl) });
    let last = null;
    for (const q of qs) { const bl = await encAll(s0, q); last = bl; if (!max || sum(bl) <= max) return pack(bl, s0, q); }
    const q = qs[qs.length - 1];
    const MIN = 0.05; // abaixo de 5% do tamanho não vale a pena: avisa em vez de entregar uma miniatura
    let lo = MIN, hi = s0, best = null;
    const guess = s0 * Math.sqrt(max / sum(last)) * 0.97; // o tamanho cai mais ou menos com a área
    for (let i = 0; i < 9 && hi - lo > 0.005; i++) {
      const sc = i === 0 ? Math.max(MIN, Math.min(guess, hi * 0.995)) : (lo + hi) / 2;
      onStep && onStep('Reduzindo para caber em ' + fmtMB(max) + '… (' + Math.round(sc * 100) + '%)');
      const bl = await encAll(sc, q);
      if (sum(bl) <= max) { best = pack(bl, sc, q); lo = sc; if (sum(bl) >= max * 0.96) break; } else hi = sc;
    }
    if (!best) { const bl = await encAll(MIN, q); if (sum(bl) <= max) best = pack(bl, MIN, q); }
    if (!best) throw new Error('não coube em ' + fmtMB(max) + ' nem reduzindo para 5% do tamanho. Aumente o limite' + (type === 'image/png' ? ' ou use JPEG/WebP (bem menores).' : '.'));
    return best;
  }
  /** Resumo do que saiu: tamanho, redução e qualidade. */
  function outSummary(res, o) {
    const scs = res.items.map((x) => x.scale), lo = Math.min(...scs), hi = Math.max(...scs);
    const red = hi >= 0.995 ? 'tamanho original' : 'reduzida para ' + (Math.round(lo * 100) === Math.round(hi * 100) ? Math.round(hi * 100) + '%' : Math.round(lo * 100) + '–' + Math.round(hi * 100) + '%');
    const q = res.items[0].q;
    return fmtMB(res.total) + ' · ' + red + ' · ' + (o.fmt === 'png' ? 'PNG' : (o.fmt === 'jpeg' ? 'JPEG' : 'WebP') + (q ? ' qualidade ' + Math.round(q * 100) + '%' : ''));
  }
  const withExt = (name, fmt) => name.replace(/\.(png|jpe?g|webp)$/i, '') + '.' + EXTS[fmt || 'png'];

  const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'elemento';

  window.__estudioPicker = function start(opts) {
    if (window.__estudioPickerActive) { window.__estudioPickerActive.stop(); if (!opts.target) return; }
    let target = opts.target || null, stopped = false;
    if (window.__estudioKeepDisplay) window.__estudioKeepDisplay();
    const host = mk('div', { all: 'initial', position: 'fixed', inset: '0', zIndex: Z, pointerEvents: 'none' });
    const root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
    const box = mk('div', { position: 'fixed', boxSizing: 'border-box', border: '2px solid #3b7cf0', background: 'rgba(59,124,240,.18)', borderRadius: '2px', pointerEvents: 'none', display: 'none', transition: 'all 40ms linear' });
    const pad = mk('div', { position: 'fixed', boxSizing: 'border-box', border: '1px dashed rgba(59,124,240,.9)', pointerEvents: 'none', display: 'none' });
    const tag = mk('div', { position: 'fixed', font: '12px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', background: '#1f2329', color: '#fff', padding: '3px 7px', borderRadius: '4px', pointerEvents: 'none', whiteSpace: 'nowrap', maxWidth: '80vw', overflow: 'hidden', textOverflow: 'ellipsis', display: 'none', boxShadow: '0 2px 8px rgba(0,0,0,.35)' });
    const bar = mk('div', { position: 'fixed', top: '10px', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', font: FONT, background: '#1f2329', color: '#e8eaed', padding: '7px 10px', borderRadius: '8px', boxShadow: '0 4px 18px rgba(0,0,0,.4)', pointerEvents: 'auto', maxWidth: 'calc(100vw - 20px)' });
    const hint = mk('span', null, 'Passe o mouse e clique no elemento · ↑ pai · ↓ filho · Esc sai');
    const padLabel = mk('label', { display: 'flex', alignItems: 'center', gap: '4px', color: '#c3c7cd' }, 'Margem');
    const padInput = mk('input', { width: '48px', font: FONT, background: '#2b3038', color: '#fff', border: '1px solid #5b6370', borderRadius: '4px', padding: '2px 4px' });
    padInput.type = 'number'; padInput.min = '0'; padInput.max = '200'; padInput.value = String((target && target.padding) || opts.padding || 0);
    padLabel.append(padInput, mk('span', null, 'px'));
    const close = btn('Sair');
    const galBtn = btn('Capturas');
    const quickLabel = mk('label', { display: 'flex', alignItems: 'center', gap: '4px', color: '#c3c7cd', cursor: 'pointer' });
    const quickIn = mk('input'); quickIn.type = 'checkbox';
    quickLabel.append(quickIn, mk('span', null, 'Só guardar'));
    quickLabel.title = 'Captura em sequência: cada clique só guarda nas Capturas, sem abrir a prévia. No fim, abra Capturas para baixar ou copiar.';
    const shareTag = mk('span', { color: '#ff7b72', display: 'none', whiteSpace: 'nowrap' }, '● compartilhando');
    shareTag.title = 'O compartilhamento de tela fica ligado enquanto o seletor está aberto, para não perguntar a cada captura. "Sair" encerra.';
    bar.append(hint, padLabel, quickLabel, galBtn, shareTag, close);
    const sharing = () => !!(window.__estudioDisplayActive && window.__estudioDisplayActive());
    const shareTimer = setInterval(() => { shareTag.style.display = sharing() ? '' : 'none'; }, 1000);
    root.append(box, pad, tag, bar);
    document.documentElement.append(host);

    let cur = null, stack = [], busy = false, panel = null, lastXY = null;
    const padding = () => Math.max(0, Math.min(200, Number(padInput.value) || 0));
    const ours = (n) => n === host || (n && host.contains(n));

    function show(el) {
      cur = el;
      if (!el) { box.style.display = tag.style.display = pad.style.display = 'none'; return; }
      const r = el.getBoundingClientRect(), p = padding();
      css(box, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      css(pad, p ? { display: 'block', left: r.left - p + 'px', top: r.top - p + 'px', width: r.width + 2 * p + 'px', height: r.height + 2 * p + 'px' } : { display: 'none' });
      tag.textContent = describe(el) + '  ' + Math.round(r.width) + ' × ' + Math.round(r.height);
      const above = r.top > 28;
      css(tag, { display: 'block', left: Math.max(4, Math.min(r.left, innerWidth - 260)) + 'px', top: (above ? r.top - 24 : Math.min(innerHeight - 24, r.bottom + 4)) + 'px' });
    }
    function pick(x, y) {
      host.style.display = 'none'; // elementFromPoint não pode achar o próprio destaque
      let el = document.elementFromPoint(x, y);
      host.style.display = '';
      if (!el || ours(el) || el === document.documentElement) el = null;
      stack = [];
      show(el);
    }
    const onMove = (e) => { if (busy || panel || e.composedPath().includes(host)) return; lastXY = [e.clientX, e.clientY]; pick(e.clientX, e.clientY); };
    const block = (e) => { if (panel || (e.target && e.target.__estudio) || ours(e.composedPath()[0]) || e.composedPath().includes(host)) return; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    const onClick = (e) => {
      if (panel || (e.target && e.target.__estudio) || e.composedPath().includes(host)) return;
      block(e);
      if (!busy && cur) shoot(cur);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (panel) closePanel(); else stop(); return; }
      if (panel || busy || !cur) return;
      if (e.key === 'ArrowUp' && cur.parentElement && cur.parentElement !== document.documentElement) { e.preventDefault(); e.stopPropagation(); stack.push(cur); show(cur.parentElement); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); const prev = stack.pop() || cur.firstElementChild; if (prev) show(prev); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); shoot(cur); }
    };
    const onScroll = () => { if (cur && !busy && !panel) show(cur); };
    const opt = { capture: true, passive: false };
    addEventListener('mousemove', onMove, true);
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick'].forEach((t) => addEventListener(t, block, opt));
    addEventListener('click', onClick, opt);
    addEventListener('keydown', onKey, true);
    addEventListener('scroll', onScroll, true);
    addEventListener('resize', onScroll, true);
    close.addEventListener('click', () => stop());
    const prevCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = 'crosshair';

    const store = opts.store || window.__estudioIdbStore();
    let prefs = { ...DEFAULT_PREFS };
    const updateCount = async () => { try { const n = (await store.list()).length; galBtn.textContent = 'Capturas (' + n + ')'; return n; } catch (e) { return 0; } };
    let quickTouched = false;
    store.prefs().then((p) => { prefs = { ...p, quick: quickTouched ? quickIn.checked : p.quick }; if (!quickTouched) quickIn.checked = !!p.quick; }).catch(() => {});
    updateCount();
    quickIn.addEventListener('change', () => { quickTouched = true; prefs.quick = quickIn.checked; store.setPrefs({ quick: prefs.quick }).catch(() => {}); });
    galBtn.addEventListener('click', () => openGallery());
    const toastBox = mk('div', { position: 'fixed', bottom: '18px', left: '50%', transform: 'translateX(-50%)', font: FONT, background: '#1f2329', color: '#fff', padding: '8px 14px', borderRadius: '8px', boxShadow: '0 4px 18px rgba(0,0,0,.4)', display: 'none', pointerEvents: 'none' });
    root.append(toastBox);
    let toastT = 0;
    const toast = (msg, ms) => { toastBox.textContent = msg; toastBox.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => { toastBox.style.display = 'none'; }, ms || 2500); };
    const fileName = (el) => slug(target ? target.name : location.hostname.replace(/^www\./, '') + '-' + describe(el)) + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.png';
    const saveBlob = (blob, name) => { const u = URL.createObjectURL(blob); const a = mk('a'); a.href = u; a.download = name; a.__estudio = true; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000); };

    const frames = (n) => new Promise((r) => { const f = () => (n-- <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    async function shoot(el, auto) {
      busy = true;
      const p = padding();
      const wasSharing = sharing();
      host.style.display = 'none';
      await frames(2);
      let blob = null, note = '';
      try {
        const out = await opts.capture(el, { padding: p, describe: describe(el) });
        blob = out && out.blob ? out.blob : out;
        note = (out && out.note) || '';
      } catch (err) {
        note = 'Não consegui capturar: ' + (err && err.message ? err.message : err);
      }
      host.style.display = '';
      busy = false;
      shareTag.style.display = sharing() ? '' : 'none';
      const firstShare = !wasSharing && sharing();
      let kept = 0;
      if (blob) {
        try {
          const bmp = await createImageBitmap(blob);
          kept = await store.add({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), blob, name: fileName(el), width: bmp.width, height: bmp.height, element: describe(el), site: location.hostname, url: location.href });
          updateCount();
        } catch (e) { /* sem histórico: segue só com esta captura */ }
      }
      if (blob && !auto && quickIn.checked) { toast('Guardada nas Capturas (' + kept + ' de ' + prefs.limit + ') ✓' + (firstShare ? ' O compartilhamento fica ligado até você clicar em Sair: as próximas não perguntam de novo.' : ''), firstShare ? 5000 : 2500); if (lastXY) pick(lastXY[0], lastXY[1]); return; }
      if (blob && target && target.action === 'baixar' && auto) { saveBlob(blob, fileName(el)); toast('“' + target.name + '” baixado ✓'); setTimeout(() => stop(true), 1800); return; }
      if (blob && target && target.action === 'copiar' && auto) {
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('“' + target.name + '” copiado ✓'); setTimeout(() => stop(true), 1800); return; } catch (e) { note = note || 'Não deu para copiar direto (o site não deixou); use os botões.'; }
      }
      if (firstShare && !note) note = 'O compartilhamento de tela fica ligado até você clicar em Sair: as próximas capturas não perguntam de novo.';
      openPanel(blob, note, el);
    }
    /** Capturas guardadas: escolher quais e baixar (soltas ou em .zip), copiar ou apagar, uma a uma ou em lote. */
    async function openGallery() {
      if (panel) closePanel();
      show(null);
      const wrap = mk('div', { position: 'fixed', inset: '0', background: 'rgba(10,12,16,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto', font: FONT });
      const card = mk('div', { background: '#1f2329', color: '#e8eaed', borderRadius: '10px', padding: '14px', width: 'min(94vw, 1100px)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', gap: '10px', boxShadow: '0 10px 40px rgba(0,0,0,.5)' });
      wrap.append(card);
      root.append(wrap);
      panel = { el: wrap, url: '' };
      wrap.addEventListener('click', (e) => { if (e.target === wrap) closePanel(); });
      const head = mk('div', { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' });
      const title = mk('div', { fontWeight: '600', fontSize: '15px' }, 'Capturas');
      const limLabel = mk('label', { display: 'flex', alignItems: 'center', gap: '5px', color: '#c3c7cd', marginLeft: 'auto' }, 'Guardar as últimas');
      const limIn = mk('input', { width: '56px', font: FONT, background: '#2b3038', color: '#fff', border: '1px solid #5b6370', borderRadius: '4px', padding: '2px 4px' });
      limIn.type = 'number'; limIn.min = '1'; limIn.max = '200'; limIn.value = String(prefs.limit); limIn.dataset.role = 'limite';
      limLabel.append(limIn);
      head.append(title, limLabel);
      const where = mk('div', { color: '#9aa0a6', fontSize: '12px' }, opts.mode === 'extensão' ? 'Guardadas na extensão (de todos os sites).' : 'Guardadas neste navegador, para este site (' + location.hostname + ').');
      const grid = mk('div', { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '10px', overflow: 'auto', minHeight: '120px', paddingRight: '4px' });
      const msg = mk('div', { color: '#9aa0a6', fontSize: '12px', minHeight: '16px' });
      msg.dataset.role = 'mensagem';
      const actions = mk('div', { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' });
      const allBtn = btn('Marcar todas'), noneBtn = btn('Desmarcar todas');
      const dlBtn = btn('Baixar', true), zipBtn = btn('Baixar .zip'), oneBtn = btn('Baixar numa imagem só'), cpBtn = btn('Copiar'), delBtn = btn('Apagar');
      // como copiar e como juntar (lembrado entre as sessões)
      const optRow = mk('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', color: '#c3c7cd', fontSize: '12px' });
      const selCss = { font: FONT, fontSize: '12px', background: '#2b3038', color: '#fff', border: '1px solid #5b6370', borderRadius: '4px', padding: '2px 4px' };
      const mkSel = (label, role, options, value) => {
        const l = mk('label', { display: 'flex', alignItems: 'center', gap: '5px' }, label);
        const sl = mk('select', selCss); sl.dataset.role = role;
        options.forEach(([v, t]) => { const o = mk('option', null, t); o.value = v; sl.append(o); });
        sl.value = value; l.append(sl); optRow.append(l); return sl;
      };
      const modeSel = mkSel('Copiar várias:', 'copia', [['auto', 'automático (o destino escolhe)'], ['juntas', 'sempre numa imagem só'], ['separadas', 'sempre separadas']], prefs.copyMode || 'auto');
      const laySel = mkSel('Juntar:', 'layout', [['vertical', 'uma embaixo da outra'], ['horizontal', 'lado a lado'], ['grade', 'em grade (melhor qualidade com muitas capturas)']], prefs.layout || 'vertical');
      const trLabel = mk('label', { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' });
      const trIn = mk('input'); trIn.type = 'checkbox'; trIn.checked = !!prefs.transparent; trIn.dataset.role = 'transparente';
      trLabel.append(trIn, mk('span', null, 'fundo transparente'));
      optRow.append(trLabel);
      // saída: formato, redução manual e limite de tamanho (para caber no limite do destino)
      const outRow = mk('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', color: '#c3c7cd', fontSize: '12px' });
      const fmtSel = mkSel('Formato:', 'formato', [['png', 'PNG (sem perda)'], ['jpeg', 'JPEG (bem menor)'], ['webp', 'WebP (menor ainda)']], prefs.fmt || 'png');
      const numIn = (role, v, min, max, step, width) => { const i = mk('input', { ...selCss, width }); i.type = 'number'; i.min = min; i.max = max; i.step = step; i.value = v; i.dataset.role = role; return i; };
      const scaleIn = numIn('escala', prefs.scale || 100, '5', '100', '5', '56px');
      const scLabel = mk('label', { display: 'flex', alignItems: 'center', gap: '5px' }, 'Tamanho:'); scLabel.append(scaleIn, mk('span', null, '%'));
      const mbIn = numIn('limite-mb', prefs.maxMB || '', '0', '1000', '0.1', '64px'); mbIn.placeholder = 'sem';
      const mbLabel = mk('label', { display: 'flex', alignItems: 'center', gap: '5px' }, 'No máximo:'); mbLabel.append(mbIn, mk('span', null, 'MB'));
      const perSel = mk('select', selCss); perSel.dataset.role = 'por';
      [['file', 'por arquivo'], ['total', 'no total']].forEach(([v, t]) => { const op = mk('option', null, t); op.value = v; perSel.append(op); });
      perSel.value = prefs.per || 'file'; mbLabel.append(perSel);
      // os selects de mkSel entram em optRow: move o de formato para a linha de saída
      outRow.append(fmtSel.parentNode, scLabel, mbLabel);
      const outHint = mk('span', { color: '#9aa0a6' }, '');
      outRow.append(outHint);
      const outOpts = () => ({ fmt: fmtSel.value, scale: Math.max(5, Math.min(100, Number(scaleIn.value) || 100)) / 100, maxBytes: Number(mbIn.value) > 0 ? Number(mbIn.value) * MB : 0, per: perSel.value, transparent: trIn.checked });
      const plainOut = () => { const o = outOpts(); return o.fmt === 'png' && o.scale >= 1 && !o.maxBytes; };
      const saveOut = async () => { prefs = await store.setPrefs({ fmt: fmtSel.value, scale: Number(scaleIn.value) || 100, maxMB: Number(mbIn.value) || 0, per: perSel.value }); updateOutHint(); };
      const updateOutHint = () => { outHint.textContent = plainOut() ? 'arquivos originais, sem nenhuma perda' : 'a cópia para a área de transferência sai sempre em PNG (é o que o navegador permite); o limite ajusta o tamanho'; };
      [fmtSel, scaleIn, mbIn, perSel].forEach((x) => x.addEventListener('change', saveOut));
      updateOutHint();
      const joinOpts = () => ({ mode: modeSel.value, layout: laySel.value, transparent: trIn.checked });
      const savePrefs = async () => { prefs = await store.setPrefs({ copyMode: modeSel.value, layout: laySel.value, transparent: trIn.checked }); split = null; label(); };
      [modeSel, laySel, trIn].forEach((x) => x.addEventListener('change', savePrefs));
      const back = btn('Voltar a capturar'), quit = btn('Sair');
      const spacer = mk('span', { flex: '1' });
      actions.append(allBtn, noneBtn, spacer, dlBtn, zipBtn, oneBtn, cpBtn, delBtn, back, quit);
      // aviso de limite da imagem única, com sugestões (outro arranjo, grade, ou dividir)
      const joinInfo = mk('div', { display: 'none', gap: '8px', flexWrap: 'wrap', alignItems: 'center', fontSize: '12px', background: '#3a3220', color: '#f2d27a', border: '1px solid #6b5a2a', borderRadius: '6px', padding: '6px 10px' });
      joinInfo.dataset.role = 'limite-aviso';
      card.append(head, where, grid, optRow, outRow, joinInfo, msg, actions);
      const LNAME = { vertical: 'uma embaixo da outra', horizontal: 'lado a lado', grade: 'em grade' };
      const NEXT = { vertical: ['horizontal', 'grade'], horizontal: ['vertical', 'grade'], grade: [] }; // ordem das sugestões
      let split = null; // { parts, next }: dividir em várias imagens sem redução
      const fmt = (n) => Math.round(n).toLocaleString('pt-BR');
      const pct = (k) => Math.floor(k * 100) + '%';

      let recs = [];
      const sel = new Set();
      const chosen = () => recs.filter((r) => sel.has(r.id));
      const label = () => {
        const n = sel.size;
        title.textContent = 'Capturas (' + recs.length + ' de ' + prefs.limit + ')';
        dlBtn.textContent = 'Baixar ' + (n === recs.length ? 'todas' : 'selecionadas') + ' (' + n + ')';
        zipBtn.textContent = 'Baixar .zip (' + n + ')';
        cpBtn.textContent = 'Copiar ' + (n === 1 ? 'a imagem' : (n === recs.length ? 'todas' : 'selecionadas') + (modeSel.value === 'juntas' ? ' numa imagem' : modeSel.value === 'separadas' ? ' separadas' : '')) + ' (' + n + ')';
        oneBtn.textContent = split ? 'Baixar em ' + split.parts.length + ' imagens, sem redução (' + n + ')' : 'Baixar numa imagem só (' + n + ')';
        if (split && modeSel.value !== 'separadas' && n > 1) cpBtn.textContent = 'Copiar parte ' + (split.next + 1) + ' de ' + split.parts.length;
        updateJoinInfo();
        delBtn.textContent = 'Apagar (' + n + ')';
        [dlBtn, zipBtn, oneBtn, cpBtn, delBtn].forEach((b) => { b.disabled = !n; b.style.opacity = n ? '1' : '.45'; });
      };
      const say = (t) => { msg.textContent = t; };
      const ordered = () => chosen().slice().reverse(); // na ordem em que foram feitas
      function updateJoinInfo() {
        joinInfo.textContent = '';
        const list = ordered();
        if (list.length < 2) { joinInfo.style.display = 'none'; return; }
        const lay = laySel.value, p = planJoin(sizesOf(list), lay);
        const big = Math.max(p.w, p.h);
        if (split) {
          joinInfo.append(mk('span', null, 'Dividido em ' + split.parts.length + ' imagens sem redução (' + split.parts.map((x) => x.length).join(' + ') + ' capturas).'));
          const undo = btn('Voltar a uma imagem só'); css(undo, { padding: '2px 8px', fontSize: '12px' });
          undo.addEventListener('click', () => { split = null; label(); });
          joinInfo.append(undo);
          joinInfo.style.display = 'flex';
          return;
        }
        if (p.k >= 1 && big <= JOIN_MAX * NEAR) { joinInfo.style.display = 'none'; return; }
        const text = p.k < 1
          ? 'Numa imagem só (' + LNAME[lay] + ') ficaria com ' + fmt(p.w) + ' × ' + fmt(p.h) + ' px, acima do limite de ' + fmt(JOIN_MAX) + ' px: seria reduzida para ' + pct(p.k) + ' (perde nitidez).'
          : 'Perto do limite: ' + LNAME[lay] + ' fica com ' + fmt(p.w) + ' × ' + fmt(p.h) + ' px (máximo ' + fmt(JOIN_MAX) + '). Com mais capturas, a imagem única começa a ser reduzida.';
        joinInfo.append(mk('span', null, text));
        // sugere o próximo arranjo na ordem (o outro em linha, depois a grade) que tiver mais folga
        const sug = NEXT[lay].map((l) => ({ l, q: planJoin(sizesOf(list), l) })).find((x) => x.q.k > p.k || (x.q.k >= 1 && Math.max(x.q.w, x.q.h) < big * 0.9));
        if (sug) {
          const b2 = btn('Usar ' + LNAME[sug.l] + (sug.q.k >= 1 ? ' (sem redução)' : ' (' + pct(sug.q.k) + ')'));
          css(b2, { padding: '2px 8px', fontSize: '12px' });
          b2.addEventListener('click', () => { laySel.value = sug.l; laySel.dispatchEvent(new Event('change')); });
          joinInfo.append(b2);
        }
        if (p.k < 1) {
          const parts = splitForLimit(list, lay);
          if (parts.length > 1) {
            const b3 = btn('Dividir em ' + parts.length + ' imagens sem redução');
            css(b3, { padding: '2px 8px', fontSize: '12px' });
            b3.addEventListener('click', () => { split = { parts, next: 0 }; label(); });
            joinInfo.append(b3);
          }
        }
        joinInfo.style.display = 'flex';
      }
      async function load() {
        recs = await store.list();
        sel.clear(); recs.forEach((r) => sel.add(r.id)); // todas marcadas: quem não desmarcar, leva tudo
        grid.textContent = '';
        if (!recs.length) grid.append(mk('div', { color: '#9aa0a6', gridColumn: '1 / -1', padding: '20px 0' }, 'Nenhuma captura guardada ainda. Clique nos elementos para capturar (marque "Só guardar" para capturar vários em sequência).'));
        for (const r of recs) {
          const item = mk('div', { background: '#2b3038', borderRadius: '8px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px', border: '2px solid #3b7cf0' });
          const top = mk('label', { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '12px', overflow: 'hidden' });
          const cb = mk('input'); cb.type = 'checkbox'; cb.checked = true;
          const nm = mk('span', { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, r.name.replace(/\.png$/, ''));
          nm.title = r.name + (r.url ? '\n' + r.url : '');
          top.append(cb, nm);
          const thumbBox = mk('div', { height: '120px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'repeating-conic-gradient(#3a3f47 0% 25%, #2b3038 0% 50%) 50% / 12px 12px', borderRadius: '4px', overflow: 'hidden', cursor: 'pointer' });
          const cv = mk('canvas', { maxWidth: '100%', maxHeight: '120px' });
          createImageBitmap(r.blob).then((b) => { const k = Math.min(1, 360 / b.width, 240 / b.height); cv.width = Math.max(1, Math.round(b.width * k)); cv.height = Math.max(1, Math.round(b.height * k)); cv.getContext('2d').drawImage(b, 0, 0, cv.width, cv.height); }).catch(() => {});
          thumbBox.append(cv);
          thumbBox.addEventListener('click', () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });
          const info = mk('div', { color: '#9aa0a6', fontSize: '11px' }, (r.width || '?') + ' × ' + (r.height || '?') + ' · ' + (r.site || '') + ' · ' + new Date(r.at).toLocaleTimeString());
          const btns = mk('div', { display: 'flex', gap: '6px' });
          const small = (t, title2) => { const b = btn(t); css(b, { padding: '3px 8px', fontSize: '12px' }); b.title = title2; return b; };
          const b1 = small('Baixar', 'Baixar esta captura'), b2 = small('Copiar', 'Copiar esta captura'), b3 = small('Apagar', 'Apagar esta captura');
          b1.addEventListener('click', () => saveBlob(r.blob, r.name));
          b2.addEventListener('click', async () => { try { await copyMany([r]); say('Copiada ✓'); } catch (e) { say('Não deu para copiar: ' + (e.message || e)); } });
          b3.addEventListener('click', async () => { await store.remove([r.id]); await load(); updateCount(); });
          btns.append(b1, b2, b3);
          cb.addEventListener('change', () => { split = null; if (cb.checked) sel.add(r.id); else sel.delete(r.id); item.style.borderColor = cb.checked ? '#3b7cf0' : 'transparent'; label(); });
          item.append(top, thumbBox, info, btns);
          grid.append(item);
        }
        label();
      }
      allBtn.addEventListener('click', () => grid.querySelectorAll('input[type=checkbox]').forEach((c) => { if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change')); } }));
      noneBtn.addEventListener('click', () => grid.querySelectorAll('input[type=checkbox]').forEach((c) => { if (c.checked) { c.checked = false; c.dispatchEvent(new Event('change')); } }));
      const stamp = () => 'capturas-' + slug(location.hostname) + '-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const bitmaps = (list) => Promise.all(list.map((r) => createImageBitmap(r.blob)));
      const busyRun = async (fn) => { [dlBtn, zipBtn, oneBtn, cpBtn].forEach((b) => { b.disabled = true; }); try { await fn(); } catch (e) { say('Não deu: ' + (e.message || e)); } finally { label(); } };
      dlBtn.addEventListener('click', () => busyRun(async () => {
        const list = chosen(), names = uniqueNames(list), o = outOpts();
        let files = list.map((r, i) => ({ blob: r.blob, name: names[i] })), extra = '';
        if (!plainOut()) {
          const res = await fitOutputs(await bitmaps(list), o, say);
          files = res.items.map((x, i) => ({ blob: x.blob, name: withExt(names[i], o.fmt) }));
          extra = ' (' + outSummary(res, o) + ')';
        }
        say('Baixando ' + files.length + '… (o navegador pode perguntar se o site pode baixar vários arquivos: permita)');
        for (const f of files) { saveBlob(f.blob, f.name); await new Promise((r) => setTimeout(r, 300)); }
        say(files.length + ' baixada(s) ✓' + extra);
      }));
      zipBtn.addEventListener('click', () => busyRun(async () => {
        const list = chosen(), names = uniqueNames(list), o = outOpts();
        let files = list.map((r, i) => ({ name: names[i], blob: r.blob })), extra = '';
        if (!plainOut()) {
          // no .zip o limite "no total" vale para o arquivo .zip (ele não comprime: é a soma das imagens)
          const res = await fitOutputs(await bitmaps(list), o, say);
          files = res.items.map((x, i) => ({ name: withExt(names[i], o.fmt), blob: x.blob }));
          extra = ' (' + outSummary(res, o) + ')';
        }
        say('Montando o .zip…');
        const z = await makeZip(files);
        saveBlob(z, stamp() + '.zip');
        say(list.length + ' captura(s) no .zip ✓ ' + fmtMB(z.size) + extra);
      }));
      oneBtn.addEventListener('click', () => busyRun(async () => {
        const list = ordered(), o = outOpts();
        const parts = split ? split.parts : [list];
        say('Juntando ' + list.length + ' capturas…');
        const canvases = [];
        for (const pt of parts) canvases.push(await joinCanvas(pt, joinOpts()));
        let blobs, extra = '';
        if (plainOut()) blobs = await Promise.all(canvases.map((c) => new Promise((ok) => c.toBlob(ok, 'image/png'))));
        else { const res = await fitOutputs(canvases, o, say); blobs = res.items.map((x) => x.blob); extra = ' · ' + outSummary(res, o); }
        for (let i = 0; i < blobs.length; i++) {
          saveBlob(blobs[i], stamp() + (blobs.length > 1 ? '-parte-' + (i + 1) : '') + '.' + EXTS[plainOut() ? 'png' : o.fmt]);
          if (blobs.length > 1) await new Promise((r) => setTimeout(r, 300));
        }
        const k = planJoin(sizesOf(list), laySel.value).k;
        say((parts.length > 1 ? list.length + ' capturas em ' + parts.length + ' imagens ✓' : list.length + ' capturas numa imagem só ✓' + (k < 1 ? ' (limite de 16.000 px: reduzida para ' + pct(k) + ')' : '')) + extra);
      }));
      /** Copia (sempre PNG para imagens; no HTML das separadas vale o formato escolhido). */
      const fitPng = async (src) => { const o = { ...outOpts(), fmt: 'png', per: 'total' }; const res = await fitOutputs([src], o, say); return { blob: res.items[0].blob, sum: outSummary(res, o) }; };
      cpBtn.addEventListener('click', () => busyRun(async () => {
        const list = chosen(), o = outOpts(), plain = plainOut();
        if (split && modeSel.value !== 'separadas' && list.length > 1) {
          const i = split.next, part = split.parts[i];
          const c = await joinCanvas(part, joinOpts());
          const out = plain ? { blob: await new Promise((ok) => c.toBlob(ok, 'image/png')), sum: '' } : await fitPng(c);
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': out.blob })]);
          split.next = (i + 1) % split.parts.length;
          say('Parte ' + (i + 1) + ' de ' + split.parts.length + ' copiada (' + part.length + ' capturas) ✓' + (out.sum ? ' · ' + out.sum : '') + (i + 1 < split.parts.length ? ' Cole e depois clique de novo para a próxima.' : ' Era a última.'));
          return;
        }
        if (plain) {
          const how = await copyMany(list.slice().reverse(), joinOpts()); // na ordem em que foram feitas
          say(how === 'imagem' ? 'Copiada ✓' : how === 'lote' ? list.length + ' capturas copiadas ✓ (em documentos e e-mails cada uma cola separada; em editores de imagem cola uma imagem com todas juntas)'
            : how === 'separadas' ? list.length + ' capturas copiadas separadas ✓ (só cola onde aceita várias imagens, como Docs, Word e Gmail)' : list.length + ' capturas copiadas numa imagem só ✓');
          const k = planJoin(sizesOf(list), laySel.value).k;
          if (how !== 'separadas' && how !== 'imagem' && k < 1) msg.textContent += ' A imagem única foi reduzida para ' + pct(k) + '.';
          return;
        }
        // com redução/limite/formato: monta cada representação ajustada
        const recsOrd = list.slice().reverse(), mode = list.length === 1 ? 'uma' : modeSel.value;
        const item = {}, notes = [];
        if (mode === 'uma') { const out = await fitPng(await createImageBitmap(recsOrd[0].blob)); item['image/png'] = out.blob; notes.push(out.sum); }
        if (mode === 'juntas' || mode === 'auto') { const out = await fitPng(await joinCanvas(recsOrd, joinOpts())); item['image/png'] = out.blob; notes.push((mode === 'auto' ? 'imagem única: ' : '') + out.sum); }
        if (mode === 'separadas' || mode === 'auto') {
          const res = await fitOutputs(await bitmaps(recsOrd), { ...o, per: o.per }, say);
          const urls = await Promise.all(res.items.map((x) => blobToDataUrl(x.blob)));
          item['text/html'] = new Blob(['<div>' + urls.map((u) => '<p><img src="' + u + '"></p>').join('') + '</div>'], { type: 'text/html' });
          notes.push((mode === 'auto' ? 'separadas: ' : '') + outSummary(res, o));
        }
        try { await navigator.clipboard.write([new ClipboardItem(item)]); }
        catch (e) { if (!item['image/png']) throw e; await navigator.clipboard.write([new ClipboardItem({ 'image/png': item['image/png'] })]); notes.push('só a imagem única'); }
        say((mode === 'uma' ? 'Copiada' : list.length + ' capturas copiadas' + (mode === 'juntas' ? ' numa imagem só' : mode === 'separadas' ? ' separadas' : '')) + ' ✓ · ' + notes.join(' · '));
      }));
      delBtn.addEventListener('click', async () => { await store.remove(chosen().map((r) => r.id)); await load(); updateCount(); say('Apagadas.'); });
      back.addEventListener('click', closePanel);
      quit.addEventListener('click', () => stop());
      limIn.addEventListener('change', async () => {
        const n = Math.max(1, Math.min(200, Math.round(Number(limIn.value) || DEFAULT_PREFS.limit)));
        limIn.value = String(n);
        prefs = await store.setPrefs({ limit: n });
        await load(); updateCount();
        say('Agora guarda as últimas ' + n + '.');
      });
      await load();
      if (window.__estudioPickerActive === me) me.gallery = { reload: load };
    }
    /** "Lembrar este elemento": monta um favorito que captura este mesmo elemento com um clique. */
    function favMaker(el) {
      const found = selectorFor(el);
      const box2 = mk('div', { borderTop: '1px solid #3a3f47', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' });
      box2.append(mk('div', { fontWeight: '600' }, '★ Lembrar este elemento (favorito que já captura ele)'));
      const line = mk('div', { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' });
      const field = (label, input) => { const l = mk('label', { display: 'flex', alignItems: 'center', gap: '5px', color: '#c3c7cd' }, label); l.append(input); return l; };
      const inputCss = { font: FONT, background: '#2b3038', color: '#fff', border: '1px solid #5b6370', borderRadius: '4px', padding: '3px 6px' };
      const nameIn = mk('input', { ...inputCss, width: '15em' });
      nameIn.value = ((target && target.name) || (document.title || location.hostname).slice(0, 30) + ' · ' + (el.id || el.tagName.toLowerCase())).slice(0, 50);
      const act = mk('select', inputCss);
      [['previa', 'mostrar a prévia'], ['baixar', 'baixar o PNG direto'], ['copiar', 'copiar direto']].forEach(([v, l]) => { const o = mk('option', null, l); o.value = v; act.append(o); });
      act.value = (target && target.action) || 'baixar';
      line.append(field('Nome', nameIn), field('Ao clicar:', act));
      const link = mk('a', { font: FONT, display: 'inline-block', padding: '5px 10px', borderRadius: '6px', background: '#e3b341', color: '#1f2329', fontWeight: '600', textDecoration: 'none', cursor: 'grab' });
      link.draggable = true;
      link.title = 'Arraste para a barra de favoritos';
      const copy = btn('Copiar código'), test = btn('Testar agora');
      const cfg = () => ({ name: nameIn.value.trim() || 'Elemento', sel: found.sel, alt: found.alt, padding: padding(), action: act.value, site: location.hostname });
      const refresh = () => { const c = cfg(); link.textContent = '★ ' + c.name; link.href = window.__estudioBookmarklet(c); };
      refresh();
      nameIn.addEventListener('input', refresh); act.addEventListener('change', refresh); padInput.addEventListener('input', refresh);
      link.addEventListener('click', (e) => { e.preventDefault(); toast('Arraste este botão para a barra de favoritos (Ctrl+Shift+B mostra a barra).', 3500); });
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(window.__estudioBookmarklet(cfg())); copy.textContent = 'Copiado ✓ (cole como endereço de um favorito novo)'; } catch (e) { copy.textContent = 'O site não deixou copiar'; }
      });
      test.addEventListener('click', () => { const c = cfg(); closePanel(); runTarget(c); });
      const line2 = mk('div', { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' });
      line2.append(link, copy, test);
      box2.append(line, line2);
      const sel = mk('code', { font: '11px ui-monospace, Menlo, Consolas, monospace', color: '#9aa0a6', wordBreak: 'break-all' }, found.sel);
      const help = mk('div', { color: '#9aa0a6', fontSize: '12px', maxWidth: '75ch' }, 'Arraste o botão amarelo para a barra de favoritos. Nesta página (ou noutra com a mesma estrutura), um clique nele captura o elemento sem precisar escolher. O elemento é achado por: ');
      help.append(sel);
      box2.append(help);
      return box2;
    }
    /** Captura direto o elemento lembrado; se não achar, volta para a escolha manual. */
    async function runTarget(t) {
      target = t;
      const tg = t;
      hint.textContent = 'Procurando “' + tg.name + '”…';
      busy = true;
      const el = await findTarget(tg, 4000);
      busy = false;
      if (!el) { hint.textContent = 'Não achei “' + tg.name + '” nesta página. Escolha o elemento de novo: passe o mouse e clique · Esc sai'; return; }
      hint.textContent = 'Capturando “' + tg.name + '”…';
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      show(el);
      await new Promise((r) => setTimeout(r, 300));
      await shoot(el, true);
      hint.textContent = 'Passe o mouse e clique no elemento · ↑ pai · ↓ filho · Esc sai';
    }
    function closePanel() { if (panel) { URL.revokeObjectURL(panel.url || ''); panel.el.remove(); panel = null; } if (lastXY) pick(lastXY[0], lastXY[1]); }
    function openPanel(blob, note, el) {
      show(null);
      const wrap = mk('div', { position: 'fixed', inset: '0', background: 'rgba(10,12,16,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto', font: FONT });
      const card = mk('div', { background: '#1f2329', color: '#e8eaed', borderRadius: '10px', padding: '14px', maxWidth: 'min(92vw, 1100px)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', gap: '10px', boxShadow: '0 10px 40px rgba(0,0,0,.5)' });
      const title = mk('div', { fontWeight: '600' }, blob ? 'Captura de ' + describe(el) : 'Captura');
      card.append(title);
      const url = blob ? URL.createObjectURL(blob) : '';
      if (blob) {
        const view = mk('div', { overflow: 'auto', maxHeight: '65vh', background: 'repeating-conic-gradient(#3a3f47 0% 25%, #2b3038 0% 50%) 50% / 16px 16px', borderRadius: '6px' });
        // prévia num canvas (sites com CSP rígido bloqueiam <img src="blob:...">)
        const cv = mk('canvas', { display: 'block', maxWidth: '100%', height: 'auto' });
        createImageBitmap(blob).then((bmp) => {
          cv.width = bmp.width; cv.height = bmp.height;
          cv.getContext('2d').drawImage(bmp, 0, 0);
          size.textContent = bmp.width + ' × ' + bmp.height + ' px · ' + Math.round(blob.size / 1024) + ' KB';
        }).catch(() => {});
        view.append(cv);
        card.append(view);
      }
      const size = mk('div', { color: '#9aa0a6', fontSize: '12px' }, '');
      card.append(size);
      if (note) card.append(mk('div', { color: blob ? '#e3b341' : '#ff9a8f', fontSize: '12px', maxWidth: '60ch' }, note));
      const row = mk('div', { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' });
      const name = fileName(el);
      if (!blob) { const retry = btn('Tentar de novo', true); retry.addEventListener('click', () => { closePanel(); shoot(el); }); row.append(retry); }
      if (blob) {
        const dl = btn('Baixar PNG', true), cp = btn('Copiar');
        dl.addEventListener('click', () => saveBlob(blob, name));
        cp.addEventListener('click', async () => {
          try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); cp.textContent = 'Copiado ✓'; } catch { cp.textContent = 'O site não deixou copiar'; }
        });
        row.append(dl, cp);
      }
      const again = btn('Outro elemento'), quit = btn('Sair'), gal = btn('Ver capturas');
      gal.addEventListener('click', () => { closePanel(); openGallery(); });
      row.append(gal);
      again.addEventListener('click', closePanel);
      quit.addEventListener('click', () => stop());
      row.append(again, quit);
      if (blob) card.append(favMaker(el));
      card.append(row);
      wrap.append(card);
      wrap.addEventListener('click', (e) => { if (e.target === wrap) closePanel(); });
      root.append(wrap);
      panel = { el: wrap, url, name };
      if (window.__estudioPickerActive) window.__estudioPickerActive.last = blob;
      if (opts.onCapture && blob) opts.onCapture({ blob, name, element: describe(el) });
    }
    /** keepShare: depois de um favorito de elemento, o compartilhamento fica mais 3 minutos (clicar no
     *  favorito de novo nesta página não pergunta outra vez); o normal é encerrar ao sair. */
    function stop(keepShare) {
      if (stopped) return;
      stopped = true;
      clearInterval(shareTimer);
      if (window.__estudioReleaseDisplay) window.__estudioReleaseDisplay(keepShare === true ? 180000 : 0);
      removeEventListener('mousemove', onMove, true);
      ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick'].forEach((t) => removeEventListener(t, block, opt));
      removeEventListener('click', onClick, opt);
      removeEventListener('keydown', onKey, true);
      removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', onScroll, true);
      document.documentElement.style.cursor = prevCursor;
      if (panel) URL.revokeObjectURL(panel.url || '');
      host.remove();
      if (window.__estudioPickerActive === me) window.__estudioPickerActive = null;
    }
    const me = { stop, ui: root };
    window.__estudioPickerActive = me;
    if (target) runTarget(target);
  };

  /**
   * Captura pelo compartilhamento de tela do próprio navegador (favorito): o navegador pergunta uma vez
   * por captura se pode compartilhar esta aba; o quadro é recortado nas coordenadas do elemento (lidas
   * depois que a barra de compartilhamento aparece). Só pega o que está visível na tela.
   */
  /**
   * Onde a página (a área visível) está dentro de um quadro capturado. Quando se compartilha uma janela
   * ou a tela inteira (o Firefox não captura só a aba), o quadro tem também a barra de título, as abas,
   * a barra de endereço e, na tela inteira, os painéis do sistema. Para achar a página com precisão, dois
   * quadrados piscam (preto → branco) nos cantos da página; o que mudou entre os dois quadros são eles.
   * diff(a, b): ImageData antes/depois; cw/ch: tamanho da área visível da página (CSS px).
   * Devolve { x, y, sx, sy } (canto e escala em pixels do quadro) ou null.
   */
  function findViewport(a, b, cw, ch, M) {
    const w = a.width, h = a.height, A = a.data, B = b.data;
    const I = new Int32Array((w + 1) * (h + 1)); // imagem integral da máscara "mudou muito"
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 4;
        row += Math.abs(A[k] - B[k]) + Math.abs(A[k + 1] - B[k + 1]) + Math.abs(A[k + 2] - B[k + 2]) > 360 ? 1 : 0;
        I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
      }
    }
    const changed = (x, y) => { const k = (y * w + x) * 4; return Math.abs(A[k] - B[k]) + Math.abs(A[k + 1] - B[k + 1]) + Math.abs(A[k + 2] - B[k + 2]) > 360; };
    const box = (x, y, m) => I[(y + m) * (w + 1) + x + m] - I[y * (w + 1) + x + m] - I[(y + m) * (w + 1) + x] + I[y * (w + 1) + x];
    /** Janela m×m quase toda "mudou": a de menor (ou maior) x+y. */
    function corner(m, last) {
      let best = null;
      const full = m * m * 0.92;
      for (let y = 0; y + m <= h; y++) for (let x = 0; x + m <= w; x++) {
        if (box(x, y, m) < full) continue;
        if (!best || (last ? x + y > best.x + best.y : x + y < best.x + best.y)) best = { x, y };
      }
      return best;
    }
    // 1) quadrado de cima à esquerda: acha, vai até as bordas dele e mede o tamanho
    const m0 = Math.max(5, Math.min(20, Math.floor((M * w) / (cw * 4))));
    const tl = corner(m0, false);
    if (!tl) return null;
    // a janela pode ter ficado um pouco para fora ou para dentro do quadrado: acerta as duas bordas
    const cy0 = tl.y + (m0 >> 1), cx0 = tl.x + (m0 >> 1);
    while (tl.x < cx0 && !changed(tl.x, cy0)) tl.x++;
    while (tl.x > 0 && changed(tl.x - 1, cy0)) tl.x--;
    while (tl.y < cy0 && !changed(cx0, tl.y)) tl.y++;
    while (tl.y > 0 && changed(cx0, tl.y - 1)) tl.y--;
    let tw = 0, th = 0;
    while (tl.x + tw < w && changed(tl.x + tw, tl.y + (m0 >> 1))) tw++;
    while (tl.y + th < h && changed(tl.x + (m0 >> 1), tl.y + th)) th++;
    if (tw < 6 || Math.abs(tw - th) > Math.max(2, tw * 0.06)) return null; // não é o quadrado
    // 2) o de baixo à direita tem que ter o mesmo tamanho (o relógio do painel, por exemplo, não serve)
    const m1 = Math.max(5, Math.floor(Math.min(tw, th) * 0.85));
    const brw = corner(m1, true);
    if (!brw) return null;
    let rx = brw.x + m1, ry = brw.y + m1;
    const cy1 = brw.y + (m1 >> 1), cx1 = brw.x + (m1 >> 1);
    while (rx > cx1 && !changed(rx - 1, cy1)) rx--;
    while (rx < w && changed(rx, cy1)) rx++;
    while (ry > cy1 && !changed(cx1, ry - 1)) ry--;
    while (ry < h && changed(cx1, ry)) ry++;
    let bw = 0, bh = 0;
    while (rx - bw - 1 >= 0 && changed(rx - bw - 1, cy1)) bw++;
    while (ry - bh - 1 >= 0 && changed(cx1, ry - bh - 1)) bh++;
    if (Math.abs(bw - tw) > Math.max(2, tw * 0.06) || Math.abs(bh - th) > Math.max(2, th * 0.06)) return null;
    const sx = (rx - tl.x) / cw, sy = (ry - tl.y) / ch;
    if (!(sx > 0.2 && sy > 0.2) || Math.abs(sx - sy) / sx > 0.04 || Math.abs(tw / M - sx) / sx > 0.1) return null;
    return { x: tl.x, y: tl.y, sx, sy };
  }
  window.__estudioFindViewport = findViewport; // para testes

  /**
   * Captura pelo compartilhamento de tela do próprio navegador (favorito). No Chrome e no Edge dá para
   * compartilhar só esta aba (o quadro é a própria página). No Firefox, ou se você escolher uma janela ou
   * a tela inteira, a página é localizada no quadro pelos quadrados que piscam nos cantos (findViewport).
   * Só pega o que está visível na tela.
   */
  // ---------------------------------------------------------------- captura pelo compartilhamento de tela
  // O navegador não deixa guardar a permissão de compartilhar a tela (ele pergunta a cada pedido, por
  // segurança). Então o compartilhamento aberto na primeira captura fica ligado enquanto o seletor está
  // aberto: as próximas capturas usam o mesmo, sem perguntar. "Sair" (ou fechar a página) encerra.
  let session = null; // { stream, track, video, ic, surface, useVideo }
  const timeout = (pr, ms, msg) => Promise.race([pr, new Promise((_, no) => setTimeout(() => no(new Error(msg)), ms))]);
  const toCanvas = (src, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0); return c; };
  /** A captura só manda quadro novo quando algo muda na tela: um ponto quase invisível pisca no canto. */
  function startNudge() {
    const n = document.createElement('div');
    css(n, { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', zIndex: Z, pointerEvents: 'none', background: 'rgba(0,0,0,0.01)' });
    document.documentElement.append(n);
    let k = 0, alive = true;
    const blink = () => { if (!alive) return; n.style.background = (k++ & 1) ? 'rgba(0,0,0,0.01)' : 'rgba(0,0,0,0.03)'; requestAnimationFrame(blink); };
    requestAnimationFrame(blink);
    return () => { alive = false; n.remove(); };
  }
  function closeSession() {
    if (!session) return;
    const s = session;
    session = null;
    s.stream.getTracks().forEach((t) => t.stop());
    s.video.srcObject = null;
  }
  let releaseTimer = 0;
  window.__estudioReleaseDisplay = (laterMs) => {
    clearTimeout(releaseTimer);
    if (laterMs) releaseTimer = setTimeout(closeSession, laterMs); else closeSession();
  };
  window.__estudioKeepDisplay = () => clearTimeout(releaseTimer);
  window.__estudioDisplayActive = () => !!(session && session.track.readyState === 'live');
  addEventListener('pagehide', closeSession);

  async function openSession(waitMs) {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser', frameRate: 30 }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude' });
    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    // quadros: pelo ImageCapture quando existe (Chrome/Edge: direto da trilha; o <video> fora da página
    // às vezes não começa a tocar), senão pelo <video> (Firefox)
    const ic = typeof window.ImageCapture === 'function' ? new window.ImageCapture(track) : null;
    const s = { stream, track, video, ic, surface: (track.getSettings && track.getSettings().displaySurface) || '', useVideo: !ic };
    track.addEventListener('ended', () => { if (session === s) session = null; }); // "Parar de compartilhar" do navegador
    const stopNudge = startNudge();
    try {
      video.play().catch(() => {});
      // primeiro quadro: o que chegar antes, pelo ImageCapture ou pelo <video>
      await new Promise((ok, no) => {
        let done = false;
        const finish = (err) => { if (done) return; done = true; clearInterval(iv); if (err) no(err); else ok(); };
        if (ic) ic.grabFrame().then((bmp) => { bmp.close && bmp.close(); finish(); }, () => { s.useVideo = true; });
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (video.readyState >= 2 && video.videoWidth) finish();
          else if (Date.now() - t0 > waitMs) finish(Object.assign(new Error('a captura da tela não começou.'), { noFrames: true }));
          else if (video.paused) video.play().catch(() => {});
        }, 50);
      });
      // a barra "compartilhando…" pode mudar o tamanho da página: espera assentar
      await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      throw e;
    } finally { stopNudge(); }
    return s;
  }

  async function captureWith(s, el, info) {
    const p = info.padding || 0;
    const extra = [];
    const { video, ic } = s;
    const nextFrame = () => new Promise((r) => { const t = setTimeout(r, 250); if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => { clearTimeout(t); r(); }); });
    const settle = async (n) => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); for (let i = 0; i < n; i++) await nextFrame(); };
    const grab = async () => {
      if (!s.useVideo) {
        try { const bmp = await timeout(ic.grabFrame(), 3000, 'sem quadro'); const c = toCanvas(bmp, bmp.width, bmp.height); bmp.close && bmp.close(); return c; } catch (e) { s.useVideo = true; }
      }
      if (video.paused) video.play().catch(() => {});
      return toCanvas(video, video.videoWidth, video.videoHeight);
    };
    const stopNudge = startNudge();
    let place = null, note = '';
    try {
      await settle(3);
      if (s.surface !== 'browser') {
        // janela ou tela inteira: acha a página no quadro pelos quadrados que piscam nos cantos
        // (refeito a cada captura: a janela pode ter mudado de lugar ou de tamanho)
        const M = 40, cw = document.documentElement.clientWidth, ch = document.documentElement.clientHeight;
        const sq = (pos) => { const d = document.createElement('div'); css(d, { position: 'fixed', width: M + 'px', height: M + 'px', zIndex: Z, pointerEvents: 'none', background: '#000', ...pos }); document.documentElement.append(d); extra.push(d); return d; };
        const a = sq({ left: '0', top: '0' }), b = sq({ right: '0', bottom: '0' });
        await settle(3);
        await grab();
        const f1 = await grab();
        a.style.background = b.style.background = '#fff';
        await settle(3);
        await grab();
        const f2 = await grab();
        a.remove(); b.remove();
        const g1 = f1.getContext('2d').getImageData(0, 0, f1.width, f1.height), g2 = f2.getContext('2d').getImageData(0, 0, f2.width, f2.height);
        place = findViewport(g1, g2, cw, ch, M);
        if (!place) {
          // sem achar os quadrados: estima pela diferença entre o tamanho da janela e o da página
          const vw = f2.width, border = Math.max(0, (outerWidth - innerWidth) / 2), k = vw / (s.surface === 'monitor' ? screen.width : outerWidth);
          place = s.surface === 'monitor'
            ? { x: (screenX + border) * k, y: (screenY + outerHeight - innerHeight - border) * k, sx: k, sy: k }
            : { x: border * k, y: (outerHeight - innerHeight - border) * k, sx: k, sy: k };
          note = 'Não consegui localizar a página com precisão na imagem compartilhada; o recorte pode ter saído um pouco deslocado. No Chrome ou no Edge, escolha compartilhar "Esta aba".';
        }
        await settle(3); // quadro final, já sem os quadrados
      }
    } finally { stopNudge(); extra.forEach((d) => d.remove()); }
    await grab();
    const frame = await grab();
    if (!place) { const k = frame.width / innerWidth; place = { x: 0, y: 0, sx: k, sy: k }; }
    const r = el.getBoundingClientRect();
    const W = document.documentElement.clientWidth || innerWidth, H = document.documentElement.clientHeight || innerHeight;
    const x0 = Math.max(0, r.left - p), y0 = Math.max(0, r.top - p), x1 = Math.min(W, r.right + p), y1 = Math.min(H, r.bottom + p);
    if (x1 <= x0 || y1 <= y0) throw new Error('O elemento não está visível na tela.');
    if (!note && (r.top - p < 0 || r.bottom + p > H || r.left - p < 0 || r.right + p > W)) note = 'O elemento é maior que a tela: saiu só a parte visível. A extensão captura o elemento inteiro.';
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((x1 - x0) * place.sx)); c.height = Math.max(1, Math.round((y1 - y0) * place.sy));
    c.getContext('2d').drawImage(frame, place.x + x0 * place.sx, place.y + y0 * place.sy, (x1 - x0) * place.sx, (y1 - y0) * place.sy, 0, 0, c.width, c.height);
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    return { blob, note };
  }

  /** Captura de um elemento pelo compartilhamento de tela (favorito). info: { padding, keep } */
  window.__estudioCaptureDisplay = async function (el, info) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error('Este navegador não permite capturar a tela. Use o Chrome, o Edge ou o Firefox no computador, ou a extensão.');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (!window.__estudioDisplayActive()) {
      closeSession();
      // às vezes a captura começa sem mandar quadros (logo depois de abrir a página): tenta mais uma vez
      try { session = await openSession(2500); } catch (e) {
        if (!(e && e.noFrames && (!navigator.userActivation || navigator.userActivation.isActive))) throw e;
        session = await openSession(6000);
      }
    }
    try { return await captureWith(session, el, info); }
    catch (e) { closeSession(); throw e; }
    finally { if (info && info.keep === false) closeSession(); }
  };
})();
