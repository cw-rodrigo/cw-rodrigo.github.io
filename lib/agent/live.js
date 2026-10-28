// Telas abertas que os agentes de IA podem usar diretamente (a DAW aberta, a seção Timbres…).
// Cada seção se registra ao abrir e sai ao fechar; as ferramentas consultam aqui antes de mexer nos dados salvos.
const live = new Map();
export function setLive(name, api) { live.set(name, api); return () => { if (live.get(name) === api) live.delete(name); }; }
export const getLive = (name) => live.get(name) || null;
