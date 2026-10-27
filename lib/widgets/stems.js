// Mixer das faixas separadas: tocar juntas com volume por faixa, solo/mudo e baixar em WAV.
import { encodeWav } from '../audio/io.js';
import { esc, mmss, download, slug } from '../core/ui.js';

/**
 * stems: { nome: Float32Array (mono) }, labels: { nome: rótulo }.
 * Retorna { destroy() }.
 */
export function stemMixer(el, { stems, sampleRate, labels = {}, name = 'faixas' }) {
  const names = Object.keys(stems);
  const len = stems[names[0]].length;
  const dur = len / sampleRate;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buffers = Object.fromEntries(names.map((n) => {
    const b = ctx.createBuffer(1, len, sampleRate);
    b.copyToChannel(stems[n], 0);
    return [n, b];
  }));
  const gains = Object.fromEntries(names.map((n) => { const g = ctx.createGain(); g.connect(ctx.destination); return [n, g]; }));
  const st = { vol: Object.fromEntries(names.map((n) => [n, 1])), mute: {}, solo: null, playing: false, offset: 0, startedAt: 0, sources: [] };

  el.innerHTML = `
    <div class="stem-mixer">
      <div class="d-flex align-items-center gap-2 mb-3">
        <button class="btn btn-primary" type="button" data-m="play" aria-label="Tocar"><i class="bi bi-play-fill"></i></button>
        <input type="range" class="form-range flex-grow-1" data-m="seek" min="0" max="${dur.toFixed(2)}" step="0.1" value="0" aria-label="Posição">
        <span class="small text-body-secondary font-monospace" data-m="time">0:00 / ${mmss(dur)}</span>
      </div>
      <div class="vstack gap-2">${names.map((n) => `
        <div class="stem-row d-flex flex-wrap align-items-center gap-2" data-stem="${n}">
          <strong class="stem-name">${esc(labels[n] || n)}</strong>
          <input type="range" class="form-range flex-grow-1" min="0" max="1.5" step="0.05" value="1" data-vol="${n}" aria-label="Volume de ${esc(labels[n] || n)}">
          <div class="btn-group btn-group-sm" role="group">
            <input type="checkbox" class="btn-check" id="m-${n}" data-mute="${n}"><label class="btn btn-outline-secondary" for="m-${n}" title="Mudo">M</label>
            <input type="checkbox" class="btn-check" id="s-${n}" data-solo="${n}"><label class="btn btn-outline-warning" for="s-${n}" title="Solo">S</label>
          </div>
          <button class="btn btn-outline-secondary btn-sm" type="button" data-dl="${n}" title="Baixar em WAV"><i class="bi bi-download"></i></button>
        </div>`).join('')}</div>
      <div class="mt-3"><button class="btn btn-outline-primary btn-sm" type="button" data-m="mix"><i class="bi bi-download"></i> Baixar a mixagem como está</button></div>
    </div>`;

  const level = (n) => (st.solo ? (st.solo === n ? st.vol[n] : 0) : st.mute[n] ? 0 : st.vol[n]);
  const applyGains = () => names.forEach((n) => gains[n].gain.setTargetAtTime(level(n), ctx.currentTime, 0.02));
  const pos = () => (st.playing ? Math.min(dur, st.offset + ctx.currentTime - st.startedAt) : st.offset);
  const icon = () => { el.querySelector('[data-m="play"]').innerHTML = `<i class="bi bi-${st.playing ? 'pause' : 'play'}-fill"></i>`; };
  let raf = 0;
  const tick = () => {
    const p = pos();
    el.querySelector('[data-m="seek"]').value = p;
    el.querySelector('[data-m="time"]').textContent = `${mmss(p)} / ${mmss(dur)}`;
    if (st.playing && p >= dur - 0.05) { stop(); st.offset = 0; }
    if (st.playing) raf = requestAnimationFrame(tick);
  };
  function play() {
    ctx.resume();
    st.sources = names.map((n) => { const s = ctx.createBufferSource(); s.buffer = buffers[n]; s.connect(gains[n]); s.start(0, st.offset); return s; });
    st.startedAt = ctx.currentTime;
    st.playing = true;
    applyGains(); icon(); tick();
  }
  function stop() {
    st.offset = pos();
    st.sources.forEach((s) => { try { s.stop(); } catch { /* ok */ } });
    st.sources = [];
    st.playing = false;
    cancelAnimationFrame(raf);
    icon();
  }
  function mixdown() {
    const out = new Float32Array(len);
    for (const n of names) { const g = level(n), x = stems[n]; if (g) for (let i = 0; i < len; i++) out[i] += x[i] * g; }
    let pk = 0;
    for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(out[i]));
    if (pk > 0.99) for (let i = 0; i < len; i++) out[i] *= 0.99 / pk;
    return out;
  }

  el.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.vol) { st.vol[t.dataset.vol] = Number(t.value); applyGains(); }
    if (t.dataset.m === 'seek') { const was = st.playing; if (was) stop(); st.offset = Number(t.value); if (was) play(); else tick(); }
  });
  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.mute) { st.mute[t.dataset.mute] = t.checked; applyGains(); }
    if (t.dataset.solo) {
      el.querySelectorAll('[data-solo]').forEach((x) => { if (x !== t) x.checked = false; });
      st.solo = t.checked ? t.dataset.solo : null;
      applyGains();
    }
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.m === 'play') { if (st.playing) stop(); else play(); }
    if (b.dataset.dl) download(`${slug(name)}-${slug(labels[b.dataset.dl] || b.dataset.dl)}.wav`, encodeWav([stems[b.dataset.dl]], sampleRate));
    if (b.dataset.m === 'mix') download(`${slug(name)}-mixagem.wav`, encodeWav([mixdown()], sampleRate));
  });
  return { destroy() { stop(); ctx.close(); } };
}
