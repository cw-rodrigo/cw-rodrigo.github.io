// Expõe as ferramentas do Estúdio para agentes de IA que rodam no navegador:
// - WebMCP (navigator.modelContext / document.modelContext), o padrão proposto pelo W3C e testado no Chrome;
// - window.estudio.tools, para extensões, automações (Playwright) e o console.
import { TOOLS, listTools, callTool, onConfirm, onActivity } from './tools.js';
import { confirmBox, toast } from '/lib/core/ui.js';

const log = [];
export const activityLog = () => log;

let registered = 0, ctrl = null;
/** Registra as ferramentas no WebMCP do navegador, se ele existir. Devolve quantas foram registradas. */
export function registerWebMCP() {
  const mc = globalThis.document?.modelContext ?? globalThis.navigator?.modelContext;
  if (!mc?.registerTool) return 0;
  ctrl?.abort();
  ctrl = new AbortController();
  registered = 0;
  for (const t of TOOLS) {
    const tool = {
      name: t.name, title: t.title, description: t.description, inputSchema: t.input,
      annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive },
      async execute(args) {
        // ações destrutivas já são confirmadas pelo navegador no WebMCP; aqui pedimos de novo na página
        const r = await callTool(t.name, args || {}, { via: 'webmcp' });
        return r.ok ? JSON.stringify(r.result) : `Erro: ${r.error}`;
      },
    };
    try { mc.registerTool(tool, { signal: ctrl.signal }); registered++; } catch { /* versão antiga da API */ }
  }
  return registered;
}
export const webmcpStatus = () => ({ available: !!(globalThis.document?.modelContext ?? globalThis.navigator?.modelContext)?.registerTool, registered });

export function installAgentApi() {
  onConfirm((t, args) => confirmBox(`Um agente de IA quer: ${t.title}. Detalhes: ${JSON.stringify(args)}`, { ok: 'Permitir', danger: true, title: 'Agente de IA' }));
  let last = 0;
  onActivity((a) => {
    log.unshift(a); log.length = Math.min(log.length, 50);
    window.dispatchEvent(new CustomEvent('estudio:agent', { detail: a }));
    if (a.at - last > 4000) toast(`Agente de IA: ${a.title}`, 'secondary');
    last = a.at;
  });
  window.estudio = Object.freeze({
    version: 1,
    tools: Object.freeze({
      /** Lista as ferramentas (nome, descrição, esquema JSON dos argumentos). */
      list: () => listTools(),
      /** Chama uma ferramenta: estudio.tools.call('cifras_listar', { busca: 'Djavan' }). */
      async call(name, args = {}) { const r = await callTool(name, args, { via: 'api' }); if (!r.ok) throw new Error(r.error); return r.result; },
    }),
  });
  registerWebMCP();
}
