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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET com novas tentativas quando o LRCLIB está sobrecarregado (503/429). */
async function lrclib(path, params, tries = 3) {
  const url = 'https://lrclib.net/api/' + path + '?' + new URLSearchParams(params).toString();
  for (let i = 0; i < tries; i++) {
    let r;
    try { r = await fetch(url); } catch (err) { throw new Error('sem conexão com o LRCLIB (' + (err.message || 'erro de rede') + ')'); }
    if (r.status === 404) return null;
    if (r.ok) return r.json();
    if ((r.status === 503 || r.status === 429) && i < tries - 1) { await sleep(1500 * (i + 1)); continue; }
    throw Object.assign(new Error('o LRCLIB respondeu com erro ' + r.status + (r.status === 503 ? ' (servidor sobrecarregado)' : '')), { status: r.status });
  }
  return null;
}

function pack(x) {
  return {
    lines: x.syncedLyrics ? parseLRC(x.syncedLyrics).filter((l) => l.text) : [],
    plain: x.plainLyrics || '',
    source: 'lrclib', track: x.trackName, artist: x.artistName, duration: x.duration || 0,
  };
}

/**
 * Busca a letra no LRCLIB. Primeiro pela consulta direta (nome + artista), que é rápida e
 * costuma funcionar mesmo quando a busca geral está sobrecarregada; depois pela busca geral.
 * Retorna { lines (com tempo, se houver), plain, source, track, artist, duration } ou null.
 */
export async function findLyrics({ title, artist, duration = 0 }) {
  if (!title) return null;
  const clean = title.replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const artists = [...new Set([artist, artist && artist.split(/\s*(?:,|&| e | feat\.?| ft\.?)\s*/i)[0]].filter(Boolean))];
  // 1) consulta direta
  for (const a of artists) {
    for (const t of [...new Set([title, clean])]) {
      const params = { track_name: t, artist_name: a };
      if (duration) params.duration = Math.round(duration);
      let x = await lrclib('get', params, 2).catch(() => null);
      if (!x && duration) x = await lrclib('get', { track_name: t, artist_name: a }, 2).catch(() => null);
      if (x && !x.instrumental && (x.syncedLyrics || x.plainLyrics)) return pack(x);
    }
  }
  // 2) busca geral (pode estar sobrecarregada)
  const queries = [];
  if (artist) queries.push({ track_name: clean, artist_name: artist });
  queries.push({ q: [clean, artist].filter(Boolean).join(' ') });
  if (artist) queries.push({ track_name: clean });
  let results = [];
  let lastErr = null;
  for (const q of queries) {
    try { results = (await lrclib('search', q)) || []; } catch (err) { lastErr = err; continue; }
    if (results.length) break;
  }
  if (!results.length) {
    if (lastErr && lastErr.status !== 404) throw lastErr;
    return null;
  }
  const scored = results.filter((x) => !x.instrumental && (x.syncedLyrics || x.plainLyrics)).map((x) => {
    let score = similarity(x.trackName, title) * 3 + (artist ? similarity(x.artistName, artist) * 2 : 0);
    if (x.syncedLyrics) score += 1.5;
    if (duration && x.duration) score += Math.abs(x.duration - duration) <= 6 ? 1.5 : Math.abs(x.duration - duration) <= 20 ? 0.5 : -0.5;
    return { x, score };
  }).sort((p, q) => q.score - p.score);
  const best = scored[0];
  if (!best || similarity(best.x.trackName, title) < 0.3) return null;
  return pack(best.x);
}

const wnorm = (w) => w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
function wordSim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const n = a.length, m = b.length;
  const d = Array.from({ length: n + 1 }, (_, i) => [i]);
  for (let j = 1; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[n][m] / Math.max(n, m);
}

/**
 * Letra correta sem tempo (do banco) + transcrição da IA com tempo -> letra correta com tempo.
 * Alinha palavra a palavra (programação dinâmica tolerante a erros de transcrição).
 */
export function alignPlainToTimed(plain, timed) {
  const lines = String(plain || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const A = []; // palavras da letra correta
  lines.forEach((l, li) => l.split(/\s+/).forEach((w) => A.push({ w: wnorm(w), li })));
  const B = []; // palavras transcritas com tempo
  for (const l of timed) {
    const ws = l.text.split(/\s+/).filter(Boolean);
    const dur = (l.end ?? l.t + ws.length * 0.35) - l.t;
    ws.forEach((w, i) => B.push({ w: wnorm(w), t: l.t + (dur * i) / ws.length }));
  }
  if (!A.length || !B.length) return [];
  const n = A.length, m = B.length;
  const GAP = -0.4;
  const score = new Float32Array((n + 1) * (m + 1));
  const back = new Uint8Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) { score[at(i, 0)] = i * GAP; back[at(i, 0)] = 1; }
  for (let j = 1; j <= m; j++) { score[at(0, j)] = 0; back[at(0, j)] = 2; } // pular palavras da IA no início é grátis
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = wordSim(A[i - 1].w, B[j - 1].w);
      const diag = score[at(i - 1, j - 1)] + (s >= 0.5 ? s : s - 0.8);
      const up = score[at(i - 1, j)] + GAP;
      const left = score[at(i, j - 1)] + (i === n ? 0 : GAP);
      let best = diag, b = 0;
      if (up > best) { best = up; b = 1; }
      if (left > best) { best = left; b = 2; }
      score[at(i, j)] = best; back[at(i, j)] = b;
    }
  }
  const timeOf = new Array(n).fill(null);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const b = back[at(i, j)];
    if (b === 0) { if (wordSim(A[i - 1].w, B[j - 1].w) >= 0.5) timeOf[i - 1] = B[j - 1].t; i--; j--; } else if (b === 1) i--; else j--;
  }
  // tempo de cada linha = primeira palavra encontrada; as que faltam são interpoladas
  const lineT = lines.map(() => null);
  A.forEach((a, k) => { if (timeOf[k] !== null && lineT[a.li] === null) lineT[a.li] = timeOf[k]; });
  const known = lineT.map((t, k) => (t === null ? null : k)).filter((k) => k !== null);
  if (!known.length) return [];
  for (let k = 0; k < lineT.length; k++) {
    if (lineT[k] !== null) continue;
    const prev = known.filter((q) => q < k).pop();
    const next = known.find((q) => q > k);
    if (prev !== undefined && next !== undefined) lineT[k] = lineT[prev] + ((lineT[next] - lineT[prev]) * (k - prev)) / (next - prev);
    else if (prev !== undefined) lineT[k] = lineT[prev] + (k - prev) * 3;
    else lineT[k] = Math.max(0, lineT[next] - (next - k) * 3);
  }
  // mantém a ordem crescente
  for (let k = 1; k < lineT.length; k++) if (lineT[k] < lineT[k - 1]) lineT[k] = lineT[k - 1] + 0.5;
  return lines.map((text, k) => ({ t: lineT[k], text }));
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
