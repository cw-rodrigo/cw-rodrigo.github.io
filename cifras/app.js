import * as M from './music.js?v=5';
import { toast, loadScript } from './util.js?v=5';
import * as P from './player.js?v=5';

const CAN_TAB = !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

// ---------- utilidades ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const app = $('#app');

function download(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[\\/:*?"<>|]+/g, '-');
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- dados ----------
const STORE = 'cifras.v1';
let db = load();
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE));
    if (d && d.songs && d.lists) return { drafts: {}, prefs: {}, ...d };
  } catch { /* vazio */ }
  return { songs: {}, lists: [], drafts: {}, prefs: {} };
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(db)); } catch { toast('Não foi possível salvar: o armazenamento do navegador está cheio ou bloqueado.'); }
}
const getList = (id) => db.lists.find((l) => l.id === id);
const getSong = (id) => db.songs[id];
const songKey = (s) => (s ? M.normalizeKey(s.key) || '' : '');
const shiftedKey = (s, shift) => (songKey(s) ? M.transposeKey(songKey(s), shift) : '');
function keyLabel(s, shift) {
  const k = shiftedKey(s, shift);
  if (k) return k;
  return shift ? (shift > 0 ? `+${shift}` : `${shift}`) : '?';
}
function transposedContent(song, shift) {
  return M.transposeChordPro(song.content || '', shift, shiftedKey(song, shift));
}

function newSong(data) {
  const s = { id: uid(), title: '', artist: '', ytId: '', key: '', bpm: 80, content: '', melody: '', createdAt: Date.now(), ...data };
  s.updatedAt = Date.now();
  db.songs[s.id] = s;
  return s;
}
function newList(name) {
  const l = { id: uid(), name: name || 'Nova lista', items: [], createdAt: Date.now() };
  db.lists.unshift(l);
  return l;
}
/** Itens da lista considerando o rascunho da edição em lote, se houver. */
const itemsOf = (list) => (db.drafts[list.id] ? db.drafts[list.id].items : list.items);
function wrap(n) { n = ((n + 6) % 12 + 12) % 12 - 6; return n; }

// ---------- cifra renderizada ----------
export function renderSheet(content) {
  const { lines } = M.parseChordPro(content);
  let h = '';
  let lastGap = true;
  for (const l of lines) {
    if (l.type === 'empty') { if (!lastGap) h += '<div class="gap"></div>'; lastGap = true; continue; }
    lastGap = false;
    if (l.type === 'section') h += `<div class="section">${esc(l.text)}</div>`;
    else if (l.type === 'tab') h += `<div class="tab">${esc(l.text)}</div>`;
    else if (l.type === 'chords') h += `<div class="ln chords-only">${l.segments.filter((s) => s.chord).map((s) => `<b class="ch">${esc(s.chord)}</b>`).join('')}</div>`;
    else if (l.segments.some((s) => s.chord)) {
      // cada palavra vira um bloco, para a linha poder quebrar em telas estreitas sem desalinhar o acorde
      const parts = [];
      for (const s of l.segments) {
        const words = s.text.match(/\s*\S+\s*|\s+/g) || [''];
        words.forEach((w, i) => parts.push({ chord: i === 0 ? s.chord : null, text: w }));
      }
      h += '<div class="ln has-ch">' + parts.map((s) => `<span class="seg"><b class="ch">${esc(s.chord || '')}</b><span class="tx">${esc(s.text) || (s.chord ? ' ' : '')}</span></span>`).join('') + '</div>';
    } else h += `<div class="ln">${esc(l.segments.map((s) => s.text).join(''))}</div>`;
  }
  return h || '<p class="hint">Sem cifra.</p>';
}

function printSongs(entries) {
  const el = $('#print');
  el.innerHTML = entries.map(({ song, shift }) => `
    <section class="song"><h1>${esc(song.title || 'Sem título')}</h1>
    <p class="meta">${esc(song.artist)}${keyLabel(song, shift) !== '?' ? ` — Tom: ${esc(keyLabel(song, shift))}` : ''}</p>
    <div class="sheet">${renderSheet(transposedContent(song, shift))}</div></section>`).join('');
  window.print();
}

function songChordPro(song, shift) {
  const k = shiftedKey(song, shift);
  const head = [`{title: ${song.title}}`, song.artist && `{artist: ${song.artist}}`, k && `{key: ${k}}`, song.bpm && `{tempo: ${song.bpm}}`,
    song.ytId && `{comment: https://youtu.be/${song.ytId}}`].filter(Boolean).join('\n');
  const body = transposedContent(song, shift).replace(/^\s*\{\s*(title|t|artist|subtitle|st|key|tempo)\s*:.*\}\s*$/gim, '').trim();
  return head + '\n\n' + body + '\n';
}
function songText(song, shift) {
  const k = keyLabel(song, shift);
  return `${song.title}${song.artist ? ' — ' + song.artist : ''}\n${k !== '?' ? 'Tom: ' + k + '\n' : ''}\n${M.chordProToText(transposedContent(song, shift))}\n`;
}

// ---------- roteamento ----------
function parseHash() {
  const h = decodeURI(location.hash.slice(1)) || '/';
  const [path, qs] = h.split('?');
  return { parts: path.split('/').filter(Boolean), q: Object.fromEntries(new URLSearchParams(qs || '')), path };
}
let leaveGuard = null;
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => { if (leaveGuard && leaveGuard()) { e.preventDefault(); e.returnValue = ''; } });

function route() {
  leaveGuard = null;
  const { parts, q } = parseHash();
  const [a, b] = parts;
  document.title = 'Cifras';
  app.classList.toggle('wide', a === 'editar');
  if (!a) viewHome();
  else if (a === 'importar') viewImport();
  else if (a === 'musicas') viewLibrary();
  else if (a === 'lista' && getList(b)) viewList(getList(b));
  else if (a === 'cifra' && getSong(b)) viewSong(getSong(b), q);
  else if (a === 'editar') viewEditor(b, q);
  else { location.hash = '#/'; return; }
  window.scrollTo(0, 0);
}

// ---------- início ----------
function viewHome() {
  const lists = db.lists;
  const count = Object.keys(db.songs).length;
  app.innerHTML = `
    <h1>Suas listas</h1>
    <p class="sub">Cole links do YouTube (ou a mensagem inteira do grupo) e monte o repertório.</p>
    <div class="row">
      <a class="btn primary" href="#/importar">Importar do YouTube</a>
      <button class="btn" data-act="new-list">Nova lista vazia</button>
      <a class="btn" href="#/editar/nova">Nova cifra</a>
    </div>
    <h2>Listas</h2>
    ${lists.length ? `<ul class="rows">${lists.map((l) => {
      const it = itemsOf(l);
      const names = it.slice(0, 3).map((i) => getSong(i.songId)?.title).filter(Boolean).join(', ');
      return `<li><a class="main" href="#/lista/${l.id}"><strong>${esc(l.name)}</strong>
        <small>${it.length} ${it.length === 1 ? 'música' : 'músicas'}${names ? ' — ' + esc(names) + (it.length > 3 ? '…' : '') : ''}</small></a>
        ${db.drafts[l.id] ? '<span class="keybadge" style="color:var(--warn);background:var(--warn-soft)">não salva</span>' : ''}</li>`;
    }).join('')}</ul>`
      : '<div class="empty"><p>Nenhuma lista ainda.</p><a class="btn primary" href="#/importar">Importar músicas do YouTube</a></div>'}
    <h2>Biblioteca</h2>
    <ul class="rows"><li><a class="main" href="#/musicas"><strong>Todas as músicas</strong><small>${count} ${count === 1 ? 'cifra salva' : 'cifras salvas'} neste navegador</small></a></li></ul>
    <h2>Backup</h2>
    <p class="hint">Tudo fica salvo só neste navegador. Exporte um backup para levar para outro aparelho.</p>
    <div class="row">
      <button class="btn" data-act="backup">Exportar backup</button>
      <label class="btn">Importar backup<input type="file" accept=".json,application/json" data-act="restore" hidden></label>
    </div>`;
  app.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'new-list') { const l = newList(prompt('Nome da lista:', 'Nova lista') || 'Nova lista'); save(); location.hash = '#/lista/' + l.id; }
    if (act === 'backup') download(`cifras-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'cifras', version: 1, songs: db.songs, lists: db.lists }, null, 1), 'application/json');
  };
  app.onchange = async (e) => {
    if (e.target.dataset.act !== 'restore' || !e.target.files[0]) return;
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (!data.songs || !data.lists) throw new Error();
      Object.assign(db.songs, data.songs);
      for (const l of data.lists) { const i = db.lists.findIndex((x) => x.id === l.id); if (i >= 0) db.lists[i] = l; else db.lists.push(l); }
      save(); toast(`Backup importado: ${Object.keys(data.songs).length} cifras e ${data.lists.length} listas.`); viewHome();
    } catch { toast('Esse arquivo não é um backup válido do Cifras.'); }
  };
}

// ---------- importação ----------
let importState = { text: '', items: [] };
const metaCache = {};
async function fetchMeta(id) {
  if (metaCache[id]) return metaCache[id];
  const watch = `https://www.youtube.com/watch?v=${id}`;
  const tries = [
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`,
    `https://noembed.com/embed?url=${encodeURIComponent(watch)}`,
  ];
  for (const url of tries) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.title) return (metaCache[id] = { title: j.title, author: j.author_name || '' });
    } catch { /* tenta o próximo */ }
  }
  return null;
}

function viewImport() {
  const lists = db.lists;
  const st = importState;
  app.innerHTML = `
    <h1>Importar do YouTube</h1>
    <p class="sub">Cole links de vídeos e de playlists, soltos ou dentro de uma mensagem. A ordem dos links é mantida, e cada playlist entra na ordem dela. Links repetidos são ignorados.</p>
    <label class="field"><span>Links ou mensagem</span>
      <textarea id="imp-text" placeholder="Ex.: Pessoal, o repertório de domingo:
1. https://youtu.be/…
2. Música tal → https://www.youtube.com/watch?v=…">${esc(st.text)}</textarea></label>
    <div class="row"><button class="btn primary" data-act="find">Encontrar músicas</button></div>
    <div id="imp-pl" aria-live="polite"></div>
    <div class="import-results" id="imp-res"></div>`;
  const res = $('#imp-res');

  const videos = () => st.items.filter((x) => x.type === 'video');
  const draw = () => {
    if (!st.items.length) { res.innerHTML = st.searched ? '<div class="empty" style="margin-top:16px"><p>Nenhum link do YouTube encontrado nesse texto.</p></div>' : ''; return; }
    const n = videos().length;
    res.innerHTML = `
      <h2>${n} ${n === 1 ? 'música encontrada' : 'músicas encontradas'}</h2>
      <p class="hint">Confira artista e nome: eles são usados para buscar a cifra e a letra depois.</p>
      <ul class="rows">${st.items.map((it, i) => it.type === 'playlist' ? `
        <li data-i="${i}">
          <div class="inputs"><strong style="grid-column:1/-1">Playlist${it.context ? ': ' + esc(it.context) : ''}</strong>
            <span class="status">${esc(it.status || '')}</span></div>
          <button class="btn icon ghost" data-act="drop" title="Remover da importação" aria-label="Remover">×</button>
        </li>` : `
        <li data-i="${i}">
          <img class="thumb" alt="" loading="lazy" src="https://i.ytimg.com/vi/${it.id}/mqdefault.jpg">
          <div class="inputs">
            <label><span class="hint">Música</span><input type="text" data-f="title" placeholder="Nome da música" value="${esc(it.title)}"></label>
            <label><span class="hint">Artista</span><input type="text" data-f="artist" placeholder="Artista" value="${esc(it.artist)}"></label>
            <span class="status">${it.from ? `Da playlist${it.from === true ? '' : ' “' + esc(it.from) + '”'} · ` : ''}${esc(it.status || '')}
              ${it.list && !it.from ? ' <button class="btn small" data-act="expand">Importar a playlist inteira</button>' : ''}</span>
          </div>
          <button class="btn icon ghost" data-act="drop" title="Remover da importação" aria-label="Remover">×</button>
        </li>`).join('')}</ul>
      <h2>Destino</h2>
      <div class="fields">
        <label class="field"><span>Adicionar em</span>
          <select id="imp-dest"><option value="">Nova lista</option>${lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
        <label class="field" id="imp-name-wrap"><span>Nome da nova lista</span>
          <input type="text" id="imp-name" value="Repertório ${new Date().toLocaleDateString('pt-BR')}"></label>
      </div>
      <div class="row"><button class="btn primary" data-act="create" ${n && !st.items.some((x) => x.type === 'playlist' && x.reading) ? '' : 'disabled'}>Adicionar ${n} ${n === 1 ? 'música' : 'músicas'}</button></div>`;
    $('#imp-dest').onchange = (e) => { $('#imp-name-wrap').hidden = !!e.target.value; };
  };

  const liOf = (it) => res.querySelector(`li[data-i="${st.items.indexOf(it)}"]`);
  const setStatus = (it) => { const s = liOf(it)?.querySelector('.status'); if (s && !s.querySelector('button')) s.textContent = (it.from ? 'Da playlist · ' : '') + it.status; };
  const setField = (it) => {
    const li = liOf(it); if (!li) return;
    for (const f of ['title', 'artist']) { const inp = li.querySelector(`[data-f="${f}"]`); if (inp && document.activeElement !== inp) inp.value = it[f]; }
  };

  const mkVideo = (f, from = null) => {
    const existing = Object.values(db.songs).find((s) => s.ytId === f.id);
    return {
      type: 'video', id: f.id, url: f.url, list: f.list || '', from,
      existing: existing?.id || null,
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
          const sp = M.splitTitle(meta.title, meta.author);
          if (!it.touched) { it.title = sp.title || it.title; it.artist = sp.artist || it.artist; setField(it); }
          it.status = `No YouTube: “${meta.title}”`;
        } else it.status = 'Não consegui ler o título deste vídeo. Preencha à mão.';
        setStatus(it);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  /** Troca o item da playlist pelos vídeos dela, na mesma posição e na ordem da playlist. */
  async function resolvePlaylist(pl) {
    pl.reading = true; pl.status = 'Lendo a playlist…'; draw();
    let ids;
    try { ids = await P.playlistVideoIds(pl.list, $('#imp-pl')); } catch {
      pl.reading = false;
      pl.status = 'Não consegui ler esta playlist. Ela pode ser privada ou um mix automático do YouTube.';
      draw(); return;
    }
    const seen = new Set(videos().map((x) => x.id));
    const vids = ids.filter((id) => !seen.has(id) && seen.add(id))
      .map((id) => mkVideo({ id, url: `https://www.youtube.com/watch?v=${id}` }, pl.context || true));
    st.items.splice(st.items.indexOf(pl), 1, ...vids);
    draw();
    loadMeta();
  }

  async function find() {
    st.text = $('#imp-text').value;
    st.searched = true;
    st.items = M.extractYouTubeItems(st.text).map((f) => (f.type === 'video' ? mkVideo(f) : { type: 'playlist', list: f.list, context: f.context, status: 'Na fila…' }));
    draw();
    loadMeta();
    for (const pl of st.items.filter((x) => x.type === 'playlist')) await resolvePlaylist(pl);
  }

  app.oninput = (e) => {
    const li = e.target.closest('li[data-i]');
    if (li && e.target.dataset.f) { const it = st.items[li.dataset.i]; it[e.target.dataset.f] = e.target.value; it.touched = true; }
    if (e.target.id === 'imp-text') st.text = e.target.value;
  };
  app.onchange = null;
  app.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'find') find();
    if (act === 'drop') { st.items.splice(Number(e.target.closest('li').dataset.i), 1); draw(); }
    if (act === 'expand') {
      const it = st.items[Number(e.target.closest('li').dataset.i)];
      const pl = { type: 'playlist', list: it.list, context: it.title, status: '' };
      st.items.splice(st.items.indexOf(it), 0, pl);
      it.list = '';
      st.items.splice(st.items.indexOf(it), 1);
      resolvePlaylist(pl);
    }
    if (act === 'create') {
      const destId = $('#imp-dest').value;
      const list = destId ? getList(destId) : newList($('#imp-name').value.trim() || 'Nova lista');
      const target = db.drafts[list.id] ? db.drafts[list.id].items : list.items;
      for (const it of videos()) {
        const song = it.existing ? getSong(it.existing) : newSong({ title: it.title || 'Sem título', artist: it.artist, ytId: it.id });
        if (!target.some((x) => x.songId === song.id)) target.push({ songId: song.id, shift: 0 });
      }
      save();
      importState = { text: '', items: [] };
      toast('Músicas adicionadas. Use os botões do Cifra Club de cada linha para achar as cifras.');
      location.hash = '#/lista/' + list.id;
    }
  };
  draw();
}

// ---------- biblioteca ----------
function viewLibrary() {
  const songs = Object.values(db.songs).sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  app.innerHTML = `
    <h1>Todas as músicas</h1>
    <div class="row" style="margin:12px 0"><input type="search" id="lib-q" placeholder="Buscar por música ou artista" style="flex:1"><a class="btn" href="#/editar/nova">Nova cifra</a></div>
    <ul class="rows songs" id="lib-rows"></ul>`;
  const draw = (q = '') => {
    const n = q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const f = songs.filter((s) => `${s.title} ${s.artist}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(n));
    $('#lib-rows').innerHTML = f.length ? f.map((s) => `
      <li data-song="${s.id}"><a class="main" href="#/cifra/${s.id}"><strong>${esc(s.title)}</strong><small>${esc(s.artist || '—')}${s.content ? '' : ' · sem cifra ainda'}</small></a>
      <span class="ctrls">${songKey(s) ? `<span class="keybadge">${esc(songKey(s))}</span>` : ''}${playButton(s)}${ccButtons(s)}</span></li>`).join('')
      : '<li><span class="hint">Nada encontrado.</span></li>';
  };
  draw();
  markPlaying();
  $('#lib-q').oninput = (e) => { draw(e.target.value); markPlaying(); };
  app.oninput = null; app.onchange = null;
  app.onclick = (e) => {
    const b = e.target.closest('[data-act="play"]');
    if (b) P.play(getSong(b.dataset.song));
  };
}

// ---------- lista ----------
function viewList(list) {
  document.title = list.name + ' · Cifras';
  const draft = db.drafts[list.id];
  const items = itemsOf(list);
  const roots = M.SHARPS.map((_, i) => M.keyName(i, false));
  app.innerHTML = `
    <p style="margin:0"><a href="#/">← Listas</a></p>
    <h1>${esc(list.name)}</h1>
    <p class="sub">${items.length} ${items.length === 1 ? 'música' : 'músicas'}. Arraste ⠿ para reordenar.</p>
    ${draft ? `
      <div class="banner" role="status"><p><strong>Edição em lote em andamento.</strong> As mudanças ficam guardadas mesmo se você abrir uma cifra para editar. Salve para aplicar à lista.</p>
        <div class="row"><button class="btn small" data-act="discard">Descartar</button><button class="btn small primary" data-act="commit">Salvar alterações</button></div></div>
      <div class="batchbar">
        <span>Mudar todas para</span>
        <select class="key" id="all-key"><option value="">tom…</option>${roots.map((r) => `<option>${r}</option>`).join('')}</select>
        <button class="btn small" data-act="reset-all">Voltar todas ao tom original</button>
        <span class="hint">Músicas em tom menor vão para o menor da mesma nota (ex.: A → Am).</span>
      </div>` : `
      <div class="row" style="margin-bottom:14px">
        <button class="btn" data-act="batch">Editar em lote</button>
        <button class="btn" data-act="add">Adicionar músicas</button>
        <button class="btn" data-act="export">Exportar</button>
        <button class="btn" data-act="print">Imprimir / PDF</button>
        <button class="btn ghost" data-act="rename">Renomear</button>
        <button class="btn ghost warn" data-act="delete">Excluir lista</button>
      </div>`}
    ${items.length ? `<ul class="rows songs" id="list-rows">${items.map((it, i) => {
      const s = getSong(it.songId);
      if (!s) return '';
      const k = keyLabel(s, it.shift);
      const orig = songKey(s);
      return `<li data-i="${i}" data-song="${s.id}">
        <span class="handle" aria-hidden="true">⠿</span>
        <span class="num">${i + 1}</span>
        <a class="main" href="#/cifra/${s.id}?lista=${list.id}"><strong>${esc(s.title)}</strong><small>${esc(s.artist || '—')}${s.content ? '' : ' · sem cifra ainda'}</small></a>
        ${draft ? `<span class="ctrls">
          ${playButton(s)}${ccButtons(s)}
          <span class="stepper"><button class="btn" data-act="down" aria-label="Meio tom abaixo">−</button>
          <span class="keybadge" title="Tom original: ${esc(orig || 'não definido')}">${esc(k)}</span>
          <button class="btn" data-act="up" aria-label="Meio tom acima">+</button></span>
          <a class="btn small" href="#/editar/${s.id}?volta=${encodeURIComponent('/lista/' + list.id)}">Editar cifra</a>
          <button class="btn icon ghost" data-act="remove" aria-label="Tirar da lista" title="Tirar da lista">×</button></span>`
        : `<span class="ctrls"><span class="keybadge">${it.shift && orig ? `<span class="from">${esc(orig)} → </span>` : ''}${esc(k)}</span>${playButton(s)}${ccButtons(s)}</span>`}
      </li>`;
    }).join('')}</ul>`
    : `<div class="empty"><p>Lista vazia.</p><div class="row" style="justify-content:center"><a class="btn primary" href="#/importar">Importar do YouTube</a><button class="btn" data-act="add">Adicionar da biblioteca</button></div></div>`}
    <dialog id="dlg"></dialog>`;

  markPlaying();
  const editItems = () => (db.drafts[list.id] ? db.drafts[list.id].items : list.items);
  const persist = () => { save(); viewList(list); };

  loadScript('https://cdn.jsdelivr.net/npm/sortablejs@1.15/Sortable.min.js').then(() => {
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

  app.oninput = null;
  app.onchange = (e) => {
    if (e.target.id === 'all-key' && e.target.value) {
      let skipped = 0;
      for (const it of editItems()) {
        const s = getSong(it.songId);
        const orig = songKey(s);
        if (!orig) { skipped++; continue; }
        it.shift = M.semitonesBetween(orig, M.keyWithRootOf(orig, e.target.value));
      }
      persist();
      if (skipped) toast(`${skipped} ${skipped === 1 ? 'música sem tom original definido ficou' : 'músicas sem tom original definido ficaram'} como estava.`);
    }
  };
  app.onclick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const i = Number(btn.closest('li[data-i]')?.dataset.i);
    const arr = editItems();
    switch (act) {
      case 'play': {
        const queue = list.items.map((x) => getSong(x.songId)).filter((x) => x && x.ytId);
        P.play(getSong(btn.dataset.song), { queue });
        break;
      }
      case 'batch': db.drafts[list.id] = { items: list.items.map((x) => ({ ...x })), startedAt: Date.now() }; persist(); break;
      case 'commit': list.items = db.drafts[list.id].items; delete db.drafts[list.id]; persist(); toast('Alterações salvas na lista.'); break;
      case 'discard': if (confirm('Descartar as alterações em lote desta lista?')) { delete db.drafts[list.id]; persist(); } break;
      case 'reset-all': arr.forEach((x) => { x.shift = 0; }); persist(); break;
      case 'up': arr[i].shift = wrap(arr[i].shift + 1); persist(); break;
      case 'down': arr[i].shift = wrap(arr[i].shift - 1); persist(); break;
      case 'remove': arr.splice(i, 1); persist(); break;
      case 'rename': { const n = prompt('Nome da lista:', list.name); if (n) { list.name = n.trim(); persist(); } break; }
      case 'delete': if (confirm(`Excluir a lista “${list.name}”? As cifras continuam na biblioteca.`)) { db.lists = db.lists.filter((l) => l !== list); delete db.drafts[list.id]; save(); location.hash = '#/'; } break;
      case 'print': printSongs(list.items.map((x) => ({ song: getSong(x.songId), shift: x.shift })).filter((x) => x.song)); break;
      case 'export': openExportList(list); break;
      case 'add': openAddSongs(list, arr, persist); break;
      default:
    }
  };
}

/** Atalhos para o Cifra Club direto na linha da lista. */
function playButton(s) {
  return s.ytId ? `<button class="btn small icon" data-act="play" data-song="${s.id}" aria-label="Ouvir ${esc(s.title)}" title="Ouvir / ver o vídeo">▶</button>` : '';
}
/** Destaca a linha da música que está tocando no player. */
function markPlaying() {
  const cur = P.current();
  $$('li[data-song]').forEach((li) => li.classList.toggle('playing', !!cur && li.dataset.song === cur.id));
}
P.onChange(markPlaying);

function ccButtons(s) {
  const cc = M.cifraClubLinks(s.artist, s.title);
  return `${cc.direct ? `<a class="btn small" href="${cc.direct}" target="_blank" rel="noopener" title="Abrir a cifra no Cifra Club">Cifra Club</a>` : ''}
    <a class="btn small icon" href="${cc.search}" target="_blank" rel="noopener" title="Buscar no Cifra Club" aria-label="Buscar ${esc(s.title)} no Cifra Club">🔍</a>`;
}

function openExportList(list) {
  const dlg = $('#dlg');
  const entries = list.items.map((x) => ({ song: getSong(x.songId), shift: x.shift })).filter((x) => x.song);
  dlg.innerHTML = `<h2>Exportar “${esc(list.name)}”</h2>
    <p class="hint">Os arquivos saem no tom definido na lista.</p>
    <div class="row">
      <button class="btn" data-x="txt">Texto (.txt)</button>
      <button class="btn" data-x="cho">ChordPro (.cho)</button>
      <button class="btn" data-x="json">Backup da lista (.json)</button>
    </div>
    <div class="row end" style="margin-top:18px"><button class="btn" data-x="close">Fechar</button></div>`;
  dlg.onclick = (e) => {
    const x = e.target.dataset.x;
    if (x === 'txt') download(`${list.name}.txt`, `${list.name}\n${'='.repeat(list.name.length)}\n\n` + entries.map((en, i) => `${i + 1}. ` + songText(en.song, en.shift)).join('\n\n'));
    if (x === 'cho') download(`${list.name}.cho`, entries.map((en) => songChordPro(en.song, en.shift)).join('\n{new_song}\n\n'));
    if (x === 'json') {
      const songs = Object.fromEntries(entries.map((en) => [en.song.id, en.song]));
      download(`${list.name}.json`, JSON.stringify({ app: 'cifras', version: 1, songs, lists: [list] }, null, 1), 'application/json');
    }
    if (x === 'close') dlg.close();
  };
  dlg.showModal();
}

function openAddSongs(list, arr, persist) {
  const dlg = $('#dlg');
  const inList = new Set(arr.map((x) => x.songId));
  const songs = Object.values(db.songs).filter((s) => !inList.has(s.id)).sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  dlg.innerHTML = `<h2>Adicionar músicas</h2>
    ${songs.length ? `<ul class="rows" style="max-height:50vh;overflow:auto">${songs.map((s) => `
      <li><label class="main" style="display:flex;gap:10px;align-items:center;cursor:pointer"><input type="checkbox" value="${s.id}">
      <span style="min-width:0"><strong>${esc(s.title)}</strong><small>${esc(s.artist || '—')}</small></span></label></li>`).join('')}</ul>`
      : '<p class="hint">Todas as músicas da biblioteca já estão nesta lista.</p>'}
    <div class="row end" style="margin-top:16px">
      <a class="btn ghost" href="#/importar">Importar do YouTube</a>
      <a class="btn ghost" href="#/editar/nova?lista=${list.id}">Nova cifra</a>
      <button class="btn" data-x="close">Cancelar</button>
      <button class="btn primary" data-x="ok">Adicionar</button></div>`;
  dlg.onclick = (e) => {
    const x = e.target.dataset.x;
    if (x === 'close') dlg.close();
    if (x === 'ok') {
      $$('input:checked', dlg).forEach((c) => arr.push({ songId: c.value, shift: 0 }));
      dlg.close(); persist();
    }
  };
  dlg.showModal();
}

// ---------- cifra ----------
const view = { songId: null, shift: 0, video: false };

function viewSong(song, q) {
  const list = q.lista ? getList(q.lista) : null;
  const items = list ? itemsOf(list) : null;
  const idx = items ? items.findIndex((x) => x.songId === song.id) : -1;
  const item = idx >= 0 ? items[idx] : null;
  if (view.songId !== song.id || view.listId !== (list?.id || null)) {
    view.songId = song.id;
    view.listId = list?.id || null;
    view.shift = item ? item.shift : 0;
    if (q.tom && songKey(song)) view.shift = M.semitonesBetween(songKey(song), M.keyWithRootOf(songKey(song), q.tom));
    view.video = false;
  }
  document.title = `${song.title} · Cifras`;
  const orig = songKey(song);
  const shown = keyLabel(song, view.shift);
  const keys = orig ? M.SHARPS.map((_, i) => M.keyName(i, M.parseKey(orig).minor)) : [];
  const cc = M.cifraClubLinks(song.artist, song.title);
  const draft = list && db.drafts[list.id];
  const savedShift = item ? item.shift : 0;
  const prev = idx > 0 ? getSong(items[idx - 1].songId) : null;
  const next = item && idx < items.length - 1 ? getSong(items[idx + 1].songId) : null;
  const fontSize = db.prefs.fontSize || 1.12;

  app.innerHTML = `
    <p style="margin:0">${list ? `<a href="#/lista/${list.id}">← ${esc(list.name)}</a>${idx >= 0 ? ` <span class="hint">· ${idx + 1} de ${items.length}</span>` : ''}` : '<a href="#/musicas">← Biblioteca</a>'}</p>
    <div class="song-head">
      <div><h1>${esc(song.title)}</h1><p class="artist">${esc(song.artist || '')}</p></div>
      <div class="keyctl" role="group" aria-label="Tom">
        <span class="label">Tom</span>
        <button class="btn icon ghost" data-act="down" aria-label="Meio tom abaixo">−</button>
        ${orig ? `<select class="key bigkey" id="key-sel" aria-label="Escolher tom">${keys.map((k) => `<option ${k === shown ? 'selected' : ''}>${k}</option>`).join('')}</select>`
          : `<span class="bigkey">${esc(shown)}</span>`}
        <button class="btn icon ghost" data-act="up" aria-label="Meio tom acima">+</button>
        ${view.shift ? `<span class="orig">original ${esc(orig || '?')}</span>` : ''}
      </div>
    </div>
    ${!orig && song.content ? '<p class="hint">Defina o tom original no editor para escolher o tom pelo nome.</p>' : ''}
    ${list && item && view.shift !== savedShift ? `<div class="banner info"><p>Este tom ainda não está salvo na lista${draft ? ' (rascunho da edição em lote)' : ''}.</p><button class="btn small primary" data-act="save-shift">Usar ${esc(shown)} na lista</button></div>` : ''}
    ${!list && view.shift && orig ? `<div class="banner info"><p>Você está vendo a cifra em ${esc(shown)}; o original é ${esc(orig)}.</p><button class="btn small" data-act="fix-key">Tornar ${esc(shown)} o tom original</button></div>` : ''}
    <div class="toolbar">
      ${song.ytId ? '<button class="btn" data-act="video">▶ Ouvir / vídeo</button>' : ''}
      <a class="btn" href="#/editar/${song.id}${list ? '?volta=' + encodeURIComponent('/cifra/' + song.id + '?lista=' + list.id) : ''}">Editar</a>
      <button class="btn" data-act="cc">Cifra Club</button>
      <button class="btn" data-act="stage" ${song.content ? '' : 'disabled'}>Modo rolagem</button>
      <button class="btn" data-act="mic">🎤 Conferir tom</button>
      <button class="btn" data-act="notation">Partitura e tab</button>
      <button class="btn" data-act="more">Exportar</button>
      <span class="row" style="margin-left:auto;gap:2px;flex-wrap:nowrap">
      <button class="btn icon ghost" data-act="smaller" aria-label="Diminuir letra">A−</button>
      <button class="btn icon ghost" data-act="bigger" aria-label="Aumentar letra">A+</button></span>
    </div>
    ${song.content ? `<div class="sheet" style="--lyric-size:${fontSize}rem">${renderSheet(transposedContent(song, view.shift))}</div>`
      : `<div class="empty"><p>Ainda não há cifra para esta música.</p>
        <div class="row" style="justify-content:center">
          ${cc.direct ? `<a class="btn primary" href="${cc.direct}" target="_blank" rel="noopener">Abrir no Cifra Club</a>` : ''}
          <a class="btn" href="${cc.search}" target="_blank" rel="noopener">Buscar no Cifra Club</a>
          <a class="btn" href="#/editar/${song.id}${list ? '?volta=' + encodeURIComponent('/cifra/' + song.id + '?lista=' + list.id) : ''}">Colar ou escrever a cifra</a>
          ${CAN_TAB && song.ytId ? `<a class="btn" href="#/editar/${song.id}?gerar=aba${list ? '&volta=' + encodeURIComponent('/cifra/' + song.id + '?lista=' + list.id) : ''}">Gerar acordes pelo vídeo</a>` : ''}
        </div>
        <p class="hint" style="margin:14px 0 0">Copie a cifra no Cifra Club e cole no editor: o formato “acordes em cima da letra” é convertido sozinho. No editor também dá para gerar um rascunho dos acordes por um arquivo de áudio ou pelo microfone.</p></div>`}
    ${list && (prev || next) ? `<nav class="pager">
      ${prev ? `<a href="#/cifra/${prev.id}?lista=${list.id}"><small>← Anterior</small><span>${esc(prev.title)}</span></a>` : '<span style="flex:1"></span>'}
      ${next ? `<a class="next" href="#/cifra/${next.id}?lista=${list.id}"><small>Próxima →</small><span>${esc(next.title)}</span></a>` : '<span style="flex:1"></span>'}
    </nav>` : ''}
    <dialog id="dlg"></dialog>`;

  const rerender = () => viewSong(song, q);
  app.oninput = null;
  app.onchange = (e) => {
    if (e.target.id === 'key-sel') { view.shift = M.semitonesBetween(orig, e.target.value); rerender(); }
  };
  app.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'up': view.shift = wrap(view.shift + 1); rerender(); break;
      case 'down': view.shift = wrap(view.shift - 1); rerender(); break;
      case 'save-shift': item.shift = view.shift; save(); rerender(); toast(draft ? 'Tom guardado no rascunho da lista.' : 'Tom salvo na lista.'); break;
      case 'fix-key':
        song.content = transposedContent(song, view.shift);
        song.key = shiftedKey(song, view.shift);
        if (song.melody) { try { song.melody = shiftMelodyText(song.melody, view.shift); } catch { /* melodia inválida fica como está */ } }
        song.updatedAt = Date.now(); view.shift = 0; save(); rerender(); break;
      case 'video': P.play(song, { queue: items ? items.map((x) => getSong(x.songId)).filter((x) => x && x.ytId) : null }); break;
      case 'bigger': case 'smaller':
        db.prefs.fontSize = Math.min(2.2, Math.max(0.8, (db.prefs.fontSize || 1.12) + (btn.dataset.act === 'bigger' ? 0.1 : -0.1)));
        save(); $('.sheet')?.style.setProperty('--lyric-size', db.prefs.fontSize + 'rem'); break;
      case 'cc': openCifraClub(song, list); break;
      case 'more': openExportSong(song); break;
      case 'stage': {
        const f = await import('./features.js?v=5');
        f.openStage({ song, html: renderSheet(transposedContent(song, view.shift)), keyLabel: keyLabel(song, view.shift), prefs: db.prefs, savePrefs: save, saveBpm: (b) => { song.bpm = b; save(); }, playVideo: () => P.play(song) });
        break;
      }
      case 'mic': {
        const f = await import('./features.js?v=5');
        f.openMic({
          song, shownKey: shiftedKey(song, view.shift), originalKey: orig,
          lists: db.lists, currentList: list,
          applyKey: (k) => { view.shift = M.semitonesBetween(orig, k); rerender(); },
          saveToCurrentList: list && item ? (k) => { view.shift = M.semitonesBetween(orig, k); item.shift = view.shift; save(); rerender(); } : null,
          addToList: (listId, k) => {
            const l = listId === '__new' ? newList(prompt('Nome da nova lista:', 'Nova lista') || 'Nova lista') : getList(listId);
            const target = itemsOf(l);
            const shift = orig ? M.semitonesBetween(orig, k) : 0;
            const existing = target.find((x) => x.songId === song.id);
            if (existing) existing.shift = shift; else target.push({ songId: song.id, shift });
            save(); toast(`Adicionada em “${l.name}” no tom ${k}.`);
          },
        });
        break;
      }
      case 'notation': {
        const f = await import('./features.js?v=5');
        f.openNotation({
          song, shift: view.shift, keyLabel: shiftedKey(song, view.shift) || 'C',
          saveMelody: (txt) => { song.melody = txt; song.updatedAt = Date.now(); save(); },
        });
        break;
      }
      default:
    }
  };
}

function shiftMelodyText(text, semis) {
  const notes = M.transposeMelody(M.parseMelody(text), semis);
  return notes.map((n) => (n.bar ? '|' : n.rest ? `R:${n.dur}` : M.midiName(n.midi, false) + (n.dur !== 1 ? `:${n.dur}` : ''))).join(' ');
}

function openCifraClub(song, list) {
  const dlg = $('#dlg');
  const cc = M.cifraClubLinks(song.artist, song.title);
  const back = list ? '?volta=' + encodeURIComponent('/cifra/' + song.id + '?lista=' + list.id) : '';
  dlg.innerHTML = `<h2>Cifra Club</h2>
    <p>Procurando <strong>${esc(song.title)}</strong>${song.artist ? ` de ${esc(song.artist)}` : ''}.</p>
    <div class="row">
      ${cc.direct ? `<a class="btn primary" href="${cc.direct}" target="_blank" rel="noopener">Abrir página da música</a>` : ''}
      <a class="btn" href="${cc.search}" target="_blank" rel="noopener">Buscar no Cifra Club</a>
      <a class="btn" href="${cc.google}" target="_blank" rel="noopener">Buscar pelo Google</a>
    </div>
    <p class="hint">Se a página direta não existir, use a busca. Depois copie a cifra (letra com acordes em cima) e cole no editor; ela é convertida automaticamente.</p>
    <div class="row end"><button class="btn" data-x="close">Fechar</button><a class="btn" href="#/editar/${song.id}${back}">Abrir editor</a></div>`;
  dlg.onclick = (e) => { if (e.target.dataset.x === 'close') dlg.close(); };
  dlg.showModal();
}

function openExportSong(song) {
  const dlg = $('#dlg');
  dlg.innerHTML = `<h2>Exportar “${esc(song.title)}”</h2>
    <p class="hint">No tom que está na tela (${esc(keyLabel(song, view.shift))}).</p>
    <div class="row">
      <button class="btn" data-x="txt">Texto (.txt)</button>
      <button class="btn" data-x="cho">ChordPro (.cho)</button>
      <button class="btn" data-x="print">Imprimir / PDF</button>
      <button class="btn" data-x="copy">Copiar texto</button>
    </div>
    <div class="row end" style="margin-top:18px"><button class="btn" data-x="close">Fechar</button></div>`;
  dlg.onclick = async (e) => {
    const x = e.target.dataset.x;
    const name = `${song.title}${song.artist ? ' - ' + song.artist : ''}`;
    if (x === 'txt') download(name + '.txt', songText(song, view.shift));
    if (x === 'cho') download(name + '.cho', songChordPro(song, view.shift));
    if (x === 'print') { dlg.close(); printSongs([{ song, shift: view.shift }]); }
    if (x === 'copy') { try { await navigator.clipboard.writeText(songText(song, view.shift)); toast('Cifra copiada.'); } catch { toast('O navegador bloqueou a cópia.'); } }
    if (x === 'close') dlg.close();
  };
  dlg.showModal();
}

// ---------- editor ----------
function viewEditor(id, q) {
  const isNew = id === 'nova';
  const song = isNew ? { title: '', artist: '', ytId: '', key: '', bpm: 80, content: '', melody: '' } : getSong(id);
  if (!song) { location.hash = '#/'; return; }
  const back = q.volta ? '#' + q.volta : isNew ? (q.lista ? '#/lista/' + q.lista : '#/musicas') : '#/cifra/' + song.id;
  const batchList = q.volta && q.volta.startsWith('/lista/') ? getList(q.volta.split('/')[2]) : null;
  const allKeys = M.KEYS;
  document.title = (song.title || 'Nova cifra') + ' · editar';
  app.innerHTML = `
    <p style="margin:0"><a href="${back}" data-act="back">← Voltar</a></p>
    <h1>${isNew ? 'Nova cifra' : 'Editar cifra'}</h1>
    ${batchList && db.drafts[batchList.id] ? `<div class="banner info"><p>Você veio da edição em lote de <strong>${esc(batchList.name)}</strong>. As mudanças da lista continuam guardadas; ao salvar ou voltar, você retorna a ela.</p></div>` : ''}
    <div class="editor-grid">
      <form id="ed" autocomplete="off">
        <div class="fields">
          <label class="field"><span>Música</span><input type="text" name="title" required value="${esc(song.title)}"></label>
          <label class="field"><span>Artista</span><input type="text" name="artist" value="${esc(song.artist)}"></label>
          <label class="field"><span>Tom original</span>
            <span class="row" style="flex-wrap:nowrap"><select name="key" class="key" style="flex:1"><option value="">não definido</option>${allKeys.map((k) => `<option ${k === songKey(song) ? 'selected' : ''}>${k}</option>`).join('')}</select>
            <button type="button" class="btn small" data-act="guess">Detectar</button></span></label>
          <label class="field"><span>Andamento (BPM)</span><input type="number" name="bpm" min="30" max="260" value="${esc(song.bpm || 80)}"></label>
          <label class="field full"><span>Vídeo do YouTube</span><input type="text" name="yt" placeholder="Cole o link do vídeo" value="${song.ytId ? 'https://youtu.be/' + song.ytId : ''}"></label>
        </div>
        <label class="field"><span>Cifra</span>
          <textarea class="code" name="content" spellcheck="false" placeholder="Cole aqui a cifra (do Cifra Club ou de onde quiser) ou escreva com os acordes entre colchetes:
[G]Quando eu digo que dei[D/F#]xei de te amar">${esc(song.content)}</textarea></label>
        <div class="row" style="margin:-6px 0 6px"><button type="button" class="btn small" data-act="convert">Converter “acordes em cima da letra”</button>
          <button type="button" class="btn small ghost" data-act="cc">Buscar no Cifra Club</button></div>
        <div class="row" style="margin:0 0 6px"><span class="hint">Gerar rascunho (acordes e letra):</span>
          ${CAN_TAB ? '<button type="button" class="btn small" data-act="gen-tab">▶ Pelo vídeo (sem baixar)</button>' : ''}
          <button type="button" class="btn small" data-act="gen-file">Pelo arquivo de áudio</button>
          <button type="button" class="btn small" data-act="gen-mic">🎤 Pelo microfone</button></div>
        <details class="help"><summary>Como escrever a cifra</summary>
          <p>Acordes vão entre colchetes, logo antes da sílaba: <code>[Am]Tudo [F]bem</code>. Seções: <code>{c: Refrão}</code>. Tablaturas ficam entre <code>{sot}</code> e <code>{eot}</code>.
          Se você colar uma cifra no formato tradicional, com os acordes na linha de cima, ela é convertida sozinha.</p></details>
        <label class="field"><span>Melodia principal (opcional)</span>
          <textarea name="melody" class="code" style="min-height:90px" spellcheck="false" placeholder="E4 G4 A4:2 | B4:0.5 A4:0.5 G4 R:1">${esc(song.melody || '')}</textarea></label>
        <details class="help"><summary>Como escrever a melodia</summary>
          <p>Uma nota por palavra: nome + oitava (<code>C4</code> é o dó central). Duração em tempos depois de dois-pontos: <code>A4:2</code> (mínima), <code>B4:0.5</code> (colcheia). Pausa: <code>R:1</code>. Barra de compasso: <code>|</code>.
          A melodia vira partitura e tablatura com o nome de cada nota, no tom escolhido.</p></details>
        <div class="row" style="margin-top:8px">
          <button class="btn primary" type="submit">Salvar</button>
          <a class="btn" href="${back}" data-act="back">Cancelar</a>
          <span style="flex:1"></span>
          ${isNew ? '' : '<button type="button" class="btn ghost warn" data-act="del">Excluir cifra</button>'}
        </div>
      </form>
      <section class="preview" aria-label="Pré-visualização"><div class="sheet" id="pv"></div></section>
    </div>
    <dialog id="dlg"></dialog>`;

  const form = $('#ed');
  const ta = form.content;
  let dirty = false;
  leaveGuard = () => dirty;
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
    const ytFound = M.extractYouTube(form.yt.value)[0];
    const data = {
      title: form.title.value.trim() || 'Sem título', artist: form.artist.value.trim(), key: form.key.value,
      bpm: Number(form.bpm.value) || 80, content: ta.value, melody: form.melody.value.trim(),
      ytId: ytFound ? ytFound.id : (form.yt.value.trim() ? song.ytId : ''),
    };
    if (data.melody) { try { M.parseMelody(data.melody); } catch (err) { toast(err.message); form.melody.focus(); return; } }
    let s;
    if (isNew) {
      s = newSong(data);
      if (q.lista && getList(q.lista)) itemsOf(getList(q.lista)).push({ songId: s.id, shift: 0 });
    } else { s = Object.assign(song, data, { updatedAt: Date.now() }); }
    save(); dirty = false;
    toast('Cifra salva.');
    location.hash = q.volta ? '#' + q.volta : '#/cifra/' + s.id + (q.lista ? '?lista=' + q.lista : '');
  };

  function openGenerator(mode) {
    const yt = M.extractYouTube(form.yt.value)[0];
    if (mode === 'mic' || mode === 'file' || yt) { /* ok */ } else { toast('Cole o link do vídeo do YouTube no campo “Vídeo do YouTube” primeiro.'); form.yt.focus(); return; }
    import('./chords.js?v=5').then((c) => c.openChordGenerator({
      mode,
      song: { id: song.id || 'novo', title: form.title.value, artist: form.artist.value, ytId: yt ? yt.id : '' },
      player: P,
      bpm: Number(form.bpm.value) || 80, title: form.title.value, hasContent: !!ta.value.trim(),
      renderSheet, toast,
      onApply: ({ text, key, bpm, append }) => {
        ta.value = append ? ta.value.replace(/\s*$/, '\n\n') + text : text;
        if (!append || !form.key.value) form.key.value = key;
        form.bpm.value = bpm;
        dirty = true; preview();
        toast('Rascunho inserido. Revise e salve.');
      },
    }));
  }
  if (q.gerar === 'aba' && CAN_TAB) openGenerator('tab');

  app.oninput = null; app.onchange = null;
  app.onclick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'back' && dirty && !confirm('Sair sem salvar as mudanças desta cifra?')) { e.preventDefault(); return; }
    if (act === 'back') dirty = false;
    if (act === 'guess') { const g = M.guessKey(ta.value); if (g) { form.key.value = g; dirty = true; toast(`Tom sugerido pelo primeiro acorde: ${g}.`); } else toast('Não encontrei acordes para sugerir o tom.'); }
    if (act === 'gen-file' || act === 'gen-mic' || act === 'gen-tab') openGenerator(act.slice(4));
    if (act === 'convert') { ta.value = M.chordsOverLyricsToChordPro(ta.value); dirty = true; preview(); }
    if (act === 'cc') {

      const cc = M.cifraClubLinks(form.artist.value, form.title.value);
      window.open(cc.direct || cc.search, '_blank', 'noopener');
    }
    if (act === 'del' && confirm('Excluir esta cifra da biblioteca e de todas as listas?')) {
      delete db.songs[song.id];
      for (const l of db.lists) l.items = l.items.filter((x) => x.songId !== song.id);
      for (const d of Object.values(db.drafts)) d.items = d.items.filter((x) => x.songId !== song.id);
      dirty = false; save(); location.hash = '#/musicas';
    }
  };
}

// ---------- global ----------
$('#mic-global').onclick = async () => {
  const f = await import('./features.js?v=5');
  f.openMic({
    song: null, lists: db.lists, songs: Object.values(db.songs).filter((s) => songKey(s)),
    openSongInKey: (songId, k) => { location.hash = `#/cifra/${songId}?tom=${encodeURIComponent(k)}`; },
  });
};

route();
