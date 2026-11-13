import { haversineM, ApiError } from './util.ts';
import { getSetting, getSettingNum } from './db.ts';
import {
  googleEnabled, googleRoute, googleAutocomplete, googlePlaceDetails, googleReverse,
} from './google-maps.ts';
import { searchBase, nearestBase } from './address-base.ts';

const UA = 'AssisMotoTaxi/1.0 (plataforma de mototaxi; contato: admin local)';

export interface RouteResult {
  distance_m: number;
  duration_s: number;
  /** GeoJSON LineString coordinates [[lng,lat],...] */
  geometry: number[][];
  /** true quando calculado por estimativa (sem serviço de rotas) */
  estimated: boolean;
  /** quem calculou: google | osrm | estimativa */
  provider: 'google' | 'osrm' | 'estimativa';
  /** modo de deslocamento realmente usado */
  mode: 'two_wheeler' | 'drive' | 'estimativa';
  /** true quando o modo de motocicleta não estava disponível e caiu para carro */
  mode_fallback?: boolean;
}

export interface GeoPoint { lat: number; lng: number; text?: string }

function offline(): boolean { return process.env.GEO_OFFLINE === '1'; }

/**
 * Rota real por vias.
 *
 * 1º Google Routes API em modo TWO_WHEELER (motocicleta de verdade);
 * 2º OSRM (perfil driving) quando não há chave do Google;
 * 3º estimativa haversine × 1.3, sempre marcada como estimativa.
 *
 * O resultado diz quem calculou e em que modo — a interface mostra isso em
 * vez de apresentar rota de carro como se fosse de moto.
 */
export async function route(from: GeoPoint, to: GeoPoint): Promise<RouteResult> {
  if (!offline() && googleEnabled()) {
    try {
      const g = await googleRoute(from, to);
      if (g) {
        return {
          distance_m: g.distance_m,
          duration_s: g.duration_s,
          geometry: g.geometry,
          estimated: false,
          provider: 'google',
          mode: g.mode === 'TWO_WHEELER' ? 'two_wheeler' : 'drive',
          mode_fallback: g.fellBackToDrive,
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
  /** coordenada; nula nas sugestões do Google até o usuário escolher uma */
  lat: number;
  lng: number;
  /** metros até o centro da cidade — usado para ordenar e avisar o usuário */
  distance_m: number;
  in_coverage: boolean;
  source: 'local' | 'osm' | 'google';
  approx?: boolean;
  /** identificador do Google; resolvido em /api/geo/place */
  place_id?: string;
  /** linha secundária (bairro, cidade) nas sugestões do Google */
  secondary?: string;
  /** true quando a coordenada ainda precisa ser resolvida */
  needs_details?: boolean;
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function decorate(text: string, lat: number, lng: number, source: 'local' | 'osm'): GeoSearchResult {
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
 *  2. a consulta ao Nominatim é feita com o nome da cidade anexado;
 *  3. os resultados são ordenados pela distância ao centro e os de fora da
 *     área de cobertura vão para o fim, marcados como fora de área.
 */
export async function searchAddress(q: string, sessionToken?: string): Promise<GeoSearchResult[]> {
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
    if (hit.number) item.approx = true;   // coordenada = centro da rua
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

  // Base completa e com boas respostas: devolve já, sem chamada externa.
  if (baseHits >= 3) return results.slice(0, 8);

  // 2) Google Places (New): ruas, números, estabelecimentos e bairros.
  // A coordenada só é buscada quando o usuário escolhe (economiza chamada).
  if (!offline() && googleEnabled()) {
    try {
      const preds = await googleAutocomplete(q, sessionToken);
      if (preds?.length) {
        for (const p of preds) {
          results.push({
            text: p.text, secondary: p.secondary,
            lat: NaN, lng: NaN, distance_m: 0, in_coverage: true,
            source: 'google', place_id: p.place_id, needs_details: true,
          });
        }
        // com Google respondendo, basta ele + os pontos locais
        return results.slice(0, 8);
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
          signal: AbortSignal.timeout(6000),
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
 * Resolve a sugestão do Google em coordenada + endereço, já validando a
 * área de cobertura. Chamado só quando o usuário escolhe um item da lista.
 */
export async function resolvePlace(placeId: string, sessionToken?: string):
  Promise<GeoSearchResult> {
  const place = await googlePlaceDetails(placeId, sessionToken);
  if (!place) throw new ApiError(404, 'Não conseguimos localizar esse endereço. Tente outro.');
  const item = decorate(place.address || place.text, place.lat, place.lng, 'google');
  item.place_id = place.place_id;
  item.secondary = place.address;
  return item;
}

/**
 * Reverse geocoding. Quando o serviço não responde, devolve as coordenadas de
 * forma explícita — nunca inventa um endereço que o usuário possa confundir
 * com o real (`exact: false` sinaliza isso à interface).
 */
export async function reverseGeocode(lat: number, lng: number):
  Promise<{ text: string; exact: boolean }> {
  if (!offline() && googleEnabled()) {
    try {
      const g = await googleReverse(lat, lng);
      if (g) return g;
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
