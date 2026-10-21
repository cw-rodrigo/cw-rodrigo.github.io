// Letras: busca no LRCLIB (banco aberto de letras sincronizadas) e encaixe dos acordes na letra.

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

function similarity(a, b) {
  const A = new Set(norm(a).split(' ').filter(Boolean));
  const B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((w) => { if (B.has(w)) inter++; });
  return inter / Math.max(A.size, B.size);
}

/** Lê o formato LRC ([mm:ss.xx] texto) em [{ t, text }]. */
export function parseLRC(lrc) {
  const out = [];
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:[.,]\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2].replace(',', '.')), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Busca a letra no LRCLIB. Retorna { lines (com tempo, se houver), plain, source, track, artist, duration } ou null.
 * Lança erro se o serviço não puder ser consultado.
 */
export async function findLyrics({ title, artist, duration = 0 }) {
  if (!title) return null;
  const base = 'https://lrclib.net/api/search?';
  const queries = [];
  if (artist) queries.push(new URLSearchParams({ track_name: title, artist_name: artist }));
  queries.push(new URLSearchParams({ q: [title, artist].filter(Boolean).join(' ') }));
  if (artist) queries.push(new URLSearchParams({ track_name: title }));
  const clean = title.replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (clean && clean !== title) queries.push(new URLSearchParams({ q: clean }));
  let results = [];
  for (const q of queries) {
    let r;
    try { r = await fetch(base + q.toString()); } catch (err) { throw new Error('sem conexão com o LRCLIB (' + (err.message || 'erro de rede') + ')'); }
    if (!r.ok) throw new Error('o LRCLIB respondeu com erro ' + r.status);
    results = await r.json();
    if (results.length) break;
  }
  if (!results.length) return null;
  const scored = results.filter((x) => !x.instrumental && (x.syncedLyrics || x.plainLyrics)).map((x) => {
    let score = similarity(x.trackName, title) * 3 + (artist ? similarity(x.artistName, artist) * 2 : 0);
    if (x.syncedLyrics) score += 1.5;
    if (duration && x.duration) score += Math.abs(x.duration - duration) <= 6 ? 1.5 : Math.abs(x.duration - duration) <= 20 ? 0.5 : -0.5;
    return { x, score };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || similarity(best.x.trackName, title) < 0.3) return null;
  const x = best.x;
  return {
    lines: x.syncedLyrics ? parseLRC(x.syncedLyrics).filter((l) => l.text) : [],
    plain: x.plainLyrics || '',
    source: 'lrclib', track: x.trackName, artist: x.artistName, duration: x.duration || 0,
  };
}

function snapToWord(text, pos) {
  if (pos <= 0) return 0;
  if (pos >= text.length) return text.length;
  if (text[pos - 1] === ' ' || pos === 0) return pos;
  let l = pos, r = pos;
  while (l > 0 && text[l - 1] !== ' ') l--;
  while (r < text.length && text[r - 1] !== ' ') r++;
  return pos - l <= r - pos ? l : Math.min(r, text.length);
}

/**
 * Encaixa os acordes (segmentos com tempo) na letra sincronizada e gera ChordPro.
 * lines: [{ t, end?, text }]  segments: [{ start, end, chord }]
 * offset: segundos somados ao tempo da letra (para corrigir vídeos com introdução diferente).
 */
export function alignLyrics(lines, segments, { offset = 0, source = '' } = {}) {
  const L = lines.filter((l) => l.text && l.text.trim()).map((l) => ({ ...l, t: l.t + offset, end: l.end !== undefined ? l.end + offset : undefined }));
  const segs = segments.filter((s) => s.chord && s.chord !== 'N');
  const out = [`{comment: Rascunho: acordes pelo áudio${source ? ', letra ' + source : ''} — confira}`, ''];
  if (!L.length) return null;
  const chordRow = (list) => list.reduce((acc, s) => { if (acc[acc.length - 1] !== s.chord) acc.push(s.chord); return acc; }, []).map((c) => `[${c}]`).join(' ');

  const intro = segs.filter((s) => s.start < L[0].t - 0.6);
  if (intro.length) { out.push('{comment: Introdução}', chordRow(intro), ''); }

  for (let i = 0; i < L.length; i++) {
    const line = L[i];
    const next = L[i + 1];
    const text = line.text.trim();
    const winStart = line.t - 0.35;
    const winEnd = next ? next.t - 0.35 : Infinity;
    const sung = line.end !== undefined ? Math.max(0.6, line.end - line.t)
      : Math.min((next ? next.t : line.t + 8) - line.t, Math.max(1.2, text.length * 0.085));
    const inLine = segs.filter((s) => s.start >= winStart && s.start < winEnd);
    const during = inLine.filter((s) => s.start < line.t + sung + 0.3);
    const after = inLine.filter((s) => s.start >= line.t + sung + 0.3);
    const marks = [];
    const active = segs.find((s) => s.start < winStart && s.end > line.t);
    if (active && (!during.length || during[0].start > line.t + sung * 0.25)) marks.push({ pos: 0, chord: active.chord });
    for (const s of during) {
      const frac = Math.min(1, Math.max(0, (s.start - line.t) / sung));
      let pos = snapToWord(text, Math.round(frac * text.length));
      if (marks.length && marks[marks.length - 1].chord === s.chord) continue;
      if (marks.length && pos <= marks[marks.length - 1].pos) {
        const prev = marks[marks.length - 1].pos;
        const nextSpace = text.indexOf(' ', prev);
        pos = nextSpace >= 0 ? nextSpace + 1 : text.length;
      }
      marks.push({ pos, chord: s.chord });
    }
    let withChords = text;
    for (let k = marks.length - 1; k >= 0; k--) {
      const { pos, chord } = marks[k];
      withChords = withChords.slice(0, pos) + `[${chord}]` + withChords.slice(pos);
    }
    out.push(withChords);
    const gap = next ? next.t - (line.t + sung) : 0;
    if (after.length && (gap > 2 || !next)) { out.push(chordRow(after)); }
    if (next && gap > 4) out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/** Letra sem tempo: vai abaixo do rascunho de acordes, para encaixe manual. */
export function appendPlainLyrics(chordText, plain) {
  return chordText.replace(/\s*$/, '\n\n') + '{comment: Letra (sem tempo — encaixe os acordes)}\n' + plain.trim() + '\n';
}

const HALLUCINATIONS = /amara\.org|legendas? (pela|por)|obrigad[oa] por assistir|inscreva-se|subt[ií]tulos|thanks for watching|♪+$/i;

/** Transforma o resultado do Whisper ([{ timestamp:[s,e], text }]) em linhas curtas com tempo. */
export function whisperToLines(chunks, maxLen = 48) {
  const lines = [];
  let last = '';
  for (const c of chunks || []) {
    const text = String(c.text || '').replace(/\s+/g, ' ').trim();
    if (!text || HALLUCINATIONS.test(text) || text === last) continue;
    last = text;
    const [s, eRaw] = c.timestamp || [0, null];
    const e = eRaw ?? s + Math.max(1.5, text.length * 0.08);
    // quebra trechos longos em linhas, distribuindo o tempo pelo número de letras
    const words = text.split(' ');
    const parts = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > maxLen && cur) { parts.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
      if (/[.!?]$/.test(w) && cur.length > 18) { parts.push(cur); cur = ''; }
    }
    if (cur) parts.push(cur);
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let t = s;
    for (const p of parts) {
      const d = ((e - s) * p.length) / total;
      lines.push({ t, end: t + d, text: p });
      t += d;
    }
  }
  return lines;
}
