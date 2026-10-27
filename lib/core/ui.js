// Utilidades de interface compartilhadas por todo o site (usa os componentes do Bootstrap).

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function slug(s, max = 40) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, 'e').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
}
export function mmss(t) {
  const s = Math.max(0, Math.floor(t || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
/** "1:23" ou "83" -> segundos; vazio ou inválido -> null. */
export function parseTime(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some((x) => !Number.isFinite(x) || x < 0)) return null;
  return parts.reduce((a, b) => a * 60 + b, 0);
}
export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Baixa um arquivo. `data` pode ser texto, Blob ou objeto (vira JSON). */
export function download(name, data, type = 'text/plain') {
  const blob = data instanceof Blob ? data
    : typeof data === 'string' ? new Blob([data], { type: type + ';charset=utf-8' })
      : new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[\\/:*?"<>|]+/g, '-');
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const scripts = {};
export function loadScript(src) {
  scripts[src] ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res;
    s.onerror = () => { delete scripts[src]; rej(new Error('Falha ao carregar ' + src)); };
    document.head.append(s);
  });
  return scripts[src];
}

/** Lê/grava um objeto no localStorage com valores padrão. */
export function store(key, defaults) {
  let data;
  try { data = { ...structuredClone(defaults), ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { data = structuredClone(defaults); }
  return {
    data,
    save() {
      try { localStorage.setItem(key, JSON.stringify(data)); return true; } catch { toast('Não foi possível salvar: o armazenamento do navegador está cheio ou bloqueado.', 'danger'); return false; }
    },
  };
}

// ---------------------------------------------------------------- avisos
export function toast(msg, kind = 'dark') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.className = 'toast-container position-fixed bottom-0 start-50 translate-middle-x p-3';
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast align-items-center border-0 text-bg-${kind}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `<div class="d-flex"><div class="toast-body">${esc(msg)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Fechar"></button></div>`;
  box.append(el);
  const t = window.bootstrap.Toast.getOrCreateInstance(el, { delay: 4000 });
  el.addEventListener('hidden.bs.toast', () => el.remove());
  t.show();
}

// ---------------------------------------------------------------- janelas
/**
 * Janela (modal do Bootstrap). Retorna { el, body, footer, close() }.
 * `onClose` roda quando ela fecha por qualquer motivo. size: 'sm' | 'lg' | 'xl'.
 */
export function modal({ title = '', body = '', footer = null, size = '', onClose = null, scrollable = true } = {}) {
  const el = document.createElement('div');
  el.className = 'modal fade';
  el.tabIndex = -1;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<div class="modal-dialog modal-dialog-centered ${scrollable ? 'modal-dialog-scrollable' : ''} ${size ? 'modal-' + size : ''} modal-fullscreen-sm-down">
    <div class="modal-content">
      <div class="modal-header"><h2 class="modal-title fs-5"></h2><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button></div>
      <div class="modal-body"></div>
      <div class="modal-footer"${footer === null ? ' hidden' : ''}></div>
    </div></div>`;
  el.querySelector('.modal-title').textContent = title;
  const bodyEl = el.querySelector('.modal-body');
  const footEl = el.querySelector('.modal-footer');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  if (typeof footer === 'string') footEl.innerHTML = footer;
  document.body.append(el);
  const m = new window.bootstrap.Modal(el);
  el.addEventListener('hidden.bs.modal', () => { onClose?.(); m.dispose(); el.remove(); });
  m.show();
  return { el, body: bodyEl, footer: footEl, close: () => m.hide(), setTitle: (t) => { el.querySelector('.modal-title').textContent = t; } };
}

/**
 * Painel lateral sem fundo escuro (offcanvas). Usado quando a tela não pode ficar coberta,
 * por exemplo enquanto o player do YouTube toca.
 */
export function panel({ title = '', body = '', onClose = null } = {}) {
  const el = document.createElement('div');
  el.className = 'offcanvas offcanvas-start side-panel';
  el.tabIndex = -1;
  el.setAttribute('data-bs-backdrop', 'false');
  el.setAttribute('data-bs-scroll', 'true');
  el.innerHTML = `<div class="offcanvas-header"><h2 class="offcanvas-title fs-5"></h2><button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="Fechar"></button></div><div class="offcanvas-body"></div>`;
  el.querySelector('.offcanvas-title').textContent = title;
  const bodyEl = el.querySelector('.offcanvas-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  document.body.append(el);
  const o = new window.bootstrap.Offcanvas(el);
  el.addEventListener('hidden.bs.offcanvas', () => { onClose?.(); o.dispose(); el.remove(); });
  o.show();
  return { el, body: bodyEl, close: () => o.hide(), setTitle: (t) => { el.querySelector('.offcanvas-title').textContent = t; } };
}

/** Confirmação. Resolve true/false. */
export function confirmBox(message, { ok = 'Confirmar', cancel = 'Cancelar', danger = false, title = 'Confirmar' } = {}) {
  return new Promise((resolve) => {
    let answer = false;
    const m = modal({
      title, size: 'sm', scrollable: false,
      body: `<p class="mb-0">${esc(message)}</p>`,
      footer: `<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">${esc(cancel)}</button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(ok)}</button>`,
      onClose: () => resolve(answer),
    });
    m.footer.querySelector('[data-ok]').onclick = () => { answer = true; m.close(); };
  });
}

/** Pergunta um texto. Resolve o texto ou null. */
export function promptBox(message, value = '', { ok = 'OK', title = '' } = {}) {
  return new Promise((resolve) => {
    let answer = null;
    const m = modal({
      title: title || message, size: 'sm', scrollable: false,
      body: `<form><label class="form-label${title ? '' : ' visually-hidden'}" for="pb-in">${esc(message)}</label><input class="form-control" id="pb-in" type="text"></form>`,
      footer: `<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button><button type="button" class="btn btn-primary" data-ok>${esc(ok)}</button>`,
      onClose: () => resolve(answer),
    });
    const inp = m.body.querySelector('input');
    inp.value = value;
    m.el.addEventListener('shown.bs.modal', () => { inp.focus(); inp.select(); });
    const done = () => { answer = inp.value.trim(); m.close(); };
    m.footer.querySelector('[data-ok]').onclick = done;
    m.body.querySelector('form').onsubmit = (e) => { e.preventDefault(); done(); };
  });
}

/** Barra de progresso do Bootstrap: retorna o HTML. */
export function progressHtml(id) {
  return `<div class="progress" role="progressbar" aria-label="Progresso" style="height:8px"><div class="progress-bar" id="${id}" style="width:0%"></div></div>`;
}
export function setProgress(el, frac) {
  if (!el) return;
  el.style.width = Math.round(clamp(frac || 0, 0, 1) * 100) + '%';
}

/** Valor em espera de um elemento: liga/desliga um spinner no botão. */
export function busyButton(btn, on, text = null) {
  if (!btn) return;
  if (on) {
    btn.dataset.label ||= btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm" aria-hidden="true"></span> ${esc(text || 'Aguarde…')}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }
  }
}
