// Cifras: repertórios a partir de links do YouTube, cifras com mudança de tom, edição em lote,
// geração de rascunho pelo áudio, modo rolagem e exportação.
import * as M from '/lib/music/theory.js';
import { renderSheet } from '/lib/music/sheet.js';
import { extractYouTube, extractYouTubeItems, splitTitle, fetchMeta } from '/lib/youtube/links.js';
import * as P from '/lib/youtube/player.js';
import { canCaptureTab } from '/lib/audio/io.js';
import { syncedStore, mergeMaps, mergeArrays, mergeTombs } from '/lib/core/sync.js';
import { $, $$, esc, uid, toast, download, loadScript, modal, confirmBox, promptBox } from '/lib/core/ui.js';

const H = '#/cifras';
const CAN_TAB = canCaptureTab();
const ANDROID = /Android/i.test(navigator.userAgent);

// ---------------------------------------------------------------- dados
const DEF = { songs: {}, lists: [], drafts: {}, prefs: {}, deleted: {} };
const S = syncedStore('cifras', 'cifras.v1', DEF, (a, b) => {
  const deleted = mergeTombs(a.deleted, b.deleted);
  const lists = mergeArrays(a.lists, b.lists, deleted, (l) => l.updatedAt || l.createdAt || 0);
  const drafts = Object.fromEntries(Object.entries({ ...b.drafts, ...a.drafts }).filter(([id]) => lists.some((l) => l.id === id)));
  return { songs: mergeMaps(a.songs, b.songs, deleted), lists, drafts, prefs: { ...b.prefs, ...a.prefs }, deleted };
});
const db = S.data;
const save = () => S.save();
const touch = (list) => { list.updatedAt = Date.now(); };

const getList = (id) => db.lists.find((l) => l.id === id);
const getSong = (id) => db.songs[id];
const songKey = (s) => (s ? M.normalizeKey(s.key) || '' : '');
const shiftedKey = (s, shift) => (songKey(s) ? M.transposeKey(songKey(s), shift) : '');
function keyLabel(s, shift) {
  const k = shiftedKey(s, shift);
  if (k) return k;
  return shift ? (shift > 0 ? `+${shift}` : `${shift}`) : '?';
}
const transposedContent = (song, shift) => M.transposeChordPro(song.content || '', shift, shiftedKey(song, shift));
const wrap = (n) => ((((n + 6) % 12) + 12) % 12) - 6;

function newSong(data) {
  const s = { id: uid(), title: '', artist: '', ytId: '', key: '', bpm: 80, content: '', melody: '', createdAt: Date.now(), ...data };
  s.updatedAt = Date.now();
  db.songs[s.id] = s;
  return s;
}
function newList(name) {
  const l = { id: uid(), name: name || 'Nova lista', items: [], createdAt: Date.now(), updatedAt: Date.now() };
  db.lists.unshift(l);
  return l;
}
/** Itens da lista considerando o rascunho da edição em lote, se houver. */
const itemsOf = (list) => (db.drafts[list.id] ? db.drafts[list.id].items : list.items);
function deleteSong(id) {
  delete db.songs[id];
  db.deleted[id] = Date.now();
  for (const l of db.lists) if (l.items.some((x) => x.songId === id)) { l.items = l.items.filter((x) => x.songId !== id); touch(l); }
  for (const d of Object.values(db.drafts)) d.items = d.items.filter((x) => x.songId !== id);
}

// ---------------------------------------------------------------- Cifra Club
function ccLinks(artist, title) {
  const q = [title, artist].filter(Boolean).join(' ');
  return {
    search: `https://www.cifraclub.com.br/?q=${encodeURIComponent(q)}`,
    google: `https://www.google.com/search?q=${encodeURIComponent(`${q} cifra site:cifraclub.com.br`)}`,
  };
}
/** No Android o app do Cifra Club captura os links do site e abre só a tela inicial; lá a busca vai pelo Google. */
const ccUrl = (cc) => (ANDROID ? cc.google : cc.search);
const ccButton = (s) => `<a class="btn btn-sm btn-outline-secondary" href="${esc(ccUrl(ccLinks(s.artist, s.title)))}" target="_blank" rel="noopener" title="Buscar no Cifra Club" aria-label="Buscar ${esc(s.title)} no Cifra Club"><i class="bi bi-search"></i> Cifra Club</a>`;
const playButton = (s) => (s.ytId ? `<button class="btn btn-sm btn-outline-primary" type="button" data-act="play" data-song="${s.id}" aria-label="Ouvir ${esc(s.title)}" title="Ouvir / ver o vídeo"><i class="bi bi-play-fill"></i></button>` : '');

// ---------------------------------------------------------------- exportação
function songChordPro(song, shift) {
  const k = shiftedKey(song, shift);
  const head = [`{title: ${song.title}}`, song.artist && `{artist: ${song.artist}}`, k && `{key: ${k}}`, song.bpm && `{tempo: ${song.bpm}}`, song.ytId && `{comment: https://youtu.be/${song.ytId}}`].filter(Boolean).join('\n');
  const body = transposedContent(song, shift).replace(/^\s*\{\s*(title|t|artist|subtitle|st|key|tempo)\s*:.*\}\s*$/gim, '').trim();
  return head + '\n\n' + body + '\n';
}
function songText(song, shift) {
  const k = keyLabel(song, shift);
  return `${song.title}${song.artist ? ' — ' + song.artist : ''}\n${k !== '?' ? 'Tom: ' + k + '\n' : ''}\n${M.chordProToText(transposedContent(song, shift))}\n`;
}
function printSongs(entries) {
  $('#print').innerHTML = entries.map(({ song, shift }) => `
    <section class="song"><h1>${esc(song.title || 'Sem título')}</h1>
    <p>${esc(song.artist)}${keyLabel(song, shift) !== '?' ? ` — Tom: ${esc(keyLabel(song, shift))}` : ''}</p>
    <div class="sheet">${renderSheet(transposedContent(song, shift))}</div></section>`).join('');
  window.print();
}

// ---------------------------------------------------------------- player
let playingListId = null;
function markPlaying() {
  const cur = P.current();
  $$('[data-song-row]').forEach((li) => li.classList.toggle('playing', !!cur && li.dataset.songRow === cur.id));
}
P.onChange(markPlaying);
// Tocando a lista com uma cifra dela aberta: ao passar para a próxima música, abre a cifra dela.
P.onChange((song) => {
  if (!song || !playingListId || !location.hash.startsWith(H + '/cifra/')) return;
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (q.get('lista') === playingListId && !location.hash.startsWith(`${H}/cifra/${song.id}`)) location.hash = `${H}/cifra/${song.id}?lista=${playingListId}`;
});
// Clicar no título do player abre a cifra da música que está tocando.
P.onTitleClick((song) => { if (getSong(song.id)) location.hash = `${H}/cifra/${song.id}${playingListId ? '?lista=' + playingListId : ''}`; });
const queueOf = (list) => itemsOf(list).map((x) => getSong(x.songId)).filter((x) => x && x.ytId);

// ---------------------------------------------------------------- seção
let view = null;
let active = false;
let route = { parts: [], q: {} };
let dirtyFn = () => false;

S.onRemote(() => { if (active && !dirtyFn()) render(view, route); });

function render(el, r) {
  view = el; route = r; active = true; dirtyFn = () => false;
  el.onclick = el.oninput = el.onchange = null;
  const [a, b] = r.parts;
  if (!a) viewHome();
  else if (a === 'importar') viewImport();
  else if (a === 'musicas') viewLibrary();
  else if (a === 'lista' && getList(b)) viewList(getList(b));
  else if (a === 'cifra' && getSong(b)) viewSong(getSong(b), r.q);
  else if (a === 'editar') viewEditor(b, r.q);
  else { location.replace(H); return null; }
  markPlaying();
  return () => { active = false; };
}

export default {
  title: 'Cifras',
  render,
  wide: (parts) => parts[0] === 'editar',
  dirty: () => dirtyFn(),
  async canLeave() { return !dirtyFn() || confirmBox('Sair sem salvar as mudanças desta cifra?', { ok: 'Sair sem salvar', danger: true }); },
};

// ---------------------------------------------------------------- início
function viewHome() {
  const count = Object.keys(db.songs).length;
  view.innerHTML = `
    <div class="d-flex flex-wrap align-items-end justify-content-between gap-2">
      <div><h1 class="h2 mb-1">Suas listas</h1><p class="text-body-secondary mb-0">Cole links do YouTube (ou a mensagem inteira do grupo) e monte o repertório.</p></div>
      <button class="btn btn-outline-secondary" type="button" data-act="mic"><i class="bi bi-mic"></i> Descobrir tom</button>
    </div>
    <div class="d-flex flex-wrap gap-2 my-3">
      <a class="btn btn-primary" href="${H}/importar"><i class="bi bi-youtube"></i> Importar do YouTube</a>
      <button class="btn btn-outline-primary" type="button" data-act="new-list"><i class="bi bi-plus-lg"></i> Nova lista</button>
      <a class="btn btn-outline-primary" href="${H}/editar/nova"><i class="bi bi-file-earmark-plus"></i> Nova cifra</a>
    </div>
    ${db.lists.length ? `<div class="list-group song-rows plain mb-4">${db.lists.map((l) => {
      const it = itemsOf(l);
      const names = it.slice(0, 3).map((i) => getSong(i.songId)?.title).filter(Boolean).join(', ');
      return `<a class="list-group-item list-group-item-action" href="${H}/lista/${l.id}"><span class="main"><strong>${esc(l.name)}</strong>
        <small>${it.length} ${it.length === 1 ? 'música' : 'músicas'}${names ? ' — ' + esc(names) + (it.length > 3 ? '…' : '') : ''}</small></span>
        ${db.drafts[l.id] ? '<span class="badge text-bg-warning">não salva</span>' : ''}<i class="bi bi-chevron-right text-body-secondary"></i></a>`;
    }).join('')}</div>`
      : '<div class="text-center border border-2 border-dashed rounded-3 p-4 mb-4 text-body-secondary"><p>Nenhuma lista ainda.</p><a class="btn btn-primary" href="#/cifras/importar">Importar músicas do YouTube</a></div>'}
    <h2 class="h5">Biblioteca</h2>
    <div class="list-group mb-4"><a class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" href="${H}/musicas"><span><strong>Todas as músicas</strong><br><small class="text-body-secondary">${count} ${count === 1 ? 'cifra salva' : 'cifras salvas'}</small></span><i class="bi bi-chevron-right"></i></a></div>
    <h2 class="h5">Backup</h2>
    <p class="small text-body-secondary">Tudo fica salvo neste navegador${'' /* a conta sincroniza */} e, se você <a href="#/conta">entrar na sua conta</a>, também na nuvem. O backup em arquivo leva os dados para qualquer lugar.</p>
    <div class="d-flex flex-wrap gap-2">
      <button class="btn btn-outline-secondary btn-sm" type="button" data-act="backup"><i class="bi bi-download"></i> Exportar backup</button>
      <label class="btn btn-outline-secondary btn-sm mb-0"><i class="bi bi-upload"></i> Importar backup<input type="file" accept=".json,application/json" data-act="restore" hidden></label>
    </div>`;
  view.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'new-list') {
      const name = await promptBox('Nome da lista', 'Nova lista', { ok: 'Criar' });
      if (name == null) return;
      const l = newList(name || 'Nova lista'); save(); location.hash = `${H}/lista/${l.id}`;
    }
    if (act === 'backup') download(`cifras-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'cifras', version: 1, songs: db.songs, lists: db.lists }, null, 1), 'application/json');
    if (act === 'mic') openMic(null);
  };
  view.onchange = async (e) => {
    if (e.target.dataset.act !== 'restore' || !e.target.files[0]) return;
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (!data.songs || !data.lists) throw new Error();
      for (const s of Object.values(data.songs)) { db.songs[s.id] = { ...s, updatedAt: Math.max(s.updatedAt || 0, Date.now()) }; delete db.deleted[s.id]; }
      for (const l of data.lists) { const i = db.lists.findIndex((x) => x.id === l.id); const nl = { ...l, updatedAt: Date.now() }; if (i >= 0) db.lists[i] = nl; else db.lists.push(nl); delete db.deleted[l.id]; }
      save(); toast(`Backup importado: ${Object.keys(data.songs).length} cifras e ${data.lists.length} listas.`); viewHome();
    } catch { toast('Esse arquivo não é um backup válido do Cifras.', 'danger'); }
  };
}

// ---------------------------------------------------------------- importação
let importState = { text: '', items: [] };
function viewImport() {
  const st = importState;
  view.innerHTML = `
    <p class="mb-1"><a href="${H}"><i class="bi bi-arrow-left"></i> Listas</a></p>
    <h1 class="h2">Importar do YouTube</h1>
    <p class="text-body-secondary">Cole links de vídeos e de playlists, soltos ou dentro de uma mensagem. A ordem dos links é mantida, e cada playlist entra na ordem dela. Links repetidos são ignorados.</p>
    <label class="form-label fw-bold" for="imp-text">Links ou mensagem</label>
    <textarea class="form-control mb-2" id="imp-text" rows="7" placeholder="Ex.: Pessoal, o repertório de domingo:
1. https://youtu.be/…
2. Música tal → https://www.youtube.com/watch?v=…">${esc(st.text)}</textarea>
    <button class="btn btn-primary" type="button" data-act="find"><i class="bi bi-search"></i> Encontrar músicas</button>
    <div id="imp-pl" aria-live="polite"></div>
    <div id="imp-res" class="mt-4"></div>`;
  const res = $('#imp-res');
  const videos = () => st.items.filter((x) => x.type === 'video');
  const draw = () => {
    if (!st.items.length) { res.innerHTML = st.searched ? '<div class="alert alert-secondary">Nenhum link do YouTube encontrado nesse texto.</div>' : ''; return; }
    const n = videos().length;
    const reading = st.items.some((x) => x.type === 'playlist' && x.reading);
    res.innerHTML = `
      <h2 class="h5">${n} ${n === 1 ? 'música encontrada' : 'músicas encontradas'}</h2>
      <p class="small text-body-secondary">Confira artista e nome: eles são usados para buscar a cifra e a letra depois.</p>
      <div class="list-group mb-4">${st.items.map((it, i) => it.type === 'playlist' ? `
        <div class="list-group-item d-flex gap-2 align-items-center" data-i="${i}"><div class="flex-grow-1"><strong>Playlist${it.context ? ': ' + esc(it.context) : ''}</strong><div class="small text-body-secondary status">${esc(it.status || '')}</div></div>
          <button class="btn btn-sm btn-link text-body" type="button" data-act="drop" aria-label="Remover"><i class="bi bi-x-lg"></i></button></div>` : `
        <div class="list-group-item d-flex gap-3 align-items-start" data-i="${i}">
          <img class="d-none d-sm-block rounded" style="width:96px;aspect-ratio:16/9;object-fit:cover" alt="" loading="lazy" src="https://i.ytimg.com/vi/${it.id}/mqdefault.jpg">
          <div class="flex-grow-1 row g-2">
            <div class="col-sm-6"><input class="form-control form-control-sm" type="text" data-f="title" placeholder="Nome da música" aria-label="Música" value="${esc(it.title)}"></div>
            <div class="col-sm-6"><input class="form-control form-control-sm" type="text" data-f="artist" placeholder="Artista" aria-label="Artista" value="${esc(it.artist)}"></div>
            <div class="col-12 small text-body-secondary"><span class="status">${it.from ? `Da playlist${it.from === true ? '' : ' “' + esc(it.from) + '”'} · ` : ''}${esc(it.status || '')}</span>
              ${it.list && !it.from ? ' <button class="btn btn-sm btn-outline-secondary py-0" type="button" data-act="expand">Importar a playlist inteira</button>' : ''}</div>
          </div>
          <button class="btn btn-sm btn-link text-body" type="button" data-act="drop" aria-label="Remover"><i class="bi bi-x-lg"></i></button>
        </div>`).join('')}</div>
      <div class="row g-2 align-items-end">
        <div class="col-sm-6"><label class="form-label small mb-0" for="imp-dest">Adicionar em</label><select class="form-select" id="imp-dest"><option value="">Nova lista</option>${db.lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></div>
        <div class="col-sm-6" id="imp-name-wrap"><label class="form-label small mb-0" for="imp-name">Nome da nova lista</label><input class="form-control" type="text" id="imp-name" value="Repertório ${new Date().toLocaleDateString('pt-BR')}"></div>
        <div class="col-12"><button class="btn btn-primary" type="button" data-act="create"${n && !reading ? '' : ' disabled'}>Adicionar ${n} ${n === 1 ? 'música' : 'músicas'}</button></div>
      </div>`;
    $('#imp-dest').onchange = (e) => { $('#imp-name-wrap').hidden = !!e.target.value; };
  };
  const rowOf = (it) => res.querySelector(`[data-i="${st.items.indexOf(it)}"]`);
  const setStatus = (it) => { const s = rowOf(it)?.querySelector('.status'); if (s) s.textContent = (it.from ? 'Da playlist · ' : '') + it.status; };
  const setField = (it) => {
    const li = rowOf(it); if (!li) return;
    for (const f of ['title', 'artist']) { const inp = li.querySelector(`[data-f="${f}"]`); if (inp && document.activeElement !== inp) inp.value = it[f]; }
  };
  const mkVideo = (f, from = null) => {
    const existing = Object.values(db.songs).find((s) => s.ytId === f.id);
    return {
      type: 'video', id: f.id, url: f.url, list: f.list || '', from, existing: existing?.id || null,
      title: existing?.title || f.context || '', artist: existing?.artist || '',
      status: existing ? 'Já está na biblioteca: a cifra salva será reaproveitada.' : 'Buscando título…',
      touched: !!existing, needsMeta: !existing,
    };
  };
  async function loadMeta() {
    const queue = videos().filter((it) => it.needsMeta);
    queue.forEach((it) => { it.needsMeta = false; });
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        const meta = await fetchMeta(it.id);
        if (meta) {
          const sp = splitTitle(meta.title, meta.author);
          if (!it.touched) { it.title = sp.title || it.title; it.artist = sp.artist || it.artist; setField(it); }
          it.status = `No YouTube: “${meta.title}”`;
        } else it.status = 'Não consegui ler o título deste vídeo. Preencha à mão.';
        setStatus(it);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }
  async function resolvePlaylist(pl) {
    pl.reading = true; pl.status = 'Lendo a playlist…'; draw();
    let ids;
    try { ids = await P.playlistVideoIds(pl.list, $('#imp-pl') || document.body); } catch {
      pl.reading = false;
      pl.status = 'Não consegui ler esta playlist. Ela pode ser privada ou um mix automático do YouTube.';
      draw(); return;
    }
    const seen = new Set(videos().map((x) => x.id));
    const vids = ids.filter((id) => !seen.has(id) && seen.add(id)).map((id) => mkVideo({ id, url: `https://www.youtube.com/watch?v=${id}` }, pl.context || true));
    st.items.splice(st.items.indexOf(pl), 1, ...vids);
    if (active) { draw(); loadMeta(); }
  }
  async function find() {
    st.text = $('#imp-text').value;
    st.searched = true;
    st.items = extractYouTubeItems(st.text).map((f) => (f.type === 'video' ? mkVideo(f) : { type: 'playlist', list: f.list, context: f.context, status: 'Na fila…' }));
    draw(); loadMeta();
    for (const pl of st.items.filter((x) => x.type === 'playlist')) await resolvePlaylist(pl);
  }
  view.oninput = (e) => {
    const row = e.target.closest('[data-i]');
    if (row && e.target.dataset.f) { const it = st.items[row.dataset.i]; it[e.target.dataset.f] = e.target.value; it.touched = true; }
    if (e.target.id === 'imp-text') st.text = e.target.value;
  };
  view.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const i = Number(e.target.closest('[data-i]')?.dataset.i);
    if (act === 'find') find();
    if (act === 'drop') { st.items.splice(i, 1); draw(); }
    if (act === 'expand') {
      const it = st.items[i];
      const pl = { type: 'playlist', list: it.list, context: it.title, status: '' };
      st.items.splice(i, 1, pl); // o vídeo volta junto com os outros da playlist
      resolvePlaylist(pl);
    }
    if (act === 'create') {
      const destId = $('#imp-dest').value;
      const list = destId ? getList(destId) : newList($('#imp-name').value.trim() || 'Nova lista');
      const target = itemsOf(list);
      for (const it of videos()) {
        const song = it.existing ? getSong(it.existing) : newSong({ title: it.title || 'Sem título', artist: it.artist, ytId: it.id });
        if (!target.some((x) => x.songId === song.id)) target.push({ songId: song.id, shift: 0 });
      }
      touch(list); save();
      importState = { text: '', items: [] };
      toast('Músicas adicionadas. Use os botões do Cifra Club de cada linha para achar as cifras.');
      location.hash = `${H}/lista/${list.id}`;
    }
  };
  draw();
}

// ---------------------------------------------------------------- biblioteca
function viewLibrary() {
  const songs = Object.values(db.songs).sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  view.innerHTML = `
    <p class="mb-1"><a href="${H}"><i class="bi bi-arrow-left"></i> Listas</a></p>
    <h1 class="h2">Todas as músicas</h1>
    <div class="d-flex gap-2 my-3"><input class="form-control" type="search" id="lib-q" placeholder="Buscar por música ou artista" aria-label="Buscar"><a class="btn btn-outline-primary text-nowrap" href="${H}/editar/nova"><i class="bi bi-plus-lg"></i> Nova cifra</a></div>
    <div class="list-group song-rows plain" id="lib-rows"></div>`;
  const norm = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const draw = (q = '') => {
    const n = norm(q);
    const f = songs.filter((s) => norm(`${s.title} ${s.artist}`).includes(n));
    $('#lib-rows').innerHTML = f.length ? f.map((s) => `
      <div class="list-group-item" data-song-row="${s.id}"><a class="main" href="${H}/cifra/${s.id}"><strong>${esc(s.title)}</strong><small>${esc(s.artist || '—')}${s.content ? '' : ' · sem cifra ainda'}</small></a>
      <span class="ctrls">${songKey(s) ? `<span class="badge text-bg-primary keybadge">${esc(songKey(s))}</span>` : ''}${playButton(s)}${ccButton(s)}</span></div>`).join('')
      : '<div class="list-group-item text-body-secondary">Nada encontrado.</div>';
    markPlaying();
  };
  draw();
  $('#lib-q').oninput = (e) => draw(e.target.value);
  view.onclick = (e) => { const b = e.target.closest('[data-act="play"]'); if (b) { playingListId = null; P.play(getSong(b.dataset.song)); } };
}

// ---------------------------------------------------------------- lista
function viewList(list) {
  document.title = list.name + ' · Estúdio';
  const draft = db.drafts[list.id];
  const items = itemsOf(list);
  const roots = M.SHARPS.map((_, i) => M.keyName(i, false));
  view.innerHTML = `
    <p class="mb-1"><a href="${H}"><i class="bi bi-arrow-left"></i> Listas</a></p>
    <h1 class="h2 mb-1">${esc(list.name)}</h1>
    <p class="text-body-secondary">${items.length} ${items.length === 1 ? 'música' : 'músicas'}. Arraste <i class="bi bi-grip-vertical"></i> para reordenar.</p>
    ${draft ? `
      <div class="alert alert-warning d-flex flex-wrap gap-2 align-items-center" role="status"><div class="flex-grow-1"><strong>Edição em lote em andamento.</strong> As mudanças ficam guardadas mesmo se você abrir uma cifra para editar. Salve para aplicar à lista.</div>
        <button class="btn btn-sm btn-outline-secondary" type="button" data-act="discard">Descartar</button><button class="btn btn-sm btn-primary" type="button" data-act="commit">Salvar alterações</button></div>
      <div class="card card-body py-2 mb-3 d-flex flex-row flex-wrap gap-2 align-items-center">
        <label for="all-key" class="mb-0">Mudar todas para</label>
        <select class="form-select form-select-sm w-auto" id="all-key"><option value="">tom…</option>${roots.map((r) => `<option>${r}</option>`).join('')}</select>
        <button class="btn btn-sm btn-outline-secondary" type="button" data-act="reset-all">Voltar todas ao tom original</button>
        <span class="small text-body-secondary">Músicas em tom menor vão para o menor da mesma nota (ex.: A → Am).</span>
      </div>` : `
      <div class="d-flex flex-wrap gap-2 mb-3">
        ${items.some((x) => getSong(x.songId)?.ytId) ? '<button class="btn btn-primary" type="button" data-act="playall"><i class="bi bi-play-fill"></i> Tocar a lista</button>' : ''}
        <button class="btn btn-outline-primary" type="button" data-act="batch"><i class="bi bi-pencil-square"></i> Editar em lote</button>
        <button class="btn btn-outline-primary" type="button" data-act="add"><i class="bi bi-plus-lg"></i> Adicionar músicas</button>
        <div class="dropdown"><button class="btn btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">Mais</button>
          <ul class="dropdown-menu">
            <li><button class="dropdown-item" type="button" data-act="export"><i class="bi bi-download"></i> Exportar</button></li>
            <li><button class="dropdown-item" type="button" data-act="print"><i class="bi bi-printer"></i> Imprimir / PDF</button></li>
            <li><button class="dropdown-item" type="button" data-act="rename"><i class="bi bi-input-cursor-text"></i> Renomear</button></li>
            <li><hr class="dropdown-divider"></li>
            <li><button class="dropdown-item text-danger" type="button" data-act="delete"><i class="bi bi-trash"></i> Excluir lista</button></li>
          </ul></div>
      </div>`}
    ${items.length ? `<div class="list-group song-rows" id="list-rows">${items.map((it, i) => {
      const s = getSong(it.songId);
      if (!s) return '';
      const k = keyLabel(s, it.shift);
      const orig = songKey(s);
      return `<div class="list-group-item" data-i="${i}" data-song-row="${s.id}">
        <span class="handle" aria-hidden="true"><i class="bi bi-grip-vertical"></i></span>
        <span class="num">${i + 1}</span>
        <a class="main" href="${H}/cifra/${s.id}?lista=${list.id}"><strong>${esc(s.title)}</strong><small>${esc(s.artist || '—')}${s.content ? '' : ' · sem cifra ainda'}</small></a>
        <span class="ctrls">${draft ? `
          ${playButton(s)}${ccButton(s)}
          <span class="btn-group btn-group-sm" role="group" aria-label="Tom"><button class="btn btn-outline-secondary" type="button" data-act="down" aria-label="Meio tom abaixo">−</button>
          <span class="btn btn-outline-secondary disabled keybadge" title="Tom original: ${esc(orig || 'não definido')}">${esc(k)}</span>
          <button class="btn btn-outline-secondary" type="button" data-act="up" aria-label="Meio tom acima">+</button></span>
          <a class="btn btn-sm btn-outline-secondary" href="${H}/editar/${s.id}?volta=${encodeURIComponent('/lista/' + list.id)}"><i class="bi bi-pencil"></i> Editar cifra</a>
          <button class="btn btn-sm btn-link text-body" type="button" data-act="remove" aria-label="Tirar da lista" title="Tirar da lista"><i class="bi bi-x-lg"></i></button>`
        : `<span class="badge text-bg-primary keybadge">${it.shift && orig ? `<span class="from">${esc(orig)} → </span>` : ''}${esc(k)}</span>${playButton(s)}${ccButton(s)}`}</span>
      </div>`;
    }).join('')}</div>`
      : `<div class="text-center border border-2 border-dashed rounded-3 p-4 text-body-secondary"><p>Lista vazia.</p><div class="d-flex flex-wrap gap-2 justify-content-center"><a class="btn btn-primary" href="${H}/importar">Importar do YouTube</a><button class="btn btn-outline-primary" type="button" data-act="add">Adicionar da biblioteca</button></div></div>`}`;

  const editItems = () => itemsOf(list);
  const persist = () => { if (!db.drafts[list.id]) touch(list); save(); viewList(list); markPlaying(); };

  loadScript('/lib/vendor/sortable/Sortable.min.js').then(() => {
    const el = $('#list-rows');
    if (!el || !window.Sortable) return;
    window.Sortable.create(el, {
      handle: '.handle', animation: 150, ghostClass: 'ghost',
      onEnd: ({ oldIndex, newIndex }) => {
        if (oldIndex === newIndex) return;
        const arr = editItems();
        arr.splice(newIndex, 0, arr.splice(oldIndex, 1)[0]);
        persist();
      },
    });
  }).catch(() => {});

  view.onchange = (e) => {
    if (e.target.id === 'all-key' && e.target.value) {
      let skipped = 0;
      for (const it of editItems()) {
        const orig = songKey(getSong(it.songId));
        if (!orig) { skipped++; continue; }
        it.shift = M.semitonesBetween(orig, M.keyWithRootOf(orig, e.target.value));
      }
      persist();
      if (skipped) toast(`${skipped} ${skipped === 1 ? 'música sem tom original definido ficou' : 'músicas sem tom original definido ficaram'} como estava.`);
    }
  };
  view.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const i = Number(btn.closest('[data-i]')?.dataset.i);
    const arr = editItems();
    switch (act) {
      case 'play': playingListId = list.id; P.play(getSong(btn.dataset.song), { queue: queueOf(list) }); break;
      case 'playall': { const q = queueOf(list); playingListId = list.id; if (q.length) P.play(q[0], { queue: q }); break; }
      case 'batch': db.drafts[list.id] = { items: list.items.map((x) => ({ ...x })), startedAt: Date.now() }; save(); viewList(list); break;
      case 'commit': list.items = db.drafts[list.id].items; delete db.drafts[list.id]; persist(); toast('Alterações salvas na lista.', 'success'); break;
      case 'discard': if (await confirmBox('Descartar as alterações em lote desta lista?', { ok: 'Descartar', danger: true })) { delete db.drafts[list.id]; save(); viewList(list); } break;
      case 'reset-all': arr.forEach((x) => { x.shift = 0; }); persist(); break;
      case 'up': arr[i].shift = wrap(arr[i].shift + 1); persist(); break;
      case 'down': arr[i].shift = wrap(arr[i].shift - 1); persist(); break;
      case 'remove': arr.splice(i, 1); persist(); break;
      case 'rename': { const n = await promptBox('Nome da lista', list.name, { ok: 'Renomear' }); if (n) { list.name = n; persist(); } break; }
      case 'delete':
        if (await confirmBox(`Excluir a lista “${list.name}”? As cifras continuam na biblioteca.`, { ok: 'Excluir', danger: true })) {
          db.lists = db.lists.filter((l) => l !== list); delete db.drafts[list.id]; db.deleted[list.id] = Date.now(); save(); location.hash = H;
        }
        break;
      case 'print': printSongs(list.items.map((x) => ({ song: getSong(x.songId), shift: x.shift })).filter((x) => x.song)); break;
      case 'export': openExportList(list); break;
      case 'add': openAddSongs(list, arr, persist); break;
      default:
    }
  };
}

function openExportList(list) {
  const entries = list.items.map((x) => ({ song: getSong(x.songId), shift: x.shift })).filter((x) => x.song);
  const m = modal({
    title: `Exportar “${list.name}”`, size: 'sm',
    body: `<p class="small text-body-secondary">Os arquivos saem no tom definido na lista.</p>
      <div class="d-grid gap-2"><button class="btn btn-outline-primary" type="button" data-x="txt">Texto (.txt)</button>
      <button class="btn btn-outline-primary" type="button" data-x="cho">ChordPro (.cho)</button>
      <button class="btn btn-outline-primary" type="button" data-x="json">Backup da lista (.json)</button></div>`,
  });
  m.body.onclick = (e) => {
    const x = e.target.dataset.x;
    if (x === 'txt') download(`${list.name}.txt`, `${list.name}\n${'='.repeat(list.name.length)}\n\n` + entries.map((en, i) => `${i + 1}. ` + songText(en.song, en.shift)).join('\n\n'));
    if (x === 'cho') download(`${list.name}.cho`, entries.map((en) => songChordPro(en.song, en.shift)).join('\n{new_song}\n\n'));
    if (x === 'json') download(`${list.name}.json`, JSON.stringify({ app: 'cifras', version: 1, songs: Object.fromEntries(entries.map((en) => [en.song.id, en.song])), lists: [list] }, null, 1), 'application/json');
  };
}

function openAddSongs(list, arr, persist) {
  const inList = new Set(arr.map((x) => x.songId));
  const songs = Object.values(db.songs).filter((s) => !inList.has(s.id)).sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  const m = modal({
    title: 'Adicionar músicas',
    body: songs.length ? `<input class="form-control mb-2" type="search" placeholder="Filtrar" data-x="filter" aria-label="Filtrar"><div class="list-group">${songs.map((s) => `
      <label class="list-group-item d-flex gap-2 align-items-center" data-name="${esc((s.title + ' ' + s.artist).toLowerCase())}"><input class="form-check-input mt-0" type="checkbox" value="${s.id}">
      <span class="text-truncate"><strong>${esc(s.title)}</strong> <small class="text-body-secondary">${esc(s.artist || '')}</small></span></label>`).join('')}</div>`
      : '<p class="text-body-secondary">Todas as músicas da biblioteca já estão nesta lista.</p>',
    footer: `<a class="btn btn-link me-auto" href="${H}/editar/nova?lista=${list.id}">Nova cifra</a><button class="btn btn-outline-secondary" type="button" data-bs-dismiss="modal">Cancelar</button><button class="btn btn-primary" type="button" data-x="ok">Adicionar</button>`,
  });
  m.body.oninput = (e) => {
    if (e.target.dataset.x !== 'filter') return;
    const q = e.target.value.toLowerCase();
    m.body.querySelectorAll('[data-name]').forEach((l) => { l.hidden = !l.dataset.name.includes(q); });
  };
  m.el.querySelector('a.btn-link').onclick = () => m.close();
  m.footer.querySelector('[data-x="ok"]').onclick = () => {
    $$('input:checked', m.body).forEach((c) => arr.push({ songId: c.value, shift: 0 }));
    m.close(); persist();
  };
}

// ---------------------------------------------------------------- cifra
const sv = { songId: null, listId: null, shift: 0 };

function viewSong(song, q) {
  const list = q.lista ? getList(q.lista) : null;
  const items = list ? itemsOf(list) : null;
  const idx = items ? items.findIndex((x) => x.songId === song.id) : -1;
  const item = idx >= 0 ? items[idx] : null;
  if (sv.songId !== song.id || sv.listId !== (list?.id || null)) {
    sv.songId = song.id;
    sv.listId = list?.id || null;
    sv.shift = item ? item.shift : 0;
    if (q.tom && songKey(song)) sv.shift = M.semitonesBetween(songKey(song), M.keyWithRootOf(songKey(song), q.tom));
  }
  document.title = `${song.title} · Estúdio`;
  const orig = songKey(song);
  const shown = keyLabel(song, sv.shift);
  const keys = orig ? M.SHARPS.map((_, i) => M.keyName(i, M.parseKey(orig).minor)) : [];
  const draft = list && db.drafts[list.id];
  const savedShift = item ? item.shift : 0;
  const prev = idx > 0 ? getSong(items[idx - 1].songId) : null;
  const next = item && idx < items.length - 1 ? getSong(items[idx + 1].songId) : null;
  const fontSize = db.prefs.fontSize || 1.12;
  const back = list ? '?volta=' + encodeURIComponent('/cifra/' + song.id + '?lista=' + list.id) : '';

  view.innerHTML = `
    <p class="mb-1">${list ? `<a href="${H}/lista/${list.id}"><i class="bi bi-arrow-left"></i> ${esc(list.name)}</a>${idx >= 0 ? ` <span class="text-body-secondary small">· ${idx + 1} de ${items.length}</span>` : ''}` : `<a href="${H}/musicas"><i class="bi bi-arrow-left"></i> Biblioteca</a>`}</p>
    <div class="d-flex flex-wrap gap-3 align-items-end justify-content-between">
      <div><h1 class="h2 mb-0">${esc(song.title)}</h1><p class="text-body-secondary mb-0">${esc(song.artist || '')}</p></div>
      <div class="keyctl d-flex align-items-center gap-1 border rounded-3 p-1" role="group" aria-label="Tom">
        <span class="px-2 text-body-secondary">Tom</span>
        <button class="btn btn-link text-body" type="button" data-act="down" aria-label="Meio tom abaixo"><i class="bi bi-dash-lg"></i></button>
        ${orig ? `<select class="form-select form-select-sm bigkey border-0" id="key-sel" aria-label="Escolher tom">${keys.map((k) => `<option${k === shown ? ' selected' : ''}>${k}</option>`).join('')}</select>` : `<span class="bigkey">${esc(shown)}</span>`}
        <button class="btn btn-link text-body" type="button" data-act="up" aria-label="Meio tom acima"><i class="bi bi-plus-lg"></i></button>
        ${sv.shift ? `<span class="small text-body-secondary pe-2">original ${esc(orig || '?')}</span>` : ''}
      </div>
    </div>
    ${!orig && song.content ? '<p class="small text-body-secondary mt-2">Defina o tom original no editor para escolher o tom pelo nome.</p>' : ''}
    ${list && item && sv.shift !== savedShift ? `<div class="alert alert-info d-flex flex-wrap gap-2 align-items-center mt-3"><span class="flex-grow-1">Este tom ainda não está salvo na lista${draft ? ' (rascunho da edição em lote)' : ''}.</span><button class="btn btn-sm btn-primary" type="button" data-act="save-shift">Usar ${esc(shown)} na lista</button></div>` : ''}
    ${!list && sv.shift && orig ? `<div class="alert alert-info d-flex flex-wrap gap-2 align-items-center mt-3"><span class="flex-grow-1">Você está vendo a cifra em ${esc(shown)}; o original é ${esc(orig)}.</span><button class="btn btn-sm btn-outline-primary" type="button" data-act="fix-key">Tornar ${esc(shown)} o tom original</button></div>` : ''}
    <div class="d-flex flex-wrap gap-2 my-3">
      ${song.ytId ? '<button class="btn btn-primary" type="button" data-act="video"><i class="bi bi-play-fill"></i> Ouvir / vídeo</button>' : ''}
      <a class="btn btn-outline-primary" href="${H}/editar/${song.id}${back}"><i class="bi bi-pencil"></i> Editar</a>
      <button class="btn btn-outline-primary" type="button" data-act="stage"${song.content ? '' : ' disabled'}><i class="bi bi-arrow-down-square"></i> Modo rolagem</button>
      <div class="dropdown"><button class="btn btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">Mais</button>
        <ul class="dropdown-menu">
          <li><button class="dropdown-item" type="button" data-act="cc"><i class="bi bi-search"></i> Cifra Club</button></li>
          <li><button class="dropdown-item" type="button" data-act="mic"><i class="bi bi-mic"></i> Conferir o tom tocando</button></li>
          <li><button class="dropdown-item" type="button" data-act="notation"><i class="bi bi-music-note-beamed"></i> Partitura e tab</button></li>
          <li><button class="dropdown-item" type="button" data-act="more"><i class="bi bi-download"></i> Exportar</button></li>
        </ul></div>
      <div class="btn-group ms-auto" role="group" aria-label="Tamanho da letra"><button class="btn btn-outline-secondary" type="button" data-act="smaller" aria-label="Diminuir letra">A−</button><button class="btn btn-outline-secondary" type="button" data-act="bigger" aria-label="Aumentar letra">A+</button></div>
    </div>
    ${song.content ? `<div class="sheet" style="--lyric-size:${fontSize}rem">${renderSheet(transposedContent(song, sv.shift))}</div>`
      : `<div class="text-center border border-2 border-dashed rounded-3 p-4"><p>Ainda não há cifra para esta música.</p>
        <div class="d-flex flex-wrap gap-2 justify-content-center">
          <a class="btn btn-primary" href="${esc(ccUrl(ccLinks(song.artist, song.title)))}" target="_blank" rel="noopener"><i class="bi bi-search"></i> ${ANDROID ? 'Buscar a cifra pelo Google' : 'Buscar no Cifra Club'}</a>
          <a class="btn btn-outline-primary" href="${H}/editar/${song.id}${back}">Colar ou escrever a cifra</a>
          ${CAN_TAB && song.ytId ? `<a class="btn btn-outline-primary" href="${H}/editar/${song.id}?gerar=aba${list ? '&volta=' + encodeURIComponent('/cifra/' + song.id + '?lista=' + list.id) : ''}"><i class="bi bi-magic"></i> Gerar acordes pelo vídeo</a>` : ''}
        </div>
        <p class="small text-body-secondary mt-3 mb-0">Copie a cifra no Cifra Club e cole no editor: o formato “acordes em cima da letra” é convertido sozinho. No editor também dá para gerar um rascunho pelo áudio.</p></div>`}
    ${list && (prev || next) ? `<nav class="pager d-flex gap-2 mt-4" aria-label="Músicas da lista">
      ${prev ? `<a class="btn btn-outline-secondary flex-fill text-start" href="${H}/cifra/${prev.id}?lista=${list.id}"><small class="d-block text-body-secondary">← Anterior</small><span>${esc(prev.title)}</span></a>` : '<span class="flex-fill"></span>'}
      ${next ? `<a class="btn btn-outline-secondary flex-fill text-end" href="${H}/cifra/${next.id}?lista=${list.id}"><small class="d-block text-body-secondary">Próxima →</small><span>${esc(next.title)}</span></a>` : '<span class="flex-fill"></span>'}
    </nav>` : ''}`;

  const rerender = () => viewSong(song, q);
  view.onchange = (e) => { if (e.target.id === 'key-sel') { sv.shift = M.semitonesBetween(orig, e.target.value); rerender(); } };
  view.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'up': sv.shift = wrap(sv.shift + 1); rerender(); break;
      case 'down': sv.shift = wrap(sv.shift - 1); rerender(); break;
      case 'save-shift': item.shift = sv.shift; if (!draft) touch(list); save(); rerender(); toast(draft ? 'Tom guardado no rascunho da lista.' : 'Tom salvo na lista.', 'success'); break;
      case 'fix-key':
        song.content = transposedContent(song, sv.shift);
        song.key = shiftedKey(song, sv.shift);
        if (song.melody) { try { song.melody = shiftMelodyText(song.melody, sv.shift); } catch { /* melodia inválida fica como está */ } }
        song.updatedAt = Date.now(); sv.shift = 0; save(); rerender(); break;
      case 'video': playingListId = list ? list.id : null; P.play(song, { queue: list ? queueOf(list) : null }); break;
      case 'bigger': case 'smaller':
        db.prefs.fontSize = Math.min(2.2, Math.max(0.8, (db.prefs.fontSize || 1.12) + (btn.dataset.act === 'bigger' ? 0.1 : -0.1)));
        save(); $('.sheet', view)?.style.setProperty('--lyric-size', db.prefs.fontSize + 'rem'); break;
      case 'cc': openCifraClub(song, back); break;
      case 'more': openExportSong(song); break;
      case 'stage': (await import('./extras.js')).openStage({ song, html: renderSheet(transposedContent(song, sv.shift)), keyLabel: keyLabel(song, sv.shift), prefs: db.prefs, savePrefs: save, saveBpm: (b) => { song.bpm = b; song.updatedAt = Date.now(); save(); }, playVideo: () => P.play(song) }); break;
      case 'mic': openMic({ song, list, item, orig, rerender }); break;
      case 'notation': (await import('./extras.js')).openNotation({ song, shift: sv.shift, keyLabel: shiftedKey(song, sv.shift) || 'C', saveMelody: (txt) => { song.melody = txt; song.updatedAt = Date.now(); save(); } }); break;
      default:
    }
  };
}

function shiftMelodyText(text, semis) {
  return M.transposeMelody(M.parseMelody(text), semis).map((n) => (n.bar ? '|' : n.rest ? `R:${n.dur}` : M.midiName(n.midi, false) + (n.dur !== 1 ? `:${n.dur}` : ''))).join(' ');
}

/** Descobrir o tom: na cifra aberta compara com o tom dela; fora, oferece abrir uma cifra no tom ouvido. */
async function openMic(c) {
  const K = await import('/lib/widgets/key.js');
  const song = c?.song;
  const lists = db.lists;
  const intro = song
    ? `Toque ou cante <strong>${esc(song.title)}</strong> perto do microfone por uns 10 segundos. Vou comparar com o tom da cifra aberta${shiftedKey(song, sv.shift) ? ` (${esc(shiftedKey(song, sv.shift))})` : ''}.`
    : 'Toque ou cante perto do microfone por uns 10 segundos para descobrir o tom.';
  const targetOf = (best) => (M.parseKey(best).minor === M.parseKey(c.orig).minor ? best : K.relativeOf(best));
  K.openKeyDetector({
    intro,
    extra: (res, best) => {
      if (song && c.orig) {
        const target = targetOf(best);
        const shown = shiftedKey(song, sv.shift);
        if (M.normalizeKey(target) === M.normalizeKey(shown)) return `<p class="fw-bold">Vocês estão no tom da cifra (${esc(shown)}).</p>`;
        return `<p>Estão tocando em <strong>${esc(target)}</strong>, e a cifra aberta está em <strong>${esc(shown)}</strong>.</p>
          <div class="d-flex flex-wrap gap-2"><button class="btn btn-primary" type="button" data-key-act="apply" data-key="${esc(target)}">Mudar a cifra para ${esc(target)}</button>
          ${c.list && c.item ? `<button class="btn btn-outline-primary" type="button" data-key-act="savelist" data-key="${esc(target)}">Usar ${esc(target)} em “${esc(c.list.name)}”</button>` : ''}</div>
          <div class="input-group mt-2"><select class="form-select" data-r="mic-list" aria-label="Lista"><option value="__new">Nova lista…</option>${lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
          <button class="btn btn-outline-primary" type="button" data-key-act="addlist" data-key="${esc(target)}">Adicionar nesta lista em ${esc(target)}</button></div>`;
      }
      if (song) return '<p class="small text-body-secondary">Esta cifra não tem tom original definido. Defina no editor para poder transpor automaticamente.</p>';
      const songs = Object.values(db.songs).filter((s) => songKey(s)).sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
      return songs.length ? `<p class="mb-1">Abrir uma cifra já neste tom:</p><div class="input-group"><select class="form-select" data-r="mic-song" aria-label="Cifra">${songs.map((s) => `<option value="${s.id}">${esc(s.title)}${s.artist ? ' — ' + esc(s.artist) : ''}</option>`).join('')}</select>
        <button class="btn btn-primary" type="button" data-key-act="opensong" data-key="${esc(best)}">Abrir em ${esc(best)}</button></div>` : '';
    },
    onAction: async (act, k, b, m) => {
      if (act === 'apply') { sv.shift = M.semitonesBetween(c.orig, k); m.close(); c.rerender(); }
      if (act === 'savelist') { sv.shift = M.semitonesBetween(c.orig, k); c.item.shift = sv.shift; if (!db.drafts[c.list.id]) touch(c.list); save(); m.close(); c.rerender(); }
      if (act === 'addlist') {
        const sel = m.body.querySelector('[data-r="mic-list"]').value;
        let l = getList(sel);
        if (sel === '__new') { const name = await promptBox('Nome da nova lista', 'Nova lista', { ok: 'Criar' }); if (name == null) return; l = newList(name || 'Nova lista'); }
        const target = itemsOf(l);
        const shift = c.orig ? M.semitonesBetween(c.orig, k) : 0;
        const ex = target.find((x) => x.songId === song.id);
        if (ex) ex.shift = shift; else target.push({ songId: song.id, shift });
        if (!db.drafts[l.id]) touch(l);
        save(); toast(`Adicionada em “${l.name}” no tom ${k}.`, 'success');
      }
      if (act === 'opensong') { const id = m.body.querySelector('[data-r="mic-song"]').value; m.close(); location.hash = `${H}/cifra/${id}?tom=${encodeURIComponent(k)}`; }
    },
  });
}

function openCifraClub(song, back) {
  const cc = ccLinks(song.artist, song.title);
  const intent = `intent:#Intent;action=android.intent.action.SEARCH;package=com.studiosol.cifraclub;S.query=${encodeURIComponent(song.title)};S.browser_fallback_url=${encodeURIComponent(cc.google)};end`;
  const m = modal({
    title: 'Cifra Club',
    body: `<p>Procurando <strong>${esc(song.title)}</strong>${song.artist ? ` de ${esc(song.artist)}` : ''}.</p>
      <div class="d-flex flex-wrap gap-2">${ANDROID ? `<a class="btn btn-primary" href="${esc(cc.google)}" target="_blank" rel="noopener">Buscar pelo Google</a><a class="btn btn-outline-primary" href="${esc(intent)}">Buscar dentro do app (experimental)</a>`
    : `<a class="btn btn-primary" href="${esc(cc.search)}" target="_blank" rel="noopener">Buscar no Cifra Club</a><a class="btn btn-outline-primary" href="${esc(cc.google)}" target="_blank" rel="noopener">Buscar pelo Google</a>`}</div>
      <p class="small text-body-secondary mt-3">${ANDROID ? 'No Android, a busca vai pelo Google: ao tocar num resultado do Cifra Club, o app abre direto na cifra. ' : ''}Escolha a versão certa da música, copie a cifra (letra com acordes em cima) e cole no editor; ela é convertida automaticamente.</p>`,
    footer: `<a class="btn btn-outline-primary" href="${H}/editar/${song.id}${back}">Abrir o editor</a>`,
  });
  m.footer.querySelector('a').onclick = () => m.close();
}

function openExportSong(song) {
  const m = modal({
    title: `Exportar “${song.title}”`, size: 'sm',
    body: `<p class="small text-body-secondary">No tom que está na tela (${esc(keyLabel(song, sv.shift))}).</p>
      <div class="d-grid gap-2"><button class="btn btn-outline-primary" type="button" data-x="txt">Texto (.txt)</button><button class="btn btn-outline-primary" type="button" data-x="cho">ChordPro (.cho)</button>
      <button class="btn btn-outline-primary" type="button" data-x="print">Imprimir / PDF</button><button class="btn btn-outline-primary" type="button" data-x="copy">Copiar texto</button></div>`,
  });
  m.body.onclick = async (e) => {
    const x = e.target.dataset.x;
    const name = `${song.title}${song.artist ? ' - ' + song.artist : ''}`;
    if (x === 'txt') download(name + '.txt', songText(song, sv.shift));
    if (x === 'cho') download(name + '.cho', songChordPro(song, sv.shift));
    if (x === 'print') { m.close(); printSongs([{ song, shift: sv.shift }]); }
    if (x === 'copy') { try { await navigator.clipboard.writeText(songText(song, sv.shift)); toast('Cifra copiada.', 'success'); } catch { toast('O navegador bloqueou a cópia.'); } }
  };
}

// ---------------------------------------------------------------- editor
function viewEditor(id, q) {
  const isNew = id === 'nova';
  let handoff = null;
  if (isNew && q.de === 'acordes') { try { handoff = JSON.parse(localStorage.getItem('cifras.handoff') || 'null'); localStorage.removeItem('cifras.handoff'); } catch { /* nada */ } }
  const song = isNew ? { title: '', artist: '', ytId: '', key: '', bpm: 80, content: '', melody: '', ...(handoff || {}) } : getSong(id);
  if (!song) { location.replace(H); return; }
  const back = q.volta ? H + q.volta : isNew ? (q.lista ? `${H}/lista/${q.lista}` : `${H}/musicas`) : `${H}/cifra/${song.id}`;
  const batchList = q.volta && q.volta.startsWith('/lista/') ? getList(q.volta.split('/')[2]) : null;
  document.title = (song.title || 'Nova cifra') + ' · editar';
  view.innerHTML = `
    <p class="mb-1"><a href="${back}"><i class="bi bi-arrow-left"></i> Voltar</a></p>
    <h1 class="h2">${isNew ? 'Nova cifra' : 'Editar cifra'}</h1>
    ${batchList && db.drafts[batchList.id] ? `<div class="alert alert-info">Você veio da edição em lote de <strong>${esc(batchList.name)}</strong>. As mudanças da lista continuam guardadas; ao salvar ou voltar, você retorna a ela.</div>` : ''}
    ${handoff ? '<div class="alert alert-success">Rascunho trazido da ferramenta Acordes. Revise e salve.</div>' : ''}
    <div class="row g-4">
      <form id="ed" class="col-lg-6" autocomplete="off" novalidate>
        <div class="row g-2 mb-2">
          <div class="col-sm-6"><label class="form-label small mb-0" for="ed-title">Música</label><input class="form-control" id="ed-title" name="title" required value="${esc(song.title)}"></div>
          <div class="col-sm-6"><label class="form-label small mb-0" for="ed-artist">Artista</label><input class="form-control" id="ed-artist" name="artist" value="${esc(song.artist)}"></div>
          <div class="col-sm-6"><label class="form-label small mb-0" for="ed-key">Tom original</label>
            <div class="input-group"><select class="form-select" id="ed-key" name="key"><option value="">não definido</option>${M.KEYS.map((k) => `<option${k === songKey(song) ? ' selected' : ''}>${k}</option>`).join('')}</select><button type="button" class="btn btn-outline-secondary" data-act="guess">Detectar</button></div></div>
          <div class="col-sm-6"><label class="form-label small mb-0" for="ed-bpm">Andamento (BPM)</label><input class="form-control" type="number" id="ed-bpm" name="bpm" min="30" max="260" value="${esc(song.bpm || 80)}"></div>
          <div class="col-12"><label class="form-label small mb-0" for="ed-yt">Vídeo do YouTube</label><input class="form-control" id="ed-yt" name="yt" placeholder="Cole o link do vídeo" value="${song.ytId ? 'https://youtu.be/' + song.ytId : ''}"></div>
        </div>
        <label class="form-label fw-bold mb-1" for="ed-content">Cifra</label>
        <textarea class="form-control code" id="ed-content" name="content" rows="16" spellcheck="false" placeholder="Cole aqui a cifra (do Cifra Club ou de onde quiser) ou escreva com os acordes entre colchetes:
[G]Quando eu digo que dei[D/F#]xei de te amar">${esc(song.content)}</textarea>
        <div class="d-flex flex-wrap gap-2 my-2">
          <button type="button" class="btn btn-sm btn-outline-secondary" data-act="convert">Converter “acordes em cima da letra”</button>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-act="cc"><i class="bi bi-search"></i> Buscar no Cifra Club</button>
        </div>
        <div class="d-flex flex-wrap gap-2 align-items-center mb-2"><span class="small text-body-secondary">Gerar rascunho (acordes e letra):</span>
          ${CAN_TAB ? '<button type="button" class="btn btn-sm btn-outline-primary" data-act="gen-tab"><i class="bi bi-youtube"></i> Pelo vídeo</button>' : ''}
          <button type="button" class="btn btn-sm btn-outline-primary" data-act="gen-file"><i class="bi bi-file-earmark-music"></i> Pelo arquivo</button>
          <button type="button" class="btn btn-sm btn-outline-primary" data-act="gen-mic"><i class="bi bi-mic"></i> Pelo microfone</button></div>
        <details class="small mb-3"><summary class="text-primary">Como escrever a cifra</summary>
          <p class="mt-2">Acordes vão entre colchetes, logo antes da sílaba: <code>[Am]Tudo [F]bem</code>. Seções: <code>{c: Refrão}</code>. Tablaturas ficam entre <code>{sot}</code> e <code>{eot}</code>. Se você colar uma cifra no formato tradicional, com os acordes na linha de cima, ela é convertida sozinha.</p></details>
        <label class="form-label fw-bold mb-1" for="ed-melody">Melodia principal (opcional)</label>
        <textarea class="form-control code" id="ed-melody" name="melody" rows="3" spellcheck="false" placeholder="E4 G4 A4:2 | B4:0.5 A4:0.5 G4 R:1">${esc(song.melody || '')}</textarea>
        <details class="small my-2"><summary class="text-primary">Como escrever a melodia</summary>
          <p class="mt-2">Uma nota por palavra: nome + oitava (<code>C4</code> é o dó central). Duração em tempos depois de dois-pontos: <code>A4:2</code> (mínima), <code>B4:0.5</code> (colcheia). Pausa: <code>R:1</code>. Barra de compasso: <code>|</code>.</p></details>
        <div class="d-flex flex-wrap gap-2 mt-3">
          <button class="btn btn-primary" type="submit"><i class="bi bi-check-lg"></i> Salvar</button>
          <a class="btn btn-outline-secondary" href="${back}">Cancelar</a>
          ${isNew ? '' : '<button type="button" class="btn btn-outline-danger ms-auto" data-act="del"><i class="bi bi-trash"></i> Excluir cifra</button>'}
        </div>
      </form>
      <section class="col-lg-6" aria-label="Pré-visualização"><div class="editor-preview"><div class="sheet" id="pv"></div></div></section>
    </div>`;

  const form = $('#ed');
  const ta = form.content;
  let dirty = !!handoff;
  dirtyFn = () => dirty;
  const preview = () => { $('#pv').innerHTML = renderSheet(ta.value); };
  preview();

  ta.addEventListener('paste', (e) => {
    const txt = e.clipboardData?.getData('text/plain');
    if (!txt || !M.looksLikeChordsOverLyrics(txt)) return;
    e.preventDefault();
    const conv = M.chordsOverLyricsToChordPro(txt);
    ta.setRangeText(conv, ta.selectionStart, ta.selectionEnd, 'end');
    dirty = true; preview();
    if (!form.key.value) { const g = M.guessKey(conv); if (g) form.key.value = g; }
    toast('Cifra convertida. Confira o tom original sugerido.');
  });
  form.oninput = (e) => { dirty = true; if (e.target === ta) preview(); };

  form.onsubmit = (e) => {
    e.preventDefault();
    const ytFound = extractYouTube(form.yt.value)[0];
    const data = {
      title: form.title.value.trim() || 'Sem título', artist: form.artist.value.trim(), key: form.key.value,
      bpm: Number(form.bpm.value) || 80, content: ta.value, melody: form.melody.value.trim(),
      ytId: ytFound ? ytFound.id : (form.yt.value.trim() ? song.ytId : ''),
    };
    if (data.melody) { try { M.parseMelody(data.melody); } catch (err) { toast(err.message, 'danger'); form.melody.focus(); return; } }
    let s;
    if (isNew) {
      s = newSong(data);
      const l = q.lista && getList(q.lista);
      if (l) { itemsOf(l).push({ songId: s.id, shift: 0 }); if (!db.drafts[l.id]) touch(l); }
    } else s = Object.assign(song, data, { updatedAt: Date.now() });
    save(); dirty = false;
    toast('Cifra salva.', 'success');
    location.hash = q.volta ? H + q.volta : `${H}/cifra/${s.id}${q.lista ? '?lista=' + q.lista : ''}`;
  };

  async function openGenerator(mode) {
    const yt = extractYouTube(form.yt.value)[0];
    if (mode === 'tab' && !yt) { toast('Cole o link do vídeo do YouTube no campo “Vídeo do YouTube” primeiro.'); form.yt.focus(); return; }
    const { openChordGenerator } = await import('/lib/widgets/chords.js');
    openChordGenerator({
      mode,
      song: { id: song.id || 'novo', title: form.title.value, artist: form.artist.value, ytId: yt ? yt.id : '' },
      bpm: Number(form.bpm.value) || 80, hasContent: !!ta.value.trim(),
      onApply: ({ text, key, bpm, append }) => {
        ta.value = append ? ta.value.replace(/\s*$/, '\n\n') + text : text;
        if (!append || !form.key.value) form.key.value = key;
        form.bpm.value = bpm;
        dirty = true; preview();
        toast('Rascunho inserido. Revise e salve.');
      },
    });
  }
  if (q.gerar === 'aba' && CAN_TAB) openGenerator('tab');

  view.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'guess') { const g = M.guessKey(ta.value); if (g) { form.key.value = g; dirty = true; toast(`Tom sugerido pelo primeiro acorde: ${g}.`); } else toast('Não encontrei acordes para sugerir o tom.'); }
    if (act === 'gen-file' || act === 'gen-mic' || act === 'gen-tab') openGenerator(act.slice(4));
    if (act === 'convert') { ta.value = M.chordsOverLyricsToChordPro(ta.value); dirty = true; preview(); }
    if (act === 'cc') window.open(ccUrl(ccLinks(form.artist.value, form.title.value)), '_blank', 'noopener');
    if (act === 'del' && await confirmBox('Excluir esta cifra da biblioteca e de todas as listas?', { ok: 'Excluir', danger: true })) {
      if (P.current()?.id === song.id) P.close();
      deleteSong(song.id);
      dirty = false; save(); location.hash = `${H}/musicas`;
    }
  };
}
