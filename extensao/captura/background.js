// Captura de elemento: o clique no ícone (ou Alt+Shift+S) liga o seletor na aba; a foto é tirada pelo
// mesmo comando que o DevTools usa ("Capturar screenshot do nó"): pega o elemento inteiro, mesmo a parte
// fora da tela, na resolução da tela. Sem o depurador (negado ou outra ferramenta usando), cai para a
// captura da parte visível da aba.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['picker.js', 'content.js'] });
  } catch (e) {
    // páginas do próprio navegador (chrome://, loja de extensões) não aceitam scripts
    chrome.action.setBadgeText({ tabId: tab.id, text: '×' });
    chrome.action.setTitle({ tabId: tab.id, title: 'Esta página não permite captura por extensões.' });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'estudio-capture' || !sender.tab) return;
  capture(sender.tab, msg.rect).then(reply, (e) => reply({ error: e.message || String(e) }));
  return true; // resposta assíncrona
});

async function capture(tab, r) {
  const target = { tabId: tab.id };
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
  } catch (e) {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { dataUrl, visibleOnly: true, note: 'Captura só da parte visível (o modo completo precisa do depurador: ' + (e.message || e) + ').' };
  }
  try {
    const res = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, fromSurface: true,
      clip: { x: r.x, y: r.y, width: Math.max(1, r.width), height: Math.max(1, r.height), scale: 1 },
    });
    return { dataUrl: 'data:image/png;base64,' + res.data };
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}
