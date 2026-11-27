/**
 * Google Maps Platform — integração de servidor.
 *
 * APIs usadas:
 *  - Routes API            → rota real, em modo TWO_WHEELER (motocicleta)
 *  - Places API (New)      → busca por nome (lojas, locais, ruas) e posição
 *                            do lugar escolhido
 *  - Geocoding API         → endereço a partir da coordenada (GPS, toque no mapa)
 *
 * Chaves:
 *  - GOOGLE_MAPS_BROWSER_KEY → vai ao navegador para desenhar o mapa (Maps
 *    JavaScript API). É pública por natureza; restrinja por site no Google Cloud.
 *  - GOOGLE_MAPS_SERVER_KEY (opcional) → usada só pelo backend. Necessária
 *    quando a chave do navegador tem restrição de site (chamadas de servidor
 *    não enviam referenciador e seriam recusadas). Sem ela, o backend usa a
 *    própria chave do navegador. A chave de servidor NUNCA vai ao navegador.
 *
 * O que fica guardado (termos da plataforma):
 *  - rotas: no cache persistente `geo_cache`, por no máximo 30 dias;
 *  - sugestões de busca, detalhes de lugar e endereços: nada é guardado.
 *    A digitação + a escolha formam uma "sessão" de cobrança única, fechada
 *    pela consulta do lugar — por isso essa consulta nunca vem de cache.
 */
import { getCredential, getSetting, getSettingNum } from './db.ts';
import { cacheGet, cacheSet } from './mapbox.ts';
import { googleAllowed, countGoogle } from './geo-usage.ts';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const PLACES_DETAILS_URL = 'https://places.googleapis.com/v1/places';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

const ROUTE_CACHE_KIND = 'rota_google';
const ROUTE_CACHE_MAX_MS = 30 * 24 * 3600_000;

type LatLng = { lat: number; lng: number };

/** Provedores em que o Google pode ser usado: automático ou escolhido à mão. */
function providerAllowsGoogle(): boolean {
  const p = getSetting('maps_provider');
  return p === 'auto' || p === 'google';
}

/** Chave do navegador (mapa visual). */
export function browserKey(): string | null {
  return getCredential('GOOGLE_MAPS_BROWSER_KEY');
}
/** Chave usada pelo backend: a de servidor, se houver; senão a do navegador. */
export function serverKey(): string | null {
  return getCredential('GOOGLE_MAPS_SERVER_KEY') || browserKey();
}
/** Rotas, busca e endereços pelo Google. */
export function googleEnabled(): boolean {
  return !!serverKey() && providerAllowsGoogle();
}
/** Mapa desenhado pelo Google nos aplicativos. */
export function googleVisualEnabled(): boolean {
  return !!browserKey() && providerAllowsGoogle();
}

/** Erro de chamada ao Google — a mensagem nunca inclui a chave nem a URL. */
class GoogleError extends Error {
  status: number;
  reason: string;
  constructor(api: string, status: number, reason: string) {
    super(`${api}: ${reason || `HTTP ${status}`}`);
    this.status = status;
    this.reason = reason;
  }
}

async function failure(api: string, r: Response): Promise<GoogleError> {
  let reason = '';
  try {
    const d: any = await r.json();
    reason = String(d?.error?.message || d?.error_message || d?.error?.status || '').slice(0, 220);
  } catch { /* corpo sem JSON */ }
  return new GoogleError(api, r.status, reason);
}

// ---------------------------------------------------------------
// Rotas (Routes API) — motocicleta de verdade
// ---------------------------------------------------------------

export interface GoogleRoute {
  distance_m: number;
  duration_s: number;
  geometry: number[][];          // [[lng,lat],...]
  mode: 'TWO_WHEELER' | 'DRIVE';
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

async function computeRoute(from: LatLng, to: LatLng,
  travelMode: 'TWO_WHEELER' | 'DRIVE', key: string): Promise<GoogleRoute | null> {
  const r = await fetch(ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
      destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
      travelMode,
      languageCode: 'pt-BR',
      regionCode: 'BR',
      units: 'METRIC',
    }),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw await failure('Routes API', r);

  const data: any = await r.json();
  const rt = data?.routes?.[0];
  if (!rt || !Number.isFinite(rt.distanceMeters)) return null;
  const geometry = rt.polyline?.encodedPolyline ? decodePolyline(rt.polyline.encodedPolyline) : [];
  if (geometry.length < 2) return null;

  return {
    distance_m: Math.round(rt.distanceMeters),
    duration_s: Math.round(Number(String(rt.duration || '0s').replace('s', '')) || 0),
    geometry,
    mode: travelMode,
    fellBackToDrive: false,
  };
}

/**
 * Rota para motocicleta. Tenta TWO_WHEELER; se o Google recusar esse modo
 * para o trajeto (400), cai para DRIVE e MARCA isso — a interface avisa o
 * usuário em vez de apresentar rota de carro como se fosse de moto.
 */
export async function googleRoute(from: LatLng, to: LatLng): Promise<GoogleRoute | null> {
  const key = serverKey();
  if (!key) return null;

  const parts = [from.lat.toFixed(5), from.lng.toFixed(5), to.lat.toFixed(5), to.lng.toFixed(5)];
  const cached = cacheGet<GoogleRoute>(ROUTE_CACHE_KIND, parts);
  if (cached) return cached;
  // teto mensal: sem cota grátis, a rota sai pelo Mapbox/OSRM
  if (!googleAllowed('routes')) return null;
  countGoogle('routes');

  let result: GoogleRoute | null = null;
  try {
    result = await computeRoute(from, to, 'TWO_WHEELER', key);
  } catch (e: any) {
    if (e?.status !== 400) throw e;
    countGoogle('routes');
    const drive = await computeRoute(from, to, 'DRIVE', key);
    if (drive) result = { ...drive, fellBackToDrive: true };
  }
  if (!result) return null;

  const ttl = Math.min(ROUTE_CACHE_MAX_MS, getSettingNum('cache_route_hours') * 3600_000);
  if (ttl > 0) cacheSet(ROUTE_CACHE_KIND, parts, result, ttl);
  return result;
}

// ---------------------------------------------------------------
// Places API (New) — busca por nome e posição do lugar
// ---------------------------------------------------------------

export interface GooglePrediction {
  place_id: string;
  /** nome do lugar ou da rua ("Farmácia São João") */
  text: string;
  /** endereço resumido ("Av. Tupãssi, 1200 - Centro") */
  secondary: string;
}

/** Só letras, números, "-" e "_": o identificador de sessão vem do navegador. */
export function cleanSession(s?: string | null): string | undefined {
  const v = String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 36);
  return v.length >= 8 ? v : undefined;
}

/**
 * Sugestões enquanto a pessoa digita — lojas, locais e ruas — limitadas ao
 * círculo da área atendida. O `sessionToken` junta a digitação e a escolha
 * numa única sessão de cobrança.
 */
export async function googleAutocomplete(input: string, sessionToken?: string,
  timeoutMs = 2500): Promise<GooglePrediction[] | null> {
  const key = serverKey();
  if (!key) return null;
  if (!googleAllowed('autocomplete')) return null;
  countGoogle('autocomplete');

  const cLat = getSettingNum('center_lat'), cLng = getSettingNum('center_lng');
  const radius = Math.min(50000, Math.max(1000, getSettingNum('coverage_radius_km') * 1000));

  const r = await fetch(PLACES_AUTOCOMPLETE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
    body: JSON.stringify({
      input,
      languageCode: 'pt-BR',
      regionCode: 'BR',
      includedRegionCodes: ['br'],
      origin: { latitude: cLat, longitude: cLng },
      locationRestriction: {
        circle: { center: { latitude: cLat, longitude: cLng }, radius },
      },
      ...(sessionToken ? { sessionToken } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw await failure('Places API', r);

  const data: any = await r.json();
  return (data?.suggestions ?? [])
    .filter((s: any) => s.placePrediction?.placeId)
    .map((s: any) => ({
      place_id: String(s.placePrediction.placeId),
      text: String(s.placePrediction.structuredFormat?.mainText?.text
        || s.placePrediction.text?.text || '').trim(),
      secondary: String(s.placePrediction.structuredFormat?.secondaryText?.text || '').trim(),
    }))
    .filter((p: GooglePrediction) => p.text);
}

export interface GooglePlace { lat: number; lng: number; address: string }

/**
 * Posição do lugar escolhido. Pede só campos do nível básico (id, posição e
 * endereço): o nome já veio na sugestão, não precisa ser pago de novo.
 */
export async function googlePlaceDetails(placeId: string, sessionToken?: string):
  Promise<GooglePlace | null> {
  const key = serverKey();
  if (!key) return null;
  if (!googleAllowed('details')) return null;
  countGoogle('details');

  const url = new URL(`${PLACES_DETAILS_URL}/${encodeURIComponent(placeId)}`);
  url.searchParams.set('languageCode', 'pt-BR');
  url.searchParams.set('regionCode', 'BR');
  if (sessionToken) url.searchParams.set('sessionToken', sessionToken);
  const r = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'id,location,formattedAddress',
    },
    signal: AbortSignal.timeout(6000),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw await failure('Places API', r);

  const d: any = await r.json();
  const lat = Number(d?.location?.latitude), lng = Number(d?.location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, address: String(d.formattedAddress || '') };
}

// ---------------------------------------------------------------
// Geocoding API — endereço a partir da coordenada
// ---------------------------------------------------------------

export async function googleReverse(lat: number, lng: number):
  Promise<{ text: string; exact: boolean } | null> {
  const key = serverKey();
  if (!key) return null;
  if (!googleAllowed('geocode')) return null;
  countGoogle('geocode');

  const url = new URL(GEOCODE_URL);
  url.searchParams.set('latlng', `${lat},${lng}`);
  url.searchParams.set('language', 'pt-BR');
  url.searchParams.set('region', 'br');
  url.searchParams.set('key', key);

  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw await failure('Geocoding API', r);
  const d: any = await r.json();
  if (d.status === 'ZERO_RESULTS') return null;
  if (d.status !== 'OK' || !d.results?.length) {
    throw new GoogleError('Geocoding API', 200,
      `${d.status}${d.error_message ? ` — ${String(d.error_message).slice(0, 180)}` : ''}`);
  }

  // prefere o resultado mais preciso (número da rua), não o bairro nem a cidade
  const has = (x: any, ...types: string[]) => (x.types ?? []).some((t: string) => types.includes(t));
  const best = d.results.find((x: any) => has(x, 'street_address', 'premise'))
    || d.results.find((x: any) => has(x, 'route'))
    || d.results.find((x: any) => !has(x, 'plus_code'))
    || d.results[0];
  const text = String(best.formatted_address || '').split(',').slice(0, 3).join(',').trim();
  if (!text) return null;
  return { text, exact: has(best, 'street_address', 'premise', 'route') };
}

// ---------------------------------------------------------------
// Diagnóstico da central: chama cada API de verdade e diz o que falha
// ---------------------------------------------------------------

type Check = { item: string; ok: boolean; detail: string };

function explain(e: any, usingBrowserKey: boolean): string {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return 'O Google demorou demais para responder. Tente de novo em instantes.';
  }
  if (!(e instanceof GoogleError)) {
    return 'O servidor não conseguiu acessar o Google (sem internet ou saída bloqueada).';
  }
  const reason = e.reason;
  if (/referer|referrer/i.test(reason)) {
    return usingBrowserKey
      ? 'A chave do navegador tem restrição de site e o servidor não pode usá-la. Crie uma segunda chave sem restrição de site e cole em "Chave de servidor".'
      : 'A chave de servidor tem restrição de site. Use uma chave sem restrição de site (restrinja por API).';
  }
  if (/billing/i.test(reason)) {
    return 'O faturamento não está ativo no projeto do Google Cloud. Ative-o em console.cloud.google.com → Faturamento.';
  }
  if (/has not been used|is disabled|not activated|not enabled|SERVICE_DISABLED|not authorized to use this (service|api)/i.test(reason)) {
    return 'Esta API não está ativada (ou não foi liberada para esta chave) no Google Cloud. Ative-a em "APIs e serviços" e confira as restrições de API da chave.';
  }
  if (/API key not valid|invalid/i.test(reason) && e.status !== 404) {
    return 'O Google não reconheceu a chave. Copie-a de novo, inteira, em "APIs e serviços → Credenciais".';
  }
  if (e.status === 429 || /quota|OVER_QUERY_LIMIT/i.test(reason)) {
    return 'A cota de uso desta API foi atingida no Google Cloud.';
  }
  return `O Google recusou a chamada: ${reason || `HTTP ${e.status}`}`;
}

export async function testGoogleKeys(): Promise<Check[]> {
  const checks: Check[] = [];
  const key = serverKey();
  if (!key) return checks;

  const usingBrowser = !getCredential('GOOGLE_MAPS_SERVER_KEY');
  const active = providerAllowsGoogle();
  const bk = browserKey();
  checks.push({
    item: 'Google Maps — mapa nos aplicativos', ok: !!bk && active,
    detail: !active ? 'A chave está salva, mas o provedor escolhido não é o Google.'
      : bk ? 'Chave do navegador configurada. Ative a "Maps JavaScript API" e restrinja a chave ao endereço do seu site.'
        : 'Sem a chave do navegador, o mapa visual continua no Mapbox/OpenStreetMap.',
  });

  const cLat = getSettingNum('center_lat'), cLng = getSettingNum('center_lng');
  const a = { lat: cLat, lng: cLng }, b = { lat: cLat + 0.02, lng: cLng + 0.01 };

  try {
    let rt: GoogleRoute | null = null, moto = true;
    try { rt = await computeRoute(a, b, 'TWO_WHEELER', key); } catch (e: any) {
      if (e?.status !== 400) throw e;
      moto = false;
      rt = await computeRoute(a, b, 'DRIVE', key);
    }
    checks.push({
      item: 'Google — rotas (Routes API)', ok: !!rt,
      detail: !rt ? 'A API respondeu, mas sem rota para o trajeto de teste.'
        : moto ? `Rota de teste: ${(rt.distance_m / 1000).toFixed(1)} km, em modo motocicleta.`
          : `Rota de teste: ${(rt.distance_m / 1000).toFixed(1)} km. O modo motocicleta foi recusado nesta região; o sistema usa rota de carro e avisa na tela.`,
    });
  } catch (e) {
    checks.push({ item: 'Google — rotas (Routes API)', ok: false, detail: explain(e, usingBrowser) });
  }

  try {
    const ac = await googleAutocomplete('centro', undefined, 6000);
    checks.push({
      item: 'Google — busca por nome (Places API)', ok: !!ac,
      detail: ac?.length ? `${ac.length} sugestão(ões) para "centro" na área atendida.`
        : 'A API respondeu, mas sem sugestões para "centro" na área atendida.',
    });
  } catch (e) {
    checks.push({ item: 'Google — busca por nome (Places API)', ok: false, detail: explain(e, usingBrowser) });
  }

  try {
    const rev = await googleReverse(cLat, cLng);
    checks.push({
      item: 'Google — endereço do GPS (Geocoding API)', ok: !!rev,
      detail: rev ? `Centro da cidade: ${rev.text}` : 'Sem resultado para o centro configurado.',
    });
  } catch (e) {
    checks.push({ item: 'Google — endereço do GPS (Geocoding API)', ok: false, detail: explain(e, usingBrowser) });
  }

  return checks;
}
