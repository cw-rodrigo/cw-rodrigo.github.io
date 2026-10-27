// Ferramenta: separar faixas (voz, bateria, baixo, harmonia) com IA e ouvir/baixar.
import { audioSource } from '/lib/widgets/source.js';
import { stemMixer } from '/lib/widgets/stems.js';
import { $, esc, mmss, toast, progressHtml, setProgress } from '/lib/core/ui.js';

const st = { stems: null, label: '', running: false, msg: '', frac: 0 };
let mixer = null;

export default {
  title: 'Separar faixas',
  render(el) {
    el.innerHTML = `<h1 class="h2">Separar faixas</h1>
      <p class="text-body-secondary">Separa voz, bateria, baixo e o resto da harmonia com IA (HTDemucs), no seu aparelho. Na primeira vez baixa um modelo de 84 MB; depois ele fica guardado. Leva cerca de 1 minuto e meio de processamento para cada minuto de música num computador comum.</p>
      <section class="card mb-4"><div class="card-body"><div id="src"></div>
        <div id="work" class="work mt-3" hidden aria-live="polite"><p class="small mb-2" id="msg"></p>${progressHtml('bar')}</div></div></section>
      <section id="out"></section>
      <p class="small text-body-secondary">O modelo HTDemucs é da Meta (licença CC BY-NC 4.0, uso não comercial).</p>`;
    audioSource($('#src'), {
      range: 'optional', modes: ['youtube', 'file', 'mic'], action: 'Separar as faixas',
      hint: 'Deixe em branco para a música inteira. Músicas longas usam bastante memória.',
      onAudio: run,
    });
    showWork();
    drawOut();
    return () => { mixer?.destroy(); mixer = null; };
  },
};

function showWork() {
  const w = $('#work');
  if (!w) return;
  w.hidden = !st.running;
  $('#msg').textContent = st.msg;
  setProgress($('#bar'), st.frac);
}

async function run(audio) {
  if (st.running) { toast('Já estou separando uma música; espere terminar.'); return; }
  const secs = audio.channels[0].length / audio.sampleRate;
  if (secs > 9 * 60) { toast('Áudio muito longo para separar no navegador. Escolha um trecho de até 9 minutos.', 'warning'); return; }
  st.running = true; st.msg = 'Preparando…'; st.frac = 0; showWork();
  try {
    const { separate } = await import('/lib/ai/separate.js');
    st.stems = await separate(audio.channels, audio.sampleRate, (m, f) => { st.msg = m; st.frac = f; showWork(); }, { stems: ['vocals', 'drums', 'bass', 'other'] });
    st.label = `${audio.label}${audio.end ? ` (${mmss(audio.start || 0)}–${mmss(audio.end)})` : ''}`;
    toast('Faixas separadas!', 'success');
  } catch (err) {
    toast('Não foi possível separar: ' + err.message, 'danger');
  }
  st.running = false; showWork();
  drawOut();
}

async function drawOut() {
  const box = $('#out');
  if (!box || !st.stems) return;
  const { STEMS } = await import('/lib/ai/separate.js');
  box.innerHTML = `<section class="card mb-4"><div class="card-body"><h2 class="h5">${esc(st.label)}</h2><div id="mixer"></div></div></section>`;
  mixer?.destroy();
  mixer = stemMixer($('#mixer'), { stems: st.stems, sampleRate: 44100, labels: STEMS, name: st.label });
}
