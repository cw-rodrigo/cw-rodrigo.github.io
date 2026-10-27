// Formas de tocar: teclado na tela (toque/mouse, várias notas), teclado do computador e teclado MIDI.
import { esc } from '../core/ui.js';
import { PEDAL_NAME } from '../pocketmaster/pm.js';

const BLACK = [1, 3, 6, 8, 10];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteLabel = (n) => NAMES[n % 12] + (Math.floor(n / 12) - 1);

/**
 * Teclado na tela. opts: { from (nota da primeira tecla), octaves, onOn(note, vel), onOff(note) }
 * A força vem da altura do toque na tecla (mais embaixo = mais forte).
 */
export function pianoKeyboard(el, opts) {
  let from = opts.from ?? 48, octaves = opts.octaves ?? 2;
  const pointers = new Map();
  function render() {
    const whites = [];
    for (let n = from; n < from + octaves * 12 + 1; n++) if (!BLACK.includes(n % 12)) whites.push(n);
    const w = 100 / whites.length;
    let html = '';
    whites.forEach((n, i) => { html += `<div class="pk white" data-n="${n}" style="left:${i * w}%;width:${w}%"><span>${n % 12 === 0 ? noteLabel(n) : ''}</span></div>`; });
    for (let n = from; n < from + octaves * 12; n++) {
      if (!BLACK.includes(n % 12)) continue;
      const i = whites.indexOf(n - 1);
      html += `<div class="pk black" data-n="${n}" style="left:${(i + 1) * w - w * 0.3}%;width:${w * 0.6}%"></div>`;
    }
    el.innerHTML = `<div class="piano" role="group" aria-label="Teclado">${html}</div>`;
  }
  const keyAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('.pk');
  const velOf = (k, y) => { const r = k.getBoundingClientRect(); return Math.round(40 + 87 * Math.min(1, Math.max(0, (y - r.top) / r.height))); };
  const press = (id, k, y) => {
    const n = Number(k.dataset.n);
    pointers.set(id, n);
    k.classList.add('on');
    opts.onOn(n, velOf(k, y));
  };
  const lift = (id) => {
    const n = pointers.get(id);
    if (n == null) return;
    pointers.delete(id);
    if (![...pointers.values()].includes(n)) { el.querySelector(`.pk[data-n="${n}"]`)?.classList.remove('on'); opts.onOff(n); }
  };
  el.addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.pk');
    if (!k) return;
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    press(e.pointerId, k, e.clientY);
  });
  el.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const k = keyAt(e.clientX, e.clientY);
    if (k && Number(k.dataset.n) !== pointers.get(e.pointerId)) { lift(e.pointerId); press(e.pointerId, k, e.clientY); }
  });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, (e) => lift(e.pointerId));
  render();
  return {
    setRange(f, o = octaves) { from = f; octaves = o; render(); },
    get from() { return from; },
    /** Acende/apaga uma tecla (notas vindas de outro lugar). */
    light(n, on) { el.querySelector(`.pk[data-n="${n}"]`)?.classList.toggle('on', on); },
  };
}

const QWERTY = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, 'ç': 16 };
/**
 * Teclado do computador: A W S E D F T G Y H U J K O L P Ç = notas; Z/X mudam a oitava; C/V a força.
 * opts: { onOn, onOff, onOctave(oitava), base (nota da tecla A) }. Retorna { detach, state }.
 */
export function qwertyKeys(opts) {
  const st = { base: opts.base ?? 60, vel: 100 };
  const down = new Map();
  const skip = (e) => e.ctrlKey || e.metaKey || e.altKey || /input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable;
  const kd = (e) => {
    if (skip(e)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' || k === 'x') { st.base = Math.max(12, Math.min(108, st.base + (k === 'z' ? -12 : 12))); opts.onOctave?.(st.base); return; }
    if (k === 'c' || k === 'v') { st.vel = Math.max(10, Math.min(127, st.vel + (k === 'c' ? -15 : 15))); opts.onVel?.(st.vel); return; }
    if (!(k in QWERTY) || e.repeat || down.has(k)) return;
    e.preventDefault();
    const n = st.base + QWERTY[k];
    down.set(k, n);
    opts.onOn(n, st.vel);
  };
  const ku = (e) => {
    const k = e.key.toLowerCase();
    if (!down.has(k)) return;
    opts.onOff(down.get(k));
    down.delete(k);
  };
  const blur = () => { for (const n of down.values()) opts.onOff(n); down.clear(); };
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);
  window.addEventListener('blur', blur);
  return { state: st, detach() { blur(); window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('blur', blur); } };
}

/**
 * Teclados MIDI ligados ao computador (Web MIDI). A Pocket Master é ignorada.
 * handlers: { onOn(note, vel), onOff(note), onBend(semis -1..1), onMod(0..1), onChange(nomes) }
 */
export async function midiKeyboards(handlers) {
  if (!navigator.requestMIDIAccess) return { names: [], detach() {} };
  const access = await navigator.requestMIDIAccess();
  const attached = new Set();
  const isPedal = (p) => PEDAL_NAME.test(`${p.name} ${p.manufacturer}`);
  const onMsg = (e) => {
    const [st, d1, d2] = e.data;
    const cmd = st & 0xf0;
    if (cmd === 0x90 && d2 > 0) handlers.onOn(d1, d2);
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) handlers.onOff(d1);
    else if (cmd === 0xe0) handlers.onBend?.((((d2 << 7) | d1) - 8192) / 8192);
    else if (cmd === 0xb0 && d1 === 1) handlers.onMod?.(d2 / 127);
    else if (cmd === 0xb0 && (d1 === 123 || d1 === 120)) handlers.onAllOff?.();
  };
  const attach = () => {
    for (const inp of access.inputs.values()) {
      if (isPedal(inp) || attached.has(inp)) continue;
      inp.addEventListener('midimessage', onMsg);
      attached.add(inp);
    }
    handlers.onChange?.([...attached].filter((i) => i.state === 'connected').map((i) => i.name));
  };
  access.addEventListener('statechange', attach);
  attach();
  return {
    get names() { return [...attached].filter((i) => i.state === 'connected').map((i) => esc(i.name)); },
    detach() { access.removeEventListener('statechange', attach); for (const i of attached) i.removeEventListener('midimessage', onMsg); attached.clear(); },
  };
}
