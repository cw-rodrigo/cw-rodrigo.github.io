// Agentes de IA: como um assistente (Claude, ChatGPT, Gemini, Cursor…) pode usar o Estúdio.
import { listTools } from '/lib/agent/tools.js';
import { webmcpStatus, activityLog } from '/lib/agent/webmcp.js';
import { onBridge, setBridge, DEFAULT_PORT } from '/lib/agent/bridge.js';
import { $, esc, toast } from '/lib/core/ui.js';

const GROUPS = [['site_', 'Site'], ['audio_', 'Ouvir e gravar'], ['cifras_', 'Cifras'], ['letras_', 'Cifras'], ['listas_', 'Repertórios'], ['timbres_', 'Timbres'], ['pedaleira_', 'Pedaleira'], ['daw_', 'DAW'], ['sintetizador_', 'Sintetizador']];
const groupOf = (n) => GROUPS.find(([p]) => n.startsWith(p))?.[1] || 'Outros';
const STATE = { off: ['Desligada', 'secondary'], connecting: ['Conectando…', 'info'], waiting: ['Esperando o servidor…', 'warning'], connected: ['Conectada', 'success'], error: ['Erro', 'danger'] };
const SERVER_URL = '/mcp/estudio-mcp.mjs';

export default {
  title: 'Agentes de IA',
  render(el) {
    const tools = listTools();
    const groups = new Map();
    for (const t of tools) { const g = groupOf(t.name); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); }
    const wm = webmcpStatus();
    el.innerHTML = `
      <h1 class="h2 mb-1"><i class="bi bi-robot"></i> Agentes de IA</h1>
      <p class="text-body-secondary">Assistentes de IA podem usar o Estúdio por você: criar e transpor cifras, montar repertórios, criar timbres e mandar para a Pocket Master, escrever padrões e arranjos na DAW. São ${tools.length} ferramentas no padrão <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener">MCP</a>, que funcionam com os seus dados deste navegador. Ações que apagam ou gravam por cima sempre pedem a sua confirmação aqui.</p>

      <section class="card mb-3"><div class="card-body">
        <h2 class="h5"><i class="bi bi-terminal"></i> Claude Code, Claude Desktop, Cursor e outros (servidor MCP local)</h2>
        <ol class="small mb-3">
          <li>Baixe o <a href="${SERVER_URL}" download="estudio-mcp.mjs">servidor <code>estudio-mcp.mjs</code></a> (um arquivo, sem dependências; precisa do <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js</a> 18 ou mais novo).</li>
          <li>Cadastre no seu agente. Claude Code: <code class="user-select-all">claude mcp add estudio -- node ~/Downloads/estudio-mcp.mjs</code><br>
            Claude Desktop, Cursor e similares (arquivo de configuração MCP): <code class="user-select-all">{"mcpServers":{"estudio":{"command":"node","args":["/caminho/estudio-mcp.mjs"]}}}</code></li>
          <li>Ligue a conexão abaixo e deixe esta aba aberta. O navegador pode pedir permissão para acessar a rede local: permita.</li>
        </ol>
        <div class="d-flex flex-wrap align-items-center gap-3">
          <div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" role="switch" id="ag-bridge"><label class="form-check-label" for="ag-bridge">Conectar ao servidor MCP local</label></div>
          <label class="d-flex align-items-center gap-1 small">Porta <input class="form-control form-control-sm" id="ag-port" type="number" min="1024" max="65535" style="width:6rem"></label>
          <span class="badge" id="ag-state"></span>
        </div>
        <p class="small text-body-secondary mt-2 mb-0">A conexão é só com o seu computador (127.0.0.1); o servidor aceita apenas este site.</p>
      </div></section>

      <section class="card mb-3"><div class="card-body">
        <h2 class="h5"><i class="bi bi-browser-chrome"></i> Agentes dentro do navegador (WebMCP)</h2>
        <p class="small mb-2">O Estúdio também registra as ferramentas no <a href="https://developer.chrome.com/docs/ai/webmcp/imperative-api" target="_blank" rel="noopener">WebMCP</a> (<code>navigator.modelContext</code>), o padrão em teste no Chrome para assistentes e extensões usarem sites diretamente, sem servidor.
          ${wm.available ? `<span class="badge text-bg-success">Ativo: ${wm.registered} ferramentas registradas</span>` : '<span class="badge text-bg-secondary">Este navegador ainda não tem WebMCP</span>'}</p>
        <p class="small text-body-secondary mb-0">Para testar no Chrome, ative <code>chrome://flags/#enable-webmcp-testing</code>. Scripts e automações (Playwright, console) também podem usar <code>await estudio.tools.call('cifras_listar', {})</code>; a lista está em <code>estudio.tools.list()</code> e em <a href="/mcp/tools.json" target="_blank">/mcp/tools.json</a>.</p>
      </div></section>

      <section class="card mb-3"><div class="card-body">
        <h2 class="h5">Atividade recente</h2>
        <div id="ag-log" class="small"></div>
      </div></section>

      <h2 class="h5">Ferramentas</h2>
      ${[...groups].map(([g, list]) => `<h3 class="h6 mt-3">${esc(g)}</h3><div class="list-group mb-2">${list.map((t) => `
        <details class="list-group-item small"><summary><code>${esc(t.name)}</code> — ${esc(t.title)}${t.annotations.destructiveHint ? ' <span class="badge text-bg-warning">pede confirmação</span>' : t.annotations.readOnlyHint ? ' <span class="badge text-bg-light border">só leitura</span>' : ''}</summary>
          <p class="mt-2 mb-1">${esc(t.description)}</p>
          ${Object.keys(t.inputSchema.properties || {}).length ? `<ul class="mb-0">${Object.entries(t.inputSchema.properties).map(([k, s]) => `<li><code>${esc(k)}</code>${(t.inputSchema.required || []).includes(k) ? ' <strong>(obrigatório)</strong>' : ''}: ${esc(s.description || '')}</li>`).join('')}</ul>` : ''}
        </details>`).join('')}</div>`).join('')}`;

    const port = $('#ag-port'), sw = $('#ag-bridge'), badge = $('#ag-state');
    const off = onBridge((s) => {
      sw.checked = s.on; port.value = s.port || DEFAULT_PORT;
      const [label, kind] = STATE[s.state] || STATE.off;
      badge.className = `badge text-bg-${kind}`; badge.textContent = label;
      badge.title = s.error || '';
    });
    sw.onchange = () => { setBridge({ on: sw.checked, port: Number(port.value) || DEFAULT_PORT }); if (sw.checked) toast('Procurando o servidor MCP local…'); };
    port.onchange = () => setBridge({ port: Number(port.value) || DEFAULT_PORT });
    const renderLog = () => {
      const box = $('#ag-log');
      if (!box) return;
      const l = activityLog();
      box.innerHTML = l.length ? `<ul class="list-unstyled mb-0">${l.slice(0, 15).map((a) => `<li><span class="text-body-secondary">${new Date(a.at).toLocaleTimeString('pt-BR')}</span> ${esc(a.title)} <span class="badge text-bg-light border">${esc(a.via)}</span></li>`).join('')}</ul>` : '<span class="text-body-secondary">Nenhuma ação de agente nesta sessão.</span>';
    };
    renderLog();
    window.addEventListener('estudio:agent', renderLog);
    return () => { off(); window.removeEventListener('estudio:agent', renderLog); };
  },
};
