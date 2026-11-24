import { haversineM, ApiError } from './util.ts';
import { getSetting, getSettingNum } from './db.ts';
import { mapboxEnabled, mapboxRoute, mapboxSearch, mapboxReverse } from './mapbox.ts';
import {
  googleEnabled, googleRoute, googleAutocomplete, googlePlaceDetails, googleReverse,
} from './google-maps.ts';
import { searchBase, nearestBase, referencePlaces, neighbourhoods } from './address-base.ts';
import { locateHouseNumber } from './house-number.ts';

const UA = 'AssisMotoTaxi/1.0 (plataforma de mototaxi; contato: admin local)';

export interface RouteResult {
  distance_m: number;
  duration_s: number;
  /** GeoJSON LineString coordinates [[lng,lat],...] */
  geometry: number[][];
  /** true quando calculado por estimativa (sem serviço de rotas) */
  estimated: boolean;
  /** quem calculou: google | mapbox | osrm | estimativa */
  provider: 'google' | 'mapbox' | 'osrm' | 'estimativa';
  /** modo de deslocamento realmente usado (só o Google tem perfil de moto) */
  mode: 'two_wheeler' | 'drive' | 'estimativa';
  /** true quando o Google não tinha rota de moto para o trajeto e usou a de carro */
  mode_fallback?: boolean;
}

export interface GeoPoint { lat: number; lng: number; text?: string }

function offline(): boolean { return process.env.GEO_OFFLINE === '1'; }

/**
 * Rota real por vias.
 *
 * 1º Google Routes API em modo motocicleta, quando há chave configurada;
 * 2º Mapbox Directions API (perfil driving), quando há token configurado;
 * 3º OSRM (perfil driving) quando nenhum dos dois responde;
 * 4º estimativa haversine × 1.3, sempre marcada como estimativa.
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
    } catch { /* cai para o Mapbox/OSRM */ }
  }

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
  /** coordenada; ausente (NaN → null) nas sugestões do Google até a pessoa escolher uma */
  lat: number;
  lng: number;
  /** metros até o centro da cidade — usado para ordenar e avisar o usuário */
  distance_m: number;
  in_coverage: boolean;
  source: 'local' | 'osm' | 'mapbox' | 'google';
  /** o que é: bairro, ponto de referência, rua ou endereço vindo de serviço externo */
  kind?: 'bairro' | 'local' | 'rua' | 'endereco' | 'google';
  approx?: boolean;
  /** sugestão do Google: identificador do lugar, resolvido em /api/geo/place */
  place_id?: string;
  /** sugestão do Google: endereço resumido mostrado sob o nome */
  secondary?: string;
  /** true quando a coordenada ainda precisa ser buscada (ao escolher) */
  needs_details?: boolean;
  /** presentes quando a busca foi "rua + número" na base local */
  street?: string;
  number?: string;
  /** exato = ponto conhecido; localizado = posição do número vinda do
   *  Google/Mapbox; interpolado = entre dois números conhecidos;
   *  centro = centro da rua (o app pede ajuste do pino) */
  number_how?: 'exato' | 'localizado' | 'interpolado' | 'centro';
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
 *  2. o Google (quando há chave) sugere lojas, locais e ruas pelo nome, só
 *     dentro da área atendida — inclusive junto com os resultados da base;
 *  3. o Mapbox (quando há token) busca só dentro da caixa da área atendida;
 *  4. a consulta ao Nominatim é feita com o nome da cidade anexado;
 *  5. os resultados de fora da área de cobertura vão para o fim, marcados
 *     como fora de área.
 *
 * `sessionToken` identifica a digitação de uma pessoa: o Google cobra a
 * digitação + a escolha como uma sessão só.
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
    item.kind = hit.kind;
    if (hit.number) {
      item.street = hit.name;
      item.number = hit.number;
      item.number_how = hit.number_how;
      // só o ponto conhecido dispensa ajuste; interpolado/centro são aproximados
      item.approx = hit.number_how !== 'exato';
    }
    results.push(item);
  }
  const baseHits = results.length;

  // 1a) Número de casa sem ponto confirmado: pergunta a quem conhece
  //     numeração (Google, depois Mapbox). Só para a rua mais provável — a
  //     primeira da lista dentro da área — para não multiplicar chamadas.
  if (!offline()) {
    const alvo = results.find(x => x.number && x.street && x.in_coverage && x.number_how !== 'exato');
    if (alvo) {
      const loc = await locateHouseNumber(alvo.street!, Number(alvo.number), alvo);
      if (loc) {
        const exato = decorate(alvo.text, loc.lat, loc.lng, 'local');
        Object.assign(alvo, {
          lat: exato.lat, lng: exato.lng, distance_m: exato.distance_m,
          in_coverage: exato.in_coverage, number_how: 'localizado', approx: false,
        });
      }
    }
  }

  // 1b) pontos de referência embutidos (úteis enquanto a base não foi baixada)
  for (const p of LOCAL_PLACES) {
    const hay = normalize(`${p.name} ${p.tags || ''}`);
    if (qn.length >= 2 && (hay.includes(qn) || qn.split(/\s+/).every(w => w.length < 3 || hay.includes(w)))) {
      // já listado pela base com o MESMO nome (não basta começar igual:
      // "Centro de Eventos" não é o bairro Centro)
      if (results.some(x => normalize(x.text).split(',')[0].replace(/\s*\(bairro\)$/, '') === normalize(p.name))) continue;
      const item = decorate(`${p.name}, ${cityName}`, p.lat, p.lng, 'local');
      item.kind = /\bbairro\b/.test(p.tags || '') || p.name === 'Centro' ? 'bairro' : 'local';
      if (item.kind === 'bairro') item.approx = true;
      // nome digitado por inteiro ("centro"): vai para o topo da lista
      if (normalize(p.name) === qn) results.unshift(item); else results.push(item);
    }
  }

  // 1c) Google Places: lojas, locais e ruas pelo nome, só na área atendida.
  //     A coordenada é buscada quando a pessoa escolhe (/api/geo/place).
  //     "Rua + número" já resolvido pela base não precisa dele.
  const ordered = () =>
    [...results.filter(x => x.in_coverage), ...results.filter(x => !x.in_coverage)];
  if (!offline() && googleEnabled() && !results.some(x => x.number)) {
    try {
      const preds = await googleAutocomplete(q, sessionToken);
      const fromGoogle: GeoSearchResult[] = [];
      for (const p of preds ?? []) {
        // mesmo nome de algo que a base já listou: não repete
        const pn = normalize(p.text);
        if (results.some(x => normalize(x.text).split(',')[0].replace(/\s*\(bairro\)$/, '') === pn)) continue;
        fromGoogle.push({
          text: p.text, secondary: p.secondary,
          lat: NaN, lng: NaN, distance_m: 0, in_coverage: true,
          source: 'google', kind: 'google', place_id: p.place_id, needs_details: true,
        });
      }
      if (fromGoogle.length) {
        // a lista tem 8 linhas: a base não pode ocupar todas e esconder as lojas
        const keepLocal = Math.max(8 - fromGoogle.length, Math.min(4, results.length));
        return [...ordered().slice(0, keepLocal), ...fromGoogle].slice(0, 8);
      }
    } catch { /* Google fora do ar: segue com a base e os outros serviços */ }
  }

  // A base achou algo: devolve NA HORA. Esperar serviço externo aqui é o que
  // deixava a busca lenta — e o Nominatim ainda podia chutar outra cidade.
  // O que está dentro da área atendida vem primeiro (a rua de mesmo nome de
  // um distrito distante não pode esconder a da cidade).
  if (baseHits >= 1) return ordered().slice(0, 8);

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
          item.kind = 'endereco';
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
          item.kind = 'endereco';
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
 * Sugestões para antes de digitar: pontos de referência e bairros que
 * EXISTEM na base local (ou cadastrados pela central). Sem base baixada,
 * usa só os pontos embutidos no código.
 */
export function searchSuggestions(): { referencias: GeoSearchResult[]; bairros: GeoSearchResult[] } {
  const cityName = getSetting('city_name').split('-')[0].trim();
  const fmt = (name: string, detail: string | null) => [name, detail, cityName].filter(Boolean).join(', ');
  const referencias = referencePlaces().map(h => {
    const it = decorate(fmt(h.name, h.detail), h.lat, h.lng, 'local');
    it.kind = 'local';
    return it;
  });
  const bairros = neighbourhoods().map(h => {
    const it = decorate(fmt(`${h.name} (bairro)`, h.detail), h.lat, h.lng, 'local');
    it.kind = 'bairro';
    it.approx = true;                   // o pino cai no centro do bairro
    return it;
  });
  // "Centro" e demais pontos embutidos entram quando a base não os tem
  for (const p of LOCAL_PLACES) {
    const isBairro = /\bbairro\b/.test(p.tags || '') || p.name === 'Centro';
    const list = isBairro ? bairros : referencias;
    if (list.some(x => normalize(x.text).startsWith(normalize(p.name)))) continue;
    if (!isBairro && neighbourhoods().length + referencePlaces().length > 0) continue;
    const it = decorate(isBairro ? fmt(`${p.name} (bairro)`, null) : fmt(p.name, null), p.lat, p.lng, 'local');
    it.kind = isBairro ? 'bairro' : 'local';
    if (isBairro) it.approx = true;
    list.push(it);
  }
  bairros.sort((a, b) => a.text.localeCompare(b.text, 'pt-BR'));
  return {
    referencias: referencias.filter(x => x.in_coverage),
    bairros: bairros.filter(x => x.in_coverage),
  };
}

/**
 * Converte a sugestão do Google escolhida em coordenada, já medindo a área
 * de cobertura. `label` é o nome que a pessoa viu na lista (vem do navegador
 * e volta só para ela): o Google não é pago de novo pelo nome.
 */
export async function resolvePlace(placeId: string, sessionToken?: string, label?: string):
  Promise<GeoSearchResult> {
  if (offline() || !googleEnabled()) {
    throw new ApiError(503, 'A busca por nome não está disponível agora. Tente a rua + bairro.');
  }
  let place;
  try {
    place = await googlePlaceDetails(placeId, sessionToken);
  } catch {
    throw new ApiError(502, 'Não conseguimos localizar esse lugar agora. Tente de novo ou marque no mapa.');
  }
  if (!place) throw new ApiError(404, 'Não conseguimos localizar esse lugar. Tente outro.');
  const name = (label || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const address = place.address.split(',').slice(0, 2).join(',').replace(/\s+/g, ' ').trim();
  const text = name && address && !normalize(address).startsWith(normalize(name))
    ? `${name} — ${address}` : (name || address || 'Local escolhido');
  const item = decorate(text.slice(0, 200), place.lat, place.lng, 'google');
  item.place_id = placeId;
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
    } catch { /* cai para o Mapbox/Nominatim */ }
  }
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
