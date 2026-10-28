#!/usr/bin/env node
// Servidor MCP do Estúdio (https://cw-rodrigo.github.io), sem dependências: só precisa do Node 18+.
//
// O agente (Claude Code, Claude Desktop, Cursor…) conversa MCP com este processo pelo stdin/stdout;
// o site, aberto no navegador, conecta neste processo por um WebSocket em 127.0.0.1 e executa as
// ferramentas com os seus dados (cifras, timbres, projetos da DAW, a pedaleira conectada).
//
// Uso:   node estudio-mcp.mjs [--port 8787]
// Depois abra o site, vá em Agentes de IA e ligue "Conectar ao servidor MCP local".
//
// Exemplos de configuração:
//   Claude Code:     claude mcp add estudio -- node /caminho/estudio-mcp.mjs
//   Claude Desktop:  { "mcpServers": { "estudio": { "command": "node", "args": ["/caminho/estudio-mcp.mjs"] } } }
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE = 'https://cw-rodrigo.github.io';
const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.ESTUDIO_MCP_PORT) || 8787;
const EXTRA_ORIGINS = (process.env.ESTUDIO_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const CALL_TIMEOUT = 180000; // ações destrutivas esperam a pessoa confirmar na página
const CACHE = path.join(os.homedir(), '.cache', 'estudio-mcp', 'tools.json');
const log = (...a) => console.error('[estudio-mcp]', ...a);

// ---------------------------------------------------------------- lista de ferramentas
let tools = [];
async function loadTools() {
  // 1) rodando de dentro do repositório do site: usa a lista do código
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const local = path.join(here, '..', 'lib', 'agent', 'tools.js');
    if (fs.existsSync(local)) { tools = (await import(pathToFileURL(local).href)).listTools(); return 'código local'; }
  } catch (e) { log('não consegui ler a lista local:', e.message); }
  // 2) a última lista que o site mandou
  try { tools = JSON.parse(fs.readFileSync(CACHE, 'utf8')); if (tools.length) return 'cache'; } catch { /* sem cache */ }
  // 3) a lista publicada no site
  try { const r = await fetch(`${SITE}/mcp/tools.json`); if (r.ok) { tools = await r.json(); return 'site'; } } catch { /* sem internet */ }
  tools = [];
  return 'nenhuma';
}
function saveCache(list) {
  try { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(list)); } catch { /* ok */ }
}
const STATUS_TOOL = {
  name: 'estudio_status', title: 'Conexão com o Estúdio',
  description: 'Diz se o site do Estúdio está aberto e conectado a este servidor. Se não estiver, explica como conectar.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

// ---------------------------------------------------------------- WebSocket mínimo (RFC 6455)
function allowedOrigin(o) {
  if (!o) return false;
  if (o === SITE || EXTRA_ORIGINS.includes(o)) return true;
  try { const u = new URL(o); return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'); } catch { return false; }
}
function frame(text) {
  const data = Buffer.from(text);
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, data]);
}
class Peer {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.parts = []; this.info = null;
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    socket.on('close', () => this.onclose?.());
    socket.on('error', () => socket.destroy());
  }
  send(obj) { if (!this.socket.destroyed) this.socket.write(frame(JSON.stringify(obj))); }
  close() { try { this.socket.end(Buffer.from([0x88, 0])); } catch { /* ok */ } }
  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 15, masked = b[1] & 0x80;
      let len = b[1] & 127, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 32 * 1024 * 1024) { this.socket.destroy(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const mk = b.subarray(off, off + 4); payload = Buffer.from(payload.map((x, i) => x ^ mk[i & 3])); }
      this.buf = b.subarray(need);
      if (op === 8) { this.close(); this.socket.destroy(); return; }
      if (op === 9) { this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 0) {
        this.parts.push(payload);
        if (fin) { const text = Buffer.concat(this.parts).toString('utf8'); this.parts = []; try { this.onmessage?.(JSON.parse(text)); } catch { /* mensagem inválida */ } }
      }
    }
  }
}

// ---------------------------------------------------------------- páginas conectadas
const pages = [];
const pending = new Map();
let nextId = 1;
const page = () => pages[pages.length - 1] || null;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Servidor MCP do Estúdio. Abra ' + SITE + '/#/agentes e ligue a conexão local.\n');
});
server.on('upgrade', (req, socket) => {
  const origin = req.headers.origin;
  if (new URL(req.url, 'http://x').pathname !== '/estudio' || !allowedOrigin(origin) || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    log('conexão recusada de', origin || '(sem origem)');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const peer = new Peer(socket);
  peer.onmessage = (msg) => {
    if (msg.type === 'hello') {
      peer.info = msg;
      if (pages.includes(peer)) pages.splice(pages.indexOf(peer), 1);
      pages.push(peer); // a aba conectada por último é a que recebe as chamadas
      log('site conectado:', msg.page);
      if (Array.isArray(msg.tools) && msg.tools.length && JSON.stringify(msg.tools) !== JSON.stringify(tools)) {
        tools = msg.tools; saveCache(tools);
        notify('notifications/tools/list_changed');
      }
    } else if (msg.type === 'result') {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); }
    }
  };
  peer.onclose = () => {
    const i = pages.indexOf(peer);
    if (i >= 0) { pages.splice(i, 1); log('site desconectado'); }
    for (const [id, p] of pending) if (p.peer === peer) { pending.delete(id); clearTimeout(p.timer); p.resolve({ ok: false, error: 'A página do Estúdio foi fechada ou recarregada durante a chamada.' }); }
  };
  const ping = setInterval(() => { if (socket.destroyed) clearInterval(ping); else socket.write(Buffer.from([0x89, 0])); }, 25000);
});
let listenError = null;
server.on('error', (e) => { listenError = e.code === 'EADDRINUSE' ? `A porta ${PORT} já está em uso (outro servidor do Estúdio aberto?). Use --port ou ESTUDIO_MCP_PORT.` : e.message; log(listenError); });
server.listen(PORT, '127.0.0.1', () => log(`esperando o site em ws://127.0.0.1:${PORT}/estudio`));

function callPage(name, args) {
  const pg = page();
  if (!pg) return Promise.resolve(null);
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'O site não respondeu a tempo (talvez esperando a pessoa confirmar).' }); }, CALL_TIMEOUT);
    pending.set(id, { resolve, timer, peer: pg });
    pg.send({ type: 'call', id, name, args });
  });
}
const howTo = () => (listenError ? listenError + ' ' : '') + `O site do Estúdio não está conectado. Peça para a pessoa abrir ${SITE}/#/agentes no Chrome ou Edge e ligar "Conectar ao servidor MCP local" (porta ${PORT}). A página precisa ficar aberta.`;

// ---------------------------------------------------------------- MCP (JSON-RPC pelo stdio)
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const notify = (method, params) => out({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // notificação
  const reply = (result) => out({ jsonrpc: '2.0', id, result });
  const error = (code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'estudio', title: 'Estúdio (cw-rodrigo.github.io)', version: '1.0.0' },
        instructions: 'Ferramentas do Estúdio: cifras e repertórios, timbres para a pedaleira Pocket Master, projetos da DAW e o sintetizador. Os dados ficam no navegador da pessoa; o site precisa estar aberto e conectado (veja estudio_status). Ids vêm das ferramentas de listar. Tempos da DAW são em semínimas.',
      });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: [STATUS_TOOL, ...tools] });
    case 'tools/call': {
      const name = params.name, args = params.arguments || {};
      if (name === 'estudio_status') {
        const pg = page();
        return reply(text(pg ? JSON.stringify({ conectado: true, pagina: pg.info?.page, abas: pages.length, ferramentas: tools.length }) : howTo()));
      }
      if (!tools.some((t) => t.name === name)) return reply(text(`Ferramenta desconhecida: ${name}`, true));
      const r = await callPage(name, args);
      if (!r) return reply(text(howTo(), true));
      return reply(r.ok ? text(JSON.stringify(r.result, null, 1)) : text(`Erro: ${r.error}`, true));
    }
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default: return error(-32601, `Método não suportado: ${method}`);
  }
}

const source = await loadTools();
log(`${tools.length} ferramentas (${source})`);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }); return; }
  for (const m of Array.isArray(msg) ? msg : [msg]) handle(m).catch((e) => out({ jsonrpc: '2.0', id: m.id ?? null, error: { code: -32603, message: e.message } }));
});
rl.on('close', () => { server.close(); process.exit(0); });
