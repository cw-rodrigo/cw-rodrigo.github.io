// Ferramenta: captura de um elemento de qualquer site, no estilo do Inspecionar do DevTools.
// Duas formas: um favorito (bookmarklet) que usa o compartilhamento da aba, e uma extensão para Chrome/Edge
// que tira a foto pelo mesmo comando do DevTools (o elemento inteiro, mesmo fora da tela).
import { $, toast } from '/lib/core/ui.js';

const SRC = '/extensao/captura/picker.js';
const ZIP = '/extensao/captura.zip';

/** Carrega o seletor nesta página (ele também gera o código dos favoritos). */
function loadPicker() {
  if (window.__estudioBookmarklet) return Promise.resolve();
  return new Promise((ok, no) => { const s = document.createElement('script'); s.src = SRC; s.onload = ok; s.onerror = no; document.head.append(s); });
}

export default {
  title: 'Captura de elemento',
  async render(el) {
    el.innerHTML = `
      <h1 class="h2 mb-1"><i class="bi bi-bounding-box-circles"></i> Captura de elemento</h1>
      <p class="text-body-secondary">Tire um print de só uma parte de qualquer site, como no <em>Inspecionar</em> do DevTools: passe o mouse para destacar um elemento (div, imagem, tabela, botão…) e clique para capturar só ele. <kbd>↑</kbd> sobe para o elemento pai, <kbd>↓</kbd> volta, <kbd>Enter</kbd> captura, <kbd>Esc</kbd> sai. Dá para pôr uma margem em volta, baixar o PNG ou copiar.</p>
      <div class="row g-3">
        <div class="col-lg-6"><section class="card h-100"><div class="card-body">
          <h2 class="h5"><i class="bi bi-bookmark-star"></i> Favorito (sem instalar nada)</h2>
          <p class="small">Arraste o botão abaixo para a barra de favoritos. Em qualquer site, clique nele, escolha o elemento e permita o compartilhamento quando o navegador perguntar.</p>
          <p><a class="btn btn-primary" id="cap-bm" href="#" draggable="true" title="Arraste para a barra de favoritos"><i class="bi bi-bounding-box-circles"></i> Capturar elemento</a></p>
          <p class="small"><strong>★ Lembrar um elemento:</strong> depois de capturar, a janela da prévia oferece um botão amarelo com o nome que você quiser. Arraste ele também para a barra de favoritos: na próxima vez, um clique nele já captura aquele mesmo elemento (e pode baixar ou copiar direto), sem precisar escolher.</p>
          <p class="small"><strong>Capturas guardadas:</strong> as últimas capturas (10, ou o número que você escolher) ficam guardadas. Marque <em>Só guardar</em> na barra para ir capturando vários elementos em sequência e, no fim, abra <em>Capturas</em> para escolher quais baixar (soltas ou num .zip), copiar para a área de transferência ou apagar. Todas vêm marcadas: se não desmarcar nenhuma, vão todas. Na cópia de várias, dá para deixar o destino escolher (separadas onde ele aceita, juntas onde não) ou forçar <em>sempre numa imagem só</em> (uma embaixo da outra, lado a lado ou em grade) ou <em>sempre separadas</em>; também dá para baixar todas numa imagem só. No favorito, elas ficam guardadas por site; na extensão, juntas, de todos os sites.</p>
          <ul class="small text-body-secondary mb-3">
            <li>Chrome e Edge: escolha compartilhar <strong>“Esta aba”</strong>. Firefox (que não compartilha só a aba): escolha a <strong>janela do Firefox</strong> ou a tela; a página é localizada na imagem por dois quadradinhos que piscam nos cantos por um instante.</li>
            <li>O navegador pergunta se pode compartilhar na primeira captura; depois o compartilhamento fica ligado (aparece “● compartilhando” na barra) e as próximas capturas não perguntam até você clicar em <em>Sair</em>. Os navegadores não deixam guardar essa permissão de uma vez para sempre; a extensão não pergunta nunca.</li>
            <li>Pega só o que está visível na tela; para elementos maiores que a tela, use a extensão.</li>
            <li>Não aparece a barra de favoritos? <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>.</li>
          </ul>
          <button class="btn btn-sm btn-outline-secondary" type="button" id="cap-try"><i class="bi bi-cursor"></i> Experimentar nesta página</button>
          <button class="btn btn-sm btn-outline-secondary" type="button" id="cap-copy"><i class="bi bi-clipboard"></i> Copiar o código do favorito</button>
        </div></section></div>
        <div class="col-lg-6"><section class="card h-100"><div class="card-body">
          <h2 class="h5"><i class="bi bi-puzzle"></i> Extensão para Chrome e Edge (melhor qualidade)</h2>
          <p class="small">Captura o elemento <strong>inteiro</strong>, mesmo a parte fora da tela, na resolução da tela e sem perguntar a cada vez, usando o mesmo comando do “Capturar screenshot do nó” do DevTools.</p>
          <ol class="small">
            <li><a href="${ZIP}" download>Baixe a extensão (.zip)</a> e descompacte numa pasta.</li>
            <li>Abra <code class="user-select-all">chrome://extensions</code> (ou <code class="user-select-all">edge://extensions</code>) e ligue o <strong>Modo do desenvolvedor</strong>.</li>
            <li>Clique em <strong>Carregar sem compactação</strong> e escolha a pasta.</li>
            <li>Em qualquer site, clique no ícone da extensão (fixe ele na barra) ou aperte <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>.</li>
          </ol>
          <p class="small text-body-secondary mb-0">Durante a foto o navegador mostra por um instante o aviso “começou a depurar este navegador”: é o comando de captura do DevTools, e ele é desligado logo em seguida. A extensão não lê nem envia nada dos sites; o código está em <a href="https://github.com/cw-rodrigo/cw-rodrigo.github.io/tree/main/extensao/captura" target="_blank" rel="noopener">extensao/captura</a>.</p>
        </div></section></div>
      </div>`;
    let code = '';
    try { await loadPicker(); code = window.__estudioBookmarklet(); } catch { toast('Não consegui carregar o código do favorito. Verifique a conexão.', 'danger'); }
    const bm = $('#cap-bm');
    if (code) bm.href = code;
    bm.onclick = (e) => { e.preventDefault(); toast('Arraste este botão para a barra de favoritos. Para testar aqui, use “Experimentar nesta página”.'); };
    $('#cap-try').onclick = () => {
      window.__estudioPicker?.({ capture: window.__estudioCaptureDisplay, mode: 'favorito' });
    };
    $('#cap-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(code); toast('Código copiado: crie um favorito e cole no endereço (URL).', 'success'); } catch { toast('Não consegui copiar.', 'danger'); }
    };
  },
};
