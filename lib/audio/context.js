// Um AudioContext para o site todo (sintetizador, DAW). Criado na primeira interação do usuário.
let ctx = null;
export function audioCtx() {
  if (!ctx || ctx.state === 'closed') {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
/** Retoma o áudio (navegadores só deixam depois de um toque/clique). */
export async function resumeAudio() { const c = audioCtx(); if (c.state !== 'running') await c.resume().catch(() => {}); return c; }
