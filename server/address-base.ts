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

  const where = effective.map(() => "norm LIKE '%' || ? || '%'").join(' AND ');
  const rows = db.prepare(
    `SELECT kind, name, norm, detail, lat, lng FROM local_addresses
     WHERE ${where} LIMIT 60`).all(...effective) as any[];

  const first = effective[0];
  const typeTokens = tokens.filter(t => TYPE_WORDS.has(t));
  const scored = rows.map(r => {
    let score = 0;
    if (r.norm === qn.trim()) score += 100;                 // nome exato
    if (r.norm.startsWith(first)) score += 30;              // começa pelo termo
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
  const pois = new Map<string, { name: string; detail: string | null; lat: number; lng: number }>();

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
        pois.set(key, { name, detail, lat: lat!, lng: lng! });
      }
    }
  }

  if (streets.size + suburbs.size + pois.size < 10) {
    throw new Error('O OpenStreetMap devolveu quase nada para a cidade — base mantida como estava.');
  }

  const t = Date.now();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM local_addresses').run();
    const ins = db.prepare(`INSERT OR IGNORE INTO local_addresses
      (kind, name, norm, detail, lat, lng, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const [key, s] of streets) {
      ins.run('rua', s.name, key, null, s.sumLat / s.n, s.sumLng / s.n, t);
    }
    for (const [key, b] of suburbs) ins.run('bairro', b.name, key, null, b.lat, b.lng, t);
    for (const [key, p] of pois) ins.run('local', p.name, key, p.detail, p.lat, p.lng, t);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  setSetting('address_base_updated_at', String(t));

  return { ruas: streets.size, bairros: suburbs.size, locais: pois.size,
    total: streets.size + suburbs.size + pois.size };
}
