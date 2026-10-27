// Ferramenta: editor da Sonicake Pocket Master pelo USB ou Bluetooth.
import * as PM from '/lib/pocketmaster/session.js';
import { blockEditor, applyEdit } from '/lib/pocketmaster/editor.js';
import { slotLabel, cleanName, USER_PRESETS } from '/lib/pocketmaster/pm.js';
import { $, esc, toast, download, slug, confirmBox, busyButton } from '/lib/core/ui.js';

let active = false;
let editor = null;
let shown = null; // o que está no editor (espelho do preset em edição)
let refreshTimer = 0;

PM.onDevice((type) => {
  if (!active) return;
  if (type === 'connect' || type === 'disconnect' || type === 'names') draw();
  if (type === 'preset' || type === 'knob') { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 250); }
});
PM.backupStore.onRemote(() => { if (active) drawBackups(); });

export default {
  title: 'Pocket Master',
  render(el) {
    active = true;
    el.innerHTML = `<div class="d-flex flex-wrap align-items-end justify-content-between gap-2 mb-3">
        <div><h1 class="h2 mb-1">Pocket Master</h1><p class="text-body-secondary mb-0">Editor da Sonicake Pocket Master pelo USB (Web MIDI) ou Bluetooth (Web Bluetooth). Projeto não oficial.</p></div>
      </div>
      <div id="pm-main"></div>
      <section class="mt-4"><h2 class="h5">Cópias de segurança</h2><p class="small text-body-secondary">Antes de salvar por cima de um preset (aqui ou no Timbres), uma cópia do que estava lá fica guardada${''} — e vai para a sua conta, se você tiver entrado.</p><div id="pm-backups"></div></section>`;
    draw();
    drawBackups();
    return () => { active = false; };
  },
};

function draw() {
  const box = $('#pm-main');
  if (!box) return;
  const pm = PM.device();
  if (!pm) {
    shown = null;
    box.innerHTML = `<div class="card"><div class="card-body"><p>Conecte a Pocket Master:</p>${PM.connectButtonsHtml()}</div></div>`;
    box.oninput = box.onchange = null;
    box.onclick = async (e) => {
      const b = e.target.closest('[data-connect]');
      if (!b) return;
      busyButton(b, true, 'Conectando…');
      try { await PM.connect(b.dataset.connect); } catch (err) { toast(PM.connectError(err), 'danger'); draw(); }
    };
    return;
  }
  shown = structuredClone(pm.state);
  const opt = (i) => `<option value="${i}"${i === pm.current ? ' selected' : ''}>${slotLabel(i)} · ${esc(pm.names[i] || '')}</option>`;
  box.innerHTML = `
    <div class="card mb-3"><div class="card-body">
      <div class="row g-2 align-items-end">
        <div class="col-md-5"><label class="form-label small mb-0" for="pm-preset">Preset</label>
          <select class="form-select" id="pm-preset"><optgroup label="Do usuário">${Array.from({ length: 50 }, (_, i) => opt(i)).join('')}</optgroup><optgroup label="De fábrica">${Array.from({ length: 50 }, (_, i) => opt(i + 50)).join('')}</optgroup></select></div>
        <div class="col-md-3"><label class="form-label small mb-0 d-flex justify-content-between" for="pm-vol"><span>Volume do preset</span><output id="pm-vol-out">${shown.preset_volume ?? 50}</output></label><input class="form-range" type="range" id="pm-vol" min="0" max="100" value="${shown.preset_volume ?? 50}"></div>
        <div class="col-md-4 d-flex flex-wrap gap-2 justify-content-md-end">
          <button class="btn btn-outline-secondary btn-sm" type="button" data-a="reload" title="Descartar as mudanças e recarregar o preset salvo"><i class="bi bi-arrow-counterclockwise"></i> Desfazer</button>
          <button class="btn btn-outline-secondary btn-sm" type="button" data-a="export"><i class="bi bi-download"></i> Exportar</button>
          <label class="btn btn-outline-secondary btn-sm mb-0"><i class="bi bi-upload"></i> Importar<input type="file" accept="application/json,.json" id="pm-import" hidden></label>
        </div>
      </div>
      <p class="small text-body-secondary mt-2 mb-0">Conectada pelo ${pm.via === 'ble' ? '<i class="bi bi-bluetooth"></i> Bluetooth' : '<i class="bi bi-usb-symbol"></i> USB'} (${esc(pm.name)}) · <button class="btn btn-link btn-sm p-0 align-baseline" type="button" data-a="disconnect">desconectar</button>. As mudanças vão na hora para o preset em edição; para manter, salve abaixo.</p>
    </div></div>
    <div id="pm-editor" class="mb-3"></div>
    <div class="card"><div class="card-body">
      <h2 class="h6">Salvar</h2>
      <div class="row g-2 align-items-end">
        <div class="col-sm-5"><label class="form-label small mb-0" for="pm-slot">Preset do usuário</label><select class="form-select form-select-sm" id="pm-slot">${Array.from({ length: USER_PRESETS }, (_, i) => `<option value="${i}"${i === (pm.current < 50 ? pm.current : 0) ? ' selected' : ''}>${slotLabel(i)} · ${esc(pm.names[i] || '')}</option>`).join('')}</select></div>
        <div class="col-sm-4"><label class="form-label small mb-0" for="pm-name">Nome (até 10 letras)</label><input class="form-control form-control-sm" id="pm-name" maxlength="10" value="${esc(pm.current < 50 ? pm.names[pm.current] || '' : '')}"></div>
        <div class="col-sm-3"><button class="btn btn-primary btn-sm w-100" type="button" data-a="save"><i class="bi bi-save"></i> Salvar</button></div>
      </div>
    </div></div>`;
  editor = blockEditor($('#pm-editor'), {
    map: pm.map,
    onChange: async (ch) => {
      const prev = shown;
      shown = applyEdit(pm.map, shown, ch);
      try { await pm.apply(shown, prev); } catch (err) { toast(err.message, 'danger'); }
      if (ch.type === 'model') editor.render(shown);
    },
  });
  editor.render(shown);
  box.oninput = async (e) => {
    if (e.target.id === 'pm-vol') {
      const prev = shown;
      shown = { ...shown, preset_volume: Number(e.target.value) };
      $('#pm-vol-out').textContent = e.target.value;
      try { await pm.apply(shown, prev); } catch { /* ok */ }
    }
  };
  box.onchange = async (e) => {
    if (e.target.id === 'pm-preset') { try { await pm.select(Number(e.target.value)); draw(); } catch (err) { toast(err.message, 'danger'); } }
    if (e.target.id === 'pm-import') {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const d = JSON.parse(await file.text());
        if (!d.blocks) throw new Error();
        await pm.apply(d);
        shown = await pm.refresh();
        draw();
        toast('Preset importado para a edição. Salve para manter.', 'success');
      } catch { toast('Esse arquivo não é um preset válido.', 'danger'); }
    }
  };
  box.onclick = async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'disconnect') { PM.disconnect(); return; }
    if (b.dataset.a === 'reload') { await pm.select(pm.current ?? 0); draw(); }
    if (b.dataset.a === 'export') download(`pocketmaster-${slotLabel(pm.current ?? 0)}-${slug(pm.names[pm.current] || 'preset')}.json`, { ...shown, name: pm.names[pm.current] || '' });
    if (b.dataset.a === 'save') {
      const slot = Number($('#pm-slot').value);
      const name = cleanName($('#pm-name').value) || 'Preset';
      const old = pm.names[slot] || '';
      if (!(await confirmBox(`Salvar "${name}" no ${slotLabel(slot)}${old ? `, no lugar de "${old}"` : ''}? Uma cópia do que está lá fica guardada.`, { ok: 'Salvar' }))) return;
      busyButton(b, true, 'Salvando…');
      try { const s = shown; await PM.saveWithBackup(slot, name, s); toast(`Salvo no ${slotLabel(slot)}.`, 'success'); } catch (err) { toast(err.message, 'danger'); }
      draw(); drawBackups();
    }
  };
}

async function refresh() {
  const pm = PM.device();
  if (!pm || !active) return;
  try { await pm.refresh(); } catch { return; }
  shown = structuredClone(pm.state);
  if ($('#pm-preset')) { $('#pm-preset').value = String(pm.current); editor?.render(shown); }
}

function drawBackups() {
  const box = $('#pm-backups');
  if (!box) return;
  const list = PM.backupStore.data.backups;
  if (!list.length) { box.innerHTML = '<p class="small text-body-secondary">Nenhuma cópia ainda.</p>'; return; }
  box.innerHTML = `<div class="list-group song-rows plain">${list.map((b) => `<div class="list-group-item"><span class="main"><strong>${slotLabel(b.slot)} · ${esc(b.name)}</strong><small>guardada em ${new Date(b.date).toLocaleString('pt-BR')}</small></span>
    <span class="ctrls"><button class="btn btn-sm btn-outline-primary" type="button" data-b="restore" data-id="${b.id}"${PM.device() ? '' : ' disabled title="Conecte a pedaleira"'}>Restaurar</button>
    <button class="btn btn-sm btn-outline-secondary" type="button" data-b="dl" data-id="${b.id}" title="Baixar"><i class="bi bi-download"></i></button>
    <button class="btn btn-sm btn-link text-body" type="button" data-b="del" data-id="${b.id}" aria-label="Apagar cópia"><i class="bi bi-trash"></i></button></span></div>`).join('')}</div>`;
  box.onclick = async (e) => {
    const el = e.target.closest('[data-b]');
    if (!el) return;
    const b = list.find((x) => x.id === el.dataset.id);
    if (!b) return;
    if (el.dataset.b === 'dl') download(`preset-${slotLabel(b.slot)}-${slug(b.name)}.json`, { ...b.state, name: b.name });
    if (el.dataset.b === 'del' && await confirmBox('Apagar esta cópia?', { ok: 'Apagar', danger: true })) { PM.removeBackup(b.id); drawBackups(); }
    if (el.dataset.b === 'restore' && await confirmBox(`Restaurar "${b.name}" no ${slotLabel(b.slot)}? O que estiver lá agora será substituído.`, { ok: 'Restaurar' })) {
      busyButton(el, true);
      try { await PM.restoreBackup(b); toast(`${slotLabel(b.slot)} restaurado.`, 'success'); } catch (err) { toast(err.message, 'danger'); }
      draw(); drawBackups();
    }
  };
}
