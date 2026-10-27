// Ferramenta: comparar dois áudios (curva de frequências, distorção, compressão, reverb, andamento).
import { audioSource } from '/lib/widgets/source.js';
import { drawCurves, diffCurve } from '/lib/widgets/chart.js';
import { analyzeTone, tempoEstimate, curveMean } from '/lib/audio/tone.js';
import { mono, playSamples } from '/lib/audio/io.js';
import { $, esc, mmss, toast, progressHtml, setProgress } from '/lib/core/ui.js';

const st = { part: 'mix', A: null, B: null, stop: null, showDiff: false };
const PARTS = [['mix', 'Áudio inteiro'], ['other', 'Só guitarra/harmonia (separa com IA)'], ['bass', 'Só baixo (separa com IA)'], ['vocals', 'Só voz (separa com IA)']];

export default {
  title: 'Comparar áudios',
  render(el) {
    el.innerHTML = `<h1 class="h2">Comparar áudios</h1>
      <p class="text-body-secondary">Compare dois sons: um timbre da música com o da sua pedaleira, duas gravações, duas mixagens… Cada lado pode ser um vídeo, um arquivo ou uma gravação.</p>
      <div class="row g-2 align-items-center mb-3"><div class="col-auto"><label class="form-label mb-0" for="cmp-part">Comparar</label></div>
        <div class="col-sm-auto"><select class="form-select" id="cmp-part">${PARTS.map(([v, l]) => `<option value="${v}"${v === st.part ? ' selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="row g-4 mb-4">${['A', 'B'].map((k) => `
        <div class="col-lg-6"><section class="card h-100"><div class="card-body">
          <h2 class="h5"><span class="badge ${k === 'A' ? 'text-bg-primary' : 'text-bg-warning'}">${k}</span> <span id="name-${k}">${esc(st[k]?.label || 'Áudio ' + k)}</span></h2>
          <div id="src-${k}"></div>
          <div class="mt-3" id="work-${k}" hidden><p class="small mb-2" id="msg-${k}"></p>${progressHtml('bar-' + k)}</div>
        </div></section></div>`).join('')}</div>
      <section id="cmp-out"></section>`;
    for (const k of ['A', 'B']) {
      audioSource($('#src-' + k), { range: 'optional', modes: ['youtube', 'file', 'mic'], action: `Usar como ${k}`, hint: 'Deixe em branco para usar tudo.', onAudio: (a) => load(k, a) });
    }
    $('#cmp-part').onchange = (e) => { st.part = e.target.value; toast('Escolha os áudios de novo para comparar desta forma.'); st.A = st.B = null; draw(); };
    draw();
    return () => { st.stop?.(); };
  },
};

function work(k, msg, frac) {
  const w = $('#work-' + k);
  if (!w) return;
  w.hidden = msg == null;
  if (msg != null) { $('#msg-' + k).textContent = msg; setProgress($('#bar-' + k), frac); }
}

async function load(k, audio) {
  try {
    let samples = mono(audio.channels), sr = audio.sampleRate;
    const bpm = await tempoEstimate(samples, sr);
    if (st.part !== 'mix') {
      const { separate } = await import('/lib/ai/separate.js');
      const stems = await separate(audio.channels, audio.sampleRate, (m, f) => work(k, m, f), { stems: [st.part] });
      samples = stems[st.part]; sr = 44100;
    }
    work(k, 'Analisando…', 0);
    const f = await analyzeTone(samples, sr, (p) => work(k, 'Analisando…', p));
    f.bpm = bpm;
    st[k] = { label: `${audio.label}${audio.end ? ` (${mmss(audio.start || 0)}–${mmss(audio.end)})` : ''}`, f, samples, sr };
    work(k, null);
    const n = $('#name-' + k); if (n) n.textContent = st[k].label;
    draw();
  } catch (err) { work(k, null); toast(err.message || 'Não consegui analisar esse áudio.', 'danger'); }
}

const fmt = (v, unit = '', d = 1) => (v == null || Number.isNaN(v) ? '—' : `${v > 0 && unit === 'dB' ? '+' : ''}${v.toFixed(d)}${unit ? ' ' + unit : ''}`);
function rows(A, B) {
  const band = (f, lo, hi) => curveMean(f.curve, lo, hi);
  const R = [
    ['Distorção (0 a 100)', (f) => f.gain * 100, '', 0],
    ['Graves (80–250 Hz)', (f) => band(f, 80, 250), 'dB'],
    ['Médios (400–1.200 Hz)', (f) => band(f, 400, 1200), 'dB'],
    ['Agudos (1,8–4,5 kHz)', (f) => band(f, 1800, 4500), 'dB'],
    ['Presença (4,5–8 kHz)', (f) => band(f, 4500, 8000), 'dB'],
    ['Compressão (0 a 100)', (f) => f.compression * 100, '', 0],
    ['Reverb (tempo de queda)', (f) => f.reverb.rt, 's'],
    ['Andamento', (f) => f.bpm || NaN, 'BPM', 0],
  ];
  return R.map(([label, fn, unit, d = 1]) => {
    const a = A ? fn(A.f) : null, b = B ? fn(B.f) : null;
    const diff = a != null && b != null ? b - a : null;
    return `<tr><th scope="row" class="fw-normal">${label}</th><td>${fmt(a, unit, d)}</td><td>${fmt(b, unit, d)}</td><td class="${diff == null ? '' : Math.abs(diff) < (unit === 'dB' ? 1.5 : unit === 's' ? 0.2 : 8) ? 'text-success' : 'text-warning-emphasis'}">${diff == null ? '—' : fmt(diff, unit === 'dB' ? 'dB' : unit, d)}</td></tr>`;
  }).join('');
}

function draw() {
  const box = $('#cmp-out');
  if (!box) return;
  const { A, B } = st;
  if (!A && !B) { box.innerHTML = ''; return; }
  box.innerHTML = `<section class="card"><div class="card-body">
    <div class="d-flex flex-wrap gap-2 align-items-center mb-2"><h2 class="h5 mb-0 me-auto">Comparação</h2>
      ${A ? '<button class="btn btn-sm btn-outline-primary" type="button" data-p="A"><i class="bi bi-play-fill"></i> Ouvir A</button>' : ''}
      ${B ? '<button class="btn btn-sm btn-outline-warning" type="button" data-p="B"><i class="bi bi-play-fill"></i> Ouvir B</button>' : ''}
      <button class="btn btn-sm btn-outline-secondary" type="button" data-p="stop" hidden><i class="bi bi-stop-fill"></i> Parar</button>
      ${A && B ? `<div class="form-check form-switch ms-2"><input class="form-check-input" type="checkbox" role="switch" id="cmp-diff"${st.showDiff ? ' checked' : ''}><label class="form-check-label small" for="cmp-diff">Mostrar a diferença (B − A)</label></div>` : ''}
    </div>
    <figure class="chart-box border rounded p-2"><svg id="cmp-chart" role="img" aria-label="Curvas de frequência"></svg><figcaption class="small text-body-secondary pt-1" id="cmp-legend"></figcaption></figure>
    <div class="table-responsive"><table class="table table-sm align-middle mb-0"><thead><tr><th scope="col">Medida</th><th scope="col">A</th><th scope="col">B</th><th scope="col">Diferença</th></tr></thead><tbody>${rows(A, B)}</tbody></table></div>
    <p class="small text-body-secondary mt-2 mb-0">As curvas são normalizadas (0 dB = média de 250 Hz a 4 kHz), então mostram o equilíbrio do som, não o volume. Diferenças em verde são pequenas.</p>
  </div></section>`;
  const series = [A && { curve: A.f.curve, kind: 'a', label: 'A: ' + A.label }, B && { curve: B.f.curve, kind: 'b', label: 'B: ' + B.label }];
  if (A && B && st.showDiff) series.push({ curve: diffCurve(A.f.curve, B.f.curve), kind: 'diff', label: 'Diferença B − A' });
  $('#cmp-legend').innerHTML = drawCurves($('#cmp-chart'), series.filter(Boolean));
  box.onchange = (e) => { if (e.target.id === 'cmp-diff') { st.showDiff = e.target.checked; draw(); } };
  box.onclick = (e) => {
    const p = e.target.closest('[data-p]')?.dataset.p;
    if (!p) return;
    st.stop?.(); st.stop = null;
    const sb = box.querySelector('[data-p="stop"]');
    sb.hidden = true;
    if (p === 'stop') return;
    st.stop = playSamples([st[p].samples], st[p].sr, { onEnd: () => { sb.hidden = true; } }).stop;
    sb.hidden = false;
  };
}
