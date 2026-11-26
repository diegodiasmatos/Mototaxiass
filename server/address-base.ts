/**
 * Base local de endereços da cidade.
 *
 * O Nominatim online é fraco para cidades pequenas: não acha muitas ruas,
 * demora e depende de serviço externo. Este módulo baixa UMA VEZ todas as
 * ruas, bairros e estabelecimentos da cidade direto do OpenStreetMap
 * (Overpass API) e guarda na tabela `local_addresses`. A busca passa a ser
 * local: instantânea, completa e funciona até sem internet externa.
 *
 * Sem chave de API, sem custo. Atualizável pela central → 🗺️ Mapas.
 */
import { db, getSetting, getSettingNum, setSetting } from './db.ts';
import { haversineM } from './util.ts';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Versão do formato da base. Sobe quando a importação muda de um jeito que
 * exige baixar de novo (ver `refreshOutdatedBase`).
 *  2 — ruas de mesmo nome em localidades diferentes viram entradas separadas.
 */
export const BASE_VERSION = '2';

/** Separa o nome da rua da localidade nas entradas repetidas ("rua x · distrito"). */
const SAME_NAME_SEP = ' · ';

/** Trechos da mesma rua ficam a menos disso um do outro; acima, é outra rua. */
const SAME_STREET_LINK_M = 1500;

export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Abreviações comuns que o usuário digita ("av brasil" → "avenida brasil"). */
const EXPANSIONS: Record<string, string> = {
  av: 'avenida', ave: 'avenida', r: 'rua', tv: 'travessa', trav: 'travessa',
  pc: 'praca', pca: 'praca', jd: 'jardim', vl: 'vila', cj: 'conjunto',
  res: 'residencial', rod: 'rodovia', estr: 'estrada',
};

/** Palavras de tipo de via: combinam quando possível, mas não eliminam. */
const TYPE_WORDS = new Set([
  'rua', 'avenida', 'travessa', 'alameda', 'praca', 'estrada', 'rodovia',
  'linha', 'jardim', 'vila', 'conjunto', 'residencial', 'parque', 'largo',
]);

export interface BaseHit {
  kind: 'rua' | 'bairro' | 'local';
  name: string;
  detail: string | null;
  lat: number;
  lng: number;
  /** número de casa digitado pelo usuário */
  number?: string;
  /** como o número foi posicionado: exato (ponto conhecido), interpolado
   *  (entre dois números conhecidos) ou centro (centro da rua — pede ajuste) */
  number_how?: 'exato' | 'interpolado' | 'centro';
}

/**
 * Posição de um número de casa numa rua.
 * Fontes: pontos do OSM + pontos confirmados pelos passageiros (quando
 * ajustam o pino no mapa). Entre dois números conhecidos, interpola.
 */
export function resolveHouseNumber(streetNorm: string, n: number):
  { lat: number; lng: number; how: 'exato' | 'interpolado' } | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const pts = db.prepare(`SELECT number, lat, lng FROM address_points
    WHERE street_norm = ? ORDER BY number`).all(streetNorm) as any[];
  if (!pts.length) return null;
  const exact = pts.find(p => p.number === n);
  if (exact) return { lat: exact.lat, lng: exact.lng, how: 'exato' };
  let lo: any = null, hi: any = null;
  for (const p of pts) {
    if (p.number < n) lo = p;
    else if (!hi) { hi = p; break; }
  }
  if (lo && hi) {
    const f = (n - lo.number) / (hi.number - lo.number);
    return {
      lat: lo.lat + (hi.lat - lo.lat) * f,
      lng: lo.lng + (hi.lng - lo.lng) * f,
      how: 'interpolado',
    };
  }
  // sem par para interpolar: um vizinho de numeração próxima ainda é muito
  // melhor que o centro da rua
  const near = lo || hi;
  if (near && Math.abs(near.number - n) <= 80) {
    return { lat: near.lat, lng: near.lng, how: 'interpolado' };
  }
  return null;
}

/**
 * Grava a posição real de um número confirmada por um passageiro (ajuste do
 * pino). A rua precisa existir na base — nada de aprender endereço inventado.
 */
export function learnHouseNumber(street: string, number: number, lat: number, lng: number):
  { ok: boolean; reason?: string } {
  const key = normalize(street);
  // pode haver mais de uma rua com esse nome (cidade e distritos): vale a
  // mais próxima do ponto confirmado
  const ruas = db.prepare(`SELECT name, norm, lat, lng FROM local_addresses
    WHERE kind = 'rua' AND (norm = ? OR norm LIKE ? || '${SAME_NAME_SEP}%')`).all(key, key) as any[];
  if (!ruas.length) return { ok: false, reason: 'rua desconhecida' };
  if (!Number.isInteger(number) || number <= 0 || number > 99999) {
    return { ok: false, reason: 'número inválido' };
  }
  const rua = ruas
    .map(r => ({ r, d: haversineM(lat, lng, r.lat, r.lng) }))
    .sort((a, b) => a.d - b.d)[0];
  // o ponto confirmado precisa estar perto da rua (tolerante: ruas longas
  // têm centro distante das pontas), senão é toque errado ou abuso
  if (rua.d > 4000) {
    return { ok: false, reason: 'ponto longe demais da rua' };
  }
  db.prepare(`INSERT INTO address_points
      (street_norm, street_name, number, lat, lng, source, hits, updated_at)
    VALUES (?, ?, ?, ?, ?, 'passageiro', 1, ?)
    ON CONFLICT(street_norm, number) DO UPDATE SET
      lat = excluded.lat, lng = excluded.lng, source = 'passageiro',
      hits = hits + 1, updated_at = excluded.updated_at`)
    .run(rua.r.norm, rua.r.name, number, lat, lng, Date.now());
  return { ok: true };
}

export function addressPointStats(): { total: number; osm: number; aprendidos: number } {
  const rows = db.prepare(
    'SELECT source, COUNT(*) c FROM address_points GROUP BY source').all() as any[];
  const by: Record<string, number> = {};
  for (const r of rows) by[r.source] = r.c;
  return {
    total: Object.values(by).reduce((a, b) => a + b, 0),
    osm: by.osm || 0, aprendidos: by.passageiro || 0,
  };
}

/**
 * Categorias do OSM → palavras-chave em português pesquisáveis.
 * É o que faz "hospital" listar todos os hospitais e "posto" achar tanto
 * posto de gasolina quanto posto de saúde, mesmo sem a palavra no nome.
 */
const CATEGORY_TAGS: [key: string, values: RegExp, pt: string][] = [
  ['amenity', /^(hospital|clinic|doctors)$/, 'hospital saude clinica pronto atendimento'],
  ['healthcare', /./, 'saude posto de saude ubs unidade'],
  ['amenity', /^pharmacy$/, 'farmacia remedio drogaria'],
  ['amenity', /^fuel$/, 'posto gasolina combustivel etanol'],
  ['shop', /^(supermarket|convenience|greengrocer|butcher)$/, 'mercado supermercado mercadinho mercearia'],
  ['amenity', /^(school|kindergarten)$/, 'escola colegio creche'],
  ['amenity', /^(college|university)$/, 'faculdade universidade ensino superior'],
  ['amenity', /^place_of_worship$/, 'igreja templo paroquia'],
  ['amenity', /^(bank|atm)$/, 'banco caixa agencia'],
  ['amenity', /^(restaurant|fast_food|cafe|bar|pub)$/, 'restaurante lanche lanchonete pizzaria comida'],
  ['amenity', /^(bus_station)$/, 'rodoviaria onibus terminal'],
  ['amenity', /^police$/, 'policia delegacia'],
  ['amenity', /^townhall$/, 'prefeitura paco municipal'],
  ['amenity', /^(dentist)$/, 'dentista odontologia'],
  ['amenity', /^veterinary$/, 'veterinario pet animal'],
  ['shop', /^(bakery)$/, 'padaria panificadora pao'],
  ['shop', /^(car_repair|tyres)$/, 'mecanica oficina borracharia carro'],
  ['shop', /^(hairdresser|beauty)$/, 'salao cabeleireiro barbearia beleza'],
  ['shop', /^(clothes|shoes)$/, 'loja roupa calcado'],
  ['shop', /^(hardware|doityourself)$/, 'material de construcao ferragem'],
  ['leisure', /^(stadium|sports_centre|pitch)$/, 'quadra estadio ginasio esporte campo'],
  ['leisure', /^(park|playground)$/, 'praca parque lazer'],
  ['tourism', /^(hotel|motel|guest_house)$/, 'hotel pousada hospedagem'],
  ['office', /^(lawyer)$/, 'advogado advocacia escritorio'],
  ['office', /^(accountant)$/, 'contador contabilidade escritorio'],
  ['office', /./, 'escritorio'],
  ['craft', /./, 'oficina servico'],
  ['emergency', /./, 'emergencia socorro'],
];

/** Monta as palavras-chave de um elemento do OSM (categorias + apelidos). */
function buildTags(tags: Record<string, string>): string | null {
  const parts: string[] = [];
  for (const [key, values, pt] of CATEGORY_TAGS) {
    if (tags[key] && values.test(tags[key])) parts.push(pt);
  }
  for (const alias of [tags.brand, tags.operator, tags.old_name, tags.alt_name, tags.short_name]) {
    if (alias) parts.push(normalize(alias));
  }
  const joined = [...new Set(parts.join(' ').split(/\s+/))].join(' ').trim();
  return joined || null;
}

/** Distância de edição limitada (para tolerar erros de digitação). */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** "tupanssi" ≈ "tupassi": colapsa letras repetidas antes de comparar. */
function squash(s: string): string { return s.replace(/(.)\1+/g, '$1'); }

function fuzzyHasToken(words: string[], token: string): boolean {
  const t = squash(token);
  const max = t.length >= 6 ? 2 : t.length >= 4 ? 1 : 0;
  return words.some(w => {
    const sw = squash(w);
    if (sw.includes(t) && t.length >= 4) return true;
    return editDistance(sw, t, max) <= max;
  });
}

// ---------------------------------------------------------------
// Nomes vagos: registros do OpenStreetMap sem nome próprio ("Escola",
// "Café", "Gasolina") ou com cara de casa particular ("Casa do Fulano").
// Eles continuam na base (não são apagados), só não aparecem na busca
// dos passageiros. Locais cadastrados pela central nunca são ocultados.
// ---------------------------------------------------------------
const GENERIC_NAMES = new Set([
  'escola', 'colegio', 'creche', 'cafe', 'gasolina', 'posto', 'ferramentas', 'trilha',
  'farmacia', 'drogaria', 'mercado', 'mercearia', 'supermercado', 'padaria', 'restaurante',
  'lanchonete', 'lanches', 'bar', 'igreja', 'academia', 'loja', 'oficina', 'hotel',
  'quadra', 'campo', 'estacionamento', 'banheiro', 'parquinho', 'salao', 'praca',
]);

/** O registro tem nome vago demais para ajudar alguém a escolher um destino? */
export function isVaguePlace(kind: string, name: string, detail: string | null,
  source?: string | null): boolean {
  if (kind !== 'local' || source === 'manual') return false;
  const n = normalize(name).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (looksPrivate(n)) return true;                           // "Casa do Fulano"
  return GENERIC_NAMES.has(n) && !detail;                     // "Escola", sem rua para situar
}

/** Palavras que fazem de "Casa da/do X" um lugar público, não a casa de alguém. */
const PUBLIC_HOUSE_WORDS = new Set([
  'cultura', 'artesao', 'estudante', 'idoso', 'idosos', 'crianca', 'saude', 'agricultor',
  'povo', 'cidadao', 'cidadania', 'mulher', 'memoria', 'musica', 'oracao', 'apoio', 'acolhida',
]);
/** "casa do marcelo" (3 palavras, a última um nome) parece casa particular. */
function looksPrivate(n: string): boolean {
  const m = /^casa (do|da|de|dos|das) (\S+)$/.exec(n);
  return !!m && !PUBLIC_HOUSE_WORDS.has(m[2]);
}

/** Lista para a central do que está oculto da busca e por quê. */
export function hiddenPlaces(): { name: string; detail: string | null; reason: string }[] {
  const rows = db.prepare(`SELECT kind, name, detail, source FROM local_addresses
    WHERE kind = 'local' ORDER BY name`).all() as any[];
  return rows.filter(r => isVaguePlace(r.kind, r.name, r.detail, r.source)).map(r => ({
    name: r.name, detail: r.detail || null,
    reason: looksPrivate(normalize(r.name).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim())
      ? 'parece endereço particular' : 'nome genérico, sem rua',
  }));
}

/**
 * Pontos de referência para sugerir antes de a pessoa digitar: os locais
 * cadastrados pela central e os da base que são de uso público e fácil de
 * reconhecer (rodoviária, hospital, UBS, prefeitura, faculdade...). Tudo
 * vem da base: nada é inventado. Mantém a ordem das categorias abaixo.
 */
const REFERENCE_TERMS: [RegExp, number][] = [
  // [começo do nome, quantos no máximo] — pelo NOME, não pela categoria do OSM
  // (que marca farmácia como "saúde" e traria farmácia para "UBS")
  [/^(rodoviaria|terminal rodoviario)/, 1],
  [/^hospital/, 2],
  [/^(ubs|unidade basica)\b/, 2],
  [/^prefeitura/, 1],
  [/^(faculdade|ifpr|universidade)\b/, 2],
  [/^forum\b/, 1],
  [/^praca\b/, 2],
];
export function referencePlaces(limit = 12): BaseHit[] {
  const rows = db.prepare(`SELECT kind, name, norm, tags, detail, lat, lng, source
    FROM local_addresses WHERE kind = 'local'`).all() as any[];
  const useful = rows.filter(r => !isVaguePlace(r.kind, r.name, r.detail, r.source));
  const picked: any[] = [];
  const seen = new Set<string>();
  const add = (r: any) => {
    // mesmo lugar cadastrado duas vezes ("IFPR Campus ..." com grafias diferentes)
    const key = r.norm.split(SAME_NAME_SEP)[0].split(/\s+/).slice(0, 2).join(' ');
    if (seen.has(key) || picked.length >= limit) return;
    seen.add(key);
    picked.push(r);
  };
  useful.filter(r => r.source === 'manual').sort((a, b) => a.name.localeCompare(b.name)).forEach(add);
  for (const [re, max] of REFERENCE_TERMS) {
    let n = 0;
    for (const r of useful.filter(x => re.test(x.norm)).sort((a, b) => a.name.length - b.name.length)) {
      const before = picked.length;
      if (n >= max) break;
      add(r);
      if (picked.length > before) n++;
    }
  }
  return picked.map(r => ({ kind: 'local', name: r.name, detail: r.detail || null, lat: r.lat, lng: r.lng }));
}

/** Bairros da base, em ordem alfabética (sugestão para quem não sabe a rua). */
export function neighbourhoods(): BaseHit[] {
  return (db.prepare(`SELECT name, detail, lat, lng FROM local_addresses
    WHERE kind = 'bairro' ORDER BY name`).all() as any[])
    .map(r => ({ kind: 'bairro', name: r.name, detail: r.detail || null, lat: r.lat, lng: r.lng }));
}

export function baseCount(): number {
  try {
    return (db.prepare('SELECT COUNT(*) c FROM local_addresses').get() as any).c;
  } catch { return 0; }
}

export function baseStats(): { ruas: number; bairros: number; locais: number; total: number; updated_at: number | null;
  numeros: number; por_fonte: Record<string, number>; ibge_updated_at: number | null } {
  const rows = db.prepare(
    'SELECT kind, COUNT(*) c FROM local_addresses GROUP BY kind').all() as any[];
  const by: Record<string, number> = {};
  for (const r of rows) by[r.kind] = r.c;
  const por_fonte: Record<string, number> = {};
  for (const r of db.prepare('SELECT source, COUNT(*) c FROM local_addresses GROUP BY source').all() as any[]) por_fonte[r.source] = r.c;
  const upd = Number(getSetting('address_base_updated_at') || '');
  const ibge = Number(getSetting('cnefe_imported_at') || '');
  return {
    ruas: by.rua || 0, bairros: by.bairro || 0, locais: by.local || 0,
    total: (by.rua || 0) + (by.bairro || 0) + (by.local || 0),
    updated_at: Number.isFinite(upd) && upd > 0 ? upd : null,
    numeros: (db.prepare('SELECT COUNT(*) c FROM address_points').get() as any).c,
    por_fonte,
    ibge_updated_at: Number.isFinite(ibge) && ibge > 0 ? ibge : null,
  };
}

/**
 * Busca na base local. Entende número de casa ("rua curitiba 123"):
 * casa com a rua e devolve o número junto, marcando a coordenada como
 * aproximada (centro da rua) — nunca inventa a posição exata da casa.
 */
export function searchBase(q: string, limit = 8): BaseHit[] {
  if (!baseCount()) return [];
  let qn = normalize(q).replace(/[.,;]/g, ' ');

  // extrai número de casa (fim ou meio: "rua x 123" / "rua x, 123 centro").
  // Número seguido de "de" faz parte do nome ("Rua 7 de Setembro"), e o
  // número da casa é o último que sobrar ("rua 7 de setembro 250" → 250).
  let houseNumber: string | undefined;
  const words = qn.split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    if (/^\d{1,5}$/.test(words[i]) && words[i + 1] !== 'de') {
      houseNumber = words[i];
      words.splice(i, 1);
      break;
    }
  }
  qn = words.join(' ');

  const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
  const tokens = qn.split(/\s+/).filter(t => t && !STOP.has(t))
    .map(t => EXPANSIONS[t] || t);
  if (!tokens.length) return [];

  // tokens de tipo ("rua", "jardim") não eliminam resultados sozinhos,
  // a menos que a consulta inteira seja só tipos ("jardim")
  const required = tokens.filter(t => !TYPE_WORDS.has(t));
  const effective = required.length ? required : tokens;

  // cada token precisa aparecer no nome OU nas palavras-chave de categoria
  // (é o que faz "hospital" listar hospitais e "mecanica" achar oficinas)
  const where = effective.map(() =>
    "(norm LIKE '%' || ? || '%' OR IFNULL(tags,'') LIKE '%' || ? || '%')").join(' AND ');
  let rows = (db.prepare(
    `SELECT kind, name, norm, tags, detail, lat, lng, source FROM local_addresses
     WHERE ${where} LIMIT 80`).all(...effective.flatMap(t => [t, t])) as any[])
    .filter(r => !isVaguePlace(r.kind, r.name, r.detail, r.source));

  // nada na busca exata? tenta tolerando erro de digitação
  // ("av tupanssi" → "Avenida Tupassi")
  if (!rows.length) {
    const all = (db.prepare(
      'SELECT kind, name, norm, tags, detail, lat, lng, source FROM local_addresses').all() as any[])
      .filter(r => !isVaguePlace(r.kind, r.name, r.detail, r.source));
    rows = all.filter(r => {
      const words = `${r.norm} ${r.tags || ''}`.split(/\s+/).filter(Boolean);
      return effective.every(t => fuzzyHasToken(words, t));
    }).slice(0, 30);
  }

  const first = effective[0];
  const typeTokens = tokens.filter(t => TYPE_WORDS.has(t));
  const scored = rows.map(r => {
    let score = 0;
    if (r.norm.split(SAME_NAME_SEP)[0] === qn.trim()) score += 100; // nome exato
    if (r.norm.startsWith(first)) score += 30;              // começa pelo termo
    if (effective.every(t => r.norm.includes(t))) score += 15; // termo no nome > só na categoria
    for (const t of typeTokens) if (r.norm.includes(t)) score += 10;
    if (houseNumber && r.kind === 'rua') score += 20;       // número pede rua
    // sem número de casa, bairro e ponto de referência com o termo no NOME
    // vêm antes das ruas ("panorama" → Jardim Panorama antes da Rua Panorama)
    const nameHit = effective.every(t => r.norm.includes(t));
    if (!houseNumber && nameHit && r.kind === 'bairro') score += 30;
    if (!houseNumber && nameHit && r.kind === 'local') score += 18;
    if (r.kind === 'local') score += 5;                     // POI é mais específico
    score -= r.norm.length / 50;                            // nomes curtos primeiro
    return { r, score };
  }).sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ r }) => {
    const hit: BaseHit = {
      kind: r.kind, name: r.name, detail: r.detail || null,
      lat: r.lat, lng: r.lng,
      number: houseNumber && r.kind === 'rua' ? houseNumber : undefined,
    };
    if (hit.number) {
      const res = resolveHouseNumber(r.norm, Number(hit.number));
      if (res) { hit.lat = res.lat; hit.lng = res.lng; hit.number_how = res.how; }
      else hit.number_how = 'centro';
    }
    return hit;
  });
}

/** Rua da base mais próxima de um ponto (fallback do reverse geocoding). */
export function nearestBase(lat: number, lng: number, maxM = 300):
  { name: string; kind: string; dist_m: number } | null {
  if (!baseCount()) return null;
  // pré-filtro por caixa (~0.01° ≈ 1.1 km) para não calcular haversine em tudo
  const d = 0.012;
  const rows = db.prepare(
    `SELECT kind, name, lat, lng FROM local_addresses
     WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`)
    .all(lat - d, lat + d, lng - d, lng + d) as any[];
  let best: { name: string; kind: string; dist_m: number } | null = null;
  for (const r of rows) {
    const dist = haversineM(lat, lng, r.lat, r.lng);
    if (dist <= maxM && (!best || dist < best.dist_m)) {
      best = { name: r.name, kind: r.kind, dist_m: Math.round(dist) };
    }
  }
  return best;
}

/** Estabelecimentos cadastrados pelo administrador (sobrevivem à reimportação). */
export function manualPlaces(): any[] {
  return db.prepare(`SELECT id, name, detail, tags, lat, lng, updated_at
    FROM local_addresses WHERE source = 'manual' ORDER BY name`).all();
}

export function addManualPlace(name: string, tags: string | null, detail: string | null,
  lat: number, lng: number): number {
  const r = db.prepare(`INSERT INTO local_addresses
    (kind, name, norm, detail, tags, lat, lng, updated_at, source)
    VALUES ('local', ?, ?, ?, ?, ?, ?, ?, 'manual')
    ON CONFLICT(kind, norm) DO UPDATE SET
      detail = excluded.detail, tags = excluded.tags, lat = excluded.lat,
      lng = excluded.lng, updated_at = excluded.updated_at, source = 'manual'`)
    .run(name.trim(), normalize(name), detail, tags ? normalize(tags) : null,
      lat, lng, Date.now());
  return Number(r.lastInsertRowid);
}

// ---------------------------------------------------------------
// Conferência de duplicados e importação em lote (planilha)
// ---------------------------------------------------------------

/** Palavras que não ajudam a comparar nomes ("de", "da", "ltda"...). */
const NAME_STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'ltda', 'me', 'eireli', 'sa', 's', 'epp']);
function nameTokens(s: string): Set<string> {
  return new Set(normalize(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !NAME_STOP.has(t)));
}
/** Parecença entre dois nomes (0 a 1): palavras em comum sobre o nome menor. */
export function nameSimilarity(a: string, b: string): number {
  const A = nameTokens(a), B = nameTokens(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  return common / Math.min(A.size, B.size);
}

export const NEAR_DUPLICATE_M = 80;

/**
 * Já existe este local? Mesmo nome (qualquer origem) ou nome parecido a
 * menos de 80 m. Nada é sobrescrito sem confirmação.
 */
export function findPlaceConflict(name: string, lat: number, lng: number):
  { kind: 'mesmo_nome' | 'parecido_perto'; id: number; name: string; source: string; dist_m: number } | null {
  const same = db.prepare(`SELECT id, name, source, lat, lng FROM local_addresses WHERE kind = 'local' AND norm = ?`)
    .get(normalize(name)) as any;
  if (same) return { kind: 'mesmo_nome', id: same.id, name: same.name, source: same.source, dist_m: Math.round(haversineM(lat, lng, same.lat, same.lng)) };
  // caixa de ~200 m em volta para não percorrer a base inteira
  const d = 0.002;
  const near = db.prepare(`SELECT id, name, source, lat, lng FROM local_addresses WHERE kind = 'local'
    AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`).all(lat - d, lat + d, lng - d, lng + d) as any[];
  for (const r of near) {
    const dist = haversineM(lat, lng, r.lat, r.lng);
    if (dist <= NEAR_DUPLICATE_M && nameSimilarity(name, r.name) >= 0.6) {
      return { kind: 'parecido_perto', id: r.id, name: r.name, source: r.source, dist_m: Math.round(dist) };
    }
  }
  return null;
}

export interface ImportRow { name: string; tags?: string | null; detail?: string | null; lat: number; lng: number }
export interface ImportResult {
  line: number; name: string;
  status: 'novo' | 'ja_existe' | 'possivel_duplicata' | 'repetido_na_planilha' | 'fora_da_area' | 'invalido';
  message: string; id?: number;
}

/**
 * Importa locais de uma planilha. Com `dryRun` só confere e mostra o que
 * aconteceria. Só entram linhas novas: o que já existe (mesmo nome) ou
 * parece já existir (nome parecido a menos de 80 m) é recusado, nunca
 * sobrescrito.
 */
export function importManualPlaces(rows: ImportRow[], area: { lat: number; lng: number; radiusM: number },
  dryRun: boolean): ImportResult[] {
  const out: ImportResult[] = [];
  const seen = new Map<string, number>();
  const accepted: { name: string; lat: number; lng: number }[] = [];
  const run = () => rows.forEach((r, i) => {
    const line = i + 2;               // linha 1 é o cabeçalho
    const name = String(r.name || '').trim().slice(0, 120);
    const lat = Number(r.lat), lng = Number(r.lng);
    const res = (status: ImportResult['status'], message: string, id?: number) =>
      out.push({ line, name: name || '(sem nome)', status, message, ...(id ? { id } : {}) });
    if (!name) return res('invalido', 'Sem nome.');
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
      return res('invalido', 'Latitude/longitude ausentes ou inválidas.');
    }
    const dist = haversineM(lat, lng, area.lat, area.lng);
    if (dist > area.radiusM) return res('fora_da_area', `A ${(dist / 1000).toFixed(1)} km do centro (limite ${(area.radiusM / 1000).toFixed(0)} km).`);
    const key = normalize(name);
    if (seen.has(key)) return res('repetido_na_planilha', `Mesmo nome da linha ${seen.get(key)}.`);
    const twin = accepted.find(a => haversineM(lat, lng, a.lat, a.lng) <= NEAR_DUPLICATE_M && nameSimilarity(name, a.name) >= 0.6);
    if (twin) return res('repetido_na_planilha', `Parecido com "${twin.name}", a menos de ${NEAR_DUPLICATE_M} m.`);
    seen.set(key, line);
    const c = findPlaceConflict(name, lat, lng);
    if (c?.kind === 'mesmo_nome') return res('ja_existe', `Já cadastrado ("${c.name}", ${c.source === 'manual' ? 'cadastro manual' : 'OpenStreetMap'}, a ${c.dist_m} m).`, c.id);
    if (c) return res('possivel_duplicata', `Parecido com "${c.name}" a ${c.dist_m} m. Confira; se for outro lugar, use um nome mais completo.`, c.id);
    accepted.push({ name, lat, lng });
    if (dryRun) return res('novo', 'Será cadastrado.');
    const id = addManualPlace(name, r.tags ? String(r.tags).slice(0, 200) : null,
      r.detail ? String(r.detail).slice(0, 200) : null, lat, lng);
    res('novo', 'Cadastrado.', id);
  });
  if (dryRun) run();
  else {
    db.exec('BEGIN');
    try { run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return out;
}

export function removeManualPlace(id: number): boolean {
  const r = db.prepare(`DELETE FROM local_addresses WHERE id = ? AND source = 'manual'`).run(id);
  return r.changes > 0;
}

interface StreetRow {
  /** nome normalizado da rua (igual para todas as de mesmo nome) */
  key: string;
  /** chave única na tabela: `key`, ou `key · localidade` para as repetidas */
  norm: string;
  name: string;
  /** localidade, preenchida só quando o nome se repete no município */
  detail: string | null;
  lat: number;
  lng: number;
}

/**
 * Separa os trechos de um mesmo nome em ruas distintas: trechos a menos de
 * `SAME_STREET_LINK_M` um do outro são a mesma rua; grupos mais distantes
 * são ruas diferentes que só compartilham o nome. O ponto de cada rua é um
 * trecho de verdade (o mais central do grupo), nunca uma média no vazio.
 * A mais próxima do centro da cidade fica com o nome simples; as outras
 * levam a localidade ("Rua Argentina", "Bragantina").
 */
export function splitStreet(key: string, name: string, pts: [number, number][],
  center: { lat: number; lng: number },
  places: { name: string; lat: number; lng: number }[]): StreetRow[] {
  // agrupamento por ligação simples (união de conjuntos)
  const parent = pts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (haversineM(pts[i][0], pts[i][1], pts[j][0], pts[j][1]) <= SAME_STREET_LINK_M) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, [number, number][]>();
  pts.forEach((p, i) => {
    const g = find(i);
    groups.set(g, [...(groups.get(g) || []), p]);
  });

  const clusters = [...groups.values()].map(g => {
    const mLat = g.reduce((s, p) => s + p[0], 0) / g.length;
    const mLng = g.reduce((s, p) => s + p[1], 0) / g.length;
    // o trecho mais perto da média: um ponto que está em cima da rua
    const rep = g.map(p => ({ p, d: haversineM(p[0], p[1], mLat, mLng) }))
      .sort((a, b) => a.d - b.d)[0].p;
    return { lat: rep[0], lng: rep[1], dist: haversineM(rep[0], rep[1], center.lat, center.lng) };
  }).sort((a, b) => a.dist - b.dist);

  const used = new Set<string>();
  return clusters.map((c, i) => {
    if (i === 0) return { key, norm: key, name, detail: null, lat: c.lat, lng: c.lng };
    // as repetidas levam a localidade mais próxima (distrito, vila, bairro)
    const near = places.map(p => ({ p, d: haversineM(c.lat, c.lng, p.lat, p.lng) }))
      .filter(x => x.d <= 4000).sort((a, b) => a.d - b.d)[0];
    let label = near ? near.p.name : `a ${(c.dist / 1000).toFixed(0)} km do centro`;
    for (let n = 2; used.has(normalize(label)); n++) label = `${label.replace(/ \(\d+\)$/, '')} (${n})`;
    used.add(normalize(label));
    return {
      key, norm: `${key}${SAME_NAME_SEP}${normalize(label)}`, name, detail: label,
      lat: c.lat, lng: c.lng,
    };
  });
}

interface OverpassElement {
  type: string;
  lat?: number; lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Baixa do OpenStreetMap (Overpass) todas as ruas com nome, bairros e
 * estabelecimentos dentro do município e regrava a tabela local.
 * Segmentos da mesma rua são agrupados pelo nome (média dos centros).
 */
export async function importAddressBase(): Promise<{ ruas: number; bairros: number; locais: number; total: number }> {
  const cityFull = getSetting('city_name');          // "Assis Chateaubriand - PR"
  const cityName = cityFull.split('-')[0].trim();
  const cLat = getSettingNum('center_lat'), cLng = getSettingNum('center_lng');
  const maxDistM = (getSettingNum('coverage_radius_km') + 15) * 1000;

  const query = `
[out:json][timeout:90];
area["name"="${cityName}"]["boundary"="administrative"]->.a;
(
  way(area.a)["highway"]["name"];
  node(area.a)["place"~"^(suburb|neighbourhood|quarter|village|hamlet)$"]["name"];
  nwr(area.a)["name"]["amenity"];
  nwr(area.a)["name"]["shop"];
  nwr(area.a)["name"]["leisure"];
  nwr(area.a)["name"]["tourism"];
  nwr(area.a)["name"]["healthcare"];
  nwr(area.a)["name"]["public_transport"];
  nwr(area.a)["name"]["office"];
  nwr(area.a)["name"]["craft"];
  nwr(area.a)["name"]["emergency"];
  way(area.a)["name"]["building"~"^(commercial|retail|supermarket|hospital|school|university|college|church|civic|public|industrial)$"];
  nwr(area.a)["addr:housenumber"]["addr:street"];
);
out center tags;`;

  let elements: OverpassElement[] | null = null;
  let lastErr = '';
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'AssisMotoTaxi/1.0 (importacao unica da base de enderecos da cidade)',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
      const data: any = await r.json();
      if (Array.isArray(data?.elements)) { elements = data.elements; break; }
      lastErr = 'resposta sem elementos';
    } catch (e: any) {
      lastErr = e?.name === 'TimeoutError' ? 'tempo esgotado' : String(e?.message || e);
    }
  }
  if (!elements) {
    throw new Error(`Não foi possível baixar a base do OpenStreetMap (${lastErr}). ` +
      'Tente novamente em alguns minutos.');
  }

  // junta os segmentos de rua pelo nome (separados depois por proximidade);
  // deduplica POIs e bairros
  const streets = new Map<string, { name: string; pts: [number, number][] }>();
  const suburbs = new Map<string, { name: string; lat: number; lng: number }>();
  const pois = new Map<string, { name: string; detail: string | null; tags: string | null; lat: number; lng: number }>();

  const addrPts: { streetNorm: string; street: string; number: number; lat: number; lng: number }[] = [];

  for (const el of elements) {
    const tags = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (haversineM(lat!, lng!, cLat, cLng) > maxDistM) continue; // fora do município

    // número de casa mapeado no OSM (raro na cidade, mas cada um vale ouro)
    if (tags['addr:housenumber'] && tags['addr:street']) {
      const n = parseInt(tags['addr:housenumber'], 10);
      if (Number.isInteger(n) && n > 0) {
        addrPts.push({
          streetNorm: normalize(tags['addr:street']), street: tags['addr:street'].trim(),
          number: n, lat: lat!, lng: lng!,
        });
      }
    }

    const name = (tags.name || '').trim();
    if (!name || name.length < 2) continue;
    const key = normalize(name);

    if (tags.highway) {
      const s = streets.get(key);
      if (s) s.pts.push([lat!, lng!]);
      else streets.set(key, { name, pts: [[lat!, lng!]] });
    } else if (tags.place) {
      if (!suburbs.has(key)) suburbs.set(key, { name, lat: lat!, lng: lng! });
    } else {
      if (!pois.has(key)) {
        const detail = [tags['addr:street'], tags['addr:housenumber']]
          .filter(Boolean).join(', ') || null;
        pois.set(key, { name, detail, tags: buildTags(tags), lat: lat!, lng: lng! });
      }
    }
  }

  if (streets.size + suburbs.size + pois.size < 10) {
    throw new Error('O OpenStreetMap devolveu quase nada para a cidade — base mantida como estava.');
  }

  // Uma rua por localidade. O mesmo nome se repete na cidade e nos distritos
  // do município: tirar a média de tudo jogava o ponto no meio do caminho,
  // a quilômetros de qualquer rua (e para fora da área de atendimento).
  const places = [...suburbs.values()];
  const streetRows: StreetRow[] = [];
  for (const [key, s] of streets) {
    streetRows.push(...splitStreet(key, s.name, s.pts, { lat: cLat, lng: cLng }, places));
  }

  // cada número de casa vai para a rua (daquele nome) mais próxima dele
  for (const p of addrPts) {
    const same = streetRows.filter(r => r.key === p.streetNorm)
      .map(r => ({ r, d: haversineM(p.lat, p.lng, r.lat, r.lng) }))
      .sort((a, b) => a.d - b.d)[0];
    if (same) { p.streetNorm = same.r.norm; p.street = same.r.name; }
  }

  const t = Date.now();
  db.exec('BEGIN');
  try {
    // só o que veio do OSM é regravado; cadastros manuais ficam intactos
    db.prepare(`DELETE FROM local_addresses WHERE source = 'osm'`).run();
    const ins = db.prepare(`INSERT OR IGNORE INTO local_addresses
      (kind, name, norm, detail, tags, lat, lng, updated_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'osm')`);
    for (const r of streetRows) ins.run('rua', r.name, r.norm, r.detail, null, r.lat, r.lng, t);
    for (const [key, b] of suburbs) ins.run('bairro', b.name, key, null, null, b.lat, b.lng, t);
    for (const [key, p] of pois) ins.run('local', p.name, key, p.detail, p.tags, p.lat, p.lng, t);

    // números de casa do OSM — os confirmados por passageiros têm prioridade
    // (INSERT OR IGNORE não sobrescreve o que já foi aprendido)
    db.prepare(`DELETE FROM address_points WHERE source = 'osm'`).run();
    const insPt = db.prepare(`INSERT OR IGNORE INTO address_points
      (street_norm, street_name, number, lat, lng, source, hits, updated_at)
      VALUES (?, ?, ?, ?, ?, 'osm', 1, ?)`);
    for (const p of addrPts) insPt.run(p.streetNorm, p.street, p.number, p.lat, p.lng, t);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  setSetting('address_base_updated_at', String(t));
  setSetting('address_base_version', BASE_VERSION);

  return { ruas: streetRows.length, bairros: suburbs.size, locais: pois.size,
    total: streetRows.length + suburbs.size + pois.size };
}

/**
 * Bases baixadas antes de uma correção da importação continuam com os dados
 * antigos. Na subida do servidor, se a base existe e é de versão anterior,
 * baixa de novo em segundo plano. Se o OpenStreetMap não responder, a base
 * atual fica como está e a próxima subida tenta outra vez.
 */
export async function refreshOutdatedBase(): Promise<'atual' | 'vazia' | 'atualizada' | 'falhou'> {
  if (!baseCount()) return 'vazia';
  if (getSetting('address_base_version') === BASE_VERSION) return 'atual';
  try {
    const r = await importAddressBase();
    console.log(`[base de endereços] atualizada para o formato ${BASE_VERSION}: ` +
      `${r.ruas} rua(s), ${r.bairros} bairro(s), ${r.locais} local(is).`);
    return 'atualizada';
  } catch (e: any) {
    console.error(`[base de endereços] não foi possível atualizar agora: ${e?.message || e}`);
    return 'falhou';
  }
}
