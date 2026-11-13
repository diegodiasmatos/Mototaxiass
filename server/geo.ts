import { haversineM, ApiError } from './util.ts';
import { getSetting, getSettingNum } from './db.ts';
import { mapboxEnabled, mapboxRoute, mapboxSearch, mapboxReverse } from './mapbox.ts';
import { searchBase, nearestBase } from './address-base.ts';

const UA = 'AssisMotoTaxi/1.0 (plataforma de mototaxi; contato: admin local)';

export interface RouteResult {
  distance_m: number;
  duration_s: number;
  /** GeoJSON LineString coordinates [[lng,lat],...] */
  geometry: number[][];
  /** true quando calculado por estimativa (sem serviço de rotas) */
  estimated: boolean;
  /** quem calculou: mapbox | osrm | estimativa */
  provider: 'mapbox' | 'osrm' | 'estimativa';
  /** modo de deslocamento realmente usado (nenhum dos serviços tem perfil de moto) */
  mode: 'drive' | 'estimativa';
}

export interface GeoPoint { lat: number; lng: number; text?: string }

function offline(): boolean { return process.env.GEO_OFFLINE === '1'; }

/**
 * Rota real por vias.
 *
 * 1º Mapbox Directions API (perfil driving), quando há token configurado;
 * 2º OSRM (perfil driving) quando não há token ou o Mapbox falha;
 * 3º estimativa haversine × 1.3, sempre marcada como estimativa.
 *
 * O resultado diz quem calculou e em que modo — a interface mostra isso em
 * vez de apresentar rota de carro como se fosse de moto.
 */
export async function route(from: GeoPoint, to: GeoPoint): Promise<RouteResult> {
  if (!offline() && mapboxEnabled()) {
    try {
      const m = await mapboxRoute(from, to);
      if (m) {
        return {
          distance_m: m.distance_m,
          duration_s: m.duration_s,
          geometry: m.geometry,
          estimated: false,
          provider: 'mapbox',
          mode: 'drive',
        };
      }
    } catch { /* cai para OSRM */ }
  }

  if (!offline()) {
    try {
      const base = process.env.OSRM_BASE || 'https://router.project-osrm.org';
      const url = `${base}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}` +
        `?overview=full&geometries=geojson&alternatives=false`;
      const r = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const data: any = await r.json();
        const rt = data?.routes?.[0];
        if (rt && Number.isFinite(rt.distance)) {
          return {
            distance_m: Math.round(rt.distance),
            duration_s: Math.round(rt.duration),
            geometry: rt.geometry?.coordinates ?? [],
            estimated: false,
            provider: 'osrm',
            mode: 'drive',
          };
        }
      }
    } catch { /* cai na estimativa */ }
  }

  const straight = haversineM(from.lat, from.lng, to.lat, to.lng);
  const dist = Math.round(straight * 1.3);
  return {
    distance_m: dist,
    duration_s: Math.round(dist / (25000 / 3600)), // ~25 km/h urbano
    geometry: [[from.lng, from.lat], [to.lng, to.lat]],
    estimated: true,
    provider: 'estimativa',
    mode: 'estimativa',
  };
}

/** Pontos de referência locais de Assis Chateaubriand (sempre pesquisáveis). */
const LOCAL_PLACES: { name: string; lat: number; lng: number; tags?: string }[] = [
  { name: 'Centro', lat: -24.4156, lng: -53.5216, tags: 'centro praça matriz' },
  { name: 'Rodoviária Municipal', lat: -24.4190, lng: -53.5180, tags: 'rodoviaria onibus terminal' },
  { name: 'Hospital Municipal', lat: -24.4120, lng: -53.5250, tags: 'hospital pronto socorro upa saude' },
  { name: 'Lago Municipal', lat: -24.4080, lng: -53.5160, tags: 'lago parque lazer' },
  { name: 'Prefeitura Municipal', lat: -24.4147, lng: -53.5203, tags: 'prefeitura paço municipal' },
  { name: 'Jardim Paraná', lat: -24.4230, lng: -53.5150, tags: 'bairro jardim parana' },
  { name: 'Jardim Europa', lat: -24.4190, lng: -53.5120, tags: 'bairro jardim europa' },
  { name: 'Jardim América', lat: -24.3970, lng: -53.5123, tags: 'bairro jardim america' },
  { name: 'Jardim Progresso', lat: -24.3852, lng: -53.5195, tags: 'bairro jardim progresso' },
  { name: 'Jardim Mônaco', lat: -24.4240, lng: -53.5190, tags: 'bairro jardim monaco' },
];

export interface GeoSearchResult {
  text: string;
  lat: number;
  lng: number;
  /** metros até o centro da cidade — usado para ordenar e avisar o usuário */
  distance_m: number;
  in_coverage: boolean;
  source: 'local' | 'osm' | 'mapbox';
  approx?: boolean;
  /** presentes quando a busca foi "rua + número" na base local */
  street?: string;
  number?: string;
  /** exato = ponto conhecido; interpolado = entre dois números conhecidos;
   *  centro = centro da rua (o app pede ajuste do pino) */
  number_how?: 'exato' | 'interpolado' | 'centro';
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function decorate(text: string, lat: number, lng: number,
  source: GeoSearchResult['source']): GeoSearchResult {
  const cLat = getSettingNum('center_lat'), cLng = getSettingNum('center_lng');
  const radius = getSettingNum('coverage_radius_km') * 1000;
  const distance_m = Math.round(haversineM(lat, lng, cLat, cLng));
  return { text, lat, lng, distance_m, in_coverage: distance_m <= radius, source };
}

/**
 * Busca de endereços priorizando a cidade atendida.
 *
 * A V1 usava apenas `viewbox` do Nominatim (±25 km), o que trazia resultados de
 * municípios vizinhos (Cafelândia, Tupãssi, Palotina…) sem qualquer ordenação —
 * o passageiro escolhia "Rodoviária" e recebia a de outra cidade. Agora:
 *  1. pontos de referência locais entram sempre;
 *  2. o Mapbox (quando há token) busca só dentro da caixa da área atendida;
 *  3. a consulta ao Nominatim é feita com o nome da cidade anexado;
 *  4. os resultados de fora da área de cobertura vão para o fim, marcados
 *     como fora de área.
 */
export async function searchAddress(q: string): Promise<GeoSearchResult[]> {
  const cLat = getSettingNum('center_lat'), cLng = getSettingNum('center_lng');
  const cityFull = getSetting('city_name');              // "Assis Chateaubriand - PR"
  const cityName = cityFull.split('-')[0].trim();        // "Assis Chateaubriand"
  const qn = normalize(q);
  const results: GeoSearchResult[] = [];

  // 1) base local de endereços (todas as ruas/bairros/locais da cidade,
  //    importados do OpenStreetMap). Instantânea e completa; quando tem
  //    resultado suficiente, nem precisamos de serviço externo.
  for (const hit of searchBase(q)) {
    const label = hit.kind === 'rua' ? hit.name
      : hit.kind === 'bairro' ? `${hit.name} (bairro)` : hit.name;
    const line = [
      label + (hit.number ? `, ${hit.number}` : ''),
      hit.detail,
      cityName,
    ].filter(Boolean).join(', ');
    const item = decorate(line, hit.lat, hit.lng, 'local');
    if (hit.number) {
      item.street = hit.name;
      item.number = hit.number;
      item.number_how = hit.number_how;
      // só o ponto exato dispensa ajuste; interpolado/centro são aproximados
      item.approx = hit.number_how !== 'exato';
    }
    results.push(item);
  }
  const baseHits = results.length;

  // 1b) pontos de referência embutidos (úteis enquanto a base não foi baixada)
  for (const p of LOCAL_PLACES) {
    const hay = normalize(`${p.name} ${p.tags || ''}`);
    if (qn.length >= 2 && (hay.includes(qn) || qn.split(/\s+/).every(w => w.length < 3 || hay.includes(w)))) {
      if (results.some(x => normalize(x.text).startsWith(normalize(p.name)))) continue;
      results.push(decorate(`${p.name}, ${cityName}`, p.lat, p.lng, 'local'));
    }
  }

  // A base achou algo: devolve NA HORA. Esperar serviço externo aqui é o que
  // deixava a busca lenta — e o Nominatim ainda podia chutar outra cidade.
  if (baseHits >= 1) return results.slice(0, 8);

  // 2) Mapbox Geocoding: ruas, números e bairros, já com a coordenada e
  //    limitado à caixa da área atendida.
  if (!offline() && mapboxEnabled()) {
    try {
      const found = await mapboxSearch(q);
      if (found?.length) {
        for (const p of found) {
          // mesmo ponto que um local já listado: não repete
          if (results.some(x => haversineM(x.lat, x.lng, p.lat, p.lng) < 40)) continue;
          const item = decorate(p.text, p.lat, p.lng, 'mapbox');
          // bairro/localidade: o pino cai no centro da área, não num endereço
          if (!p.exact) item.approx = true;
          results.push(item);
        }
        // com o Mapbox respondendo, basta ele + os pontos locais; mantém a
        // ordem de relevância e manda o que ficou fora da área para o fim
        // (a caixa de busca é um quadrado; a cobertura, um círculo)
        return [...results.filter(x => x.in_coverage), ...results.filter(x => !x.in_coverage)]
          .slice(0, 8);
      }
    } catch { /* cai para o OSM abaixo */ }
  }

  // 3) Nominatim (OpenStreetMap), com a cidade no texto da consulta
  if (!offline()) {
    const base = process.env.NOMINATIM_BASE || 'https://nominatim.openstreetmap.org';
    const d = 0.22;
    const attempts = [
      // consulta ancorada na cidade — evita o vizinho com nome parecido
      `${base}/search?format=jsonv2&limit=8&countrycodes=br&addressdetails=1` +
      `&q=${encodeURIComponent(`${q}, ${cityName}, Paraná`)}`,
      // reserva: dentro da caixa geográfica, caso a consulta ancorada falhe
      `${base}/search?format=jsonv2&limit=8&countrycodes=br&addressdetails=1&bounded=1` +
      `&viewbox=${cLng - d},${cLat - d},${cLng + d},${cLat + d}&q=${encodeURIComponent(q)}`,
    ];
    for (const url of attempts) {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR' },
          // curto de propósito: é só reserva — melhor "nada encontrado" rápido
          // do que o passageiro olhando um spinner por 12 segundos
          signal: AbortSignal.timeout(3500),
        });
        if (!r.ok) continue;
        const data = await r.json() as any[];
        if (!Array.isArray(data)) continue;
        for (const p of data) {
          const lat = Number(p.lat), lng = Number(p.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
          const a = p.address || {};
          const line = [
            p.name || a.road || a.suburb,
            a.house_number,
            a.suburb || a.neighbourhood,
            a.city || a.town || a.village || a.municipality,
          ].filter(Boolean).join(', ') || String(p.display_name).split(',').slice(0, 3).join(',');
          const item = decorate(line, lat, lng, 'osm');
          // evita duplicados muito próximos (mesmo ponto vindo das duas consultas)
          if (results.some(x => haversineM(x.lat, x.lng, lat, lng) < 40)) continue;
          results.push(item);
        }
        // a primeira consulta já trouxe resultados dentro da área: basta
        if (results.some(x => x.in_coverage)) break;
      } catch { /* tenta a próxima */ }
    }
  }

  // 4) ordena só o que veio de fora (OSM): dentro da área primeiro, depois
  //    pela distância ao centro. Os resultados da base local mantêm a ordem
  //    de relevância da busca.
  const localPart = results.filter(x => x.source !== 'osm');
  const osmPart = results.filter(x => x.source === 'osm').sort((a, b) =>
    (a.in_coverage === b.in_coverage ? 0 : a.in_coverage ? -1 : 1) || a.distance_m - b.distance_m);

  return [...localPart, ...osmPart].slice(0, 8);
}

/**
 * Reverse geocoding. Quando o serviço não responde, devolve as coordenadas de
 * forma explícita — nunca inventa um endereço que o usuário possa confundir
 * com o real (`exact: false` sinaliza isso à interface).
 */
export async function reverseGeocode(lat: number, lng: number):
  Promise<{ text: string; exact: boolean }> {
  if (!offline() && mapboxEnabled()) {
    try {
      const m = await mapboxReverse(lat, lng);
      if (m) return m;
    } catch { /* cai para o Nominatim */ }
  }
  if (!offline()) {
    try {
      const base = process.env.NOMINATIM_BASE || 'https://nominatim.openstreetmap.org';
      const url = `${base}/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}`;
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR' },
        signal: AbortSignal.timeout(6000),
      });
      if (r.ok) {
        const data: any = await r.json();
        const a = data?.address || {};
        const line = [
          a.road || data?.name,
          a.house_number,
          a.suburb || a.neighbourhood,
          a.city || a.town || a.village,
        ].filter(Boolean).join(', ');
        if (line) return { text: line, exact: true };
        if (data?.display_name) {
          return { text: String(data.display_name).split(',').slice(0, 4).join(','), exact: true };
        }
      }
    } catch { /* fallback */ }
  }
  // Serviços externos indisponíveis: rua mais próxima da base local,
  // claramente marcada como aproximada — nunca um endereço inventado.
  const near = nearestBase(lat, lng);
  if (near) {
    return { text: `Perto de ${near.name} (±${near.dist_m} m)`, exact: false };
  }
  return { text: `Ponto no mapa (${lat.toFixed(5)}, ${lng.toFixed(5)})`, exact: false };
}

/** Valida que o ponto está dentro da área de cobertura configurada. */
export function assertInCoverage(p: GeoPoint, label: string): void {
  const cLat = getSettingNum('center_lat'), cLng = getSettingNum('center_lng');
  const radius = getSettingNum('coverage_radius_km') * 1000;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) ||
      Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
    throw new ApiError(400, `Coordenadas inválidas em ${label}.`);
  }
  const d = haversineM(p.lat, p.lng, cLat, cLng);
  if (d > radius) {
    throw new ApiError(422,
      `O ponto de ${label} está fora da área de cobertura (${getSetting('city_name')}).`);
  }
}
