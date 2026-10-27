// Ferramenta: rascunho de cifra (acordes + letra) a partir de um vídeo, arquivo ou do microfone.
import { openChordGenerator } from '/lib/widgets/chords.js';
import { renderSheet } from '/lib/music/sheet.js';
import { chordProToText } from '/lib/music/theory.js';
import { extractYouTube, fetchMeta, splitTitle } from '/lib/youtube/links.js';
import { canCaptureTab } from '/lib/audio/io.js';
import { $, esc, toast, download, slug } from '/lib/core/ui.js';

const st = { title: '', artist: '', url: '', result: null };

export default {
  title: 'Acordes de um áudio',
  render(el) {
    el.innerHTML = `<h1 class="h2">Acordes de um áudio</h1>
      <p class="text-body-secondary">Gera um rascunho de cifra: os acordes vêm do áudio e a letra do banco LRCLIB ou da transcrição por IA. Tudo no seu aparelho.</p>
      <section class="card mb-4"><div class="card-body">
        <div class="row g-2">
          <div class="col-md-6"><label class="form-label small mb-0" for="ac-title">Música</label><input class="form-control" id="ac-title" value="${esc(st.title)}" placeholder="Usado para buscar a letra"></div>
          <div class="col-md-6"><label class="form-label small mb-0" for="ac-artist">Artista</label><input class="form-control" id="ac-artist" value="${esc(st.artist)}"></div>
          <div class="col-12"><label class="form-label small mb-0" for="ac-url">Vídeo do YouTube (para gerar pelo vídeo)</label><input class="form-control" id="ac-url" value="${esc(st.url)}" placeholder="Cole o link do vídeo"></div>
        </div>
        <div class="d-flex flex-wrap gap-2 mt-3">
          ${canCaptureTab() ? '<button class="btn btn-primary" type="button" data-g="tab"><i class="bi bi-youtube"></i> Pelo vídeo</button>' : ''}
          <button class="btn btn-outline-primary" type="button" data-g="file"><i class="bi bi-file-earmark-music"></i> Pelo arquivo</button>
          <button class="btn btn-outline-primary" type="button" data-g="mic"><i class="bi bi-mic"></i> Pelo microfone</button>
        </div>
      </div></section>
      <section id="result"></section>`;
    const sync = () => { st.title = $('#ac-title').value; st.artist = $('#ac-artist').value; st.url = $('#ac-url').value; };
    $('#ac-url').addEventListener('change', async () => {
      sync();
      const it = extractYouTube(st.url)[0];
      if (!it || st.title) return;
      const meta = await fetchMeta(it.id);
      if (meta) { const sp = splitTitle(meta.title, meta.author); st.title = sp.title; st.artist ||= sp.artist; if (el.isConnected) { $('#ac-title').value = st.title; $('#ac-artist').value = st.artist; } }
    });
    el.oninput = sync;
    el.onclick = async (e) => {
      const g = e.target.closest('[data-g]')?.dataset.g;
      if (g) {
        sync();
        const yt = extractYouTube(st.url)[0];
        if (g === 'tab' && !yt) { toast('Cole o link do vídeo primeiro.'); $('#ac-url').focus(); return; }
        openChordGenerator({
          mode: g, song: { id: 'acordes', title: st.title, artist: st.artist, ytId: yt?.id || '' },
          applyLabel: 'Usar este rascunho',
          onApply: (r) => { st.result = { ...r, title: st.title, artist: st.artist, ytId: yt?.id || '' }; drawResult(); },
        });
      }
      const a = e.target.closest('[data-r]')?.dataset.r;
      if (!a || !st.result) return;
      const r = st.result;
      const name = slug(r.title || 'rascunho') || 'rascunho';
      if (a === 'cho') download(`${name}.cho`, `{title: ${r.title || 'Rascunho'}}\n${r.artist ? `{artist: ${r.artist}}\n` : ''}{key: ${r.key}}\n{tempo: ${r.bpm}}\n\n${r.text}`);
      if (a === 'txt') download(`${name}.txt`, chordProToText(r.text));
      if (a === 'copy') { try { await navigator.clipboard.writeText(chordProToText(r.text)); toast('Copiado.', 'success'); } catch { toast('O navegador bloqueou a cópia.'); } }
      if (a === 'cifras') {
        localStorage.setItem('cifras.handoff', JSON.stringify({ title: r.title, artist: r.artist, ytId: r.ytId, key: r.key, bpm: r.bpm, content: r.text }));
        location.hash = '#/cifras/editar/nova?de=acordes';
      }
    };
    if (st.result) drawResult();
  },
};

function drawResult() {
  const box = $('#result');
  if (!box) return;
  const r = st.result;
  box.innerHTML = `<div class="d-flex flex-wrap align-items-center gap-2 mb-2"><h2 class="h5 mb-0 me-auto">Rascunho${r.title ? ': ' + esc(r.title) : ''} <span class="badge text-bg-primary">${esc(r.key)}</span> <span class="badge text-bg-secondary">${r.bpm} BPM</span></h2>
      <button class="btn btn-primary btn-sm" type="button" data-r="cifras"><i class="bi bi-music-note-list"></i> Levar para o Cifras</button>
      <button class="btn btn-outline-secondary btn-sm" type="button" data-r="copy"><i class="bi bi-clipboard"></i> Copiar</button>
      <button class="btn btn-outline-secondary btn-sm" type="button" data-r="cho">.cho</button>
      <button class="btn btn-outline-secondary btn-sm" type="button" data-r="txt">.txt</button></div>
    <div class="sheet">${renderSheet(r.text)}</div>`;
}
