// Player do YouTube fixo no canto da tela. Continua tocando ao trocar de página
// e é usado também para analisar os acordes pelo áudio da aba.

let apiReady = null;
function loadApi() {
  apiReady ||= new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) { resolve(window.YT); return; }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiReady = null; reject(new Error('Não foi possível carregar o player do YouTube.')); };
    document.head.append(s);
  });
  return apiReady;
}

const state = { player: null, song: null, queue: [], index: -1, listeners: new Set(), onEnded: null };
let dock = null;

function ensureDock() {
  if (dock) return dock;
  dock = document.createElement('aside');
  dock.className = 'dock';
  dock.setAttribute('aria-label', 'Player');
  dock.innerHTML = `
    <div class="dock-bar">
      <div class="dock-title"><strong></strong><small></small></div>
      <button class="btn small icon ghost" data-d="prev" aria-label="Música anterior" title="Anterior">⏮</button>
      <button class="btn small icon ghost" data-d="next" aria-label="Próxima música" title="Próxima">⏭</button>
      <button class="btn small icon ghost" data-d="close" aria-label="Fechar player" title="Fechar">×</button>
    </div>
    <div class="dock-video"><div id="yt-dock"></div></div>`;
  document.body.append(dock);
  dock.onclick = (e) => {
    const d = e.target.closest('[data-d]')?.dataset.d;
    if (d === 'close') close();
    if (d === 'next') step(1);
    if (d === 'prev') step(-1);
  };
  return dock;
}

function updateBar() {
  if (!dock || !state.song) return;
  dock.querySelector('.dock-title strong').textContent = state.song.title || 'Sem título';
  dock.querySelector('.dock-title small').textContent = state.queue.length > 1
    ? `${state.index + 1} de ${state.queue.length}${state.song.artist ? ' · ' + state.song.artist : ''}`
    : state.song.artist || '';
  dock.querySelector('[data-d="prev"]').hidden = !(state.queue.length > 1);
  dock.querySelector('[data-d="next"]').hidden = !(state.queue.length > 1);
  emit();
}

function emit() { state.listeners.forEach((fn) => fn(state.song)); }

/** Avisa quando a música tocando muda (para destacar a linha da lista). */
export function onChange(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); }
export function current() { return state.song; }

/**
 * Toca uma música no player fixo. `queue` (lista de músicas com ytId) permite avançar para a próxima.
 * `autoplay` false só carrega o vídeo.
 */
export async function play(song, { queue = null, autoplay = true } = {}) {
  if (!song?.ytId) return null;
  ensureDock();
  dock.hidden = false;
  document.body.classList.add('has-dock');
  state.queue = (queue || [song]).filter((s) => s.ytId);
  state.index = Math.max(0, state.queue.findIndex((s) => s.id === song.id));
  state.song = song;
  updateBar();
  const YT = await loadApi();
  if (!state.player) {
    await new Promise((resolve) => {
      state.player = new YT.Player('yt-dock', {
        host: 'https://www.youtube-nocookie.com',
        videoId: song.ytId,
        playerVars: { rel: 0, playsinline: 1, autoplay: autoplay ? 1 : 0 },
        events: {
          onReady: () => resolve(),
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.ENDED) {
              if (state.onEnded) { state.onEnded(); return; }
              if (state.index < state.queue.length - 1) step(1);
            }
          },
        },
      });
    });
  } else if (autoplay) state.player.loadVideoById(song.ytId);
  else state.player.cueVideoById(song.ytId);
  return state.player;
}

function step(dir) {
  const i = state.index + dir;
  if (i < 0 || i >= state.queue.length) return;
  state.index = i;
  state.song = state.queue[i];
  updateBar();
  state.player?.loadVideoById(state.song.ytId);
}

export function close() {
  state.onEnded = null;
  try { state.player?.stopVideo(); } catch { /* ok */ }
  if (dock) dock.hidden = true;
  document.body.classList.remove('has-dock');
  state.song = null;
  emit();
}

/** Acesso direto ao player para a análise pela aba. */
export function api() { return state.player; }
export function setOnEnded(fn) { state.onEnded = fn; }

/**
 * Lê os vídeos de uma playlist, na ordem, usando um player temporário (visível) dentro de `mount`.
 * Usa só funções documentadas da API do player do YouTube (cuePlaylist / getPlaylist).
 */
export async function playlistVideoIds(listId, mount) {
  const YT = await loadApi();
  const box = document.createElement('div');
  box.className = 'pl-reader';
  const holder = document.createElement('div');
  box.append(holder);
  mount.append(box);
  try {
    return await new Promise((resolve, reject) => {
      let tries = 0;
      const pl = new YT.Player(holder, {
        host: 'https://www.youtube-nocookie.com',
        width: 356, height: 200,
        playerVars: { listType: 'playlist', list: listId, rel: 0, playsinline: 1 },
        events: {
          onReady: () => {
            const poll = setInterval(() => {
              const ids = pl.getPlaylist?.();
              if (ids && ids.length) { clearInterval(poll); resolve(ids); pl.destroy(); }
              else if (++tries > 40) { clearInterval(poll); reject(new Error('playlist')); pl.destroy(); }
            }, 250);
          },
          onError: () => reject(new Error('playlist')),
        },
      });
    });
  } finally {
    box.remove();
  }
}
