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
  /** número de casa digitado pelo usuário (coordenada fica no centro da rua) */
  number?: string;
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

export function baseCount(): number {
  try {
    return (db.prepare('SELECT COUNT(*) c FROM local_addresses').get() as any).c;
  } catch { return 0; }
}

export function baseStats(): { ruas: number; bairros: number; locais: number; total: number; updated_at: number | null } {
  const rows = db.prepare(
    'SELECT kind, COUNT(*) c FROM local_addresses GROUP BY kind').all() as any[];
  const by: Record<string, number> = {};
  for (const r of rows) by[r.kind] = r.c;
  const upd = Number(getSetting('address_base_updated_at') || '');
  return {
    ruas: by.rua || 0, bairros: by.bairro || 0, locais: by.local || 0,
    total: (by.rua || 0) + (by.bairro || 0) + (by.local || 0),
    updated_at: Number.isFinite(upd) && upd > 0 ? upd : null,
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

  // extrai número de casa (fim ou meio: "rua x 123" / "rua x, 123 centro")
  let houseNumber: string | undefined;
  const numMatch = qn.match(/(?:^|\s)(\d{1,5})(?:\s|$)/);
  if (numMatch) {
    houseNumber = numMatch[1];
    qn = qn.replace(numMatch[0], ' ');
  }

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
  let rows = db.prepare(
    `SELECT kind, name, norm, tags, detail, lat, lng FROM local_addresses
     WHERE ${where} LIMIT 60`).all(...effective.flatMap(t => [t, t])) as any[];

  // nada na busca exata? tenta tolerando erro de digitação
  // ("av tupanssi" → "Avenida Tupassi")
  if (!rows.length) {
    const all = db.prepare(
      'SELECT kind, name, norm, tags, detail, lat, lng FROM local_addresses').all() as any[];
    rows = all.filter(r => {
      const words = `${r.norm} ${r.tags || ''}`.split(/\s+/).filter(Boolean);
      return effective.every(t => fuzzyHasToken(words, t));
    }).slice(0, 30);
  }

  const first = effective[0];
  const typeTokens = tokens.filter(t => TYPE_WORDS.has(t));
  const scored = rows.map(r => {
    let score = 0;
    if (r.norm === qn.trim()) score += 100;                 // nome exato
    if (r.norm.startsWith(first)) score += 30;              // começa pelo termo
    if (effective.every(t => r.norm.includes(t))) score += 15; // termo no nome > só na categoria
    for (const t of typeTokens) if (r.norm.includes(t)) score += 10;
    if (houseNumber && r.kind === 'rua') score += 20;       // número pede rua
    if (r.kind === 'local') score += 5;                     // POI é mais específico
    score -= r.norm.length / 50;                            // nomes curtos primeiro
    return { r, score };
  }).sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ r }) => ({
    kind: r.kind, name: r.name, detail: r.detail || null,
    lat: r.lat, lng: r.lng,
    number: houseNumber && r.kind === 'rua' ? houseNumber : undefined,
  }));
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

export function removeManualPlace(id: number): boolean {
  const r = db.prepare(`DELETE FROM local_addresses WHERE id = ? AND source = 'manual'`).run(id);
  return r.changes > 0;
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

  // agrupa segmentos de rua pelo nome; deduplica POIs e bairros
  const streets = new Map<string, { name: string; sumLat: number; sumLng: number; n: number }>();
  const suburbs = new Map<string, { name: string; lat: number; lng: number }>();
  const pois = new Map<string, { name: string; detail: string | null; tags: string | null; lat: number; lng: number }>();

  for (const el of elements) {
    const tags = el.tags || {};
    const name = (tags.name || '').trim();
    if (!name || name.length < 2) continue;
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (haversineM(lat!, lng!, cLat, cLng) > maxDistM) continue; // fora do município
    const key = normalize(name);

    if (tags.highway) {
      const s = streets.get(key);
      if (s) { s.sumLat += lat!; s.sumLng += lng!; s.n++; }
      else streets.set(key, { name, sumLat: lat!, sumLng: lng!, n: 1 });
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

  const t = Date.now();
  db.exec('BEGIN');
  try {
    // só o que veio do OSM é regravado; cadastros manuais ficam intactos
    db.prepare(`DELETE FROM local_addresses WHERE source = 'osm'`).run();
    const ins = db.prepare(`INSERT OR IGNORE INTO local_addresses
      (kind, name, norm, detail, tags, lat, lng, updated_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'osm')`);
    for (const [key, s] of streets) {
      ins.run('rua', s.name, key, null, null, s.sumLat / s.n, s.sumLng / s.n, t);
    }
    for (const [key, b] of suburbs) ins.run('bairro', b.name, key, null, null, b.lat, b.lng, t);
    for (const [key, p] of pois) ins.run('local', p.name, key, p.detail, p.tags, p.lat, p.lng, t);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  setSetting('address_base_updated_at', String(t));

  return { ruas: streets.size, bairros: suburbs.size, locais: pois.size,
    total: streets.size + suburbs.size + pois.size };
}
