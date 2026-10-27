// Ferramenta: descobrir o tom pelo microfone ou analisando um áudio/vídeo.
import { keyDetector, relativeOf } from '/lib/widgets/key.js';
import { audioSource } from '/lib/widgets/source.js';
import { keyOfSamples } from '/lib/audio/harmony.js';
import { mono } from '/lib/audio/io.js';
import { $, esc, mmss, progressHtml, setProgress } from '/lib/core/ui.js';

let last = null; // último resultado de áudio
let kd = null;

const keyHtml = (res, label) => `<p class="small text-body-secondary mb-1">${esc(label)}</p>
  <div class="display-5 fw-bold text-primary">${esc(res[0].key)}</div>
  <p class="text-body-secondary mb-0">Também pode ser ${esc(res.slice(1, 3).map((r) => r.key).join(' ou '))}. Relativo: ${esc(relativeOf(res[0].key))}.</p>`;

export default {
  title: 'Descobrir o tom',
  render(el) {
    el.innerHTML = `<h1 class="h2">Descobrir o tom</h1>
      <p class="text-body-secondary">Pelo microfone (toque ou cante) ou analisando um vídeo do YouTube ou arquivo.</p>
      <div class="row g-4">
        <div class="col-lg-6"><section class="card h-100"><div class="card-body"><h2 class="h5"><i class="bi bi-mic"></i> Pelo microfone</h2><div id="kd"></div></div></section></div>
        <div class="col-lg-6"><section class="card h-100"><div class="card-body"><h2 class="h5"><i class="bi bi-file-earmark-music"></i> De um áudio ou vídeo</h2>
          <div id="src"></div>
          <div id="an" class="mt-3" hidden><p class="small mb-2" id="an-msg">Analisando…</p>${progressHtml('an-bar')}</div>
          <div id="out" class="mt-3"></div></div></section></div>
      </div>`;
    kd = keyDetector($('#kd'));
    audioSource($('#src'), {
      range: 'optional', modes: ['youtube', 'file', 'mic'], action: 'Descobrir o tom',
      onAudio: async (a) => {
        $('#an').hidden = false; $('#out').innerHTML = '';
        const res = await keyOfSamples(mono(a.channels), a.sampleRate, (p) => setProgress($('#an-bar'), p));
        last = res ? { res, label: `${a.label}${a.end ? ` (${mmss(a.start || 0)}–${mmss(a.end)})` : ''}` } : null;
        if (!el.isConnected) return;
        $('#an').hidden = true;
        $('#out').innerHTML = last ? keyHtml(last.res, last.label) : '<p>Não encontrei notas suficientes nesse áudio.</p>';
      },
    });
    if (last) $('#out').innerHTML = keyHtml(last.res, last.label);
    return () => kd?.stop();
  },
};
