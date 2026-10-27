// Página inicial: atalhos para as seções e ferramentas.
import * as C from '/lib/core/cloud.js';
import { esc } from '/lib/core/ui.js';

const count = (key, fn) => { try { return fn(JSON.parse(localStorage.getItem(key) || '{}')); } catch { return 0; } };
const tile = (href, icon, title, text) => `<div class="col"><a class="card h-100 text-decoration-none tile" href="${href}"><div class="card-body">
  <i class="bi ${icon} text-primary"></i><h3 class="h6 mt-2 mb-1 text-body">${title}</h3><p class="small text-body-secondary mb-0">${text}</p></div></a></div>`;

export default {
  title: '',
  render(el) {
    const songs = count('cifras.v1', (d) => Object.keys(d.songs || {}).length);
    const lists = count('cifras.v1', (d) => (d.lists || []).length);
    const tones = count('timbres.v1', (d) => (d.tones || []).length);
    const u = C.user();
    el.innerHTML = `
      <section class="py-3 py-md-4">
        <h1 class="display-6 fw-bold mb-2">Estúdio</h1>
        <p class="lead text-body-secondary mb-0">Cifras, timbres e ferramentas de áudio que rodam no seu navegador.</p>
        ${C.configured() && !u ? '<p class="mt-2 mb-0"><a href="#/conta"><i class="bi bi-cloud-arrow-up"></i> Entre ou crie uma conta</a> para guardar tudo na nuvem e usar em qualquer aparelho.</p>' : ''}
        ${u ? `<p class="mt-2 mb-0 small text-body-secondary"><i class="bi bi-cloud-check"></i> Conectado como <strong>${esc(u.username)}</strong>.</p>` : ''}
      </section>
      <div class="row row-cols-1 row-cols-md-2 g-3 mb-4">
        <div class="col"><a class="card h-100 text-decoration-none tile border-primary" href="#/cifras"><div class="card-body">
          <div class="d-flex align-items-center gap-2"><i class="bi bi-music-note-list text-primary"></i><h2 class="h4 mb-0 text-body">Cifras</h2></div>
          <p class="text-body-secondary mt-2 mb-1">Repertórios a partir de links do YouTube, cifras com troca de tom, edição em lote, modo rolagem e geração de rascunho pelo áudio.</p>
          <span class="small text-body-secondary">${lists} ${lists === 1 ? 'lista' : 'listas'} · ${songs} ${songs === 1 ? 'cifra' : 'cifras'}</span></div></a></div>
        <div class="col"><a class="card h-100 text-decoration-none tile border-primary" href="#/timbres"><div class="card-body">
          <div class="d-flex align-items-center gap-2"><i class="bi bi-sliders text-primary"></i><h2 class="h4 mb-0 text-body">Timbres</h2></div>
          <p class="text-body-secondary mt-2 mb-1">Ouve um trecho de música, sugere o timbre e monta o preset na Sonicake Pocket Master (USB ou Bluetooth), com ajuste fino ouvindo a pedaleira.</p>
          <span class="small text-body-secondary">${tones} ${tones === 1 ? 'timbre guardado' : 'timbres guardados'}</span></div></a></div>
      </div>
      <h2 class="h5">Ferramentas</h2>
      <div class="row row-cols-1 row-cols-sm-2 row-cols-lg-3 g-3">
        ${tile('#/ferramentas/tom', 'bi-mic', 'Descobrir o tom', 'Toque ou cante perto do microfone, ou use um áudio ou vídeo.')}
        ${tile('#/ferramentas/acordes', 'bi-file-earmark-music', 'Acordes de um áudio', 'Rascunho de cifra com letra a partir de um vídeo, arquivo ou do microfone.')}
        ${tile('#/ferramentas/separar', 'bi-layers', 'Separar faixas', 'Voz, bateria, baixo e harmonia com IA, para ouvir e baixar.')}
        ${tile('#/ferramentas/comparar', 'bi-graph-up', 'Comparar áudios', 'Curva de frequências, distorção e reverb de dois áudios lado a lado.')}
        ${tile('#/ferramentas/pedaleira', 'bi-usb-symbol', 'Pocket Master', 'Editar presets, salvar e restaurar cópias de segurança pelo USB ou Bluetooth.')}
      </div>`;
  },
};
