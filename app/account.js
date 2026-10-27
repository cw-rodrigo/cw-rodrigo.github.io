// Conta: entrar, criar conta, sincronizar, trocar senha e sair.
import * as C from '/lib/core/cloud.js';
import { syncAll, syncStatus, onSyncStatus } from '/lib/core/sync.js';
import { $, esc, toast, confirmBox, busyButton } from '/lib/core/ui.js';

let off = null;
export default {
  title: 'Conta',
  render(el) {
    const draw = () => {
      const u = C.user();
      if (!C.configured()) {
        el.innerHTML = `<h1 class="h2">Conta</h1>
          <div class="alert alert-secondary">O login ainda não foi configurado neste site. Enquanto isso, tudo continua salvo neste navegador, e o Cifras e o Timbres têm exportação de backup.</div>`;
        return;
      }
      if (!u) {
        el.innerHTML = `<div class="row justify-content-center"><div class="col-md-7 col-lg-5">
          <h1 class="h2">Conta</h1>
          <p class="text-body-secondary">Com uma conta, suas cifras, listas, timbres, presets do sintetizador e cópias da pedaleira ficam salvos na nuvem e aparecem em qualquer aparelho. Sem conta, tudo continua funcionando, salvo só neste navegador.</p>
          <ul class="nav nav-tabs mb-3" role="tablist">
            <li class="nav-item" role="presentation"><button class="nav-link active" data-bs-toggle="tab" data-bs-target="#tab-in" type="button" role="tab">Entrar</button></li>
            <li class="nav-item" role="presentation"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab-up" type="button" role="tab">Criar conta</button></li>
          </ul>
          <div class="tab-content">
            <form class="tab-pane fade show active" id="tab-in" role="tabpanel" data-form="in">
              <div class="mb-2"><label class="form-label" for="in-user">Usuário</label><input class="form-control" id="in-user" autocomplete="username" autocapitalize="none" required></div>
              <div class="mb-3"><label class="form-label" for="in-pass">Senha</label><input class="form-control" id="in-pass" type="password" autocomplete="current-password" required></div>
              <button class="btn btn-primary w-100" type="submit">Entrar</button>
            </form>
            <form class="tab-pane fade" id="tab-up" role="tabpanel" data-form="up">
              <div class="mb-2"><label class="form-label" for="up-user">Usuário</label><input class="form-control" id="up-user" autocomplete="username" autocapitalize="none" required aria-describedby="up-help"><div class="form-text" id="up-help">3 a 30 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.</div></div>
              <div class="mb-2"><label class="form-label" for="up-pass">Senha</label><input class="form-control" id="up-pass" type="password" autocomplete="new-password" minlength="6" required></div>
              <div class="mb-3"><label class="form-label" for="up-pass2">Repita a senha</label><input class="form-control" id="up-pass2" type="password" autocomplete="new-password" minlength="6" required></div>
              <button class="btn btn-primary w-100" type="submit">Criar conta</button>
              <p class="small text-body-secondary mt-2">Não há recuperação de senha por e-mail: guarde a sua. O que já estiver salvo neste navegador vai junto para a conta.</p>
            </form>
          </div></div></div>`;
        el.onsubmit = async (e) => {
          e.preventDefault();
          const f = e.target;
          const btn = f.querySelector('button[type=submit]');
          busyButton(btn, true);
          try {
            if (f.dataset.form === 'in') await C.signIn($('#in-user').value, $('#in-pass').value);
            else {
              if ($('#up-pass').value !== $('#up-pass2').value) throw new Error('As senhas não são iguais.');
              await C.signUp($('#up-user').value, $('#up-pass').value);
            }
            toast(`Bem-vindo, ${C.user().username}!`, 'success');
            draw();
          } catch (err) { toast(err.message, 'danger'); busyButton(btn, false); }
        };
        return;
      }
      const s = syncStatus();
      el.innerHTML = `<div class="row justify-content-center"><div class="col-md-8 col-lg-6">
        <h1 class="h2">Conta</h1>
        <div class="card mb-3"><div class="card-body">
          <p class="mb-1">Conectado como <strong>${esc(u.username)}</strong>.</p>
          <p class="small text-body-secondary mb-3" id="sync-line">${syncText(s)}</p>
          <button class="btn btn-outline-primary btn-sm" type="button" data-a="sync"><i class="bi bi-arrow-repeat"></i> Sincronizar agora</button>
        </div></div>
        <div class="card mb-3"><form class="card-body" data-form="pass">
          <h2 class="h6">Trocar a senha</h2>
          <div class="input-group"><input class="form-control" type="password" id="new-pass" autocomplete="new-password" minlength="6" placeholder="Nova senha" aria-label="Nova senha" required><button class="btn btn-outline-primary" type="submit">Trocar</button></div>
        </form></div>
        <button class="btn btn-outline-danger" type="button" data-a="out"><i class="bi bi-box-arrow-right"></i> Sair</button>
        <p class="small text-body-secondary mt-2">Ao sair, seus dados saem deste aparelho, mas continuam na sua conta.</p>
      </div></div>`;
      el.onsubmit = async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type=submit]');
        busyButton(btn, true);
        try { await C.changePassword($('#new-pass').value); toast('Senha trocada.', 'success'); $('#new-pass').value = ''; } catch (err) { toast(err.message, 'danger'); }
        busyButton(btn, false);
      };
    };
    const syncText = (s) => ({ syncing: 'Sincronizando…', ok: `Sincronizado${s.at ? ' às ' + new Date(s.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''}.`, error: `Erro ao sincronizar: ${s.error}`, idle: 'Pronto para sincronizar.' }[s.state] || '');
    el.onclick = async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'sync') syncAll();
      if (a === 'out' && await confirmBox('Sair da conta? Os dados saem deste aparelho e continuam salvos na nuvem.', { ok: 'Sair' })) { await C.signOut(); toast('Você saiu da conta.'); draw(); }
    };
    off?.();
    off = onSyncStatus((s) => { const l = $('#sync-line'); if (l) l.textContent = syncText(s); });
    draw();
    return () => { off?.(); off = null; };
  },
};
