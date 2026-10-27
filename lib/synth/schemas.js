// Parâmetros de cada motor de síntese: usados pela interface (controles) e pelo áudio (valores padrão).
// Tipos: range (min/max/step), select (options), toggle, text (sequências), harmonics (barras).

const r = (id, label, min, max, def, step = 0.01, unit = '', extra = {}) => ({ id, label, type: 'range', min, max, def, step, unit, ...extra });
const sel = (id, label, options, def = 0) => ({ id, label, type: 'select', options, def });
const tog = (id, label, def = false) => ({ id, label, type: 'toggle', def });
const adsr = (p, label, a = 0.005, d = 0.25, s = 0.7, rel = 0.3) => ({
  name: label,
  params: [r(p + 'A', 'Ataque', 0.001, 4, a, 0.001, 's', { curve: 'log' }), r(p + 'D', 'Queda', 0.005, 6, d, 0.001, 's', { curve: 'log' }),
    r(p + 'S', 'Sustentação', 0, 1, s), r(p + 'R', 'Soltura', 0.005, 8, rel, 0.001, 's', { curve: 'log' })],
});
const WAVE4 = ['Serra', 'Quadrada', 'Triângulo', 'Seno'];
const LFO_SHAPES = ['Seno', 'Triângulo', 'Quadrada', 'Serra', 'Aleatório'];
const filterGroup = (def = 8000) => ({
  name: 'Filtro',
  params: [sel('fType', 'Tipo', ['Passa-baixa', 'Passa-alta', 'Passa-banda', 'Rejeita-faixa']), r('cutoff', 'Corte', 20, 20000, def, 1, 'Hz', { curve: 'log' }),
    r('res', 'Ressonância', 0, 0.98, 0.15), r('fEnv', 'Envelope do filtro', -6, 6, 0, 0.05, 'oit'), r('keyTrack', 'Seguir o teclado', 0, 1, 0.3)],
});

export const COMMON = {
  name: 'Geral',
  params: [r('vol', 'Volume', -36, 6, -8, 0.5, 'dB'), r('voices', 'Vozes', 1, 16, 8, 1), tog('mono', 'Monofônico'), r('glide', 'Glide', 0, 1, 0, 0.005, 's'),
    r('bendRange', 'Pitch bend', 0, 12, 2, 1, 'st'), r('velSens', 'Sensibilidade à força', 0, 1, 0.6)],
};

export const ENGINES = {
  subtractive: {
    name: 'Subtrativo', icon: 'bi-funnel', desc: 'Osciladores ricos passando por um filtro com envelope: o clássico dos sintetizadores analógicos (leads, baixos, pads).',
    groups: [
      { name: 'Oscilador 1', params: [sel('o1Wave', 'Onda', WAVE4), r('o1Pw', 'Largura de pulso', 0.05, 0.95, 0.5), r('o1Oct', 'Oitava', -2, 2, 0, 1), r('o1Lvl', 'Nível', 0, 1, 0.8)] },
      { name: 'Oscilador 2', params: [sel('o2Wave', 'Onda', WAVE4, 1), r('o2Pw', 'Largura de pulso', 0.05, 0.95, 0.35), r('o2Oct', 'Oitava', -2, 2, 0, 1), r('o2Semi', 'Semitons', -12, 12, 0, 1), r('o2Fine', 'Afinação fina', -50, 50, 7, 1, 'cents'), r('o2Lvl', 'Nível', 0, 1, 0.5)] },
      { name: 'Uníssono e extras', params: [r('uni', 'Vozes em uníssono', 1, 7, 1, 1), r('uniDetune', 'Desafinação', 0, 1, 0.2), r('uniSpread', 'Abertura estéreo', 0, 1, 0.6), r('sub', 'Sub-oscilador', 0, 1, 0), r('noise', 'Ruído', 0, 1, 0)] },
      filterGroup(5000),
      { ...adsr('fe', 'Envelope do filtro', 0.005, 0.3, 0.3, 0.3) },
      { ...adsr('ae', 'Envelope de volume', 0.005, 0.3, 0.8, 0.25) },
      { name: 'LFO', params: [sel('lfoShape', 'Forma', LFO_SHAPES), r('lfoRate', 'Velocidade', 0.05, 20, 5, 0.01, 'Hz', { curve: 'log' }), sel('lfoDest', 'Destino', ['Afinação', 'Filtro', 'Volume', 'Largura de pulso']), r('lfoDepth', 'Quantidade', 0, 1, 0)] },
    ],
  },
  additive: {
    name: 'Aditivo', icon: 'bi-bar-chart-steps', desc: 'O som é montado somando senos (harmônicos), cada um com volume próprio e que somem em velocidades diferentes, como no órgão e em timbres de sino.',
    groups: [
      { name: 'Harmônicos', params: [{ id: 'harm', label: 'Volume de cada harmônico', type: 'harmonics', count: 32, def: Array.from({ length: 32 }, (_, i) => +(1 / (i + 1)).toFixed(3)) }] },
      { name: 'Espectro', params: [r('partials', 'Quantidade de harmônicos', 1, 32, 32, 1), r('tilt', 'Brilho', -12, 12, 0, 0.5, 'dB/oit'), r('oddEven', 'Ímpares × pares', -1, 1, 0), r('stretch', 'Inarmonicidade', 0, 0.03, 0, 0.0005), r('decayTilt', 'Agudos somem mais rápido', 0, 1, 0.3)] },
      { ...adsr('ae', 'Envelope de volume', 0.01, 0.6, 0.6, 0.5) },
      { name: 'Vibrato', params: [r('vibRate', 'Velocidade', 0.1, 12, 5.5, 0.1, 'Hz'), r('vibDepth', 'Profundidade', 0, 50, 0, 1, 'cents')] },
    ],
  },
  fm: {
    name: 'FM', icon: 'bi-diagram-3', desc: 'Síntese por modulação de frequência com 4 operadores, como nos teclados DX e chips de videogame: pianos elétricos, sinos, baixos metálicos.',
    groups: [
      { name: 'Algoritmo', params: [sel('algo', 'Algoritmo', ['1: 4→3→2→1', '2: (3+4)→2→1', '3: 4→1 e 3→2→1', '4: 4→3→1 e 2→1', '5: 4→3 e 2→1', '6: 4→(1, 2, 3)', '7: 4→3, com 1 e 2', '8: os 4 em paralelo']), r('feedback', 'Realimentação do op. 4', 0, 1, 0.2)] },
      ...[1, 2, 3, 4].map((n) => ({
        name: `Operador ${n}${n === 1 ? ' (portadora)' : ''}`,
        params: [r(`op${n}Ratio`, 'Proporção', 0.5, 16, [1, 2, 1, 14][n - 1], 0.5), r(`op${n}Det`, 'Desafinação', -50, 50, [0, 3, -3, 0][n - 1], 1, 'cents'), r(`op${n}Lvl`, 'Nível', 0, 1, [0.9, 0.5, 0.4, 0.2][n - 1]),
          r(`op${n}A`, 'Ataque', 0.001, 4, 0.002, 0.001, 's', { curve: 'log' }), r(`op${n}D`, 'Queda', 0.005, 6, [1.5, 0.8, 1.2, 0.3][n - 1], 0.001, 's', { curve: 'log' }), r(`op${n}S`, 'Sustentação', 0, 1, [0.4, 0.2, 0.3, 0][n - 1]), r(`op${n}R`, 'Soltura', 0.005, 8, 0.4, 0.001, 's', { curve: 'log' })],
      })),
    ],
  },
  am: {
    name: 'AM e ring', icon: 'bi-broadcast', desc: 'Um oscilador controla o volume de outro: tremolos, sons metálicos e de sino (modo ring) e timbres de rádio.',
    groups: [
      { name: 'Osciladores', params: [sel('carWave', 'Onda da portadora', WAVE4, 0), sel('modWave', 'Onda da moduladora', WAVE4, 3), r('modRatio', 'Proporção da moduladora', 0.25, 16, 2, 0.25), r('modFine', 'Ajuste fino', -100, 100, 0, 1, 'cents'), r('depth', 'Profundidade', 0, 1, 0.7), sel('amMode', 'Modo', ['AM (soma)', 'Ring (multiplica)'])] },
      { ...adsr('me', 'Envelope da modulação', 0.005, 0.5, 0.6, 0.4) },
      filterGroup(9000),
      { ...adsr('ae', 'Envelope de volume', 0.005, 0.4, 0.7, 0.3) },
    ],
  },
  wavetable: {
    name: 'Wavetable', icon: 'bi-water', desc: 'Toca uma sequência de formas de onda e passeia entre elas, criando timbres que mudam com o tempo.',
    groups: [
      { name: 'Tabela', params: [sel('table', 'Tabela', ['Básica (seno → serra → quadrada)', 'PWM', 'Vozes (formantes)', 'Digital (sinos)', 'Harmônicos crescentes', 'Órgão']), r('pos', 'Posição', 0, 1, 0.3), r('posEnv', 'Envelope da posição', -1, 1, 0.3), r('posLfo', 'LFO na posição', 0, 1, 0), r('posLfoRate', 'Velocidade do LFO', 0.05, 10, 0.5, 0.01, 'Hz', { curve: 'log' })] },
      { ...adsr('pe', 'Envelope da posição', 0.01, 1.5, 0.2, 0.8) },
      { name: 'Uníssono', params: [r('uni', 'Vozes em uníssono', 1, 7, 3, 1), r('uniDetune', 'Desafinação', 0, 1, 0.15), r('uniSpread', 'Abertura estéreo', 0, 1, 0.7)] },
      filterGroup(12000),
      { ...adsr('fe', 'Envelope do filtro', 0.005, 0.4, 0.4, 0.4) },
      { ...adsr('ae', 'Envelope de volume', 0.01, 0.5, 0.8, 0.5) },
    ],
  },
  pd: {
    name: 'Phase distortion', icon: 'bi-activity', desc: 'Distorção de fase como nos Casio CZ: um seno deformado vira serra, quadrada ou ressonância, controlado por um envelope (DCW).',
    groups: [
      { name: 'Forma', params: [sel('pdWave', 'Forma', ['Serra', 'Quadrada', 'Pulso', 'Seno duplo', 'Serra-pulso', 'Ressonante 1 (serra)', 'Ressonante 2 (triângulo)', 'Ressonante 3 (trapézio)']), r('dcw', 'DCW (brilho)', 0, 1, 0.6), r('dcwKey', 'DCW segue o teclado', -1, 1, -0.3)] },
      { ...adsr('de', 'Envelope do DCW', 0.005, 0.8, 0.3, 0.5) },
      { name: 'Segunda linha', params: [sel('pd2Wave', 'Forma', ['Desligada', 'Serra', 'Quadrada', 'Pulso', 'Seno duplo', 'Serra-pulso', 'Ressonante 1', 'Ressonante 2', 'Ressonante 3']), r('pd2Fine', 'Desafinação', -50, 50, 8, 1, 'cents'), r('pd2Oct', 'Oitava', -1, 2, 0, 1), r('pd2Lvl', 'Nível', 0, 1, 0.5)] },
      { ...adsr('ae', 'Envelope de volume', 0.005, 0.6, 0.6, 0.4) },
    ],
  },
  formant: {
    name: 'Formante (voz)', icon: 'bi-chat-quote', desc: 'Uma fonte como a das cordas vocais passa por ressonâncias de vogais: coros, "aahs" e vozes robóticas.',
    groups: [
      { name: 'Voz', params: [r('vowel', 'Vogal (a, e, i, o, u)', 0, 4, 0, 0.01), sel('voiceType', 'Tipo de voz', ['Baixo', 'Tenor', 'Contralto', 'Soprano']), r('breath', 'Sopro', 0, 1, 0.1), r('bright', 'Brilho da fonte', 0, 1, 0.5), r('vowelLfo', 'Movimento da vogal', 0, 1, 0), r('vowelRate', 'Velocidade do movimento', 0.05, 5, 0.3, 0.01, 'Hz')] },
      { name: 'Vibrato', params: [r('vibRate', 'Velocidade', 0.1, 10, 5.2, 0.1, 'Hz'), r('vibDepth', 'Profundidade', 0, 80, 18, 1, 'cents'), r('vibDelay', 'Atraso do vibrato', 0, 2, 0.4, 0.01, 's')] },
      { ...adsr('ae', 'Envelope de volume', 0.08, 0.3, 0.9, 0.5) },
    ],
  },
  granular: {
    name: 'Granular', icon: 'bi-grid-3x3-gap', desc: 'Fatia um áudio em grãos minúsculos e os espalha: texturas, nuvens e sons congelados.',
    groups: [
      { name: 'Fonte', params: [sel('src', 'Áudio de origem', ['Amostra carregada', 'Coro gerado', 'Sino gerado', 'Ruído rosa', 'Cordas geradas']), r('pos', 'Posição', 0, 1, 0.3), r('scan', 'Velocidade de leitura', -1, 1, 0.05), tog('freeze', 'Congelar')] },
      { name: 'Grãos', params: [r('size', 'Tamanho', 0.01, 0.5, 0.09, 0.001, 's', { curve: 'log' }), r('density', 'Densidade', 1, 120, 30, 1, 'grãos/s', { curve: 'log' }), r('jitter', 'Variação da posição', 0, 1, 0.1), r('pitchJitter', 'Variação da afinação', 0, 1, 0.05), r('spread', 'Abertura estéreo', 0, 1, 0.7), r('root', 'Nota original da amostra', 24, 96, 60, 1)] },
      { ...adsr('ae', 'Envelope de volume', 0.2, 0.5, 0.9, 1.2) },
    ],
  },
  physical: {
    name: 'Modelagem física', icon: 'bi-music-note', desc: 'Simula o objeto que vibra: corda dedilhada, marimba, sino, flauta e tambor. Responde à força com que você toca.',
    groups: [
      { name: 'Modelo', params: [sel('model', 'Instrumento', ['Corda dedilhada', 'Marimba', 'Sino', 'Vibrafone', 'Flauta', 'Tambor (membrana)']), r('decay', 'Duração', 0.05, 1, 0.6), r('bright', 'Brilho', 0, 1, 0.6), r('position', 'Ponto de ataque', 0.02, 0.5, 0.2), r('hardness', 'Dureza (baqueta/palheta)', 0, 1, 0.5), r('body', 'Caixa de ressonância', 0, 1, 0.3)] },
      { name: 'Sopro (flauta)', params: [r('breath', 'Pressão', 0.3, 1.2, 0.8), r('noise', 'Ruído do sopro', 0, 0.5, 0.1), r('vibDepth', 'Vibrato', 0, 0.1, 0.02, 0.001)] },
      { name: 'Soltar a nota', params: [r('damp', 'Abafar ao soltar', 0, 1, 0.7)] },
    ],
  },
  sampler: {
    name: 'Sampler / rompler', icon: 'bi-vinyl', desc: 'Toca gravações: instrumentos prontos (General MIDI) ou uma amostra sua, gravada ou de arquivo — até a sua Pocket Master.',
    groups: [
      { name: 'Amostra', params: [r('root', 'Nota original (amostra sua)', 24, 96, 60, 1), r('tune', 'Afinação fina', -100, 100, 0, 1, 'cents'), r('start', 'Início', 0, 0.9, 0), tog('loop', 'Repetir (loop)'), r('loopStart', 'Início do loop', 0, 0.99, 0.3), r('loopEnd', 'Fim do loop', 0.01, 1, 0.9), tog('reverse', 'Ao contrário')] },
      filterGroup(20000),
      { ...adsr('fe', 'Envelope do filtro', 0.005, 0.3, 0.5, 0.3) },
      { ...adsr('ae', 'Envelope de volume', 0.002, 0.3, 1, 0.3) },
    ],
  },
  drums: {
    name: 'Bateria sintetizada', icon: 'bi-record-circle', desc: 'Bateria eletrônica no estilo 808/909, toda sintetizada. Usa o mapa General MIDI: C2 bumbo, D2 caixa, F#2 chimbal…',
    groups: [
      { name: 'Bumbo', params: [r('kTune', 'Afinação', 30, 90, 50, 1, 'Hz'), r('kDecay', 'Duração', 0.05, 1.5, 0.45, 0.01, 's'), r('kPunch', 'Ataque', 0, 1, 0.5), r('kDrive', 'Saturação', 0, 1, 0.2)] },
      { name: 'Caixa e palmas', params: [r('sTune', 'Afinação da caixa', 120, 400, 190, 1, 'Hz'), r('sSnap', 'Esteira', 0, 1, 0.6), r('sDecay', 'Duração', 0.05, 0.8, 0.22, 0.01, 's'), r('cDecay', 'Duração das palmas', 0.05, 0.8, 0.25, 0.01, 's')] },
      { name: 'Pratos e chimbal', params: [r('hTone', 'Brilho', 0, 1, 0.6), r('hDecay', 'Chimbal fechado', 0.01, 0.3, 0.05, 0.005, 's'), r('ohDecay', 'Chimbal aberto', 0.1, 1.5, 0.45, 0.01, 's'), r('cyDecay', 'Pratos', 0.3, 4, 1.6, 0.01, 's')] },
      { name: 'Tons e outros', params: [r('tTune', 'Afinação dos tons', 0.5, 2, 1, 0.01, '×'), r('tDecay', 'Duração dos tons', 0.05, 1, 0.35, 0.01, 's')] },
    ],
  },
  nes: {
    name: 'NES (2A03)', icon: 'bi-controller', desc: 'Emulação do chip de som do Nintendinho (2A03) com instrumentos no estilo do FamiTracker: sequências de volume, arpejo, afinação e duty.',
    groups: [
      { name: 'Canal', params: [sel('chan', 'Canal', ['Pulso', 'Triângulo', 'Ruído', 'APU completa (2 pulsos + triângulo)']), sel('duty', 'Duty do pulso', ['12,5%', '25%', '50%', '75%'], 2), r('chVol', 'Volume do canal (0–15)', 0, 15, 15, 1), sel('noiseMode', 'Modo do ruído', ['Longo (chiado)', 'Curto (metálico)']), sel('region', 'Região', ['NTSC (60 Hz)', 'PAL (50 Hz)'])] },
      { name: 'Sequências do instrumento', params: [
        { id: 'seqVol', label: 'Volume (0 a 15)', type: 'text', def: '15 14 12 10 9 8 | 8 / 6 4 2 0', hint: '| marca o loop, / marca o que toca ao soltar a nota' },
        { id: 'seqArp', label: 'Arpejo (semitons)', type: 'text', def: '', hint: 'ex.: 0 4 7 | 0 4 7 (acorde maior)' },
        { id: 'seqPitch', label: 'Afinação (passos relativos)', type: 'text', def: '', hint: 'ex.: 0 0 1 1 0 0 -1 -1 |' },
        { id: 'seqDuty', label: 'Duty (0 a 3)', type: 'text', def: '', hint: 'ex.: 2 2 1 | 0' },
      ] },
      { name: 'Efeitos', params: [r('vibSpeed', 'Vibrato: velocidade (4xy)', 0, 15, 0, 1), r('vibDepthN', 'Vibrato: profundidade', 0, 15, 0, 1), tog('nesFilter', 'Filtros do aparelho original', true)] },
    ],
  },
};

/** Valores padrão de um motor (incluindo os gerais). */
export function defaults(engine) {
  const out = {};
  for (const g of [COMMON, ...(ENGINES[engine]?.groups || [])]) for (const p of g.params) out[p.id] = Array.isArray(p.def) ? [...p.def] : p.def;
  if (engine === 'drums' || engine === 'nes') { out.voices = engine === 'drums' ? 16 : 1; }
  return out;
}
export const ENGINE_IDS = Object.keys(ENGINES);
