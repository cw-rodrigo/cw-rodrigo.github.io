// Instrumentos General MIDI para o rompler: amostras do banco FluidR3 GM (licença MIT), servidas pelo
// projeto midi-js-soundfonts (github.com/gleitz/midi-js-soundfonts). Baixadas na primeira vez e guardadas.

const BASE = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/';
const SLUGS = 'acoustic_grand_piano bright_acoustic_piano electric_grand_piano honkytonk_piano electric_piano_1 electric_piano_2 harpsichord clavinet celesta glockenspiel music_box vibraphone marimba xylophone tubular_bells dulcimer drawbar_organ percussive_organ rock_organ church_organ reed_organ accordion harmonica tango_accordion acoustic_guitar_nylon acoustic_guitar_steel electric_guitar_jazz electric_guitar_clean electric_guitar_muted overdriven_guitar distortion_guitar guitar_harmonics acoustic_bass electric_bass_finger electric_bass_pick fretless_bass slap_bass_1 slap_bass_2 synth_bass_1 synth_bass_2 violin viola cello contrabass tremolo_strings pizzicato_strings orchestral_harp timpani string_ensemble_1 string_ensemble_2 synth_strings_1 synth_strings_2 choir_aahs voice_oohs synth_choir orchestra_hit trumpet trombone tuba muted_trumpet french_horn brass_section synth_brass_1 synth_brass_2 soprano_sax alto_sax tenor_sax baritone_sax oboe english_horn bassoon clarinet piccolo flute recorder pan_flute blown_bottle shakuhachi whistle ocarina lead_1_square lead_2_sawtooth lead_3_calliope lead_4_chiff lead_5_charang lead_6_voice lead_7_fifths lead_8_bass_lead pad_1_new_age pad_2_warm pad_3_polysynth pad_4_choir pad_5_bowed pad_6_metallic pad_7_halo pad_8_sweep fx_1_rain fx_2_soundtrack fx_3_crystal fx_4_atmosphere fx_5_brightness fx_6_goblins fx_7_echoes fx_8_scifi sitar banjo shamisen koto kalimba bagpipe fiddle shanai tinkle_bell agogo steel_drums woodblock taiko_drum melodic_tom synth_drum reverse_cymbal guitar_fret_noise breath_noise seashore bird_tweet telephone_ring helicopter applause gunshot'.split(' ');
const PT = ['Piano de cauda', 'Piano brilhante', 'Piano elétrico de cauda', 'Piano honky-tonk', 'Piano elétrico 1 (Rhodes)', 'Piano elétrico 2 (DX)', 'Cravo', 'Clavinete', 'Celesta', 'Glockenspiel', 'Caixinha de música', 'Vibrafone', 'Marimba', 'Xilofone', 'Sinos tubulares', 'Saltério', 'Órgão (drawbar)', 'Órgão percussivo', 'Órgão de rock', 'Órgão de igreja', 'Harmônio', 'Acordeom', 'Gaita', 'Acordeom de tango', 'Violão (náilon)', 'Violão (aço)', 'Guitarra jazz', 'Guitarra limpa', 'Guitarra abafada', 'Guitarra com overdrive', 'Guitarra distorcida', 'Harmônicos de guitarra', 'Baixo acústico', 'Baixo (dedos)', 'Baixo (palheta)', 'Baixo fretless', 'Baixo slap 1', 'Baixo slap 2', 'Baixo sintetizado 1', 'Baixo sintetizado 2', 'Violino', 'Viola', 'Violoncelo', 'Contrabaixo', 'Cordas em tremolo', 'Cordas em pizzicato', 'Harpa', 'Tímpano', 'Orquestra de cordas 1', 'Orquestra de cordas 2', 'Cordas sintetizadas 1', 'Cordas sintetizadas 2', 'Coro "aah"', 'Vozes "ooh"', 'Coro sintetizado', 'Ataque de orquestra', 'Trompete', 'Trombone', 'Tuba', 'Trompete com surdina', 'Trompa', 'Naipe de metais', 'Metais sintetizados 1', 'Metais sintetizados 2', 'Sax soprano', 'Sax alto', 'Sax tenor', 'Sax barítono', 'Oboé', 'Corne-inglês', 'Fagote', 'Clarinete', 'Flautim', 'Flauta', 'Flauta doce', 'Flauta de pã', 'Garrafa soprada', 'Shakuhachi', 'Assobio', 'Ocarina', 'Lead quadrada', 'Lead serra', 'Lead calíope', 'Lead chiff', 'Lead charang', 'Lead voz', 'Lead quintas', 'Lead baixo', 'Pad new age', 'Pad quente', 'Pad polissintetizado', 'Pad coro', 'Pad arco', 'Pad metálico', 'Pad halo', 'Pad varredura', 'Efeito chuva', 'Efeito trilha', 'Efeito cristal', 'Efeito atmosfera', 'Efeito brilho', 'Efeito goblins', 'Efeito ecos', 'Efeito ficção científica', 'Cítara', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Gaita de foles', 'Rabeca', 'Shanai', 'Sininho', 'Agogô', 'Steel drum', 'Bloco de madeira', 'Taikô', 'Tom melódico', 'Tambor sintetizado', 'Prato ao contrário', 'Ruído de traste', 'Respiração', 'Mar', 'Passarinho', 'Telefone', 'Helicóptero', 'Aplausos', 'Tiro'];
export const GM = SLUGS.map((slug, i) => ({ program: i, slug, name: PT[i] || slug }));

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const noteName = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const ROOTS = Array.from({ length: 21 }, (_, i) => 24 + i * 4); // C1 a G#7, uma amostra a cada 4 semitons
const cache = new Map();

async function fetchBuf(url) {
  let cacheStore = null;
  try { cacheStore = await caches.open('estudio-gm'); const hit = await cacheStore.match(url); if (hit) return hit.arrayBuffer(); } catch { /* sem cache */ }
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  const copy = r.clone();
  try { await cacheStore?.put(url, copy); } catch { /* ok */ }
  return r.arrayBuffer();
}

/** Zonas { L, R, sr, root, lo, hi } de um instrumento GM. onProgress(0..1) */
export async function loadGMZones(program, ctx, onProgress = () => {}) {
  if (cache.has(program)) return cache.get(program);
  const g = GM[program];
  if (!g) throw new Error('Instrumento desconhecido.');
  let done = 0;
  const results = await Promise.all(ROOTS.map(async (root) => {
    try {
      const buf = await ctx.decodeAudioData(await fetchBuf(`${BASE}${g.slug}-mp3/${noteName(root)}.mp3`));
      return { L: buf.getChannelData(0), R: buf.numberOfChannels > 1 ? buf.getChannelData(1) : null, sr: buf.sampleRate, root };
    } catch { return null; } finally { onProgress(++done / ROOTS.length); }
  }));
  const zones = results.filter(Boolean).sort((a, b) => a.root - b.root);
  if (!zones.length) throw new Error('Não consegui baixar as amostras desse instrumento. Confira a internet.');
  zones.forEach((z, i) => {
    z.lo = i === 0 ? 0 : Math.floor((zones[i - 1].root + z.root) / 2) + 1;
    z.hi = i === zones.length - 1 ? 127 : Math.floor((z.root + zones[i + 1].root) / 2);
  });
  cache.set(program, zones);
  return zones;
}
