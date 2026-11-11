/**
 * Google Maps Platform — integração de servidor.
 *
 * APIs usadas (todas pela chave de SERVIDOR, que nunca vai ao navegador):
 *  - Routes API            → rota real, com modo TWO_WHEELER (motocicleta)
 *  - Places API (New)      → autocomplete e detalhes do lugar
 *  - Geocoding API         → geocodificação reversa
 *
 * A chave do navegador (Maps JavaScript API) é separada e restrita por
 * domínio — ver `server/geo.ts` e a tela 🗺️ Mapas da central.
 *
 * Todas as respostas passam por cache persistente (`geo_cache`) para não
 * repetir chamada paga quando a mesma consulta se repete.
 */
import crypto from 'node:crypto';
import { db, getCredential, getSetting, getSettingNum } from './db.ts';
import { now } from './util.ts';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const PLACES_DETAILS_URL = 'https://places.googleapis.com/v1/places';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

export function serverKey(): string | null {
  return getCredential('GOOGLE_MAPS_SERVER_KEY');
}
export function browserKey(): string | null {
  return getCredential('GOOGLE_MAPS_BROWSER_KEY');
}
export function googleEnabled(): boolean {
  return !!serverKey() && getSetting('maps_provider') !== 'osm';
}

// ---------------------------------------------------------------
// Cache (evita cobrança repetida pela mesma consulta)
// ---------------------------------------------------------------

function cacheKey(kind: string, parts: unknown): string {
  return `${kind}:${crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex')}`;
}

function cacheGet<T>(kind: string, parts: unknown): T | null {
  const key = cacheKey(kind, parts);
  const row = db.prepare('SELECT payload, expires_at FROM geo_cache WHERE key = ?').get(key) as any;
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM geo_cache WHERE key = ?').run(key);
    return null;
  }
  db.prepare('UPDATE geo_cache SET hits = hits + 1 WHERE key = ?').run(key);
  try { return JSON.parse(row.payload) as T; } catch { return null; }
}

function cacheSet(kind: string, parts: unknown, value: unknown, ttlMs: number): void {
  db.prepare(`INSERT INTO geo_cache (key, kind, payload, created_at, expires_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload,
      expires_at = excluded.expires_at`)
    .run(cacheKey(kind, parts), kind, JSON.stringify(value), now(), now() + ttlMs);
}

/** Estatísticas para a central (quanto o cache está economizando). */
export function cacheStats(): { kind: string; entradas: number; acertos: number }[] {
  return db.prepare(`SELECT kind, COUNT(*) entradas, COALESCE(SUM(hits),0) acertos
    FROM geo_cache GROUP BY kind`).all() as any[];
}

export function purgeExpiredCache(): void {
  db.prepare('DELETE FROM geo_cache WHERE expires_at < ?').run(now());
}

// ---------------------------------------------------------------
// Rotas (Routes API) — motocicleta de verdade
// ---------------------------------------------------------------

export interface GoogleRoute {
  distance_m: number;
  duration_s: number;
  geometry: number[][];          // [[lng,lat],...]
  mode: 'TWO_WHEELER' | 'DRIVE';
  provider: 'google';
  /** true quando o modo de duas rodas não pôde ser usado neste trajeto */
  fellBackToDrive: boolean;
}

/** Decodifica o polyline codificado do Google para [[lng,lat],...]. */
export function decodePolyline(encoded: string): number[][] {
  const out: number[][] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let result = 0, shift = 0, b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 0; shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    out.push([lng / 1e5, lat / 1e5]);
  }
  return out;
}

async function computeRoute(from: { lat: number; lng: number }, to: { lat: number; lng: number },
  travelMode: 'TWO_WHEELER' | 'DRIVE'): Promise<GoogleRoute | null> {
  const key = serverKey();
  if (!key) return null;

  const body = {
    origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
    destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
    travelMode,
    // TWO_WHEELER não aceita TRAFFIC_AWARE em todas as regiões; o padrão é seguro.
    ...(travelMode === 'DRIVE' ? { routingPreference: 'TRAFFIC_AWARE' } : {}),
    languageCode: 'pt-BR',
    regionCode: 'BR',
    units: 'METRIC',
  };

  const r = await fetch(ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    // 400 com INVALID_ARGUMENT costuma significar modo indisponível na região
    const err = new Error(`Routes API ${r.status}: ${txt.slice(0, 300)}`);
    (err as any).status = r.status;
    throw err;
  }
  const data: any = await r.json();
  const rt = data?.routes?.[0];
  if (!rt || !Number.isFinite(rt.distanceMeters)) return null;

  return {
    distance_m: Math.round(rt.distanceMeters),
    duration_s: Math.round(Number(String(rt.duration || '0s').replace('s', '')) || 0),
    geometry: rt.polyline?.encodedPolyline ? decodePolyline(rt.polyline.encodedPolyline) : [],
    mode: travelMode,
    provider: 'google',
    fellBackToDrive: false,
  };
}

/**
 * Rota para motocicleta. Tenta TWO_WHEELER; se o Google recusar esse modo
 * para o trajeto, cai para DRIVE e MARCA isso — a interface avisa o usuário
 * em vez de apresentar rota de carro como se fosse de moto.
 */
export async function googleRoute(from: { lat: number; lng: number },
  to: { lat: number; lng: number }): Promise<GoogleRoute | null> {
  const parts = [from.lat.toFixed(5), from.lng.toFixed(5), to.lat.toFixed(5), to.lng.toFixed(5)];
  const cached = cacheGet<GoogleRoute>('route', parts);
  if (cached) return cached;

  let result: GoogleRoute | null = null;
  try {
    result = await computeRoute(from, to, 'TWO_WHEELER');
  } catch (e: any) {
    if (e?.status === 400) {
      // modo de duas rodas indisponível neste caso — usa carro, de forma explícita
      const drive = await computeRoute(from, to, 'DRIVE').catch(() => null);
      if (drive) result = { ...drive, fellBackToDrive: true };
    } else {
      throw e;
    }
  }
  if (!result) return null;

  cacheSet('route', parts, result, getSettingNum('cache_route_hours') * 3600_000);
  return result;
}

// ---------------------------------------------------------------
// Places API (New) — autocomplete e detalhes
// ---------------------------------------------------------------

export interface GooglePrediction {
  place_id: string;
  text: string;
  secondary: string;
}

/**
 * Autocomplete com viés para a cidade atendida. O `sessionToken` agrupa a
 * digitação + a escolha numa única sessão de cobrança do Google.
 */
export async function googleAutocomplete(input: string, sessionToken?: string):
  Promise<GooglePrediction[] | null> {
  const key = serverKey();
  if (!key) return null;

  const cLat = getSettingNum('center_lat'), cLng = getSettingNum('center_lng');
  const radius = Math.min(50000, getSettingNum('coverage_radius_km') * 1000);

  // o cache ignora o token de sessão (a sugestão é a mesma)
  const parts = [input.toLowerCase().trim(), cLat.toFixed(3), cLng.toFixed(3), radius];
  const cached = cacheGet<GooglePrediction[]>('autocomplete', parts);
  if (cached) return cached;

  const r = await fetch(PLACES_AUTOCOMPLETE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
    body: JSON.stringify({
      input,
      languageCode: 'pt-BR',
      regionCode: 'BR',
      includedRegionCodes: ['br'],
      locationBias: {
        circle: { center: { latitude: cLat, longitude: cLng }, radius },
      },
      ...(sessionToken ? { sessionToken } : {}),
    }),
    signal: AbortSignal.timeout(7000),
  });
  if (!r.ok) throw new Error(`Places Autocomplete ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const data: any = await r.json();
  const list: GooglePrediction[] = (data?.suggestions ?? [])
    .filter((s: any) => s.placePrediction)
    .map((s: any) => ({
      place_id: s.placePrediction.placeId,
      text: s.placePrediction.structuredFormat?.mainText?.text
        || s.placePrediction.text?.text || '',
      secondary: s.placePrediction.structuredFormat?.secondaryText?.text || '',
    }));

  cacheSet('autocomplete', parts, list, getSettingNum('cache_places_hours') * 3600_000);
  return list;
}

export interface GooglePlace {
  lat: number; lng: number; text: string; address: string; place_id: string;
}

/** Detalhes do lugar escolhido (coordenada exata + endereço formatado). */
export async function googlePlaceDetails(placeId: string, sessionToken?: string):
  Promise<GooglePlace | null> {
  const key = serverKey();
  if (!key) return null;

  const cached = cacheGet<GooglePlace>('place', [placeId]);
  if (cached) return cached;

  const url = new URL(`${PLACES_DETAILS_URL}/${encodeURIComponent(placeId)}`);
  if (sessionToken) url.searchParams.set('sessionToken', sessionToken);
  const r = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'id,location,formattedAddress,displayName,shortFormattedAddress',
      'Accept-Language': 'pt-BR',
    },
    signal: AbortSignal.timeout(7000),
  });
  if (!r.ok) throw new Error(`Place Details ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const d: any = await r.json();
  if (!d?.location) return null;
  const place: GooglePlace = {
    lat: d.location.latitude,
    lng: d.location.longitude,
    place_id: d.id || placeId,
    text: d.displayName?.text || d.shortFormattedAddress || d.formattedAddress || '',
    address: d.shortFormattedAddress || d.formattedAddress || '',
  };
  cacheSet('place', [placeId], place, getSettingNum('cache_places_hours') * 3600_000);
  return place;
}

// ---------------------------------------------------------------
// Geocoding API — reversa
// ---------------------------------------------------------------

export async function googleReverse(lat: number, lng: number):
  Promise<{ text: string; exact: boolean } | null> {
  const key = serverKey();
  if (!key) return null;

  // arredonda para ~11 m: pontos quase iguais reaproveitam a mesma resposta
  const parts = [lat.toFixed(4), lng.toFixed(4)];
  const cached = cacheGet<{ text: string; exact: boolean }>('reverse', parts);
  if (cached) return cached;

  const url = new URL(GEOCODE_URL);
  url.searchParams.set('latlng', `${lat},${lng}`);
  url.searchParams.set('language', 'pt-BR');
  url.searchParams.set('region', 'br');
  url.searchParams.set('key', key);

  const r = await fetch(url, { signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error(`Geocoding ${r.status}`);
  const d: any = await r.json();
  if (d.status !== 'OK' || !d.results?.length) {
    if (d.status === 'ZERO_RESULTS') return null;
    throw new Error(`Geocoding: ${d.status} ${d.error_message || ''}`);
  }

  // prefere o resultado mais preciso (número da rua), não o bairro
  const best = d.results.find((x: any) => x.types?.includes('street_address'))
    || d.results.find((x: any) => x.types?.includes('route'))
    || d.results[0];
  const value = {
    text: String(best.formatted_address).split(',').slice(0, 3).join(',').trim(),
    exact: !!best.types?.some((t: string) => ['street_address', 'premise', 'route'].includes(t)),
  };
  cacheSet('reverse', parts, value, getSettingNum('cache_geocode_hours') * 3600_000);
  return value;
}

/** Teste de conectividade usado pela central (diz exatamente o que falha). */
export async function testGoogleKeys(): Promise<{ item: string; ok: boolean; detail: string }[]> {
  const checks: { item: string; ok: boolean; detail: string }[] = [];
  const key = serverKey();

  if (!key) {
    checks.push({
      item: 'Chave de servidor', ok: false,
      detail: 'Não configurada — o sistema usa OpenStreetMap/OSRM (gratuito).',
    });
    return checks;
  }

  // Routes API com modo motocicleta, em Assis Chateaubriand
  const cLat = getSettingNum('center_lat'), cLng = getSettingNum('center_lng');
  try {
    const rt = await computeRoute(
      { lat: cLat, lng: cLng }, { lat: cLat + 0.02, lng: cLng + 0.01 }, 'TWO_WHEELER');
    checks.push({
      item: 'Routes API (motocicleta)', ok: !!rt,
      detail: rt ? `Rota de teste: ${(rt.distance_m / 1000).toFixed(1)} km em modo TWO_WHEELER.`
        : 'A API respondeu, mas sem rota para o trajeto de teste.',
    });
  } catch (e: any) {
    const driveOk = await computeRoute({ lat: cLat, lng: cLng },
      { lat: cLat + 0.02, lng: cLng + 0.01 }, 'DRIVE').catch(() => null);
    checks.push({
      item: 'Routes API (motocicleta)', ok: false,
      detail: driveOk
        ? 'Modo TWO_WHEELER recusado nesta região/conta; o sistema usará DRIVE e avisará na tela.'
        : `Falhou: ${e?.message || e}`,
    });
  }

  try {
    const ac = await googleAutocomplete('centro');
    checks.push({
      item: 'Places API (New)', ok: !!ac,
      detail: ac ? `${ac.length} sugestão(ões) para "centro".` : 'Sem resposta.',
    });
  } catch (e: any) {
    checks.push({ item: 'Places API (New)', ok: false, detail: `Falhou: ${e?.message || e}` });
  }

  try {
    const rev = await googleReverse(cLat, cLng);
    checks.push({
      item: 'Geocoding API', ok: !!rev,
      detail: rev ? `Centro da cidade: ${rev.text}` : 'Sem resultado para o centro configurado.',
    });
  } catch (e: any) {
    checks.push({ item: 'Geocoding API', ok: false, detail: `Falhou: ${e?.message || e}` });
  }

  const bk = browserKey();
  checks.push({
    item: 'Chave do navegador (Maps JavaScript)', ok: !!bk,
    detail: bk ? 'Configurada. Restrinja por domínio no Google Cloud.'
      : 'Sem ela o mapa visual continua em OpenStreetMap (funcional e gratuito).',
  });

  const stats = cacheStats();
  const hits = stats.reduce((s, x) => s + x.acertos, 0);
  checks.push({
    item: 'Cache de chamadas', ok: true,
    detail: `${stats.reduce((s, x) => s + x.entradas, 0)} entrada(s), ${hits} chamada(s) evitada(s).`,
  });

  return checks;
}
