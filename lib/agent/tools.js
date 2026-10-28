// Ferramentas para agentes de IA: o mesmo conjunto serve ao WebMCP do navegador (navigator.modelContext),
// à API window.estudio e à ponte local com o servidor MCP (mcp/estudio-mcp.mjs).
// Cada ferramenta: { name, title, description, input (JSON Schema), readOnly?, destructive?, run(args) -> objeto }.
// Os módulos de cada seção só são carregados quando a ferramenta é usada.
import { getLive } from './live.js';

const cifras = () => import('/app/cifras/store.js');
const theory = () => import('/lib/music/theory.js');
const timbres = () => import('/app/timbres/store.js');
const toneLib = () => import('/app/timbres/tone.js');
const pmSession = () => import('/lib/pocketmaster/session.js');
const pmLib = () => import('/lib/pocketmaster/pm.js');
const daw = () => import('/app/daw/project.js');

// ---------------------------------------------------------------- utilidades
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const fail = (msg) => { throw new Error(msg); };
const now = () => Date.now();
const r1 = (v) => Math.round(v * 10) / 10;
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Nota: número MIDI (60 = Dó central) ou nome como "C4", "F#3", "Bb2". */
const NOTE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function parseNote(n) {
  if (typeof n === 'number' && Number.isFinite(n)) return Math.max(0, Math.min(127, Math.round(n)));
  const m = /^\s*([A-Ga-g])([#b♯♭]?)(-?\d)\s*$/.exec(String(n));
  if (!m) fail(`Nota inválida: "${n}". Use um número MIDI (60 = C4) ou um nome como C4, F#3, Bb2.`);
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0;
  return Math.max(0, Math.min(127, (Number(m[3]) + 1) * 12 + NOTE_PC[m[1].toUpperCase()] + acc));
}

/** Confere os argumentos contra o esquema (o suficiente para dar erros claros ao agente). */
export function validate(schema, args) {
  const a = args == null ? {} : args;
  if (typeof a !== 'object' || Array.isArray(a)) return 'Os argumentos precisam ser um objeto.';
  for (const k of schema.required || []) if (a[k] == null || a[k] === '') return `Falta o campo obrigatório "${k}".`;
  for (const [k, v] of Object.entries(a)) {
    const s = schema.properties?.[k];
    if (!s) { if (schema.additionalProperties === false) return `Campo desconhecido "${k}". Campos aceitos: ${Object.keys(schema.properties || {}).join(', ') || 'nenhum'}.`; continue; }
    if (v == null) continue;
    const types = [].concat(s.type || []);
    const ok = !types.length || types.some((t) => (t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'array' ? Array.isArray(v) : t === 'object' ? typeof v === 'object' && !Array.isArray(v) : typeof v === t));
    if (!ok) return `O campo "${k}" precisa ser do tipo ${types.join(' ou ')}.`;
    if (s.enum && !s.enum.includes(v)) return `O campo "${k}" aceita: ${s.enum.join(', ')}.`;
    if (typeof v === 'number' && ((s.minimum != null && v < s.minimum) || (s.maximum != null && v > s.maximum))) return `O campo "${k}" vai de ${s.minimum ?? '-∞'} a ${s.maximum ?? '∞'}.`;
  }
  return null;
}

// ---------------------------------------------------------------- cifras
const songBrief = (s, M) => ({ id: s.id, titulo: s.title, artista: s.artist || '', tom: M.normalizeKey(s.key) || '', bpm: s.bpm || null, youtube: s.ytId || null });
async function songOrFail(id) {
  const C = await cifras();
  return C.getSong(id) || fail(`Não existe cifra com id "${id}". Use cifras_listar.`);
}
async function toChordPro(text) {
  const M = await theory();
  return M.looksLikeChordsOverLyrics(text) ? M.chordsOverLyricsToChordPro(text) : text;
}
async function listBrief(l) {
  const C = await cifras(), M = await theory();
  const items = C.itemsOf(l);
  return {
    id: l.id, nome: l.name, rascunho: !!C.db.drafts[l.id],
    musicas: items.map((x) => { const s = C.getSong(x.songId); return s ? { id: s.id, titulo: s.title, artista: s.artist || '', tomOriginal: M.normalizeKey(s.key) || '', semitons: x.shift || 0, tomNaLista: C.keyLabel(s, x.shift || 0) } : null; }).filter(Boolean),
  };
}
async function listOrFail(id) {
  const C = await cifras();
  return C.getList(id) || fail(`Não existe lista com id "${id}". Use listas_listar.`);
}
async function semisTo(song, target, M) {
  const from = M.normalizeKey(song.key) || M.guessKey(song.content || '');
  if (!from) fail('Não sei o tom original desta cifra; informe "semitons" em vez de "tom".');
  const to = M.normalizeKey(target) || fail(`Tom inválido: "${target}". Exemplos: C, Am, F#, Bbm.`);
  const C = await cifras();
  return C.wrap(M.semitonesBetween(from, to));
}

const CIFRAS = [
  {
    name: 'cifras_listar', title: 'Listar cifras', readOnly: true,
    description: 'Lista as cifras (músicas) salvas no Estúdio, com id, título, artista, tom e BPM. Filtre com "busca" (título ou artista).',
    input: obj({ busca: str('Texto para filtrar por título ou artista (opcional).'), limite: int('Máximo de resultados (padrão 100).', { minimum: 1, maximum: 1000 }) }),
    async run({ busca, limite = 100 }) {
      const C = await cifras(), M = await theory();
      const q = norm(busca);
      const all = Object.values(C.db.songs).filter((s) => !q || norm(`${s.title} ${s.artist}`).includes(q)).sort((a, b) => a.title.localeCompare(b.title, 'pt'));
      return { total: all.length, musicas: all.slice(0, limite).map((s) => songBrief(s, M)) };
    },
  },
  {
    name: 'cifras_ler', title: 'Ler cifra', readOnly: true,
    description: 'Lê uma cifra completa no formato ChordPro (acordes entre colchetes antes da sílaba, ex.: "[G]Letra [D/F#]aqui"). Pode devolver já transposta com "tom" ou "semitons".',
    input: obj({ id: str('Id da cifra.'), tom: str('Tom desejado (ex.: "D", "Bm"). Opcional.'), semitons: int('Transposição em semitons (-11 a 11). Opcional.', { minimum: -11, maximum: 11 }), formato: str('"chordpro" (padrão) ou "texto" (acordes sobre a letra).', { enum: ['chordpro', 'texto'] }) }, ['id']),
    async run({ id, tom, semitons, formato = 'chordpro' }) {
      const C = await cifras(), M = await theory();
      const s = await songOrFail(id);
      const shift = tom ? await semisTo(s, tom, M) : semitons || 0;
      const content = shift ? C.transposedContent(s, shift) : s.content || '';
      return { ...songBrief(s, M), tomExibido: C.keyLabel(s, shift), semitons: shift, conteudo: formato === 'texto' ? M.chordProToText(content) : content, melodia: s.melody || '' };
    },
  },
  {
    name: 'cifras_criar', title: 'Criar cifra',
    description: 'Cria uma cifra nova. "conteudo" pode ser ChordPro ([C]letra) ou o formato de acordes sobre a letra (é convertido). Sem "tom", o tom é estimado pelos acordes. Opcionalmente já coloca a música numa lista.',
    input: obj({
      titulo: str('Título da música.'), artista: str('Artista.'), conteudo: str('Cifra em ChordPro ou acordes sobre a letra.'),
      tom: str('Tom original (ex.: "G", "Em").'), bpm: int('Andamento.', { minimum: 20, maximum: 300 }),
      youtube: str('Id ou link do vídeo do YouTube (opcional).'), lista: str('Id de uma lista para adicionar a música (opcional).'),
    }, ['titulo']),
    async run({ titulo, artista = '', conteudo = '', tom, bpm, youtube, lista }) {
      const C = await cifras(), M = await theory();
      const content = await toChordPro(conteudo);
      const key = (tom && (M.normalizeKey(tom) || fail(`Tom inválido: "${tom}".`))) || M.guessKey(content) || '';
      const ytId = youtube ? (/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/.exec(youtube)?.[1] || (/^[\w-]{11}$/.test(youtube) ? youtube : fail('Link do YouTube inválido.'))) : '';
      const l = lista ? await listOrFail(lista) : null;
      const s = C.newSong({ title: titulo, artist: artista, content, key, ytId, ...(bpm ? { bpm } : {}) });
      if (l) { C.itemsOf(l).push({ songId: s.id, shift: 0 }); if (!C.db.drafts[l.id]) C.touch(l); }
      C.S.notify();
      return { criada: songBrief(s, M), lista: l ? l.id : null, abrir: `#/cifras/cifra/${s.id}` };
    },
  },
  {
    name: 'cifras_editar', title: 'Editar cifra',
    description: 'Altera campos de uma cifra existente. Só os campos informados mudam. "conteudo" substitui a cifra inteira (ChordPro ou acordes sobre a letra).',
    input: obj({ id: str('Id da cifra.'), titulo: str('Novo título.'), artista: str('Novo artista.'), conteudo: str('Cifra inteira nova.'), tom: str('Tom original.'), bpm: int('Andamento.', { minimum: 20, maximum: 300 }), melodia: str('Melodia no formato de notas do Estúdio (opcional).') }, ['id']),
    async run({ id, titulo, artista, conteudo, tom, bpm, melodia }) {
      const C = await cifras(), M = await theory();
      const s = await songOrFail(id);
      if (titulo != null) s.title = titulo;
      if (artista != null) s.artist = artista;
      if (conteudo != null) s.content = await toChordPro(conteudo);
      if (tom != null) s.key = M.normalizeKey(tom) || fail(`Tom inválido: "${tom}".`);
      if (bpm != null) s.bpm = bpm;
      if (melodia != null) s.melody = melodia;
      s.updatedAt = now();
      C.S.notify();
      return { editada: songBrief(s, M) };
    },
  },
  {
    name: 'cifras_transpor', title: 'Mudar o tom da cifra',
    description: 'Reescreve a cifra salva em outro tom (muda os acordes e o tom original). Para só ver transposta sem salvar, use cifras_ler com "tom".',
    input: obj({ id: str('Id da cifra.'), tom: str('Tom de destino (ex.: "A").'), semitons: int('Ou a transposição em semitons.', { minimum: -11, maximum: 11 }) }, ['id']),
    async run({ id, tom, semitons }) {
      const C = await cifras(), M = await theory();
      const s = await songOrFail(id);
      const shift = tom ? await semisTo(s, tom, M) : semitons || fail('Informe "tom" ou "semitons".');
      const key = C.shiftedKey(s, shift);
      s.content = C.transposedContent(s, shift);
      if (key) s.key = key;
      s.updatedAt = now();
      C.S.notify();
      return { id: s.id, tom: s.key, semitons: shift };
    },
  },
  {
    name: 'cifras_apagar', title: 'Apagar cifra', destructive: true,
    description: 'Apaga uma cifra (e a tira de todas as listas). Não dá para desfazer.',
    input: obj({ id: str('Id da cifra.') }, ['id']),
    async run({ id }) {
      const C = await cifras();
      const s = await songOrFail(id);
      C.deleteSong(id);
      C.S.notify();
      return { apagada: s.title };
    },
  },
  {
    name: 'cifras_detectar_tom', title: 'Descobrir o tom pelos acordes', readOnly: true,
    description: 'Estima o tom de uma cifra (pelo id ou por um texto com acordes).',
    input: obj({ id: str('Id de uma cifra salva.'), conteudo: str('Ou o texto da cifra.') }),
    async run({ id, conteudo }) {
      const M = await theory();
      const text = id ? (await songOrFail(id)).content : await toChordPro(conteudo || fail('Informe "id" ou "conteudo".'));
      return { tom: M.guessKey(text || '') || null };
    },
  },
  {
    name: 'letras_buscar', title: 'Buscar letra', readOnly: true,
    description: 'Procura a letra de uma música no LRCLIB (base aberta de letras). Útil para montar uma cifra nova.',
    input: obj({ titulo: str('Título.'), artista: str('Artista.') }, ['titulo']),
    async run({ titulo, artista = '' }) {
      const { findLyrics } = await import('/lib/music/lyrics.js');
      const r = await findLyrics({ title: titulo, artist: artista });
      if (!r) return { encontrada: false };
      return { encontrada: true, titulo: r.track || titulo, artista: r.artist || artista, letra: r.plain || (r.lines || []).map((l) => l.text).join('\n') };
    },
  },
  {
    name: 'listas_listar', title: 'Listar repertórios', readOnly: true,
    description: 'Lista os repertórios (listas de músicas), com o número de músicas de cada um.',
    input: obj({}),
    async run() {
      const C = await cifras();
      return { listas: C.db.lists.map((l) => ({ id: l.id, nome: l.name, musicas: C.itemsOf(l).length, rascunho: !!C.db.drafts[l.id] })) };
    },
  },
  {
    name: 'listas_ler', title: 'Ler repertório', readOnly: true,
    description: 'Mostra as músicas de uma lista, na ordem, com o tom em que cada uma é tocada nela.',
    input: obj({ id: str('Id da lista.') }, ['id']),
    async run({ id }) { return listBrief(await listOrFail(id)); },
  },
  {
    name: 'listas_criar', title: 'Criar repertório',
    description: 'Cria uma lista de músicas. "musicas" é a lista de ids de cifras, na ordem.',
    input: obj({ nome: str('Nome da lista.'), musicas: { type: 'array', items: { type: 'string' }, description: 'Ids das cifras, na ordem (opcional).' } }, ['nome']),
    async run({ nome, musicas = [] }) {
      const C = await cifras();
      for (const id of musicas) await songOrFail(id);
      const l = C.newList(nome);
      l.items = musicas.map((songId) => ({ songId, shift: 0 }));
      C.S.notify();
      return { ...(await listBrief(l)), abrir: `#/cifras/lista/${l.id}` };
    },
  },
  {
    name: 'listas_editar', title: 'Editar repertório',
    description: 'Muda uma lista: renomear, adicionar ou remover músicas, reordenar (passando todos os ids na nova ordem) e definir o tom de cada música na lista (por tom ou semitons). Se a lista estiver em edição em lote na tela, as mudanças vão para o rascunho.',
    input: obj({
      id: str('Id da lista.'), nome: str('Novo nome.'),
      adicionar: { type: 'array', items: { type: 'string' }, description: 'Ids de cifras para pôr no fim.' },
      remover: { type: 'array', items: { type: 'string' }, description: 'Ids de cifras para tirar.' },
      ordem: { type: 'array', items: { type: 'string' }, description: 'Todos os ids da lista na nova ordem.' },
      tons: { type: 'object', description: 'Tom de cada música nesta lista: { "<id da cifra>": "D" } ou { "<id>": -2 } (semitons).', additionalProperties: { type: ['string', 'integer'] } },
    }, ['id']),
    async run({ id, nome, adicionar = [], remover = [], ordem, tons = {} }) {
      const C = await cifras(), M = await theory();
      const l = await listOrFail(id);
      const draft = C.db.drafts[l.id];
      let items = C.itemsOf(l);
      if (nome) l.name = nome;
      for (const sid of adicionar) { await songOrFail(sid); if (!items.some((x) => x.songId === sid)) items.push({ songId: sid, shift: 0 }); }
      if (remover.length) items = items.filter((x) => !remover.includes(x.songId));
      if (ordem) {
        const by = new Map(items.map((x) => [x.songId, x]));
        if (ordem.length !== items.length || ordem.some((sid) => !by.has(sid))) fail('"ordem" precisa ter exatamente os ids das músicas da lista.');
        items = ordem.map((sid) => by.get(sid));
      }
      for (const [sid, v] of Object.entries(tons)) {
        const it = items.find((x) => x.songId === sid) || fail(`A música "${sid}" não está na lista.`);
        it.shift = typeof v === 'number' ? C.wrap(v) : await semisTo(C.getSong(sid), v, M);
      }
      if (draft) draft.items = items; else { l.items = items; C.touch(l); }
      C.S.notify();
      return listBrief(l);
    },
  },
  {
    name: 'listas_apagar', title: 'Apagar repertório', destructive: true,
    description: 'Apaga uma lista (as cifras continuam salvas).',
    input: obj({ id: str('Id da lista.') }, ['id']),
    async run({ id }) {
      const C = await cifras();
      const l = await listOrFail(id);
      C.db.lists = C.db.lists.filter((x) => x !== l);
      delete C.db.drafts[l.id];
      C.db.deleted[l.id] = now();
      C.S.notify();
      return { apagada: l.name };
    },
  },
];

// ---------------------------------------------------------------- timbres
const MACRO_PROPS = {
  instrumento: str('"guitar" (guitarra) ou "bass" (baixo).', { enum: ['guitar', 'bass'] }),
  ganho: int('Distorção de 0 (limpo) a 100 (alto ganho). Faixas: <22 limpo, <42 quase saturando, <62 crunch, <80 distorcido.', { minimum: 0, maximum: 100 }),
  graves: num('Graves em dB em relação ao normal (-12 a 12).', { minimum: -12, maximum: 12 }),
  medios: num('Médios em dB (-12 a 12).', { minimum: -12, maximum: 12 }),
  agudos: num('Agudos em dB (-12 a 12).', { minimum: -12, maximum: 12 }),
  presenca: num('Presença (brilho de 4,5 a 8 kHz) em dB (-12 a 12).', { minimum: -12, maximum: 12 }),
  reverb: int('Quantidade de reverb (0 a 100).', { minimum: 0, maximum: 100 }),
  tipoReverb: str('Tipo de reverb.', { enum: ['auto', 'Room', 'Spring', 'Plate 1', 'Hall', 'Church', 'Air', 'Dream'] }),
  duracaoReverb: num('Duração do reverb em segundos (0,2 a 6).', { minimum: 0.2, maximum: 6 }),
  delay: str('Delay: off, slap (curto), tempo (colcheia pontuada), quarter (semínima), long (longo).', { enum: ['off', 'slap', 'tempo', 'quarter', 'long'] }),
  mixDelay: int('Volume do delay (0 a 100).', { minimum: 0, maximum: 100 }),
  bpm: int('Andamento (para o delay no tempo).', { minimum: 30, maximum: 300 }),
  modulacao: str('Modulação.', { enum: ['off', 'chorus', 'phaser', 'flanger', 'tremolo', 'vibe', 'vibrato', 'octave'] }),
  compressor: bool('Liga o compressor.'),
};
const MACRO_KEYS = { instrumento: 'instrument', ganho: 'gain', graves: 'bass', medios: 'mid', agudos: 'treble', presenca: 'presence', reverb: 'reverb', tipoReverb: 'reverbType', duracaoReverb: 'rt', delay: 'delay', mixDelay: 'delayMix', bpm: 'bpm', modulacao: 'mod', compressor: 'comp' };
const BASE_MACROS = { instrument: 'guitar', gain: 15, bass: 0, mid: 0, treble: 0, presence: 0, reverb: 20, reverbType: 'auto', rt: 1, delay: 'off', delayMix: 20, bpm: 100, mod: 'off', comp: false };
const macrosOut = (m) => Object.fromEntries(Object.entries(MACRO_KEYS).map(([pt, en]) => [pt, m[en]]));

/** Curva de frequências coerente com os ajustes (para o gráfico da seção e o ajuste fino). */
async function curveFor(m) {
  const T = await toneLib(), { BANDS } = await import('/lib/audio/tone.js');
  const ref = T.referenceCurve(m.instrument);
  return ref.map((v, i) => { const f = BANDS[i]; return v + (f < 250 ? m.bass : f < 1200 ? m.mid : f < 4500 ? m.treble : m.presence); });
}
async function toneFromMacros(m, base = {}) {
  const T = await toneLib(), PM = await pmSession();
  const curve = await curveFor(m);
  const macros = { ...m, dev: T.deviation(curve, m.instrument) };
  const overrides = base.overrides || { blocks: {} };
  const spec = T.withOverrides(T.buildSpec(macros, await PM.map()), overrides);
  return {
    app: 'timbres', version: 1, name: base.name || 'Timbre', song: base.song || null,
    instrument: m.instrument, macros, overrides,
    features: { curve, gain: m.gain / 100, reverb: { rt: m.rt, amount: m.reverb / 100 }, bpm: m.bpm, compression: m.comp ? 0.6 : 0.2, separated: true },
    ...spec,
  };
}
async function toneBrief(t, full = false) {
  const T = await toneLib();
  const out = { id: t.id, nome: t.name, instrumento: t.instrument, descricao: T.describe(t.macros), musica: t.song?.title || null };
  if (full) {
    out.ajustes = macrosOut(t.macros);
    out.preset = { cadeia: t.chain, volume: t.preset_volume, blocos: t.blocks };
  }
  return out;
}
async function toneOrFail(id) {
  const Tm = await timbres();
  return Tm.getTone(id) || fail(`Não existe timbre com id "${id}". Use timbres_listar.`);
}
const toMacros = (args, base) => { const m = { ...base }; for (const [pt, en] of Object.entries(MACRO_KEYS)) if (args[pt] != null) m[en] = args[pt]; return m; };
async function pedal() {
  const PM = await pmSession();
  return PM.device() || fail('A Pocket Master não está conectada. Peça para a pessoa conectar em Ferramentas → Pedaleira (o navegador exige um clique dela para USB ou Bluetooth).');
}

const TIMBRES = [
  {
    name: 'timbres_listar', title: 'Listar timbres', readOnly: true,
    description: 'Lista os timbres de guitarra/baixo guardados (presets para a pedaleira Pocket Master).',
    input: obj({}),
    async run() { const Tm = await timbres(); return { timbres: await Promise.all(Tm.db.tones.map((t) => toneBrief(t))) }; },
  },
  {
    name: 'timbres_ler', title: 'Ler timbre', readOnly: true,
    description: 'Mostra um timbre: os ajustes de músico (ganho, graves, reverb…) e o preset completo da pedaleira (blocos, modelos e parâmetros).',
    input: obj({ id: str('Id do timbre.') }, ['id']),
    async run({ id }) { return toneBrief(await toneOrFail(id), true); },
  },
  {
    name: 'timbres_criar', title: 'Criar timbre',
    description: 'Cria um timbre a partir de ajustes de músico; o Estúdio escolhe amplificador, caixa, EQ e efeitos da Pocket Master. Campos não informados usam um som limpo neutro.',
    input: obj({ nome: str('Nome do timbre.'), musica: str('Música de referência (opcional).'), ...MACRO_PROPS }, ['nome']),
    async run(args) {
      const Tm = await timbres();
      const m = toMacros(args, { ...BASE_MACROS, ...(args.instrumento === 'bass' ? { reverb: 0 } : {}) });
      const rec = { id: 't' + now().toString(36) + Math.random().toString(36).slice(2, 5), date: now(), updatedAt: now(), ...(await toneFromMacros(m, { name: args.nome, song: args.musica ? { title: args.musica } : null })) };
      Tm.db.tones.unshift(rec);
      Tm.S.notify();
      return { criado: await toneBrief(rec, true), abrir: `#/timbres?abrir=${rec.id}` };
    },
  },
  {
    name: 'timbres_editar', title: 'Editar timbre',
    description: 'Muda ajustes de um timbre (só os informados) e/ou parâmetros de blocos do preset. "blocos" ex.: { "amp": { "params": { "Gain": 60 } }, "dly": { "on": true, "model": "Analog" } }. Blocos: nr, fx1, drv, amp, ir, eq, fx2, dly, rvb.',
    input: obj({ id: str('Id do timbre.'), nome: str('Novo nome.'), ...MACRO_PROPS, blocos: { type: 'object', description: 'Ajustes manuais por bloco: { bloco: { model?, on?, params? } }.' }, volume: int('Volume do preset (0 a 100).', { minimum: 0, maximum: 100 }) }, ['id']),
    async run(args) {
      const Tm = await timbres();
      const t = await toneOrFail(args.id);
      const m = toMacros(args, t.macros);
      const overrides = structuredClone(t.overrides || { blocks: {} });
      for (const [k, o] of Object.entries(args.blocos || {})) {
        if (!['nr', 'fx1', 'drv', 'amp', 'ir', 'eq', 'fx2', 'dly', 'rvb'].includes(k)) fail(`Bloco desconhecido "${k}".`);
        const cur = (overrides.blocks[k] ||= {});
        if (o.model) { cur.model = o.model; cur.params = { ...(o.params || {}) }; } else if (o.params) cur.params = { ...(cur.params || {}), ...o.params };
        if (o.on != null) cur.on = !!o.on;
      }
      if (args.volume != null) overrides.preset_volume = args.volume;
      const changedMacros = Object.keys(MACRO_KEYS).some((k) => args[k] != null);
      const rec = await toneFromMacros(m, { name: args.nome || t.name, song: t.song, overrides });
      if (!changedMacros) { rec.features = t.features; rec.macros = t.macros; } // só blocos: mantém a análise original
      Object.assign(t, rec, { updatedAt: now() });
      Tm.S.notify();
      getLive('timbres')?.reload(t.id);
      return { editado: await toneBrief(t, true) };
    },
  },
  {
    name: 'timbres_apagar', title: 'Apagar timbre', destructive: true,
    description: 'Apaga um timbre guardado.',
    input: obj({ id: str('Id do timbre.') }, ['id']),
    async run({ id }) { const Tm = await timbres(); const t = await toneOrFail(id); Tm.deleteTone(id); Tm.S.notify(); return { apagado: t.name }; },
  },
  {
    name: 'pedaleira_status', title: 'Estado da pedaleira', readOnly: true,
    description: 'Diz se a Pocket Master está conectada (USB ou Bluetooth), qual preset está ativo e os nomes dos presets do usuário (P01 a P50).',
    input: obj({}),
    async run() {
      const PM = await pmSession(), L = await pmLib();
      const pm = PM.device();
      if (!pm) return { conectada: false, suportado: PM.canConnect(), dica: 'Conecte em Ferramentas → Pedaleira.' };
      return { conectada: true, via: PM.via(), presetAtual: pm.current != null ? L.slotLabel(pm.current) : null, presets: Object.fromEntries(Object.entries(pm.names).filter(([i]) => i < L.USER_PRESETS).map(([i, n]) => [L.slotLabel(Number(i)), n])) };
    },
  },
  {
    name: 'pedaleira_aplicar_timbre', title: 'Mandar timbre para a pedaleira',
    description: 'Manda um timbre guardado para o preset em edição da Pocket Master (não grava nada; para gravar use pedaleira_salvar).',
    input: obj({ id: str('Id do timbre.') }, ['id']),
    async run({ id }) { const t = await toneOrFail(id), pm = await pedal(); await pm.apply({ chain: t.chain, amp_mode: t.amp_mode, preset_volume: t.preset_volume, blocks: t.blocks }); return { aplicado: t.name }; },
  },
  {
    name: 'pedaleira_selecionar', title: 'Trocar de preset',
    description: 'Seleciona um preset da Pocket Master: "P01" a "P50" (usuário) ou "F01" a "F50" (fábrica).',
    input: obj({ preset: str('Ex.: "P07" ou "F12".') }, ['preset']),
    async run({ preset }) {
      const L = await pmLib(), pm = await pedal();
      const m = /^([PF])(\d{1,2})$/i.exec(preset.trim()) || fail('Use "P01".."P50" ou "F01".."F50".');
      const n = Number(m[2]);
      if (n < 1 || n > 50) fail('O número vai de 01 a 50.');
      const index = (m[1].toUpperCase() === 'F' ? L.USER_PRESETS : 0) + n - 1;
      await pm.select(index);
      return { selecionado: L.slotLabel(index), nome: pm.names[index] || '' };
    },
  },
  {
    name: 'pedaleira_salvar', title: 'Gravar timbre na pedaleira', destructive: true,
    description: 'Grava um timbre num preset do usuário (P01 a P50). O que estava no preset é guardado como cópia de segurança (dá para restaurar em Ferramentas → Pedaleira).',
    input: obj({ id: str('Id do timbre.'), preset: str('Preset de destino, "P01" a "P50".'), nome: str('Nome no visor (até 10 letras; padrão: o nome do timbre).') }, ['id', 'preset']),
    async run({ id, preset, nome }) {
      const L = await pmLib(), PM = await pmSession();
      const t = await toneOrFail(id); await pedal();
      const m = /^P(\d{1,2})$/i.exec(preset.trim()) || fail('Só dá para gravar nos presets do usuário, "P01" a "P50".');
      const slot = Number(m[1]) - 1;
      if (slot < 0 || slot >= L.USER_PRESETS) fail('O número vai de 01 a 50.');
      const name = L.cleanName(nome || t.name) || 'Timbre';
      await PM.saveWithBackup(slot, name, { chain: t.chain, amp_mode: t.amp_mode, preset_volume: t.preset_volume, blocks: t.blocks });
      return { gravado: L.slotLabel(slot), nome: name };
    },
  },
];

// ---------------------------------------------------------------- DAW
/** Edita um projeto: pela DAW aberta (com desfazer) ou direto no armazenamento do navegador. */
async function withProject(id, fn, write = true) {
  const D = await daw();
  const s = getLive('daw');
  if (s && (!id || s.project().id === id)) {
    if (!write) return fn(s.project(), D);
    let out; await s.edit((p) => { out = fn(p, D); }); return out;
  }
  let pid = id;
  if (!pid) { try { pid = localStorage.getItem('daw.last'); } catch { /* sem armazenamento */ } }
  const p = (pid && await D.loadProject(pid)) || fail(id ? `Não existe projeto com id "${id}". Use daw_listar_projetos.` : 'Nenhum projeto aberto; use daw_criar_projeto ou informe "projeto".');
  const out = fn(p, D);
  if (write) await D.saveProject(p);
  return out;
}
function dawSummary(p, D) {
  return {
    id: p.id, nome: p.name, bpm: p.bpm, temposPorCompasso: p.sig, modo: p.mode === 'song' ? 'música' : 'padrão',
    padraoAtual: p.curPattern,
    canais: p.channels.map((c) => ({ id: c.id, nome: c.name, motor: c.synth.engine, ...(c.synth.source?.kind === 'gm' ? { instrumentoGM: c.synth.source.program } : {}), notaDosPassos: c.stepNote, volumeDb: c.vol, pan: c.pan, mudo: !!c.mute })),
    padroes: p.patterns.map((pt) => ({ id: pt.id, nome: pt.name, tempos: D.patternLength(p, pt), notasPorCanal: Object.fromEntries(Object.entries(pt.notes).filter(([, a]) => a.length).map(([k, a]) => [k, a.length])) })),
    playlist: p.playlist.clips.map((c) => ({ id: c.id, tipo: { pattern: 'padrão', audio: 'áudio', auto: 'automação' }[c.kind], ...(c.kind === 'pattern' ? { padrao: c.pattern } : {}), ...(c.kind === 'audio' ? { nome: c.name || '' } : {}), faixa: p.playlist.tracks.findIndex((t) => t.id === c.track) + 1, compasso: +(c.start / p.sig + 1).toFixed(3), tempos: +D.clipLen(p, c).toFixed(3) })),
    mixer: p.mixer.inserts.map((i) => ({ id: i.id, nome: i.name, volumeDb: i.vol, efeitos: i.fx.map((f) => f.type) })),
    duracaoCompassos: +(D.songEnd(p) / p.sig).toFixed(2),
  };
}
const findIn = (list, ref, what, hint) => list.find((x) => x.id === ref) || list.find((x) => norm(x.name) === norm(ref)) || fail(`Não achei ${what} "${ref}". ${hint}`);
const channelRef = (p, ref) => findIn(p.channels, ref, 'o canal', `Canais: ${p.channels.map((c) => `${c.name} (${c.id})`).join(', ')}.`);
function patternRef(p, D, ref, create = false) {
  if (!ref) return D.curPattern(p) || fail('O projeto não tem padrões.');
  const f = p.patterns.find((x) => x.id === ref) || p.patterns.find((x) => norm(x.name) === norm(ref));
  if (f) return f;
  if (!create) fail(`Não achei o padrão "${ref}". Padrões: ${p.patterns.map((x) => `${x.name} (${x.id})`).join(', ')}.`);
  const pt = D.newPattern(p, ref);
  p.patterns.push(pt);
  return pt;
}
const NOTE_ITEM = { type: 'object', properties: { nota: { type: ['integer', 'string'], description: 'MIDI (60 = C4) ou nome ("C4", "F#3"). Bateria: 36 bumbo, 38 caixa, 39 palmas, 42 chimbal fechado, 46 aberto, 49 prato.' }, inicio: { type: 'number', description: 'Início em tempos (semínimas) desde o começo do padrão; 0.25 = uma semicolcheia.' }, duracao: { type: 'number', description: 'Duração em tempos (padrão 0.25).' }, vel: { type: 'integer', description: 'Força de 1 a 127 (padrão 100).' } }, required: ['nota', 'inicio'] };

const DAW = [
  {
    name: 'daw_listar_projetos', title: 'Listar projetos da DAW', readOnly: true,
    description: 'Lista os projetos de música da DAW guardados neste navegador e indica qual está aberto.',
    input: obj({}),
    async run() {
      const D = await daw(), open = getLive('daw')?.project().id || null;
      return { aberto: open, projetos: (await D.listProjects()).map((x) => ({ id: x.id, nome: x.name, atualizado: new Date(x.updated).toISOString(), aberto: x.id === open })) };
    },
  },
  {
    name: 'daw_ler_projeto', title: 'Ler projeto da DAW', readOnly: true,
    description: 'Resumo de um projeto: BPM, canais (instrumentos), padrões, clipes da playlist e mixer. Sem "projeto", usa o aberto/último.',
    input: obj({ projeto: str('Id do projeto (opcional).') }),
    async run({ projeto }) { return withProject(projeto, dawSummary, false); },
  },
  {
    name: 'daw_ler_padrao', title: 'Ler notas de um padrão', readOnly: true,
    description: 'Devolve as notas de um padrão, por canal (início e duração em tempos).',
    input: obj({ projeto: str('Id do projeto (opcional).'), padrao: str('Id ou nome do padrão (padrão: o atual).') }),
    async run({ projeto, padrao }) {
      return withProject(projeto, (p, D) => {
        const pt = patternRef(p, D, padrao);
        return { id: pt.id, nome: pt.name, tempos: D.patternLength(p, pt), canais: Object.entries(pt.notes).filter(([, a]) => a.length).map(([chId, a]) => ({ canal: chId, nome: D.channelOf(p, chId)?.name || '?', notas: a.map((n) => ({ nota: n.p, inicio: n.t, duracao: n.d, vel: n.v })) })) };
      }, false);
    },
  },
  {
    name: 'daw_criar_projeto', title: 'Criar projeto na DAW',
    description: 'Cria um projeto novo (com bateria, baixo e teclado prontos, como o modelo básico) e o abre se a DAW estiver aberta. "vazio" cria sem canais.',
    input: obj({ nome: str('Nome.'), bpm: int('Andamento (padrão 120).', { minimum: 20, maximum: 300 }), temposPorCompasso: int('Fórmula de compasso (padrão 4).', { minimum: 1, maximum: 12 }), vazio: bool('Sem canais nem notas de exemplo.') }, ['nome']),
    async run({ nome, bpm, temposPorCompasso, vazio }) {
      const D = await daw();
      const p = D.newProject(nome);
      if (bpm) p.bpm = bpm;
      if (temposPorCompasso) { p.sig = temposPorCompasso; p.patterns[0].len = p.sig; }
      if (vazio) {
        const keep = new Set(['master', p.mixer.inserts.find((i) => i.name === 'Gravações')?.id]);
        p.channels = []; p.mixer.inserts = p.mixer.inserts.filter((i) => keep.has(i.id)); p.patterns[0].notes = {};
      }
      await D.saveProject(p);
      const s = getLive('daw');
      if (s) await s.open(p.id);
      else { try { localStorage.setItem('daw.last', p.id); } catch { /* ok */ } }
      return dawSummary(p, D);
    },
  },
  {
    name: 'daw_configurar', title: 'Configurar projeto',
    description: 'Muda nome, BPM, compasso ou o modo de reprodução (padrão = toca só o padrão atual em loop; música = toca a playlist).',
    input: obj({ projeto: str('Id do projeto (opcional).'), nome: str('Novo nome.'), bpm: num('Andamento.', { minimum: 20, maximum: 300 }), temposPorCompasso: int('Tempos por compasso.', { minimum: 1, maximum: 12 }), modo: str('"padrao" ou "musica".', { enum: ['padrao', 'musica'] }), padraoAtual: str('Id ou nome do padrão a selecionar.') }),
    async run({ projeto, nome, bpm, temposPorCompasso, modo, padraoAtual }) {
      return withProject(projeto, (p, D) => {
        if (nome) p.name = nome;
        if (bpm) p.bpm = bpm;
        if (temposPorCompasso) p.sig = temposPorCompasso;
        if (modo) p.mode = modo === 'musica' ? 'song' : 'pattern';
        if (padraoAtual) p.curPattern = patternRef(p, D, padraoAtual).id;
        return { id: p.id, nome: p.name, bpm: p.bpm, temposPorCompasso: p.sig, modo: p.mode === 'song' ? 'música' : 'padrão', padraoAtual: p.curPattern };
      });
    },
  },
  {
    name: 'daw_adicionar_canal', title: 'Adicionar instrumento',
    description: 'Adiciona um canal (instrumento) ao projeto. Motores: subtractive, additive, fm, am, wavetable, pd, formant, granular, physical, sampler, drums, nes. Use "preset" com um nome de sintetizador_presets, ou "instrumentoGM" (0 a 127, General MIDI: 0 piano, 24 violão nylon, 25 violão aço, 33 baixo, 40 violino, 48 cordas, 56 trompete, 73 flauta) para amostras reais.',
    input: obj({ projeto: str('Id do projeto (opcional).'), nome: str('Nome do canal.'), motor: str('Motor de síntese.', { enum: ['subtractive', 'additive', 'fm', 'am', 'wavetable', 'pd', 'formant', 'granular', 'physical', 'sampler', 'drums', 'nes'] }), preset: str('Nome de um preset de fábrica do motor.'), instrumentoGM: int('Programa General MIDI (usa o motor sampler).', { minimum: 0, maximum: 127 }), notaDosPassos: { type: ['integer', 'string'], description: 'Nota tocada pelos passos do sequenciador (padrão 60; bateria: 36 bumbo…).' } }, ['nome']),
    async run({ projeto, nome, motor, preset, instrumentoGM, notaDosPassos }) {
      const { PRESETS } = await import('/lib/synth/presets.js');
      const engine = instrumentoGM != null ? 'sampler' : motor || 'subtractive';
      let params = {};
      if (preset) {
        const f = (PRESETS[engine] || []).find((x) => norm(x.name) === norm(preset)) || fail(`O motor ${engine} não tem o preset "${preset}". Opções: ${(PRESETS[engine] || []).map((x) => x.name).join(', ')}.`);
        params = structuredClone(f.params);
      }
      return withProject(projeto, (p, D) => {
        const ch = D.newChannel(p, nome, { engine, params, ...(instrumentoGM != null ? { source: { kind: 'gm', program: instrumentoGM } } : {}) }, { stepNote: notaDosPassos != null ? parseNote(notaDosPassos) : engine === 'drums' ? 36 : 60 });
        p.channels.push(ch);
        return { canal: { id: ch.id, nome: ch.name, motor: engine, insert: ch.insert } };
      });
    },
  },
  {
    name: 'daw_configurar_canal', title: 'Ajustar canal',
    description: 'Muda volume (dB), pan (-1 a 1), mudo, nome ou preset de um canal.',
    input: obj({ projeto: str('Id do projeto (opcional).'), canal: str('Id ou nome do canal.'), nome: str('Novo nome.'), volumeDb: num('Volume em dB (-60 a 6).', { minimum: -60, maximum: 6 }), pan: num('Pan (-1 esquerda, 1 direita).', { minimum: -1, maximum: 1 }), mudo: bool('Silencia o canal.'), preset: str('Preset de fábrica do motor do canal.') }, ['canal']),
    async run({ projeto, canal, nome, volumeDb, pan, mudo, preset }) {
      const { PRESETS } = await import('/lib/synth/presets.js');
      return withProject(projeto, (p) => {
        const ch = channelRef(p, canal);
        if (nome) ch.name = nome;
        if (volumeDb != null) ch.vol = volumeDb;
        if (pan != null) ch.pan = pan;
        if (mudo != null) ch.mute = mudo;
        if (preset) {
          const f = (PRESETS[ch.synth.engine] || []).find((x) => norm(x.name) === norm(preset)) || fail(`O motor ${ch.synth.engine} não tem o preset "${preset}".`);
          ch.synth = { ...ch.synth, params: structuredClone(f.params) };
        }
        return { canal: { id: ch.id, nome: ch.name, volumeDb: ch.vol, pan: ch.pan, mudo: !!ch.mute } };
      });
    },
  },
  {
    name: 'daw_remover_canal', title: 'Remover canal', destructive: true,
    description: 'Remove um canal e as notas dele em todos os padrões.',
    input: obj({ projeto: str('Id do projeto (opcional).'), canal: str('Id ou nome do canal.') }, ['canal']),
    async run({ projeto, canal }) {
      return withProject(projeto, (p) => {
        const ch = channelRef(p, canal);
        p.channels = p.channels.filter((c) => c !== ch);
        for (const pt of p.patterns) delete pt.notes[ch.id];
        if (!p.channels.some((c) => c.insert === ch.insert) && ch.insert !== 'master') p.mixer.inserts = p.mixer.inserts.filter((i) => i.id !== ch.insert);
        return { removido: ch.name };
      });
    },
  },
  {
    name: 'daw_escrever_notas', title: 'Escrever notas num padrão',
    description: 'Escreve notas de um canal num padrão (cria o padrão se o nome não existir). Tempos em semínimas: num 4/4, um compasso = 4 tempos. Com "substituir" (padrão true) troca as notas que o canal tinha no padrão.',
    input: obj({ projeto: str('Id do projeto (opcional).'), padrao: str('Id ou nome do padrão (padrão: o atual; nome novo cria).'), canal: str('Id ou nome do canal.'), notas: { type: 'array', items: NOTE_ITEM, description: 'Notas.' }, substituir: bool('Troca as notas existentes do canal neste padrão (padrão true).'), compassos: int('Comprimento mínimo do padrão em compassos.', { minimum: 1, maximum: 64 }) }, ['canal', 'notas']),
    async run({ projeto, padrao, canal, notas, substituir = true, compassos }) {
      return withProject(projeto, (p, D) => {
        const ch = channelRef(p, canal), pt = patternRef(p, D, padrao, true);
        const list = notas.map((n) => {
          if (!(n.inicio >= 0)) fail('"inicio" precisa ser >= 0.');
          return { p: parseNote(n.nota), t: +n.inicio, d: Math.max(1 / 64, +(n.duracao ?? D.STEP)), v: Math.max(1, Math.min(127, Math.round(n.vel ?? 100))) };
        });
        pt.notes[ch.id] = [...(substituir ? [] : pt.notes[ch.id] || []), ...list].sort((a, b) => a.t - b.t || a.p - b.p);
        if (compassos) pt.len = Math.max(pt.len || 0, compassos * p.sig);
        p.curPattern = pt.id;
        return { padrao: { id: pt.id, nome: pt.name, tempos: D.patternLength(p, pt) }, canal: ch.name, notas: pt.notes[ch.id].length };
      });
    },
  },
  {
    name: 'daw_escrever_passos', title: 'Programar passos (bateria)',
    description: 'Programa o sequenciador de passos de um canal, como no Channel Rack: "x" toca, "X" toca forte, "." ou "-" pausa; cada caractere é uma semicolcheia (16 = um compasso 4/4). Espaços e "|" são ignorados. Ex.: "x...x...x...x..." (bumbo nos tempos).',
    input: obj({ projeto: str('Id do projeto (opcional).'), padrao: str('Id ou nome do padrão (padrão: o atual; nome novo cria).'), canal: str('Id ou nome do canal.'), passos: str('Sequência de passos.'), nota: { type: ['integer', 'string'], description: 'Nota (padrão: a nota dos passos do canal).' } }, ['canal', 'passos']),
    async run({ projeto, padrao, canal, passos, nota }) {
      return withProject(projeto, (p, D) => {
        const ch = channelRef(p, canal), pt = patternRef(p, D, padrao, true);
        const seq = passos.replace(/[\s|]/g, '');
        if (!/^[xXoO.\-_0]*$/.test(seq)) fail('Use só x, X, o, ".", "-" nos passos.');
        const pitch = nota != null ? parseNote(nota) : ch.stepNote;
        if (nota != null) ch.stepNote = pitch;
        pt.notes[ch.id] = [...seq].map((c, i) => (/[xXoO]/.test(c) ? { p: pitch, t: i * D.STEP, d: D.STEP, v: c === 'X' || c === 'O' ? 120 : 95 } : null)).filter(Boolean);
        pt.len = Math.max(pt.len || 0, Math.ceil((seq.length * D.STEP) / p.sig) * p.sig);
        p.curPattern = pt.id;
        return { padrao: { id: pt.id, nome: pt.name, tempos: D.patternLength(p, pt) }, canal: ch.name, golpes: pt.notes[ch.id].length };
      });
    },
  },
  {
    name: 'daw_colocar_na_playlist', title: 'Colocar padrão na playlist',
    description: 'Coloca um padrão na playlist (o arranjo da música) a partir de um compasso, repetindo quantas vezes quiser, e põe a DAW no modo música.',
    input: obj({ projeto: str('Id do projeto (opcional).'), padrao: str('Id ou nome do padrão.'), compasso: int('Compasso inicial (1 = começo).', { minimum: 1 }), repeticoes: int('Quantas vezes seguidas (padrão 1).', { minimum: 1, maximum: 256 }), faixa: int('Faixa da playlist (1, 2…). Padrão: a primeira livre.', { minimum: 1 }) }, ['padrao', 'compasso']),
    async run({ projeto, padrao, compasso, repeticoes = 1, faixa }) {
      return withProject(projeto, (p, D) => {
        const pt = patternRef(p, D, padrao), len = D.patternLength(p, pt), start = (compasso - 1) * p.sig;
        while (faixa && p.playlist.tracks.length < faixa) p.playlist.tracks.push(D.newPlaylistTrack(p));
        const track = faixa ? p.playlist.tracks[faixa - 1] : D.freeTrack(p, start, start + len * repeticoes);
        const made = [];
        for (let i = 0; i < repeticoes; i++) {
          const c = { id: uid(), kind: 'pattern', track: track.id, start: start + i * len, len, pattern: pt.id };
          p.playlist.clips.push(c); made.push(c.id);
        }
        p.mode = 'song';
        return { clipes: made, faixa: p.playlist.tracks.indexOf(track) + 1, deCompasso: compasso, ateCompasso: +(compasso + (len * repeticoes) / p.sig).toFixed(2) };
      });
    },
  },
  {
    name: 'daw_remover_clipes', title: 'Remover clipes da playlist', destructive: true,
    description: 'Remove clipes da playlist pelos ids (veja daw_ler_projeto) ou todos de um padrão.',
    input: obj({ projeto: str('Id do projeto (opcional).'), clipes: { type: 'array', items: { type: 'string' }, description: 'Ids dos clipes.' }, padrao: str('Ou: remove todos os clipes deste padrão.') }),
    async run({ projeto, clipes = [], padrao }) {
      return withProject(projeto, (p, D) => {
        const pid = padrao ? patternRef(p, D, padrao).id : null;
        const before = p.playlist.clips.length;
        p.playlist.clips = p.playlist.clips.filter((c) => !clipes.includes(c.id) && !(pid && c.pattern === pid));
        return { removidos: before - p.playlist.clips.length };
      });
    },
  },
  {
    name: 'daw_transporte', title: 'Tocar ou parar a DAW',
    description: 'Toca, para ou volta ao início na DAW aberta (a pessoa precisa estar com a DAW aberta; o navegador pode exigir um clique antes do primeiro som).',
    input: obj({ acao: str('tocar, parar ou inicio.', { enum: ['tocar', 'parar', 'inicio'] }) }, ['acao']),
    async run({ acao }) {
      const s = getLive('daw') || fail('A DAW não está aberta. Use site_abrir com secao "daw".');
      await s.transport(acao);
      return { tocando: s.playing() };
    },
  },
  {
    name: 'sintetizador_presets', title: 'Presets do sintetizador', readOnly: true,
    description: 'Lista os motores de síntese e os presets de fábrica de cada um (para daw_adicionar_canal), mais os presets salvos pela pessoa.',
    input: obj({ motor: str('Só deste motor (opcional).') }),
    async run({ motor }) {
      const { PRESETS } = await import('/lib/synth/presets.js'), { ENGINES } = await import('/lib/synth/schemas.js');
      const { presetStore } = await import('/lib/synth/ui.js');
      const ids = motor ? [motor] : Object.keys(ENGINES);
      return {
        motores: ids.filter((id) => ENGINES[id]).map((id) => ({ id, nome: ENGINES[id].name, descricao: ENGINES[id].desc, presets: (PRESETS[id] || []).map((x) => x.name) })),
        meusPresets: presetStore.data.presets.filter((x) => !motor || x.engine === motor).map((x) => ({ nome: x.name, motor: x.engine })),
      };
    },
  },
];

// ---------------------------------------------------------------- ouvir, gravar e exportar
const monitorLib = () => import('/lib/pocketmaster/monitor.js');
const listenLib = () => import('./listen.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (v) => Math.round(v * 100) / 100;
const INSTR = str('Instrumento ligado na pedaleira: "guitar" ou "bass" (padrão guitar).', { enum: ['guitar', 'bass'] });
const audioErr = (e) => fail(e.name === 'NotAllowedError' ? 'O navegador não deixou usar a entrada de áudio. Peça para a pessoa permitir o microfone/entrada para este site.' : e.message || String(e));

/** Áudio de um clipe da playlist (só o trecho que aparece no clipe). */
async function clipAudio(p, D, clipId) {
  const c = p.playlist.clips.find((x) => x.id === clipId) || fail(`Não achei o clipe "${clipId}" (veja daw_ler_projeto).`);
  if (c.kind !== 'audio') fail('Esse clipe não é de áudio.');
  const { audioCtx } = await import('/lib/audio/context.js');
  const a = (await D.loadAudio(audioCtx(), c.audioId)) || fail('O áudio desse clipe não está mais guardado neste navegador.');
  const s0 = Math.round((c.offset || 0) * a.sampleRate), s1 = Math.min(a.channels[0].length, s0 + Math.round(c.dur * a.sampleRate));
  return { channels: a.channels.map((ch) => ch.subarray(s0, s1)), sampleRate: a.sampleRate, clip: c };
}
const clipBrief = (p, c) => ({ id: c.id, tipo: c.kind === 'audio' ? 'áudio' : c.kind === 'pattern' ? 'padrão' : c.kind, nome: c.name || '', compasso: +(c.start / p.sig + 1).toFixed(2), ...(c.kind === 'audio' ? { segundos: +c.dur.toFixed(2) } : {}) });

const AUDIO = [
  {
    name: 'pedaleira_ouvir', title: 'Ouvir a pedaleira no computador',
    description: 'Liga ou desliga o retorno: o som que sai da Pocket Master pelo USB passa a tocar nos alto-falantes/fones do computador. Não precisa do controle (MIDI) conectado, só do cabo USB.',
    input: obj({ ligar: bool('true liga, false desliga.'), volume: int('Volume do retorno (0 a 100).', { minimum: 0, maximum: 100 }) }, ['ligar']),
    async run({ ligar, volume }) {
      const Mo = await monitorLib();
      if (!ligar) { Mo.stopMonitor(); return Mo.monitorState(); }
      try { await Mo.startMonitor({ volume: volume != null ? volume / 100 : null }); } catch (e) { audioErr(e); }
      const s = Mo.monitorState();
      return { ...s, volume: Math.round(s.volume * 100) };
    },
  },
  {
    name: 'audio_escutar', title: 'Escutar o instrumento',
    description: 'Grava alguns segundos da saída da pedaleira (ou do microfone) e devolve o que ouviu: volume, distorção, graves/médios/agudos/presença, reverb, compressão e a curva de frequências. Com "comparar" (id de um timbre) diz a diferença para ele e o que mexer. Antes de chamar, peça para a pessoa tocar: a gravação espera o som começar. Use em ciclo com timbres_editar + pedaleira_aplicar_timbre para timbrar como a pessoa pedir.',
    input: obj({ fonte: str('"pedaleira" (padrão) ou "microfone".', { enum: ['pedaleira', 'microfone'] }), segundos: num('Quanto gravar depois que o som começa (2 a 30; padrão 6).', { minimum: 2, maximum: 30 }), esperar: num('Quanto esperar a pessoa começar a tocar (padrão 20 s).', { minimum: 1, maximum: 90 }), instrumento: INSTR, comparar: str('Id de um timbre para comparar (opcional).') }),
    readOnly: true,
    async run({ fonte = 'pedaleira', segundos = 6, esperar = 20, instrumento, comparar }) {
      const Mo = await monitorLib(), L = await listenLib();
      const target = comparar ? await toneOrFail(comparar) : null;
      let cap;
      try { cap = await Mo.captureInput(segundos, { source: fonte === 'microfone' ? 'mic' : 'pedal', wait: esperar }); } catch (e) { audioErr(e); }
      if (!cap.channels) return { sinal: false, entrada: cap.label, dica: `Nenhum som chegou em ${esperar} s. Confira se a pessoa está tocando, o volume do preset e o cabo USB.` };
      const rep = await L.hear(cap.channels, cap.sampleRate, { instrument: instrumento || target?.instrument || 'guitar', compare: target });
      return { entrada: cap.label, esperouSegundos: r1(cap.waited), ...rep };
    },
  },
  {
    name: 'timbres_ajuste_fino', title: 'Ajuste fino ouvindo a pedaleira',
    description: 'Manda o timbre para a pedaleira e, enquanto a pessoa toca, ouve a saída USB e corrige sozinho o equalizador e o ganho para chegar perto do alvo do timbre (o mesmo "ajuste fino" da seção Timbres). No fim guarda os ajustes no timbre. Precisa da pedaleira conectada (controle) e do cabo USB. Peça para a pessoa tocar durante todo o tempo.',
    input: obj({ id: str('Id do timbre.'), segundos: int('Duração do ajuste (10 a 120; padrão 40).', { minimum: 10, maximum: 120 }) }, ['id']),
    async run({ id, segundos = 40 }) {
      const Tm = await timbres(), T = await toneLib(), PM = await pmSession(), Mo = await monitorLib();
      const t = await toneOrFail(id), pm = await pedal();
      if (!t.features?.curve) fail('Esse timbre não tem uma curva-alvo para comparar.');
      let dev;
      try { dev = await Mo.findPedalInput(); } catch (e) { audioErr(e); }
      if (!dev) fail('Não achei a entrada de áudio da Pocket Master (cabo USB-C).');
      const map = await PM.map();
      const ov = structuredClone(t.overrides || { blocks: {} });
      const spec = () => T.withOverrides(T.buildSpec(t.macros, map), ov);
      let last = spec();
      await pm.apply(last);
      const { startRefine } = await import('/app/timbres/refine.js');
      const rounds = [];
      let job;
      try {
        job = await startRefine({
          deviceId: dev.deviceId, target: t.features, getSpec: spec,
          setParam: (block, name, value) => {
            const o = (ov.blocks[block] ||= {});
            o.model ||= spec().blocks[block].model;
            if (name === '__on') o.on = true; else o.params = { ...(o.params || {}), [name]: value };
          },
          send: async () => { const s = spec(); await pm.apply(s, last); last = s; },
          onUpdate: (info) => { if (info.round) rounds.push({ rodada: info.round, diferencaEqDb: r1(info.eqError), diferencaGanho: r2(info.gainError), ajustou: info.changed }); },
        });
      } catch (e) { audioErr(e); }
      await sleep(segundos * 1000);
      job.stop();
      if (!rounds.length) return { ajustado: false, dica: 'Não ouvi a pedaleira tocando. Peça para a pessoa tocar durante o ajuste e confira o cabo USB.' };
      t.overrides = ov;
      Object.assign(t, spec(), { updatedAt: now() });
      Tm.S.notify();
      getLive('timbres')?.reload(t.id);
      return { ajustado: true, rodadas: rounds.length, primeira: rounds[0], ultima: rounds[rounds.length - 1], eq: t.blocks.eq, amp: t.blocks.amp, obs: 'diferencaEqDb abaixo de 1,5 e diferencaGanho perto de 0 = bem parecido.' };
    },
  },
  {
    name: 'daw_gravar', title: 'Gravar na DAW',
    description: 'Grava na DAW aberta, como o botão de gravar: áudio da pedaleira (USB) ou do microfone vira um clipe na playlist; "notas" grava só o teclado. "iniciar" começa (com "segundos", para sozinho e devolve o resultado); "parar" termina e devolve os clipes novos, com a análise do áudio gravado. A pessoa precisa estar com a DAW aberta e tocar durante a gravação.',
    input: obj({ acao: str('iniciar ou parar.', { enum: ['iniciar', 'parar'] }), fonte: str('pedaleira (padrão), microfone ou notas.', { enum: ['pedaleira', 'microfone', 'notas'] }), compasso: int('Compasso onde começa (padrão: onde o cursor está).', { minimum: 1 }), contagem: bool('Conta um compasso antes de gravar.'), segundos: num('Grava por este tempo e para sozinho (1 a 150).', { minimum: 1, maximum: 150 }), analisar: bool('Analisa o áudio gravado (padrão true).'), instrumento: INSTR }, ['acao']),
    async run({ acao, fonte, compasso, contagem, segundos, analisar = true, instrumento = 'guitar' }) {
      const s = getLive('daw') || fail('A DAW não está aberta. Use site_abrir com secao "daw" e peça para a pessoa clicar na página uma vez (o navegador exige um clique antes de tocar som).');
      const D = await daw();
      const finish = async () => {
        const clips = await s.stopRecord();
        const p = s.project(), out = { clipes: clips.map((c) => clipBrief(p, c)) };
        if (!clips.length) out.dica = 'Nada foi gravado.';
        const a = clips.find((c) => c.kind === 'audio');
        if (a && analisar) { const L = await listenLib(), au = await clipAudio(p, D, a.id); out.analise = await L.hear(au.channels, au.sampleRate, { instrument: instrumento }); }
        return out;
      };
      if (acao === 'parar') return finish();
      const src = { pedaleira: 'pocket', microfone: 'default', notas: 'notes' }[fonte || 'pedaleira'];
      try { await s.record({ fromBar: compasso ?? null, source: src, countIn: contagem ?? null }); } catch (e) { audioErr(e); }
      if (!segundos) return { gravando: true, fonte: fonte || 'pedaleira', dica: 'Chame daw_gravar com acao "parar" quando a pessoa terminar.' };
      const p = s.project();
      await sleep((segundos + (p.countIn ? (p.sig * 60) / p.bpm : 0)) * 1000);
      if (!s.recording()) return { gravando: false, dica: 'A gravação foi parada antes (pela pessoa?).' };
      return finish();
    },
  },
  {
    name: 'daw_analisar_clipe', title: 'Escutar um clipe de áudio',
    description: 'Analisa um clipe de áudio da playlist (por exemplo uma gravação da pedaleira): volume, distorção, equalização, reverb. Pode comparar com um timbre.',
    input: obj({ projeto: str('Id do projeto (opcional).'), clipe: str('Id do clipe de áudio.'), instrumento: INSTR, comparar: str('Id de um timbre (opcional).') }, ['clipe']),
    readOnly: true,
    async run({ projeto, clipe, instrumento = 'guitar', comparar }) {
      const target = comparar ? await toneOrFail(comparar) : null;
      const au = await withProject(projeto, (p, D) => clipAudio(p, D, clipe), false);
      const L = await listenLib();
      return { clipe: au.clip.name || au.clip.id, ...(await L.hear(au.channels, au.sampleRate, { instrument: target?.instrument || instrumento, compare: target })) };
    },
  },
  {
    name: 'daw_exportar', title: 'Exportar o áudio da DAW',
    description: 'Mixa o projeto (a música inteira, o padrão atual ou só o loop) num arquivo WAV, baixa o arquivo no computador da pessoa e devolve uma análise da mixagem (duração, pico, volume médio, se saturou, curva de frequências). Com "colocarNaPlaylist", a mixagem também vira um clipe de áudio novo no projeto.',
    input: obj({ projeto: str('Id do projeto (opcional).'), parte: str('musica (padrão), padrao ou loop.', { enum: ['musica', 'padrao', 'loop'] }), baixar: bool('Baixa o WAV (padrão true).'), nomeArquivo: str('Nome do arquivo (sem .wav).'), colocarNaPlaylist: bool('Também põe a mixagem como clipe de áudio numa faixa nova.') }),
    async run({ projeto, parte = 'musica', baixar = true, nomeArquivo, colocarNaPlaylist = false }) {
      const D = await daw();
      const kind = { musica: 'song', padrao: 'pattern', loop: 'loop' }[parte];
      const s = getLive('daw');
      let out, p;
      if (s && (!projeto || s.project().id === projeto)) {
        p = s.project();
        if (kind === 'song' && !p.playlist.clips.length) fail('A playlist está vazia: exporte "padrao" ou ponha padrões na playlist (daw_colocar_na_playlist).');
        out = await s.render(kind);
      } else {
        // DAW fechada: monta um motor só para mixar
        p = await withProject(projeto, (q) => q, false);
        if (kind === 'song' && !p.playlist.clips.length) fail('A playlist está vazia.');
        const { DawEngine } = await import('/app/daw/engine.js'), { audioCtx } = await import('/lib/audio/context.js');
        const eng = new DawEngine(audioCtx());
        try { await eng.sync(p); out = await eng.render(kind === 'pattern' ? { mode: 'pattern' } : kind === 'loop' ? { mode: 'song', from: p.loop.start, to: p.loop.end } : { mode: 'song' }); } finally { eng.destroy(); }
      }
      const { encodeWav } = await import('/lib/audio/io.js');
      const name = (nomeArquivo || `${p.name}${kind === 'song' ? '' : kind === 'pattern' ? ` (${D.curPattern(p)?.name || 'padrão'})` : ' (loop)'}`).replace(/[\\/:*?"<>|]/g, '_');
      if (baixar) { const { download } = await import('/lib/core/ui.js'); download(`${name}.wav`, encodeWav(out.channels, out.sampleRate)); }
      let clip = null;
      if (colocarNaPlaylist) {
        const audioId = await D.saveAudio(out.channels, out.sampleRate, name);
        clip = await withProject(p.id, (q) => {
          const t = D.newPlaylistTrack(q); q.playlist.tracks.push(t);
          const c = { id: uid(), kind: 'audio', track: t.id, start: kind === 'loop' ? q.loop.start : 0, dur: out.channels[0].length / out.sampleRate, offset: 0, audioId, gain: 0, insert: q.mixer.inserts[0].id, name };
          q.playlist.clips.push(c);
          return c.id;
        });
      }
      const L = await listenLib();
      return { arquivo: baixar ? `${name}.wav` : null, clipe: clip, sampleRate: out.sampleRate, ...(await L.hear(out.channels, out.sampleRate, { mix: true })) };
    },
  },
];

// ---------------------------------------------------------------- site
const SECTIONS = { inicio: '#/', cifras: '#/cifras', timbres: '#/timbres', daw: '#/daw', sintetizador: '#/sintetizador', ferramentas: '#/ferramentas', pedaleira: '#/ferramentas/pedaleira', conta: '#/conta', agentes: '#/agentes' };
const SITE = [
  {
    name: 'site_estado', title: 'Onde a pessoa está', readOnly: true,
    description: 'Diz qual seção do Estúdio está aberta, se a conta está conectada (sincroniza entre aparelhos) e se a pedaleira está conectada. Chame primeiro para se situar.',
    input: obj({}),
    async run() {
      const C = await import('/lib/core/cloud.js'), PM = await pmSession();
      return {
        endereco: location.hash || '#/', titulo: document.title,
        conta: C.user() ? { conectada: true, usuario: C.user().username || null } : { conectada: false },
        pedaleira: !!PM.device(), dawAberta: getLive('daw')?.project().id || null,
        secoes: Object.keys(SECTIONS),
      };
    },
  },
  {
    name: 'site_abrir', title: 'Abrir seção',
    description: 'Abre uma seção do Estúdio para a pessoa ver (ex.: a cifra que você criou). Use "endereco" com um link devolvido por outra ferramenta (ex.: "#/cifras/cifra/abc") ou "secao".',
    input: obj({ secao: str('Seção.', { enum: Object.keys(SECTIONS) }), endereco: str('Endereço interno começando com "#/".') }),
    async run({ secao, endereco }) {
      const to = endereco || SECTIONS[secao] || fail('Informe "secao" ou "endereco".');
      if (!to.startsWith('#/')) fail('O endereço precisa começar com "#/".');
      location.hash = to;
      return { aberto: to };
    },
  },
];

export const TOOLS = [...SITE, ...CIFRAS, ...TIMBRES, ...DAW, ...AUDIO];
const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** Lista pública (formato MCP). */
export function listTools() {
  return TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.input, annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive } }));
}

const confirmers = new Set();
/** A interface pode pedir confirmação antes de ações destrutivas: fn(tool, args) -> Promise<boolean>. */
export function onConfirm(fn) { confirmers.add(fn); return () => confirmers.delete(fn); }
const activity = new Set();
/** Avisa a interface a cada chamada (para mostrar o que o agente está fazendo). */
export function onActivity(fn) { activity.add(fn); return () => activity.delete(fn); }

/** Executa uma ferramenta: devolve { ok: true, result } ou { ok: false, error }. */
export async function callTool(name, args = {}, { via = 'api', confirm = true } = {}) {
  const t = byName.get(name);
  if (!t) return { ok: false, error: `Ferramenta desconhecida "${name}". Use a lista de ferramentas.` };
  const bad = validate(t.input, args);
  if (bad) return { ok: false, error: bad };
  if (t.destructive && confirm) for (const fn of confirmers) if (!(await fn(t, args))) return { ok: false, error: 'A pessoa não autorizou esta ação.' };
  activity.forEach((fn) => fn({ name, title: t.title, via, at: Date.now() }));
  try { return { ok: true, result: await t.run(args || {}) }; } catch (e) { return { ok: false, error: e.message || String(e) }; }
}
