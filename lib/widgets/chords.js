// Gerador de rascunho de cifra (acordes + letra) a partir do áudio: vídeo do YouTube (ouvindo a aba),
// arquivo ou microfone. Usado no editor do Cifras e na ferramenta Acordes.
import * as LY from '../music/lyrics.js';
import * as M from '../music/theory.js';
import { MODELS } from '../ai/whisper.js';
import { analyzeSamples, framesToChords, segmentsToChordPro, classify, chordName, sumChroma, LiveChords } from '../audio/harmony.js';
import { canCaptureTab, captureThisTab, captureError, decodeFile, mono, getInput, encodeWav } from '../audio/io.js';
import * as P from '../youtube/player.js';
import { renderSheet } from '../music/sheet.js';
import { esc, mmss, modal, panel, toast, progressHtml, setProgress, uid } from '../core/ui.js';

/** Notas para tocar um acorde: baixo grave e a harmonia perto do dó central. */
export function chordNotes(name) {
  const c = M.chordTones(name);
  if (!c) return [];
  const near = (p, center) => { let n = center - M.mod12(center - p); if (center - n > 6) n += 12; return n; };
  const top = c.intervals.map((i) => near(M.mod12(c.root + i), 62));
  return [near(c.bass, 40), ...new Set(top)];
}

const W_MODELS = MODELS.map((m) => m.label);
const LANGS = [['portuguese', 'Português'], ['english', 'Inglês'], ['spanish', 'Espanhol']];
const SEP_TEXT = 'Separar as faixas com IA para acordes mais precisos (sem voz e bateria, com o baixo ajudando). A letra continua vindo do banco quando existir. Mais lento: cerca de 85 MB na primeira vez e alguns minutos por música.';

/**
 * ctx: { mode: 'tab'|'file'|'mic', song: { title, artist, ytId }, bpm, hasContent,
 *        onApply({ text, key, bpm, append }), applyLabel }
 */
export function openChordGenerator(ctx) {
  const id = 'cg' + uid();
  const song = ctx.song || { title: '', artist: '' };
  const titles = { file: 'Gerar cifra pelo arquivo de áudio', tab: 'Gerar cifra pelo vídeo', mic: 'Gerar cifra pelo microfone' };
  let live = null, tabRun = null, follow = 0, audioUrl = null;
  let result = null; // { key, segments, separated }
  let audio = null; // { samples, sampleRate, toMusicTime, rate, vocals } para a letra
  let rec = null; // áudio original (estéreo) para separar depois
  let duration = 0;
  let bpm = ctx.bpm || 80;
  const lyr = { status: 'idle', lines: [], plain: '', source: '', info: '', offset: 0, include: true, msg: '', title: song.title || '', artist: song.artist || '', model: 0, lang: 'portuguese' };

  // piano sintetizado tocando os acordes encontrados junto com a música, para conferir de ouvido
  const echo = { synth: null, on: false, last: null, raf: 0 };
  async function echoStart() {
    const [{ Synth }, { PRESETS }, { audioCtx, resumeAudio }] = await Promise.all([import('../synth/synth.js'), import('../synth/presets.js'), import('../audio/context.js')]);
    const ac = audioCtx(); await resumeAudio();
    if (!echo.synth) {
      echo.synth = await Synth.create(ac, { engine: 'fm', params: { ...(PRESETS.fm.find((p) => p.name === 'Piano elétrico (DX)')?.params || {}), vol: -10 }, fx: { reverbMix: 0.15 } });
      echo.synth.connect(ac.destination);
    }
    echo.on = true; echo.last = null;
  }
  function echoPlay(chord) {
    if (!echo.on || !echo.synth || chord === echo.last) return;
    echo.last = chord;
    echo.synth.allOff();
    for (const n of chordNotes(chord)) echo.synth.noteOn(n, n < 50 ? 85 : 70);
  }
  const echoStop = () => { echo.last = null; echo.synth?.allOff(); };

  const cleanup = () => {
    echo.on = false; cancelAnimationFrame(echo.raf); echo.synth?.destroy(); echo.synth = null;
    live?.stop(); live = null; clearInterval(follow);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    tabRun?.finish(true);
  };
  // No modo vídeo a janela não pode cobrir o player do YouTube: abre ao lado, sem fundo escuro.
  const box = ctx.mode === 'tab' ? panel({ title: titles.tab, onClose: cleanup }) : modal({ title: titles[ctx.mode], size: 'lg', onClose: cleanup });
  const root = box.body;

  const intro = ctx.mode === 'file'
    ? `<p>Escolha um arquivo de áudio (MP3, M4A, WAV…) de <strong>${esc(song.title || 'a música')}</strong>. A análise acontece no seu aparelho; o arquivo não é enviado para lugar nenhum.</p>
       <div class="form-check mb-3"><input class="form-check-input" type="checkbox" id="${id}-sep"><label class="form-check-label" for="${id}-sep">${SEP_TEXT}</label></div>
       <input class="form-control" type="file" accept="audio/*,video/mp4" data-x="file" aria-label="Arquivo de áudio">`
    : ctx.mode === 'tab'
      ? `<p>O vídeo de <strong>${esc(song.title || 'a música')}</strong> toca no player do site e a página escuta o áudio desta aba. Nada é baixado.</p>
         <p class="small text-body-secondary" data-r="prelyr">Procurando a letra no LRCLIB…</p>
         <div class="form-check mb-2"><input class="form-check-input" type="checkbox" id="${id}-slow"><label class="form-check-label" for="${id}-slow">Analisar em velocidade normal, para transcrever a letra com IA (leva o tempo da música)</label></div>
         <div class="form-check mb-2"><input class="form-check-input" type="checkbox" id="${id}-sep"><label class="form-check-label" for="${id}-sep">${SEP_TEXT}</label></div>
         <p class="small text-body-secondary">O navegador vai pedir para compartilhar esta aba: deixe marcada a opção de <strong>compartilhar o áudio da guia</strong>. O som fica mudo enquanto analisa.</p>
         <button class="btn btn-primary" type="button" data-x="tab-start"><i class="bi bi-play-fill"></i> Analisar o vídeo</button>`
      : `<p>Deixe a música tocar perto do microfone, ou toque você mesmo. Os acordes vão sendo anotados enquanto você ouve; pare quando a música acabar.</p>
         <button class="btn btn-primary" type="button" data-x="mic-start"><i class="bi bi-mic-fill"></i> Começar a ouvir</button>`;

  root.innerHTML = `
    <div data-r="start">${intro}</div>
    <div data-r="work" hidden>
      <p class="small text-body-secondary" data-r="msg"></p>${progressHtml(id + '-bar')}
      <div data-r="live" hidden class="mt-3"><div class="display-5 fw-bold text-primary" data-r="now">—</div><p class="small text-body-secondary">Tempo: <span data-r="time">0:00</span></p>
        <button class="btn btn-primary" type="button" data-x="${ctx.mode === 'tab' ? 'tab-stop' : 'mic-stop'}">Parar e gerar a cifra</button></div>
    </div>
    <div data-r="result" hidden></div>
    <p class="small text-body-secondary mt-3 mb-0">O resultado é um rascunho: os acordes vêm do áudio e a letra vem do banco de letras LRCLIB ou, se ela não estiver lá, da transcrição por IA. Confira e corrija.</p>`;
  const r = (k) => root.querySelector(`[data-r="${k}"]`);
  const show = (k) => ['start', 'work', 'result'].forEach((x) => { r(x).hidden = x !== k; });
  const bar = () => root.querySelector(`#${id}-bar`);

  // ---------- letra ----------
  async function searchLyrics() {
    lyr.status = 'searching'; renderLyrics();
    try {
      const found = await LY.findLyrics({ title: lyr.title, artist: lyr.artist, duration });
      if (found && (found.lines.length || found.plain)) {
        Object.assign(lyr, { status: 'found', lines: found.lines, plain: found.plain, source: 'do LRCLIB', include: true, offset: 0, info: `“${found.track}” — ${found.artist}${found.lines.length ? '' : ' (sem tempo)'}` });
        // vídeo com introdução diferente da gravação do banco: sugere um ajuste inicial
        if (found.lines.length && duration && found.duration && Math.abs(duration - found.duration) > 3) lyr.offset = Math.round((duration - found.duration) * 2) / 2;
      } else Object.assign(lyr, { status: 'notfound', lines: [], plain: '' });
    } catch (err) {
      Object.assign(lyr, { status: 'error', lines: [], plain: '', msg: err.message });
    }
    renderLyrics(); renderPreview(); updatePreLyrics();
  }

  async function runWhisper() {
    if (!audio) return;
    lyr.status = 'transcribing'; lyr.msg = 'Preparando o áudio…'; renderLyrics();
    try {
      const W = await import('../ai/whisper.js');
      const a16 = await W.to16k(audio.samples, audio.sampleRate);
      const chunks = await W.transcribe(a16, {
        model: W.MODELS[lyr.model].id, language: lyr.lang,
        onStatus: (m) => { lyr.msg = m; const el = r('lymsg'); if (el) el.textContent = m; },
      });
      const lines = LY.whisperToLines(chunks).map((l) => ({ ...l, t: audio.toMusicTime(l.t), end: audio.toMusicTime(l.end) }));
      if (!lines.length) throw new Error('vazio');
      const aligned = lyr.plain && lyr.source === 'do LRCLIB' ? LY.alignPlainToTimed(lyr.plain, lines) : [];
      if (aligned.length) Object.assign(lyr, { status: 'found', lines: aligned, include: true, offset: 0, info: lyr.info.replace(' (sem tempo)', '') + ' — tempo das linhas encontrado pela IA' });
      else Object.assign(lyr, { status: 'found', lines, plain: '', source: 'transcrita por IA', include: true, offset: 0, info: 'Transcrita por IA — confira as palavras.' });
    } catch (err) {
      lyr.status = 'whisper-error';
      lyr.msg = err.message === 'vazio' ? 'A IA não reconheceu nenhuma letra.' : 'Não foi possível transcrever: ' + err.message;
    }
    renderLyrics(); renderPreview();
  }

  function whisperControls() {
    if (!audio || audio.rate > 1) return ctx.mode === 'tab' ? '<p class="small text-body-secondary">Para transcrever a letra com IA, analise de novo marcando “velocidade normal”.</p>' : '';
    return `<div class="row g-2 mt-1">
      <div class="col-auto"><select class="form-select form-select-sm" data-x="ly-model" aria-label="Modelo de IA">${W_MODELS.map((m, i) => `<option value="${i}"${i === lyr.model ? ' selected' : ''}>${m}</option>`).join('')}</select></div>
      <div class="col-auto"><select class="form-select form-select-sm" data-x="ly-lang" aria-label="Idioma">${LANGS.map(([v, l]) => `<option value="${v}"${v === lyr.lang ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="col-auto"><button class="btn btn-outline-primary btn-sm" type="button" data-x="whisper"${lyr.status === 'transcribing' ? ' disabled' : ''}>${lyr.plain && !lyr.lines.length ? 'Encaixar a letra com IA' : 'Transcrever a letra com IA'}</button></div></div>
      <p class="small text-body-secondary mt-1">A IA roda no seu aparelho${audio.vocals ? ' e vai ouvir só a faixa da voz' : '. Voz com muitos instrumentos atrás gera erros; separar as faixas antes ajuda'}. No celular pode demorar bastante.</p>`;
  }

  function renderLyrics() {
    const el = r('lyrics');
    if (!el) return;
    let h = '<h3 class="h6">Letra</h3>';
    if (lyr.status === 'searching' || lyr.status === 'idle') h += '<p class="small text-body-secondary">Procurando a letra no LRCLIB…</p>';
    else if (lyr.status === 'transcribing') h += `<p data-r="lymsg">${esc(lyr.msg)}</p><div class="progress" style="height:6px"><div class="progress-bar progress-bar-striped progress-bar-animated" style="width:100%"></div></div>`;
    else if (lyr.status === 'found') {
      h += `<p class="mb-1">${lyr.source === 'do LRCLIB' ? 'Encontrada no LRCLIB: ' : ''}${esc(lyr.info)}</p>
        <div class="form-check"><input class="form-check-input" type="checkbox" id="${id}-inc" data-x="ly-inc"${lyr.include ? ' checked' : ''}><label class="form-check-label" for="${id}-inc">Incluir a letra na cifra</label></div>`;
      if (lyr.lines.length && lyr.include) {
        h += `<div class="d-flex flex-wrap align-items-center gap-2 mt-2"><span>Sincronia</span>
          <div class="btn-group btn-group-sm"><button class="btn btn-outline-secondary" type="button" data-x="ly-minus" aria-label="Letra meio segundo antes">−</button>
          <span class="btn btn-outline-secondary disabled font-monospace">${lyr.offset > 0 ? '+' : ''}${lyr.offset.toFixed(1).replace('.', ',')} s</span>
          <button class="btn btn-outline-secondary" type="button" data-x="ly-plus" aria-label="Letra meio segundo depois">+</button></div>
          <span class="small text-body-secondary">Se os acordes caírem cedo ou tarde demais nas palavras, ajuste aqui.</span></div>`;
      } else if (!lyr.lines.length && lyr.plain) h += `<p class="small text-body-secondary mt-2">Essa letra não tem tempo marcado: ela vai abaixo dos acordes. A IA pode ouvir a música e encaixar cada linha no tempo certo, mantendo o texto correto.</p>${whisperControls()}`;
      if (lyr.source === 'do LRCLIB') h += `<details class="mt-2"><summary class="small">Não é essa a letra?</summary>${whisperControls()}</details>`;
    } else {
      const why = lyr.status === 'error' && /503/.test(lyr.msg) ? 'A consulta direta pelo nome não achou a letra, e a busca geral do LRCLIB está sobrecarregada agora. Tente “Buscar com outro nome” (o nome exato da música e do artista), mais tarde ou use a IA.'
        : lyr.status === 'error' ? `Não consegui consultar o LRCLIB: ${lyr.msg}.`
          : lyr.status === 'whisper-error' ? lyr.msg : 'A letra não está no LRCLIB.';
      h += `<p>${esc(why)}</p>${whisperControls()}`;
    }
    h += `<details class="mt-2"><summary class="small">Buscar com outro nome</summary>
      <div class="row g-2 mt-1"><div class="col-sm"><input class="form-control form-control-sm" type="text" data-r="lytitle" placeholder="Música" value="${esc(lyr.title)}" aria-label="Música"></div>
      <div class="col-sm"><input class="form-control form-control-sm" type="text" data-r="lyartist" placeholder="Artista" value="${esc(lyr.artist)}" aria-label="Artista"></div>
      <div class="col-sm-auto"><button class="btn btn-outline-secondary btn-sm" type="button" data-x="ly-search">Buscar letra</button></div></div></details>`;
    el.innerHTML = h;
  }

  function updatePreLyrics() {
    const el = r('prelyr');
    if (!el) return;
    const slow = root.querySelector(`#${id}-slow`);
    if (lyr.status === 'found') { el.textContent = `Letra encontrada no LRCLIB: ${lyr.info}. A análise pode ser em 2x.`; if (slow) slow.checked = false; }
    else if (lyr.status === 'searching') el.textContent = 'Procurando a letra no LRCLIB…';
    else { el.textContent = lyr.status === 'error' ? `Não consegui consultar o LRCLIB (${lyr.msg}). Marque a opção abaixo para transcrever a letra com IA.` : 'A letra não está no LRCLIB. Para transcrevê-la com IA, a análise precisa ser em velocidade normal.'; if (slow) slow.checked = true; }
  }

  // ---------- resultado ----------
  function buildText() {
    const base = segmentsToChordPro(result.segments, bpm);
    if (lyr.status === 'found' && lyr.include) {
      if (lyr.lines.length) return LY.alignLyrics(lyr.lines, result.segments, { offset: lyr.offset, source: lyr.source }) || base;
      if (lyr.plain) return LY.appendPlainLyrics(base, lyr.plain);
    }
    return base;
  }
  function renderPreview() { const el = r('preview'); if (el && result) el.innerHTML = renderSheet(buildText()); }

  function drawResult() {
    show('result');
    const out = r('result');
    if (!segmentsToChordPro(result.segments, bpm)) { out.innerHTML = '<p>Não consegui reconhecer acordes. Tente um trecho com o som mais alto ou mais limpo.</p>'; return; }
    const distinct = [...new Set(result.segments.filter((s) => s.chord !== 'N').map((s) => s.chord))];
    out.innerHTML = `
      <div class="row g-3 align-items-end">
        <div class="col-auto"><div class="small text-body-secondary">Tom provável</div><div class="display-6 fw-bold text-primary">${esc(result.key)}</div></div>
        <div class="col-auto"><label class="form-label small mb-0" for="${id}-bpm">Andamento (BPM)</label><input class="form-control form-control-sm" style="width:6rem" type="number" id="${id}-bpm" data-x="bpm" min="30" max="260" value="${bpm}"></div>
        <div class="col small text-body-secondary">Acordes encontrados: ${distinct.map(esc).join(', ')}.${result.separated ? ' Analisados nas faixas separadas (baixo e harmonia, sem voz e bateria).' : ''}</div>
      </div>
      ${audioUrl ? `<audio controls src="${audioUrl}" class="w-100 my-3" data-r="audio"></audio>` : ''}
      ${audioUrl || ctx.mode === 'tab' ? `<p class="mt-2 mb-1">Acorde agora: <strong class="text-primary fs-4" data-r="follow">—</strong>${ctx.mode === 'tab' ? '<span class="small text-body-secondary"> — dê play no vídeo do player para conferir de ouvido.</span>' : ''}</p>
        <div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" role="switch" id="${id}-echo" data-x="echo"${echo.on ? ' checked' : ''}><label class="form-check-label" for="${id}-echo">Tocar os acordes encontrados num piano junto com a música (se algum soar errado, é ali que a cifra precisa de ajuste)</label></div>` : ''}
      <section class="border rounded p-3 my-3" data-r="lyrics"></section>
      <div class="sheet small-sheet" data-r="preview"></div>
      <div class="d-flex flex-wrap gap-2 mt-3">
        ${!result.separated && rec ? '<button class="btn btn-outline-primary" type="button" data-x="resep">Melhorar os acordes separando as faixas</button>' : ''}
        <button class="btn btn-primary" type="button" data-x="apply">${esc(ctx.applyLabel || (ctx.hasContent ? 'Substituir a cifra atual' : 'Usar esta cifra'))}</button>
        ${ctx.hasContent ? '<button class="btn btn-outline-primary" type="button" data-x="append">Adicionar ao fim da cifra</button>' : ''}
      </div>`;
    renderLyrics(); renderPreview();
    if (lyr.status === 'idle') searchLyrics();
    const segAt = (t) => result.segments.find((x) => t >= x.start && t < x.end);
    const showAt = (t, playing = true) => {
      const s = segAt(t), chord = s && s.chord !== 'N' ? s.chord : null;
      const el = r('follow'); if (el) el.textContent = chord || '—';
      if (playing) echoPlay(chord); else echoStop();
    };
    clearInterval(follow);
    if (ctx.mode === 'tab') follow = setInterval(() => { if (!P.current()) return; let on = false; try { on = P.api().getPlayerState() === 1; } catch { /* ok */ } showAt(P.time() + 0.08, on); }, 100);
    const au = r('audio');
    if (au) {
      const loop = () => { showAt(au.currentTime + 0.05, true); if (!au.paused) echo.raf = requestAnimationFrame(loop); };
      au.onplay = () => { cancelAnimationFrame(echo.raf); loop(); };
      au.onpause = au.onended = () => { cancelAnimationFrame(echo.raf); echoStop(); };
      au.onseeked = () => { echo.last = null; showAt(au.currentTime, !au.paused); };
      au.ontimeupdate = () => { if (au.paused) showAt(au.currentTime, false); };
    }
  }

  /** Separa as faixas, refaz os acordes com baixo + harmonia e deixa a voz para a IA da letra. */
  async function analyzeSeparated(source, fallback = () => {}) {
    show('work');
    r('live').hidden = true;
    try {
      const S = await import('../ai/separate.js');
      const stems = await S.separate(source.channels, source.sampleRate, (text, p) => { r('msg').textContent = text; setProgress(bar(), p); });
      r('msg').textContent = 'Encontrando os acordes nas faixas separadas…';
      const { frames, hop } = await analyzeSamples(stems.other, 44100, (p) => setProgress(bar(), p), stems.bass);
      const res = framesToChords(frames, { hop });
      res.segments = res.segments.map((x) => ({ ...x, start: source.toMusicTime(x.start), end: source.toMusicTime(x.end) }));
      res.separated = true;
      result = res;
      audio = { samples: stems.vocals, sampleRate: 44100, toMusicTime: source.toMusicTime, vocals: true, rate: source.rate || 1 };
      if (lyr.status !== 'found') lyr.model = 1;
    } catch (err) {
      toast('Não foi possível separar as faixas (' + err.message + '). Usei a análise normal.', 'warning');
      fallback();
    }
    if (result) drawResult(); else show('start');
  }

  async function fromFile(file) {
    show('work');
    r('msg').textContent = 'Lendo o arquivo…';
    try {
      const buf = await decodeFile(file);
      duration = buf.duration;
      audioUrl = URL.createObjectURL(file);
      rec = { channels: buf.channels, sampleRate: buf.sampleRate, toMusicTime: (w) => w, rate: 1 };
      const m = mono(buf.channels);
      const quick = async () => {
        r('msg').textContent = `Analisando ${mmss(buf.duration)} de áudio…`;
        const { frames, hop } = await analyzeSamples(m, buf.sampleRate, (p) => setProgress(bar(), p));
        result = framesToChords(frames, { hop });
        audio = { samples: m, sampleRate: buf.sampleRate, toMusicTime: (w) => w, rate: 1 };
      };
      if (root.querySelector(`#${id}-sep`)?.checked) { await analyzeSeparated(rec, () => {}); if (result) return; }
      await quick();
      drawResult();
    } catch {
      show('start');
      toast('Não consegui ler esse arquivo. Tente outro formato, como MP3 ou WAV.');
    }
  }

  const onLiveFrame = (fr, frames) => {
    r('time').textContent = mmss(fr.t) + (duration ? ' de ' + mmss(duration) : '');
    if (duration) setProgress(bar(), fr.t / duration);
    else setProgress(bar(), Math.min(1, fr.energy * 8));
    if (fr.energy < 0.005) { if (ctx.mode === 'mic') r('now').textContent = '—'; return; }
    r('now').textContent = chordName(classify(sumChroma(frames.slice(-5))).label);
  };

  async function startTab() {
    if (!canCaptureTab()) { toast('Ouvir o áudio da aba só funciona no Chrome ou Edge do computador.'); return; }
    const sep = root.querySelector(`#${id}-sep`)?.checked;
    const slow = root.querySelector(`#${id}-slow`)?.checked;
    let stream;
    try {
      await P.play(song, { autoplay: false });
      stream = await captureThisTab({ silent: true });
    } catch (err) { toast(captureError(err, 'o áudio da aba')); return; }
    const p = P.api();
    const rates = p.getAvailablePlaybackRates?.() || [1];
    const rate = slow ? 1 : rates.includes(2) ? 2 : Math.max(...rates);
    show('work');
    r('live').hidden = false;
    r('msg').textContent = rate > 1 ? `Analisando o vídeo em ${rate}x… pode deixar esta janela aberta.` : 'Analisando o vídeo em velocidade normal… pode deixar esta janela aberta.';
    duration = p.getDuration?.() || 0;
    const l = new LiveChords();
    live = l;
    let done = false;
    tabRun = {
      finish: (aborted) => {
        if (done) return;
        done = true;
        P.setOnEnded(null);
        try { p.pauseVideo(); p.setPlaybackRate(1); } catch { /* ok */ }
        const frames = l.stop();
        live = null; tabRun = null;
        if (aborted || !root.isConnected) return;
        if (frames.length < 20) { show('start'); toast('Ouvi muito pouco do vídeo. Confira se o áudio da guia foi compartilhado.'); return; }
        rec = l.recording();
        if (rec) { rec.rate = rate; audio = { ...rec, samples: mono(rec.channels), rate }; }
        const quick = () => { result = framesToChords(frames, { hop: l.hop }); };
        if (sep && rec) { analyzeSeparated(rec, quick); return; }
        quick();
        drawResult();
      },
    };
    stream.getAudioTracks()[0].addEventListener('ended', () => tabRun?.finish(false));
    P.setOnEnded(() => tabRun?.finish(false));
    await l.start(stream, onLiveFrame, { getTime: () => P.time(), shouldKeep: () => { try { return p.getPlayerState() === 1; } catch { return false; } }, record: true, rate });
    p.seekTo(0, true);
    p.setPlaybackRate(rate);
    p.playVideo();
  }

  async function startMic() {
    show('work');
    r('msg').textContent = 'Ouvindo… o acorde mostrado é o que está soando agora.';
    r('live').hidden = false;
    try {
      const stream = await getInput();
      live = new LiveChords();
      await live.start(stream, onLiveFrame, { record: true });
    } catch (err) {
      live = null; show('start');
      toast(captureError(err, 'o microfone'));
    }
  }
  function stopMic() {
    const l = live;
    const frames = l.stop();
    live = null;
    if (frames.length < 20) { show('start'); toast('Ouvi muito pouco. Deixe tocar por mais tempo.'); return; }
    rec = l.recording();
    if (rec) {
      rec.rate = 1; audio = { ...rec, samples: mono(rec.channels), rate: 1 };
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(encodeWav(rec.channels, rec.sampleRate)); // para ouvir de novo e conferir
    }
    result = framesToChords(frames, { hop: l.hop });
    drawResult();
  }

  root.addEventListener('change', (e) => {
    const x = e.target.dataset.x;
    if (x === 'bpm') { bpm = Math.min(260, Math.max(30, Number(e.target.value) || 80)); renderPreview(); }
    if (x === 'ly-inc') { lyr.include = e.target.checked; renderLyrics(); renderPreview(); }
    if (x === 'ly-model') lyr.model = Number(e.target.value);
    if (x === 'ly-lang') lyr.lang = e.target.value;
    if (x === 'file' && e.target.files[0]) fromFile(e.target.files[0]);
    if (x === 'echo') {
      if (e.target.checked) echoStart().catch((err) => { e.target.checked = false; toast('Não consegui ligar o piano: ' + err.message); });
      else { echo.on = false; echoStop(); }
    }
  });
  root.addEventListener('click', (e) => {
    const x = e.target.closest('button[data-x]')?.dataset.x;
    if (!x) return;
    if (x === 'ly-minus' || x === 'ly-plus') { lyr.offset = Math.round((lyr.offset + (x === 'ly-plus' ? 0.5 : -0.5)) * 2) / 2; renderLyrics(); renderPreview(); }
    if (x === 'ly-search') { lyr.title = r('lytitle').value.trim(); lyr.artist = r('lyartist').value.trim(); searchLyrics(); }
    if (x === 'whisper') runWhisper();
    if (x === 'resep' && rec) analyzeSeparated(rec);
    if (x === 'mic-start') startMic();
    if (x === 'mic-stop' && live) stopMic();
    if (x === 'tab-start') startTab();
    if (x === 'tab-stop' && tabRun) tabRun.finish(false);
    if (x === 'apply' || x === 'append') { ctx.onApply({ text: buildText(), key: result.key, bpm, append: x === 'append' }); box.close(); }
  });
  if (ctx.mode === 'tab') searchLyrics().then(updatePreLyrics);
  return box;
}
