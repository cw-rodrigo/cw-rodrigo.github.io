// Conversa com a Sonicake Pocket Master pelo USB (Web MIDI, mensagens SysEx).
// Protocolo descoberto pelo PocketEdit (github.com/suckyble/PocketEdit) e documentado pelo
// pocket-master-mcp (github.com/voronkovd/pocket-master-mcp, licença MIT). Projeto não oficial.

/** Nome com que a pedaleira aparece como entrada de áudio ou porta MIDI. */
export const PEDAL_NAME = /pocket|sonicake|qme|sonic master/i;

export const MODULES = ['nr', 'fx1', 'drv', 'amp', 'ir', 'eq', 'fx2', 'dly', 'rvb'];
export const LABELS = { nr: 'Noise gate', fx1: 'FX 1', drv: 'Drive', amp: 'Amp', ir: 'Caixa (IR)', eq: 'EQ', fx2: 'FX 2', dly: 'Delay', rvb: 'Reverb' };
export const DEFAULT_CHAIN = [...MODULES];
const CLONE = 9;
const SET = 0x11, GET = 0x12, ACK = 0x14;
const Q = { globals: 0x10, irNames: 0x20, cloneNames: 0x24, names: 0x40, dump: 0x41, index: 0x43, modified: 0x45 };
export const USER_PRESETS = 50;
export const TOTAL_PRESETS = 100; // 50 do usuário + 50 de fábrica
export const NAME_LEN = 10;

// ---------------------------------------------------------------- quadros
export function crc8(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}
export function expand(bytes) { const out = []; for (const b of bytes) out.push((b >> 4) & 15, b & 15); return out; }
export function collapse(data) {
  if (data.length % 2) throw new Error('tamanho ímpar');
  const out = new Uint8Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (data[2 * i] << 4) | data[2 * i + 1];
  return out;
}
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return [...b]; };
const i32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v | 0, true); return [...b]; };
const f32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return [...b]; };
const rdU32 = (b, o) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);
const rdU16 = (b, o) => new DataView(b.buffer, b.byteOffset).getUint16(o, true);
const rdF32 = (b, o) => new DataView(b.buffer, b.byteOffset).getFloat32(o, true);

/** Bytes SysEx (sem F0/F7) de uma mensagem. */
export function build(payload, total = 1, index = 0) {
  const body = [total, index, payload.length, ...payload];
  return expand([crc8(body), ...body]);
}
export function parseFrame(data) {
  const b = collapse(data);
  if (b.length < 4) throw new Error('quadro curto');
  const payload = b.slice(4);
  return { total: b[1], index: b[2], payload, ok: crc8(b.slice(1)) === b[0] && b[3] === payload.length };
}

export const cmd = {
  query: (kind) => build([GET, kind]),
  select: (index) => build([SET, 0x43, ...u32(index)]),
  state: (module, on) => build([SET, 0x49, ...u32(module), ...u32(on ? 1 : 0)]),
  ampMode: (clone) => build([SET, 0x49, ...u32(CLONE), ...u32(clone ? 1 : 0)]),
  effect: (module, code) => build([SET, 0x47, ...u32(module), ...u32(module), ...u32(code)]),
  param: (module, alg, value) => build([SET, 0x48, ...u32(module), ...u32(alg), ...f32(value)]),
  chain: (ids) => build([SET, 0x44, ...ids, CLONE]),
  volume: (v) => build([SET, 0x42, 0x01, 0x20, 0x01, 0x00, Math.round(v)]),
  global: (group, sub, v) => build([SET, 0x11, group, sub, 0, 0, ...i32(v)]),
  save: (slot, name) => build([SET, 0x4a, ...u32(slot), ...encodeName(name), 0, 0, 0]),
};

/** Nome de preset: até 10 caracteres ASCII (acentos são removidos). */
export function cleanName(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, NAME_LEN);
}
function encodeName(name) {
  const s = cleanName(name) || 'Timbre';
  return [...s].map((c) => c.charCodeAt(0)).concat(new Array(NAME_LEN - s.length).fill(0));
}
export function slotLabel(i) { return i < USER_PRESETS ? `P${String(i + 1).padStart(2, '0')}` : `F${String(i - USER_PRESETS + 1).padStart(2, '0')}`; }

// ---------------------------------------------------------------- mapa de modelos
let mapPromise = null;
export function loadMap() {
  mapPromise ||= fetch(new URL('./device-map.json', import.meta.url)).then((r) => r.json());
  return mapPromise;
}
export function modelByCode(map, key, code) {
  const list = map.models[key] || [];
  return list.find((m) => m.code === code) || (key === 'clone' ? list.find((m) => (m.code & 0xffffff) === (code & 0xffffff)) : null) || null;
}
export function modelByName(map, key, name) {
  const n = String(name || '').toLowerCase();
  return (map.models[key] || []).find((m) => m.name.toLowerCase() === n) || null;
}
export function paramValue(p, v) {
  if (v == null || Number.isNaN(v)) return p.default ?? 0;
  if (p.type === 'switch') return v >= 0.5 ? 1 : 0;
  if (p.type === 'select') return Math.max(0, Math.min(p.options.length - 1, Math.round(v)));
  const lo = p.min ?? 0, hi = p.max ?? 100, step = p.step || 1;
  const c = Math.max(lo, Math.min(hi, v));
  return Math.round((lo + Math.round((c - lo) / step) * step) * 100) / 100;
}

// ---------------------------------------------------------------- leitura do dump
function records(buf, start, end) {
  const out = [];
  let o = start;
  while (o + 4 <= end) {
    const tag = rdU16(buf, o), len = rdU16(buf, o + 2);
    if (o + 4 + len > end) break;
    out.push({ tag, data: buf.subarray(o + 4, o + 4 + len) });
    o += 4 + len;
  }
  return out;
}
export function parseDump(payload) {
  if (payload[0] !== GET || payload[1] !== Q.dump || payload.length < 6) throw new Error('não é um dump do preset');
  const hdr = rdU16(payload, 4);
  const tags = {};
  for (const r of records(payload, 6, 6 + hdr)) tags[0xf000 | r.tag] = r.data;
  for (const g of records(payload, 6 + hdr, payload.length)) for (const r of records(g.data, 0, g.data.length)) tags[r.tag] = r.data;
  return tags;
}

/** Dump -> timbre no mesmo formato dos arquivos do pocket-master-mcp: { chain, amp_mode, preset_volume, blocks:{ amp:{model,on,params} } } */
export function decodeDump(map, payload) {
  const t = parseDump(payload);
  const out = { blocks: {} };
  const mask = t[0x3001] ? rdU32(t[0x3001], 0) : null;
  const clone = mask != null && !!(mask & (1 << CLONE));
  out.amp_mode = clone ? 'clone' : 'normal';
  if (t[0x3002] && [...t[0x3002].slice(0, 9)].sort().join() === '0,1,2,3,4,5,6,7,8') out.chain = [...t[0x3002].slice(0, 9)].map((i) => MODULES[i]);
  if (t[0x2001]) out.preset_volume = rdU32(t[0x2001], 0);
  if (t[0x2002]) out.tempo = rdU32(t[0x2002], 0);
  const codes = t[0x3003] ? Array.from({ length: t[0x3003].length / 4 }, (_, i) => rdU32(t[0x3003], 4 * i)) : [];
  const params = t[0x3004] || new Uint8Array(0);
  MODULES.forEach((key, mod) => {
    const src = mod === 3 && clone ? CLONE : mod;
    const pool = src === CLONE ? 'clone' : key;
    const m = codes[src] != null ? modelByCode(map, pool, codes[src]) : null;
    const entry = { on: mask == null ? true : !!(mask & (1 << mod)) };
    if (m) {
      entry.model = m.name;
      entry.params = {};
      for (const p of m.params) {
        const o = 32 * src + 4 * p.alg;
        entry.params[p.name] = paramValue(p, params.length >= o + 4 ? rdF32(params, o) : null);
      }
    } else entry.model = null;
    out.blocks[key] = entry;
  });
  return out;
}
export function decodeNames(payload) {
  const names = {};
  const start = payload[0] === GET && payload[1] === Q.names ? 2 : 0;
  for (let o = start; o + 20 <= payload.length; o += 20) {
    const idx = rdU32(payload, o);
    if (idx >= TOTAL_PRESETS) break;
    let s = '';
    for (let i = 0; i < NAME_LEN; i++) { const c = payload[o + 4 + i]; if (!c) break; s += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '?'; }
    names[idx] = s.trimEnd();
  }
  return names;
}

// ---------------------------------------------------------------- envio de um timbre
/**
 * Mensagens para aplicar `spec` no preset em edição. Com `prev`, manda só o que mudou.
 */
export function specMessages(map, spec, prev = null) {
  const out = [];
  if (spec.chain && (!prev || prev.chain?.join() !== spec.chain.join())) {
    const ids = spec.chain.map((k) => MODULES.indexOf(k));
    if (ids.slice().sort().join() === '0,1,2,3,4,5,6,7,8') out.push(cmd.chain(ids));
  }
  for (const key of MODULES) {
    const b = spec.blocks?.[key];
    if (!b) continue;
    const pb = prev?.blocks?.[key];
    const clone = key === 'amp' && spec.amp_mode === 'clone';
    const pool = clone ? 'clone' : key;
    const m = b.model ? modelByName(map, pool, b.model) : null;
    const module = clone ? CLONE : MODULES.indexOf(key);
    const modelChanged = m && (!pb || pb.model !== b.model || (key === 'amp' && (prev?.amp_mode || 'normal') !== (spec.amp_mode || 'normal')));
    if (modelChanged) {
      if (key === 'amp') out.push(cmd.ampMode(clone));
      out.push(cmd.effect(module, m.code));
    }
    if (b.on != null && (modelChanged || !pb || pb.on !== b.on)) out.push(cmd.state(MODULES.indexOf(key), b.on));
    if (m) {
      for (const p of m.params) {
        const v = paramValue(p, b.params?.[p.name] ?? p.default);
        const pv = pb?.params?.[p.name];
        if (modelChanged || pv == null || paramValue(p, pv) !== v) out.push(cmd.param(module, p.alg, v));
      }
    }
  }
  if (spec.preset_volume != null && (!prev || prev.preset_volume !== spec.preset_volume)) out.push(cmd.volume(spec.preset_volume));
  return out;
}

// ---------------------------------------------------------------- conexão
// ---------------------------------------------------------------- conexões (USB e Bluetooth)
const HINTS = ['pocket', 'sonicake', 'qme'];
const GAP_MS = { usb: 15, ble: 25 };
// Serviço e característica padrão de MIDI por Bluetooth (BLE-MIDI); a pedaleira se anuncia como "Sonic Master BLE".
export const BLE_MIDI_SERVICE = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
export const BLE_MIDI_CHAR = '7772e5db-3868-4112-a1a9-f2669d106bf3';
const BLE_NAME = 'Sonic Master BLE';

export function midiSupported() { return !!globalThis.navigator?.requestMIDIAccess; }
export function bluetoothSupported() { return !!globalThis.navigator?.bluetooth?.requestDevice; }
/** Algum jeito de conectar neste navegador? */
export function canConnect() { return midiSupported() || bluetoothSupported(); }

/**
 * Lê pacotes BLE-MIDI e devolve as mensagens SysEx completas (sem F0/F7).
 * Cada pacote começa com um byte de cabeçalho; bytes >= 0x80 dentro do SysEx são marcas de tempo,
 * e uma mensagem pode continuar no pacote seguinte.
 */
export class BleMidiParser {
  constructor(onSysex) { this.onSysex = onSysex; this.buf = null; }
  push(packet) {
    const d = packet instanceof Uint8Array ? packet : new Uint8Array(packet.buffer || packet);
    if (!d.length || !(d[0] & 0x80)) return;
    for (let i = 1; i < d.length; i++) {
      const b = d[i];
      if (b === 0xf0) this.buf = [];
      else if (b === 0xf7) { if (this.buf) { this.onSysex(Uint8Array.from(this.buf)); this.buf = null; } }
      else if (b & 0x80) continue; // marca de tempo (ou mensagem que não interessa)
      else if (this.buf) this.buf.push(b);
    }
  }
}

/** Monta os pacotes BLE-MIDI de uma mensagem SysEx (corpo sem F0/F7). */
export function blePackets(body, maxLen = 512) {
  const whole = [0x80, 0x80, 0xf0, ...body, 0xf7];
  if (whole.length <= maxLen) return [Uint8Array.from(whole)];
  // mensagem maior que o pacote: continua em pacotes que começam só com o cabeçalho
  const out = [];
  let rest = [0xf0, ...body];
  let first = true;
  while (rest.length) {
    const room = maxLen - (first ? 2 : 1) - 2;
    const chunk = rest.slice(0, room);
    rest = rest.slice(room);
    const pkt = first ? [0x80, 0x80, ...chunk] : [0x80, ...chunk];
    if (!rest.length) pkt.push(0x80, 0xf7);
    out.push(Uint8Array.from(pkt));
    first = false;
  }
  return out;
}

async function openUsb(pm) {
  const access = await navigator.requestMIDIAccess({ sysex: true });
  const outs = [...access.outputs.values()], ins = [...access.inputs.values()];
  const match = (p) => HINTS.some((h) => (p.name || '').toLowerCase().includes(h) || (p.manufacturer || '').toLowerCase().includes(h));
  let candidates = outs.filter(match);
  if (!candidates.length) candidates = outs;
  for (const out of candidates) {
    const inp = ins.find((i) => i.name === out.name) || ins.find(match) || ins[0];
    if (!inp) continue;
    inp.onmidimessage = (e) => {
      const d = e.data;
      if (d[0] !== 0xf0) return;
      pm.onSysex(d.subarray(1, d[d.length - 1] === 0xf7 ? d.length - 1 : d.length));
    };
    const link = {
      kind: 'usb', name: out.name,
      send: (body) => out.send([0xf0, ...body, 0xf7]),
      close: () => { inp.onmidimessage = null; access.onstatechange = null; },
    };
    pm.link = link;
    if (await pm.probe()) {
      access.onstatechange = (e) => { if (e.port.state === 'disconnected' && (e.port.id === out.id || e.port.id === inp.id)) pm.lost(); };
      return link;
    }
    link.close();
    pm.link = null;
  }
  throw new Error(outs.length ? 'A pedaleira não respondeu pelo USB. Confira se ela está ligada e conectada por cabo USB-C para USB-C.' : 'Nenhum aparelho MIDI encontrado. Ligue a pedaleira no USB e tente de novo.');
}

async function openBle(pm) {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ name: BLE_NAME }, { namePrefix: 'Sonic' }, { services: [BLE_MIDI_SERVICE] }],
    optionalServices: [BLE_MIDI_SERVICE],
  });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(BLE_MIDI_SERVICE);
  const ch = await service.getCharacteristic(BLE_MIDI_CHAR);
  const parser = new BleMidiParser((body) => pm.onSysex(body));
  const onValue = (e) => parser.push(new Uint8Array(e.target.value.buffer, e.target.value.byteOffset, e.target.value.byteLength));
  ch.addEventListener('characteristicvaluechanged', onValue);
  await ch.startNotifications();
  let maxLen = 512;
  const onGone = () => pm.lost();
  device.addEventListener('gattserverdisconnected', onGone);
  const write = (pkt) => (ch.writeValueWithoutResponse ? ch.writeValueWithoutResponse(pkt) : ch.writeValue(pkt));
  const link = {
    kind: 'ble', name: device.name || BLE_NAME,
    async send(body) {
      try {
        for (const pkt of blePackets(body, maxLen)) await write(pkt);
      } catch (err) {
        if (maxLen <= 20) throw err;
        maxLen = 20; // pacote grande demais para esta conexão: manda em pedaços pequenos
        for (const pkt of blePackets(body, maxLen)) await write(pkt);
      }
    },
    close: () => {
      device.removeEventListener('gattserverdisconnected', onGone);
      ch.removeEventListener('characteristicvaluechanged', onValue);
      try { device.gatt.disconnect(); } catch { /* ok */ }
    },
  };
  pm.link = link;
  if (await pm.probe(1500)) return link;
  link.close();
  pm.link = null;
  throw new Error('A pedaleira não respondeu pelo Bluetooth. Confira se o Bluetooth dela está ligado e tente de novo.');
}

export class PocketMaster {
  constructor(map) {
    this.map = map;
    this.listeners = new Set();
    this.waiters = new Set();
    this.queue = Promise.resolve();
    this.partial = {};
    this.names = {};
    this.current = null;
    this.state = null;
    this.link = null;
    this.log = [];
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { this.listeners.forEach((fn) => fn(type, data)); }

  /** Conecta pelo USB ('usb') ou Bluetooth ('ble'), encontra a pedaleira e lê o preset atual. */
  async connect(via = 'usb') {
    if (via === 'ble') {
      if (!bluetoothSupported()) throw new Error('Este navegador não tem Bluetooth para sites. Use o Chrome ou o Edge.');
      await openBle(this);
    } else {
      if (!midiSupported()) throw new Error('Este navegador não conversa com aparelhos USB (MIDI). Use o Chrome ou o Edge.');
      await openUsb(this);
    }
    this.name = this.link.name;
    await this.readNames().catch(() => {});
    await this.refresh();
    return this.name;
  }
  /** A conexão caiu (cabo solto, Bluetooth desligado…). */
  lost() {
    if (!this.link) return;
    this.link.close();
    this.link = null;
    this.emit('disconnect');
  }
  disconnect() { if (this.link) { this.link.close(); this.link = null; this.emit('disconnect'); } }
  get connected() { return !!this.link; }
  get via() { return this.link?.kind || null; }

  /** Uma mensagem SysEx recebida (sem F0/F7). */
  onSysex(body) {
    let f;
    try { f = parseFrame(body); } catch { return; }
    if (f.total > 1) {
      const now = performance.now();
      let set = this.partial[f.total];
      if (f.index === 0 || !set || now - set.t > 1500) set = this.partial[f.total] = { t: now, parts: {} };
      set.parts[f.index] = f;
      if (Object.keys(set.parts).length < f.total) return;
      delete this.partial[f.total];
      const parts = Array.from({ length: f.total }, (_, i) => set.parts[i]);
      const len = parts.reduce((n, p) => n + p.payload.length, 0);
      const payload = new Uint8Array(len);
      let o = 0;
      for (const p of parts) { payload.set(p.payload, o); o += p.payload.length; }
      f = { total: 1, index: 0, payload, ok: parts.every((p) => p.ok) };
    }
    if (!f.ok) return;
    this.track(f);
    for (const w of [...this.waiters]) if (w.pred(f)) { this.waiters.delete(w); w.resolve(f); }
  }

  /** Mudanças feitas nos botões da própria pedaleira. */
  track(f) {
    const p = f.payload;
    if (p[0] !== SET && p[0] !== GET) return;
    if (p[1] === 0x43 && p.length >= 3 && p[0] === GET) {
      if (this.current !== p[2]) { this.current = p[2]; this.emit('preset', p[2]); }
    } else if (p[1] === 0x45 && p.length >= 3) this.modified = !!p[2];
    else if (p[0] === GET && [0x47, 0x48, 0x49].includes(p[1])) this.emit('knob');
  }

  send(data) {
    const run = async () => {
      if (!this.link) throw new Error('A pedaleira não está conectada.');
      await this.link.send(data);
      this.log.push(data.length);
      await new Promise((r) => setTimeout(r, GAP_MS[this.link?.kind] || 15));
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }
  wait(pred, timeout) {
    return new Promise((resolve) => {
      const w = { pred, resolve };
      this.waiters.add(w);
      setTimeout(() => { if (this.waiters.delete(w)) resolve(null); }, timeout);
    });
  }
  async request(kind, pred = () => true, timeout = 1500, retries = 2) {
    for (let i = 0; i <= retries; i++) {
      const got = this.wait((f) => f.payload[0] === GET && f.payload[1] === kind && pred(f), timeout);
      await this.send(cmd.query(kind));
      const f = await got;
      if (f) return f;
    }
    return null;
  }
  async probe(timeout = 700) {
    const f = await this.request(Q.index, () => true, timeout, 1);
    if (f && f.payload.length >= 3) this.current = f.payload[2];
    return !!f;
  }
  async readNames() {
    const f = await this.request(Q.names, (f) => f.payload.length > 100, 2500);
    if (!f) throw new Error('A pedaleira não mandou os nomes dos presets.');
    this.names = decodeNames(f.payload);
    return this.names;
  }
  async readIndex() {
    const f = await this.request(Q.index, (f) => f.payload.length >= 3);
    if (f) this.current = f.payload[2];
    return this.current;
  }
  async readState() {
    const f = await this.request(Q.dump, (f) => f.payload.length > 200);
    if (!f) throw new Error('A pedaleira não mandou o preset atual.');
    return decodeDump(this.map, f.payload);
  }
  async refresh() {
    await this.readIndex();
    this.state = await this.readState();
    this.emit('state', this.state);
    return this.state;
  }
  async select(index) {
    await this.send(cmd.select(index));
    this.current = index;
    await new Promise((r) => setTimeout(r, 300));
    return this.refresh();
  }
  /** Aplica um timbre no preset em edição (sem salvar). Com `prev`, manda só as diferenças. */
  async apply(spec, prev = null) {
    const msgs = specMessages(this.map, spec, prev);
    for (const m of msgs) await this.send(m);
    return msgs.length;
  }
  async setParam(key, paramName, value, clone = false) {
    const pool = clone && key === 'amp' ? 'clone' : key;
    const name = this.state?.blocks?.[key]?.model;
    const m = modelByName(this.map, pool, name);
    const p = m?.params.find((x) => x.name === paramName);
    if (!p) return;
    await this.send(cmd.param(clone && key === 'amp' ? CLONE : MODULES.indexOf(key), p.alg, paramValue(p, value)));
  }
  /** Salva o preset em edição num slot do usuário (P01–P50). */
  async save(slot, name) {
    if (!(slot >= 0 && slot < USER_PRESETS)) throw new Error('Só dá para salvar nos presets do usuário (P01 a P50).');
    const ack = this.wait((f) => f.payload[0] === ACK && f.payload[1] === 0x08, 3000);
    await this.send(cmd.save(slot, name));
    const f = await ack;
    const ok = f ? f.payload[2] === 0 : null;
    try { await this.readNames(); } catch { /* segue */ }
    const verified = this.names[slot] === cleanName(name);
    if (ok === false) throw new Error('A pedaleira recusou o salvamento.');
    if (ok == null && !verified) throw new Error('A pedaleira não confirmou o salvamento. Confira na tela dela.');
    this.current = slot;
    return { ok, verified };
  }
}
