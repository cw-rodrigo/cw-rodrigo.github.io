// Descobrir o tom pelo microfone (ou outra entrada). Usado na ferramenta Tom e no Cifras.
import * as M from '../music/theory.js';
import { LiveChords } from '../audio/harmony.js';
import { getInput, captureError } from '../audio/io.js';
import { esc, modal, toast, progressHtml, setProgress, uid } from '../core/ui.js';

/** Relativo maior/menor de um tom ("Am" -> "C"). */
export function relativeOf(key) {
  const k = M.parseKey(key);
  return k.minor ? M.keyName(k.root + 3, false) : M.keyName(k.root + 9, true);
}

/**
 * Ouve por `seconds` segundos e estima o tom. Retorna [{ key, score }] ou null (pouco som).
 * onLevel(0..1), onUpdate(palpite|null, progresso 0..1)
 */
export async function listenForKey({ seconds = 10, deviceId = null, onLevel = () => {}, onUpdate = () => {}, signal }) {
  const stream = await getInput(deviceId);
  const live = new LiveChords();
  const chroma = new Array(12).fill(0);
  let frames = 0, elapsed = 0;
  try {
    await new Promise((resolve) => {
      live.start(stream, (fr) => {
        elapsed = live.rec.seconds;
        onLevel(Math.min(1, fr.energy * 8));
        if (fr.energy > 0.008) { fr.chroma.forEach((v, i) => { chroma[i] += v; }); frames++; }
        onUpdate(frames > 5 ? M.estimateKey(chroma) : null, Math.min(1, elapsed / seconds));
        if (elapsed >= seconds || signal?.aborted) resolve();
      }, { record: false });
      signal?.addEventListener('abort', resolve, { once: true });
    });
  } finally { live.stop(); }
  return frames > 5 ? M.estimateKey(chroma) : null;
}

/**
 * Interface completa em `el`.
 * opts: { intro, seconds, extra(result, best) -> HTML extra embaixo do resultado,
 *         onAction(nome, tom, elementoClicado) para botões [data-key-act] do extra }
 */
export function keyDetector(el, opts = {}) {
  const id = 'kd' + uid();
  let ctrl = null;
  el.innerHTML = `
    <div class="key-detector">
      <p>${opts.intro || 'Toque ou cante perto do microfone por uns 10 segundos.'}</p>
      <div data-k="start"><button class="btn btn-primary" type="button" data-k-btn="start"><i class="bi bi-mic-fill"></i> Começar a ouvir</button></div>
      <div data-k="live" hidden>
        <label class="form-label small mb-1">Volume</label>
        <div class="progress mb-2" style="height:6px"><div class="progress-bar bg-success" id="${id}-lvl" style="width:0%"></div></div>
        <label class="form-label small mb-1">Progresso</label>${progressHtml(id + '-prog')}
        <p class="mt-2 mb-2">Palpite agora: <strong data-k="guess">—</strong></p>
        <button class="btn btn-outline-secondary btn-sm" type="button" data-k-btn="stop">Parar</button>
      </div>
      <div data-k="result" hidden></div>
    </div>`;
  const q = (k) => el.querySelector(`[data-k="${k}"]`);
  const show = (k) => ['start', 'live', 'result'].forEach((x) => { q(x).hidden = x !== k; });

  function result(res) {
    const out = q('result');
    show('result');
    if (!res) {
      out.innerHTML = '<p>Não ouvi som suficiente. Aproxime o instrumento do microfone e tente de novo.</p><button class="btn btn-primary" type="button" data-k-btn="start">Ouvir de novo</button>';
      return;
    }
    const best = res[0].key;
    out.innerHTML = `<div class="display-5 fw-bold text-primary">${esc(best)}</div>
      <p class="text-body-secondary">Também pode ser ${esc(res.slice(1, 3).map((r) => r.key).join(' ou '))}. Relativo: ${esc(relativeOf(best))}.</p>
      ${opts.extra ? opts.extra(res, best) : ''}
      <button class="btn btn-outline-primary btn-sm mt-3" type="button" data-k-btn="start"><i class="bi bi-arrow-repeat"></i> Ouvir de novo</button>`;
  }

  async function start() {
    show('live');
    ctrl = new AbortController();
    try {
      const res = await listenForKey({
        seconds: opts.seconds || 10, signal: ctrl.signal,
        onLevel: (v) => { const b = el.querySelector(`#${id}-lvl`); if (b) b.style.width = v * 100 + '%'; },
        onUpdate: (r, p) => { setProgress(el.querySelector(`#${id}-prog`), p); if (r) q('guess').textContent = r[0].key; },
      });
      if (el.isConnected) result(res);
    } catch (err) {
      show('start');
      toast(captureError(err, 'o microfone'));
    }
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-k-btn], [data-key-act]');
    if (!b) return;
    if (b.dataset.kBtn === 'start') start();
    if (b.dataset.kBtn === 'stop') ctrl?.abort();
    if (b.dataset.keyAct) opts.onAction?.(b.dataset.keyAct, b.dataset.key, b);
  });
  return { stop: () => ctrl?.abort() };
}

/** O mesmo numa janela. Retorna a janela. */
export function openKeyDetector(opts = {}) {
  let kd = null;
  const m = modal({ title: opts.title || 'Descobrir o tom', onClose: () => kd?.stop() });
  kd = keyDetector(m.body, { ...opts, onAction: (a, k, b) => opts.onAction?.(a, k, b, m) });
  return m;
}
