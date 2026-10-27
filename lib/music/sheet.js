// Desenha uma cifra ChordPro em HTML (acordes sobre a letra, quebrando bem em telas estreitas).
import { parseChordPro } from './theory.js';
import { esc } from '../core/ui.js';

export function renderSheet(content) {
  const { lines } = parseChordPro(content || '');
  let h = '';
  let lastGap = true;
  for (const l of lines) {
    if (l.type === 'empty') { if (!lastGap) h += '<div class="gap"></div>'; lastGap = true; continue; }
    lastGap = false;
    if (l.type === 'section') h += `<div class="section">${esc(l.text)}</div>`;
    else if (l.type === 'tab') h += `<div class="tab">${esc(l.text)}</div>`;
    else if (l.type === 'chords') h += `<div class="ln chords-only">${l.segments.filter((s) => s.chord).map((s) => `<b class="ch">${esc(s.chord)}</b>`).join('')}</div>`;
    else if (l.segments.some((s) => s.chord)) {
      // cada palavra vira um bloco, para a linha poder quebrar sem desalinhar o acorde
      const parts = [];
      for (const s of l.segments) {
        const words = s.text.match(/\s*\S+\s*|\s+/g) || [''];
        words.forEach((w, i) => parts.push({ chord: i === 0 ? s.chord : null, text: w }));
      }
      h += '<div class="ln has-ch">' + parts.map((s) => `<span class="seg"><b class="ch">${esc(s.chord || '')}</b><span class="tx">${esc(s.text) || (s.chord ? ' ' : '')}</span></span>`).join('') + '</div>';
    } else h += `<div class="ln">${esc(l.segments.map((s) => s.text).join(''))}</div>`;
  }
  return h || '<p class="text-body-secondary">Sem cifra.</p>';
}
