// Escolha da fonte de áudio: um vídeo do YouTube (ouvido pelo player do site), um arquivo
// ou uma gravação (microfone / outra entrada). Devolve o áudio pronto para analisar.
import * as P from '../youtube/player.js';
import { extractYouTube, fetchMeta, startTimeOf } from '../youtube/links.js';
import { canCaptureTab, captureThisTab, captureError, Recorder, decodeFile, getInput, listInputs } from '../audio/io.js';
import { esc, mmss, parseTime, toast, progressHtml, setProgress, uid } from '../core/ui.js';

/**
 * opts: {
 *   label, range: 'required' | 'optional' | 'none', defaultRange: [início, fim],
 *   modes: ['youtube','file','mic'], action: texto do botão, hint: dica do trecho,
 *   onAudio(audio) -> audio = { channels, sampleRate, label, kind, ytId?, start, end }
 *   onVideo({ ytId, title })   (vídeo carregado)
 * }
 * Retorna { setVideo(url), busy(on), info() }.
 */
export function audioSource(el, opts = {}) {
  const id = 'src' + uid();
  const range = opts.range || 'optional';
  const modes = (opts.modes || ['youtube', 'file', 'mic']).filter((m) => m !== 'youtube' || canCaptureTab() || opts.youtubeAlways);
  const [d0, d1] = opts.defaultRange || [30, 60];
  const st = { mode: modes[0], video: null, file: null, rec: null };
  const labels = { youtube: '<i class="bi bi-youtube"></i> Vídeo', file: '<i class="bi bi-file-earmark-music"></i> Arquivo', mic: '<i class="bi bi-mic"></i> Gravar' };

  el.innerHTML = `
    <div class="audio-source">
      ${modes.length > 1 ? `<div class="btn-group mb-3" role="group" aria-label="Fonte do áudio">${modes.map((m) => `
        <input type="radio" class="btn-check" name="${id}-mode" id="${id}-${m}" value="${m}"${m === st.mode ? ' checked' : ''}>
        <label class="btn btn-outline-primary btn-sm" for="${id}-${m}">${labels[m]}</label>`).join('')}</div>` : ''}
      <div data-pane="youtube"${st.mode === 'youtube' ? '' : ' hidden'}>
        <div class="input-group">
          <input type="text" class="form-control" data-f="url" placeholder="Cole o link do YouTube (ou uma mensagem com o link)" aria-label="Link do YouTube">
          <button class="btn btn-outline-secondary" type="button" data-a="load">Carregar</button>
        </div>
        <div class="form-text" data-f="title"></div>
      </div>
      <div data-pane="file"${st.mode === 'file' ? '' : ' hidden'}>
        <input class="form-control" type="file" accept="audio/*,video/*" data-f="file" aria-label="Arquivo de áudio">
        <div class="form-text">O arquivo é lido no seu aparelho; nada é enviado.</div>
      </div>
      <div data-pane="mic"${st.mode === 'mic' ? '' : ' hidden'}>
        <div class="row g-2 align-items-end">
          <div class="col-sm"><label class="form-label small mb-0" for="${id}-in">Entrada</label><select class="form-select form-select-sm" id="${id}-in" data-f="input"><option value="">Microfone padrão</option></select></div>
          <div class="col-sm-auto"><button class="btn btn-danger btn-sm" type="button" data-a="rec"><i class="bi bi-record-circle"></i> Gravar</button></div>
        </div>
        <div class="progress mt-2" style="height:6px" aria-label="Volume"><div class="progress-bar bg-success" data-f="lvl" style="width:0%"></div></div>
        <div class="form-text" data-f="rectime"></div>
      </div>
      ${range !== 'none' ? `<div class="row g-2 mt-2 range-row" data-range>
        <div class="col-6 col-sm-auto"><label class="form-label small mb-0" for="${id}-a">Começa em</label>
          <div class="input-group input-group-sm"><input class="form-control time-in" id="${id}-a" data-f="start" inputmode="numeric" value="${range === 'required' ? mmss(d0) : ''}" placeholder="início"><button class="btn btn-outline-secondary" type="button" data-now="start" title="Usar o ponto em que o vídeo está agora"><i class="bi bi-stopwatch"></i></button></div></div>
        <div class="col-6 col-sm-auto"><label class="form-label small mb-0" for="${id}-b">Termina em</label>
          <div class="input-group input-group-sm"><input class="form-control time-in" id="${id}-b" data-f="end" inputmode="numeric" value="${range === 'required' ? mmss(d1) : ''}" placeholder="fim"><button class="btn btn-outline-secondary" type="button" data-now="end" title="Usar o ponto em que o vídeo está agora"><i class="bi bi-stopwatch"></i></button></div></div>
        <div class="col-12 form-text mt-1">${esc(opts.hint || (range === 'optional' ? 'Deixe em branco para usar tudo.' : ''))}</div>
      </div>` : ''}
      <div class="mt-3" data-f="go-row"><button class="btn btn-primary" type="button" data-a="go">${esc(opts.action || 'Ouvir e analisar')}</button></div>
      ${!canCaptureTab() && (opts.modes || ['youtube']).includes('youtube') ? `<div class="form-text">Ouvir vídeos do YouTube só funciona no Chrome ou Edge do computador. Aqui, use um arquivo${modes.includes('mic') ? ' ou grave' : ''}.</div>` : ''}
      <div class="work mt-3" data-f="work" hidden aria-live="polite">
        <p class="mb-2 small" data-f="msg"></p>${progressHtml(id + '-bar')}
        <button class="btn btn-outline-secondary btn-sm mt-2" type="button" data-a="stop" hidden>Parar e usar o que já ouvi</button>
      </div>
    </div>`;
  const q = (s) => el.querySelector(s);
  const f = (n) => q(`[data-f="${n}"]`);
  const setMode = (m) => {
    st.mode = m;
    el.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== m; });
    const r = q('[data-range]');
    if (r) { r.hidden = m === 'mic'; r.querySelectorAll('[data-now]').forEach((b) => { b.hidden = m !== 'youtube'; }); }
    f('go-row').hidden = m === 'mic';
    if (m === 'mic') fillInputs();
  };
  setMode(st.mode);

  const work = (msg, frac = null, stoppable = false) => {
    f('work').hidden = false; f('msg').textContent = msg;
    if (frac != null) setProgress(q(`#${id}-bar`), frac);
    q('[data-a="stop"]').hidden = !stoppable;
  };
  const done = () => { f('work').hidden = true; busy(false); };
  function busy(on) { el.querySelectorAll('button, input, select').forEach((b) => { if (b.dataset.a !== 'stop' && b.dataset.a !== 'rec') b.disabled = on; }); }

  function rangeOf(duration = Infinity) {
    if (range === 'none') return [0, duration];
    let a = parseTime(f('start').value);
    let b = parseTime(f('end').value);
    if (range === 'required') { a ??= d0; if (b == null || b <= a) b = a + (d1 - d0); }
    a ??= 0;
    if (b == null || b <= a) b = duration;
    return [a, Math.min(b, duration)];
  }

  async function loadVideo(text, quiet = false) {
    const it = extractYouTube(text || '')[0];
    if (!it) { if (!quiet) toast('Não achei um link do YouTube aí.'); return null; }
    const t = startTimeOf(String(text).split(/\s+/).find((w) => w.includes(it.id)));
    if (t != null && range !== 'none') { f('start').value = mmss(t); if (!parseTime(f('end').value) || parseTime(f('end').value) <= t) f('end').value = mmss(t + (d1 - d0)); }
    st.video = { ytId: it.id, title: 'Vídeo do YouTube' };
    f('url').value = it.url;
    f('title').textContent = 'Carregando…';
    await P.play({ id: 'src-' + it.id, ytId: it.id, title: st.video.title }, { autoplay: false });
    const meta = await fetchMeta(it.id);
    if (meta && st.video?.ytId === it.id) {
      st.video.title = meta.title; st.video.author = meta.author;
      P.play({ id: 'src-' + it.id, ytId: it.id, title: meta.title, artist: meta.author }, { autoplay: false });
    }
    f('title').innerHTML = `<i class="bi bi-music-note-beamed"></i> ${esc(st.video.title)}`;
    opts.onVideo?.(st.video);
    return st.video;
  }

  async function fromVideo() {
    const typed = extractYouTube(f('url').value)[0];
    if (!st.video || (typed && typed.id !== st.video.ytId)) { const v = await loadVideo(f('url').value); if (!v) { f('url').focus(); return; } }
    let stream;
    try {
      await P.play({ id: 'src-' + st.video.ytId, ytId: st.video.ytId, title: st.video.title }, { autoplay: false });
      stream = await captureThisTab();
    } catch (err) { toast(captureError(err, 'o áudio da aba')); return; }
    const p = P.api();
    const dur = p.getDuration?.() || Infinity;
    const [a, b] = rangeOf(dur);
    if (Number.isFinite(dur) && a >= dur - 2) { stream.getTracks().forEach((t) => t.stop()); toast(`O vídeo tem ${mmss(dur)}. Escolha um trecho dentro dele.`); return; }
    busy(true);
    const rec = new Recorder();
    let finished = false, timer = 0;
    const finish = async (early) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      try { p.pauseVideo(); } catch { /* ok */ }
      rec.stop();
      P.setOnEnded(null);
      if (rec.seconds < 3) { done(); toast(early ? 'Ouvi muito pouco. Deixe tocar pelo menos uns 10 segundos.' : 'Não ouvi o vídeo. Confira se o áudio da guia foi compartilhado.'); return; }
      const r = rec.result();
      done();
      opts.onAudio?.({ ...r, label: st.video.title, kind: 'youtube', ytId: st.video.ytId, start: a, end: a + rec.seconds });
    };
    q('[data-a="stop"]').onclick = () => finish(true);
    await rec.start(stream, {
      shouldKeep: () => { try { const t = p.getCurrentTime(); return p.getPlayerState() === 1 && t >= a - 0.05 && t <= b + 0.05; } catch { return false; } },
    });
    stream.getAudioTracks()[0].addEventListener('ended', () => finish(true));
    P.setOnEnded(() => finish(false));
    p.seekTo(a, true);
    p.playVideo();
    const total = Number.isFinite(b) ? b - a : null;
    work(`Ouvindo ${mmss(a)}${total ? ' a ' + mmss(b) : ''}…`, 0, true);
    timer = setInterval(() => {
      let t = a;
      try { t = p.getCurrentTime(); } catch { /* ok */ }
      work(`Ouvindo… ${mmss(Math.max(0, t - a))}${total ? ' de ' + mmss(total) : ''}`, total ? (t - a) / total : null, true);
      if (Number.isFinite(b) && t >= b - 0.05) finish(false);
    }, 250);
  }

  async function fromFile(file) {
    if (!file) { toast('Escolha um arquivo de áudio.'); return; }
    busy(true);
    work('Lendo o arquivo…', 0);
    try {
      const [a, b] = rangeOf(Infinity);
      const audio = await decodeFile(file, a, b);
      done();
      opts.onAudio?.({ ...audio, label: file.name.replace(/\.[^.]+$/, ''), kind: 'file', file, start: a, end: a + audio.channels[0].length / audio.sampleRate });
    } catch (err) {
      done();
      toast(err.name === 'OutOfRange' ? err.message : 'Não consegui ler esse arquivo. Tente MP3, WAV ou M4A.');
    }
  }

  async function fillInputs() {
    try {
      const list = await listInputs();
      if (!list.some((d) => d.label)) return;
      const sel = f('input');
      const cur = sel.value;
      sel.innerHTML = '<option value="">Microfone padrão</option>' + list.map((d) => `<option value="${esc(d.deviceId)}"${d.deviceId === cur ? ' selected' : ''}>${esc(d.label || 'Entrada')}</option>`).join('');
    } catch { /* sem lista */ }
  }

  async function toggleRec() {
    const btn = q('[data-a="rec"]');
    if (st.rec) {
      const r = st.rec;
      st.rec = null;
      clearInterval(r.timer);
      r.rec.stop();
      btn.innerHTML = '<i class="bi bi-record-circle"></i> Gravar';
      f('lvl').style.width = '0%';
      if (r.rec.seconds < 2) { toast('Gravação curta demais.'); return; }
      opts.onAudio?.({ ...r.rec.result(), label: 'Gravação', kind: 'mic', start: 0, end: r.rec.seconds });
      return;
    }
    try {
      const stream = await getInput(f('input').value || null);
      fillInputs();
      const rec = new Recorder();
      await rec.start(stream, { onLevel: (l) => { f('lvl').style.width = Math.min(100, l * 400) + '%'; } });
      st.rec = { rec, timer: setInterval(() => { f('rectime').textContent = `Gravando… ${mmss(rec.seconds)}`; }, 300) };
      btn.innerHTML = '<i class="bi bi-stop-fill"></i> Parar';
    } catch (err) { toast(captureError(err, 'o microfone')); }
  }

  el.addEventListener('change', (e) => {
    if (e.target.name === `${id}-mode`) setMode(e.target.value);
    if (e.target.dataset.f === 'file') { st.file = e.target.files[0] || null; if (st.file && opts.autoFile) fromFile(st.file); }
  });
  f('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadVideo(f('url').value); });
  f('url').addEventListener('paste', () => setTimeout(() => loadVideo(f('url').value, true), 0));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.now) {
      if (!P.current()) { toast('Carregue o vídeo primeiro.'); return; }
      f(b.dataset.now).value = mmss(P.time());
    }
    if (b.dataset.a === 'load') loadVideo(f('url').value);
    if (b.dataset.a === 'rec') toggleRec();
    if (b.dataset.a === 'go') { if (st.mode === 'youtube') fromVideo(); else fromFile(st.file); }
  });
  return {
    setVideo: (url) => loadVideo(url, true),
    /** Mostra um vídeo já conhecido sem carregá-lo no player (não interrompe o que estiver tocando). */
    prefill(video) {
      if (!video?.ytId) return;
      st.video = { ytId: video.ytId, title: video.title || 'Vídeo do YouTube' };
      f('url').value = `https://www.youtube.com/watch?v=${video.ytId}`;
      f('title').innerHTML = `<i class="bi bi-music-note-beamed"></i> ${esc(st.video.title)}`;
    },
    setRange: (a, b) => { if (range !== 'none') { f('start').value = a == null ? '' : mmss(a); f('end').value = b == null ? '' : mmss(b); } },
    info: () => ({ mode: st.mode, video: st.video, file: st.file, range: rangeOf(Infinity) }),
    busy,
  };
}
