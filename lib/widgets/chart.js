// Gráfico de curvas de frequência (1/3 de oitava), usado no Timbres e no Comparar áudios.
import { BANDS } from '../audio/tone.js';
import { esc } from '../core/ui.js';

const STYLES = {
  a: { cls: 'c-a', label: 'A' },
  b: { cls: 'c-b', label: 'B' },
  ref: { cls: 'c-ref', label: 'Referência' },
  diff: { cls: 'c-diff', label: 'Diferença' },
};

/**
 * Desenha no SVG. series: [{ curve, label, kind: 'a'|'b'|'ref'|'diff' }]
 * Retorna o HTML da legenda (para pôr embaixo).
 */
export function drawCurves(svg, series, { min = -30, max = 12 } = {}) {
  const W = 640, H = 220, L = 34, R = 8, T = 10, B = 24;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const x = (f) => L + ((Math.log10(f) - Math.log10(60)) / (Math.log10(11000) - Math.log10(60))) * (W - L - R);
  const y = (d) => T + ((max - d) / (max - min)) * (H - T - B);
  const path = (c) => c.map((v, i) => `${i ? 'L' : 'M'}${x(BANDS[i]).toFixed(1)},${y(Math.max(min, Math.min(max, v))).toFixed(1)}`).join('');
  let g = '';
  for (let d = Math.ceil(max / 12) * 12; d >= min; d -= 12) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(d)}" y2="${y(d)}"/><text class="lbl" x="${L - 6}" y="${y(d) + 4}" text-anchor="end">${d > 0 ? '+' : ''}${d}</text>`;
  for (const [f, t] of [[100, '100'], [300, '300'], [1000, '1k'], [3000, '3k'], [10000, '10k']]) g += `<line class="grid" x1="${x(f)}" x2="${x(f)}" y1="${T}" y2="${H - B}"/><text class="lbl" x="${x(f)}" y="${H - 6}" text-anchor="middle">${t} Hz</text>`;
  for (const s of series) if (s?.curve) g += `<path class="${STYLES[s.kind]?.cls || 'c-a'}" d="${path(s.curve)}"><title>${esc(s.label || '')}</title></path>`;
  svg.innerHTML = g;
  return series.filter((s) => s?.curve).map((s) => `<span class="me-3"><i class="swatch ${STYLES[s.kind]?.cls || 'c-a'}"></i>${esc(s.label || STYLES[s.kind]?.label)}</span>`).join('');
}

/** Curva B − A (dB). */
export function diffCurve(a, b) { return a.map((v, i) => b[i] - v); }
