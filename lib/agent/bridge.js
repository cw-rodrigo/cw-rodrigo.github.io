// Ponte com o servidor MCP local (mcp/estudio-mcp.mjs): agentes como Claude Code, Claude Desktop ou
// Cursor falam MCP com o servidor, e o servidor repassa as chamadas para esta página por um WebSocket
// em 127.0.0.1. Só conecta quando a pessoa liga a opção na página Agentes de IA.
import { listTools, callTool } from './tools.js';

const KEY = 'agent.bridge';
export const DEFAULT_PORT = 8787;
const listeners = new Set();
let ws = null, timer = null, wait = 1000, state = 'off', lastError = '';

export function bridgeConfig() {
  try { return { on: false, port: DEFAULT_PORT, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { on: false, port: DEFAULT_PORT }; }
}
function setConfig(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* sem armazenamento */ } }
export const bridgeState = () => ({ state, error: lastError, ...bridgeConfig() });
export function onBridge(fn) { listeners.add(fn); fn(bridgeState()); return () => listeners.delete(fn); }
function set(s, err = '') { state = s; lastError = err; listeners.forEach((fn) => fn(bridgeState())); }

function connect() {
  clearTimeout(timer);
  const { on, port } = bridgeConfig();
  if (!on) { set('off'); return; }
  set('connecting');
  let sock;
  try { sock = new WebSocket(`ws://127.0.0.1:${port}/estudio`); } catch (e) { set('error', e.message); retry(); return; }
  ws = sock;
  sock.onopen = () => {
    wait = 1000;
    sock.send(JSON.stringify({ type: 'hello', app: 'estudio', version: 1, page: location.href, tools: listTools() }));
    set('connected');
  };
  sock.onmessage = async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'call') {
      const r = await callTool(msg.name, msg.args || {}, { via: 'mcp' });
      if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'result', id: msg.id, ...r }));
    } else if (msg.type === 'ping') sock.send(JSON.stringify({ type: 'pong' }));
  };
  sock.onclose = () => { if (ws === sock) { ws = null; if (bridgeConfig().on) { set('waiting', 'Servidor MCP local não encontrado.'); retry(); } else set('off'); } };
  sock.onerror = () => {};
}
function retry() { clearTimeout(timer); timer = setTimeout(connect, wait); wait = Math.min(wait * 2, 30000); }

/** Liga/desliga a ponte (fica lembrado neste navegador). */
export function setBridge({ on, port }) {
  const c = { ...bridgeConfig(), ...(on != null ? { on } : {}), ...(port ? { port } : {}) };
  setConfig(c);
  wait = 1000;
  if (ws) { const s = ws; ws = null; s.close(); }
  connect();
}
export function startBridge() { if (bridgeConfig().on) connect(); }
