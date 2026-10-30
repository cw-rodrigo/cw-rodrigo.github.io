// Seletor de elemento no estilo do "inspecionar" do DevTools: passe o mouse para destacar,
// clique para capturar só aquele elemento. Arquivo sem módulos (vira favorito e entra na extensão).
// Uso: window.__estudioPicker({ capture: async (el, info) => Blob, mode: 'favorito' | 'extensão' })
// Só usa DOM e CSSOM (nada de innerHTML nem <style>), para funcionar em sites com CSP e Trusted Types.
(function () {
  if (window.__estudioPicker) return;
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
  const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'elemento';

  window.__estudioPicker = function start(opts) {
    if (window.__estudioPickerActive) { window.__estudioPickerActive.stop(); return; }
    const host = mk('div', { all: 'initial', position: 'fixed', inset: '0', zIndex: Z, pointerEvents: 'none' });
    const root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
    const box = mk('div', { position: 'fixed', boxSizing: 'border-box', border: '2px solid #3b7cf0', background: 'rgba(59,124,240,.18)', borderRadius: '2px', pointerEvents: 'none', display: 'none', transition: 'all 40ms linear' });
    const pad = mk('div', { position: 'fixed', boxSizing: 'border-box', border: '1px dashed rgba(59,124,240,.9)', pointerEvents: 'none', display: 'none' });
    const tag = mk('div', { position: 'fixed', font: '12px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', background: '#1f2329', color: '#fff', padding: '3px 7px', borderRadius: '4px', pointerEvents: 'none', whiteSpace: 'nowrap', maxWidth: '80vw', overflow: 'hidden', textOverflow: 'ellipsis', display: 'none', boxShadow: '0 2px 8px rgba(0,0,0,.35)' });
    const bar = mk('div', { position: 'fixed', top: '10px', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', font: FONT, background: '#1f2329', color: '#e8eaed', padding: '7px 10px', borderRadius: '8px', boxShadow: '0 4px 18px rgba(0,0,0,.4)', pointerEvents: 'auto', maxWidth: 'calc(100vw - 20px)' });
    const hint = mk('span', null, 'Passe o mouse e clique no elemento · ↑ pai · ↓ filho · Esc sai');
    const padLabel = mk('label', { display: 'flex', alignItems: 'center', gap: '4px', color: '#c3c7cd' }, 'Margem');
    const padInput = mk('input', { width: '48px', font: FONT, background: '#2b3038', color: '#fff', border: '1px solid #5b6370', borderRadius: '4px', padding: '2px 4px' });
    padInput.type = 'number'; padInput.min = '0'; padInput.max = '200'; padInput.value = String(opts.padding || 0);
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
    const block = (e) => { if (panel || ours(e.composedPath()[0]) || e.composedPath().includes(host)) return; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    const onClick = (e) => {
      if (panel || e.composedPath().includes(host)) return;
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

    const frames = (n) => new Promise((r) => { const f = () => (n-- <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    async function shoot(el) {
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
      openPanel(blob, note, el);
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
      const name = slug(location.hostname.replace(/^www\./, '')) + '-' + slug(describe(el)) + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.png';
      if (blob) {
        const dl = btn('Baixar PNG', true), cp = btn('Copiar');
        dl.addEventListener('click', () => { const a = mk('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); });
        cp.addEventListener('click', async () => {
          try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); cp.textContent = 'Copiado ✓'; } catch { cp.textContent = 'O site não deixou copiar'; }
        });
        row.append(dl, cp);
      }
      const again = btn('Outro elemento'), quit = btn('Sair');
      again.addEventListener('click', closePanel);
      quit.addEventListener('click', () => stop());
      row.append(again, quit);
      card.append(row);
      wrap.append(card);
      wrap.addEventListener('click', (e) => { if (e.target === wrap) closePanel(); });
      root.append(wrap);
      panel = { el: wrap, url, name };
      if (window.__estudioPickerActive) window.__estudioPickerActive.last = blob;
      if (opts.onCapture && blob) opts.onCapture({ blob, name, element: describe(el) });
    }
    function stop() {
      removeEventListener('mousemove', onMove, true);
      ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick'].forEach((t) => removeEventListener(t, block, opt));
      removeEventListener('click', onClick, opt);
      removeEventListener('keydown', onKey, true);
      removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', onScroll, true);
      document.documentElement.style.cursor = prevCursor;
      if (panel) URL.revokeObjectURL(panel.url || '');
      host.remove();
      window.__estudioPickerActive = null;
    }
    window.__estudioPickerActive = { stop, ui: root };
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
