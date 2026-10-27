// Conta (usuário e senha) e dados na nuvem pelo Supabase, usando direto as APIs REST
// (Auth e PostgREST), sem biblioteca extra.
import { SUPABASE } from './cloud-config.js';

const SESSION_KEY = 'conta.v1';
const DOMAIN = 'usuarios.cw-rodrigo.github.io'; // o Supabase pede um e-mail; o usuário vira <nome>@DOMAIN
const listeners = new Set();
let session = null;
try { session = JSON.parse(globalThis.localStorage?.getItem(SESSION_KEY) || 'null'); } catch { session = null; }

export function configured() {
  const c = globalThis.__cloudConfig || SUPABASE;
  return !!(c.url && c.anonKey);
}
const cfg = () => globalThis.__cloudConfig || SUPABASE;
export function user() { return session?.user || null; }
export function onAuth(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function setSession(s) {
  session = s;
  try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch { /* ok */ }
  listeners.forEach((fn) => fn(user()));
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
export function normalizeUsername(u) { return String(u || '').trim().toLowerCase(); }

function friendly(status, body) {
  const code = body?.error_code || body?.code || body?.error || '';
  const msg = String(body?.msg || body?.message || body?.error_description || '');
  if (/invalid_credentials|invalid_grant/.test(code) || /invalid login/i.test(msg)) return 'Usuário ou senha incorretos.';
  if (/user_already_exists|email_exists/.test(code) || /already registered/i.test(msg)) return 'Esse nome de usuário já está em uso.';
  if (/weak_password/.test(code) || /password should be/i.test(msg)) return 'Senha fraca: use pelo menos 6 caracteres.';
  if (/email_not_confirmed/.test(code)) return 'A confirmação de e-mail está ligada no Supabase. Desligue em Authentication → Sign In / Providers → Email → "Confirm email".';
  if (/signup_disabled/.test(code)) return 'Novos cadastros estão desativados no Supabase.';
  if (status === 429) return 'Muitas tentativas. Espere um pouco e tente de novo.';
  return msg || `Erro ${status} ao falar com o servidor.`;
}

async function call(path, { method = 'GET', body = null, auth = false, headers = {} } = {}) {
  if (!configured()) throw new Error('O login ainda não foi configurado neste site.');
  const h = { apikey: cfg().anonKey, 'Content-Type': 'application/json', ...headers };
  if (auth) h.Authorization = `Bearer ${await accessToken()}`;
  let r;
  try {
    r = await fetch(cfg().url.replace(/\/$/, '') + path, { method, headers: h, body: body ? JSON.stringify(body) : null });
  } catch {
    throw Object.assign(new Error('Sem conexão com o servidor.'), { offline: true });
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw Object.assign(new Error(friendly(r.status, data)), { status: r.status });
  return data;
}

function fromAuth(d, username) {
  if (!d?.access_token) return null;
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
    user: { id: d.user?.id, username: d.user?.user_metadata?.username || username },
  };
}

let refreshing = null;
async function accessToken() {
  if (!session) throw Object.assign(new Error('Entre na sua conta.'), { status: 401 });
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  refreshing ||= (async () => {
    try {
      const d = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } });
      setSession(fromAuth(d, session.user.username));
    } catch (err) {
      if (err.status === 400 || err.status === 401) setSession(null); // sessão expirada de vez
      throw err;
    } finally { refreshing = null; }
  })();
  await refreshing;
  return session.access_token;
}

export async function signUp(username, password) {
  const u = normalizeUsername(username);
  if (!USERNAME_RE.test(u)) throw new Error('Use de 3 a 30 letras minúsculas, números, ponto, hífen ou sublinhado, começando por letra ou número.');
  if (String(password).length < 6) throw new Error('Senha fraca: use pelo menos 6 caracteres.');
  const d = await call('/auth/v1/signup', { method: 'POST', body: { email: `${u}@${DOMAIN}`, password, data: { username: u } } });
  const s = fromAuth(d, u);
  if (!s) throw new Error(friendly(400, { error_code: 'email_not_confirmed' }));
  setSession(s);
  return s.user;
}

export async function signIn(username, password) {
  const u = normalizeUsername(username);
  const d = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: `${u}@${DOMAIN}`, password } });
  setSession(fromAuth(d, u));
  return user();
}

export async function signOut() {
  try { if (session) await call('/auth/v1/logout', { method: 'POST', auth: true }); } catch { /* sai mesmo assim */ }
  setSession(null);
}

export async function changePassword(password) {
  if (String(password).length < 6) throw new Error('Senha fraca: use pelo menos 6 caracteres.');
  await call('/auth/v1/user', { method: 'PUT', auth: true, body: { password } });
}

// ---------------------------------------------------------------- dados
/** Lê o documento de um app: { data, updated_at } ou null. */
export async function pull(app) {
  const rows = await call(`/rest/v1/user_data?app=eq.${encodeURIComponent(app)}&select=data,updated_at`, { auth: true });
  return rows?.[0] || null;
}

/** Grava o documento de um app. Retorna o updated_at gravado. */
export async function push(app, data) {
  const updated_at = new Date().toISOString();
  await call('/rest/v1/user_data?on_conflict=user_id,app', {
    method: 'POST', auth: true,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: { user_id: session.user.id, app, data, updated_at },
  });
  return updated_at;
}
