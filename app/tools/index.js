// Lista de ferramentas.
const TOOLS = [
  ['tom', 'bi-mic', 'Descobrir o tom', 'Pelo microfone (toque ou cante) ou analisando um vídeo do YouTube ou arquivo de áudio.'],
  ['acordes', 'bi-file-earmark-music', 'Acordes de um áudio', 'Gera um rascunho de cifra com acordes e letra (banco LRCLIB ou IA) a partir de um vídeo, arquivo ou do microfone. Dá para levar direto para o Cifras.'],
  ['separar', 'bi-layers', 'Separar faixas', 'Separa voz, bateria, baixo e harmonia com IA (HTDemucs), no seu aparelho. Ouça com mixer, solo/mudo, e baixe cada faixa em WAV.'],
  ['comparar', 'bi-graph-up', 'Comparar áudios', 'Compara dois áudios (vídeo, arquivo ou gravação): curva de frequências, distorção, compressão, reverb e andamento.'],
  ['#/agentes', 'bi-robot', 'Agentes de IA (MCP)', 'Deixe assistentes como Claude, ChatGPT ou Cursor gerenciarem suas cifras, repertórios, timbres e projetos da DAW pelo protocolo MCP.'],
  ['pedaleira', 'bi-usb-symbol', 'Pocket Master', 'Conecta a Sonicake Pocket Master pelo USB ou Bluetooth: troca de preset, edição de todos os blocos, salvar, importar/exportar e cópias de segurança.'],
];
export default {
  title: 'Ferramentas',
  render(el) {
    el.innerHTML = `<h1 class="h2">Ferramentas</h1>
      <p class="text-body-secondary">Cada recurso do Cifras e do Timbres também pode ser usado sozinho. Tudo roda no seu navegador.</p>
      <div class="list-group">${TOOLS.map(([id, icon, t, d]) => `<a class="list-group-item list-group-item-action d-flex gap-3 py-3" href="${id.startsWith('#') ? id : '#/ferramentas/' + id}">
        <i class="bi ${icon} fs-4 text-primary"></i><div><strong>${t}</strong><div class="small text-body-secondary">${d}</div></div></a>`).join('')}</div>`;
  },
};
