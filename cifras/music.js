// Lógica musical e de texto, sem dependência de navegador (testável no Node).

export const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NOTE_INDEX = {
  C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, 'E#': 5, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11,
};
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6]); // F Bb Eb Ab Db Gb
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]); // Dm Gm Cm Fm Bbm Ebm

export const KEYS = [
  ...SHARPS.map((_, i) => keyName(i, false)),
  ...SHARPS.map((_, i) => keyName(i, true)),
];

export function noteIndex(name) {
  const n = NOTE_INDEX[name];
  return n === undefined ? -1 : n;
}

export function mod12(n) {
  return ((n % 12) + 12) % 12;
}

export function usesFlats(root, minor) {
  return minor ? FLAT_MINOR.has(root) : FLAT_MAJOR.has(root);
}

export function keyName(root, minor) {
  const r = mod12(root);
  const names = usesFlats(r, minor) ? FLATS : SHARPS;
  // Preferências comuns em cifras brasileiras
  let name = names[r];
  if (!minor && r === 6) name = 'F#';
  if (minor && r === 8) name = 'G#';
  if (minor && r === 3) name = 'Eb';
  return name + (minor ? 'm' : '');
}

export function parseKey(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^([A-G])([#b]?)(m(?!aj))?/);
  if (!m) return null;
  const root = noteIndex(m[1] + m[2]);
  if (root < 0) return null;
  return { root, minor: Boolean(m[3]) };
}

export function normalizeKey(str) {
  const k = parseKey(str);
  return k ? keyName(k.root, k.minor) : '';
}

/** Semitons para ir do tom `from` ao tom `to` (pela menor distância, -5..+6). */
export function semitonesBetween(from, to) {
  const a = parseKey(from);
  const b = parseKey(to);
  if (!a || !b) return 0;
  let d = mod12(b.root - a.root);
  if (d > 6) d -= 12;
  return d;
}

/** Tom resultante ao transpor `key` em `semis`. */
export function transposeKey(key, semis) {
  const k = parseKey(key);
  if (!k) return '';
  return keyName(k.root + semis, k.minor);
}

/** Leva um tom para a tônica de `target`, mantendo o modo (maior/menor) original. */
export function keyWithRootOf(original, target) {
  const o = parseKey(original);
  const t = parseKey(target);
  if (!o || !t) return normalizeKey(target);
  return keyName(t.root, o.minor);
}

const CHORD_RE = /^([A-G](?:#|b)?)((?:maj|min|dim|aug|sus|add|m|M|°|º|\+|-|ø|[0-9]|[#b](?=[0-9])|\((?:[#b+\-]?[0-9]{1,2}[,/ ]?)+\))*)(?:\/([A-G](?:#|b)?))?$/;

export function isChord(token) {
  return CHORD_RE.test(token);
}

function spellNote(idx, flats) {
  return (flats ? FLATS : SHARPS)[mod12(idx)];
}

export function transposeChord(chord, semis, flats) {
  const m = chord.match(CHORD_RE);
  if (!m) return chord;
  const root = noteIndex(m[1]);
  let out = spellNote(root + semis, flats) + (m[2] || '');
  if (m[3]) out += '/' + spellNote(noteIndex(m[3]) + semis, flats);
  return out;
}

// ---------- ChordPro ----------

const NOISE_TOKEN = /^(\||-+|\(?\d+x\)?|x\d+|\(|\)|%|\/)$/i;

/** Uma linha de cifra contém só acordes (e marcações como "|" ou "2x"). */
export function isChordLine(line) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  let chords = 0;
  for (const t of tokens) {
    if (NOISE_TOKEN.test(t)) continue;
    const clean = t.replace(/^\(|\)$/g, '');
    if (!isChord(clean)) return false;
    chords++;
  }
  return chords > 0;
}

const TAB_LINE = /^\s*[eEBGDAa]\s*[|:]?[-0-9hpbr/\\~x|()\s]{4,}$/;
const SECTION_LINE = /^\s*\[([^\]]+)\]\s*(.*)$/;

/** Converte cifra no formato "acordes em cima da letra" (Cifra Club etc.) para ChordPro. */
export function chordsOverLyricsToChordPro(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const out = [];
  let inTab = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');

    if (TAB_LINE.test(line)) {
      if (!inTab) { out.push('{start_of_tab}'); inTab = true; }
      out.push(line);
      continue;
    } else if (inTab) {
      out.push('{end_of_tab}');
      inTab = false;
    }

    const sec = line.match(SECTION_LINE);
    if (sec && !isChord(sec[1].trim())) {
      out.push(`{comment: ${sec[1].trim()}}`);
      const rest = sec[2];
      if (rest.trim()) {
        if (isChordLine(rest)) out.push(chordLineInline(rest));
        else out.push(rest.trim());
      }
      continue;
    }

    if (line.trim() && isChordLine(line)) {
      const next = lines[i + 1];
      const nextIsLyric = next !== undefined && next.trim() !== '' && !isChordLine(next)
        && !TAB_LINE.test(next) && !SECTION_LINE.test(next);
      if (nextIsLyric) {
        out.push(mergeChordsIntoLyric(line, next.replace(/\t/g, '    ').replace(/\s+$/, '')));
        i++;
      } else {
        out.push(chordLineInline(line));
      }
      continue;
    }
    out.push(line);
  }
  if (inTab) out.push('{end_of_tab}');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function chordPositions(line) {
  const res = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line))) {
    const clean = m[0].replace(/^\(|\)$/g, '');
    if (isChord(clean)) res.push({ col: m.index, chord: clean });
  }
  return res;
}

function chordLineInline(line) {
  return chordPositions(line).map((p) => `[${p.chord}]`).join(' ');
}

function mergeChordsIntoLyric(chordLine, lyric) {
  const pos = chordPositions(chordLine);
  let padded = lyric;
  const last = pos.length ? pos[pos.length - 1].col : 0;
  if (padded.length < last) padded = padded.padEnd(last, ' ');
  let result = padded;
  for (let k = pos.length - 1; k >= 0; k--) {
    const { col, chord } = pos[k];
    result = result.slice(0, col) + `[${chord}]` + result.slice(col);
  }
  return result.replace(/\s+$/, '');
}

/** Detecta se um texto parece estar em "acordes em cima da letra". */
export function looksLikeChordsOverLyrics(text) {
  if (/\[[A-G][^\]\s]*\][a-zà-ú ]/i.test(text) && !/^\s*\[[A-G][^\]]*\]\s*$/m.test(text)) return false;
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  const chordLines = lines.filter(isChordLine).length;
  return chordLines >= 2;
}

/** Lê ChordPro em uma estrutura para exibir. */
export function parseChordPro(text) {
  const meta = {};
  const lines = [];
  let inTab = false;
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const dir = line.match(/^\s*\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/i);
    if (dir) {
      const name = dir[1].toLowerCase();
      const val = dir[2] || '';
      if (name === 'sot' || name === 'start_of_tab') { inTab = true; continue; }
      if (name === 'eot' || name === 'end_of_tab') { inTab = false; continue; }
      if (['c', 'comment', 'ci', 'comment_italic', 'soc', 'start_of_chorus', 'sov', 'start_of_verse'].includes(name)) {
        const label = val || (name.includes('chorus') || name === 'soc' ? 'Refrão' : name.includes('verse') || name === 'sov' ? 'Estrofe' : '');
        if (label) lines.push({ type: 'section', text: label });
        continue;
      }
      if (['eoc', 'end_of_chorus', 'eov', 'end_of_verse'].includes(name)) continue;
      const alias = { t: 'title', st: 'artist', subtitle: 'artist' }[name] || name;
      meta[alias] = val;
      continue;
    }
    if (inTab) { lines.push({ type: 'tab', text: line }); continue; }
    if (!line.trim()) { lines.push({ type: 'empty' }); continue; }
    const segments = [];
    const re = /\[([^\]]*)\]/g;
    let last = 0;
    let m;
    let pending = null;
    while ((m = re.exec(line))) {
      const before = line.slice(last, m.index);
      if (pending !== null || before) segments.push({ chord: pending, text: before });
      pending = m[1];
      last = m.index + m[0].length;
    }
    const rest = line.slice(last);
    if (pending !== null || rest) segments.push({ chord: pending, text: rest });
    const hasChord = segments.some((s) => s.chord);
    const hasText = segments.some((s) => s.text.trim());
    lines.push({ type: hasChord && !hasText ? 'chords' : 'lyric', segments });
  }
  return { meta, lines };
}

/** Transpõe todos os acordes de um texto ChordPro. */
export function transposeChordPro(text, semis, targetKey) {
  if (!semis) return text;
  const k = parseKey(targetKey);
  const flats = k ? usesFlats(k.root, k.minor) : false;
  let inTab = false;
  return String(text).split('\n').map((line) => {
    if (/^\s*\{\s*(sot|start_of_tab)/i.test(line)) inTab = true;
    if (/^\s*\{\s*(eot|end_of_tab)/i.test(line)) inTab = false;
    if (inTab || /^\s*\{/.test(line)) return line;
    return line.replace(/\[([^\]]+)\]/g, (all, c) => (isChord(c) ? `[${transposeChord(c, semis, flats)}]` : all));
  }).join('\n');
}

/** Converte ChordPro de volta para "acordes em cima da letra" (texto puro). */
export function chordProToText(text) {
  const { lines } = parseChordPro(text);
  const out = [];
  for (const l of lines) {
    if (l.type === 'empty') out.push('');
    else if (l.type === 'section') out.push(`[${l.text}]`);
    else if (l.type === 'tab') out.push(l.text);
    else if (l.type === 'chords') out.push(l.segments.map((s) => s.chord || '').filter(Boolean).join('  '));
    else {
      let chordRow = '';
      let lyricRow = '';
      for (const s of l.segments) {
        if (s.chord) {
          if (chordRow.length > lyricRow.length) lyricRow = lyricRow.padEnd(chordRow.length, ' ');
          chordRow = chordRow.padEnd(lyricRow.length, ' ') + s.chord + ' ';
        }
        lyricRow += s.text;
      }
      if (chordRow.trim()) out.push(chordRow.replace(/\s+$/, ''));
      out.push(lyricRow.replace(/\s+$/, ''));
    }
  }
  return out.join('\n');
}

/** Palpite do tom pela cifra: primeiro acorde (ou {key:}). */
export function guessKey(text) {
  const { meta, lines } = parseChordPro(text);
  if (meta.key && parseKey(meta.key)) return normalizeKey(meta.key);
  for (const l of lines) {
    for (const s of l.segments || []) {
      if (s.chord && isChord(s.chord)) {
        const m = s.chord.match(CHORD_RE);
        const minor = /^m(?!aj)/.test(m[2] || '');
        return keyName(noteIndex(m[1]), minor);
      }
    }
  }
  return '';
}

// ---------- YouTube ----------

const YT_RE = /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^\s#]*?&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])[^\s<>"')\]]*/g;

/**
 * Encontra vídeos do YouTube em um texto livre (lista de links ou mensagem).
 * Retorna [{ id, url, context }] sem repetições, na ordem em que aparecem.
 * `context` é o texto da mesma linha sem o link — útil como título de reserva.
 */
export function extractYouTube(text) {
  const found = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    YT_RE.lastIndex = 0;
    let m;
    const matches = [];
    while ((m = YT_RE.exec(line))) matches.push(m);
    for (const mm of matches) {
      const id = mm[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const context = line.replace(YT_RE, ' ')
        .replace(/^[\s\d.)\-–—•*#:>]+/, '')
        .replace(/[\s\-–—:|•]+$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      found.push({ id, url: `https://www.youtube.com/watch?v=${id}`, context });
    }
  }
  return found;
}

const NOISE = [
  /\((?:[^)]*?(?:official|oficial|clipe|video|vídeo|lyric|letra|audio|áudio|visualizer|ao vivo|live|remaster|hd|4k|hq|acústico|acustico|cover|karaok)[^)]*)\)/gi,
  /\[(?:[^\]]*?(?:official|oficial|clipe|video|vídeo|lyric|letra|audio|áudio|visualizer|ao vivo|live|remaster|hd|4k|hq|acústico|acustico|cover|karaok)[^\]]*)\]/gi,
  /\b(?:official\s+(?:music\s+)?video|clipe\s+oficial|v[ií]deo\s+oficial|lyric\s+video|com\s+letra|ao\s+vivo)\b/gi,
];

/** Separa artista e música a partir do título do vídeo e do nome do canal. */
export function splitTitle(videoTitle, channel) {
  let t = String(videoTitle || '');
  for (const re of NOISE) t = t.replace(re, ' ');
  t = t.replace(/\s*[|｜]\s*.*$/, '').replace(/\s{2,}/g, ' ').trim();
  let artist = '';
  let title = t;
  const parts = t.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  } else {
    artist = String(channel || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '')
      .replace(/\s*\b(oficial|official)\b\s*$/i, '').trim();
  }
  title = title.replace(/\s*\((?:feat|ft)\.?[^)]*\)/i, '').replace(/\s+(?:feat|ft)\.\s.*$/i, '')
    .replace(/^["“']|["”']$/g, '').trim();
  return { artist, title };
}

// ---------- Cifra Club ----------

export function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, 'e').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function cifraClubLinks(artist, title) {
  const q = [title, artist].filter(Boolean).join(' ');
  return {
    direct: artist && title ? `https://www.cifraclub.com.br/${slugify(artist)}/${slugify(title)}/` : '',
    search: `https://www.cifraclub.com.br/?q=${encodeURIComponent(q)}`,
    google: `https://www.google.com/search?q=${encodeURIComponent(`${q} cifra site:cifraclub.com.br`)}`,
  };
}

// ---------- Detecção de tom (Krumhansl–Schmuckler) ----------

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a, b) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Recebe um cromagrama (12 valores, C..B) e devolve os tons mais prováveis. */
export function estimateKey(chroma) {
  const results = [];
  for (let r = 0; r < 12; r++) {
    const rot = (p) => p.map((_, i) => p[mod12(i - r)]);
    results.push({ key: keyName(r, false), score: correlation(chroma, rot(MAJOR_PROFILE)) });
    results.push({ key: keyName(r, true), score: correlation(chroma, rot(MINOR_PROFILE)) });
  }
  return results.sort((x, y) => y.score - x.score);
}

// ---------- Melodia -> ABC (partitura / tablatura) ----------

/**
 * Formato simples de melodia, uma nota por palavra:
 *   nota + oitava, e opcionalmente ":duração" em tempos (1 = semínima)
 *   ex.:  E4 G4 A4:2 | B4:0.5 A4:0.5 G4:1   R:1 = pausa de 1 tempo   | = barra de compasso
 */
export function parseMelody(text) {
  const notes = [];
  for (const tok of String(text || '').trim().split(/\s+/).filter(Boolean)) {
    if (tok === '|') { notes.push({ bar: true }); continue; }
    const m = tok.match(/^([A-Ga-g])([#b]?)(\d)?(?::(\d+(?:[.,]\d+)?|\d+\/\d+))?$|^([Rr])(?::(\d+(?:[.,]\d+)?|\d+\/\d+))?$/);
    if (!m) throw new Error(`Não entendi a nota "${tok}". Use algo como C4, F#4:2 ou R:1.`);
    const durStr = m[4] || m[6] || '1';
    const dur = durStr.includes('/') ? durStr.split('/').reduce((a, b) => Number(a) / Number(b)) : Number(durStr.replace(',', '.'));
    if (m[5]) { notes.push({ rest: true, dur }); continue; }
    const octave = m[3] ? Number(m[3]) : 4;
    const midi = 12 * (octave + 1) + noteIndex(m[1].toUpperCase() + m[2]);
    notes.push({ midi, dur });
  }
  return notes;
}

export function transposeMelody(notes, semis) {
  return notes.map((n) => (n.midi !== undefined ? { ...n, midi: n.midi + semis } : n));
}

export function midiName(midi, flats) {
  return spellNote(midi, flats) + (Math.floor(midi / 12) - 1);
}

/** Gera ABC com o nome de cada nota escrito acima dela. */
export function melodyToAbc(notes, { title = '', bpm = 90, key = 'C' } = {}) {
  const k = parseKey(key);
  const flats = k ? usesFlats(k.root, k.minor) : false;
  let body = '';
  let barAcc = {};
  for (const n of notes) {
    if (n.bar) { body += ' | '; barAcc = {}; continue; }
    const len = abcLength(n.dur);
    if (n.rest) { body += `z${len} `; continue; }
    const name = spellNote(n.midi, flats);
    const letter = name[0];
    const acc = name[1] === '#' ? '^' : name[1] === 'b' ? '_' : '=';
    const octave = Math.floor(n.midi / 12) - 1;
    const id = letter + octave;
    let accText = '';
    if ((barAcc[id] || '=') !== acc) accText = acc;
    barAcc[id] = acc;
    let pitch = letter;
    if (octave >= 5) pitch = letter.toLowerCase() + "'".repeat(octave - 5);
    else pitch = letter + ','.repeat(Math.max(0, 4 - octave));
    body += `"^${name}"${accText}${pitch}${len} `;
  }
  return `X:1\nT:${title.replace(/\n/g, ' ')}\nM:4/4\nL:1/8\nQ:1/4=${bpm}\nK:C\n${body.trim()} |]\n`;
}

function abcLength(beats) {
  const eighths = beats * 2;
  if (Number.isInteger(eighths)) return eighths === 1 ? '' : String(eighths);
  const sixteenths = Math.round(beats * 4);
  return `${sixteenths}/2`;
}
