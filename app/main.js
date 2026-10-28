// App único: menu, rotas (#/seção/...), carregamento das seções sob demanda e service worker.
import * as P from '/lib/youtube/player.js';
import * as PM from '/lib/pocketmaster/session.js';
import * as C from '/lib/core/cloud.js';
import { onSyncStatus, syncStatus } from '/lib/core/sync.js';
import { $, $$ } from '/lib/core/ui.js';
import { installAgentApi } from '/lib/agent/webmcp.js';
import { startBridge } from '/lib/agent/bridge.js';

const view = $('#view');
const SECTIONS = {
  '': () => import('./home.js'),
  cifras: () => import('./cifras/cifras.js'),
  timbres: () => import('./timbres/timbres.js'),
  ferramentas: () => import('./tools/index.js'),
  conta: () => import('./account.js'),
  sintetizador: () => import('./synth/synth.js'),
  daw: () => import('./daw/daw.js'),
  agentes: () => import('./agentes.js'),
};
const TOOLS = {
  tom: () => import('./tools/tom.js'),
  acordes: () => import('./tools/acordes.js'),
  separar: () => import('./tools/separar.js'),
  comparar: () => import('./tools/comparar.js'),
  pedaleira: () => import('./tools/pedaleira.js'),
};

export function parseHash() {
  let h = location.hash.slice(1) || '/';
  try { h = decodeURI(h); } catch { /* endereço malformado: usa como está */ }
  const [path, qs] = h.split('?');
  return { parts: path.split('/').filter(Boolean), q: Object.fromEntries(new URLSearchParams(qs || '')), path };
}

let current = { key: null, mod: null, cleanup: null };
let lastHash = location.hash;
let ignoreNext = false;

async function route() {
  if (ignoreNext) { ignoreNext = false; return; }
  // seção com alterações não salvas pode pedir para ficar
  if (current.mod?.canLeave && !(await current.mod.canLeave())) {
    ignoreNext = true;
    location.hash = lastHash;
    return;
  }
  lastHash = location.hash;
  const r = parseHash();
  let [a, b] = r.parts;
  let loader = SECTIONS[a || ''];
  let key = a || '';
  if (a === 'ferramentas' && b && TOOLS[b]) { loader = TOOLS[b]; key = 'ferramentas/' + b; r.parts = r.parts.slice(1); }
  if (!loader) { location.replace('#/'); return; }
  $$('[data-nav]').forEach((l) => l.classList.toggle('active', l.dataset.nav === a));
  bootstrap.Collapse.getInstance($('#nav-links'))?.hide();
  let mod;
  try { mod = (await loader()).default; } catch (err) {
    view.innerHTML = `<div class="alert alert-danger">Não consegui abrir esta seção (${err.message}). Verifique a conexão e recarregue.</div>`;
    return;
  }
  current.cleanup?.();
  document.title = mod.title ? `${mod.title} · Estúdio` : 'Estúdio';
  current = { key, mod, cleanup: null };
  view.classList.toggle('wide', !!mod.wide?.(r.parts.slice(1)));
  view.onclick = view.oninput = view.onchange = view.onsubmit = null;
  const cleanup = await mod.render(view, { parts: r.parts.slice(1), q: r.q, setTitle: (t) => { document.title = `${t} · Estúdio`; } });
  if (typeof cleanup === 'function') current.cleanup = cleanup;
  if (!mod.keepScroll) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => {
  if (current.mod?.dirty?.()) { e.preventDefault(); e.returnValue = ''; }
});

// endereços antigos (/cifras/#/lista/x, /timbres/) chegam aqui como ?de=...
(() => {
  const u = new URL(location.href);
  const from = u.searchParams.get('de');
  if (from) {
    const hash = location.hash.slice(1);
    history.replaceState(null, '', u.pathname + (from === 'cifras' ? '#/cifras' + (hash && hash !== '/' ? hash : '') : '#/' + from));
  }
})();

// ---------------------------------------------------------------- menu
function pill() {
  const el = $('#pm-pill');
  const label = PM.currentLabel();
  el.hidden = !label;
  el.innerHTML = label ? `<i class="bi ${PM.via() === 'ble' ? 'bi-bluetooth' : 'bi-usb-symbol'}"></i> <span class="d-none d-sm-inline">${label}</span>` : '';
  el.title = label ? `Pocket Master conectada pelo ${PM.via() === 'ble' ? 'Bluetooth' : 'USB'}` : '';
}
PM.onDevice(pill);
const syncIcon = { off: 'bi-person-circle', idle: 'bi-cloud', syncing: 'bi-cloud-arrow-up', ok: 'bi-cloud-check', error: 'bi-cloud-slash' };
function renderAccount(s) {
  const u = C.user();
  const btn = $('#account-btn');
  btn.innerHTML = `<i class="bi ${u ? syncIcon[s.state] || 'bi-cloud' : 'bi-person-circle'} fs-5"></i>${u ? `<span class="d-none d-lg-inline ms-1 small">${u.username}</span>` : ''}<span class="visually-hidden">Conta</span>`;
  btn.title = u ? `Conta: ${u.username}${s.state === 'error' ? ' — erro ao sincronizar' : s.state === 'ok' ? ' — sincronizado' : ''}` : 'Entrar para salvar na nuvem';
}
onSyncStatus(renderAccount);
C.onAuth(() => renderAccount(syncStatus()));

// ---------------------------------------------------------------- service worker
// Sempre busca a versão nova do site quando há internet; sem internet, usa a última que funcionou.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

window.__estudio = { P, PM, C };
// ferramentas para agentes de IA (WebMCP, window.estudio e a ponte com o servidor MCP local)
installAgentApi();
startBridge();
route();
