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
  const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'elemento';

  window.__estudioPicker = function start(opts) {
    if (window.__estudioPickerActive) { window.__estudioPickerActive.stop(); if (!opts.target) return; }
    let target = opts.target || null, stopped = false;
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
    bar.append(hint, padLabel, close);
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
      if (blob && target && target.action === 'baixar' && auto) { saveBlob(blob, fileName(el)); toast('“' + target.name + '” baixado ✓'); setTimeout(stop, 1800); return; }
      if (blob && target && target.action === 'copiar' && auto) {
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('“' + target.name + '” copiado ✓'); setTimeout(stop, 1800); return; } catch (e) { note = note || 'Não deu para copiar direto (o site não deixou); use os botões.'; }
      }
      openPanel(blob, note, el);
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
      const again = btn('Outro elemento'), quit = btn('Sair');
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
    function stop() {
      if (stopped) return;
      stopped = true;
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
  window.__estudioCaptureDisplay = async function (el, info) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error('Este navegador não permite capturar a aba. Use o Chrome ou o Edge no computador, ou a extensão.');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const p = info.padding || 0;
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser', frameRate: 30 }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude' });
    const track = stream.getVideoTracks()[0];
    try {
      const surface = track.getSettings ? track.getSettings().displaySurface : 'browser';
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.srcObject = stream;
      // a captura da aba só manda quadro novo quando algo muda na tela: um ponto quase invisível
      // (1 pixel, transparência de 1/255) pisca no canto enquanto esperamos o quadro certo
      const nudge = document.createElement('div');
      css(nudge, { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', zIndex: Z, pointerEvents: 'none', background: 'rgba(0,0,0,0.002)' });
      document.documentElement.append(nudge);
      let k = 0, alive = true;
      const blink = () => { if (!alive) return; nudge.style.background = (k++ & 1) ? 'rgba(0,0,0,0.002)' : 'rgba(0,0,0,0.003)'; requestAnimationFrame(blink); };
      requestAnimationFrame(blink);
      const nextFrame = () => new Promise((r) => { const t = setTimeout(r, 250); if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => { clearTimeout(t); r(); }); });
      try {
        await Promise.race([video.play(), new Promise((_, no) => setTimeout(() => no(new Error('a captura da aba não começou.')), 4000))]);
        // a barra "compartilhando esta aba" pode mudar o tamanho da página: espera assentar
        await new Promise((r) => setTimeout(r, 400));
        for (let i = 0; i < 3; i++) await nextFrame();
      } finally { alive = false; nudge.remove(); }
      const vw = video.videoWidth;
      const c = document.createElement('canvas');
      let note = '';
      {
        const r = el.getBoundingClientRect();
        const s = vw / innerWidth;
        const x0 = Math.max(0, r.left - p), y0 = Math.max(0, r.top - p), x1 = Math.min(innerWidth, r.right + p), y1 = Math.min(innerHeight, r.bottom + p);
        if (x1 <= x0 || y1 <= y0) throw new Error('O elemento não está visível na tela.');
        if (r.top - p < 0 || r.bottom + p > innerHeight || r.left - p < 0 || r.right + p > innerWidth) note = 'O elemento é maior que a tela: saiu só a parte visível. A extensão captura o elemento inteiro.';
        c.width = Math.round((x1 - x0) * s); c.height = Math.round((y1 - y0) * s);
        c.getContext('2d').drawImage(video, x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s, 0, 0, c.width, c.height);
      }
      if (surface && surface !== 'browser') note = 'Você compartilhou uma janela ou tela inteira, não a aba: o recorte pode ter saído deslocado. Na próxima, escolha "Esta aba".';
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return { blob, note };
    } finally { stream.getTracks().forEach((t) => t.stop()); }
  };
})();
