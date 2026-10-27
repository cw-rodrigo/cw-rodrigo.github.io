// Links do YouTube em texto livre, títulos dos vídeos e tempo inicial (?t=).

const YT_TOKEN = /(?:https?:\/\/)?(?:[\w-]+\.)?(?:youtube\.com|youtu\.be)\/[^\s<>"')\]]*/gi;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function parseYouTubeUrl(token) {
  let u;
  try { u = new URL(/^https?:/i.test(token) ? token : 'https://' + token); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  const list = u.searchParams.get('list') || '';
  const parts = u.pathname.split('/').filter(Boolean);
  let id = '';
  if (host === 'youtu.be') id = parts[0] || '';
  else if (parts[0] === 'watch') id = u.searchParams.get('v') || '';
  else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1] || '';
  else if (parts[0] === 'playlist' && list) return { type: 'playlist', list };
  if (VIDEO_ID.test(id)) return { type: 'video', id, list };
  return null;
}

/**
 * Encontra vídeos e playlists do YouTube em um texto livre (lista de links ou mensagem),
 * na ordem em que aparecem e sem repetições.
 * Vídeo: { type:'video', id, url, list, context }; playlist: { type:'playlist', list, url, context }.
 * `context` é o texto da mesma linha sem o link — útil como título de reserva.
 */
export function extractYouTubeItems(text) {
  const found = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const tokens = line.match(YT_TOKEN) || [];
    const context = line.replace(YT_TOKEN, ' ')
      .replace(/^[\s\d.)\-–—•*#:>]+/, '')
      .replace(/[\s\-–—:|•]+$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    for (const tok of tokens) {
      const it = parseYouTubeUrl(tok);
      if (!it) continue;
      const k = it.type === 'video' ? 'v:' + it.id : 'p:' + it.list;
      if (seen.has(k)) continue;
      seen.add(k);
      if (it.type === 'video') found.push({ ...it, url: `https://www.youtube.com/watch?v=${it.id}`, context: tokens.length > 1 ? '' : context });
      else found.push({ ...it, url: `https://www.youtube.com/playlist?list=${it.list}`, context });
    }
  }
  return found;
}

/** Só os vídeos (sem playlists). */
export function extractYouTube(text) {
  return extractYouTubeItems(text).filter((x) => x.type === 'video');
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


/** Segundo inicial de um link (?t=95, ?t=1m35s, &start=95), ou null. */
export function startTimeOf(url) {
  const m = /[?&#](?:t|start)=([\dhms]+)/.exec(String(url || ''));
  if (!m) return null;
  const v = m[1];
  if (/^\d+$/.test(v)) return Number(v);
  const h = /(\d+)h/.exec(v), mi = /(\d+)m/.exec(v), se = /(\d+)s/.exec(v);
  return (h ? +h[1] * 3600 : 0) + (mi ? +mi[1] * 60 : 0) + (se ? +se[1] : 0) || null;
}

const metaCache = new Map();
/** Título e canal de um vídeo (oEmbed do YouTube, com o noembed de reserva). */
export function fetchMeta(id) {
  if (!metaCache.has(id)) {
    metaCache.set(id, (async () => {
      const watch = `https://www.youtube.com/watch?v=${id}`;
      for (const url of [`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, `https://noembed.com/embed?url=${encodeURIComponent(watch)}`]) {
        try {
          const r = await fetch(url);
          if (!r.ok) continue;
          const j = await r.json();
          if (j.title) return { title: j.title, author: j.author_name || '' };
        } catch { /* tenta o próximo */ }
      }
      metaCache.delete(id);
      return null;
    })());
  }
  return metaCache.get(id);
}
