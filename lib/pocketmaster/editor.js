// Editor visual dos blocos de um preset da Pocket Master (liga/desliga, modelo e parâmetros).
// Usado na ferramenta Pedaleira e no Timbres.
import { LABELS, MODULES, modelByName } from './pm.js';
import { esc } from '../core/ui.js';

/**
 * Monta o editor em `el`. onChange({ type:'param'|'on'|'model', key, name?, value })
 * Retorna { render(spec) }. Mexer num controle não redesenha o editor (o arraste continua).
 */
export function blockEditor(el, { map, onChange, compact = false }) {
  const paramInput = (key, p, v) => {
    const id = `pe-${key}-${p.alg}`;
    if (p.type === 'switch') {
      return `<div class="col"><div class="form-check form-switch mt-1"><input class="form-check-input" type="checkbox" role="switch" id="${id}" data-p="${key}" data-n="${esc(p.name)}"${v ? ' checked' : ''}><label class="form-check-label" for="${id}">${esc(p.name)}</label></div></div>`;
    }
    if (p.type === 'select') {
      return `<div class="col"><label class="form-label small mb-0" for="${id}">${esc(p.name)}</label><select class="form-select form-select-sm" id="${id}" data-p="${key}" data-n="${esc(p.name)}">${p.options.map((o, i) => `<option value="${i}"${i === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
    }
    return `<div class="col"><label class="form-label small mb-0 d-flex justify-content-between" for="${id}"><span>${esc(p.name)}</span><output class="text-body-secondary">${v}${p.unit ? ' ' + p.unit : ''}</output></label>
      <input type="range" class="form-range" id="${id}" data-p="${key}" data-n="${esc(p.name)}" data-unit="${esc(p.unit || '')}" min="${p.min}" max="${p.max}" step="${p.step || 1}" value="${v}"></div>`;
  };

  function render(spec) {
    el.innerHTML = `<div class="vstack gap-2">${(spec.chain || MODULES).map((key) => {
      const b = spec.blocks[key];
      if (!b) return '';
      const pool = key === 'amp' && spec.amp_mode === 'clone' ? 'clone' : key;
      const m = modelByName(map, pool, b.model);
      const models = map.models[pool] || [];
      return `<section class="card pm-block${b.on ? '' : ' is-off'}" data-key="${key}">
        <div class="card-header d-flex flex-wrap align-items-center gap-2 py-2">
          <div class="form-check form-switch m-0"><input class="form-check-input" type="checkbox" role="switch" id="on-${key}" data-on="${key}"${b.on ? ' checked' : ''}><label class="form-check-label fw-bold" for="on-${key}">${LABELS[key]}</label></div>
          ${models.length > 1 ? `<select class="form-select form-select-sm w-auto ms-auto" data-model="${key}" aria-label="Modelo de ${LABELS[key]}">${models.map((x) => `<option${x.name === b.model ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : `<span class="ms-auto small">${esc(b.model || '')}</span>`}
        </div>
        ${m && m.params.length ? `<div class="card-body py-2"><div class="row row-cols-1 row-cols-sm-2 ${compact ? '' : 'row-cols-lg-3'} g-2">${m.params.map((p) => paramInput(key, p, b.params?.[p.name] ?? p.default)).join('')}</div></div>` : ''}
      </section>`;
    }).join('')}</div>`;
  }

  el.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.dataset.p) return;
    const value = t.type === 'checkbox' ? (t.checked ? 1 : 0) : Number(t.value);
    const out = t.parentElement.querySelector('output');
    if (out) out.textContent = value + (t.dataset.unit ? ' ' + t.dataset.unit : '');
    onChange({ type: 'param', key: t.dataset.p, name: t.dataset.n, value });
  });
  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.on) { t.closest('.pm-block').classList.toggle('is-off', !t.checked); onChange({ type: 'on', key: t.dataset.on, value: t.checked }); }
    if (t.dataset.model) onChange({ type: 'model', key: t.dataset.model, value: t.value });
  });
  return { render };
}

/** Aplica uma mudança do editor num preset (spec) e devolve o novo. */
export function applyEdit(map, spec, ch) {
  const s = structuredClone(spec);
  const b = s.blocks[ch.key] ||= { on: true, params: {} };
  if (ch.type === 'param') b.params = { ...b.params, [ch.name]: ch.value };
  if (ch.type === 'on') b.on = ch.value;
  if (ch.type === 'model') {
    const pool = ch.key === 'amp' && s.amp_mode === 'clone' ? 'clone' : ch.key;
    const m = modelByName(map, pool, ch.value);
    b.model = ch.value;
    b.params = Object.fromEntries((m?.params || []).map((p) => [p.name, p.default]));
    b.on = true;
  }
  return s;
}
